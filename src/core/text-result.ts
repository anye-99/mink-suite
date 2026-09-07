import { Modal, Notice } from 'obsidian';
import type { MinkSuite } from '../main';
import { copyText, openAnno } from './link';
import { AskModal } from '../ai/ask';
import type { SnapshotCtx } from './modals';

/** OCR / 转文字结果弹窗：可编辑、复制、收藏为卡片 */
export class TextResultModal extends Modal {
  private textarea!: HTMLTextAreaElement;

  constructor(
    private plugin: MinkSuite,
    initialText: string,
    private ctx?: SnapshotCtx,
  ) {
    super(plugin.app);
    this.initialText = initialText;
  }

  private initialText: string;

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('识别结果');
    contentEl.addClass('mink-text-result-modal');
    this.textarea = contentEl.createEl('textarea', { cls: 'mink-text-result' });
    this.textarea.value = this.initialText;
    this.textarea.rows = 12;

    const btns = contentEl.createEl('div', { cls: 'mink-snapshot-btns' });
    const mkBtn = (label: string, fn: () => void | Promise<void>) => {
      const b = btns.createEl('button', { cls: 'mink-btn', text: label });
      b.addEventListener('click', () => void Promise.resolve(fn()));
    };
    mkBtn('复制', async () => {
      await copyText(this.textarea.value, '已复制识别文本');
    });
    mkBtn('收藏为卡片', async () => {
      await this.plugin.cards.add({
        kind: 'ocr',
        content: this.textarea.value,
        file: this.ctx?.file,
        page: this.ctx?.page,
        tags: ['OCR'],
      });
      this.close();
    });
    mkBtn('AI 追问', async () => {
      new AskModal(this.plugin, {
        title: 'AI 追问',
        quote: this.textarea.value,
      }).open();
      this.close();
    });
    if (this.ctx?.file) {
      mkBtn('定位到原文', async () => {
        await openAnno(this.plugin.app, this.plugin.bus, this.ctx!.file, this.ctx!.page);
        this.close();
      });
    }
  }
}
