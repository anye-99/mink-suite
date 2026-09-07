import { App, TFile, TFolder } from 'obsidian';
import type { AnnoObject, AnnoSidecar, MdAnnotation, MdSidecar, PdfBookmark } from '../types';
import type { StoreManager } from './store';
import type { EventBus } from './eventbus';
import { sha1hex } from './ids';
import { DATA_SUB } from '../constants';

/** PDF / .mink 批注侧车管理：内存缓存 + 防抖落盘 + 冲突备份 */
export class AnnoStore {
  private cache = new Map<string, AnnoSidecar>();
  private saveTimers = new Map<string, number>();
  private lastSaved = new Map<string, number>();

  constructor(private app: App, private store: StoreManager, private bus: EventBus) {}

  private async keyFor(file: string): Promise<string> {
    return (await sha1hex(file)).slice(0, 12);
  }

  private rel(key: string): string {
    return `${DATA_SUB.annos}/${key}.json`;
  }

  async load(file: string): Promise<AnnoSidecar> {
    const key = await this.keyFor(file);
    let sc = this.cache.get(key);
    if (!sc) {
      const data = await this.store.readJson<AnnoSidecar>(this.rel(key));
      sc = data ?? { version: 1, file, objects: [], bookmarks: [] };
      if (data && data.file !== file) sc.file = file;
      this.cache.set(key, sc);
      this.bus.emit('annos-loaded', { file });
    }
    return sc;
  }

  /** 仅在 load 之后可用（视图打开时会先 load） */
  objectsFor(file: string): AnnoObject[] {
    for (const sc of this.cache.values()) {
      if (sc.file === file) return sc.objects;
    }
    return [];
  }

  sidecarFor(file: string): AnnoSidecar | null {
    for (const sc of this.cache.values()) if (sc.file === file) return sc;
    return null;
  }

  allLoaded(): AnnoSidecar[] {
    return Array.from(this.cache.values());
  }

  /** 加载磁盘上全部侧车（批注中心用，含缓存合并） */
  async loadAll(): Promise<AnnoSidecar[]> {
    const dir = this.store.resolve(DATA_SUB.annos);
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (folder instanceof TFolder) {
      for (const f of folder.children) {
        if (f instanceof TFile && f.name.endsWith('.json')) {
          const key = f.name.replace(/\.json$/, '');
          if (!this.cache.has(key)) {
            const data = await this.store.readJson<AnnoSidecar>(`${DATA_SUB.annos}/${f.name}`);
            if (data) this.cache.set(key, data);
          }
        }
      }
    }
    return this.allLoaded();
  }

  async add(file: string, anno: AnnoObject): Promise<void> {
    const sc = await this.load(file);
    sc.objects.push(anno);
    this.scheduleSave(file);
    this.bus.emit('anno-changed', { file, kind: 'add', anno });
  }

  async update(file: string, anno: AnnoObject): Promise<void> {
    const sc = await this.load(file);
    const i = sc.objects.findIndex(o => o.id === anno.id);
    if (i >= 0) sc.objects[i] = anno;
    else sc.objects.push(anno);
    this.scheduleSave(file);
    this.bus.emit('anno-changed', { file, kind: 'update', anno });
  }

  async remove(file: string, annoId: string): Promise<void> {
    const sc = await this.load(file);
    const anno = sc.objects.find(o => o.id === annoId);
    sc.objects = sc.objects.filter(o => o.id !== annoId);
    this.scheduleSave(file);
    if (anno) this.bus.emit('anno-changed', { file, kind: 'remove', anno });
  }

  async getBookmarks(file: string): Promise<PdfBookmark[]> {
    const sc = await this.load(file);
    if (!sc.bookmarks) sc.bookmarks = [];
    return sc.bookmarks;
  }

  async addBookmark(file: string, bm: PdfBookmark): Promise<void> {
    const list = await this.getBookmarks(file);
    list.push(bm);
    this.scheduleSave(file);
  }

  async removeBookmark(file: string, page: number): Promise<void> {
    const list = await this.getBookmarks(file);
    const i = list.findIndex(b => b.page === page);
    if (i >= 0) list.splice(i, 1);
    this.scheduleSave(file);
  }

  /** 文件重命名：迁移侧车并更新对象 file 字段 */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const oldKey = await this.keyFor(oldPath);
    const sc = this.cache.get(oldKey);
    if (!sc) return;
    await this.flushKey(oldKey);
    const newKey = await this.keyFor(newPath);
    sc.file = newPath;
    for (const o of sc.objects) o.file = newPath;
    this.cache.delete(oldKey);
    this.cache.set(newKey, sc);
    await this.store.writeJson(this.rel(newKey), sc);
    const oldFile = this.app.vault.getAbstractFileByPath(this.store.resolve(this.rel(oldKey)));
    if (oldFile instanceof TFile) {
      try { await this.app.vault.delete(oldFile); } catch { /* ignore */ }
    }
  }

  async deleteFile(file: string): Promise<void> {
    const key = await this.keyFor(file);
    if (this.cache.has(key)) {
      const sc = this.cache.get(key)!;
      for (const o of sc.objects) this.bus.emit('anno-changed', { file, kind: 'remove', anno: o });
      this.cache.delete(key);
    }
    const f = this.app.vault.getAbstractFileByPath(this.store.resolve(this.rel(key)));
    if (f instanceof TFile) {
      try { await this.app.vault.trash(f, false); } catch { /* ignore */ }
    }
  }

  private scheduleSave(file: string): void {
    void (async () => {
      const key = await this.keyFor(file);
      const prev = this.saveTimers.get(key);
      if (prev) window.clearTimeout(prev);
      const t = window.setTimeout(() => { void this.flushKey(key); }, 600);
      this.saveTimers.set(key, t);
    })();
  }

  async flushKey(key: string): Promise<void> {
    const sc = this.cache.get(key);
    if (!sc) return;
    const rel = this.rel(key);
    try {
      const f = this.app.vault.getAbstractFileByPath(this.store.resolve(rel));
      if (f instanceof TFile) {
        const last = this.lastSaved.get(key) ?? 0;
        const mtime = f.stat?.mtime ?? 0;
        if (mtime > last && last > 0) {
          // 磁盘版本比我们上次写入新 → 可能被外部修改，先备份
          await this.store.backup(rel);
        }
      }
      await this.store.writeJson(rel, sc);
      const nf = this.app.vault.getAbstractFileByPath(this.store.resolve(rel));
      this.lastSaved.set(key, nf instanceof TFile ? (nf.stat?.mtime ?? Date.now()) : Date.now());
    } catch (e) {
      console.error('[mink-suite] flushKey failed', e);
    }
    const t = this.saveTimers.get(key);
    if (t) { window.clearTimeout(t); this.saveTimers.delete(key); }
  }

  async flush(): Promise<void> {
    for (const key of Array.from(this.cache.keys())) await this.flushKey(key);
  }
}

