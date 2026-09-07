// Mink 妙笔批注套件 —— 统一数据模型
// 坐标约定：所有持久化坐标按「页宽 = 1000 归一化单位」存储，
// 渲染时乘以 (实际页宽 / 1000)。PDF 与 .mink 页共用该约定。

export interface Pt { x: number; y: number; p?: number }
export interface Rect { x: number; y: number; w: number; h: number }

export type AnnoKind =
  | 'ink' | 'highlight' | 'underline' | 'note'
  | 'text' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'arrow2'
  | 'sticky' | 'image' | 'sticker' | 'mask';

/** 统一批注对象：PDF 页 / .mink 页 / Markdown（经 MdAnnotation 另行存储） */
export interface AnnoObject {
  id: string;
  /** 宿主文件 vault 相对路径 */
  file: string;
  /** PDF 页码（1 起）或 .mink 页 id */
  page: number | string;
  kind: AnnoKind;
  /** 笔迹点（含压感 p ∈ [0,1]） */
  points?: Pt[];
  /** 区域（形状/文本/遮盖/锚定行），归一化坐标 */
  rects?: Rect[];
  color?: string;
  /** 线宽或字号（归一化单位） */
  size?: number;
  opacity?: number;
  dash?: boolean;
  /** 文本 / 笔记 / 便利贴内容 */
  text?: string;
  /** 便利贴底色 */
  bg?: string;
  /** 图片 vault 路径 */
  src?: string;
  stickerId?: string;
  /** 文本批注锚（选区文字 + 行矩形） */
  anchor?: { quote: string; rects: Rect[] };
  /** 遮盖对象当前是否处于「已显示」状态 */
  revealed?: boolean;
  created: number;
  modified: number;
  tool?: string;
  /** 由 PDF 内置标准批注导入 */
  imported?: boolean;
}

// ---------- 工具 ----------
export type ToolId =
  | 'select' | 'pen' | 'highlighter' | 'eraser'
  | 'rect' | 'ellipse' | 'line' | 'arrow' | 'arrow2'
  | 'text' | 'sticker' | 'mask' | 'sticky' | 'screenshot';

// ---------- .mink 手写笔记 ----------
export type PaperTemplate = 'blank' | 'lined' | 'grid' | 'dots' | 'cornell';

export interface MinkPage {
  id: string;
  template: PaperTemplate;
  /** 归一化宽高，渲染时映射到实际像素 */
  width: number;
  height: number;
}

export interface MinkDoc {
  version: number;
  meta: { title?: string; created: number; modified: number };
  pages: MinkPage[];
  objects: AnnoObject[];
}

// ---------- 批注侧车（.mink-suite/annos/<key>.json） ----------
export interface PdfBookmark { page: number; label: string; created: number }

export interface AnnoSidecar {
  version: number;
  file: string;
  objects: AnnoObject[];
  bookmarks?: PdfBookmark[];
}

// ---------- Markdown 原文批注（.mink-suite/md/<key>.json） ----------
export interface MdAnnotation {
  id: string;
  file: string;
  /** 0 起行号，文件变更后重锚 */
  line: number;
  quote: string;
  note: string;
  created: number;
  modified: number;
}

export interface MdSidecar {
  version: number;
  file: string;
  annotations: MdAnnotation[];
}

// ---------- 学习卡片 ----------
export type CardKind = 'text' | 'image' | 'ocr' | 'anno';

export interface Card {
  id: string;
  kind: CardKind;
  content: string;
  file?: string;
  page?: number | string;
  annoId?: string;
  /** 卡片截图（vault 相对路径） */
  snapshot?: string;
  tags: string[];
  created: number;
}

export interface CardStoreData { version: number; cards: Card[] }

// ---------- AI 会话 ----------
export type AiRole = 'user' | 'assistant' | 'system';
export interface AiMessage { role: AiRole; content: string; images?: string[] }
export interface AiConversation {
  id: string; title: string; messages: AiMessage[];
  created: number; updated: number;
  pinned?: boolean;
  /** 会话类型：文本问答 / 问图 */
  kind?: 'chat' | 'vision';
}
export interface AiHistoryData { version: number; conversations: AiConversation[] }

// ---------- .duowei 多维表导出 ----------
export interface DuoweiColumn { id: string; name: string; type: 'text' | 'number' | 'date' | 'select' }
export interface DuoweiRecord { id: string; cells: Record<string, string> }
export interface DuoweiDoc {
  format: 'duowei';
  version: number;
  name: string;
  columns: DuoweiColumn[];
  records: DuoweiRecord[];
  views: { id: string; type: 'table' }[];
  exportedFrom: string;
}

// ---------- 设置 ----------
export interface MinkSettings {
  dataDir: string;
  defaultPaper: PaperTemplate;
  penColor: string;
  penSize: number;
  highlighterColor: string;
  highlighterSize: number;
  shapeColor: string;
  shapeSize: number;
  highlightColors: string[];
  /** 允许手指直接书写（否则仅笔/鼠标） */
  drawOnTouch: boolean;
  /** 触控优化：书写时忽略触摸输入（防掌误触） */
  palmRejection: boolean;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiVisionModel: string;
  /** CJK 字体 vault 路径（用于导出 PDF 中文文本） */
  cjkFontPath: string;
  ocrEngine: 'ai' | 'off';
  screenshotFolder: string;
  /** 导出 PDF 时页面渲染倍率 */
  exportScale: number;
}

export const DEFAULT_SETTINGS: MinkSettings = {
  dataDir: '.mink-suite',
  defaultPaper: 'lined',
  penColor: '#2f6fdb',
  penSize: 4,
  highlighterColor: '#ffe066',
  highlighterSize: 16,
  shapeColor: '#e8590c',
  shapeSize: 3,
  highlightColors: ['#ffe066', '#8ce99a', '#a5d8ff', '#ffc9c9', '#eebefa'],
  drawOnTouch: false,
  palmRejection: true,
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
  aiVisionModel: '',
  cjkFontPath: '',
  ocrEngine: 'ai',
  screenshotFolder: '.mink-suite/assets',
  exportScale: 2,
};
