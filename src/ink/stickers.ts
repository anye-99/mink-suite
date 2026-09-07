export interface StickerDef {
  id: string;
  name: string;
  /** 24x24 viewBox 的 SVG path d（填充） */
  path: string;
  color: string;
  /** 需要 evenodd 填充规则 */
  evenodd?: boolean;
}

/** 内置贴纸集（SVG path，24x24 视图盒） */
export const STICKERS: StickerDef[] = [
  { id: 'star', name: '星星', color: '#fcc419', path: 'M12 2l2.9 6.26 6.6 1.04-4.75 4.13 1.32 6.57L12 16.9l-6.07 3.1 1.32-6.57L2.5 9.3l6.6-1.04L12 2z' },
  { id: 'heart', name: '爱心', color: '#e64980', path: 'M12 21s-7.5-4.9-9.7-9.1C.6 8.4 2.5 4.5 6 4.5c2 0 3.3 1 4 2.2.7-1.2 2-2.2 4-2.2 3.5 0 5.4 3.9 3.7 7.4C19.5 16.1 12 21 12 21z' },
  { id: 'check', name: '对勾', color: '#2f9e44', path: 'M9 16.2l-3.5-3.5L4 14.2 9 19.2 20 8.2l-1.5-1.5z' },
  { id: 'cross', name: '叉号', color: '#e03131', path: 'M18.3 5.7l-1.4-1.4L12 9.2 7.1 4.3 5.7 5.7l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z' },
  { id: 'flag', name: '旗帜', color: '#1971c2', path: 'M5 3v18h2v-7h5l1 2h6V5h-5l-1-2H5z' },
  { id: 'bookmark', name: '书签', color: '#f08c00', path: 'M6 2h12v20l-6-4.5L6 22z' },
  { id: 'pin', name: '图钉', color: '#e8590c', path: 'M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z', evenodd: true },
  { id: 'diamond', name: '菱形', color: '#9c36b5', path: 'M12 2l7 10-7 10-7-10z' },
  { id: 'spark4', name: '四角星', color: '#0c8599', path: 'M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z' },
  { id: 'bulb', name: '灯泡', color: '#f59f00', path: 'M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2zM9 22h6v-1.5H9z' },
];

export function getSticker(id: string): StickerDef | undefined {
  return STICKERS.find(s => s.id === id);
}
