import { STICKY_COLORS } from '../constants';
import type { AnnoObject, Pt } from '../types';
import type { MinkSuite } from '../main';
import type { PageOverlay } from './overlay';
import { pdfBase } from './annotate';

/** PDF 页面创建书写便利贴 */
export async function createSticky(plugin: MinkSuite, po: PageOverlay, pt: Pt, file: string): Promise<void> {
  const color = STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)];
  const o = pdfBase(file, po.pageNumber, 'sticky', 'sticky');
  o.rects = [{ x: pt.x, y: pt.y, w: 220, h: 170 }];
  o.bg = color;
  o.text = '';
  o.size = 16;
  await plugin.annoStore.add(file, o);
}

/** 渲染某页全部便利贴（DOM 交互：拖动/编辑/删除） */
export function renderStickyLayer(plugin: MinkSuite, po: PageOverlay, objects: AnnoObject[]): void {
  po.stickyLayer.empty();
  for (const o of objects) {
    if (o.kind !== 'sticky') continue;
    const rect = o.rects?.[0];
    if (!rect) continue;
    const node = po.stickyLayer.createEl('div', { cls: 'mink-sticky' });
    node.style.left = `${rect.x * po.scale}px`;
    node.style.top = `${rect.y * po.scale}px`;
    node.style.width = `${rect.w * po.scale}px`;
    node.style.height = `${rect.h * po.scale}px`;
    node.style.background = o.bg ?? '#ffe066';

    const head = node.createEl('div', { cls: 'mink-sticky-head' });
    const del = head.createEl('div', { cls: 'mink-sticky-del', text: '✕', attr: { title: '删除便利贴' } });
    del.addEventListener('pointerdown', e => e.stopPropagation());
    del.addEventListener('click', async e => {
      e.stopPropagation();
      await plugin.annoStore.remove(o.file, o.id);
    });

    head.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const orig = { x: rect.x, y: rect.y };
      const onMove = (ev: PointerEvent) => {
        rect.x = orig.x + (ev.clientX - startX) / po.scale;
        rect.y = orig.y + (ev.clientY - startY) / po.scale;
        node.style.left = `${rect.x * po.scale}px`;
        node.style.top = `${rect.y * po.scale}px`;
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        o.modified = Date.now();
        void plugin.annoStore.update(o.file, o);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    const ta = node.createEl('textarea', { cls: 'mink-sticky-text' });
    ta.value = o.text ?? '';
    ta.style.fontSize = `${(o.size ?? 16) * po.scale}px`;
    ta.addEventListener('input', () => {
      o.text = ta.value;
      o.modified = Date.now();
      void plugin.annoStore.update(o.file, o);
    });
    ta.addEventListener('pointerdown', e => e.stopPropagation());
    ta.addEventListener('keydown', e => e.stopPropagation());
  }
}
