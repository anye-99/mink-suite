import { Notice } from 'obsidian';
import type { AnnoObject, Pt, Rect } from '../types';
import type { MinkSuite } from '../main';
import { Toolbar } from '../ink/tools';
import { drawObject } from '../ink/render';
import { makeStroke, tracePath } from '../ink/engine';
import { marqueeSelect, objectsBBox, scaleObjects, translateObjects, cloneObjects } from '../ink/selection';
import type { PdfViewLike } from './private-api';
import { getPdfViewerContainer, getPdfPages, pageNumberOf } from './private-api';
import { normRectFromPoints, pdfBase, pointFromEvent, rectsFromClientRects } from './annotate';
import { attachSelectionMenu, hideSelectionMenu } from './textlayer';
import { renderMaskLayer } from './mask';
import { renderStickyLayer, createSticky } from './sticky';
import { composeScreenshot } from './screenshot';
import { uid } from '../core/ids';
import { pdfWikiLink } from '../core/link';

export interface PageOverlay {
  pageEl: HTMLElement;
  pageNumber: number;
  annoCanvas: HTMLCanvasElement;
  liveCanvas: HTMLCanvasElement;
  stickyLayer: HTMLElement;
  maskLayer: HTMLElement;
  selectLayer: HTMLElement;
  scale: number; // css px / norm unit
}

type DragState =
  | { mode: 'ink'; po: PageOverlay; points: Pt[] }
  | { mode: 'shape'; po: PageOverlay; start: Pt; cur: Pt; kind: AnnoObject['kind'] }
  | { mode: 'marquee'; po: PageOverlay; start: Pt; cur: Pt; el: HTMLElement }
  | { mode: 'move'; po: PageOverlay; start: Pt; base: AnnoObject[]; ids: string[] }
  | { mode: 'scale'; po: PageOverlay; baseBBox: Rect; startBox: Rect; base: AnnoObject[]; ids: string[] }
  | { mode: 'screenshot'; po: PageOverlay; start: Pt; cur: Pt };

/** 内置 PDF 查看器扩展控制器（私有 API 路线，风险集中） */
export class PdfOverlayController {
  private container: HTMLElement | null = null;
  private toolbar: Toolbar | null = null;
  private overlays = new Map<HTMLElement, PageOverlay>();
  private mo: MutationObserver | null = null;
  private ro: ResizeObserver | null = null;
  private drag: DragState | null = null;
  private selected: AnnoObject[] = [];
  private pendingReveal: string | null = null;
  private unsubs: Array<() => void> = [];
  private degradeBanner: HTMLElement | null = null;
  private flashRAF: number | null = null;
  readonly file: string;

  constructor(private plugin: MinkSuite, private view: PdfViewLike) {
    this.file = view.file?.path ?? '';
  }

  async activate(): Promise<void> {
    // 容器可能随 pdf.js 异步挂载，重试探测
    for (let i = 0; i < 20; i++) {
      this.container = getPdfViewerContainer(this.view);
      if (this.container) break;
      await sleep(300);
      // 视图已关闭：中止重试
      const stillOpen = this.plugin.app.workspace
        .getLeavesOfType('pdf')
        .some(l => l.view === this.view);
      if (!stillOpen) return;
    }
    if (!this.container) {
      this.showDegradeBanner();
      return;
    }
    await this.plugin.annoStore.load(this.file);

    this.toolbar = new Toolbar(this.view.contentEl, this.plugin.tools, () => this.plugin.settings, { mask: true, screenshot: true });
    this.toolbar.el.addClass('mink-pdf-toolbar');

    this.mo = new MutationObserver(() => { this.syncPages(); });
    this.mo.observe(this.container, { childList: true, subtree: true });

    this.ro = new ResizeObserver(() => { this.syncPages(); });
    this.ro.observe(this.container);

    attachSelectionMenu(this.plugin, this.view, this.container, this);

    this.unsubs.push(this.plugin.bus.on('anno-changed', ({ file, anno }) => {
      if (file !== this.file) return;
      if (anno.kind === 'sticky') this.renderSticky(anno.page);
      if (anno.kind === 'mask') this.renderMask(anno.page);
      if (anno.kind !== 'sticky' && anno.kind !== 'mask') this.drawPage(anno.page);
    }));
    this.unsubs.push(this.plugin.bus.on('reveal-anno', ({ file, annoId }) => {
      if (file !== this.file) return;
      this.reveal(annoId);
    }));
    // 激活前错过的定位请求（回链打开时控制器尚未就绪）
    const pending = this.plugin.consumeRevealRequest(this.file);
    if (pending) this.pendingReveal = pending;
    this.unsubs.push(this.plugin.tools.onChange(() => {
      this.selected = [];
      this.renderSelectionBox();
      for (const po of this.overlays.values()) {
        po.liveCanvas.style.pointerEvents = this.plugin.tools.state.tool === 'select' ? 'none' : 'auto';
        po.liveCanvas.style.touchAction = this.plugin.tools.state.tool === 'select' ? 'auto' : 'none';
      }
    }));

    this.syncPages();
  }

