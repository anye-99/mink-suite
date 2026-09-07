import { Modal, Notice } from 'obsidian';
import type { AnnoObject } from '../types';
import type { MinkSuite } from '../main';
import { AskModal } from '../ai/ask';

/** PDF 笔记批注编辑弹窗 */
export class NoteModal extends Modal {
  private textarea!: HTMLTextAreaElement;

  constructor(
    private plugin: MinkSuite,
    private anno: AnnoObject,
    private isNew: boolean,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.isNew ? '添加笔记' : '编辑笔记');
    contentEl.addClass('mink-note-modal');

    if (this.anno.anchor?.quote) {
      contentEl.createEl('div', { cls: 'mink-ask-quote' })
        .setText(this.anno.anchor.quote.length > 400 ? this.anno.anchor.quote.slice(0, 400) + '…' : this.anno.anchor.quote);
    }
    this.textarea = contentEl.createEl('textarea', { cls: 'mink-note-textarea' });
    this.textarea.rows = 8;
    this.textarea.value = this.text ?? '';
    this.textarea.focus();

    const btns = contentEl.createEl('div', { cls: 'mink-snapshot-btns' });
    const save = btns.createEl('button', { cls: 'mink-btn mink-btn-primary', text: '保存' });
    save.addEventListener('click', () => void this.save());
    if (!this.isNew) {
      const del = btns.createEl('button', { cls: 'mink-btn', text: '删除批注' });
      del.addEventListener('click', () => {
        void this.plugin.annoStore.remove(this.anno.file, this.anno.id);
        this.close();
      });
    }
    const ai = btns.createEl('button', { cls: 'mink-btn', text: 'AI 追问' });
    ai.addEventListener('click', () => {
      new AskModal(this.plugin, {
        title: 'AI 追问',
        quote: `${this.anno.anchor?.quote ?? ''}\n\n我的笔记：${this.textarea.value}`,
      }).open();
      this.close();
    });
  }

  private get text(): string { return this.anno.text ?? ''; }

  private async save(): Promise<void> {
    const v = this.textarea.value.trim();
    if (!v) { new Notice('笔记内容为空'); return; }
    this.anno.text = v;
    this.anno.modified = Date.now();
    await this.plugin.annoStore.update(this.anno.file, this.anno);
    this.close();
  }
}
