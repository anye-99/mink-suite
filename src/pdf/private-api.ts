import type { TFile, View } from 'obsidian';

/**
 * 私有 API 兼容层（风险集中点）：
 * Obsidian 公共 API 未暴露内置 PDF 查看器扩展点，
 * 此处通过 DOM 结构（.pdfViewer / .page）访问，属性名参考 PDF++（RyotaUshio/obsidian-pdf-plus）。
 * 若结构变化 → degrade()，仅禁用 PDF 扩展功能，不影响 .mink / 批注中心 / 卡片。
 */

export interface PdfViewLike extends View {
  viewer?: unknown;
  contentEl: HTMLElement;
  file: TFile | null;
}

export function isPdfView(view: unknown): view is PdfViewLike {
  const v = view as { getViewType?: () => string } | null;
  return !!v && typeof v.getViewType === 'function' && v.getViewType() === 'pdf';
}

export function getPdfViewerContainer(view: PdfViewLike): HTMLElement | null {
  return (view.contentEl?.querySelector('.pdfViewer') as HTMLElement | null) ?? null;
}

export function getPdfPages(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.page[data-page-number]')) as HTMLElement[];
}

export function pageNumberOf(el: HTMLElement): number {
  return parseInt(el.dataset.pageNumber ?? '1', 10) || 1;
}

/** 私有 API 可用性探测 */
export function probePdfExt(view: PdfViewLike): boolean {
  return !!getPdfViewerContainer(view);
}

/** 当前页码：优先 viewer 私有链，失败则按滚动位置估算 */
export function currentPageNumber(view: PdfViewLike): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = (view as any).viewer?.child;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pv = child?.pdfViewer as { currentPageNumber?: number } | undefined;
  if (pv?.currentPageNumber) return pv.currentPageNumber;
  const container = getPdfViewerContainer(view);
  if (!container) return 1;
  const cRect = container.getBoundingClientRect();
  const midY = cRect.top + cRect.height / 3;
  let best = 1, bestDist = Infinity;
  for (const p of getPdfPages(container)) {
    const r = p.getBoundingClientRect();
    if (r.height === 0) continue;
    const d = Math.abs(r.top - midY);
    if (d < bestDist) { bestDist = d; best = pageNumberOf(p); }
  }
  return best;
}

/** 页总数（viewer 私有链，失败按 DOM 最大页码） */
export function totalPages(view: PdfViewLike): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = (view as any).viewer?.child;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pv = child?.pdfViewer as { pagesCount?: number } | undefined;
  if (pv?.pagesCount) return pv.pagesCount;
  const container = getPdfViewerContainer(view);
  if (!container) return 1;
  let max = 1;
  for (const p of getPdfPages(container)) max = Math.max(max, pageNumberOf(p));
  return max;
}

/** 滚动到指定页：优先 pdfViewer 私有链，回退 DOM scrollIntoView */
export function scrollToPage(view: PdfViewLike, pageNumber: number): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = (view as any).viewer?.child;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pv = child?.pdfViewer as { scrollPageIntoView?: (p: { pageNumber: number }) => void } | undefined;
  if (typeof pv?.scrollPageIntoView === 'function') {
    try { pv.scrollPageIntoView({ pageNumber }); return true; } catch { /* fall through */ }
  }
  const container = getPdfViewerContainer(view);
  if (!container) return false;
  for (const p of getPdfPages(container)) {
    if (pageNumberOf(p) === pageNumber) {
      p.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
  }
  return false;
}
