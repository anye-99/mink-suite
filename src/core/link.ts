import { App, Notice } from 'obsidian';
import type { EventBus } from './eventbus';

/** 生成 PDF 批注回链 wikilink：[[file.pdf#page=3&mink=<id>]] */
export function pdfWikiLink(file: string, page?: number, annoId?: string): string {
  const params: string[] = [];
  if (typeof page === 'number') params.push(`page=${page}`);
  if (annoId) params.push(`mink=${annoId}`);
  const sub = params.length ? `#${params.join('&')}` : '';
  return `[[${file}${sub}]]`;
}

/** 生成 .mink 手写笔记回链 */
export function minkWikiLink(file: string, annoId?: string): string {
  return annoId ? `[[${file}?mink=${annoId}]]` : `[[${file}]]`;
}

/** 解析 pdf 子路径（file.pdf#page=3&mink=x） */
export function parsePdfSubpath(subpath: string): { page?: number; mink?: string } {
  const out: { page?: number; mink?: string } = {};
  if (!subpath) return out;
  const s = subpath.replace(/^#/, '');
  for (const kv of s.split('&')) {
    const [k, v] = kv.split('=');
    if (k === 'page') out.page = parseInt(v, 10);
    else if (k === 'mink') out.mink = v;
  }
  return out;
}

export async function copyText(text: string, notice = '已复制到剪贴板'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(notice);
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      new Notice(notice);
    } catch {
      new Notice('复制失败');
    }
  }
}

/** 打开批注所在文件并请求定位（页码定位 + 闪烁批注） */
export async function openAnno(
  app: App,
  bus: EventBus,
  file: string,
  page?: number | string,
  annoId?: string,
): Promise<void> {
  const link = typeof page === 'number' ? `${file}#page=${page}` : file;
  await app.workspace.openLinkText(link, '', false);
  if (annoId) bus.emit('reveal-anno', { file, annoId });
}
