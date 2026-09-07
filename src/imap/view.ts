import { FileView, Notice, Scope, TFile, setIcon } from 'obsidian';
import type { IMapDoc, IMapNode } from '../types';
import { VIEW_TYPE_IMAP } from '../constants';
import type { MinkSuite } from '../main';
import { childrenMap, isDescendant, makeNode, readDoc, removeSubtree, writeDoc } from './file';
import { copyText, minkWikiLink, openAnno, pdfWikiLink } from '../core/link';
import { TextInputModal } from '../core/modals';

/** 布局参数（世界坐标 / CSS 像素） */
const GAP_X = 64;
const GAP_Y = 14;
const NODE_COLORS = ['#f76707', '#f08c00', '#2f9e44', '#1971c2', '#6741d9', '#c2255c'];

interface Box { x: number; y: number; w: number; h: number }

interface NodeDrag {
  id: string;
  startX: number;
  startY: number;
  /** 自动布局中心点 */
  base: { x: number; y: number };
  size: { w: number; h: number };
  origDx: number;
  origDy: number;
  curDx: number;
  curDy: number;
  moved: boolean;
}

interface PanState { startX: number; startY: number; panX: number; panY: number }

/** .imap 批注思维导图视图：树形画布 + 平移缩放 + 节点编辑 */
export class ImapView extends FileView {
  plugin: MinkSuite;
  private doc: IMapDoc | null = null;
  private selectedId: string | null = null;
  private editingId: string | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private panning: PanState | null = null;
  private drag: NodeDrag | null = null;
  private sizes = new Map<string, { w: number; h: number }>();
  private basePos = new Map<string, { x: number; y: number }>();
  private layout = new Map<string, Box>();
  private nodeEls = new Map<string, HTMLElement>();
  private imageUrls = new Map<string, string>();
  private saveTimer: number | null = null;
  private dirty = false;
  private didFit = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private viewportEl!: HTMLElement;
  private worldEl!: HTMLElement;
  private edgesEl!: SVGSVGElement;
  private zoomLabelEl!: HTMLElement;
  private opsBarEl!: HTMLElement;
  private unsubs: Array<() => void> = [];

