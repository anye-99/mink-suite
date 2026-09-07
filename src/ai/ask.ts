import { App, Modal, Notice, setIcon } from 'obsidian';
import type { AiMessage, AiConversation } from '../types';
import type { MinkSuite } from '../main';

export interface AskModalOpts {
  title?: string;
  /** 引用的上下文文本（批注/选区） */
  quote?: string;
  /** 附图（dataURL） */
  images?: string[];
  /** 继续既有会话 */
  conversationId?: string;
  /** 会话完成后的回调 */
  onDone?: (conv: AiConversation) => void;
}

/** AI 问答 / 问图 / 追问 弹窗 */
export class AskModal extends Modal {
  private messages: AiMessage[] = [];
  private convId: string | null = null;
  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private busy = false;

  constructor(private plugin: MinkSuite, private opts: AskModalOpts) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.opts.title ?? 'AI 问答');
    contentEl.addClass('mink-ask-modal');

    if (this.opts.quote) {
      const q = contentEl.createEl('div', { cls: 'mink-ask-quote' });
      q.setText(this.opts.quote.length > 500 ? this.opts.quote.slice(0, 500) + '…' : this.opts.quote);
    }
    if (this.opts.images?.length) {
      const row = contentEl.createEl('div', { cls: 'mink-ask-images' });
      for (const url of this.opts.images.slice(0, 3)) {
        row.createEl('img', { attr: { src: url } });
      }
    }

    this.listEl = contentEl.createEl('div', { cls: 'mink-ask-list' });

    const bar = contentEl.createEl('div', { cls: 'mink-ask-bar' });
    this.inputEl = bar.createEl('textarea', {
      cls: 'mink-ask-input', attr: { placeholder: this.plugin.settings.aiBaseUrl ? '输入问题，Enter 发送…' : '请先在设置中配置 AI 接口…', rows: '2' },
    });
    const sendBtn = bar.createEl('button', { cls: 'mink-ask-send', attr: { title: '发送' } });
    setIcon(sendBtn, 'send');
    sendBtn.addEventListener('click', () => void this.send());
    this.inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });

    // 恢复既有会话
    if (this.opts.conversationId) {
      const conv = await this.plugin.aiHistory.get(this.opts.conversationId);
      if (conv) {
        this.convId = conv.id;
        this.messages = [...conv.messages];
        for (const m of this.messages) this.renderMsg(m);
        this.listEl.scrollTop = this.listEl.scrollHeight;
      }
    }
  }

  private renderMsg(m: AiMessage): void {
    const item = this.listEl.createEl('div', { cls: `mink-ask-msg is-${m.role}` });
    item.setText(m.content || '(图片)');
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) return;
    if (!this.plugin.ai.configured()) {
      new Notice('AI 未配置：设置 → Mink 妙笔批注套件 → AI 接口');
      return;
    }
    this.busy = true;
    this.inputEl.value = '';
    const userMsg: AiMessage = { role: 'user', content: text, images: this.opts.images };
    this.messages.push(userMsg);
    this.renderMsg(userMsg);

    const loading = this.listEl.createEl('div', { cls: 'mink-ask-msg is-assistant is-loading', text: '思考中…' });
    try {
      let answer: string;
      if (this.opts.images?.length) {
        answer = await this.plugin.ai.askImage(text, this.opts.images);
      } else {
        answer = await this.plugin.ai.chat(this.messages);
      }
      this.opts.images = undefined; // 只随第一条消息带图
      const asst: AiMessage = { role: 'assistant', content: answer };
      this.messages.push(asst);
      loading.remove();
      this.renderMsg(asst);
      await this.persist(text, answer);
    } catch (e) {
      loading.setText(`出错：${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async persist(userText: string, answer: string): Promise<void> {
    try {
      if (!this.convId) {
        const conv = await this.plugin.aiHistory.create('新会话');
        this.convId = conv.id;
      }
      await this.plugin.aiHistory.append(this.convId, { role: 'user', content: userText });
      await this.plugin.aiHistory.append(this.convId, { role: 'assistant', content: answer });
      const conv = await this.plugin.aiHistory.get(this.convId);
      if (conv) this.opts.onDone?.(conv);
    } catch (e) {
      console.warn('[mink-suite] save ai history failed', e);
    }
  }
}