  destroy(): void {
    if (this.flashRAF) cancelAnimationFrame(this.flashRAF);
    for (const u of this.unsubs) u();
    this.mo?.disconnect();
    this.ro?.disconnect();
    this.toolbar?.destroy();
    for (const po of Array.from(this.overlays.values())) this.removePageOverlay(po);
    this.overlays.clear();
    this.degradeBanner?.remove();
    hideSelectionMenu(this.view);
  }

  private showDegradeBanner(): void {
    this.degradeBanner = this.view.contentEl.createEl('div', {
      cls: 'mink-degrade-banner',
      text: 'Mink 批注：当前 Obsidian 版本的内置 PDF 查看器结构暂不兼容，PDF 标注暂不可用（手写笔记 / 批注中心 / 卡片不受影响）。',
    });
    this.view.contentEl.insertBefore(this.degradeBanner, this.view.contentEl.firstChild);
  }

  // ---------- 页面 overlay 同步 ----------

  syncPages(): void {
    if (!this.container) return;
    const pages = getPdfPages(this.container);
    const seen = new Set<HTMLElement>();
    for (const pageEl of pages) {
      seen.add(pageEl);
      if (!this.overlays.has(pageEl)) this.addPageOverlay(pageEl);
    }
    for (const [el, po] of Array.from(this.overlays.entries())) {
      if (!seen.has(el)) {
        this.removePageOverlay(po);
        this.overlays.delete(el);
      } else {
        this.relayoutPage(po);
      }
    }
    if (this.pendingReveal) {
      const id = this.pendingReveal;
      this.pendingReveal = null;
      this.reveal(id);
    }
  }

  private addPageOverlay(pageEl: HTMLElement): void {
    const anchor = pageEl.querySelector('canvas');
    const root = pageEl.createEl('div', { cls: 'mink-pdf-overlay-root' });
    const position = () => {
      const c = anchor instanceof HTMLCanvasElement ? anchor : null;
      if (c) {
        root.style.left = `${c.offsetLeft}px`;
        root.style.top = `${c.offsetTop}px`;
      }
    };
    position();

    const annoCanvas = root.createEl('canvas', { cls: 'mink-pdf-anno' });
    const liveCanvas = root.createEl('canvas', { cls: 'mink-pdf-live' });
    const stickyLayer = root.createEl('div', { cls: 'mink-pdf-sticky-layer' });
    const maskLayer = root.createEl('div', { cls: 'mink-pdf-mask-layer' });
    const selectLayer = root.createEl('div', { cls: 'mink-pdf-select-layer' });

    const po: PageOverlay = {
      pageEl, pageNumber: pageNumberOf(pageEl),
      annoCanvas, liveCanvas, stickyLayer, maskLayer, selectLayer, scale: 1,
    };
    this.overlays.set(pageEl, po);

    liveCanvas.addEventListener('pointerdown', e => this.onPointerDown(e, po));
    liveCanvas.addEventListener('pointermove', e => this.onPointerMove(e, po));
    liveCanvas.addEventListener('pointerup', e => this.onPointerUp(e, po));
    liveCanvas.addEventListener('pointercancel', e => this.onPointerUp(e, po));
    // 空白处（非文本层）框选笔迹
    pageEl.addEventListener('pointerdown', e => {
      const tool = this.plugin.tools.state.tool;
      if (tool !== 'select') return;
      if ((e.target as HTMLElement).closest('.textLayer')) return;
      const pt = pointFromEvent(pageEl, e, 0.5);
      this.startMarquee(e, po, pt);
    }, true);

    this.relayoutPage(po);
  }

  private removePageOverlay(po: PageOverlay): void {
    po.annoCanvas.parentElement?.remove();
  }

