import { ItemView, Notice, TFile, setIcon } from 'obsidian';
import type { MinkSuite } from '../main';
import { VIEW_TYPE_PDF_NAV } from '../constants';
import type { PdfOutlineItem, PdfSearchHit } from './pdfjs';
import { readOutline, searchText } from './pdfjs';
import { isPdfView, currentPageNumber, totalPages, scrollToPage } from './private-api';
import { pdfWikiLink } from '../core/link';

/** PDF 阅读导航侧栏：目录 / 书签 / 搜索 / 页码定位 / 出链引用框 */
export class PdfNavView extends ItemView {
  plugin: MinkSuite;
  private outline: PdfOutlineItem[] | null = null;
  private searching = false;

  constructor(leaf: import('obsidian').WorkspaceLeaf, plugin: MinkSuite) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_PDF_NAV; }
 getDisplayText(): string { return 'Mink PDF 导航'; }
getIcon(): string { return 'map'; }

  get pdfView(): import('./private-api').PdfViewLike | null {
    const leaves = this.app.workspace.getLeavesOfType('pdf');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (isPdfView(view)) return view;
    }
    return null;
  }

  get pdfFile(): TFile | null {
    return this.pdfView?.file ?? null;
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('mink-pdf-nav');
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const file = this.pdfFile;
    if (!file) {
      contentEl.createEl('div', { cls: 'mink-nav-empty', text: '请先打开一个 PDF 文件' });
      return;
    }

    // ---------- 页码定位 ----------
    const jump = contentEl.createEl('div', { cls: 'mink-nav-section' });
    jump.createEl('div', { cls: 'mink-nav-title', text: '页码定位' });
    const row = jump.createEl('div', { cls: 'mink-nav-jump' });
    const input = row.createEl('input', {
      cls: 'mink-nav-input', type: 'number',
      attr: { placeholder: '页码', min: '1' },
    });
    const go = () => {
      const n = parseInt(input.value, 10);
      const view = this.pdfView;
      if (!view || !n || n < 1) return;
      if (scrollToPage(view, n)) {
        void this.plugin.annoStore.load(file.path);
      } else {
        new Notice(`未找到第 ${n} 页`);
      }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    const btn = row.createEl('button', { cls: 'mink-btn mink-btn-primary', text: '跳转' });
    btn.addEventListener('click', go);

    const view = this.pdfView!;
    jump.createEl('div', { cls: 'mink-nav-hint', text: `当前第 ${currentPageNumber(view)} 页 / 共 ${totalPages(view)} 页` });

    // ---------- 书签 ----------
    const bmSection = contentEl.createEl('div', { cls: 'mink-nav-section' });
    bmSection.createEl('div', { cls: 'mink-nav-title', text: '书签' });
    const addBm = bmSection.createEl('button', { cls: 'mink-btn', text: '收藏当前页书签', attr: { title: '为当前页添加书签' } });
    addBm.addEventListener('click', async () => {
      const v = this.pdfView;
      if (!v) return;
      await this.plugin.annoStore.addBookmark(file.path, {
        page: currentPageNumber(v),
        label: `第 ${currentPageNumber(v)} 页`,
        created: Date.now(),
      });
      new Notice('已添加书签');
      await this.render();
    });
    const bookmarks = await this.plugin.annoStore.getBookmarks(file.path);
    if (!bookmarks.length) {
      bmSection.createEl('div', { cls: 'mink-nav-empty', text: '暂无书签' });
    }
    for (const bm of bookmarks) {
      const item = bmSection.createEl('div', { cls: 'mink-nav-item' });
      const label = item.createEl('div', { cls: 'mink-nav-item-label', text: `${bm.label}` });
      void label;
      item.addEventListener('click', () => {
        const v = this.pdfView;
        if (v) scrollToPage(v, bm.page);
      });
      const del = item.createEl('div', { cls: 'mink-nav-item-del', text: '✕' });
      del.addEventListener('click', async e => {
        e.stopPropagation();
        await this.plugin.annoStore.removeBookmark(file.path, bm.page);
        await this.render();
      });
    }

    // ---------- 目录 ----------
    const tocSection = contentEl.createEl('div', { cls: 'mink-nav-section' });
    tocSection.createEl('div', { cls: 'mink-nav-title', text: '目录' });
    if (this.outline === null) {
      const loading = tocSection.createEl('div', { cls: 'mink-nav-empty', text: '加载目录…' });
      const data = await this.app.vault.readBinary(file);
      this.outline = await readOutline(data);
      loading.remove();
    }
    if (!this.outline?.length) {
      tocSection.createEl('div', { cls: 'mink-nav-empty', text: '此 PDF 无目录（或 pdf.js 加载失败）' });
    } else {
      const renderItems = (parent: HTMLElement, items: PdfOutlineItem[], depth: number) => {
        for (const it of items) {
          const item = parent.createEl('div', {
            cls: 'mink-nav-item mink-nav-outline-item',
            attr: { style: `padding-left:${8 + depth * 14}px` },
          });
          item.createEl('span', { text: it.title });
          if (it.page != null) {
            item.createEl('span', { cls: 'mink-nav-page-no', text: ` ${it.page}` });
          }
          item.addEventListener('click', () => {
            const v = this.pdfView;
            if (v && it.page != null) scrollToPage(v, it.page);
          });
          if (it.items?.length) renderItems(parent, it.items, depth + 1);
        }
      };
      renderItems(tocSection, this.outline, 0);
    }

    // ---------- 搜索 ----------
    const searchSection = contentEl.createEl('div', { cls: 'mink-nav-section' });
    searchSection.createEl('div', { cls: 'mink-nav-title', text: '文本搜索' });
    const srow = searchSection.createEl('div', { cls: 'mink-nav-jump' });
    const sinput = srow.createEl('input', {
      cls: 'mink-nav-input', type: 'text', attr: { placeholder: '搜索 PDF 全文…' },
    });
    const doSearch = async () => {
      const q = sinput.value.trim();
      if (!q || this.searching) return;
      this.searching = true;
      results.empty();
      results.createEl('div', { cls: 'mink-nav-empty', text: '搜索中…（首次需联网加载 pdf.js）' });
      const data = await this.app.vault.readBinary(file);
      const hits = await searchText(data, q);
      this.searching = false;
      results.empty();
      if (hits === null) {
        results.createEl('div', { cls: 'mink-nav-empty', text: 'pdf.js 加载失败，无法搜索' });
        return;
      }
      if (!hits.length) {
        results.createEl('div', { cls: 'mink-nav-empty', text: '无结果' });
        return;
      }
      for (const hit of hits) {
        const item = results.createEl('div', { cls: 'mink-nav-item mink-nav-hit' });
        item.createEl('div', { cls: 'mink-nav-hit-page', text: `P${hit.page}` });
        item.createEl('div', { cls: 'mink-nav-hit-snippet', text: hit.snippet });
        item.addEventListener('click', () => {
          const v = this.pdfView;
          if (v) scrollToPage(v, hit.page);
        });
      }
    };
    sinput.addEventListener('keydown', e => { if (e.key === 'Enter') void doSearch(); });
    const sbtn = srow.createEl('button', { cls: 'mink-btn mink-btn-primary', text: '搜索' });
    sbtn.addEventListener('click', () => void doSearch());
    const results = searchSection.createEl('div', { cls: 'mink-nav-results' });

    // ---------- 出链引用框 ----------
    const blSection = contentEl.createEl('div', { cls: 'mink-nav-section' });
    blSection.createEl('div', { cls: 'mink-nav-title', text: '出链引用' });
    const links = this.plugin.backlinksOf(file.path);
    if (!links.length) {
      blSection.createEl('div', { cls: 'mink-nav-empty', text: '暂无笔记引用此 PDF' });
    } else {
      for (const [src, count] of links) {
        const item = blSection.createEl('div', { cls: 'mink-nav-item' });
        const icon = item.createEl('span', { cls: 'mink-nav-bl-icon' });
        setIcon(icon, 'file-text');
        item.createEl('span', { text: ` ${src}` });
        item.createEl('span', { cls: 'mink-nav-page-no', text: ` ×${count}` });
        item.addEventListener('click', () => {
          void this.app.workspace.openLinkText(src, '', false);
        });
      }
    }

    // 回链当前页按钮
    const linkRow = contentEl.createEl('div', { cls: 'mink-nav-section' });
    const copyLink = linkRow.createEl('button', { cls: 'mink-btn', text: '复制当前页回链' });
    copyLink.addEventListener('click', async () => {
      const v = this.pdfView;
      if (!v) return;
      const link = pdfWikiLink(file.path, currentPageNumber(v));
      try {
        await navigator.clipboard.writeText(link);
        new Notice('已复制回链');
      } catch { new Notice('复制失败'); }
    });
  }

  async onClose(): Promise<void> {
    this.outline = null;
  }
}
