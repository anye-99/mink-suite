import { Notice, TFile } from 'obsidian';
import { PDFDocument, PDFName, PDFNumber, PDFDict, PDFHexString } from '@cantoo/pdf-lib';
import type { AnnoObject } from '../types';
import type { MinkSuite } from '../main';
import { pdfBase } from './annotate';
import { hexToRgb, toAb } from './export';

const PDFJS_CMAP = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/cmaps/';

/** 导入 PDF 内置标准批注（高亮/下划线/文本笔记/矩形/圆形/墨迹）→ Mink 批注 */
export async function importStandardAnnos(plugin: MinkSuite, file: TFile): Promise<number> {
  const { loadPdfjs } = await import('./pdfjs');
  const lib = await loadPdfjs();
  if (!lib) throw new Error('pdf.js 加载失败（需联网），无法导入标准批注');
  const data = await plugin.app.vault.readBinary(file);
  const doc = await lib.getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: PDFJS_CMAP,
    cMapPacked: true,
  }).promise;

  let count = 0;
  const pages = doc.numPages;
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const { width: W, height: H } = await page.getViewport({ scale: 1 });
    let annos: Array<Record<string, unknown>> = [];
    try {
      annos = await page.getAnnotations({ intent: 'display' }) as Array<Record<string, unknown>>;
    } catch {
      continue;
    }
    for (const a of annos) {
      const subtype = a.subtype as string;
      const rect = a.rect as number[] | undefined;
      if (!rect || rect.length < 4) continue;
      // 归一化（页宽 1000，顶部原点）
      const sx = 1000 / W;
      const normRect = {
        x: Math.min(rect[0], rect[2]) * sx,
        y: Math.min(H - Math.max(rect[1], rect[3]), H - Math.min(rect[1], rect[3])) * sx,
        w: Math.abs(rect[2] - rect[0]) * sx,
        h: Math.abs(rect[3] - rect[1]) * sx,
      };
      const color = Array.isArray(a.color) && a.color.length === 3
        ? rgbToHex(a.color as [number, number, number])
        : '#ffe066';

      let o: AnnoObject | null = null;
      switch (subtype) {
        case 'Highlight':
          o = pdfBase(file.path, p, 'highlight', 'import');
          o.rects = [normRect];
          o.color = color;
          o.anchor = { quote: String(a.contents ?? ''), rects: [normRect] };
          break;
        case 'Underline':
          o = pdfBase(file.path, p, 'underline', 'import');
          o.rects = [normRect];
          o.color = color;
          o.anchor = { quote: String(a.contents ?? ''), rects: [normRect] };
          break;
        case 'Text':
          o = pdfBase(file.path, p, 'sticky', 'import');
          o.rects = [{ ...normRect, w: 220, h: 170 }];
          o.bg = '#ffe066';
          o.text = String(a.contents ?? '');
          break;
        case 'Square':
          o = pdfBase(file.path, p, 'rect', 'import');
          o.rects = [normRect];
          o.color = color;
          break;
        case 'Circle':
          o = pdfBase(file.path, p, 'ellipse', 'import');
          o.rects = [normRect];
          o.color = color;
          break;
        case 'Ink': {
          // inkLists: [[x,y,x,y...], ...] PDF 坐标
          const lists = (a as { inkLists?: number[][][] }).inkLists;
          if (Array.isArray(lists) && lists.length) {
            const pts = lists[0].map((pt: number[]) => ({ x: pt[0] * sx, y: (H - pt[1]) * sx }));
            if (pts.length > 1) {
              o = pdfBase(file.path, p, 'ink', 'import');
              o.points = pts;
              o.color = color;
              o.size = 4;
            }
          }
          break;
        }
        default:
          break;
      }
      if (o) {
        o.imported = true;
        await plugin.annoStore.add(file.path, o);
        count++;
      }
    }
  }
  await doc.destroy();
  return count;
}

function rgbToHex(c: [number, number, number]): string {
  return '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * 把 Mink 批注写为 PDF 标准批注（Annotation Dictionary）：
 * mode: 'copy' 导出副本；'writeback' 备份后写回源文件。
 */
export async function exportStandardAnnos(
  plugin: MinkSuite,
  file: TFile,
  mode: 'copy' | 'writeback',
): Promise<void> {
  const objects = plugin.annoStore.objectsFor(file.path).filter(o => !o.imported);
  if (!objects.length) {
    new Notice('该文件暂无 Mink 批注可导出');
    return;
  }
  const srcBytes = await plugin.app.vault.readBinary(file);
  const pdfDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  for (const o of objects) {
    const pageIdx = (typeof o.page === 'number' ? o.page : 1) - 1;
    const page = pages[pageIdx];
    if (!page) continue;
    const annot = buildAnnotDict(pdfDoc, page, o);
    if (!annot) continue;
    const ref = pdfDoc.context.register(annot);
    const annots = page.node.Annots();
    if (annots) annots.push(ref);
    else page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([ref]));
  }

  const out = await pdfDoc.save();
  if (mode === 'copy') {
    const outPath = file.path.replace(/\.pdf$/i, '') + '-标准批注副本.pdf';
    const existing = plugin.app.vault.getAbstractFileByPath(outPath);
    if (existing instanceof TFile) await plugin.app.vault.modifyBinary(existing, toAb(out));
    else await plugin.app.vault.createBinary(outPath, toAb(out));
    new Notice(`已导出标准批注副本：${outPath}`);
  } else {
    // 备份原文件后写回
    const bakPath = file.path.replace(/\.pdf$/i, '') + '.backup.pdf';
    const bak = plugin.app.vault.getAbstractFileByPath(bakPath);
    if (bak instanceof TFile) await plugin.app.vault.modifyBinary(bak, srcBytes);
    else await plugin.app.vault.createBinary(bakPath, srcBytes);
    await plugin.app.vault.modifyBinary(file, toAb(out));
    new Notice(`已写回源文件（原文件备份为 ${bakPath}）`);
  }
}

