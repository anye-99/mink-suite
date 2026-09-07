import { App, PluginSettingTab, Setting } from 'obsidian';
import type { MinkSuite } from './main';
import { PAPER_LABELS } from './constants';
import type { PaperTemplate } from './types';

export class MinkSettingTab extends PluginSettingTab {
  plugin: MinkSuite;

  constructor(app: App, plugin: MinkSuite) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ---------- 存储 ----------
    new Setting(containerEl)
      .setName('数据目录')
      .setDesc('批注侧车、卡片、AI 历史等数据的存放目录（修改后需重启）')
      .addText(t => t
        .setValue(this.plugin.settings.dataDir)
        .onChange(async v => {
          this.plugin.settings.dataDir = v.trim() || '.mink-suite';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('截图保存目录')
      .setDesc('页面截图保存的 vault 目录')
      .addText(t => t
        .setValue(this.plugin.settings.screenshotFolder)
        .onChange(async v => {
          this.plugin.settings.screenshotFolder = v.trim() || '.mink-suite/assets';
          await this.plugin.saveSettings();
        }));

    // ---------- 书写 ----------
    containerEl.createEl('h3', { text: '书写' });
    new Setting(containerEl)
      .setName('默认纸张模板')
      .addDropdown(d => {
        for (const [k, v] of Object.entries(PAPER_LABELS)) {
          d.addOption(k, v);
        }
        d.setValue(this.plugin.settings.defaultPaper);
        d.onChange(async v => {
          this.plugin.settings.defaultPaper = v as PaperTemplate;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('允许手指直接书写')
      .setDesc('关闭时触摸输入仅用于滚动/缩放（防掌误触）；Apple Pencil 等主动笔不受影响')
      .addToggle(t => t
        .setValue(this.plugin.settings.drawOnTouch)
        .onChange(async v => {
          this.plugin.settings.drawOnTouch = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('掌压抑制')
      .setDesc('书写过程中忽略触摸输入（iPad / 触控屏优化）')
      .addToggle(t => t
        .setValue(this.plugin.settings.palmRejection)
        .onChange(async v => {
          this.plugin.settings.palmRejection = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('画笔颜色')
      .addColorPicker(c => c
        .setValue(this.plugin.settings.penColor)
        .onChange(async v => {
          this.plugin.settings.penColor = v;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('画笔粗细')
      .addSlider(s => s
        .setLimits(1, 20, 1)
        .setValue(this.plugin.settings.penSize)
        .setDynamicTooltip()
        .onChange(async v => {
          this.plugin.settings.penSize = v;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('荧光笔颜色')
      .addColorPicker(c => c
        .setValue(this.plugin.settings.highlighterColor)
        .onChange(async v => {
          this.plugin.settings.highlighterColor = v;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('荧光笔粗细')
      .addSlider(s => s
        .setLimits(4, 40, 1)
        .setValue(this.plugin.settings.highlighterSize)
        .setDynamicTooltip()
        .onChange(async v => {
          this.plugin.settings.highlighterSize = v;
          await this.plugin.saveSettings();
        }));

    // ---------- AI ----------
    containerEl.createEl('h3', { text: 'AI 接口（OpenAI 兼容）' });
    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('如 https://api.deepseek.com/v1 或 https://openrouter.ai/api/v1')
      .addText(t => t
        .setValue(this.plugin.settings.aiBaseUrl)
        .onChange(async v => {
          this.plugin.settings.aiBaseUrl = v.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('API Key')
      .addText(t => t
        .setValue(this.plugin.settings.aiApiKey)
        .onChange(async v => {
          this.plugin.settings.aiApiKey = v.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('文本模型')
      .addText(t => t
        .setValue(this.plugin.settings.aiModel)
        .onChange(async v => {
          this.plugin.settings.aiModel = v.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('视觉模型（问图 / 手写转文字）')
      .setDesc('需支持图片输入，如 gpt-4o-mini / qwen-vl；留空则使用文本模型')
      .addText(t => t
        .setValue(this.plugin.settings.aiVisionModel)
        .onChange(async v => {
          this.plugin.settings.aiVisionModel = v.trim();
          await this.plugin.saveSettings();
        }));

    // ---------- OCR ----------
    containerEl.createEl('h3', { text: 'OCR' });
    new Setting(containerEl)
      .setName('OCR 引擎')
      .addDropdown(d => {
        d.addOption('tesseract', 'Tesseract.js（本地，联网加载语言包）');
        d.addOption('ai', 'AI 视觉模型（走上方配置）');
        d.addOption('off', '关闭');
        d.setValue(this.plugin.settings.ocrEngine);
        d.onChange(async v => {
          this.plugin.settings.ocrEngine = v as 'tesseract' | 'ai' | 'off';
          await this.plugin.saveSettings();
        });
      });

    // ---------- 导出 ----------
    containerEl.createEl('h3', { text: 'PDF 导出' });
    new Setting(containerEl)
      .setName('CJK 字体路径')
      .setDesc('vault 内 .otf/.ttf/.ttc 字体文件路径，用于导出含中文文本的 PDF；留空则中文降级为 ?')
      .addText(t => t
        .setValue(this.plugin.settings.cjkFontPath)
        .onChange(async v => {
          this.plugin.settings.cjkFontPath = v.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('导出渲染倍率')
      .setDesc('.mink 页面渲染为图片的倍率（1-4）')
      .addSlider(s => s
        .setLimits(1, 4, 0.5)
        .setValue(this.plugin.settings.exportScale)
        .setDynamicTooltip()
        .onChange(async v => {
          this.plugin.settings.exportScale = v;
          await this.plugin.saveSettings();
        }));
  }
}
