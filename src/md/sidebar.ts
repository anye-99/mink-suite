import { ItemView, MarkdownView, Notice, setIcon } from 'obsidian';
import type { MdAnnotation } from '../types';
import type { MinkSuite } from '../main';
import { VIEW_TYPE_MD_SIDEBAR } from '../constants';
import { AskModal } from '../ai/ask';

/** Markdown 原文批注侧栏：查看 / 维护当前文件的原文批注 */
export class MdSidebarView extends ItemView {
  plugin: MinkSuite;
  private targetFile = '';
  private highlightId = '';

  constructor(leaf: import('obsidian').WorkspaceLeaf, plugin: MinkSuite) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_MD_SIDEBAR; }
  getDisplayText(): string { return 'Mink 原文批注'; }
  getIcon(): string { return 'notebook-pen'; }

  async setTarget(file: string, annoId?: string): Promise<void> {
    this.targetFile = file;
    this.highlightId = annoId ?? '';
    await this.plugin.mdStore.load(file);
    this.renderView();
    if (annoId) this.scrollToAnno(annoId);
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('mink-md-sidebar');
    // 默认跟随活动 Markdown 文件
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) {
      await this.setTarget(active.file.path);
    } else {
      this.renderView();
    }
    this.registerEvent(this.plugin.bus.on('md-anno-changed', ({ file }) => {
      if (file === this.targetFile) this.renderView();
    }));
    // 跟随活动文件切换
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      const view = leaf?.view;
      if (view instanceof MarkdownView && view.file && view.file.path !== this.targetFile) {
        void this.setTarget(view.file.path);
      }
    }));
  }

  private renderView(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('div', { cls: 'mink-md-sidebar-head', text: this.targetFile || '打开一个 Markdown 文件后显示批注' });

    if (!this.targetFile) return;
    const annos = this.plugin.mdStore.list(this.targetFile);
    const addBtn = contentEl.createEl('button', { cls: 'mink-btn mink-btn-primary', text: '批注选中文字' });
    addBtn.addEventListener('click', () => {
      void this.plugin.annotateSelection();
    });

    const list = contentEl.createEl('div', { cls: 'mink-center-list' });
    if (!annos.length) {
      list.createEl('div', { cls: 'mink-nav-empty', text: '暂无批注。选中文字后点上方按钮，或使用命令「为选中文字添加批注」。' });
      return;
    }
    for (const a of annos) this.renderAnno(list, a);
  }

  private renderAnno(list: HTMLElement, a: MdAnnotation): void {
    const item = list.createEl('div', {
      cls: `mink-center-row${this.highlightId === a.id ? ' is-highlight' : ''}`,
      attr: { 'data-anno-id': a.id },
    });

    const body = item.createEl('div', { cls: 'mink-center-row-body' });
    body.createEl('div', { cls: 'mink-center-quote', text: a.quote });
    const note = body.createEl('textarea', { cls: 'mink-md-note-input' });
    note.value = a.note;
    note.rows = 3;
    note.placeholder = '写下你的批注…';
    note.addEventListener('change', () => {
      a.note = note.value;
      a.modified = Date.now();
      void this.plugin.mdStore.update(this.targetFile, a);
    });
    const meta = body.createEl('div', { cls: 'mink-center-meta' });
    meta.setText(`第 ${a.line + 1} 行 · ${new Date(a.created).toLocaleString()}`);

    const ops = item.createEl('div', { cls: 'mink-center-ops' });
    const mkOp = (icon: string, title: string, fn: () => void) => {
      const b = ops.createEl('div', { cls: 'mink-op', attr: { title } });
      setIcon(b, icon);
      b.addEventListener('click', e => { e.stopPropagation(); void fn(); });
    };
    mkOp('crosshair', '定位到原文行', () => this.gotoAnno(a));
    mkOp('message-circle-question', 'AI 追问', () => {
      new AskModal(this.plugin, {
        title: 'AI 追问',
        quote: `${a.quote}${a.note ? `\n\n我的批注：${a.note}` : ''}`,
      }).open();
    });
    mkOp('bookmark-plus', '收藏为卡片', async () => {
      await this.plugin.cards.add({
        kind: 'anno',
        content: `${a.quote}${a.note ? `\n批注：${a.note}` : ''}`,
        file: this.targetFile,
        tags: ['Markdown 批注'],
      });
    });
    mkOp('trash-2', '删除批注', async () => {
      await this.plugin.mdStore.remove(this.targetFile, a.id);
    });
  }

  private gotoAnno(a: MdAnnotation): void {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === this.targetFile) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        const pos = { line: a.line, ch: 0 };
        view.editor.setCursor(pos);
        view.editor.scrollIntoView({ from: pos, to: pos }, true);
        return;
      }
    }
    void this.app.workspace.openLinkText(this.targetFile, '', false).then(() => {
      window.setTimeout(() => {
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (active) {
          const pos = { line: a.line, ch: 0 };
          active.editor.setCursor(pos);
          active.editor.scrollIntoView({ from: pos, to: pos }, true);
        }
      }, 400);
    });
  }

  private scrollToAnno(annoId: string): void {
    this.highlightId = annoId;
    this.renderView();
    const el = this.contentEl.querySelector(`[data-anno-id="${annoId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!el) new Notice('批注侧栏已更新');
  }
}
