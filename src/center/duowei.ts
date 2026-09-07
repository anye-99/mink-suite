import { Notice, TFile } from 'obsidian';
import type { AnnoObject, DuoweiDoc, MdAnnotation } from '../types';
import { uid } from '../core/ids';

/** 批注行：批注中心列表项的统一形态（PDF / .mink / Markdown） */
export interface AnnoRow {
  anno: AnnoObject | null;
  mdAnno: MdAnnotation | null;
  file: string;
  page: number | string | null;
  quote: string;
  note: string;
  kind: string;
  created: number;
}

export function rowFromAnno(anno: AnnoObject): AnnoRow {
  return {
    anno,
    mdAnno: null,
    file: anno.file,
    page: typeof anno.page === 'number' ? anno.page : null,
    quote: anno.anchor?.quote ?? anno.text ?? '',
    note: anno.kind === 'note' ? anno.text ?? '' : '',
    kind: anno.kind,
    created: anno.created,
  };
}

export function rowFromMd(file: string, a: MdAnnotation): AnnoRow {
  return {
    anno: null,
    mdAnno: a,
    file,
    page: null,
    quote: a.quote,
    note: a.note,
    kind: 'md-note',
    created: a.created,
  };
}

/** 导出为 .duowei 多维表（JSON 格式，可被多维表格应用读取） */
export async function exportDuowei(
  app: import('obsidian').App,
  rows: AnnoRow[],
  name: string,
): Promise<void> {
  const colDefs = [
    { id: 'c1', name: '文档', type: 'text' as const },
    { id: 'c2', name: '位置', type: 'text' as const },
    { id: 'c3', name: '类型', type: 'text' as const },
    { id: 'c4', name: '原文', type: 'text' as const },
    { id: 'c5', name: '笔记', type: 'text' as const },
    { id: 'c6', name: '创建时间', type: 'date' as const },
  ];
  const doc: DuoweiDoc = {
    format: 'duowei',
    version: 1,
    name,
    columns: colDefs,
    records: rows.map(r => ({
      id: uid(),
      cells: {
        c1: r.file,
        c2: r.page != null ? `第 ${r.page} 页` : '-',
        c3: KIND_LABELS[r.kind] ?? r.kind,
        c4: r.quote,
        c5: r.note,
        c6: new Date(r.created).toISOString(),
      },
    })),
    views: [{ id: 'v1', type: 'table' }],
    exportedFrom: 'mink-suite',
  };
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  const path = `${safe}.duowei`;
  const existing = app.vault.getAbstractFileByPath(path);
  const body = JSON.stringify(doc, null, 2);
  try {
    if (existing instanceof TFile) await app.vault.modify(existing, body);
    else await app.vault.create(path, body);
    new Notice(`已导出 ${rows.length} 条批注 → ${path}`);
  } catch (e) {
    console.error(e);
    new Notice('导出失败');
  }
}

export const KIND_LABELS: Record<string, string> = {
  ink: '笔迹',
  highlight: '高亮',
  underline: '下划线',
  note: '笔记',
  text: '文本',
  rect: '矩形',
  ellipse: '圆形',
  line: '线条',
  arrow: '箭头',
  arrow2: '双向箭头',
  sticky: '便利贴',
  image: '图片',
  sticker: '贴纸',
  mask: '遮盖',
  'md-note': 'Markdown 批注',
};
