import { Notice } from 'obsidian';
import type { AnnoObject, Rect } from '../types';
import type { MinkSuite } from '../main';
import type { PdfOverlayController } from './overlay';
import type { PdfViewLike } from './private-api';
import { pageNumberOf } from './private-api';
import { rectsFromClientRects } from './annotate';
import { copyText } from '../core/link';
import { NoteModal } from './note-modal';
import { AskModal } from '../ai/ask';

const HIGHLIGHT_PALETTE = ['#ffe066', '#8ce99a', '#a5d8ff', '#ffc9c9', '#eebefa'];

/**
 * PDF 文本选区 → 批注操作菜单（高亮/下划线/笔记/问答/遮盖/复制/回链）。
 * Obsidian 内置 PDF 查看器无文本选区事件，用 pointerup + Selection API 轮询实现。
 */
export function attachSelectionMenu(
  plugin: MinkSuite,
  view: PdfViewLike,
  container: HTMLElement,
  controller: PdfOverlayController,
): void {
  let menuEl: HTMLElement | null = null;
  let lastQuote = '';

  const hide = () => {
    menuEl?.remove();
    menuEl = null;
  };

  const showMenu = () => {
    hide();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const anchorNode = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as HTMLElement);
    const pageEl = anchorNode?.closest('.page') as HTMLElement | null;
    const inTextLayer = !!anchorNode?.closest('.textLayer');
    if (!pageEl || !inTextLayer) return;

    const quote = sel.toString().trim();
    if (!quote) return;
    lastQuote = quote;

    const pageNumber = pageNumberOf(pageEl);
    const rects = rectsFromClientRects(pageEl, range.getClientRects());
    if (!rects.length) return;
    const endRect = range.getClientRects().item(range.getClientRects().length - 1)!;

    menuEl = view.contentEl.createEl('div', { cls: 'mink-text-menu' });
    // 定位：选区末行右下方
    const contentRect = view.contentEl.getBoundingClientRect();
    menuEl.style.left = `${endRect.right - contentRect.left}px`;
    menuEl.style.top = `${endRect.bottom - contentRect.top + 6}px`;

    const mk = (label: string, fn: () => void | Promise<void>, cls = '') => {
      const b = menuEl!.createEl('div', { cls: `mink-text-menu-btn${cls ? ' ' + cls : ''}`, text: label });
      b.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); });
      b.addEventListener('click', e => {
        e.stopPropagation();
        hide();
        void Promise.resolve(fn());
      });
      return b;
    };

    // 高亮（带色板）
    const hi = menuEl.createEl('div', { cls: 'mink-text-menu-hi' });
    for (const c of HIGHLIGHT_PALETTE) {
      const dot = hi.createEl('div', { cls: 'mink-color-dot', attr: { title: `高亮 ${c}` } });
      dot.style.background = c;
      dot.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); });
      dot.addEventListener('click', async e => {
        e.stopPropagation();
        hide();
        const o = controller.makeTextAnno(pageNumber, rects, quote, 'highlight', c);
        await plugin.annoStore.add(o.file, o);
      });
    }

    mk('下划线', async () => {
      const o = controller.makeTextAnno(pageNumber, rects, quote, 'underline', plugin.settings.shapeColor);
      await plugin.annoStore.add(o.file, o);
    });
    mk('笔记', async () => {
      const o = controller.makeTextAnno(pageNumber, rects, quote, 'note', '#f08c00');
      o.text = '';
      await plugin.annoStore.add(o.file, o);
      new NoteModal(plugin, o, true).open();
    });
    mk('问答', () => {
      new AskModal(plugin, { title: 'AI 问答', quote: lastQuote }).open();
    });
    mk('遮盖', async () => {
      const o = controller.makeTextAnno(pageNumber, rects, quote, 'mask', '#343a40');
      o.revealed = false;
      await plugin.annoStore.add(o.file, o);
      new Notice('已创建遮盖：点击遮盖可显示/重新遮盖，长按删除');
    });
    mk('复制', async () => {
      await copyText(quote, '已复制选中文本');
    });
    mk('回链', async () => {
      await copyText(controller.wikiLink(pageNumber), '已复制回链');
    });
  };

  // 选区结束（松开鼠标/抬起）后出现菜单
  container.addEventListener('pointerup', () => {
    window.setTimeout(() => showMenu(), 60);
  });
  container.addEventListener('keyup', () => {
    window.setTimeout(() => showMenu(), 60);
  });
  // 任意新按下 / 滚动 / 清空选区 → 隐藏菜单
  container.addEventListener('pointerdown', e => {
    if (menuEl && !(e.target as HTMLElement).closest('.mink-text-menu')) hide();
  }, true);
  view.contentEl.addEventListener('scroll', hide, true);
  view.register(() => hide());

  // 点击已有笔记角标 / 文本批注 → 打开编辑（角标画在 annoCanvas 上，用坐标命中）
  container.addEventListener('click', e => {
    const pageEl = (e.target as HTMLElement).closest('.page') as HTMLElement | null;
    if (!pageEl) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // 正在选文本
    const pageNumber = pageNumberOf(pageEl);
    const rect = pageEl.getBoundingClientRect();
    const f = rect.width > 0 ? 1000 / rect.width : 1;
    const x = (e.clientX - rect.left) * f;
    const y = (e.clientY - rect.top) * f;
    const objs = plugin.annoStore.objectsFor(controller.file).filter(o => o.page === pageNumber);
    // 笔记角标命中（右上方 20px 半径）
    for (const o of objs) {
      if (o.kind !== 'note') continue;
      const r = o.anchor?.rects?.[0] ?? o.rects?.[0];
      if (!r) continue;
      const cx = r.x + r.w + 14, cy = r.y;
      if ((x - cx) ** 2 + (y - cy) ** 2 < 22 ** 2) {
        new NoteModal(plugin, o, false).open();
        return;
      }
    }
    // 命中已有高亮/下划线 → 删除（点击切换，简单交互）
    for (const o of objs) {
      if (o.kind !== 'highlight' && o.kind !== 'underline') continue;
      const hit = (o.anchor?.rects ?? o.rects ?? []).some(r =>
        x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4);
      if (hit) {
        void plugin.annoStore.remove(o.file, o.id);
        return;
      }
    }
  });
}

export function hideSelectionMenu(view: PdfViewLike): void {
  view.contentEl.querySelectorAll('.mink-text-menu').forEach(el => el.remove());
}