  constructor(leaf: import('obsidian').WorkspaceLeaf, plugin: MinkSuite) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
  }

  getViewType(): string { return VIEW_TYPE_IMAP; }
  getDisplayText(): string { return this.file?.basename ?? '思维导图'; }
  getIcon(): string { return 'network'; }

  // ---------- 生命周期 ----------

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('mink-imap-view');

    const bar = this.contentEl.createEl('div', { cls: 'mink-imap-toolbar' });
    const mkTool = (icon: string, label: string, fn: () => void) => {
      const b = bar.createEl('button', { cls: 'mink-btn', attr: { title: label, 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', () => fn());
      return b;
    };
    mkTool('wand-2', '整理布局（清除手动偏移）', () => this.tidyLayout());
    mkTool('maximize', '适应画布', () => this.fitView());
    mkTool('zoom-out', '缩小', () => this.zoomAt(this.viewportCenter(), 1 / 1.2));
    this.zoomLabelEl = bar.createEl('span', { cls: 'mink-imap-zoom', text: '100%' });
    mkTool('zoom-in', '放大', () => this.zoomAt(this.viewportCenter(), 1.2));

    this.opsBarEl = this.contentEl.createEl('div', { cls: 'mink-imap-ops' });

    this.viewportEl = this.contentEl.createEl('div', { cls: 'mink-imap-viewport' });
    this.worldEl = this.viewportEl.createEl('div', { cls: 'mink-imap-world' });
    this.edgesEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.edgesEl.setAttribute('class', 'mink-imap-edges');
    this.edgesEl.setAttribute('overflow', 'visible');
    this.worldEl.appendChild(this.edgesEl);

    this.viewportEl.addEventListener('pointerdown', e => this.onViewportDown(e));
    this.viewportEl.addEventListener('pointermove', e => this.onPointerMove(e));
    this.viewportEl.addEventListener('pointerup', e => this.onPointerUp(e));
    this.viewportEl.addEventListener('pointercancel', () => {
      this.drag = null;
      this.panning = null;
    });
    this.viewportEl.addEventListener('wheel', e => this.onWheel(e), { passive: false });

    this.scope = new Scope(this.app.scope);
    const guarded = (fn: () => boolean) => () => (this.editingId ? false : fn());
    this.scope.register([], 'Tab', guarded(() => (this.selectedId ? (this.addChildNode(this.selectedId), true) : false)));
    this.scope.register([], 'Enter', guarded(() => (this.selectedId ? (this.addSibling(this.selectedId), true) : false)));
    this.scope.register([], 'Delete', guarded(() => (this.selectedId ? (this.deleteNode(this.selectedId), true) : false)));
    this.scope.register([], 'Backspace', guarded(() => (this.selectedId ? (this.deleteNode(this.selectedId), true) : false)));
    this.scope.register([], 'F2', guarded(() => (this.selectedId ? (this.startEdit(this.selectedId), true) : false)));
    this.scope.register(['Mod'], 'z', guarded(() => this.undo()));
    this.scope.register(['Mod', 'Shift'], 'z', guarded(() => this.redo()));
    this.scope.register(['Mod'], 'y', guarded(() => this.redo()));

    this.unsubs.push(this.plugin.bus.on('imap-changed', ({ file }) => {
      if (file === this.file?.path) void this.reload();
    }));
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.doc = await readDoc(this.app, file);
    this.selectedId = null;
    this.editingId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.didFit = false;
    await this.loadImages();
    this.render();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    void file;
    await this.flushSave();
  }

  async onUnload(): Promise<void> {
    await this.flushSave();
    for (const fn of this.unsubs) fn();
    this.unsubs = [];
    for (const url of this.imageUrls.values()) URL.revokeObjectURL(url);
    this.imageUrls.clear();
  }

  private async reload(): Promise<void> {
    if (!this.file) return;
    this.editingId = null;
    this.doc = await readDoc(this.app, this.file);
    await this.loadImages();
    this.render();
  }

  // ---------- 渲染 ----------

  private render(): void {
    if (!this.doc) return;
    this.editingId = null;
    this.worldEl.removeClass('is-ready');
    for (const el of Array.from(this.nodeEls.values())) el.remove();
    this.nodeEls.clear();
    this.clearEdges();

    const root = this.doc.nodes.find(n => n.parentId === null);
    if (!root) return;

    // 可见节点：折叠的子树跳过
    const byParent = childrenMap(this.doc);
    const visible: IMapNode[] = [];
    const pushVisible = (n: IMapNode) => {
      visible.push(n);
      if (n.collapsed) return;
      for (const c of byParent.get(n.id) ?? []) pushVisible(c);
    };
    pushVisible(root);

    // 1. 建 DOM（未定位）
    for (const n of visible) this.worldEl.appendChild(this.buildNodeEl(n));
    // 2. 测量
    this.sizes.clear();
    for (const n of visible) {
      const el = this.nodeEls.get(n.id);
      if (el) this.sizes.set(n.id, { w: el.offsetWidth, h: el.offsetHeight });
    }
    // 3. 布局 + 定位 + 连线
    this.computeLayout(root, byParent, visible);
    for (const n of visible) this.positionNode(n);
    this.drawEdges();
    this.applyTransform();
    this.worldEl.addClass('is-ready');
    if (!this.didFit) {
      this.fitView();
      this.didFit = true;
    }
    this.refreshSelection();
  }

  private buildNodeEl(n: IMapNode): HTMLElement {
    const el = createDiv({ cls: 'mink-imap-node' });
    el.dataset.id = n.id;
    if (n.parentId === null) el.addClass('is-root');
    if (n.color) {
      el.style.borderColor = n.color;
      el.style.background = `${n.color}26`;
    }
    el.createDiv({ cls: 'mink-imap-node-text', text: n.text || '…' });
    const url = n.source?.snapshot ? this.imageUrls.get(n.source.snapshot) : null;
    if (url) el.createEl('img', { cls: 'mink-imap-thumb', attr: { src: url, alt: '' } });
    const meta = el.createEl('div', { cls: 'mink-imap-node-meta' });
    if (n.note) {
      const i = meta.createEl('span', { cls: 'mink-imap-node-note', attr: { title: n.note } });
      setIcon(i, 'sticky-note');
    }
    if (n.source) {
      const i = meta.createEl('span', { cls: 'mink-imap-node-src', attr: { title: `来自 ${n.source.file}` } });
      setIcon(i, 'file-text');
    }
    if (n.collapsed) {
      const cnt = this.hiddenCount(n);
      el.createEl('span', { cls: 'mink-imap-node-fold', text: `＋${cnt}` });
    }
    el.addEventListener('pointerdown', e => this.onNodeDown(e, n.id));
    el.addEventListener('dblclick', e => {
      e.stopPropagation();
      this.startEdit(n.id);
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      this.select(n.id);
    });
    this.nodeEls.set(n.id, el);
    return el;
  }

  /** 左右分栏的整齐树布局；dx/dy 为相对自动位置的手动偏移（子树整体跟随） */
  private computeLayout(root: IMapNode, byParent: Map<string, IMapNode[]>, visible: IMapNode[]): void {
    const visSet = new Set(visible.map(n => n.id));
    const kids = (id: string) => (byParent.get(id) ?? []).filter(c => visSet.has(c.id));
    const size = (id: string) => this.sizes.get(id) ?? { w: 100, h: 36 };
    const H = new Map<string, number>();
    const stackH = (nodes: IMapNode[]) =>
      nodes.reduce((a, c) => a + (H.get(c.id) ?? 0), 0) + GAP_Y * Math.max(0, nodes.length - 1);
    const walk = (n: IMapNode): number => {
      let h = size(n.id).h;
      const ch = kids(n.id);
      if (ch.length) {
        for (const c of ch) walk(c);
        if (n.id === root.id) {
          // 根的孩子左右分栏，各栏独立堆叠
          const right = ch.filter((_, i) => i % 2 === 0);
          const left = ch.filter((_, i) => i % 2 === 1);
          h = Math.max(h, stackH(right), stackH(left));
        } else {
          h = Math.max(h, stackH(ch));
        }
      }
      H.set(n.id, h);
      return h;
    };
    walk(root);

    this.basePos.clear();
    this.layout.clear();
    const place = (n: IMapNode, top: number, cx: number, side: 1 | -1, accDx: number, accDy: number): void => {
      const s = size(n.id);
      const h = H.get(n.id) ?? s.h;
      const baseCy = top + h / 2;
      this.basePos.set(n.id, { x: cx, y: baseCy });
      const ax = accDx + (n.dx ?? 0);
      const ay = accDy + (n.dy ?? 0);
      this.layout.set(n.id, { x: cx - s.w / 2 + ax, y: baseCy - s.h / 2 + ay, w: s.w, h: s.h });
      const ch = kids(n.id);
      if (!ch.length) return;
      const groups: Array<[IMapNode[], 1 | -1]> = n.id === root.id
        ? [[ch.filter((_, i) => i % 2 === 0), 1], [ch.filter((_, i) => i % 2 === 1), -1]]
        : [[ch, side]];
      for (const [grp, sd] of groups) {
        let cur = top;
        for (const c of grp) {
          const ccs = size(c.id);
          place(c, cur, cx + sd * (s.w / 2 + GAP_X + ccs.w / 2), sd, ax, ay);
          cur += H.get(c.id) ?? ccs.h + GAP_Y;
        }
      }
    };
    place(root, -(H.get(root.id) ?? 0) / 2, 0, 1, 0, 0);
  }

  private positionNode(n: IMapNode): void {
    const el = this.nodeEls.get(n.id);
    const box = this.layout.get(n.id);
    if (!el || !box) return;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
  }

  private clearEdges(): void {
    while (this.edgesEl.firstChild) this.edgesEl.removeChild(this.edgesEl.firstChild);
  }

  private drawEdges(): void {
    if (!this.doc) return;
    this.clearEdges();
    const layout = this.layout;
    for (const n of this.doc.nodes) {
      if (n.parentId === null) continue;
      const pb = layout.get(n.parentId);
      const cb = layout.get(n.id);
      if (!pb || !cb) continue;
      // 子在父右侧 → 连右缘，否则连左缘（手动拖到另一侧时自动适配）
      const side = cb.x + cb.w / 2 >= pb.x + pb.w / 2 ? 1 : -1;
      const sx = side === 1 ? pb.x + pb.w : pb.x;
      const sy = pb.y + pb.h / 2;
      const ex = side === 1 ? cb.x : cb.x + cb.w;
      const ey = cb.y + cb.h / 2;
      const mx = (sx + ex) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`);
      path.setAttribute('class', 'mink-imap-edge');
      if (n.color) path.setAttribute('stroke', n.color);
      this.edgesEl.appendChild(path);
    }
  }

  private applyTransform(): void {
    this.worldEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    this.zoomLabelEl.setText(`${Math.round(this.zoom * 100)}%`);
  }

  // ---------- 平移 / 缩放 ----------

  private viewportCenter(): { x: number; y: number } {
    return { x: this.viewportEl.clientWidth / 2, y: this.viewportEl.clientHeight / 2 };
  }

  private zoomAt(pt: { x: number; y: number }, factor: number): void {
    const nz = Math.min(3, Math.max(0.2, this.zoom * factor));
    const wx = (pt.x - this.panX) / this.zoom;
    const wy = (pt.y - this.panY) / this.zoom;
    this.panX = pt.x - wx * nz;
    this.panY = pt.y - wy * nz;
    this.zoom = nz;
    this.applyTransform();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.viewportEl.getBoundingClientRect();
    this.zoomAt(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      e.deltaY < 0 ? 1.12 : 1 / 1.12,
    );
  }

  private onViewportDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.mink-imap-node')) return;
    this.viewportEl.setPointerCapture(e.pointerId);
    this.panning = { startX: e.clientX, startY: e.clientY, panX: this.panX, panY: this.panY };
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.drag) {
      const d = this.drag;
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.moved = true;
      d.curDx = d.origDx + (e.clientX - d.startX) / this.zoom;
      d.curDy = d.origDy + (e.clientY - d.startY) / this.zoom;
      const el = this.nodeEls.get(d.id);
      const box = this.layout.get(d.id);
      if (el && box) {
        box.x = d.base.x - d.size.w / 2 + d.curDx;
        box.y = d.base.y - d.size.h / 2 + d.curDy;
        el.style.left = `${box.x}px`;
        el.style.top = `${box.y}px`;
        this.drawEdges();
      }
      return;
    }
    if (this.panning) {
      this.panX = this.panning.panX + (e.clientX - this.panning.startX);
      this.panY = this.panning.panY + (e.clientY - this.panning.startY);
      this.applyTransform();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      const node = this.doc?.nodes.find(n => n.id === d.id);
      if (!node || !this.doc) return;
      if (!d.moved) {
        this.select(d.id);
        return;
      }
      this.pushUndo();
      // 命中其他节点 → 改挂父级；否则仅记录手动偏移
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
        ?.closest('.mink-imap-node') as HTMLElement | null;
      const targetId = target?.dataset.id ?? null;
      if (targetId && targetId !== d.id && !isDescendant(this.doc, d.id, targetId)) {
        node.parentId = targetId;
        node.dx = 0;
        node.dy = 0;
        new Notice('已挂到新父节点下');
      } else {
        node.dx = Math.round(d.curDx);
        node.dy = Math.round(d.curDy);
      }
      node.modified = Date.now();
      this.markDirty();
      this.render();
      return;
    }
    this.panning = null;
  }

  // ---------- 节点交互 ----------

  private onNodeDown(e: PointerEvent, id: string): void {
    if (e.button !== 0 || this.editingId) return;
    const el = this.nodeEls.get(id);
    if (!el || !this.doc) return;
    el.setPointerCapture(e.pointerId);
    const node = this.doc.nodes.find(n => n.id === id);
    if (!node) return;
    this.drag = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      base: this.basePos.get(id) ?? { x: 0, y: 0 },
      size: this.sizes.get(id) ?? { w: 100, h: 36 },
      origDx: node.dx ?? 0,
      origDy: node.dy ?? 0,
      curDx: node.dx ?? 0,
      curDy: node.dy ?? 0,
      moved: false,
    };
  }

  private select(id: string): void {
    this.selectedId = id;
    this.refreshSelection();
  }

  private deselect(): void {
    this.selectedId = null;
    this.refreshSelection();
  }

  private refreshSelection(): void {
    if (this.selectedId && !this.doc?.nodes.some(n => n.id === this.selectedId)) {
      this.selectedId = null;
    }
    for (const [id, el] of this.nodeEls) el.toggleClass('is-selected', id === this.selectedId);
    this.refreshOpsBar();
  }

  private refreshOpsBar(): void {
    const bar = this.opsBarEl;
    bar.empty();
    const n = this.selectedId ? this.doc?.nodes.find(x => x.id === this.selectedId) : null;
    if (!n) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    const mk = (icon: string, label: string, fn: () => void) => {
      const b = bar.createEl('button', { cls: 'mink-btn', attr: { title: label } });
      setIcon(b, icon);
      b.createSpan({ text: label });
      b.addEventListener('click', () => fn());
    };
    mk('corner-down-right', '子节点', () => this.addChildNode(n.id));
    if (n.parentId !== null) mk('plus', '同级', () => this.addSibling(n.id));
    mk('type', '文字', () => this.startEdit(n.id));
    mk('sticky-note', '备注', () => this.editNote(n.id));
    const colors = bar.createEl('span', { cls: 'mink-imap-colors' });
    for (const c of NODE_COLORS) {
      const dot = colors.createEl('span', { cls: 'mink-imap-color-dot', attr: { title: `颜色 ${c}` } });
      dot.style.background = c;
      dot.addEventListener('click', () => this.setColor(n.id, c));
    }
    const clear = colors.createEl('span', { cls: 'mink-imap-color-dot mink-imap-color-clear', attr: { title: '清除颜色' } });
    clear.setText('×');
    clear.addEventListener('click', () => this.setColor(n.id, null));
    if (n.source) {
      mk('file-text', '来源', () => this.openSource(n.id));
      mk('link', '回链', () => this.copySourceLink(n.id));
    }
    mk(n.collapsed ? 'chevrons-down-up' : 'chevrons-up-down', n.collapsed ? '展开' : '折叠', () => this.toggleCollapse(n.id));
    mk('trash-2', '删除', () => this.deleteNode(n.id));
    mk('x', '取消', () => this.deselect());
  }

  private addChildNode(parentId: string): void {
    if (!this.doc) return;
    this.pushUndo();
    const node = makeNode('新主题', parentId);
    this.doc.nodes.push(node);
    node.modified = Date.now();
    this.markDirty();
    this.render();
    this.select(node.id);
    this.startEdit(node.id);
  }

  private addSibling(id: string): void {
    if (!this.doc) return;
    const cur = this.doc.nodes.find(n => n.id === id);
    if (!cur || cur.parentId === null) {
      new Notice('根节点没有同级节点');
      return;
    }
    this.pushUndo();
    const node = makeNode('新主题', cur.parentId);
    this.doc.nodes.push(node);
    this.markDirty();
    this.render();
    this.select(node.id);
    this.startEdit(node.id);
  }

  private deleteNode(id: string): void {
    if (!this.doc) return;
    const cur = this.doc.nodes.find(n => n.id === id);
    if (!cur) return;
    if (cur.parentId === null) {
      new Notice('根节点不可删除');
      return;
    }
    this.pushUndo();
    const removed = removeSubtree(this.doc, id);
    if (this.selectedId && removed.some(n => n.id === this.selectedId)) this.selectedId = null;
    this.markDirty();
    this.render();
  }

  private toggleCollapse(id: string): void {
    if (!this.doc) return;
    const n = this.doc.nodes.find(x => x.id === id);
    if (!n) return;
    this.pushUndo();
    n.collapsed = !n.collapsed;
    n.modified = Date.now();
    this.markDirty();
    this.render();
  }

  private setColor(id: string, color: string | null): void {
    if (!this.doc) return;
    const n = this.doc.nodes.find(x => x.id === id);
    if (!n) return;
    this.pushUndo();
    if (color) n.color = color;
    else delete n.color;
    n.modified = Date.now();
    this.markDirty();
    this.render();
  }

  private editNote(id: string): void {
    if (!this.doc) return;
    const n = this.doc.nodes.find(x => x.id === id);
    if (!n) return;
    new TextInputModal(this.app, '编辑节点备注', n.note ?? '', v => {
      this.pushUndo();
      n.note = v || undefined;
      n.modified = Date.now();
      this.markDirty();
      this.render();
    }).open();
  }

  private startEdit(id: string): void {
    const el = this.nodeEls.get(id);
    const node = this.doc?.nodes.find(n => n.id === id);
    if (!el || !node) return;
    const textEl = el.querySelector('.mink-imap-node-text') as HTMLElement | null;
    if (!textEl) return;
    this.editingId = id;
    el.addClass('is-editing');
    textEl.setAttribute('contenteditable', 'plaintext-only');
    textEl.focus();
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const commit = () => {
      if (this.editingId !== id) return;
      this.editingId = null;
      const t = textEl.textContent?.trim();
      if (t && t !== node.text) {
        this.pushUndo();
        node.text = t;
        node.modified = Date.now();
        this.markDirty();
      }
      this.render();
    };
    textEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.editingId = null;
        this.render();
      }
    });
    textEl.addEventListener('blur', () => commit());
  }

  private openSource(id: string): void {
    if (!this.doc) return;
    const n = this.doc.nodes.find(x => x.id === id);
    const s = n?.source;
    if (!s) {
      new Notice('该节点没有来源');
      return;
    }
    if (s.file.endsWith('.pdf')) {
      void openAnno(this.app, this.plugin.bus, s.file, typeof s.page === 'number' ? s.page : undefined, s.annoId);
    } else if (s.file.endsWith('.mink')) {
      void openAnno(this.app, this.plugin.bus, s.file, undefined, s.annoId);
    } else {
      void this.app.workspace.openLinkText(s.file, '', false);
    }
  }

  private copySourceLink(id: string): void {
    if (!this.doc) return;
    const n = this.doc.nodes.find(x => x.id === id);
    const s = n?.source;
    if (!s) {
      new Notice('该节点没有来源');
      return;
    }
    const link = s.file.endsWith('.pdf')
      ? pdfWikiLink(s.file, typeof s.page === 'number' ? s.page : undefined, s.annoId)
      : s.file.endsWith('.mink')
        ? minkWikiLink(s.file, s.annoId)
        : `[[${s.file}]]`;
    void copyText(link, '已复制来源回链');
  }

  private tidyLayout(): void {
    if (!this.doc) return;
    let changed = false;
    for (const n of this.doc.nodes) {
      if (n.dx || n.dy) {
        delete n.dx;
        delete n.dy;
        changed = true;
      }
    }
    if (!changed) {
      new Notice('布局已是整洁状态');
      return;
    }
    this.pushUndo();
    this.markDirty();
    this.render();
  }

  private fitView(): void {
    if (!this.layout.size) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of this.layout.values()) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (!isFinite(minX)) return;
    const vw = this.viewportEl.clientWidth || 800;
    const vh = this.viewportEl.clientHeight || 600;
    const pad = 48;
    this.zoom = Math.min(2, Math.max(0.2, Math.min(
      (vw - pad * 2) / Math.max(1, maxX - minX),
      (vh - pad * 2) / Math.max(1, maxY - minY),
    )));
    this.panX = vw / 2 - ((minX + maxX) / 2) * this.zoom;
    this.panY = vh / 2 - ((minY + maxY) / 2) * this.zoom;
    this.applyTransform();
  }

  private hiddenCount(n: IMapNode): number {
    if (!this.doc) return 0;
    const byParent = childrenMap(this.doc);
    let count = 0;
    const queue = [n.id];
    while (queue.length) {
      for (const c of byParent.get(queue.shift()!) ?? []) {
        count++;
        queue.push(c.id);
      }
    }
    return count;
  }

  // ---------- 撤销 / 重做 ----------

  private pushUndo(): void {
    if (!this.doc) return;
    this.undoStack.push(JSON.stringify(this.doc.nodes));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): boolean {
    if (!this.doc || !this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.doc.nodes));
    this.doc.nodes = JSON.parse(this.undoStack.pop()!) as IMapNode[];
    this.markDirty();
    this.render();
    return true;
  }

  private redo(): boolean {
    if (!this.doc || !this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.doc.nodes));
    this.doc.nodes = JSON.parse(this.redoStack.pop()!) as IMapNode[];
    this.markDirty();
    this.render();
    return true;
  }

  // ---------- 持久化 ----------

  private async loadImages(): Promise<void> {
    if (!this.doc) return;
    const paths = Array.from(new Set(
      this.doc.nodes.filter(n => n.source?.snapshot).map(n => n.source!.snapshot!),
    ));
    for (const p of paths) {
      if (this.imageUrls.has(p)) continue;
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      try {
        const buf = await this.app.vault.readBinary(f);
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
        this.imageUrls.set(p, url);
      } catch {
        /* 缩略图缺失时仅显示文字 */
      }
    }
  }

  private markDirty(): void {
    if (!this.doc) return;
    this.doc.meta.modified = Date.now();
    this.dirty = true;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flushSave(), 500);
  }

  private async flushSave(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.doc || !this.file) return;
    this.dirty = false;
    try {
      await writeDoc(this.app, this.file, this.doc);
    } catch (e) {
      this.dirty = true;
      console.error('[mink-suite] imap save failed', e);
      new Notice('思维导图保存失败');
    }
  }
}
