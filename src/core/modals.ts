import { App, Modal, Notice, Setting } from 'obsidian';
import type { MinkSuite } from '../main';
import { copyImageBlob, savePngBlob, blobToDataUrl } from './snapshot';
import { copyText } from './link';
import { ocrNotice } from '../ai/ocr';
import { AskModal } from '../ai/ask';
import { TextResultModal } from './text-result';

/** 通用文本输入弹窗（命名等） */
export class TextInputModal extends Modal {
  constructor(
    app: App,
    private placeholder: string,
    private initial: string,
    private onSubmit: (val: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.placeholder);
    let value = this.initial;
    new Setting(contentEl)
      .addText(text => {
        text.setValue(this.initial);
        text.onChange(v => (value = v));
        text.inputEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); this.close(); this.onSubmit(value); }
        });
      })
      .addButton(btn => {
        btn.setButtonText('确定');
        btn.onClick(() => { this.close(); this.onSubmit(value); });
      });
  }
}

export interface SnapshotCtx {
  file: string;
  page?: number | string;
  /** 回链 wikilink 文本 */
  link: string;
  /** OCR 结果备注 */
  label?: string;
}

/** 截图操作弹窗：保存 / 复制 / 回链 / OCR / 问图 / 收藏卡片 / 加入脑图（预留） */
export class SnapshotActionsModal extends Modal {
  private dataUrl: string | null = null;

  constructor(
    private plugin: MinkSuite,
    private blob: Blob,
    private ctx: SnapshotCtx,
  ) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, titleEl } = this;
    titleEl.setText('截图操作');
    contentEl.addClass('mink-snapshot-modal');
    try {
      this.dataUrl = await blobToDataUrl(this.blob);
      contentEl.createEl('img', { cls: 'mink-snapshot-preview', attr: { src: this.dataUrl } });
    } catch { /* ignore */ }

    const btns = contentEl.createEl('div', { cls: 'mink-snapshot-btns' });

    const mkBtn = (label: string, fn: () => void | Promise<void>) => {
      const b = btns.createEl('button', { cls: 'mink-btn', text: label });
      b.addEventListener('click', () => void Promise.resolve(fn()));
      return b;
    };

    mkBtn('保存图片', async () => {
      await savePngBlob(this.plugin.app, this.plugin.store, this.plugin.settings.screenshotFolder, this.blob);
      this.close();
    });
    mkBtn('复制图片', async () => {
      const ok = await copyImageBlob(this.blob);
      new Notice(ok ? '已复制图片' : '复制图片失败（当前环境不支持）');
    });
    mkBtn('复制回链', async () => {
      await copyText(this.ctx.link);
    });
    mkBtn('保存并复制回链', async () => {
      await savePngBlob(this.plugin.app, this.plugin.store, this.plugin.settings.screenshotFolder, this.blob);
      await copyText(this.ctx.link);
      this.close();
    });
    mkBtn('OCR 识别', async () => {
      if (this.plugin.settings.ocrEngine === 'off') { new Notice('OCR 已在设置中关闭'); return; }
      if (!this.plugin.ai.configured()) {
        new Notice('OCR 需要 AI 接口：请在设置 → Mink 妙笔批注套件 → AI 中配置');
        return;
      }
      ocrNotice();
      try {
        const text = await this.plugin.ai.askImage('请识别并输出图片中的所有文字，保持原有换行。', [this.dataUrl!]);
        new TextResultModal(this.plugin, text, this.ctx).open();
      } catch (e) {
        new Notice(`OCR 失败：${(e as Error).message}`);
      }
    });
    mkBtn('AI 问图', async () => {
      new AskModal(this.plugin, {
        title: 'AI 问图',
        images: this.dataUrl ? [this.dataUrl] : [],
      }).open();
      this.close();
    });
    mkBtn('收藏为卡片', async () => {
      const snapshotPath = await this.plugin.cards.saveSnapshotAsset(this.blob);
      await this.plugin.cards.add({
        kind: 'image',
        content: this.ctx.label ?? '截图卡片',
        file: this.ctx.file,
        page: this.ctx.page,
        snapshot: snapshotPath ?? undefined,
        tags: ['截图'],
      });
      this.close();
    });
    mkBtn('加入脑图', () => {
      new Notice('批注思维导图（.imap）将在后续版本提供');
    });
  }
}

/** 文本结果（OCR / 转文字）弹窗：编辑 / 复制 / 收藏卡片 */
export { TextResultModal } from './text-result';
