import { Modal, Notice, setIcon, TFile } from 'obsidian';
import type { Card } from '../types';
import type { MinkSuite } from '../main';
import { ocrNotice } from '../ai/ocr';
import { AskModal } from '../ai/ask';
import { TextResultModal } from '../core/text-result';
import { openAnno, copyText } from '../core/link';
import { blobToDataUrl } from '../core/snapshot';

const KIND_LABELS: Record<string, string> = {
  text: '文本', image: '截图', ocr: 'OCR', anno: '批注',
};

/** 阅读页卡片抽屉：不离开当前文档，搜索 / 筛选 / OCR / 管理卡片 */
export class CardDrawer extends Modal {
  private cards: Card[] = [];
  private query = '';
  private kind = '';
  private onlyCurrent = true;

  constructor(
    private plugin: MinkSuite,
    private currentFile: string,
  ) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('卡片收藏夹');
    this.contentEl.addClass('mink-card-drawer');
    this.modalEl.addClass('mink-card-drawer-modal');
    await this.reload();
    this.renderView();
  }

  private async reload(): Promise<void> {
    this.cards = await this.plugin.cards.list();
  }

  private filtered(): Card[] {
    let cards = this.cards;
    if (this.onlyCurrent && this.currentFile) {
      cards = cards.filter(c => c.file === this.currentFile);
    }
    if (this.kind) cards = cards.filter(c => c.kind === this.kind);
    if (this.query) {
      const q = this.query.toLowerCase();
      cards = cards.filter(c =>
        c.content.toLowerCase().includes(q)
        || c.tags.some(t => t.toLowerCase().includes(q)));
    }
    return cards;
  }

  private renderView(): void {
    const { contentEl } = this;
    contentEl.empty();
    const cards = this.filtered();

    // ---------- 工具条 ----------
    const bar = contentEl.createEl('div', { cls: 'mink-center-bar' });

    const search = bar.createEl('input', {
      cls: 'mink-nav-input mink-card-search', type: 'text',
      attr: { placeholder: '搜索卡片内容或标签…' },
    });
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value.trim();
      this.renderList();
    });

    const kindSel = bar.createEl('select', { cls: 'mink-center-select' });
    kindSel.createEl('option', { text: '全部类型', attr: { value: '' } });
    for (const [k, label] of Object.entries(KIND_LABELS)) {
      const opt = kindSel.createEl('option', { text: label, attr: { value: k } });
      if (k === this.kind) (opt as HTMLOptionElement).selected = true;
    }
    kindSel.addEventListener('change', () => {
      this.kind = kindSel.value;
      this.renderView();
    });

    const scopeBtn = bar.createEl('button', {
      cls: 'mink-btn',
      text: this.onlyCurrent ? '当前文档' : '全部卡片',
      attr: { title: '切换范围' },
    });
    scopeBtn.addEventListener('click', () => {
      this.onlyCurrent = !this.onlyCurrent;
      this.renderView();
    });

    // ---------- 列表 ----------
    const listWrap = contentEl.createEl('div', { cls: 'mink-center-list' });
    this.listEl = listWrap;
    this.renderList();
    void cards;
  }

  private listEl: HTMLElement | null = null;

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const cards = this.filtered();
    if (!cards.length) {
      this.listEl.createEl('div', { cls: 'mink-nav-empty', text: '暂无卡片' });
      return;
    }
    for (const c of cards) this.renderCard(this.listEl, c);
  }

  private renderCard(list: HTMLElement, c: Card): void {
    const item = list.createEl('div', { cls: 'mink-card-item' });

    if (c.snapshot) {
      const img = item.createEl('img', { cls: 'mink-card-thumb', attr: { alt: '' } });
      void this.loadThumb(img, c.snapshot);
    }

    const body = item.createEl('div', { cls: 'mink-card-body' });
    const head = body.createEl('div', { cls: 'mink-center-row-head' });
    const badge = head.createEl('span', { cls: `mink-kind-badge mink-kind-${c.kind}` });
    badge.setText(KIND_LABELS[c.kind] ?? c.kind);
    const meta = head.createEl('span', { cls: 'mink-center-meta' });
    meta.setText(`${c.file ?? ''}${c.page != null ? ` · ${typeof c.page === 'number' ? '第 ' + c.page + ' 页' : c.page}` : ''}`);

    body.createEl('div', { cls: 'mink-card-content', text: c.content });
    if (c.tags.length) {
      const tags = body.createEl('div', { cls: 'mink-card-tags' });
      for (const t of c.tags) tags.createEl('span', { cls: 'mink-card-tag', text: t });
    }

    const ops = item.createEl('div', { cls: 'mink-center-ops' });
    const mkOp = (icon: string, title: string, fn: () => void) => {
      const b = ops.createEl('div', { cls: 'mink-op', attr: { title } });
      setIcon(b, icon);
      b.addEventListener('click', e => { e.stopPropagation(); void fn(); });
    };

    if (c.file) {
      mkOp('crosshair', '定位到来源', () => {
        void openAnno(this.app, this.plugin.bus, c.file!, typeof c.page === 'number' ? c.page : undefined, c.annoId);
      });
    }
    if (c.snapshot) {
      mkOp('scan-text', 'OCR 识别截图', async () => {
        if (!this.plugin.ai.configured()) {
          new Notice('OCR 需要 AI 接口：请在设置 → Mink 妙笔批注套件 → AI 中配置');
          return;
        }
        const dataUrl = await this.snapshotToDataUrl(c.snapshot!);
        if (!dataUrl) { new Notice('找不到卡片截图'); return; }
        ocrNotice();
        try {
          const text = await this.plugin.ai.askImage('请识别并输出图片中的所有文字，保持原有换行。', [dataUrl]);
          new TextResultModal(this.plugin, text, { file: c.file ?? '', page: c.page, link: '' }).open();
        } catch (e) {
          new Notice(`OCR 失败：${(e as Error).message}`);
        }
      });
    }
    mkOp('copy', '复制内容', async () => {
      await copyText(c.content, '已复制卡片内容');
    });
    mkOp('message-circle-question', 'AI 追问', () => {
      new AskModal(this.plugin, { title: 'AI 追问', quote: c.content }).open();
    });
    mkOp('trash-2', '删除卡片', async () => {
      await this.plugin.cards.remove(c.id);
      await this.reload();
      this.renderList();
    });
  }

  private async loadThumb(img: HTMLImageElement, rel: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(rel);
    if (!(f instanceof TFile)) return;
    try {
      const buf = await this.app.vault.readBinary(f);
      const blob = new Blob([buf], { type: 'image/png' });
      img.src = await blobToDataUrl(blob);
    } catch { /* ignore */ }
  }

  private async snapshotToDataUrl(rel: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(rel);
    if (!(f instanceof TFile)) return null;
    try {
      const buf = await this.app.vault.readBinary(f);
      const blob = new Blob([buf], { type: 'image/png' });
      return await blobToDataUrl(blob);
    } catch {
      return null;
    }
  }
}
