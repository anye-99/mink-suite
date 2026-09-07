/**
 * pdfjs 运行时加载器（PDF 大纲 / 文本搜索用）：
 * 仅复用 Obsidian 内置查看器可能暴露的 window.pdfjsLib（私有，不保证存在）。
 * 不可用时相关功能（大纲 / 全文搜索 / 标准批注导入）明确降级，不影响其他功能。
 * 说明：不运行时加载远程代码（Obsidian 开发者政策禁止）；cMaps 仅为数据文件。
 */
const PDFJS_CMAP = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/cmaps/';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsLib = any;

export function loadPdfjs(): PdfjsLib | null {
  const w = window as unknown as { pdfjsLib?: PdfjsLib };
  return w.pdfjsLib ?? null;
}

export interface PdfOutlineItem {
  title: string;
  page: number | null; // 1 起
  items?: PdfOutlineItem[];
}

/** 解析 PDF 大纲（含目的地页码解析；失败返回 null） */
export async function readOutline(
  data: ArrayBuffer,
): Promise<PdfOutlineItem[] | null> {
  const lib = await loadPdfjs();
  if (!lib) return null;
  try {
    const doc = await lib.getDocument({
      data: new Uint8Array(data.slice(0)),
      cMapUrl: PDFJS_CMAP,
      cMapPacked: true,
    }).promise;
    const outline = await doc.getOutline();
    if (!outline) return [];
    const convert = async (items: PdfjsLib[]): Promise<PdfOutlineItem[]> => {
      const out: PdfOutlineItem[] = [];
      for (const it of items) {
        let page: number | null = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await doc.getDestination(dest);
          if (Array.isArray(dest)) {
            const ref = dest[0];
            const idx = typeof ref === 'object' && ref !== null
              ? await doc.getPageIndex(ref)
              : typeof ref === 'number' ? ref : -1;
            if (idx >= 0) page = idx + 1;
          }
        } catch { /* 目的地解析失败，忽略页码 */ }
        out.push({
          title: it.title?.trim() || '(无标题)',
          page,
          items: it.items?.length ? await convert(it.items) : undefined,
        });
      }
      return out;
    };
    const result = await convert(outline);
    await doc.destroy();
    return result;
  } catch (e) {
    console.warn('[mink-suite] readOutline failed', e);
    return null;
  }
}

export interface PdfSearchHit { page: number; snippet: string }

/** 全文搜索（逐页 getTextContent，命中返回页码 + 摘要片段） */
export async function searchText(
  data: ArrayBuffer,
  query: string,
  limit = 50,
): Promise<PdfSearchHit[] | null> {
  const lib = await loadPdfjs();
  if (!lib) return null;
  try {
    const doc = await lib.getDocument({
      data: new Uint8Array(data.slice(0)),
      cMapUrl: PDFJS_CMAP,
      cMapPacked: true,
    }).promise;
    const hits: PdfSearchHit[] = [];
    const q = query.toLowerCase();
    outer:
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const text = tc.items
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((it: any) => it.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ');
      const lower = text.toLowerCase();
      let idx = lower.indexOf(q);
      while (idx >= 0) {
        const start = Math.max(0, idx - 20);
        hits.push({
          page: p,
          snippet: (start > 0 ? '…' : '') + text.slice(start, idx + query.length + 30).trim() + '…',
        });
        if (hits.length >= limit) break outer;
        idx = lower.indexOf(q, idx + q.length);
      }
    }
    await doc.destroy();
    return hits;
  } catch (e) {
    console.warn('[mink-suite] searchText failed', e);
    return null;
  }
}
