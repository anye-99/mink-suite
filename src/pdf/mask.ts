import type { AnnoObject } from '../types';
import type { MinkSuite } from '../main';
import type { PageOverlay } from './overlay';

/**
 * 遮盖复习层：矩形遮盖 + 文本行遮盖。
 * 点击遮盖 → 切换显示/重新遮盖；长按（600ms）→ 删除。
 */
export function renderMaskLayer(plugin: MinkSuite, po: PageOverlay, objects: AnnoObject[]): void {
  po.maskLayer.empty();
  for (const o of objects) {
    if (o.kind !== 'mask' || !o.rects?.length) continue;
    const node = po.maskLayer.createEl('div', {
      cls: `mink-mask${o.revealed ? ' is-revealed' : ''}`,
      attr: { title: '点击显示 / 重新遮盖，长按删除' },
    });
    // 多行文本遮盖用多个矩形拼合
    const box = unionRects(o.rects);
    node.style.left = `${box.x * po.scale}px`;
    node.style.top = `${box.y * po.scale}px`;
    node.style.width = `${box.w * po.scale}px`;
    node.style.height = `${box.h * po.scale}px`;
    if (o.rects.length > 1) {
      node.setCssStyles({ clipPath: buildClipPath(o.rects, po.scale) });
    }

    let pressTimer: number | null = null;
    let longPressed = false;
    node.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      longPressed = false;
      pressTimer = window.setTimeout(() => {
        longPressed = true;
        pressTimer = null;
        void plugin.annoStore.remove(o.file, o.id);
      }, 600);
    });
    const cancelPress = () => {
      if (pressTimer !== null) {
        window.clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    node.addEventListener('pointerup', () => {
      cancelPress();
      if (longPressed) return;
      o.revealed = !o.revealed;
      o.modified = Date.now();
      void plugin.annoStore.update(o.file, o);
    });
    node.addEventListener('pointerleave', cancelPress);
    node.addEventListener('pointercancel', cancelPress);
  }
}

function unionRects(rects: { x: number; y: number; w: number; h: number }[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 多行遮盖：clip-path polygon 拼出实际行矩形 */
function buildClipPath(rects: { x: number; y: number; w: number; h: number }[], scale: number): string {
  const parts = rects.map(r =>
    `${r.x * scale}px ${r.y * scale}px, ${(r.x + r.w) * scale}px ${r.y * scale}px, ${(r.x + r.w) * scale}px ${(r.y + r.h) * scale}px, ${r.x * scale}px ${(r.y + r.h) * scale}px`,
  );
  return `polygon(${parts.join(', ')})`;
}