  private relayoutPage(po: PageOverlay): void {
    const dpr = window.devicePixelRatio || 1;
    const w = po.pageEl.clientWidth;
    const h = po.pageEl.clientHeight;
    if (w <= 0 || h <= 0) return;
    po.scale = w / 1000;
    for (const c of [po.annoCanvas, po.liveCanvas]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.drawPage(po.pageNumber);
    this.renderMask(po.pageNumber);
    this.renderSticky(po.pageNumber);
  }

  // ---------- 渲染 ----------

  objectsOf(page: number | string): AnnoObject[] {
    return this.plugin.annoStore.objectsFor(this.file).filter(o => o.page === page);
  }

  drawPage(page: number | string): void {
    const po = this.findOverlay(page);
    if (!po) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = po.annoCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, po.annoCanvas.width, po.annoCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const o of this.objectsOf(page)) {
      if (o.kind === 'sticky' || o.kind === 'mask') continue;
      drawObject(ctx, o, po.scale);
    }
    // 笔记角标
    for (const o of this.objectsOf(page)) {
      if (o.kind !== 'note') continue;
      const r = o.anchor?.rects?.[0] ?? o.rects?.[0];
      if (!r) continue;
      const cx = (r.x + r.w + 14) * po.scale;
      const cy = r.y * po.scale;
      ctx.fillStyle = '#f08c00';
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', cx, cy);
    }
  }

  renderMask(page: number | string): void {
    const po = this.findOverlay(page);
    if (po) renderMaskLayer(this.plugin, po, this.objectsOf(page));
  }

  renderSticky(page: number | string): void {
    const po = this.findOverlay(page);
    if (po) renderStickyLayer(this.plugin, po, this.objectsOf(page));
  }

  findOverlay(page: number | string): PageOverlay | null {
    if (typeof page === 'number') {
      for (const po of this.overlays.values()) if (po.pageNumber === page) return po;
      return null;
    }
    return null;
  }

  private clearLive(po: PageOverlay): void {
    const dpr = window.devicePixelRatio || 1;
    const ctx = po.liveCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, po.liveCanvas.width, po.liveCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- 指针交互 ----------

  private onPointerDown(e: PointerEvent, po: PageOverlay): void {
    const tool = this.plugin.tools.state.tool;
    if (tool === 'select') return; // marquee 由 pageEl capture 处理
    if (!this.plugin.inputFilter.isDrawingPointer(e)) return;
    e.preventDefault();
    hideSelectionMenu(this.view);
    po.liveCanvas.setPointerCapture(e.pointerId);
    const pt = pointFromEvent(po.pageEl, e, this.plugin.inputFilter.pressureOf(e));

    switch (tool) {
      case 'pen': case 'highlighter':
        this.drag = { mode: 'ink', po, points: [pt] };
        break;
      case 'eraser':
        this.drag = { mode: 'ink', po, points: [] };
        this.eraseAt(po, pt);
        break;
      case 'rect': case 'ellipse': case 'line': case 'arrow': case 'arrow2':
        this.drag = { mode: 'shape', po, start: pt, cur: pt, kind: tool as AnnoObject['kind'] };
        break;
      case 'text':
        this.openTextEditor(po, pt);
        break;
      case 'sticker':
        void this.addSticker(po, pt);
        break;
      case 'sticky':
        void createSticky(this.plugin, po, pt, this.file);
        break;
      case 'mask':
        this.drag = { mode: 'shape', po, start: pt, cur: pt, kind: 'mask' };
        break;
      case 'screenshot':
        this.drag = { mode: 'screenshot', po, start: pt, cur: pt };
        break;
      default:
        break;
    }
  }

  private onPointerMove(e: PointerEvent, po: PageOverlay): void {
    if (!this.drag) return;
    const pt = pointFromEvent(po.pageEl, e, this.plugin.inputFilter.pressureOf(e));
    const d = this.drag;
    if (d.mode === 'ink' && d.po === po) {
      if (this.plugin.tools.state.tool === 'eraser') { this.eraseAt(po, pt); return; }
      d.points.push(pt);
      this.previewInk(po, d.points);
    } else if (d.mode === 'shape' && d.po === po) {
      d.cur = pt;
      this.previewShape(po, d.start, d.cur, d.kind === 'mask' ? '#343a40' : undefined);
    } else if (d.mode === 'screenshot' && d.po === po) {
      d.cur = pt;
      this.previewShape(po, d.start, d.cur, '#e8590c');
    } else if (d.mode === 'marquee' && d.po === po) {
      d.cur = pt;
      this.updateMarquee(po, d.start, d.cur);
    } else if (d.mode === 'move' && d.po === po) {
      const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
      const moved = translateObjects(d.base, dx, dy);
      this.applyLivePreview(po, moved);
    } else if (d.mode === 'scale' && d.po === po) {
      const boxW = Math.max(1, pt.x - d.startBox.x), boxH = Math.max(1, pt.y - d.startBox.y);
      this.applyLivePreview(po, scaleObjects(d.base, d.baseBBox, { x: d.startBox.x, y: d.startBox.y, w: boxW, h: boxH }));
    }
  }

  private onPointerUp(e: PointerEvent, po: PageOverlay): void {
    if (!this.drag) { this.finishMarquee(po); return; }
    const d = this.drag;
    this.drag = null;
    const pt = pointFromEvent(po.pageEl, e, this.plugin.inputFilter.pressureOf(e));

    if (d.mode === 'ink' && d.po === po) {
      if (d.points.length > 1 && this.plugin.tools.state.tool !== 'eraser') {
        this.commitInk(po, d.points);
      } else {
        this.clearLive(po);
      }
    } else if (d.mode === 'shape' && d.po === po) {
      this.clearLive(po);
      const rect = normRectFromPoints(po.pageEl, d.start, d.cur);
      if (rect.w > 4 || rect.h > 4) this.commitShape(po, rect, d.kind);
    } else if (d.mode === 'screenshot' && d.po === po) {
      this.clearLive(po);
      const rect = normRectFromPoints(po.pageEl, d.start, d.cur);
      if (rect.w > 10 && rect.h > 10) void composeScreenshot(this.plugin, po, rect, this.view);
    } else if (d.mode === 'marquee' && d.po === po) {
      this.finishMarquee(po, normRectFromPoints(po.pageEl, d.start, d.cur));
    } else if (d.mode === 'move' && d.po === po) {
      const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        const moved = translateObjects(d.base, dx, dy);
        void this.replaceObjects(moved);
      } else {
        this.selected = d.base;
        this.renderSelectionBox();
      }
    } else if (d.mode === 'scale' && d.po === po) {
      const boxW = Math.max(1, pt.x - d.startBox.x), boxH = Math.max(1, pt.y - d.startBox.y);
      void this.replaceObjects(scaleObjects(d.base, d.baseBBox, { x: d.startBox.x, y: d.startBox.y, w: boxW, h: boxH }));
    }
  }

