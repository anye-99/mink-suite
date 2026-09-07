import { FileView, FuzzySuggestModal, Notice, Scope, TFile, setIcon } from 'obsidian';
import type { AnnoObject, MinkDoc, PaperTemplate, Pt, Rect } from '../types';
import { PAPER_LABELS, STICKY_COLORS, VIEW_TYPE_MINK } from '../constants';
import type { MinkSuite } from '../main';
import { Toolbar } from '../ink/tools';
import { drawPaper } from '../ink/paper';
import { drawObject, objectBBox } from '../ink/render';
import { makeStroke, tracePath } from '../ink/engine';
import { marqueeSelect, objectsBBox, scaleObjects, translateObjects, cloneObjects } from '../ink/selection';
import { newPage, preloadImages, readDoc, writeDoc } from './file';
import { uid } from '../core/ids';
import { canvasToBlob } from '../core/snapshot';
import { SnapshotActionsModal } from '../core/modals';
import { minkWikiLink } from '../core/link';

interface PageRenderer {
  page: MinkDoc['pages'][number];
  idx: number;
  el: HTMLElement;
  staticCanvas: HTMLCanvasElement;
  liveCanvas: HTMLCanvasElement;
  stickyLayer: HTMLElement;
  selectLayer: HTMLElement;
  /** css 像素 / 归一化单位 */
  scale: number;
}

type DragState =
  | { mode: 'ink'; idx: number; points: Pt[] }
  | { mode: 'shape'; idx: number; start: Pt; cur: Pt }
  | { mode: 'marquee'; idx: number; start: Pt; cur: Pt; el: HTMLElement }
  | { mode: 'move'; idx: number; start: Pt; base: AnnoObject[]; ids: string[] }
  | { mode: 'scale'; idx: number; baseBBox: Rect; startBox: Rect; base: AnnoObject[]; ids: string[] }
  | { mode: 'screenshot'; idx: number; start: Pt; cur: Pt };

/** .mink 独立手写笔记视图 */
export class MinkView extends FileView {
  plugin: MinkSuite;
  private doc: MinkDoc | null = null;
  private renderers: PageRenderer[] = [];
  private toolbar: Toolbar | null = null;
  private zoom = 1;
  private images = new Map<string, HTMLImageElement>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private selected: AnnoObject[] = [];
  private clipboard: AnnoObject[] = [];
  private drag: DragState | null = null;
  private saveTimer: number | null = null;
  private unsubs: Array<() => void> = [];
  private flashRAF: number | null = null;
  private headerEl!: HTMLElement;
  private pagesEl!: HTMLElement;

