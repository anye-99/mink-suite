import { App, Notice, TFile } from 'obsidian';
import { PDFDocument, StandardFonts, LineCapStyle, rgb } from '@cantoo/pdf-lib';
import type { PDFFont } from '@cantoo/pdf-lib';
// @ts-expect-error @pdf-lib/fontkit 仅在运行时提供 default 导出（CJS/UMD），其 d.ts 未声明
import fontkit from '@pdf-lib/fontkit';
import type { AnnoObject } from '../types';
import type { MinkSuite } from '../main';
import { readDoc, renderMinkPageToCanvas, preloadImages } from '../mink/file';
import { canvasToBlob } from '../core/snapshot';

const LINE_CAP_ROUND = LineCapStyle.Round;

/** Uint8Array → ArrayBuffer（vault.createBinary/modifyBinary 需要） */
export function toAb(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

/**
 * PDF 视觉导出：把笔迹 / 文本批注 / 对象标注 / 便利贴 合成进 PDF 页面，
 * 并把 .mink 独立手写笔记作为附加页拼接到文档末尾。
 */
export async function exportPdf(
  plugin: MinkSuite,
  sourceFile: TFile,
  includeMinkNotes: TFile[],
): Promise<void> {
  try {
    const srcBytes = await plugin.app.vault.readBinary(sourceFile);
    const pdfDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    pdfDoc.registerFontkit(fontkit);

    // ---------- 字体（CJK 可选） ----------
    let cjkFont: FontLike | null = null;
    const latinFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontPath = plugin.settings.cjkFontPath.trim();
    if (fontPath) {
      const ff = plugin.app.vault.getAbstractFileByPath(fontPath);
      if (ff instanceof TFile && /\.(otf|ttf|ttc)$/i.test(ff.extension)) {
        try {
          const buf = await plugin.app.vault.readBinary(ff);
          cjkFont = await pdfDoc.embedFont(buf, { subset: true });
        } catch (e) {
          console.warn('[mink-suite] CJK 字体嵌入失败', e);
          new Notice('CJK 字体嵌入失败，将回退内置字体（中文文本可能显示为 ?）');
        }
      }
    }
    const pickFont: FontPick = (text: string) => {
      if (/[^\u0000-\u00ff]/.test(text) && cjkFont) return { font: cjkFont, text };
      if (/[^\u0000-\u00ff]/.test(text)) {
        return { font: latinFont, text: text.replace(/[^\u0000-\u00ff]/g, '?') };
      }
      return { font: latinFont, text };
    };

    // ---------- 合成批注 ----------
    const objects = plugin.annoStore.objectsFor(sourceFile.path);
    const pages = pdfDoc.getPages();
    for (const o of objects) {
      const pageIdx = (typeof o.page === 'number' ? o.page : 1) - 1;
      const page = pages[pageIdx];
      if (!page) continue;
      try {
        drawAnnoOnPdf(page, o, pickFont, o.opacity ?? 1);
      } catch (e) {
        console.warn('[mink-suite] 导出对象失败', o.id, e);
      }
    }

    // ---------- 追加 .mink 页 ----------
    for (const mf of includeMinkNotes) {
      const doc = await readDoc(plugin.app, mf);
      const images = await preloadImages(plugin.app, doc.objects);
      for (const pg of doc.pages) {
        const canvas = await renderMinkPageToCanvas(plugin.app, pg, doc.objects, Math.round(pg.width * plugin.settings.exportScale), images);
        const blob = await canvasToBlob(canvas);
        const png = await pdfDoc.embedPng(await blob.arrayBuffer());
        const np = pdfDoc.addPage([png.width, png.height]);
        np.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
      }
    }

    // ---------- 保存 ----------
    const out = await pdfDoc.save();
    const base = sourceFile.path.replace(/\.pdf$/i, '');
    const suffix = includeMinkNotes.length ? '-含手写笔记' : '-批注版';
    const outPath = `${base}${suffix}.pdf`;
    const outAb = toAb(out);
    const existing = plugin.app.vault.getAbstractFileByPath(outPath);
    if (existing instanceof TFile) await plugin.app.vault.modifyBinary(existing, outAb);
    else await plugin.app.vault.createBinary(outPath, outAb);
    new Notice(`已导出：${outPath}`);
  } catch (e) {
    console.error(e);
    new Notice(`PDF 导出失败：${(e as Error).message}`);
  }
}

type FontLike = PDFFont;
type FontPick = (text: string) => { font: FontLike; text: string };

/** 把单个批注对象画到 PDF 页（坐标：归一化 → PDF 左下原点） */
function drawAnnoOnPdf(
  page: import('@cantoo/pdf-lib').PDFPage,
  o: AnnoObject,
  pickFont: FontPick,
  opacity: number,
): void {
  const { width: W, height: H } = page.getSize();
  const sx = W / 1000;
  const sy = W / 1000;
  const X = (x: number) => x * sx;
  const Y = (y: number) => H - y * sy; // 顶部原点 → 底部原点

  const color = hexToRgb(o.color ?? '#e8590c');

  switch (o.kind) {
    case 'ink': {
      if (!o.points?.length) break;
      const isHi = o.tool === 'highlighter';
      const d = o.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${X(p.x).toFixed(2)} ${Y(p.y).toFixed(2)}`).join(' ');
      page.drawSvgPath(d, {
        borderColor: color,
        borderWidth: Math.max(0.5, (o.size ?? 4) * sx),
        borderLineCap: LINE_CAP_ROUND,
        opacity: isHi ? 0.45 : 1,
        borderOpacity: isHi ? 0.45 : 1,
      });
      break;
    }
    case 'highlight': {
      for (const r of o.rects ?? []) {
        page.drawRectangle({
          x: X(r.x), y: Y(r.y + r.h),
          width: r.w * sx, height: r.h * sy,
          color, opacity: 0.35,
        });
      }
      break;
    }
    case 'underline': {
      for (const r of o.rects ?? []) {
        page.drawLine({
          start: { x: X(r.x), y: Y(r.y + r.h) },
          end: { x: X(r.x + r.w), y: Y(r.y + r.h) },
          thickness: Math.max(0.7, (o.size ?? 3) * sx),
          color,
        });
      }
      break;
    }
    case 'note': {
      const r = o.anchor?.rects?.[0] ?? o.rects?.[0];
      if (!r) break;
      page.drawRectangle({
        x: X(r.x), y: Y(r.y + r.h),
        width: r.w * sx, height: r.h * sy,
        color, opacity: 0.12,
      });
      if (o.text) {
        drawWrappedText(page, o.text, pickFont, X(r.x), Y(r.y + r.h) + 4, r.w * sx, 12 * sx, 0.9);
      }
      break;
    }
    case 'rect': {
      const r = o.rects?.[0];
      if (!r) break;
      page.drawRectangle({
        x: X(r.x), y: Y(r.y + r.h),
        width: r.w * sx, height: r.h * sy,
        borderColor: color,
        borderWidth: Math.max(0.7, (o.size ?? 3) * sx),
        opacity,
      });
      break;
    }
    case 'ellipse': {
      const r = o.rects?.[0];
      if (!r) break;
      page.drawEllipse({
        x: X(r.x + r.w / 2), y: Y(r.y + r.h / 2),
        xScale: (r.w / 2) * sx, yScale: (r.h / 2) * sy,
        borderColor: color,
        borderWidth: Math.max(0.7, (o.size ?? 3) * sx),
        opacity,
      });
      break;
    }
    case 'line': case 'arrow': case 'arrow2': {
      const r = o.rects?.[0];
      if (!r) break;
      const x1 = X(r.x), y1 = Y(r.y), x2 = X(r.x + r.w), y2 = Y(r.y + r.h);
      page.drawLine({
        start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
        thickness: Math.max(0.7, (o.size ?? 3) * sx),
        color, opacity,
      });
      const size = Math.max(8, (o.size ?? 3) * sx * 4);
      if (o.kind !== 'line') {
        drawArrowHead(page, x1, y1, x2, y2, size, color);
        if (o.kind === 'arrow2') drawArrowHead(page, x2, y2, x1, y1, size, color);
      }
      break;
    }
    case 'text': {
      const r = o.rects?.[0];
      if (!r || !o.text) break;
      drawWrappedText(page, o.text, pickFont, X(r.x), Y(r.y), r.w * sx, (o.size ?? 18) * sx, 1);
      break;
    }
    case 'sticky': {
      const r = o.rects?.[0];
      if (!r) break;
      page.drawRectangle({
        x: X(r.x), y: Y(r.y + r.h),
        width: r.w * sx, height: r.h * sy,
        color: hexToRgb(o.bg ?? '#ffe066'),
        borderColor: rgb(0.75, 0.75, 0.75),
        borderWidth: 0.8,
      });
      if (o.text) {
        drawWrappedText(page, o.text, pickFont, X(r.x) + 4, Y(r.y + 8), r.w * sx - 8, (o.size ?? 16) * sx, 0.95);
      }
      break;
    }
    case 'sticker': {
      const r = o.rects?.[0];
      if (!r) break;
      page.drawEllipse({
        x: X(r.x + r.w / 2), y: Y(r.y + r.h / 2),
        xScale: (r.w / 2) * sx, yScale: (r.h / 2) * sy,
        color: color, opacity: 0.85,
      });
      break;
    }
    default:
      break;
  }
}

function drawArrowHead(
  page: import('@cantoo/pdf-lib').PDFPage,
  fromX: number, fromY: number, tipX: number, tipY: number,
  size: number, color: import('@cantoo/pdf-lib').RGB,
): void {
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const p1 = `${(tipX - size * Math.cos(angle - Math.PI / 6)).toFixed(2)} ${(tipY - size * Math.sin(angle - Math.PI / 6)).toFixed(2)}`;
  const p2 = `${(tipX - size * Math.cos(angle + Math.PI / 6)).toFixed(2)} ${(tipY - size * Math.sin(angle + Math.PI / 6)).toFixed(2)}`;
  page.drawSvgPath(
    `M ${tipX.toFixed(2)} ${tipY.toFixed(2)} L ${p1} L ${p2} Z`,
    { color },
  );
}

function drawWrappedText(
  page: import('@cantoo/pdf-lib').PDFPage,
  text: string,
  pickFont: FontPick,
  x: number, yTop: number, maxW: number, fontSize: number,
  opacity: number,
): void {
  const { font, text: safeText } = pickFont(text);
  const lineHeight = fontSize * 1.35;
  let y = yTop;
  for (const para of safeText.split('\n')) {
    let line = '';
    const widthOf = (s: string): number => {
      try { return font.widthOfTextAtSize(s, fontSize); }
      catch { return s.length * fontSize * 0.6; }
    };
    for (const ch of para) {
      const candidate = line + ch;
      if (widthOf(candidate) > maxW && line) {
        page.drawText(line, { x, y: y - fontSize, size: fontSize, font, opacity });
        y -= lineHeight;
        line = ch;
      } else {
        line = candidate;
      }
    }
    page.drawText(line, { x, y: y - fontSize, size: fontSize, font, opacity });
    y -= lineHeight;
  }
}

export function hexToRgb(hex: string): import('@cantoo/pdf-lib').RGB {
  const m = hex.replace('#', '');
  const v = m.length === 3
    ? m.split('').map(c => parseInt(c + c, 16))
    : [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16));
  return rgb(
    (v[0] ?? 0) / 255, (v[1] ?? 0) / 255, (v[2] ?? 0) / 255,
  );
}

/** 找到 vault 中所有 .mink 文件（导出选择用） */
export function listMinkFiles(app: App): TFile[] {
  return app.vault.getFiles().filter(f => f.extension === 'mink');
}
