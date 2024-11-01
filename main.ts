import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  EventRef
} from 'obsidian';

const { diffChars } = require('diff');

interface OCRPluginSettings {
  appId: string;
  appKey: string;
}

const DEFAULT_SETTINGS: OCRPluginSettings = {
  appId: '',
  appKey: ''
};

export default class OCRPlugin extends Plugin {
  settings: OCRPluginSettings;

  private autoOCRMode: boolean = false;
  private ribbonIconEl: HTMLElement;
  private processedImages: Set<string> = new Set();
  private previousContent: string = '';
  private editorChangeEventRef: EventRef | null = null;

  async onload() {
    console.log('Loading OCR Plugin');

    await this.loadSettings();

    this.addCommand({
      id: 'ocr-selected-image',
      name: 'OCR selected image',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.ocrSelectedImage(editor, view);
      }
    });

    this.addCommand({
      id: 'ocr-all-images',
      name: 'OCR all images in current note',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.ocrAllImagesInNote(editor, view);
      }
    });

    // Add Ribbon button
    this.ribbonIconEl = this.addRibbonIcon('camera', 'Toggle automatic OCR mode', (evt: MouseEvent) => {
      // Toggle automatic OCR mode
      this.toggleAutoOCRMode();
    });
    // Set initial icon style
    this.updateRibbonIcon();

    this.addSettingTab(new OCRSettingTab(this.app, this));
  }

  onunload() {
    console.log('Unloading OCR Plugin');
    // Unregister event listeners when the plugin is unloaded
    this.stopListeningForChanges();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private toggleAutoOCRMode() {
    this.autoOCRMode = !this.autoOCRMode;
    this.updateRibbonIcon();

    if (this.autoOCRMode) {
      new Notice('Automatic OCR mode is enabled.');
      this.startListeningForChanges();
    } else {
      new Notice('Automatic OCR mode is disabled.');
      this.stopListeningForChanges();
    }
  }

  private updateRibbonIcon() {
    if (this.autoOCRMode) {
      // Active state, add style
      this.ribbonIconEl.addClass('is-active');
    } else {
      // Inactive state, remove style
      this.ribbonIconEl.removeClass('is-active');
    }
  }

  private startListeningForChanges() {
    console.log('startListeningForChanges called');

    // Initialize previousContent with current editor content
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (editor) {
      this.previousContent = editor.getValue();
    } else {
      this.previousContent = '';
    }

    // Register the event listener if not already registered
    if (!this.editorChangeEventRef) {
      this.editorChangeEventRef = this.app.workspace.on('editor-change', this.handleEditorChange.bind(this));
    }
  }

  private stopListeningForChanges() {
    console.log('stopListeningForChanges called');

    // Unregister the event listener if it exists
    if (this.editorChangeEventRef) {
      this.app.workspace.offref(this.editorChangeEventRef);
      this.editorChangeEventRef = null;
    }

    // Clear processed images and previous content
    this.processedImages.clear();
    this.previousContent = '';
  }

  private handleEditorChange(editor: Editor) {
    console.log('handleEditorChange called');

    // Get current content
    const currentContent = editor.getValue();

    // Compare old and new content to get the added text
    const addedText = this.getAddedText(this.previousContent, currentContent);

    // Update previousContent
    this.previousContent = currentContent;

    // If there's no new content, return
    if (!addedText) {
      return;
    }

    // Find image links in the added text
    const imageLinkRegex = /!\[\[([^\]]+)\]\]|!\[.*?\]\((.+?)\)/g;
    let match;

    while ((match = imageLinkRegex.exec(addedText)) !== null) {
      const fullMatch = match[0];
      const imagePath = match[1] || match[2];

      // If the image has already been processed, skip it
      if (this.processedImages.has(fullMatch)) {
        continue;
      }
      this.processedImages.add(fullMatch);

      const currentFilePath = this.app.workspace.getActiveFile()?.path;
      if (!currentFilePath) {
        continue;
      }

      this.processImage(fullMatch, imagePath, currentFilePath).then(result => {
        if (result) {
          // Replace image link with OCR result
          const newContent = editor.getValue().replace(result.imageLink, () => result.ocrText);
          editor.setValue(newContent);
          // Update previousContent
          this.previousContent = newContent;
        }
      });
    }
  }

  private getAddedText(oldText: string, newText: string): string {
    const changes = diffChars(oldText, newText);
    let addedText = '';

    for (const part of changes) {
      if (part.added) {
        addedText += part.value;
      }
    }

    return addedText;
  }

  private async processImage(imageLink: string, imagePath: string, currentFilePath: string) {
    // Wait for image file to be loaded
    const imageFile = await this.waitForImageFile(imagePath, currentFilePath);

    if (!imageFile) {
      new Notice(`Unable to find the image file: ${imagePath}`);
      return null;
    }

    // Read image data
    const arrayBuffer = await this.app.vault.readBinary(imageFile);
    const base64Image = this.arrayBufferToBase64(arrayBuffer);

    // Perform OCR
    const processedText = await this.processImageData(base64Image);

    if (!processedText) {
      return null;
    }

    return { imageLink, ocrText: processedText };
  }

  private async waitForImageFile(imagePath: string, currentFilePath: string): Promise<TFile | null> {
    const maxRetries = 10; // Maximum number of retries
    const retryInterval = 500; // Retry interval in milliseconds

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const imageFile = this.app.metadataCache.getFirstLinkpathDest(imagePath, currentFilePath) as TFile;
      if (imageFile) {
        return imageFile;
      }
      // Wait for a while before retrying
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
    return null;
  }

  private async processImageData(base64Image: string): Promise<string | null> {
    // Call Mathpix API
    const response = await fetch('https://api.mathpix.com/v3/text', {
      method: 'POST',
      headers: {
        'app_id': this.settings.appId,
        'app_key': this.settings.appKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        src: `data:image/png;base64,${base64Image}`,
        formats: ['text']
      })
    });

    if (!response.ok) {
      new Notice('OCR request failed');
      return null;
    }

    const result = await response.json();
    const ocrText = result.text;

    if (!ocrText) {
      new Notice('Failed to OCR.');
      return null;
    }

    // Process OCR result with removeBlanks function
    const processedText = this.removeBlanks(ocrText);

    return processedText;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private removeBlanks(input: string): string {
    let result = input;
    // Replace inline math delimiters and trim
    result = result.replace(/\$(.*?)\$/g, (_match, p1) => `$${p1.trim()}$`);
    // Replace display math delimiters with inline math delimiters
    result = result.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, p1) => `$$${p1.trim()}$$`);
    // Replace \( and \) with inline math delimiters
    result = result.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_match, p1) => `$${p1.trim()}$`);
    return result;
  }

  private async ocrSelectedImage(editor: Editor, view: MarkdownView) {
    const selectedText = editor.getSelection();

    if (!selectedText) {
      new Notice('Select the link of an image first.');
      return;
    }

    // Check if the selected text is an image link
    const imageLinkRegex = /!\[\[([^\]]+)\]\]|!\[.*?\]\((.+?)\)/;
    const match = selectedText.match(imageLinkRegex);

    if (!match) {
      new Notice('Invalid image link.');
      return;
    }

    const imagePath = match[1] || match[2];

    const currentFilePath = view.file?.path;
    if (!currentFilePath) {
      new Notice('Unable to obtain the current file path.');
      return;
    }

    // Wait for image file to be loaded
    const imageFile = await this.waitForImageFile(imagePath, currentFilePath);
    if (!imageFile) {
      new Notice(`Unable to find image file: ${imagePath}`);
      return;
    }

    // Read image data
    const arrayBuffer = await this.app.vault.readBinary(imageFile);
    const base64Image = this.arrayBufferToBase64(arrayBuffer);

    // Perform OCR
    const processedText = await this.processImageData(base64Image);

    if (processedText) {
      // Replace the selected content with OCR result
      editor.replaceSelection(processedText);
    }
  }

  private async ocrAllImagesInNote(editor: Editor, view: MarkdownView) {
    const content = editor.getValue();

    const currentFilePath = view.file?.path;
    if (!currentFilePath) {
      new Notice('Unable to obtain the current file path.');
      return;
    }

    // Regular expression to match all image links
    const imageLinkRegex = /(!\[\[([^\]]+)\]\])|(!\[[^\]]*\]\((.+?)\))/g;
    let match;
    const promises = [];

    while ((match = imageLinkRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const imagePath = match[2] || match[4];

      promises.push(this.processImage(fullMatch, imagePath, currentFilePath));
    }

    const results = await Promise.all(promises);

    // Replace image links with OCR results in the content
    let newContent = content;
    for (const result of results) {
      if (result) {
        newContent = newContent.replace(result.imageLink, () => result.ocrText);
      }
    }

    editor.setValue(newContent);

    new Notice('All images have been processed.');
  }
}

class OCRSettingTab extends PluginSettingTab {
  plugin: OCRPlugin;

  constructor(app: App, plugin: OCRPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'OCR Plugin Settings' });

    new Setting(containerEl)
      .setName('Mathpix App ID')
      .setDesc('Your Mathpix API App ID')
      .addText(text => text
        .setPlaceholder('Please enter your App ID.')
        .setValue(this.plugin.settings.appId)
        .onChange(async (value) => {
          this.plugin.settings.appId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Mathpix App Key')
      .setDesc('Your Mathpix API App Key')
      .addText(text => text
        .setPlaceholder('Please enter your App Key')
        .setValue(this.plugin.settings.appKey)
        .onChange(async (value) => {
          this.plugin.settings.appKey = value;
          await this.plugin.saveSettings();
        }));
  }
}
