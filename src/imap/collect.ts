import { FuzzySuggestModal, Notice, TFile } from 'obsidian';
import type { IMapDoc, IMapNode, IMapSource } from '../types';
import type { MinkSuite } from '../main';
import type { SnapshotCtx } from '../core/modals';
import { TextInputModal } from '../core/modals';
import type { AnnoRow } from '../center/duowei';
import { DATA_SUB } from '../constants';
import { uid } from '../core/ids';
import { defaultDoc, makeNode, readDoc, writeDoc } from './file';

/** 采集项：要追加进脑图的一条内容 */
export interface CollectItem {
  text: string;
  note?: string;
  source?: IMapSource;
}

/** 新建 .imap 文件（重名时直接返回已有文件） */
export async function createImapFile(plugin: MinkSuite, name: string): Promise<TFile | null> {
  const safe = (name.trim() || '未命名脑图').replace(/[\\/:*?"<>|]/g, '_').replace(/\.imap$/i, '');
  const folder = plugin.app.workspace.getActiveFile()?.parent?.path ?? '';
  const path = folder ? `${folder}/${safe}.imap` : `${safe}.imap`;
  const exist = plugin.app.vault.getAbstractFileByPath(path);
  if (exist instanceof TFile) return exist;
  await plugin.app.vault.create(path, JSON.stringify(defaultDoc(safe)));
  const f = plugin.app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f : null;
}

interface NewMapItem { newMap: true }
const NEW_MAP_ITEM: NewMapItem = { newMap: true };
type MapItem = TFile | NewMapItem;

/** 第一步：选择（或新建）目标脑图 */
class ImapPickerModal extends FuzzySuggestModal<MapItem> {
  constructor(private plugin: MinkSuite, private items: CollectItem[]) {
    super(plugin.app);
    this.setPlaceholder('选择要加入的思维导图…');
  }

  getItems(): MapItem[] {
    const files = this.plugin.app.vault.getFiles().filter(f => f.extension === 'imap');
    return [NEW_MAP_ITEM, ...files];
  }

  getItemText(item: MapItem): string {
    return 'newMap' in item ? '＋ 新建思维导图…' : item.path;
  }

  onChooseItem(item: MapItem): void {
    if ('newMap' in item) {
      new TextInputModal(this.plugin.app, '新建思维导图（名称）', `脑图 ${new Date().toLocaleDateString()}`, async name => {
        const file = await createImapFile(this.plugin, name);
        if (file) void this.pickParent(file);
      }).open();
    } else {
      void this.pickParent(item);
    }
  }

  private async pickParent(file: TFile): Promise<void> {
    let doc: IMapDoc;
    try {
      doc = await readDoc(this.plugin.app, file);
    } catch (e) {
      new Notice(`读取脑图失败：${(e as Error).message}`);
      return;
    }
    new ParentPickerModal(this.plugin, file, doc, this.items).open();
  }
}

/** 第二步：选择挂载父节点，然后追加采集项 */
class ParentPickerModal extends FuzzySuggestModal<IMapNode> {
  private depthOf = new Map<string, number>();

  constructor(
    private plugin: MinkSuite,
    private file: TFile,
    private doc: IMapDoc,
    private items: CollectItem[],
  ) {
    super(plugin.app);
    this.setPlaceholder('选择挂载到哪个节点下…');
    const byId = new Map(doc.nodes.map(n => [n.id, n]));
    for (const n of doc.nodes) {
      let k = 0;
      let cur = n;
      const seen = new Set<string>();
      while (cur.parentId !== null && !seen.has(cur.id)) {
        seen.add(cur.id);
        const p = byId.get(cur.parentId);
        if (!p) break;
        cur = p;
        k++;
      }
      this.depthOf.set(n.id, k);
    }
  }

  getItems(): IMapNode[] {
    // 深度优先顺序展示，根在最前
    const byParent = new Map<string, IMapNode[]>();
    for (const n of this.doc.nodes) {
      if (n.parentId === null) continue;
      const arr = byParent.get(n.parentId) ?? [];
      arr.push(n);
      byParent.set(n.parentId, arr);
    }
    const out: IMapNode[] = [];
    const root = this.doc.nodes.find(n => n.parentId === null);
    const walk = (n: IMapNode) => {
      out.push(n);
      for (const c of byParent.get(n.id) ?? []) walk(c);
    };
    if (root) walk(root);
    for (const n of this.doc.nodes) if (!out.includes(n)) out.push(n);
    return out;
  }

  getItemText(n: IMapNode): string {
    const depth = this.depthOf.get(n.id) ?? 0;
    return `${'　'.repeat(depth)}${depth > 0 ? '└ ' : ''}${(n.text || '…').slice(0, 60)}`;
  }

  async onChooseItem(parent: IMapNode): Promise<void> {
    for (const it of this.items) {
      const node = makeNode((it.text || '…').slice(0, 200), parent.id, it.source);
      if (it.note) node.note = it.note.slice(0, 500);
      this.doc.nodes.push(node);
    }
    try {
      await writeDoc(this.plugin.app, this.file, this.doc);
      this.plugin.bus.emit('imap-changed', { file: this.file.path });
      new Notice(`已加入脑图「${this.file.basename}」（${this.items.length} 个节点）`);
    } catch (e) {
      new Notice(`写入脑图失败：${(e as Error).message}`);
    }
  }
}

/** 通用采集入口：选择（或新建）脑图 → 选择父节点 → 追加 */
export function collectToImap(plugin: MinkSuite, items: CollectItem[]): void {
  if (!items.length) return;
  new ImapPickerModal(plugin, items).open();
}

/** 选中文本 → 脑图（PDF 选区菜单 / Markdown 命令） */
export function collectTextToImap(
  plugin: MinkSuite,
  opts: { text: string; file: string; page?: number | string; quote?: string },
): void {
  const text = opts.text.trim();
  if (!text) {
    new Notice('没有可采集的文本');
    return;
  }
  collectToImap(plugin, [{
    text: text.slice(0, 80),
    source: { kind: 'text', file: opts.file, page: opts.page, quote: text.slice(0, 500) },
  }]);
}

/** 截图 → 脑图：先把截图存入数据目录，再采集为带缩略图的节点 */
export async function collectSnapshotToImap(plugin: MinkSuite, blob: Blob, ctx: SnapshotCtx): Promise<void> {
  const rel = `${DATA_SUB.assets}/imap-${uid().slice(0, 10)}.png`;
  const buf = await blob.arrayBuffer();
  const f = await plugin.store.writeBinary(rel, buf);
  if (!f) {
    new Notice('截图保存失败，无法加入脑图');
    return;
  }
  const where = typeof ctx.page === 'number' ? `第 ${ctx.page} 页` : '';
  collectToImap(plugin, [{
    text: ctx.label?.trim() || `截图${where ? ` · ${where}` : ''}`,
    source: {
      kind: 'screenshot',
      file: ctx.file,
      page: ctx.page,
      snapshot: plugin.store.resolve(rel),
    },
  }]);
}

/** 批注中心行 → 采集项 */
export function rowToItem(r: AnnoRow): CollectItem {
  const quote = (r.quote || '').trim();
  const note = (r.note || '').trim();
  const text = quote || note || (r.anno?.kind === 'ink' ? '（手写笔迹）' : '（无文本）');
  const source: IMapSource = r.anno
    ? { kind: 'anno', file: r.file, page: r.page ?? undefined, annoId: r.anno.id, quote: quote.slice(0, 500) }
    : { kind: 'md-anno', file: r.file, quote: quote.slice(0, 500) };
  return { text: text.slice(0, 80), note: note || undefined, source };
}

/** 批注（单条或勾选批量）→ 脑图 */
export function collectRowsToImap(plugin: MinkSuite, rows: AnnoRow[]): void {
  if (!rows.length) return;
  collectToImap(plugin, rows.map(rowToItem));
}
