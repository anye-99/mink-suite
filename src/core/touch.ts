import type { MinkSettings } from '../types';

/**
 * 触控输入过滤（面向 iPad / 触控屏优化）：
 * - pen 始终可书写，并携带压感
 * - mouse 可书写
 * - touch 仅在「允许手指书写」开启时可书写，否则用于滚动/缩放（防掌误触）
 */
export class InputFilter {
  constructor(private getSettings: () => MinkSettings) {}

  isDrawingPointer(e: PointerEvent): boolean {
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') return true;
    if (e.pointerType === 'touch') return this.getSettings().drawOnTouch;
    return false;
  }

  /** 书写过程中收到 touch 事件 → 掌误触，应忽略 */
  isPalm(e: PointerEvent, penActive: boolean): boolean {
    return e.pointerType === 'touch' && penActive && this.getSettings().palmRejection;
  }

  /** 归一化压感：pen 用 e.pressure；mouse/touch 无压感时给固定值 */
  pressureOf(e: PointerEvent): number {
    if (e.pointerType === 'pen' && e.pressure > 0) return Math.min(1, e.pressure);
    return 0.5;
  }
}