  // ---------- 预览 ----------

  private previewInk(po: PageOverlay, points: Pt[]): void {
    this.clearLive(po);
    const dpr = window.devicePixelRatio || 1;
    const ctx = po.liveCanvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const st = this.plugin.tools.state;
    const isHi = st.tool === 'highlighter';
    const outline = makeStroke(points, { color: st.color, size: st.size * po.scale, highlighter: isHi });
    ctx.globalAlpha = isHi ? 0.45 : 1;
    ctx.fillStyle = st.color;
    tracePath(ctx, outline);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private previewShape(po: PageOverlay, start: Pt, cur: Pt, color?: string): void {
    this.clearLive(po);
    const dpr = window.devicePixelRatio || 1;
    const ctx = po.liveCanvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const st = this.plugin.tools.state;
    const rect = normRectFromPoints(po.pageEl, start, cur);
    ctx.strokeStyle = color ?? st.color;
    ctx.lineWidth = Math.max(1, st.size * po.scale);
    ctx.setLineDash(color ? [6, 4] : []);
    ctx.strokeRect(rect.x * po.scale, rect.y * po.scale, rect.w * po.scale, rect.h * po.scale);
    ctx.setLineDash([]);
  }

  private applyLivePreview(po: PageOverlay, objs: AnnoObject[]): void {
    this.drawPage(po.pageNumber);
    const dpr = window.devicePixelRatio || 1;
    const ctx = po.liveCanvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const o of objs) drawObject(ctx, o, po.scale);
    this.selected = objs;
  }

  // ---------- 提交 ----------

  private commitInk(po: PageOverlay, points: Pt[]): void {
    const st = this.plugin.tools.state;
    const o = pdfBase(this.file, po.pageNumber, 'ink', st.tool);
    o.points = points;
    o.color = st.color;
    o.size = st.size;
    o.opacity = st.tool === 'highlighter' ? 0.45 : 1;
    void this.plugin.annoStore.add(this.file, o);
    this.clearLive(po);
  }

