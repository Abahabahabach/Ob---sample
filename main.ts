import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

// 声明 require 以避免 TypeScript 报错
declare const require: any;

// 正确引入 diff 库
const { diffChars } = require('diff');
// 如果您更倾向于使用 ES6 模块，可以考虑安装 @types/node 并使用下面的导入方式
// import { diffChars } from 'diff';

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
  // 将 processedImages 更改为 per-note 结构
  private processedImagesPerNote: { [notePath: string]: Set<string> } = {};
  private previousContent: string = '';

  async onload() {
    console.log('Loading OCR Plugin');

    await this.loadSettings();
    await this.loadProcessedImages(); // 加载已处理的图片记录

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

    // 添加 Ribbon 按钮
    this.ribbonIconEl = this.addRibbonIcon('camera', 'Toggle automatic OCR mode', (evt: MouseEvent) => {
      // 切换自动 OCR 模式
      this.toggleAutoOCRMode();
    });
    // 设置初始状态的图标样式
    this.updateRibbonIcon();

    this.addSettingTab(new OCRSettingTab(this.app, this));
  }

  onunload() {
    console.log('Unloading OCR Plugin');
    // 在插件卸载时，确保注销事件监听器
    this.stopListeningForChanges();
    this.saveProcessedImages(); // 保存已处理的图片记录
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 加载已处理的图片记录
  private async loadProcessedImages() {
    const data = await this.loadData();
    if (data && data.processedImagesPerNote) {
      this.processedImagesPerNote = data.processedImagesPerNote;
      // 将每个数组转换为 Set
      for (const notePath in this.processedImagesPerNote) {
        this.processedImagesPerNote[notePath] = new Set(this.processedImagesPerNote[notePath]);
      }
      console.log('Loaded processedImagesPerNote:', this.processedImagesPerNote);
    }
  }

  // 保存已处理的图片记录
  private async saveProcessedImages() {
    // 将 Set 转换为数组以便序列化
    const dataToSave: any = {
      ...this.settings,
      processedImagesPerNote: {}
    };
    for (const notePath in this.processedImagesPerNote) {
      dataToSave.processedImagesPerNote[notePath] = Array.from(this.processedImagesPerNote[notePath]);
    }
    await this.saveData(dataToSave);
    console.log('Saved processedImagesPerNote:', this.processedImagesPerNote);
  }

  private toggleAutoOCRMode() {
    this.autoOCRMode = !this.autoOCRMode;
    this.updateRibbonIcon();

    if (this.autoOCRMode) {
      new Notice('Automatic OCR mode is enabled.');
      this.startListeningForChanges();

      // 在开启自动 OCR 时，初始化 previousContent 为当前编辑器的内容
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        this.previousContent = activeView.editor.getValue();
        console.log('Initialized previousContent on enabling auto OCR.');
      } else {
        this.previousContent = '';
        console.log('No active MarkdownView found. Set previousContent to empty string.');
      }
    } else {
      new Notice('Automatic OCR mode is disabled.');
      this.stopListeningForChanges();

      // 关闭自动 OCR 时，不清空 previousContent
      console.log('Auto OCR mode disabled. previousContent retained.');
    }
  }

  private updateRibbonIcon() {
    if (this.autoOCRMode) {
      // 激活状态，添加样式
      this.ribbonIconEl.addClass('is-active');
    } else {
      // 未激活状态，移除样式
      this.ribbonIconEl.removeClass('is-active');
    }
  }

  private startListeningForChanges() {
    console.log('startListeningForChanges called');
    this.registerEvent(
      this.app.workspace.on('editor-change', this.handleEditorChange.bind(this))
    );
  }

  private stopListeningForChanges() {
    console.log('stopListeningForChanges called');
    this.processedImagesPerNote = {}; // 清空已处理图片集合
    this.saveProcessedImages(); // 保存清空后的记录
    // 不再清空 previousContent
    console.log('previousContent retained:', this.previousContent);
  }

  private async handleEditorChange(editor: Editor) {
    console.log('handleEditorChange called');

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) {
      console.log('No active MarkdownView found.');
      return;
    }

    const currentFile = activeView.file;
    if (!currentFile) {
      console.log('No active file found.');
      return;
    }

    const currentFilePath = currentFile.path;

    // 获取或初始化当前笔记的 processedImages 集合
    if (!this.processedImagesPerNote[currentFilePath]) {
      this.processedImagesPerNote[currentFilePath] = new Set();
    }

    // 获取当前内容
    const currentContent = editor.getValue();

    // 比较前后内容，获取新增的部分
    const addedText = this.getAddedText(this.previousContent, currentContent);

    // 如果没有新增内容，更新 previousContent 并返回
    if (!addedText) {
      this.previousContent = currentContent; // 更新 previousContent
      console.log('No added text detected. Updated previousContent.');
      return;
    }

    console.log('Added text detected:', addedText);

    // 在新增的文本中查找图片链接
    const imageLinkRegex = /!\[\[([^\]]+)\]\]|!\[.*?\]\((.*?)\)/g;
    let match: RegExpExecArray | null;

    const processingPromises: Promise<void>[] = [];

    while ((match = imageLinkRegex.exec(addedText)) !== null) {
      const fullMatch = match[0];
      const imagePath = match[1] || match[2];

      // 获取当前笔记的 processedImages 集合
      const processedImages = this.processedImagesPerNote[currentFilePath];

      // 如果图片已经处理过，跳过
      if (processedImages.has(fullMatch)) {
        console.log(`Image already processed in this note: ${fullMatch}`);
        continue;
      }
      processedImages.add(fullMatch);

      // 处理图片并替换链接
      const promise = this.processImage(fullMatch, imagePath, currentFilePath).then(result => {
        if (result) {
          // 替换图片链接为 OCR 结果
          const newContent = editor.getValue().replace(result.imageLink, result.ocrText);
          editor.setValue(newContent);
          console.log(`Replaced image link with OCR text: ${result.imageLink}`);
        }
      });

      processingPromises.push(promise);
    }

    // 等待所有图片处理完成
    await Promise.all(processingPromises);

    // 在处理完所有新增内容后，更新 previousContent
    this.previousContent = editor.getValue();
    console.log('Updated previousContent after processing.');

    // 保存 processedImagesPerNote
    await this.saveProcessedImages();
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
    // 等待图片文件加载完成
    const imageFile = await this.waitForImageFile(imagePath, currentFilePath);

    if (!imageFile) {
      new Notice(`Unable to find the image file: ${imagePath}`);
      return null;
    }

    // 读取图片数据
    const arrayBuffer = await this.app.vault.readBinary(imageFile);
    const base64Image = this.arrayBufferToBase64(arrayBuffer);

    // 调用 OCR 处理
    const processedText = await this.processImageData(base64Image);

    if (!processedText) {
      return null;
    }

    return { imageLink, ocrText: processedText };
  }

  private async waitForImageFile(imagePath: string, currentFilePath: string): Promise<TFile | null> {
    const maxRetries = 10; // 最大重试次数
    const retryInterval = 500; // 每次重试间隔，毫秒

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const imageFile = this.app.metadataCache.getFirstLinkpathDest(imagePath, currentFilePath) as TFile;
      if (imageFile) {
        return imageFile;
      }
      // 等待一段时间后重试
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
    return null;
  }

  private async processImageData(base64Image: string): Promise<string | null> {
    // 调用 Mathpix API
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
      console.error('OCR request failed with status:', response.status);
      return null;
    }

    const result = await response.json();
    const ocrText = result.text;

    if (!ocrText) {
      new Notice('Failed to OCR.');
      console.error('OCR response did not contain text.');
      return null;
    }

    // 调用 removeBlanks 函数处理 OCR 结果
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
    result = result.replace(/\$(.*?)\$/g, (_match, p1) => `$${p1.trim()}$`);
    // 将 "\[" 或 "\]" 替换为 "$$"
    result = result.replace(/\\\[/g, '$$$').replace(/\\\]/g, '$$$');
    // 将 "\(" 或 "\)" 替换为 "$"
    result = result.replace(/\\\(\s/g, '$$').replace(/\s\\\)/g, '$$');
    result = result.replace(/\\\(/g, '$$').replace(/\\\)/g, '$$');
    return result;
  }

  private async ocrSelectedImage(editor: Editor, view: MarkdownView) {
    const selectedText = editor.getSelection();

    if (!selectedText) {
      new Notice('Select the link of an image first.');
      return;
    }

    // 检查选中的文本是否为图片链接
    const imageLinkRegex = /!\[\[([^\]]+)\]\]|!\[.*?\]\((.*?)\)/;
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

    // 获取或初始化当前笔记的 processedImages 集合
    if (!this.processedImagesPerNote[currentFilePath]) {
      this.processedImagesPerNote[currentFilePath] = new Set();
    }

    const processedImages = this.processedImagesPerNote[currentFilePath];

    // 检查图片是否已处理
    if (processedImages.has(selectedText)) {
      new Notice('This image has already been processed.');
      return;
    }
    processedImages.add(selectedText);

    // 等待图片文件加载完成
    const imageFile = await this.waitForImageFile(imagePath, currentFilePath);
    if (!imageFile) {
      new Notice(`Unable to find image file: ${imagePath}`);
      return;
    }

    // 读取图片数据
    const arrayBuffer = await this.app.vault.readBinary(imageFile);
    const base64Image = this.arrayBufferToBase64(arrayBuffer);

    // 调用 OCR 处理
    const processedText = await this.processImageData(base64Image);

    if (processedText) {
      // 替换选中的内容为 OCR 结果
      editor.replaceSelection(processedText);
      // 更新 previousContent
      this.previousContent = editor.getValue();
      console.log('Replaced selected image link with OCR text.');

      // 保存 processedImagesPerNote
      await this.saveProcessedImages();
    }
  }

  private async ocrAllImagesInNote(editor: Editor, view: MarkdownView) {
    const content = editor.getValue();

    const currentFilePath = view.file?.path;
    if (!currentFilePath) {
      new Notice('Unable to obtain the current file path.');
      return;
    }

    // 获取或初始化当前笔记的 processedImages 集合
    if (!this.processedImagesPerNote[currentFilePath]) {
      this.processedImagesPerNote[currentFilePath] = new Set();
    }

    const processedImages = this.processedImagesPerNote[currentFilePath];

    // 正则表达式匹配所有图片链接
    const imageLinkRegex = /(!\[\[([^\]]+)\]\])|(!\[[^\]]*\]\(([^)]+)\))/g;
    let match;
    const promises: Promise<{ imageLink: string; ocrText: string } | null>[] = [];

    while ((match = imageLinkRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const imagePath = match[2] || match[4];

      // 跳过已处理的图片
      if (processedImages.has(fullMatch)) {
        console.log(`Image already processed in this note: ${fullMatch}`);
        continue;
      }
      processedImages.add(fullMatch);

      promises.push(this.processImage(fullMatch, imagePath, currentFilePath));
    }

    const results = await Promise.all(promises);

    // 将内容中的图片链接替换为 OCR 结果
    let newContent = content;
    for (const result of results) {
      if (result) {
        newContent = newContent.replace(result.imageLink, result.ocrText);
        console.log(`Replaced image link with OCR text: ${result.imageLink}`);
      }
    }

    editor.setValue(newContent);

    // 更新 previousContent
    this.previousContent = newContent;
    console.log('Replaced all image links with OCR text.');

    // 保存 processedImagesPerNote
    await this.saveProcessedImages();

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