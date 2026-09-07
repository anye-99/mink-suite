import { Notice } from 'obsidian';

/**
 * OCR：统一走 AI 视觉通道（OpenAI 兼容接口）。
 * 说明：不再运行时从 CDN 加载 tesseract.js——Obsidian 开发者政策禁止执行远程代码。
 */

/** OCR 进行中的提示（由调用方在发起 AI 识别前显示） */
export function ocrNotice(): void {
  new Notice('OCR 进行中…');
}
