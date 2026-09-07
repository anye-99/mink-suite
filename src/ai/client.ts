import { requestUrl } from 'obsidian';
import type { AiMessage } from '../types';

export interface AiRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
}

/** OpenAI 兼容 chat/completions 客户端（DeepSeek / OpenRouter / 硅基流动 / Ollama 均可） */
export class AiClient {
  constructor(private cfg: () => AiRuntimeConfig) {}

  configured(): boolean {
    const c = this.cfg();
    return !!(c.baseUrl && c.model);
  }

  private endpoint(): string {
    const base = this.cfg().baseUrl.trim().replace(/\/+$/, '');
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }

  async chat(messages: AiMessage[], opts?: { model?: string; maxTokens?: number }): Promise<string> {
    const c = this.cfg();
    if (!this.configured()) throw new Error('AI 未配置：请在设置中填写 Base URL 与模型');
    const model = opts?.model || c.model;
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => this.toApiMessage(m)),
    };
    if (opts?.maxTokens) body.max_tokens = opts.maxTokens;

    const res = await requestUrl({
      url: this.endpoint(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (res.status >= 400) {
      throw new Error(`AI 请求失败 (${res.status})：${(res.text || '').slice(0, 300)}`);
    }
    const choice = res.json?.choices?.[0]?.message;
    if (!choice) throw new Error('AI 返回格式异常');
    return (choice.content ?? '') as string;
  }

  /** 视觉模型：把图片（dataURL）连同提问发给 visionModel */
  async askImage(prompt: string, imageDataUrls: string[]): Promise<string> {
    const c = this.cfg();
    const model = c.visionModel || c.model;
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
    for (const url of imageDataUrls) {
      content.push({ type: 'image_url', image_url: { url } });
    }
    if (!this.configured()) throw new Error('AI 未配置：请在设置中填写 Base URL 与模型');
    const res = await requestUrl({
      url: this.endpoint(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(`AI 问图失败 (${res.status})：${(res.text || '').slice(0, 300)}`);
    }
    return (res.json?.choices?.[0]?.message?.content ?? '') as string;
  }

  private toApiMessage(m: AiMessage): Record<string, unknown> {
    if (m.images?.length && this.cfg().visionModel) {
      // 带图消息仅在 vision 模型下转换为多模态格式
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: m.content }];
      for (const url of m.images) content.push({ type: 'image_url', image_url: { url } });
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  }
}
