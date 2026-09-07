import { App, TFile, normalizePath } from 'obsidian';

/** .mink-suite 数据目录管理：JSON / 二进制读写 */
export class StoreManager {
  constructor(private app: App, public dataDir: string) {}

  resolve(rel: string): string {
    return normalizePath(rel.startsWith(this.dataDir) ? rel : `${this.dataDir}/${rel}`);
  }

  async ensureDir(rel = ''): Promise<void> {
    const p = rel ? this.resolve(rel) : this.dataDir;
    const parts = p.split('/');
    let cur = '';
    for (const part of parts) {
      if (!part || part === '.') continue;
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch { /* 并发创建冲突，忽略 */ }
      }
    }
  }

  async exists(rel: string): Promise<boolean> {
    return !!this.app.vault.getAbstractFileByPath(this.resolve(rel));
  }

  async readJson<T>(rel: string): Promise<T | null> {
    try {
      const f = this.app.vault.getAbstractFileByPath(this.resolve(rel));
      if (f instanceof TFile) {
        const txt = await this.app.vault.read(f);
        return JSON.parse(txt) as T;
      }
    } catch (e) {
      console.warn('[mink-suite] readJson failed:', rel, e);
    }
    return null;
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    await this.ensureDir(rel.split('/').slice(0, -1).join('/'));
    const path = this.resolve(rel);
    const body = JSON.stringify(data, null, 2);
    const f = this.app.vault.getAbstractFileByPath(path);
    try {
      if (f instanceof TFile) await this.app.vault.modify(f, body);
      else await this.app.vault.create(path, body);
    } catch (e) {
      console.error('[mink-suite] writeJson failed:', path, e);
      throw e;
    }
  }

  async readBinary(rel: string): Promise<ArrayBuffer | null> {
    const f = this.app.vault.getAbstractFileByPath(this.resolve(rel));
    if (f instanceof TFile) {
      try { return await this.app.vault.readBinary(f); } catch (e) { console.warn(e); }
    }
    return null;
  }

  async writeBinary(rel: string, data: ArrayBuffer): Promise<TFile | null> {
    await this.ensureDir(rel.split('/').slice(0, -1).join('/'));
    const path = this.resolve(rel);
    const f = this.app.vault.getAbstractFileByPath(path);
    try {
      if (f instanceof TFile) { await this.app.vault.modifyBinary(f, data); return f; }
      return await this.app.vault.createBinary(path, data);
    } catch (e) {
      console.error('[mink-suite] writeBinary failed:', path, e);
      return null;
    }
  }

  /** 写入前把已存在文件备份为 .bak（冲突保护） */
  async backup(rel: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(this.resolve(rel));
    if (f instanceof TFile) {
      const bak = this.resolve(rel) + '.bak';
      const bf = this.app.vault.getAbstractFileByPath(bak);
      try {
        const data = await this.app.vault.readBinary(f);
        if (bf instanceof TFile) await this.app.vault.modifyBinary(bf, data);
        else await this.app.vault.createBinary(bak, data);
      } catch (e) { console.warn('[mink-suite] backup failed', e); }
    }
  }
}
