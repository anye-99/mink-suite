import type { AnnoObject, Pt, Rect } from '../types';
import { uid } from '../core/ids';

export function pdfBase(file: string, page: number, kind: AnnoObject['kind'], tool?: string): AnnoObject {
  return {
    id: uid(),
    file,
    page,
    kind,
    created: Date.now(),
    modified: Date.now(),
    tool,
  };
}

/** DOM 客户端坐标 → 页归一化坐标（页宽 = 1000） */
export function clientToNorm(pageEl: HTMLElement, x: number, y: number): Pt {
  const r = pageEl.getBoundingClientRect();
  const f = r.width > 0 ? 1000 / r.width : 1;
  return { x: (x - r.left) * f, y: (y - r.top) * f };
}

/** DOMRect 列表 → 归一化矩形（合并相邻行可由调用方决定，此处逐行保留） */
export function rectsFromClientRects(pageEl: HTMLElement, rects: ArrayLike<DOMRect>): Rect[] {
  const pr = pageEl.getBoundingClientRect();
  const f = pr.width > 0 ? 1000 / pr.width : 1;
  const out: Rect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width <= 0 || r.height <= 0) continue;
    out.push({ x: (r.left - pr.left) * f, y: (r.top - pr.top) * f, w: r.width * f, h: r.height * f });
  }
  return out;
}

export function normRectFromPoints(pageEl: HTMLElement, a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
  };
}

/** 事件 → 归一化坐标点（含压感） */
export function pointFromEvent(pageEl: HTMLElement, e: PointerEvent, pressure: number): Pt {
  const p = clientToNorm(pageEl, e.clientX, e.clientY);
  p.p = pressure;
  return p;
}
