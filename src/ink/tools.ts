import { setIcon } from 'obsidian';
import type { MinkSettings, ToolId } from '../types';
import { STICKERS } from './stickers';
import { TOOL_LABELS } from '../constants';

export interface ToolState {
  tool: ToolId;
  color: string;
  size: number;
  stickerId: string;
}

/** 全局工具状态机：.mink 视图与 PDF overlay 共用 */
export class ToolManager {
  state: ToolState;
  private listeners = new Set<() => void>();

  constructor(private settings: () => MinkSettings) {
    this.state = {
      tool: 'select',
      color: settings().penColor,
      size: settings().penSize,
      stickerId: STICKERS[0]?.id ?? 'star',
    };
  }

  set(patch: Partial<ToolState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  selectTool(tool: ToolId): void {
    const s = this.settings();
    const patch: Partial<ToolState> = { tool };
    switch (tool) {
      case 'pen': patch.color = s.penColor; patch.size = s.penSize; break;
      case 'highlighter': patch.color = s.highlighterColor; patch.size = s.highlighterSize; break;
      case 'rect': case 'ellipse': case 'line': case 'arrow': case 'arrow2':
        patch.color = s.shapeColor; patch.size = s.shapeSize; break;
      case 'text': patch.color = '#1f2937'; patch.size = 18; break;
      default: break;
    }
    this.set(patch);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of Array.from(this.listeners)) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }
}

const TOOL_ICONS: Record<ToolId, string> = {
  select: 'mouse-pointer-2',
  pen: 'pen-line',
  highlighter: 'highlighter',
  eraser: 'eraser',
  rect: 'square',
  ellipse: 'circle',
  line: 'minus',
  arrow: 'arrow-right',
  arrow2: 'arrow-left-right',
  text: 'type',
  sticker: 'smile',
  mask: 'eye-off',
  sticky: 'sticky-note',
  screenshot: 'scissors',
};

const PEN_PALETTE = ['#212529', '#e03131', '#2f9e44', '#1971c2', '#9c36b5', '#f08c00', '#0c8599'];

export interface ToolbarOpts {
  /** PDF 场景显示遮盖工具 */
  mask?: boolean;
  /** 显示截图工具 */
  screenshot?: boolean;
}

/** 浮动工具栏（.mink / PDF 共用） */
export class Toolbar {
  el: HTMLElement;
  private unsub: () => void;
  private destroyed = false;

  constructor(
    parent: HTMLElement,
    private tm: ToolManager,
    private settings: () => MinkSettings,
    private opts: ToolbarOpts = {},
  ) {
    this.el = parent.createEl('div', { cls: 'mink-toolbar' });
    this.unsub = tm.onChange(() => this.render());
    this.render();
  }

  private tools(): ToolId[] {
    const base: ToolId[] = ['select', 'pen', 'highlighter', 'eraser',
      'rect', 'ellipse', 'line', 'arrow', 'arrow2', 'text', 'sticker', 'sticky'];
    if (this.opts.mask) base.push('mask');
    if (this.opts.screenshot) base.push('screenshot');
    return base;
  }

  render(): void {
    if (this.destroyed) return;
    const { state } = this.tm;
    this.el.empty();

    for (const tool of this.tools()) {
      const btn = this.el.createEl('div', {
        cls: `mink-tool-btn${state.tool === tool ? ' is-active' : ''}`,
        attr: { 'data-tool': tool, title: TOOL_LABELS[tool] ?? tool },
      });
      setIcon(btn, TOOL_ICONS[tool] ?? 'circle');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.tm.selectTool(tool);
      });
      if (tool === 'sticker' && state.tool === 'sticker') {
        this.renderStickerPicker(btn);
      }
    }

    // 颜色
    const colors = state.tool === 'highlighter'
      ? this.settings().highlightColors
      : PEN_PALETTE;
    if (!['select', 'eraser', 'sticky', 'screenshot', 'sticker', 'mask'].includes(state.tool)) {
      const row = this.el.createEl('div', { cls: 'mink-color-row' });
      for (const c of colors) {
        const dot = row.createEl('div', {
          cls: `mink-color-dot${state.color === c ? ' is-active' : ''}`,
          attr: { 'data-color': c, title: c },
        });
        dot.style.background = c;
        dot.addEventListener('click', e => {
          e.stopPropagation();
          this.tm.set({ color: c });
        });
      }
    }

    // 粗细/字号
    if (['pen', 'highlighter', 'eraser', 'rect', 'ellipse', 'line', 'arrow', 'arrow2', 'text'].includes(state.tool)) {
      const sizeWrap = this.el.createEl('div', { cls: 'mink-size-wrap', attr: { title: '粗细/大小' } });
      const input = sizeWrap.createEl('input', {
        cls: 'mink-size-input', type: 'range',
      });
      input.type = 'range';
      input.min = '1';
      input.max = state.tool === 'text' ? '48' : '30';
      input.value = String(state.size);
      input.addEventListener('input', () => this.tm.set({ size: parseInt(input.value, 10) }));
      input.addEventListener('pointerdown', e => e.stopPropagation());
    }
  }

  private renderStickerPicker(anchor: HTMLElement): void {
    const picker = anchor.createEl('div', { cls: 'mink-sticker-picker' });
    for (const s of STICKERS) {
      const item = picker.createEl('div', {
        cls: `mink-sticker-item${this.tm.state.stickerId === s.id ? ' is-active' : ''}`,
        attr: { title: s.name },
      });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '22');
      svg.setAttribute('height', '22');
      item.appendChild(svg);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', s.path);
      svg.appendChild(path);
      path.setAttribute('fill', s.color);
      if (s.evenodd) path.setAttribute('fill-rule', 'evenodd');
      item.addEventListener('click', e => {
        e.stopPropagation();
        this.tm.set({ stickerId: s.id });
      });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsub();
    this.el.remove();
  }
}