  private commitShape(po: PageOverlay, rect: Rect, kind: AnnoObject['kind']): void {
    const st = this.plugin.tools.state;
    const o = pdfBase(this.file, po.pageNumber, kind, st.tool);
    o.rects = [rect];
    o.color = kind === 'mask' ? '#343a40' : st.color;
    o.size = st.size;
    if (kind === 'mask') o.revealed = false;
    void this.plugin.annoStore.add(this.file, o);
  }

  private async addSticker(po: PageOverlay, pt: Pt): Promise<void> {
    const st = this.plugin.tools.state;
    const o = pdfBase(this.file, po.pageNumber, 'sticker', 'sticker');
    o.rects = [{ x: pt.x - 50, y: pt.y - 50, w: 100, h: 100 }];
    o.stickerId = st.stickerId;
    await this.plugin.annoStore.add(this.file, o);
  }

  private openTextEditor(po: PageOverlay, pt: Pt): void {
    const st = this.plugin.tools.state;
    const ta = po.pageEl.createEl('textarea', { cls: 'mink-pdf-text-editor' });
    ta.style.left = `${pt.x * po.scale}px`;
    ta.style.top = `${pt.y * po.scale}px`;
    ta.style.fontSize = `${st.size * po.scale}px`;
    setTimeout(() => ta.focus(), 30);
    const commit = () => {
      const text = ta.value.trim();
      ta.remove();
      if (!text) return;
      const lines = text.split('\n');
      const measure = document.createElement('canvas').getContext('2d')!;
      measure.font = `${st.size}px sans-serif`;
      const w = Math.max(...lines.map(l => measure.measureText(l).width)) + 8;
      const h = lines.length * st.size * 1.3 + 4;
      const o = pdfBase(this.file, po.pageNumber, 'text', 'text');
      o.rects = [{ x: pt.x, y: pt.y, w, h }];
      o.text = text;
      o.color = st.color;
      o.size = st.size;
      void this.plugin.annoStore.add(this.file, o);
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); ta.value = ''; commit(); }
    });
  }

  private eraseAt(po: PageOverlay, pt: Pt): void {
    const victims = this.objectsOf(po.pageNumber).filter(o =>
      o.kind === 'ink' && o.points?.some(p =>
        (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2 < (10 + (o.size ?? 4)) ** 2));
    for (const v of victims) void this.plugin.annoStore.remove(this.file, v.id);
  }

  // ---------- 选择/变换 ----------

  private startMarquee(e: PointerEvent, po: PageOverlay, pt: Pt): void {
    if (this.selected.length) {
      const box = objectsBBox(this.selected)!;
      const corner = (Math.abs(pt.x - box.x) < 14 || Math.abs(pt.x - (box.x + box.w)) < 14)
        && (Math.abs(pt.y - box.y) < 14 || Math.abs(pt.y - (box.y + box.h)) < 14);
      if (corner) {
        const base = this.selected.map(o => JSON.parse(JSON.stringify(o)) as AnnoObject);
        e.preventDefault();
        this.drag = { mode: 'scale', po, baseBBox: { ...box }, startBox: box, base, ids: base.map(o => o.id) };
        return;
      }
      if (pt.x > box.x && pt.x < box.x + box.w && pt.y > box.y && pt.y < box.y + box.h) {
        const base = this.selected.map(o => JSON.parse(JSON.stringify(o)) as AnnoObject);
        e.preventDefault();
        this.drag = { mode: 'move', po, start: pt, base, ids: base.map(o => o.id) };
        return;
      }
    }
    const el = po.selectLayer.createEl('div', { cls: 'mink-marquee' });
    e.preventDefault();
    this.drag = { mode: 'marquee', po, start: pt, cur: pt, el };
  }

  private updateMarquee(po: PageOverlay, start: Pt, cur: Pt): void {
    const d = this.drag;
    if (!d || d.mode !== 'marquee') return;
    const rect = normRectFromPoints(po.pageEl, start, cur);
    d.el.style.left = `${rect.x * po.scale}px`;
    d.el.style.top = `${rect.y * po.scale}px`;
    d.el.style.width = `${rect.w * po.scale}px`;
    d.el.style.height = `${rect.h * po.scale}px`;
  }

  private finishMarquee(po: PageOverlay, rect?: Rect): void {
    for (const p of this.overlays.values()) p.selectLayer.querySelectorAll('.mink-marquee').forEach(el => el.remove());
    if (rect) {
      this.selected = marqueeSelect(this.objectsOf(po.pageNumber).filter(o => o.kind !== 'sticky' && o.kind !== 'mask'), rect);
    }
    this.renderSelectionBox();
  }

  private renderSelectionBox(): void {
    for (const po of this.overlays.values()) {
      po.selectLayer.querySelectorAll('.mink-selection, .mink-selection-handle, .mink-selection-bar').forEach(el => el.remove());
    }
    if (!this.selected.length) return;
    const page = this.selected[0].page;
    const po = this.findOverlay(page);
    if (!po) return;
    const box = objectsBBox(this.selected)!;
    const boxEl = po.selectLayer.createEl('div', { cls: 'mink-selection' });
    boxEl.style.left = `${box.x * po.scale}px`;
    boxEl.style.top = `${box.y * po.scale}px`;
    boxEl.style.width = `${box.w * po.scale}px`;
    boxEl.style.height = `${box.h * po.scale}px`;
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const h = po.selectLayer.createEl('div', { cls: 'mink-selection-handle' });
      h.style.left = `${(box.x + box.w * cx) * po.scale - 5}px`;
      h.style.top = `${(box.y + box.h * cy) * po.scale - 5}px`;
    }
    const bar = po.selectLayer.createEl('div', { cls: 'mink-selection-bar' });
    bar.style.left = `${box.x * po.scale}px`;
    bar.style.top = `${Math.max(0, box.y * po.scale - 36)}px`;
    const mk = (label: string, fn: () => void) => {
      const b = bar.createEl('div', { cls: 'mink-selection-btn', text: label });
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    };
    mk('复制', () => this.copySelection());
    mk('粘贴', () => void this.pasteClipboard(po));
    mk('删除', () => {
      for (const o of this.selected) void this.plugin.annoStore.remove(this.file, o.id);
      this.selected = [];
      this.renderSelectionBox();
    });
    mk('回链截图', () => void composeScreenshot(this.plugin, po, box, this.view));
  }

  private async replaceObjects(objs: AnnoObject[]): Promise<void> {
    for (const o of objs) await this.plugin.annoStore.update(this.file, o);
    this.selected = objs;
    this.renderSelectionBox();
  }

  private copySelection(): void {
    if (!this.selected.length) return;
    this.plugin.inkClipboard = this.selected.map(o => JSON.parse(JSON.stringify(o)) as AnnoObject);
    new Notice(`已复制 ${this.plugin.inkClipboard.length} 个对象`);
  }

  private async pasteClipboard(po: PageOverlay): Promise<void> {
    if (!this.plugin.inkClipboard.length) return;
    const copies = cloneObjects(this.plugin.inkClipboard, () => uid(), 20);
    for (const c of copies) {
      c.file = this.file;
      c.page = po.pageNumber;
      await this.plugin.annoStore.add(this.file, c);
    }
  }

  // ---------- 定位 ----------

  reveal(annoId: string): void {
    const anno = this.plugin.annoStore.objectsFor(this.file).find(o => o.id === annoId);
    if (!anno) return;
    const po = this.findOverlay(anno.page);
    if (!po) { this.pendingReveal = annoId; return; }
    this.flash(po, anno);
  }

  private flash(po: PageOverlay, anno: AnnoObject): void {
    const box = objectsBBox([anno]) ?? anno.anchor?.rects?.[0];
    if (!box) return;
    const start = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const tick = () => {
      const t = performance.now() - start;
      if (t > 1600) { this.clearLive(po); this.flashRAF = null; return; }
      this.clearLive(po);
      const ctx = po.liveCanvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = '#e8590c';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -t / 25;
      ctx.strokeRect(box.x * po.scale, box.y * po.scale, box.w * po.scale, box.h * po.scale);
      this.flashRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  /** 当前选中文本 → 创建文本批注（供 textlayer 菜单调用） */
  makeTextAnno(pageNumber: number, rects: Rect[], quote: string, kind: AnnoObject['kind'], color: string): AnnoObject {
    const o = pdfBase(this.file, pageNumber, kind, kind);
    o.rects = rects;
    o.color = color;
    o.size = kind === 'underline' ? 3 : 4;
    o.anchor = { quote, rects };
    return o;
  }

  wikiLink(pageNumber: number, annoId?: string): string {
    return pdfWikiLink(this.file, pageNumber, annoId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => window.setTimeout(r, ms));
}
