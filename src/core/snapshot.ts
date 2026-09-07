import { App, Notice, TFile } from 'obsidian';
import type { StoreManager } from './store';
import { uid } from './ids';

export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png');
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return await res.blob();
}

/** 复制图片到剪贴板：优先 Clipboard API，桌面端回退 electron clipboard */
export async function copyImageBlob(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }
  } catch { /* fall through */ }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = (window as any).require;
    if (req) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const electron = req('electron') as any;
      const dataUrl = await blobToDataUrl(blob);
      const img = electron?.nativeImage?.createFromDataURL?.(dataUrl)
        ?? electron?.remote?.nativeImage?.createFromDataURL?.(dataUrl);
      const clipboard = electron?.clipboard ?? electron?.remote?.clipboard;
      if (img && clipboard) {
        clipboard.writeImage(img);
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/** 保存 PNG 到 vault 指定目录，返回 TFile */
export async function savePngBlob(
  app: App,
  store: StoreManager,
  folder: string,
  blob: Blob,
): Promise<TFile | null> {
  const name = `mink-${new Date().toISOString().replace(/[:.]/g, '-')}-${uid().slice(0, 6)}.png`;
  const rel = `${folder.replace(/^\/+|\/+$/g, '')}/${name}`;
  await store.ensureDir(folder);
  const buf = await blob.arrayBuffer();
  const f = await app.vault.createBinary(rel, buf).catch(e => {
    console.error('[mink-suite] savePngBlob failed', e);
    return null;
  });
  if (f) new Notice(`已保存：${rel}`);
  else new Notice('保存图片失败');
  return f;
}
