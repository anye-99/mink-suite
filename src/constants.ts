export const VIEW_TYPE_MINK = 'mink-view';
export const VIEW_TYPE_ANNOTATION_CENTER = 'mink-annotation-center';
export const VIEW_TYPE_MD_SIDEBAR = 'mink-md-sidebar';
export const VIEW_TYPE_PDF_NAV = 'mink-pdf-nav';

export const DATA_SUB = {
  annos: 'annos',
  md: 'md',
  cards: 'cards',
  cardsAssets: 'cards/assets',
  assets: 'assets',
  ai: 'ai',
} as const;

export const CARDS_FILE = 'cards.json';
export const AI_HISTORY_FILE = 'history.json';

/** 归一化页宽（坐标基准） */
export const PAGE_NORM_W = 1000;

export const TOOL_LABELS: Record<string, string> = {
  select: '选择',
  pen: '画笔',
  highlighter: '荧光笔',
  eraser: '橡皮',
  rect: '矩形',
  ellipse: '圆形',
  line: '线条',
  arrow: '单向箭头',
  arrow2: '双向箭头',
  text: '文本',
  sticker: '贴纸',
  mask: '遮盖',
  sticky: '便利贴',
  screenshot: '截图',
};

export const STICKY_COLORS = ['#ffe066', '#8ce99a', '#a5d8ff', '#ffc9c9', '#eebefa', '#ffd8a8'];

export const PAPER_LABELS: Record<string, string> = {
  blank: '空白',
  lined: '横线',
  grid: '方格',
  dots: '点阵',
  cornell: '康奈尔',
};
