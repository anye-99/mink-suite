import { App, Notice } from 'obsidian';
import type { Card, CardStoreData } from '../types';
import type { StoreManager } from '../core/store';
import type { EventBus } from '../core/eventbus';
import { CARDS_FILE, DATA_SUB } from '../constants';
import { uid } from '../core/ids';

/** 卡片收藏夹：文本 / 截图 / OCR 结果 / 重点批注 */
export class CardStore {
  private data: CardStoreData | null = null;

  constructor(private app: App, private store: StoreManager, private bus: EventBus) {}

  private async load(): Promise<CardStoreData> {
    if (!this.data) {
      this.data = (await this.store.readJson<CardStoreData>(`${DATA_SUB.cards}/${CARDS_FILE}`))
        ?? { version: 1, cards: [] };
    }
    return this.data;
  }

  async list(): Promise<Card[]> {
    const d = await this.load();
    return [...d.cards].sort((a, b) => b.created - a.created);
  }

  async forFile(file: string): Promise<Card[]> {
    const all = await this.list();
    return all.filter(c => c.file === file);
  }

  async add(card: Omit<Card, 'id' | 'created'>): Promise<Card> {
    const d = await this.load();
    const c: Card = { ...card, id: uid(), created: Date.now() };
    d.cards.push(c);
    await this.save();
    new Notice('已收藏为学习卡片');
    return c;
  }

  async update(card: Card): Promise<void> {
    const d = await this.load();
    const i = d.cards.findIndex(c => c.id === card.id);
    if (i >= 0) d.cards[i] = card;
    await this.save();
  }

  async remove(id: string): Promise<void> {
    const d = await this.load();
    d.cards = d.cards.filter(c => c.id !== id);
    await this.save();
  }

  /** 文件重命名：更新卡片中的 file 引用 */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const d = await this.load();
    let changed = false;
    for (const c of d.cards) {
      if (c.file === oldPath) { c.file = newPath; changed = true; }
    }
    if (changed) await this.save();
  }

  async deleteFile(file: string): Promise<void> {
    const d = await this.load();
    const before = d.cards.length;
    d.cards = d.cards.filter(c => c.file !== file);
    if (d.cards.length !== before) await this.save();
  }

  /** 保存卡片截图资源，返回 vault 相对路径 */
  async saveSnapshotAsset(blob: Blob): Promise<string | null> {
    await this.store.ensureDir(DATA_SUB.cardsAssets);
    const name = `card-${uid().slice(0, 10)}.png`;
    const rel = `${DATA_SUB.cardsAssets}/${name}`;
    const buf = await blob.arrayBuffer();
    const f = await this.app.vault.createBinary(rel, buf).catch(e => {
      console.error('[mink-suite] saveSnapshotAsset', e);
      return null;
    });
    return f ? rel : null;
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    await this.store.writeJson(`${DATA_SUB.cards}/${CARDS_FILE}`, this.data);
    this.bus.emit('cards-changed', undefined);
  }
}