/** Markdown 原文批注侧车（.mink-suite/md/<key>.json） */
export class MdAnnoStore {
  private cache = new Map<string, MdSidecar>();
  private saveTimers = new Map<string, number>();

  constructor(private app: App, private store: StoreManager, private bus: EventBus) {}

  private async keyFor(file: string): Promise<string> {
    return (await sha1hex(file)).slice(0, 12);
  }

  private rel(key: string): string {
    return `${DATA_SUB.md}/${key}.json`;
  }

  async load(file: string): Promise<MdSidecar> {
    const key = await this.keyFor(file);
    let sc = this.cache.get(key);
    if (!sc) {
      const data = await this.store.readJson<MdSidecar>(this.rel(key));
      sc = data ?? { version: 1, file, annotations: [] };
      this.cache.set(key, sc);
    }
    return sc;
  }

  list(file: string): MdAnnotation[] {
    for (const sc of this.cache.values()) if (sc.file === file) return sc.annotations;
    return [];
  }

  async add(file: string, anno: MdAnnotation): Promise<void> {
    const sc = await this.load(file);
    sc.annotations.push(anno);
    this.save(file);
    this.bus.emit('md-anno-changed', { file });
  }

  async update(file: string, anno: MdAnnotation): Promise<void> {
    const sc = await this.load(file);
    const i = sc.annotations.findIndex(a => a.id === anno.id);
    if (i >= 0) sc.annotations[i] = anno;
    this.save(file);
    this.bus.emit('md-anno-changed', { file });
  }

  async remove(file: string, id: string): Promise<void> {
    const sc = await this.load(file);
    sc.annotations = sc.annotations.filter(a => a.id !== id);
    this.save(file);
    this.bus.emit('md-anno-changed', { file });
  }

  allLoaded(): MdSidecar[] {
    return Array.from(this.cache.values());
  }

  /** 文件重命名：迁移侧车并更新 file 字段 */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    const oldKey = await this.keyFor(oldPath);
    const sc = this.cache.get(oldKey);
    if (sc) {
      const newKey = await this.keyFor(newPath);
      sc.file = newPath;
      for (const a of sc.annotations) a.file = newPath;
      this.cache.delete(oldKey);
      this.cache.set(newKey, sc);
      await this.store.writeJson(`${DATA_SUB.md}/${newKey}.json`, sc);
      const oldFile = this.app.vault.getAbstractFileByPath(this.store.resolve(`${DATA_SUB.md}/${oldKey}.json`));
      if (oldFile instanceof TFile) {
        try { await this.app.vault.delete(oldFile); } catch { /* ignore */ }
      }
    }
  }

  async deleteFile(file: string): Promise<void> {
    const key = await this.keyFor(file);
    if (this.cache.has(key)) this.cache.delete(key);
    const f = this.app.vault.getAbstractFileByPath(this.store.resolve(`${DATA_SUB.md}/${key}.json`));
    if (f instanceof TFile) {
      try { await this.app.vault.trash(f, false); } catch { /* ignore */ }
    }
  }

  /** 加载磁盘上全部 Markdown 批注侧车 */
  async loadAll(): Promise<MdSidecar[]> {
    const dir = this.store.resolve(DATA_SUB.md);
    const folder = this.app.vault.getAbstractFileByPath(dir);
    if (folder instanceof TFolder) {
      for (const f of folder.children) {
        if (f instanceof TFile && f.name.endsWith('.json')) {
          const key = f.name.replace(/\.json$/, '');
          if (!this.cache.has(key)) {
            const data = await this.store.readJson<MdSidecar>(`${DATA_SUB.md}/${f.name}`);
            if (data) this.cache.set(key, data);
          }
        }
      }
    }
    return this.allLoaded();
  }

  private save(file: string): void {
    void (async () => {
      const key = await this.keyFor(file);
      const prev = this.saveTimers.get(key);
      if (prev) window.clearTimeout(prev);
      const t = window.setTimeout(() => {
        void (async () => {
          const sc = this.cache.get(key);
          if (sc) await this.store.writeJson(this.rel(key), sc);
        })();
      }, 600);
      this.saveTimers.set(key, t);
    })();
  }

  async flush(): Promise<void> {
    for (const [key, sc] of Array.from(this.cache.entries())) {
      await this.store.writeJson(this.rel(key), sc);
    }
  }
}
