import getStroke from 'perfect-freehand';
import type { Pt, Rect } from '../types';

export interface InkStyle {
  color: string;
  size: number;
  opacity?: number;
  /** 荧光笔：无粗细变化、半透明 */
  highlighter?: boolean;
}

/** perfect-freehand 生成笔迹轮廓（点为归一化坐标） */
export function makeStroke(points: Pt[], style: InkStyle): number[][] {
  const raw = points.map(p => [p.x, p.y, p.p ?? 0.5]);
  return getStroke(raw, {
    size: style.size,
    thinning: style.highlighter ? 0 : 0.55,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: true,
    last: false,
  });
}

/** 将轮廓绘制为填充路径 */
export function tracePath(ctx: CanvasRenderingContext2D, outline: number[][]): void {
  if (!outline.length) return;
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  ctx.closePath();
}

export function strokeBBox(points: Pt[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 橡皮/选择命中：点到笔迹中心线的距离 */
export function pointNearStroke(x: number, y: number, points: Pt[], radius: number): boolean {
  for (const p of points) {
    if ((p.x - x) ** 2 + (p.y - y) ** 2 <= radius * radius) return true;
  }
  return false;
}
