import { Notice } from 'obsidian';

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js';
const TESSDATA_CDN = 'https://tessdata.projectnaptha.com/4.0.0_fast';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TesseractNS = any;

let loading: Promise<TesseractNS | null> | null = null;

async function injectScript(src: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });
}

/** 运行时从 CDN 加载 tesseract.js（避免打包 worker 问题） */
export async function loadTesseract(): Promise<TesseractNS | null> {
  const w = window as unknown as { Tesseract?: TesseractNS };
  if (w.Tesseract) return w.Tesseract;
  if (!loading) {
    loading = (async () => {
      try {
        await injectScript(TESSERACT_CDN);
        return w.Tesseract ?? null;
      } catch (e) {
        console.warn('[mink-suite] tesseract load failed', e);
        return null;
      }
    })();
  }
  return loading;
}

/** OCR：canvas / dataURL 均可 */
export async function ocrImage(image: HTMLCanvasElement | string, lang = 'chi_sim+eng'): Promise<string> {
  const T = await loadTesseract();
  if (!T) throw new Error('OCR 引擎加载失败（需要联网加载 tesseract.js，或改用 AI 问图）');
  const worker = await T.createWorker(lang, 1, { langPath: TESSDATA_CDN });
  try {
    const { data } = await worker.recognize(image);
    return String(data?.text ?? '').trim();
  } finally {
    try { await worker.terminate(); } catch { /* ignore */ }
  }
}

export function ocrNotice(): void {
  new Notice('OCR 进行中，首次使用需联网加载语言包…');
}
