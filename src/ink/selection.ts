import type { AnnoObject, Pt, Rect } from '../types';
import { objectBBox } from './render';
import { pointNearStroke } from './engine';

/** 对象集合包围盒 */
export function objectsBBox(objs: AnnoObject[]): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objs) {
    const b = objectBBox(o);
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 单对象命中（归一化坐标 + 容差） */
export function hitTest(obj: AnnoObject, x: number, y: number, tol: number): boolean {
  if (obj.points?.length) {
    return pointNearStroke(x, y, obj.points, tol + (obj.size ?? 4));
  }
  const b = objectBBox(obj);
  if (!b) return false;
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}

/** 框选 */
export function marqueeSelect(objs: AnnoObject[], rect: Rect): AnnoObject[] {
  return objs.filter(o => {
    const b = objectBBox(o);
    if (!b) return false;
    return b.x >= rect.x && b.y >= rect.y
      && b.x + b.w <= rect.x + rect.w && b.y + b.h <= rect.y + rect.h;
  });
}

/** 套索选择：任一点落在多边形内 */
export function lassoSelect(objs: AnnoObject[], poly: Pt[]): AnnoObject[] {
  return objs.filter(o => {
    const pts: Pt[] = o.points ?? [];
    const rects = o.rects ?? [];
    const sample: Pt[] = [...pts];
    if (!sample.length && rects.length) {
      for (const r of rects) {
        sample.push({ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
      }
    }
    return sample.some(p => pointInPoly(p, poly));
  });
}

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y))
      && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 平移（返回新对象数组，不修改原对象） */
export function translateObjects(objs: AnnoObject[], dx: number, dy: number): AnnoObject[] {
  return objs.map(o => {
    const n: AnnoObject = { ...o, rects: o.rects?.map(r => ({ ...r, x: r.x + dx, y: r.y + dy })) };
    if (o.points) n.points = o.points.map(p => ({ x: p.x + dx, y: p.y + dy, p: p.p }));
    return n;
  });
}

/** 缩放：把 bbox 映射为 newBbox */
export function scaleObjects(objs: AnnoObject[], bbox: Rect, newBbox: Rect): AnnoObject[] {
  const sx = newBbox.w / bbox.w;
  const sy = newBbox.h / bbox.h;
  return objs.map(o => {
    const n: AnnoObject = {
      ...o,
      rects: o.rects?.map(r => ({
        x: newBbox.x + (r.x - bbox.x) * sx,
        y: newBbox.y + (r.y - bbox.y) * sy,
        w: r.w * sx, h: r.h * sy,
      })),
    };
    if (o.points) {
      n.points = o.points.map(p => ({
        x: newBbox.x + (p.x - bbox.x) * sx,
        y: newBbox.y + (p.y - bbox.y) * sy,
        p: p.p,
      }));
      n.size = (o.size ?? 4) * ((sx + sy) / 2);
    }
    if (o.rects && !o.points) n.size = (o.size ?? 3) * ((sx + sy) / 2);
    return n;
  });
}

/** 深拷贝并分配新 id */
export function cloneObjects(objs: AnnoObject[], newId: () => string, offset = 24): AnnoObject[] {
  return objs.map(o => {
    const n: AnnoObject = JSON.parse(JSON.stringify(o));
    n.id = newId();
    n.created = Date.now();
    n.modified = Date.now();
    if (n.rects) n.rects = n.rects.map(r => ({ ...r, x: r.x + offset, y: r.y + offset }));
    if (n.points) n.points = n.points.map(p => ({ x: p.x + offset, y: p.y + offset, p: p.p }));
    return n;
  });
}
