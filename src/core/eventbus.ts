import type { AnnoObject } from '../types';

export interface MinkEvents {
  /** 批注对象增删改（PDF / .mink） */
  'anno-changed': { file: string; kind: 'add' | 'update' | 'remove'; anno: AnnoObject };
  /** 侧车加载完成（视图可据此重绘） */
  'annos-loaded': { file: string };
  /** 请求跳转并闪烁定位某批注 */
  'reveal-anno': { file: string; annoId: string };
  /** Markdown 批注变化 */
  'md-anno-changed': { file: string };
  /** 卡片集合变化 */
  'cards-changed': void;
  /** AI 会话历史变化 */
  'ai-history-changed': void;
  /** .imap 思维导图文件被外部更新（采集入口写入后通知打开中的视图） */
  'imap-changed': { file: string };
}

type Handler<K extends keyof MinkEvents> = (payload: MinkEvents[K]) => void;

/** 极简类型化事件总线 */
export class EventBus {
  private map = new Map<string, Set<(p: unknown) => void>>();

  on<K extends keyof MinkEvents>(name: K, fn: Handler<K>): () => void {
    let set = this.map.get(name as string);
    if (!set) {
      set = new Set();
      this.map.set(name as string, set);
    }
    set.add(fn as (p: unknown) => void);
    return () => this.off(name, fn);
  }

  off<K extends keyof MinkEvents>(name: K, fn: Handler<K>): void {
    this.map.get(name as string)?.delete(fn as (p: unknown) => void);
  }

  emit<K extends keyof MinkEvents>(name: K, payload: MinkEvents[K]): void {
    const set = this.map.get(name as string);
    if (set) for (const fn of Array.from(set)) {
      try { fn(payload); } catch (e) { console.error('[mink-suite] event handler error', e); }
    }
  }
}
