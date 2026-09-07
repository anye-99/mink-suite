import { App, TFile } from 'obsidian';
import type { IMapDoc, IMapNode, IMapSource } from '../types';
import { uid } from '../core/ids';

/** .imap 批注思维导图：文件读写与树操作 */

export function makeNode(text: string, parentId: string | null = null, source?: IMapSource): IMapNode {
  const now = Date.now();
  return { id: uid(), parentId, text, source, created: now, modified: now };
}

export function defaultDoc(title: string): IMapDoc {
  const now = Date.now();
  return {
    version: 1,
    meta: { title, created: now, modified: now },
    nodes: [makeNode(title || '中心主题', null)],
  };
}

/** parentId → 子节点列表 */
export function childrenMap(doc: IMapDoc): Map<string, IMapNode[]> {
  const m = new Map<string, IMapNode[]>();
  for (const n of doc.nodes) {
    if (n.parentId === null) continue; // 根不挂在任何父下
    let arr = m.get(n.parentId);
    if (!arr) {
      arr = [];
      m.set(n.parentId, arr);
    }
    arr.push(n);
  }
  return m;
}

export async function readDoc(app: App, file: TFile): Promise<IMapDoc> {
  const doc = JSON.parse(await app.vault.read(file)) as IMapDoc;
  if (!Array.isArray(doc.nodes)) doc.nodes = [];
  let root = doc.nodes.find(n => n.parentId === null);
  if (!root) {
    root = makeNode(file.basename, null);
    doc.nodes.unshift(root);
  }
  // 修复环 / 孤儿节点：从根出发不可达的一律挂回根下（数据不丢失）
  const byParent = childrenMap(doc);
  const seen = new Set<string>([root.id]);
  const queue = [root.id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of byParent.get(cur) ?? []) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        queue.push(c.id);
      }
    }
  }
  const byId = new Set(doc.nodes.map(n => n.id));
  for (const n of doc.nodes) {
    if (n.id === root.id) continue;
    const broken = !seen.has(n.id) || (n.parentId !== null && !byId.has(n.parentId));
    if (broken) n.parentId = root.id;
  }
  return doc;
}

export async function writeDoc(app: App, file: TFile, doc: IMapDoc): Promise<void> {
  doc.meta.modified = Date.now();
  await app.vault.modify(file, JSON.stringify(doc));
}

/** ancestorId 是否为 nodeId 的祖先（含环保护） */
export function isDescendant(doc: IMapDoc, ancestorId: string, nodeId: string): boolean {
  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  let cur = byId.get(nodeId);
  const visited = new Set<string>();
  while (cur && cur.parentId !== null && !visited.has(cur.id)) {
    visited.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

/** 删除节点及其整棵子树，返回被删除的节点 */
export function removeSubtree(doc: IMapDoc, nodeId: string): IMapNode[] {
  const byParent = childrenMap(doc);
  const doom = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    for (const c of byParent.get(queue.shift()!) ?? []) {
      if (!doom.has(c.id)) {
        doom.add(c.id);
        queue.push(c.id);
      }
    }
  }
  const removed = doc.nodes.filter(n => doom.has(n.id));
  doc.nodes = doc.nodes.filter(n => !doom.has(n.id));
  return removed;
}

/** 源文件重命名：同步所有 .imap 中的 source.file 引用（删除源文件不动脑图，仅回链失效） */
export async function migrateSources(app: App, oldPath: string, newPath: string): Promise<void> {
  for (const f of app.vault.getFiles()) {
    if (f.extension !== 'imap') continue;
    try {
      const doc = await readDoc(app, f);
      let changed = false;
      for (const n of doc.nodes) {
        if (n.source?.file === oldPath) {
          n.source.file = newPath;
          changed = true;
        }
      }
      if (changed) await writeDoc(app, f, doc);
    } catch {
      /* 跳过损坏文件 */
    }
  }
}
