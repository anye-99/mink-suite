import type { AiConversation, AiHistoryData } from '../types';
import type { StoreManager } from '../core/store';
import type { EventBus } from '../core/eventbus';
import { AI_HISTORY_FILE, DATA_SUB } from '../constants';
import { uid } from '../core/ids';

/** AI 会话历史：基础顺序存取（搜索/置顶/重命名留待 Phase 2） */
export class AiHistory {
  private data: AiHistoryData | null = null;

  constructor(private store: StoreManager, private bus: EventBus) {}

  private async load(): Promise<AiHistoryData> {
    if (!this.data) {
      this.data = (await this.store.readJson<AiHistoryData>(`${DATA_SUB.ai}/${AI_HISTORY_FILE}`))
        ?? { version: 1, conversations: [] };
    }
    return this.data;
  }

  async list(): Promise<AiConversation[]> {
    const d = await this.load();
    return [...d.conversations].sort((a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated,
    );
  }

  /** 按关键词搜索会话（标题 + 消息内容） */
  async search(query: string): Promise<AiConversation[]> {
    const all = await this.list();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(c =>
      c.title.toLowerCase().includes(q)
      || c.messages.some(m => m.content.toLowerCase().includes(q)),
    );
  }

  async get(id: string): Promise<AiConversation | null> {
    const d = await this.load();
    return d.conversations.find(c => c.id === id) ?? null;
  }

  async create(title: string): Promise<AiConversation> {
    const d = await this.load();
    const conv: AiConversation = {
      id: uid(), title, messages: [], created: Date.now(), updated: Date.now(),
    };
    d.conversations.push(conv);
    await this.save();
    return conv;
  }

  async append(id: string, message: { role: 'user' | 'assistant'; content: string; images?: string[] }): Promise<void> {
    const d = await this.load();
    const conv = d.conversations.find(c => c.id === id);
    if (!conv) return;
    conv.messages.push(message);
    conv.updated = Date.now();
    if (conv.title === '新会话' && message.role === 'user') {
      conv.title = message.content.slice(0, 24);
    }
    await this.save();
  }

  async remove(id: string): Promise<void> {
    const d = await this.load();
    d.conversations = d.conversations.filter(c => c.id !== id);
    await this.save();
  }

  async rename(id: string, title: string): Promise<void> {
    const d = await this.load();
    const conv = d.conversations.find(c => c.id === id);
    if (conv) {
      conv.title = title.trim() || conv.title;
      await this.save();
    }
  }

  async togglePin(id: string): Promise<void> {
    const d = await this.load();
    const conv = d.conversations.find(c => c.id === id);
    if (conv) {
      conv.pinned = !conv.pinned;
      await this.save();
    }
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    await this.store.writeJson(`${DATA_SUB.ai}/${AI_HISTORY_FILE}`, this.data);
    this.bus.emit('ai-history-changed', undefined);
  }
}