  constructor(leaf: import('obsidian').WorkspaceLeaf, plugin: MinkSuite) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
  }

  getViewType(): string { return VIEW_TYPE_MINK; }
  getDisplayText(): string { return this.file?.basename ?? '手写笔记'; }
  getIcon(): string { return 'pencil'; }

  // ---------- 生命周期 ----------

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('mink-view');

    this.headerEl = this.contentEl.createEl('div', { cls: 'mink-header' });
    this.pagesEl = this.contentEl.createEl('div', { cls: 'mink-pages-wrap' }).createEl('div', { cls: 'mink-pages' });

    this.buildHeader();
    this.toolbar = new Toolbar(this.contentEl, this.plugin.tools, () => this.plugin.settings, { screenshot: true });

    this.unsubs.push(this.plugin.tools.onChange(() => this.onToolChange()));
    this.unsubs.push(this.plugin.bus.on('reveal-anno', ({ file, annoId }) => {
      if (file === this.file?.path) this.flashAnno(annoId);
    }));
    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Delete', () => this.deleteKey());
    this.scope.register([], 'Backspace', () => this.deleteKey());
    this.scope.register(['Mod'], 'z', () => this.undo());
    this.scope.register(['Mod', 'Shift'], 'z', () => this.redo());
    this.scope.register(['Mod'], 'y', () => this.redo());
    this.scope.register(['Mod'], 'c', () => this.copySelection());
    this.scope.register(['Mod'], 'v', () => this.pasteClipboard());
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.doc = await readDoc(this.app, file);
    this.images = await preloadImages(this.app, this.doc.objects);
    this.undoStack = [];
    this.redoStack = [];
    this.selected = [];
    this.rebuildPages();
    this.plugin.bus.emit('annos-loaded', { file: file.path });
  }

  async onUnloadFile(file: TFile): Promise<void> {
    await this.flushSave();
    void file;
  }

  async onUnload(): Promise<void> {
    await this.flushSave();
    if (this.flashRAF) cancelAnimationFrame(this.flashRAF);
    for (const u of this.unsubs) u();
    this.toolbar?.destroy();
    this.contentEl.empty();
  }

  // ---------- 头部工具条 ----------

  private buildHeader(): void {
    const mk = (icon: string, title: string, fn: () => void) => {
      const b = this.headerEl.createEl('div', { cls: 'mink-header-btn', attr: { title } });
      setIcon(b, icon);
      b.addEventListener('click', () => fn());
      return b;
    };
    mk('undo-2', '撤销', () => this.undo());
    mk('redo-2', '重做', () => this.redo());
    mk('image-plus', '插入图片', () => this.pickImage());
    mk('clipboard-paste', '粘贴笔迹', () => this.pasteClipboard());
    mk('file-plus-2', '添加页面', () => this.addPage());
    const zoomOut = mk('zoom-out', '缩小', () => { this.zoom = Math.max(0.4, this.zoom - 0.1); this.relayout(); });
    const zoomIn = mk('zoom-in', '放大', () => { this.zoom = Math.min(3, this.zoom + 0.1); this.relayout(); });
    void zoomOut; void zoomIn;
    mk('save', '保存', () => void this.flushSave(true));
  }

  // ---------- 页面构建与渲染 ----------

  private rebuildPages(): void {
    if (!this.doc) return;
    this.renderers = [];
    this.pagesEl.empty();
    this.doc.pages.forEach((page, idx) => {
      this.renderers.push(this.buildPage(page, idx));
    });
    this.relayout();
  }

  private buildPage(page: MinkDoc['pages'][number], idx: number): PageRenderer {
    const el = this.pagesEl.createEl('div', { cls: 'mink-page', attr: { 'data-page-idx': String(idx) } });
    const tools = el.createEl('div', { cls: 'mink-page-tools' });
    const sel = tools.createEl('select', { cls: 'mink-paper-select' });
    for (const [k, v] of Object.entries(PAPER_LABELS)) {
      const opt = sel.createEl('option', { text: v, attr: { value: k } });
      if (k === page.template) (opt as HTMLOptionElement).selected = true;
    }
    sel.addEventListener('change', () => {
      page.template = sel.value as PaperTemplate;
      this.renderStatic(idx);
      this.scheduleSave();
    });
    const del = tools.createEl('div', { cls: 'mink-page-del', attr: { title: '删除本页' }, text: '✕' });
    del.addEventListener('click', () => this.removePage(idx));

    const staticCanvas = el.createEl('canvas', { cls: 'mink-static' });
    const liveCanvas = el.createEl('canvas', { cls: 'mink-live' });
    const stickyLayer = el.createEl('div', { cls: 'mink-sticky-layer' });
    const selectLayer = el.createEl('div', { cls: 'mink-select-layer' });

    const r: PageRenderer = {
      page, idx, el, staticCanvas, liveCanvas, stickyLayer, selectLayer, scale: 1,
    };

    liveCanvas.addEventListener('pointerdown', e => this.onPointerDown(e, r));
    liveCanvas.addEventListener('pointermove', e => this.onPointerMove(e, r));
    liveCanvas.addEventListener('pointerup', e => this.onPointerUp(e, r));
    liveCanvas.addEventListener('pointercancel', e => this.onPointerUp(e, r));
    return r;
  }

  /** 布局：计算每页 css 尺寸并重绘 */
  private relayout(): void {
    if (!this.doc) return;
    const avail = this.pagesEl.parentElement?.clientWidth ?? 800;
    const baseW = Math.min(avail - 48, 820);
    for (const r of this.renderers) {
      const cssW = Math.max(240, baseW * this.zoom);
      const cssH = (r.page.height / r.page.width) * cssW;
      r.scale = cssW / r.page.width;
      r.el.style.width = `${cssW}px`;
      r.el.style.height = `${cssH}px`;
      const dpr = window.devicePixelRatio || 1;
      for (const c of [r.staticCanvas, r.liveCanvas]) {
        c.width = Math.round(cssW * dpr);
        c.height = Math.round(cssH * dpr);
        c.style.width = `${cssW}px`;
        c.style.height = `${cssH}px`;
      }
      r.liveCanvas.style.touchAction = this.plugin.tools.state.tool === 'select' ? 'pan-y' : 'none';
      this.renderStatic(r.idx);
      this.renderStickies(r.idx);
      this.renderSelectionBox();
    }
  }

  private renderStatic(idx: number): void {
    const r = this.renderers[idx];
    if (!r || !this.doc) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = r.staticCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, r.staticCanvas.width, r.staticCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPaper(ctx, r.staticCanvas.width / dpr, r.staticCanvas.height / dpr, r.page.template);
    for (const o of this.doc.objects) {
      if (o.page !== r.page.id || o.kind === 'sticky') continue;
      drawObject(ctx, o, r.scale, { images: this.images });
    }
  }

  private clearLive(idx: number): void {
    const r = this.renderers[idx];
    if (!r) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = r.liveCanvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, r.liveCanvas.width, r.liveCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- 指针交互 ----------

  private norm(e: PointerEvent, r: PageRenderer): Pt {
    const rect = r.liveCanvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * r.page.width,
      y: ((e.clientY - rect.top) / rect.height) * r.page.height,
      p: this.plugin.inputFilter.pressureOf(e),
    };
  }

  private onToolChange(): void {
    this.selected = [];
    this.renderSelectionBox();
    for (const r of this.renderers) {
      r.liveCanvas.style.touchAction = this.plugin.tools.state.tool === 'select' ? 'pan-y' : 'none';
    }
  }

  private onPointerDown(e: PointerEvent, r: PageRenderer): void {
    if (!this.doc) return;
    const tool = this.plugin.tools.state.tool;
    const pt = this.norm(e, r);

    if (tool === 'select') {
      this.startMarquee(e, r, pt);
      return;
    }
    if (!this.plugin.inputFilter.isDrawingPointer(e)) return; // touch 滚动
    e.preventDefault();
    r.liveCanvas.setPointerCapture(e.pointerId);

    switch (tool) {
      case 'pen': case 'highlighter':
        this.drag = { mode: 'ink', idx: r.idx, points: [pt] };
        break;
      case 'eraser':
        this.drag = { mode: 'ink', idx: r.idx, points: [] };
        this.eraseAt(r, pt);
        break;
      case 'rect': case 'ellipse': case 'line': case 'arrow': case 'arrow2':
        this.drag = { mode: 'shape', idx: r.idx, start: pt, cur: pt };
        break;
      case 'text':
        this.openTextEditor(r, pt);
        break;
      case 'sticker':
        this.addSticker(r, pt);
        break;
      case 'sticky':
        this.addSticky(r, pt);
        break;
      case 'screenshot':
        this.drag = { mode: 'screenshot', idx: r.idx, start: pt, cur: pt };
        break;
      default:
        break;
    }
  }

  private onPointerMove(e: PointerEvent, r: PageRenderer): void {
    if (!this.doc || !this.drag) return;
    const pt = this.norm(e, r);
    const d = this.drag;
    if (d.mode === 'ink' && d.idx === r.idx) {
      if (d.points.length && this.plugin.tools.state.tool === 'eraser') {
        this.eraseAt(r, pt);
        return;
      }
      d.points.push(pt);
      this.previewInk(r, d.points);
    } else if (d.mode === 'shape' && d.idx === r.idx) {
      d.cur = pt;
      this.previewShape(r, d.start, d.cur);
    } else if (d.mode === 'screenshot' && d.idx === r.idx) {
      d.cur = pt;
      this.previewShape(r, d.start, d.cur, '#e8590c');
    } else if (d.mode === 'marquee' && d.idx === r.idx) {
      d.cur = pt;
      this.updateMarquee(r, d.start, d.cur);
    } else if (d.mode === 'move' && d.idx === r.idx) {
      const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
      const moved = translateObjects(d.base, dx, dy);
      this.applyLivePreview(r, moved);
    } else if (d.mode === 'scale' && d.idx === r.idx) {
      const box = d.startBox;
      const boxW = Math.max(1, pt.x - box.x), boxH = Math.max(1, pt.y - box.y);
      const scaled = scaleObjects(d.base, d.baseBBox, { x: box.x, y: box.y, w: boxW, h: boxH });
      this.applyLivePreview(r, scaled);
    }
  }

  private onPointerUp(e: PointerEvent, r: PageRenderer): void {
    if (!this.doc || !this.drag) { this.finishMarquee(r); return; }
    const d = this.drag;
    this.drag = null;
    const pt = this.norm(e, r);

    if (d.mode === 'ink' && d.idx === r.idx) {
      if (d.points.length > 1 && this.plugin.tools.state.tool !== 'eraser') {
        this.commitInk(r, d.points);
      } else {
        this.clearLive(r.idx);
      }
    } else if (d.mode === 'shape' && d.idx === r.idx) {
      this.clearLive(r.idx);
      const rect = normRect(d.start, d.cur);
      if (rect.w > 4 || rect.h > 4) this.commitShape(r, rect);
    } else if (d.mode === 'screenshot' && d.idx === r.idx) {
      this.clearLive(r.idx);
      const rect = normRect(d.start, d.cur);
      if (rect.w > 10 && rect.h > 10) void this.snapshotRegion(r, rect);
    } else if (d.mode === 'marquee' && d.idx === r.idx) {
      this.finishMarquee(r, normRect(d.start, d.cur));
    } else if (d.mode === 'move' && d.idx === r.idx) {
      const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        const moved = translateObjects(d.base, dx, dy);
        this.replaceObjects(d.ids, moved);
      } else {
        this.renderStatic(r.idx);
        this.selected = d.base;
        this.renderSelectionBox();
      }
    } else if (d.mode === 'scale' && d.idx === r.idx) {
      const boxW = Math.max(1, pt.x - d.startBox.x), boxH = Math.max(1, pt.y - d.startBox.y);
      const scaled = scaleObjects(d.base, d.baseBBox, { x: d.startBox.x, y: d.startBox.y, w: boxW, h: boxH });
      this.replaceObjects(d.ids, scaled);
    }
  }

  // ---------- 预览绘制 ----------

  private previewInk(r: PageRenderer, points: Pt[]): void {
    this.clearLive(r.idx);
    const dpr = window.devicePixelRatio || 1;
    const ctx = r.liveCanvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const st = this.plugin.tools.state;
    const isHi = st.tool === 'highlighter';
    const outline = makeStroke(points, {
      color: st.color, size: st.size * r.scale, highlighter: isHi,
    });
    ctx.globalAlpha = isHi ? 0.45 : 1;
    ctx.fillStyle = st.color;
    tracePath(ctx, outline);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private previewShape(r: PageRenderer, start: Pt, cur: Pt, color?: string): void {
    this.clearLive(r.idx);
    const dpr = window.devicePixelRatio || 1;
    const ctx = r.liveCanvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const st = this.plugin.tools.state;
    const rect = normRect(start, cur);
    ctx.strokeStyle = color ?? st.color;
    ctx.lineWidth = Math.max(1, st.size * r.scale);
    ctx.setLineDash(color ? [6, 4] : []);
    ctx.strokeRect(rect.x * r.scale, rect.y * r.scale, rect.w * r.scale, rect.h * r.scale);
    ctx.setLineDash([]);
  }

  private applyLivePreview(r: PageRenderer, objs: AnnoObject[]): void {
    this.renderStatic(r.idx);
    const dpr = window.devicePixelRatio || 1;
    const ctx = r.liveCanvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const o of objs) drawObject(ctx, o, r.scale, { images: this.images });
    this.selected = objs;
  }

  // ---------- 对象提交 ----------

  private baseObject(r: PageRenderer, kind: AnnoObject['kind']): Partial<AnnoObject> {
    return {
      id: uid(),
      file: this.file?.path ?? '',
      page: r.page.id,
      kind,
      created: Date.now(),
      modified: Date.now(),
    };
  }

  private commitInk(r: PageRenderer, points: Pt[]): void {
    const st = this.plugin.tools.state;
    const o: AnnoObject = {
      ...this.baseObject(r, 'ink'),
      points,
      color: st.color,
      size: st.size,
      opacity: st.tool === 'highlighter' ? 0.45 : 1,
      tool: st.tool,
    } as AnnoObject;
    this.pushUndo();
    this.doc!.objects.push(o);
    this.clearLive(r.idx);
    this.renderStatic(r.idx);
    this.scheduleSave();
  }

  private commitShape(r: PageRenderer, rect: Rect): void {
    const st = this.plugin.tools.state;
    const o: AnnoObject = {
      ...this.baseObject(r, st.tool === 'line' || st.tool === 'arrow' || st.tool === 'arrow2' ? st.tool : 'rect'),
      rects: [rect],
      color: st.color,
      size: st.size,
    } as AnnoObject;
    if (st.tool === 'ellipse') o.kind = 'ellipse';
    this.pushUndo();
    this.doc!.objects.push(o);
    this.renderStatic(r.idx);
    this.scheduleSave();
  }

  private addSticker(r: PageRenderer, pt: Pt): void {
    const st = this.plugin.tools.state;
    const o: AnnoObject = {
      ...this.baseObject(r, 'sticker'),
      rects: [{ x: pt.x - 60, y: pt.y - 60, w: 120, h: 120 }],
      stickerId: st.stickerId,
    } as AnnoObject;
    this.pushUndo();
    this.doc!.objects.push(o);
    this.renderStatic(r.idx);
    this.scheduleSave();
  }

  private openTextEditor(r: PageRenderer, pt: Pt): void {
    const st = this.plugin.tools.state;
    const ta = r.el.createEl('textarea', { cls: 'mink-text-editor' });
    ta.style.left = `${pt.x * r.scale}px`;
    ta.style.top = `${pt.y * r.scale}px`;
    ta.style.fontSize = `${st.size * r.scale}px`;
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
      const o: AnnoObject = {
        ...this.baseObject(r, 'text'),
        rects: [{ x: pt.x, y: pt.y, w, h }],
        text, color: st.color, size: st.size,
      } as AnnoObject;
      this.pushUndo();
      this.doc!.objects.push(o);
      this.renderStatic(r.idx);
      this.scheduleSave();
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); ta.value = ''; commit(); }
      e.stopPropagation();
    });
  }

  // ---------- 便利贴 ----------

  private addSticky(r: PageRenderer, pt: Pt): void {
    const color = STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)];
    const o: AnnoObject = {
      ...this.baseObject(r, 'sticky'),
      rects: [{ x: pt.x, y: pt.y, w: 220, h: 170 }],
      bg: color, text: '', size: 16,
    } as AnnoObject;
    this.pushUndo();
    this.doc!.objects.push(o);
    this.renderStickies(r.idx);
    this.scheduleSave();
  }

  private renderStickies(idx: number): void {
    const r = this.renderers[idx];
    if (!r || !this.doc) return;
    r.stickyLayer.empty();
    for (const o of this.doc.objects) {
      if (o.page !== r.page.id || o.kind !== 'sticky') continue;
      const rect = o.rects?.[0];
      if (!rect) continue;
      const node = r.stickyLayer.createEl('div', { cls: 'mink-sticky' });
      node.style.left = `${rect.x * r.scale}px`;
      node.style.top = `${rect.y * r.scale}px`;
      node.style.width = `${rect.w * r.scale}px`;
      node.style.height = `${rect.h * r.scale}px`;
      node.style.background = o.bg ?? '#ffe066';

      const head = node.createEl('div', { cls: 'mink-sticky-head' });
      const del = head.createEl('div', { cls: 'mink-sticky-del', text: '✕', attr: { title: '删除便利贴' } });
      del.addEventListener('pointerdown', e => e.stopPropagation());
      del.addEventListener('click', e => {
        e.stopPropagation();
        this.removeObject(o.id);
      });
      // 拖动
      head.addEventListener('pointerdown', e => {
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const orig = { ...rect };
        const onMove = (ev: PointerEvent) => {
          rect.x = orig.x + (ev.clientX - startX) / r.scale;
          rect.y = orig.y + (ev.clientY - startY) / r.scale;
          node.style.left = `${rect.x * r.scale}px`;
          node.style.top = `${rect.y * r.scale}px`;
        };
        const onUp = () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          o.modified = Date.now();
          this.scheduleSave();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });

      const ta = node.createEl('textarea', { cls: 'mink-sticky-text' });
      ta.value = o.text ?? '';
      ta.style.fontSize = `${(o.size ?? 16) * r.scale}px`;
      ta.addEventListener('input', () => { o.text = ta.value; this.scheduleSave(); });
      ta.addEventListener('pointerdown', e => e.stopPropagation());
      ta.addEventListener('keydown', e => e.stopPropagation());
    }
  }

  // ---------- 选择与变换 ----------

  private startMarquee(e: PointerEvent, r: PageRenderer, pt: Pt): void {
    // 已有选区：命中选区内 → 拖动；命中四角 → 缩放
    if (this.selected.length) {
      const box = objectsBBox(this.selected)!;
      const corner = hitCorner(pt, box, 14);
      if (corner) {
        const baseBBox = { ...box };
        const base = this.selected.map(o => JSON.parse(JSON.stringify(o)) as AnnoObject);
        this.drag = { mode: 'scale', idx: r.idx, baseBBox, startBox: box, base, ids: base.map(o => o.id) };
        e.preventDefault();
        r.liveCanvas.setPointerCapture(e.pointerId);
        return;
      }
      if (pt.x > box.x && pt.x < box.x + box.w && pt.y > box.y && pt.y < box.y + box.h) {
        const base = this.selected.map(o => JSON.parse(JSON.stringify(o)) as AnnoObject);
        this.drag = { mode: 'move', idx: r.idx, start: pt, base, ids: base.map(o => o.id) };
        e.preventDefault();
        r.liveCanvas.setPointerCapture(e.pointerId);
        return;
      }
    }
    const el = r.selectLayer.createEl('div', { cls: 'mink-marquee' });
    this.drag = { mode: 'marquee', idx: r.idx, start: pt, cur: pt, el };
    e.preventDefault();
    r.liveCanvas.setPointerCapture(e.pointerId);
  }

  private updateMarquee(r: PageRenderer, start: Pt, cur: Pt): void {
    const d = this.drag;
    if (!d || d.mode !== 'marquee') return;
    const rect = normRect(start, cur);
    d.el.style.left = `${rect.x * r.scale}px`;
    d.el.style.top = `${rect.y * r.scale}px`;
    d.el.style.width = `${rect.w * r.scale}px`;
    d.el.style.height = `${rect.h * r.scale}px`;
  }

  private finishMarquee(r: PageRenderer, rect?: Rect): void {
    for (const rr of this.renderers) rr.selectLayer.querySelectorAll('.mink-marquee').forEach(el => el.remove());
    if (rect && this.doc) {
      this.selected = marqueeSelect(
        this.doc.objects.filter(o => o.page === r.page.id && o.kind !== 'sticky'),
        rect,
      );
    }
    this.renderSelectionBox();
  }

  private renderSelectionBox(): void {
    for (const r of this.renderers) r.selectLayer.querySelectorAll('.mink-selection, .mink-selection-handle, .mink-selection-bar').forEach(el => el.remove());
    if (!this.selected.length || !this.doc) return;
    // 只在同一页的选区显示框
    const pageId = this.selected[0].page;
    const r = this.renderers.find(rr => rr.page.id === pageId);
    if (!r) return;
    const box = objectsBBox(this.selected)!;
    const boxEl = r.selectLayer.createEl('div', { cls: 'mink-selection' });
    boxEl.style.left = `${box.x * r.scale}px`;
    boxEl.style.top = `${box.y * r.scale}px`;
    boxEl.style.width = `${box.w * r.scale}px`;
    boxEl.style.height = `${box.h * r.scale}px`;
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const h = r.selectLayer.createEl('div', { cls: 'mink-selection-handle' });
      h.style.left = `${(box.x + box.w * cx) * r.scale - 5}px`;
      h.style.top = `${(box.y + box.h * cy) * r.scale - 5}px`;
    }
    // 操作条
    const bar = r.selectLayer.createEl('div', { cls: 'mink-selection-bar' });
    bar.style.left = `${box.x * r.scale}px`;
    bar.style.top = `${Math.max(0, box.y * r.scale - 36)}px`;
    const mk = (label: string, fn: () => void) => {
      const b = bar.createEl('div', { cls: 'mink-selection-btn', text: label });
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    };
    mk('复制', () => this.copySelection());
    mk('删除', () => this.removeObjects(this.selected.map(o => o.id)));
    mk('回链截图', () => {
      const box2 = objectsBBox(this.selected)!;
      void this.snapshotRegion(r, box2);
    });
  }

  private replaceObjects(ids: string[], objs: AnnoObject[]): void {
    if (!this.doc) return;
    this.pushUndo();
    const idSet = new Set(ids);
    this.doc.objects = this.doc.objects.filter(o => !idSet.has(o.id));
    for (const o of objs) this.doc.objects.push(o);
    this.selected = objs;
    for (const r of this.renderers) this.renderStatic(r.idx);
    this.renderSelectionBox();
    this.scheduleSave();
  }

  private removeObject(id: string): void {
    this.removeObjects([id]);
  }

  private removeObjects(ids: string[]): void {
    if (!this.doc) return;
    this.pushUndo();
    const idSet = new Set(ids);
    this.doc.objects = this.doc.objects.filter(o => !idSet.has(o.id));
    this.selected = [];
    for (const r of this.renderers) { this.renderStatic(r.idx); this.renderStickies(r.idx); }
    this.renderSelectionBox();
    this.scheduleSave();
  }

  private eraseAt(r: PageRenderer, pt: Pt): void {
    if (!this.doc) return;
    const tol = 10;
    const victims = this.doc.objects.filter(o =>
      o.page === r.page.id && o.kind === 'ink'
      && o.points?.some(p => (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2 < (tol + (o.size ?? 4)) ** 2));
    if (victims.length) this.removeObjects(victims.map(o => o.id));
  }

  private copySelection(): boolean {
    if (!this.selected.length) return false;
    this.clipboard = this.selected.map(o => JSON.parse(JSON.stringify(o)) as AnnoObject);
    new Notice(`已复制 ${this.clipboard.length} 个对象`);
    return true;
  }

  private pasteClipboard(): boolean {
    if (!this.doc || !this.clipboard.length) return false;
    const target = this.renderers[0];
    if (!target) return false;
    const copies = cloneObjects(this.clipboard, () => uid(), 24);
    for (const c of copies) { c.page = target.page.id; c.file = this.file?.path ?? ''; }
    this.pushUndo();
    this.doc.objects.push(...copies);
    this.selected = copies;
    this.renderStatic(target.idx);
    this.renderStickies(target.idx);
    this.renderSelectionBox();
    this.scheduleSave();
    return true;
  }

  private deleteKey(): boolean {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return false;
    if (!this.selected.length) return false;
    this.removeObjects(this.selected.map(o => o.id));
    return true;
  }

  // ---------- 撤销 / 重做 ----------

  private pushUndo(): void {
    if (!this.doc) return;
    this.undoStack.push(JSON.stringify(this.doc.objects));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): boolean {
    if (!this.doc || !this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.doc.objects));
    this.doc.objects = JSON.parse(this.undoStack.pop()!);
    this.selected = [];
    this.rerenderAll();
    this.scheduleSave();
    return true;
  }

  private redo(): boolean {
    if (!this.doc || !this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.doc.objects));
    this.doc.objects = JSON.parse(this.redoStack.pop()!);
    this.selected = [];
    this.rerenderAll();
    this.scheduleSave();
    return true;
  }

  private rerenderAll(): void {
    for (const r of this.renderers) { this.renderStatic(r.idx); this.renderStickies(r.idx); }
    this.renderSelectionBox();
  }

  // ---------- 页面管理 ----------

  private addPage(): void {
    if (!this.doc) return;
    this.doc.pages.push(newPage(this.plugin.settings.defaultPaper));
    this.rebuildPages();
    this.scheduleSave();
  }

  private removePage(idx: number): void {
    if (!this.doc || this.doc.pages.length <= 1) {
      new Notice('至少保留一页');
      return;
    }
    const page = this.doc.pages[idx];
    this.pushUndo();
    this.doc.pages.splice(idx, 1);
    this.doc.objects = this.doc.objects.filter(o => o.page !== page.id);
    this.rebuildPages();
    this.scheduleSave();
  }

  // ---------- 图片 ----------

  private pickImage(): void {
    new ImagePickerModal(this.app, this.file?.path ?? '', async (imgFile) => {
      const r = this.renderers[this.renderers.length - 1];
      if (!r || !this.doc) return;
      this.pushUndo();
      this.doc.objects.push({
        ...this.baseObject(r, 'image'),
        src: imgFile.path,
        rects: [{ x: 300, y: 300, w: 400, h: 300 }],
      } as AnnoObject);
      this.images = await preloadImages(this.app, this.doc.objects);
      this.renderStatic(r.idx);
      this.scheduleSave();
    }).open();
  }

  // ---------- 截图 ----------

  private async snapshotRegion(r: PageRenderer, region: Rect): Promise<void> {
    if (!this.file) return;
    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement('canvas');
    out.width = Math.max(2, Math.round(region.w * r.scale));
    out.height = Math.max(2, Math.round(region.h * r.scale));
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(
      r.staticCanvas,
      region.x * r.scale * dpr, region.y * r.scale * dpr,
      region.w * r.scale * dpr, region.h * r.scale * dpr,
      0, 0, out.width, out.height,
    );
    // 便利贴渲染进截图
    for (const o of this.doc?.objects ?? []) {
      if (o.page !== r.page.id || o.kind !== 'sticky') continue;
      const rect = o.rects?.[0];
      if (!rect || !intersects(rect, region)) continue;
      ctx.save();
      ctx.translate(-region.x * r.scale, -region.y * r.scale);
      drawObject(ctx, o, r.scale, { images: this.images });
      ctx.restore();
    }
    const blob = await canvasToBlob(out);
    new SnapshotActionsModal(this.plugin, blob, {
      file: this.file.path,
      page: r.page.id,
      link: minkWikiLink(this.file.path),
      label: `${this.file.basename} 截图`,
    }).open();
  }

  // ---------- 闪烁定位 ----------

  private flashAnno(annoId: string): void {
    const o = this.doc?.objects.find(x => x.id === annoId);
    if (!o) return;
    const r = this.renderers.find(rr => rr.page.id === o.page);
    if (!r) return;
    const box = objectBBox(o);
    if (!box) return;
    const start = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const tick = () => {
      const t = performance.now() - start;
      if (t > 1600) { this.clearLive(r.idx); this.flashRAF = null; return; }
      this.clearLive(r.idx);
      const ctx = r.liveCanvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = '#e8590c';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -t / 25;
      ctx.strokeRect(box.x * r.scale, box.y * r.scale, box.w * r.scale, box.h * r.scale);
      this.flashRAF = requestAnimationFrame(tick);
    };
    tick();
    r.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- 保存 ----------

  private scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { void this.flushSave(); }, 800);
  }

  private async flushSave(notify = false): Promise<void> {
    if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.doc && this.file) {
      await writeDoc(this.app, this.file, this.doc).catch(e => console.error(e));
      if (notify) new Notice('已保存');
    }
  }
}

function normRect(a: Pt, b: Pt): Rect {
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
  };
}

function hitCorner(pt: Pt, box: Rect, tol: number): boolean {
  return (Math.abs(pt.x - box.x) < tol || Math.abs(pt.x - (box.x + box.w)) < tol)
    && (Math.abs(pt.y - box.y) < tol || Math.abs(pt.y - (box.y + box.h)) < tol);
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

/** vault 图片选择器 */
class ImagePickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: import('obsidian').App, private sourcePath: string, private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder('选择要插入的图片…');
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(f => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.extension));
  }

  getItemText(item: TFile): string { return item.path; }

  onChooseItem(item: TFile): void {
    this.onPick(item);
  }
}
