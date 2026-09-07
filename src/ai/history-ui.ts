import { Modal, Notice, setIcon } from 'obsidian';
import type { AiConversation } from '../types';
import type { MinkSuite } from '../main';
import { AskModal } from './ask';
import { TextInputModal } from '../core/modals';

/** AI 会话历史：搜索 / 置顶 / 重命名 / 继续会话 / 删除 */
export class AiHistoryModal extends Modal {
  private query = '';
  private convs: AiConversation[] = [];

  constructor(private plugin: MinkSuite) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('AI 会话历史');
    this.contentEl.addClass('mink-ai-history');
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.convs = await this.plugin.aiHistory.search(this.query);
    this.renderView();
  }

  private renderView(): void {
    const { contentEl } = this;
    contentEl.empty();

    const bar = contentEl.createEl('div', { cls: 'mink-center-bar' });
    const search = bar.createEl('input', {
      cls: 'mink-nav-input mink-card-search', type: 'text',
      attr: { placeholder: '搜索会话标题或内容…' },
    });
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      void this.reload();
    });
    const newBtn = bar.createEl('button', { cls: 'mink-btn mink-btn-primary', text: '新会话' });
    newBtn.addEventListener('click', () => {
      new AskModal(this.plugin, { title: 'AI 问答' }).open();
      this.close();
    });

    const list = contentEl.createEl('div', { cls: 'mink-center-list' });
    if (!this.convs.length) {
      list.createEl('div', { cls: 'mink-nav-empty', text: '暂无历史会话' });
      return;
    }
    for (const c of this.convs) this.renderConv(list, c);
  }

  private renderConv(list: HTMLElement, c: AiConversation): void {
    const item = list.createEl('div', { cls: `mink-ai-conv${c.pinned ? ' is-pinned' : ''}` });
    const body = item.createEl('div', { cls: 'mink-ai-conv-body' });
    const head = body.createEl('div', { cls: 'mink-ai-conv-head' });
    if (c.pinned) {
      const pin = head.createEl('span', { cls: 'mink-ai-pin', attr: { title: '已置顶' } });
      setIcon(pin, 'pin');
    }
    head.createEl('span', { cls: 'mink-ai-conv-title', text: c.title || '(无标题)' });
    const meta = body.createEl('div', { cls: 'mink-center-meta' });
    meta.setText(`${c.messages.length} 条消息 · ${new Date(c.updated).toLocaleString()}`);
    const last = c.messages[c.messages.length - 1];
    if (last) {
      body.createEl('div', {
        cls: 'mink-ai-conv-preview',
        text: `${last.role === 'user' ? '我：' : 'AI：'}${last.content.slice(0, 90)}`,
      });
    }

    const ops = item.createEl('div', { cls: 'mink-center-ops' });
    const mkOp = (icon: string, title: string, fn: () => void) => {
      const b = ops.createEl('div', { cls: 'mink-op', attr: { title } });
      setIcon(b, icon);
      b.addEventListener('click', e => { e.stopPropagation(); void fn(); });
    };
    mkOp('play', '继续此会话', () => {
      new AskModal(this.plugin, {
        title: c.title || '继续会话',
        conversationId: c.id,
      }).open();
      this.close();
    });
    mkOp('pin', c.pinned ? '取消置顶' : '置顶', async () => {
      await this.plugin.aiHistory.togglePin(c.id);
      await this.reload();
    });
    mkOp('pencil', '重命名', () => {
      new TextInputModal(this.app, '重命名会话', c.title, async v => {
        await this.plugin.aiHistory.rename(c.id, v);
        await this.reload();
      }).open();
    });
    mkOp('trash-2', '删除会话', async () => {
      await this.plugin.aiHistory.remove(c.id);
      new Notice('已删除会话');
      await this.reload();
    });
  }
}