function buildAnnotDict(
  pdfDoc: PDFDocument,
  page: import('@cantoo/pdf-lib').PDFPage,
  o: AnnoObject,
): PDFDict | null {
  const ctx = pdfDoc.context;
  const { width: W, height: H } = page.getSize();
  const sx = W / 1000;
  const X = (x: number) => x * sx;
  const Y = (y: number) => H - y * sx;

  const dict = ctx.obj({});
  dict.set(PDFName.of('Type'), PDFName.of('Annot'));
  dict.set(PDFName.of('F'), PDFNumber.of(4)); // Print 标志
  dict.set(PDFName.of('T'), PDFHexString.fromText('Mink Suite'));
  if (o.text) dict.set(PDFName.of('Contents'), PDFHexString.fromText(o.text));

  const setCA = (hex: string): void => {
    const rgb = hexToRgb(hex);
    dict.set(PDFName.of('C'), ctx.obj([PDFNumber.of(+rgb.red.toFixed(3)), PDFNumber.of(+rgb.green.toFixed(3)), PDFNumber.of(+rgb.blue.toFixed(3))]));
  };

  const rectOf = (r: { x: number; y: number; w: number; h: number }): number[] => {
    const x1 = X(r.x), y1 = Y(r.y + r.h), x2 = X(r.x + r.w), y2 = Y(r.y);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  };

  switch (o.kind) {
    case 'highlight': case 'underline': {
      const rects = o.anchor?.rects ?? o.rects;
      if (!rects?.length) return null;
      const quads: number[] = [];
      for (const r of rects) {
        quads.push(
          X(r.x), Y(r.y),                    // 左上
          X(r.x + r.w), Y(r.y),              // 右上
          X(r.x), Y(r.y + r.h),              // 左下
          X(r.x + r.w), Y(r.y + r.h),        // 右下
        );
      }
      dict.set(PDFName.of('Subtype'), PDFName.of(o.kind === 'highlight' ? 'Highlight' : 'Underline'));
      dict.set(PDFName.of('Rect'), ctx.obj(rectOf(rects[0])));
      dict.set(PDFName.of('QuadPoints'), ctx.obj(quads));
      setCA(o.color ?? '#ffe066');
      if (o.kind === 'underline') {
        const c = dict.get(PDFName.of('C'));
        if (c) dict.set(PDFName.of('IC'), c);
      }
      break;
    }
    case 'ink': {
      if (!o.points?.length) return null;
      dict.set(PDFName.of('Subtype'), PDFName.of('Ink'));
      const xs = o.points.map(p => X(p.x));
      const ys = o.points.map(p => Y(p.y));
      dict.set(PDFName.of('Rect'), ctx.obj([
        Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2,
      ]));
      const inkList = ctx.obj([ctx.obj(o.points.map(p => [X(p.x), Y(p.y)]).flat())]);
      dict.set(PDFName.of('InkList'), inkList);
      setCA(o.color ?? '#2f6fdb');
      break;
    }
    case 'note': {
      const r = o.anchor?.rects?.[0] ?? o.rects?.[0];
      if (!r) return null;
      dict.set(PDFName.of('Subtype'), PDFName.of('Text'));
      dict.set(PDFName.of('Rect'), ctx.obj(rectOf(r)));
      setCA(o.color ?? '#f08c00');
      break;
    }
    case 'sticky': {
      const r = o.rects?.[0];
      if (!r) return null;
      dict.set(PDFName.of('Subtype'), PDFName.of('Text'));
      dict.set(PDFName.of('Rect'), ctx.obj(rectOf(r)));
      setCA(o.bg ?? '#ffe066');
      break;
    }
    case 'rect': case 'ellipse': {
      const r = o.rects?.[0];
      if (!r) return null;
      dict.set(PDFName.of('Subtype'), PDFName.of(o.kind === 'rect' ? 'Square' : 'Circle'));
      dict.set(PDFName.of('Rect'), ctx.obj(rectOf(r)));
      setCA(o.color ?? '#e8590c');
      break;
    }
    default:
      return null;
  }
  return dict;
}
