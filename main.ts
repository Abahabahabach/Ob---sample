import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

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

  async onload() {
    console.log('Loading OCR Plugin');

    await this.loadSettings();

    this.addCommand({
      id: 'ocr-selected-image',
      name: 'OCR Selected Image',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.ocrSelectedImage(editor, view);
      }
    });

    this.addCommand({
      id: 'ocr-all-images',
      name: 'OCR All Images in Note',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.ocrAllImagesInNote(editor, view);
      }
    });

    this.addSettingTab(new OCRSettingTab(this.app, this));
  }

  onunload() {
    console.log('Unloading OCR Plugin');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async ocrSelectedImage(editor: Editor, view: MarkdownView) {
    const selectedText = editor.getSelection();

    if (!selectedText) {
      new Notice('请先选中一张图片的链接');
      return;
    }

    // 检查选中的文本是否为图片链接
    const imageLinkRegex = /!\[\[([^\]]+)\]\]|!\[.*?\]\((.*?)\)/;
    const match = selectedText.match(imageLinkRegex);

    if (!match) {
      new Notice('选中的内容不是有效的图片链接');
      return;
    }

    const imagePath = match[1] || match[2];

    const currentFilePath = view.file?.path;
    if (!currentFilePath) {
      new Notice('无法获取当前文件路径');
      return;
    }

    const result = await this.processImage(selectedText, imagePath, currentFilePath);

    if (result) {
      // 替换选中的内容为 OCR 结果
      editor.replaceSelection(result.ocrText);
    }
  }

  private async ocrAllImagesInNote(editor: Editor, view: MarkdownView) {
    const content = editor.getValue();

    const currentFilePath = view.file?.path;
    if (!currentFilePath) {
      new Notice('无法获取当前文件路径');
      return;
    }

    // 正则表达式匹配所有图片链接
    const imageLinkRegex = /(!\[\[([^\]]+)\]\])|(!\[[^\]]*\]\(([^)]+)\))/g;
    let match;
    const promises = [];

    while ((match = imageLinkRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const imagePath = match[2] || match[4];

      promises.push(this.processImage(fullMatch, imagePath, currentFilePath));
    }

    const results = await Promise.all(promises);

    // 将内容中的图片链接替换为 OCR 结果
    let newContent = content;
    for (const result of results) {
      if (result) {
        newContent = newContent.replace(result.imageLink, result.ocrText);
      }
    }

    editor.setValue(newContent);

    new Notice('所有图片已处理完成');
  }

  private async processImage(imageLink: string, imagePath: string, currentFilePath: string) {
    // 获取图片文件
    const imageFile = this.app.metadataCache.getFirstLinkpathDest(imagePath, currentFilePath);

    if (!imageFile) {
      new Notice(`无法找到图片文件：${imagePath}`);
      return null;
    }

    // 读取图片数据
    const arrayBuffer = await this.app.vault.readBinary(imageFile);
    const base64Image = this.arrayBufferToBase64(arrayBuffer);

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
      new Notice(`OCR 请求失败：${imagePath}`);
      return null;
    }

    const result = await response.json();
    const ocrText = result.text;

    if (!ocrText) {
      new Notice(`未能识别出文本：${imagePath}`);
      return null;
    }

    // 调用 removeBlanks 函数处理 OCR 结果
    const processedText = this.removeBlanks(ocrText);

    return { imageLink, ocrText: processedText };
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
  // 删除美元符号前后的空格
  let result = input.replace(/\$(.*?)\$/g, (match, p1) => `$${p1.trim()}$`);
  // 将 "\[" 或 "\]" 替换为 "$$"
  result = result.replace(/\\\[/g, '$$$').replace(/\\\]/g, '$$$');
  // 将 "\(" 或 "\)" 替换为 "$"
  result = result.replace(/\\\(\s/g, '$').replace(/\s\\\)/g, '$');
  result = result.replace(/\\\(/g, '$').replace(/\\\)/g, '$');
    return result;
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
        .setPlaceholder('Enter your App ID')
        .setValue(this.plugin.settings.appId)
        .onChange(async (value) => {
          this.plugin.settings.appId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Mathpix App Key')
      .setDesc('Your Mathpix API App Key')
      .addText(text => text
        .setPlaceholder('Enter your App Key')
        .setValue(this.plugin.settings.appKey)
        .onChange(async (value) => {
          this.plugin.settings.appKey = value;
          await this.plugin.saveSettings();
        }));
  }
}
