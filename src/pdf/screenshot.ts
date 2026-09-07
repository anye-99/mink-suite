import type { Rect } from '../types';
import type { MinkSuite } from '../main';
import type { PageOverlay } from './overlay';
import type { PdfViewLike } from './private-api';
import { canvasToBlob } from '../core/snapshot';
import { SnapshotActionsModal } from '../core/modals';
import { drawObject } from '../ink/render';
import { pdfWikiLink } from '../core/link';

/**
 * PDF 区域截图：合成 pdf.js 页面渲染 + 批注层 + 便利贴 → SnapshotActionsModal
 * （保存 / 复制 / 回链 / OCR / AI 问图 / 收藏卡片）
 */
export async function composeScreenshot(
  plugin: MinkSuite,
  po: PageOverlay,
  region: Rect,
  view: PdfViewLike,
): Promise<void> {
  const pageCanvas = po.pageEl.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const out = document.createElement('canvas');
  const w = Math.max(2, Math.round(region.w * po.scale));
  const h = Math.max(2, Math.round(region.h * po.scale));
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);

  // 底层：pdf.js 页面渲染
  if (pageCanvas instanceof HTMLCanvasElement) {
    const pdfDpr = pageCanvas.width / po.pageEl.clientWidth;
    ctx.drawImage(
      pageCanvas,
      region.x * po.scale * pdfDpr, region.y * po.scale * pdfDpr,
      region.w * po.scale * pdfDpr, region.h * po.scale * pdfDpr,
      0, 0, w, h,
    );
  }
  // 中层：对象批注（笔迹/形状/文本/贴纸/高亮/下划线）
  ctx.drawImage(
    po.annoCanvas,
    region.x * po.scale * dpr, region.y * po.scale * dpr,
    region.w * po.scale * dpr, region.h * po.scale * dpr,
    0, 0, w, h,
  );
  // 顶层：便利贴（DOM 渲染 → drawObject 静态绘制）
  for (const o of plugin.annoStore.objectsFor(view.file?.path ?? '')) {
    if (o.page !== po.pageNumber || o.kind !== 'sticky') continue;
    const r = o.rects?.[0];
    if (!r || !intersects(r, region)) continue;
    ctx.save();
    ctx.translate(-region.x * po.scale, -region.y * po.scale);
    drawObject(ctx, o, po.scale);
    ctx.restore();
  }

  const blob = await canvasToBlob(out);
  const file = view.file?.path ?? '';
  new SnapshotActionsModal(plugin, blob, {
    file,
    page: po.pageNumber,
    link: pdfWikiLink(file, po.pageNumber),
    label: `${view.file?.basename ?? 'PDF'} 第 ${po.pageNumber} 页截图`,
  }).open();
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}
