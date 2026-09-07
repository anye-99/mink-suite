import { ItemView, Notice, TFile, setIcon } from 'obsidian';
import type { AnnoObject } from '../types';
import type { MinkSuite } from '../main';
import { VIEW_TYPE_ANNOTATION_CENTER } from '../constants';
import { openAnno } from '../core/link';
import { AskModal } from '../ai/ask';
import { TextResultModal } from '../core/text-result';
import { NoteModal } from '../pdf/note-modal';
import { readDoc } from '../mink/file';
import { exportDuowei, KIND_LABELS, rowFromAnno, rowFromMd, type AnnoRow } from './duowei';
import { inkToText } from './ink-to-text';

/** 批注中心：按文档 / 按时间集中查看与操作全部批注 */
export class AnnotationCenterView extends ItemView {
  plugin: MinkSuite;
  private rows: AnnoRow[] = [];
  private filterFile = '';
  private filterKind = '';
  private sortMode: 'time' | 'doc' = 'time';
  private selected = new Set<string>();
  private rowKey = (r: AnnoRow): string =>
    r.anno ? r.anno.id : `md:${r.mdAnno?.id}`;

  constructor(leaf: import('obsidian').WorkspaceLeaf, plugin: MinkSuite) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_ANNOTATION_CENTER; }
  getDisplayText(): string { return 'Mink 批注中心'; }
  getIcon(): string { return 'notebook-pen'; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('mink-center');
    await this.collect();
    this.renderView();
    this.registerEvent(this.plugin.bus.on('anno-changed', () => {
      void this.collect().then(() => this.renderView());
    }));
    this.registerEvent(this.plugin.bus.on('md-anno-changed', () => {
      void this.collect().then(() => this.renderView());
    }));
  }

  private async collect(): Promise<void> {
    const rows: AnnoRow[] = [];
    // PDF 批注（侧车）
    for (const sc of await this.plugin.annoStore.loadAll()) {
      for (const o of sc.objects) {
        if (o.kind === 'mask' || o.kind === 'sticker') continue;
        rows.push(rowFromAnno(o));
      }
    }
    // Markdown 批注（侧车）
    for (const sc of await this.plugin.mdStore.loadAll()) {
      for (const a of sc.annotations) rows.push(rowFromMd(sc.file, a));
    }
    // .mink 独立手写笔记（直接读文件）
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== 'mink') continue;
      try {
        const doc = await readDoc(this.app, f);
        const pageIndex = new Map(doc.pages.map((p, i) => [p.id, i + 1]));
        for (const o of doc.objects) {
          if (o.kind === 'sticky' || o.kind === 'mask') continue;
          const r = rowFromAnno(o);
          r.page = pageIndex.get(String(o.page)) ?? null;
          rows.push(r);
        }
      } catch { /* 跳过损坏文件 */ }
    }
    this.rows = rows;
  }

  private filtered(): AnnoRow[] {
    let rows = this.rows;
    if (this.filterFile) rows = rows.filter(r => r.file === this.filterFile);
    if (this.filterKind) rows = rows.filter(r => r.kind === this.filterKind);
    rows = [...rows].sort((a, b) => b.created - a.created);
    if (this.sortMode === 'doc') {
      rows.sort((a, b) => a.file.localeCompare(b.file) || b.created - a.created);
    }
    return rows;
  }

  private renderView(): void {
    const { contentEl } = this;
    contentEl.empty();
    const rows = this.filtered();

    // ---------- 工具条 ----------
    const bar = contentEl.createEl('div', { cls: 'mink-center-bar' });
    const fileSel = bar.createEl('select', { cls: 'mink-center-select' });
    const files = Array.from(new Set(this.rows.map(r => r.file))).sort();
    fileSel.createEl('option', { text: '全部文档', attr: { value: '' } });
    for (const f of files) {
      const opt = fileSel.createEl('option', { text: f, attr: { value: f } });
      if (f === this.filterFile) (opt as HTMLOptionElement).selected = true;
    }
    fileSel.addEventListener('change', () => {
      this.filterFile = fileSel.value;
      this.renderView();
    });

    const kindSel = bar.createEl('select', { cls: 'mink-center-select' });
    const kinds = Array.from(new Set(this.rows.map(r => r.kind)));
    kindSel.createEl('option', { text: '全部类型', attr: { value: '' } });
    for (const k of kinds) {
      const opt = kindSel.createEl('option', { text: KIND_LABELS[k] ?? k, attr: { value: k } });
      if (k === this.filterKind) (opt as HTMLOptionElement).selected = true;
    }
    kindSel.addEventListener('change', () => {
      this.filterKind = kindSel.value;
      this.renderView();
    });

    const sortBtn = bar.createEl('button', {
      cls: 'mink-btn',
      text: this.sortMode === 'time' ? '按时间' : '按文档',
      attr: { title: '切换排序方式' },
    });
    sortBtn.addEventListener('click', () => {
      this.sortMode = this.sortMode === 'time' ? 'doc' : 'time';
      this.renderView();
    });

    const selAll = bar.createEl('label', { cls: 'mink-center-selall' });
    const cb = selAll.createEl('input', { type: 'checkbox' });
    cb.addEventListener('change', () => {
      this.selected.clear();
      if (cb.checked) for (const r of rows) this.selected.add(this.rowKey(r));
      this.renderView();
    });
    selAll.createSpan({ text: ' 全选' });

    const exportSel = bar.createEl('button', { cls: 'mink-btn mink-btn-primary', text: '导出所选' });
    exportSel.addEventListener('click', () => {
      const chosen = rows.filter(r => this.selected.has(this.rowKey(r)));
      if (!chosen.length) { new Notice('请先勾选要导出的批注'); return; }
      void exportDuowei(this.app, chosen, this.exportName('所选'));
    });
    const exportFiltered = bar.createEl('button', { cls: 'mink-btn', text: '导出当前筛选' });
    exportFiltered.addEventListener('click', () => {
      if (!rows.length) { new Notice('当前筛选无批注'); return; }
      void exportDuowei(this.app, rows, this.exportName('筛选'));
    });

    contentEl.createEl('div', { cls: 'mink-center-count', text: `共 ${rows.length} 条批注` });

    // ---------- 列表 ----------
    const list = contentEl.createEl('div', { cls: 'mink-center-list' });
    if (!rows.length) {
      list.createEl('div', { cls: 'mink-nav-empty', text: '暂无批注' });
      return;
    }
    let lastFile = '';
    for (const r of rows) {
      if (this.sortMode === 'doc' && r.file !== lastFile) {
        lastFile = r.file;
        list.createEl('div', { cls: 'mink-center-file-head', text: r.file });
      }
      this.renderRow(list, r, rows);
    }
  }

  private exportName(prefix: string): string {
    const base = this.filterFile ? this.filterFile.replace(/\.[^.]+$/, '') : '全部批注';
    return `Mink-${prefix}批注-${base}`;
  }

  private renderRow(list: HTMLElement, r: AnnoRow, allRows: AnnoRow[]): void {
    void allRows;
    const item = list.createEl('div', { cls: 'mink-center-row' });
    const key = this.rowKey(r);

    const cb = item.createEl('input', { type: 'checkbox', cls: 'mink-center-cb' });
    cb.checked = this.selected.has(key);
    cb.addEventListener('change', () => {
      if (cb.checked) this.selected.add(key);
      else this.selected.delete(key);
    });

    const body = item.createEl('div', { cls: 'mink-center-row-body' });
    const head = body.createEl('div', { cls: 'mink-center-row-head' });
    const badge = head.createEl('span', { cls: `mink-kind-badge mink-kind-${r.kind}` });
    badge.setText(KIND_LABELS[r.kind] ?? r.kind);
    const meta = head.createEl('span', { cls: 'mink-center-meta' });
    const t = new Date(r.created);
    meta.setText(
      `${r.file}${r.page != null ? ` · 第 ${r.page} 页` : ''} · ${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`,
    );

    if (r.quote) body.createEl('div', { cls: 'mink-center-quote', text: r.quote });
    if (r.note) body.createEl('div', { cls: 'mink-center-note', text: r.note });

    const ops = item.createEl('div', { cls: 'mink-center-ops' });
    const mkOp = (icon: string, title: string, fn: () => void) => {
      const b = ops.createEl('div', { cls: 'mink-op', attr: { title } });
      setIcon(b, icon);
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    };

    mkOp('crosshair', '定位到原文', () => {
      if (r.file.endsWith('.mink')) {
        void openAnno(this.app, this.plugin.bus, r.file);
      } else {
        void openAnno(this.app, this.plugin.bus, r.file, r.page ?? undefined, r.anno?.id);
      }
    });
    if (r.anno?.kind === 'note') {
      mkOp('pencil', '编辑笔记', () => {
        new NoteModal(this.plugin, r.anno!, false).open();
      });
    }
    if (r.mdAnno) {
      mkOp('pencil', '编辑批注', () => {
        void this.editMdAnno(r);
      });
    }
    if (r.anno?.kind === 'ink') {
      mkOp('type', '转文字（AI 识别手写）', () => {
        void this.transcribe(r.anno!);
      });
    }
    mkOp('message-circle-question', 'AI 追问', () => {
      new AskModal(this.plugin, {
        title: 'AI 追问',
        quote: `${r.quote}${r.note ? `\n\n我的笔记：${r.note}` : ''}`,
      }).open();
    });
    mkOp('bookmark-plus', '收藏为学习卡片', () => {
      void this.toCard(r);
    });
    mkOp('trash-2', '删除', () => {
      void this.removeRow(r);
    });
  }

  private async transcribe(anno: AnnoObject): Promise<void> {
    new Notice('AI 识别手写中…');
    try {
      const text = await inkToText(this.plugin, anno);
      new TextResultModal(this.plugin, text, { file: anno.file, page: anno.page, link: '' }).open();
    } catch (e) {
      new Notice(`转文字失败：${(e as Error).message}`);
    }
  }

  private async toCard(r: AnnoRow): Promise<void> {
    await this.plugin.cards.add({
      kind: 'anno',
      content: `${r.quote}${r.note ? `\n笔记：${r.note}` : ''}`,
      file: r.file,
      page: r.page ?? undefined,
      annoId: r.anno?.id,
      tags: ['批注', KIND_LABELS[r.kind] ?? r.kind],
    });
  }

  private async removeRow(r: AnnoRow): Promise<void> {
    if (r.file.endsWith('.mink') && r.anno) {
      // .mink 对象存于笔记文件本身，不走侧车
      const f = this.app.vault.getAbstractFileByPath(r.file);
      if (f instanceof TFile) {
        const doc = await readDoc(this.app, f);
        doc.objects = doc.objects.filter(o => o.id !== r.anno!.id);
        await this.app.vault.modify(f, JSON.stringify(doc));
      }
    } else if (r.anno) {
      await this.plugin.annoStore.remove(r.file, r.anno.id);
    } else if (r.mdAnno) {
      await this.plugin.mdStore.remove(r.file, r.mdAnno.id);
    }
    await this.collect();
    this.renderView();
  }

  private async editMdAnno(r: AnnoRow): Promise<void> {
    if (!r.mdAnno) return;
    const { TextInputModal } = await import('../core/modals');
    new TextInputModal(this.app, '编辑批注笔记', r.mdAnno.note, v => {
      r.mdAnno!.note = v;
      r.mdAnno!.modified = Date.now();
      void this.plugin.mdStore.update(r.file, r.mdAnno!);
    }).open();
  }
}
