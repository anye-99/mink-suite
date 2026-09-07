import { App, TFile } from 'obsidian';
import type { AnnoObject, MinkDoc, PaperTemplate } from '../types';
import { uid } from '../core/ids';

export const MINK_PAGE_W = 1000;
export const MINK_PAGE_H = 1414; // A4 比例

export function defaultDoc(paper: PaperTemplate): MinkDoc {
  return {
    version: 1,
    meta: { created: Date.now(), modified: Date.now() },
    pages: [{ id: uid(), template: paper, width: MINK_PAGE_W, height: MINK_PAGE_H }],
    objects: [],
  };
}

export function newPage(paper: PaperTemplate): MinkDoc['pages'][number] {
  return { id: uid(), template: paper, width: MINK_PAGE_W, height: MINK_PAGE_H };
}

export async function readDoc(app: App, file: TFile): Promise<MinkDoc> {
  const txt = await app.vault.read(file);
  const doc = JSON.parse(txt) as MinkDoc;
  if (!Array.isArray(doc.pages) || doc.pages.length === 0) {
    doc.pages = [{ id: uid(), template: 'lined', width: MINK_PAGE_W, height: MINK_PAGE_H }];
  }
  if (!Array.isArray(doc.objects)) doc.objects = [];
  for (const o of doc.objects) o.file = file.path;
  return doc;
}

export async function writeDoc(app: App, file: TFile, doc: MinkDoc): Promise<void> {
  doc.meta.modified = Date.now();
  await app.vault.modify(file, JSON.stringify(doc));
}

/** 预加载图片对象（vault 路径 → HTMLImageElement） */
export async function preloadImages(
  app: App,
  objects: AnnoObject[],
): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>();
  const paths = Array.from(new Set(objects.filter(o => o.src).map(o => o.src!)));
  await Promise.all(paths.map(async path => {
    try {
      const f = app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        const buf = await app.vault.readBinary(f);
        const blob = new Blob([buf], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('image load failed: ' + path));
          img.src = url;
        });
        map.set(path, img);
      }
    } catch (e) {
      console.warn('[mink-suite] preload image failed', path, e);
    }
  }));
  return map;
}

/** 把 .mink 渲染为页面画布（导出 PDF / 缩略图用） */
export async function renderMinkPageToCanvas(
  app: App,
  page: MinkDoc['pages'][number],
  objects: AnnoObject[],
  pixelWidth: number,
  images: Map<string, HTMLImageElement>,
): Promise<HTMLCanvasElement> {
  const { drawPaper } = await import('../ink/paper');
  const { drawObject } = await import('../ink/render');
  const scale = pixelWidth / page.width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(page.width * scale);
  canvas.height = Math.round(page.height * scale);
  const ctx = canvas.getContext('2d')!;
  drawPaper(ctx, canvas.width, canvas.height, page.template);
  for (const o of objects) {
    if (o.page !== page.id) continue;
    drawObject(ctx, o, scale, { images });
  }
  return canvas;
}
