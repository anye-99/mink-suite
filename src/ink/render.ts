import type { AnnoObject, Pt, Rect } from '../types';
import { makeStroke, tracePath } from './engine';
import { getSticker } from './stickers';

export interface RenderEnv {
  /** 预加载的图片：vault 路径 → HTMLImageElement */
  images?: Map<string, HTMLImageElement>;
}

/** 对象包围盒（归一化坐标） */
export function objectBBox(o: AnnoObject): Rect | null {
  if (o.points?.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of o.points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const pad = (o.size ?? 4) / 2 + 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  if (o.rects?.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of o.rects) {
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return null;
}

/** 绘制单个对象。对象坐标为归一化单位（页宽 1000），scale = 像素/归一化单位 */
export function drawObject(
  ctx: CanvasRenderingContext2D,
  o: AnnoObject,
  scale: number,
  env?: RenderEnv,
): void {
  ctx.save();
  switch (o.kind) {
    case 'ink':
      drawInk(ctx, o, scale);
      break;
    case 'highlight':
      drawFillRects(ctx, o, scale, 0.35);
      break;
    case 'underline':
      drawUnderline(ctx, o, scale);
      break;
    case 'note':
      drawFillRects(ctx, o, scale, 0.12);
      drawNoteBadge(ctx, o, scale);
      break;
    case 'rect':
      drawRectShape(ctx, o, scale);
      break;
    case 'ellipse':
      drawEllipseShape(ctx, o, scale);
      break;
    case 'line':
    case 'arrow':
    case 'arrow2':
      drawLineShape(ctx, o, scale);
      break;
    case 'text':
      drawTextObject(ctx, o, scale);
      break;
    case 'image':
      drawImageObject(ctx, o, scale, env);
      break;
    case 'sticker':
      drawStickerObject(ctx, o, scale);
      break;
    case 'sticky':
      drawStickyObject(ctx, o, scale);
      break;
    case 'mask':
      drawMaskObject(ctx, o, scale);
      break;
  }
  ctx.restore();
}

export function drawInk(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  if (!o.points?.length) return;
  const style = {
    color: o.color ?? '#2f6fdb',
    size: (o.size ?? 4) * scale,
    highlighter: o.tool === 'highlighter' || (o.opacity ?? 1) < 1,
  };
  const outline = makeStroke(o.points, style);
  ctx.globalAlpha = o.tool === 'highlighter' ? 0.45 : (o.opacity ?? 1);
  ctx.fillStyle = style.color;
  tracePath(ctx, outline);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawFillRects(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number, alpha: number): void {
  if (!o.rects?.length) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = o.color ?? '#ffe066';
  for (const r of o.rects) {
    ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  }
  ctx.globalAlpha = 1;
}

function drawUnderline(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  if (!o.rects?.length) return;
  ctx.strokeStyle = o.color ?? '#e8590c';
  ctx.lineWidth = Math.max(1.5, (o.size ?? 3) * scale);
  for (const r of o.rects) {
    const y = (r.y + r.h - 1) * scale;
    ctx.beginPath();
    ctx.moveTo(r.x * scale, y);
    ctx.lineTo((r.x + r.w) * scale, y);
    ctx.stroke();
  }
}

function drawNoteBadge(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  const r = o.rects?.[0];
  if (!r) return;
  const cx = (r.x + r.w + 10) * scale;
  const cy = r.y * scale;
  ctx.fillStyle = '#f08c00';
  ctx.beginPath();
  ctx.arc(cx, cy, 9 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${11 * scale}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, cy);
}

function drawRectShape(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  const r = o.rects?.[0];
  if (!r) return;
  applyStroke(ctx, o, scale);
  ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
}

function drawEllipseShape(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  const r = o.rects?.[0];
  if (!r) return;
  applyStroke(ctx, o, scale);
  ctx.beginPath();
  ctx.ellipse(
    (r.x + r.w / 2) * scale, (r.y + r.h / 2) * scale,
    (r.w / 2) * scale, (r.h / 2) * scale,
    0, 0, Math.PI * 2,
  );
  ctx.stroke();
}

function applyStroke(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  ctx.strokeStyle = o.color ?? '#e8590c';
  ctx.lineWidth = Math.max(1, (o.size ?? 3) * scale);
  if (o.dash) ctx.setLineDash([6 * scale, 4 * scale]);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
}

function drawLineShape(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  const r = o.rects?.[0];
  if (!r) return;
  const x1 = r.x * scale, y1 = r.y * scale;
  const x2 = (r.x + r.w) * scale, y2 = (r.y + r.h) * scale;
  applyStroke(ctx, o, scale);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  if (o.kind !== 'line') {
    drawArrowHead(ctx, x1, y1, x2, y2, o, scale);
    if (o.kind === 'arrow2') drawArrowHead(ctx, x2, y2, x1, y1, o, scale);
  }
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  fromX: number, fromY: number, tipX: number, tipY: number,
  o: AnnoObject, scale: number,
): void {
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const len = Math.max(8, (o.size ?? 3) * scale * 4);
  ctx.fillStyle = o.color ?? '#e8590c';
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - len * Math.cos(angle - Math.PI / 6), tipY - len * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(tipX - len * Math.cos(angle + Math.PI / 6), tipY - len * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function drawTextObject(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  const r = o.rects?.[0];
  if (!r) return;
  const size = (o.size ?? 18) * scale;
  ctx.fillStyle = o.color ?? '#1f2937';
  ctx.font = `${size}px sans-serif`;
  ctx.textBaseline = 'top';
  const lines = (o.text ?? '').split('\n');
  let y = r.y * scale;
  for (const line of lines) {
    ctx.fillText(line, r.x * scale, y);
    y += size * 1.3;
  }
}

function drawImageObject(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number, env?: RenderEnv): void {
  const r = o.rects?.[0];
  if (!r || !o.src) return;
  const img = env?.images?.get(o.src);
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  } else {
    ctx.strokeStyle = '#adb5bd';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  }
}

function drawStickerObject(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  const r = o.rects?.[0];
  const def = getSticker(o.stickerId ?? '');
  if (!r || !def) return;
  const path = new Path2D(def.path);
  ctx.save();
  ctx.translate(r.x * scale, r.y * scale);
  const s = (Math.min(r.w, r.h) * scale) / 24;
  ctx.scale(s, s);
  ctx.fillStyle = o.color ?? def.color;
  ctx.fill(path, def.evenodd ? 'evenodd' : 'nonzero');
  ctx.restore();
}

/** 便利贴的静态渲染（快照/导出用；交互视图用 DOM） */
function drawStickyObject(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  const r = o.rects?.[0];
  if (!r) return;
  const x = r.x * scale, y = r.y * scale, w = r.w * scale, h = r.h * scale;
  ctx.fillStyle = o.bg ?? '#ffe066';
  roundRect(ctx, x, y, w, h, 4 * scale);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 4 * scale);
  ctx.stroke();
  const text = o.text ?? '';
  if (text) {
    ctx.fillStyle = '#212529';
    const fs = (o.size ?? 16) * scale;
    ctx.font = `${fs}px sans-serif`;
    ctx.textBaseline = 'top';
    wrapText(ctx, text, x + 6 * scale, y + 6 * scale, w - 12 * scale, h - 12 * scale, fs * 1.35);
  }
}

function drawMaskObject(ctx: CanvasRenderingContext2D, o: AnnoObject, scale: number): void {
  if (!o.rects?.length) return;
  if (o.revealed) {
    ctx.strokeStyle = o.color ?? '#495057';
    ctx.setLineDash([5 * scale, 3 * scale]);
    ctx.lineWidth = 1.5;
    for (const r of o.rects) {
      ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
    }
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = o.color ?? '#343a40';
    for (const r of o.rects) {
      ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D, text: string,
  x: number, y: number, maxW: number, maxH: number, lh: number,
): void {
  let cy = y;
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > maxW) {
        ctx.fillText(line, x, cy);
        cy += lh;
        if (cy > y + maxH) return;
        line = ch;
      } else {
        line += ch;
      }
    }
    ctx.fillText(line, x, cy);
    cy += lh;
    if (cy > y + maxH) return;
  }
}

/** 闪烁定位框 */
export function drawFlashRect(ctx: CanvasRenderingContext2D, r: Rect, scale: number, t: number): void {
  ctx.save();
  ctx.strokeStyle = '#e8590c';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -t / 30;
  ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  ctx.restore();
}
