import { Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import type { Extension } from '@codemirror/state';
import { DEFAULT_SETTINGS, type MinkSettings, type AnnoObject } from './types';
import { EventBus } from './core/eventbus';
import { StoreManager } from './core/store';
import { AnnoStore, MdAnnoStore } from './core/annostore';
import { ToolManager } from './ink/tools';
import { InputFilter } from './core/touch';
import { AiClient } from './ai/client';
import { AiHistory } from './ai/history';
import { CardStore } from './cards/model';
import { MinkView } from './mink/view';
import { registerMinkEmbed } from './mink/embed';
import { defaultDoc } from './mink/file';
import { ImapView } from './imap/view';
import { collectTextToImap } from './imap/collect';
import { defaultDoc as defaultImapDoc, migrateSources } from './imap/file';
import { isPdfView, type PdfViewLike } from './pdf/private-api';
import { PdfOverlayController } from './pdf/overlay';
import { PdfNavView } from './pdf/nav';
import { AnnotationCenterView } from './center/center';
import { MdSidebarView } from './md/sidebar';
import { buildMdAnnoExtension, annotateSelection, openMdSidebar } from './md/annotate';
import { MdAnnoExportModal } from './md/export-md';
import { MinkSettingTab } from './settings';
import { TextInputModal } from './core/modals';
import { AskModal } from './ai/ask';
import { AiHistoryModal } from './ai/history-ui';
import { CardDrawer } from './cards/drawer';
import { exportPdf, listMinkFiles } from './pdf/export';
import { importStandardAnnos, exportStandardAnnos } from './pdf/interop';
import { VIEW_TYPE_ANNOTATION_CENTER, VIEW_TYPE_IMAP, VIEW_TYPE_MD_SIDEBAR, VIEW_TYPE_MINK, VIEW_TYPE_PDF_NAV } from './constants';

export default class MinkSuite extends Plugin {
  settings!: MinkSettings;
  bus = new EventBus();
  store!: StoreManager;
  annoStore!: AnnoStore;
  mdStore!: MdAnnoStore;
  tools!: ToolManager;
  inputFilter!: InputFilter;
  ai!: AiClient;
  aiHistory!: AiHistory;
  cards!: CardStore;
  /** 笔迹对象剪贴板（.mink / PDF 间共享） */
  inkClipboard: AnnoObject[] = [];
  /** Markdown 批注版本号（编辑器装饰刷新用） */
  __mdAnnoVersion = 0;
  /** 未送达的定位请求：file → annoId（控制器激活时消费） */
  private revealRequests = new Map<string, string>();
  private pdfControllers = new Map<PdfViewLike, PdfOverlayController>();
  private mdAnnoExtension!: Extension;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.store = new StoreManager(this.app, this.settings.dataDir);
    this.annoStore = new AnnoStore(this.app, this.store, this.bus);
    this.mdStore = new MdAnnoStore(this.app, this.store, this.bus);
    this.tools = new ToolManager(() => this.settings);
    this.inputFilter = new InputFilter(() => this.settings);
    this.ai = new AiClient(() => ({
      baseUrl: this.settings.aiBaseUrl,
      apiKey: this.settings.aiApiKey,
      model: this.settings.aiModel,
      visionModel: this.settings.aiVisionModel,
    }));
    this.aiHistory = new AiHistory(this.store, this.bus);
    this.cards = new CardStore(this.app, this.store, this.bus);

    // ---------- 视图 ----------
    this.registerView(VIEW_TYPE_MINK, leaf => new MinkView(leaf, this));
    this.registerView(VIEW_TYPE_IMAP, leaf => new ImapView(leaf, this));
    this.registerView(VIEW_TYPE_ANNOTATION_CENTER, leaf => new AnnotationCenterView(leaf, this));
    this.registerView(VIEW_TYPE_MD_SIDEBAR, leaf => new MdSidebarView(leaf, this));
    this.registerView(VIEW_TYPE_PDF_NAV, leaf => new PdfNavView(leaf, this));
    // 关键：把 .mink / .imap 扩展名绑定到对应视图，否则 Obsidian 会当未知文件交给系统「打开方式」
    this.registerExtensions(['mink'], VIEW_TYPE_MINK);
    this.registerExtensions(['imap'], VIEW_TYPE_IMAP);

    // ---------- Markdown 编辑器装饰 ----------
    this.mdAnnoExtension = buildMdAnnoExtension(this);
    this.registerEditorExtension(this.mdAnnoExtension);
    this.registerEvent(this.bus.on('md-anno-changed', () => {
      this.__mdAnnoVersion++;
      this.refreshMdEditors();
    }));

    // ---------- 嵌入预览 ----------
    registerMinkEmbed(this);

    // ---------- PDF 视图扩展 ----------
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.syncPdfViews()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.syncPdfViews()));
    this.registerEvent(this.bus.on('reveal-anno', ({ file, annoId }) => {
      this.revealRequests.set(file, annoId);
    }));

    // ---------- Markdown 视图：预加载侧车（装饰可显示） ----------
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      const view = leaf?.view;
      if (view?.getViewType() === 'markdown') {
        const state = view.getState() as { file?: string };
        if (state?.file) void this.mdStore.load(state.file);
      }
    }));

    // ---------- 文件重命名 / 删除迁移 ----------
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      void this.annoStore.renameFile(oldPath, file.path);
      void this.mdStore.renameFile(oldPath, file.path);
      void this.cards.renameFile(oldPath, file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      void this.annoStore.deleteFile(file.path);
      void this.mdStore.deleteFile(file.path);
      void this.cards.deleteFile(file.path);
    }));

    // ---------- 命令 ----------
    this.addCommand({
      id: 'new-mink-note',
      name: '新建手写笔记（.mink）',
      callback: () => void this.commandNewMink(),
    });
    this.addCommand({
      id: 'open-annotation-center',
      name: '打开批注中心',
      callback: () => void this.openCenter(),
    });
    this.addCommand({
      id: 'open-pdf-nav',
      name: '打开 PDF 导航侧栏',
      checkCallback: checking => {
        const pdf = this.activePdfFile();
        if (!pdf) return false;
        if (!checking) void this.openPdfNav();
        return true;
      },
    });
    this.addCommand({
      id: 'md-annotate-selection',
      name: '为选中文字添加原文批注',
      editorCallback: () => void annotateSelection(this),
    });
    this.addCommand({
      id: 'open-md-sidebar',
      name: '打开原文批注侧栏',
      callback: () => void this.commandOpenMdSidebar(),
    });
    this.addCommand({
      id: 'md-anno-export',
      name: '导出批注到 Markdown 文件',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.commandExportMdAnnos(file);
        return true;
      },
    });
    this.addCommand({
      id: 'ai-ask',
      name: 'AI 问答',
      callback: () => new AskModal(this, { title: 'AI 问答' }).open(),
    });
    this.addCommand({
      id: 'ai-history',
      name: 'AI 会话历史',
      callback: () => new AiHistoryModal(this).open(),
    });
    this.addCommand({
      id: 'card-drawer',
      name: '打开卡片收藏夹抽屉',
      callback: () => {
        const file = this.app.workspace.getActiveFile()?.path ?? '';
        new CardDrawer(this, file).open();
      },
    });
    this.addCommand({
      id: 'pdf-export',
      name: '导出批注版 PDF（含手写笔记页）',
      checkCallback: checking => {
        const pdf = this.activePdfFile();
        if (!pdf) return false;
        if (!checking) void exportPdf(this, pdf, listMinkFiles(this.app));
        return true;
      },
    });
    this.addCommand({
      id: 'pdf-import-standard',
      name: '导入 PDF 内置标准批注',
      checkCallback: checking => {
        const pdf = this.activePdfFile();
        if (!pdf) return false;
        if (!checking) {
          void importStandardAnnos(this, pdf)
            .then(n => new Notice(n ? `已导入 ${n} 条标准批注` : '未发现可导入的标准批注'))
            .catch(e => new Notice(`导入失败：${(e as Error).message}`));
        }
        return true;
      },
    });
    this.addCommand({
      id: 'pdf-export-standard-copy',
      name: '导出标准批注副本（PDF 注释格式）',
      checkCallback: checking => {
        const pdf = this.activePdfFile();
        if (!pdf) return false;
        if (!checking) void exportStandardAnnos(this, pdf, 'copy');
        return true;
      },
    });
    this.addCommand({
      id: 'pdf-writeback',
      name: '批注写回源 PDF（先备份）',
      checkCallback: checking => {
        const pdf = this.activePdfFile();
        if (!pdf) return false;
        if (!checking) void exportStandardAnnos(this, pdf, 'writeback');
        return true;
      },
    });

    // ---------- Ribbon ----------
    this.addRibbonIcon('notebook-pen', 'Mink 批注中心', () => void this.openCenter());
    this.addRibbonIcon('pencil', '新建手写笔记', () => void this.commandNewMink());

    // ---------- 设置 ----------
    this.addSettingTab(new MinkSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    for (const ctrl of Array.from(this.pdfControllers.values())) ctrl.destroy();
    this.pdfControllers.clear();
    await this.annoStore.flush();
    await this.mdStore.flush();
  }

  // ---------- 设置 ----------

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---------- 命令实现 ----------

  private async commandNewMink(): Promise<void> {
    new TextInputModal(this.app, '新建手写笔记（文件名）', `未命名笔记 ${new Date().toLocaleDateString()}`, async name => {
      const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.mink$/i, '');
      const folder = this.app.workspace.getActiveFile()?.parent?.path ?? '';
      const path = folder ? `${folder}/${safe}.mink` : `${safe}.mink`;
      const exist = this.app.vault.getAbstractFileByPath(path);
      if (exist instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(exist);
        return;
      }
      const doc = defaultDoc(this.settings.defaultPaper);
      await this.app.vault.create(path, JSON.stringify(doc));
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(f, { active: true });
      }
    }).open();
  }

  private async commandNewImap(): Promise<void> {
    new TextInputModal(this.app, '新建思维导图（名称）', `脑图 ${new Date().toLocaleDateString()}`, async name => {
      const safe = (name || '未命名脑图').replace(/[\\/:*?"<>|]/g, '_').replace(/\.imap$/i, '');
      const folder = this.app.workspace.getActiveFile()?.parent?.path ?? '';
      const path = folder ? `${folder}/${safe}.imap` : `${safe}.imap`;
      const exist = this.app.vault.getAbstractFileByPath(path);
      if (exist instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(exist);
        return;
      }
      await this.app.vault.create(path, JSON.stringify(defaultImapDoc(safe)));
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(f, { active: true });
      }
    }).open();
  }

  private async openCenter(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATION_CENTER);
    let leaf: WorkspaceLeaf;
    if (existing.length) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_ANNOTATION_CENTER, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  private async openPdfNav(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_NAV);
    let leaf: WorkspaceLeaf;
    if (existing.length) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_PDF_NAV, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof PdfNavView) await view.render();
  }

  private async commandOpenMdSidebar(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active?.extension === 'md') {
      await openMdSidebar(this, active.path);
    } else {
      await openMdSidebar(this, '');
    }
  }

  private async commandExportMdAnnos(file: TFile): Promise<void> {
    await this.mdStore.load(file.path);
    const annos = this.mdStore.list(file.path);
    if (!annos.length) {
      new Notice('当前文件暂无批注');
      return;
    }
    new MdAnnoExportModal(this, file, annos).open();
  }

  // ---------- PDF 控制器管理 ----------

  private syncPdfViews(): void {
    const activeViews = new Set<PdfViewLike>();
    for (const leaf of this.app.workspace.getLeavesOfType('pdf')) {
      const view = leaf.view;
      if (isPdfView(view)) activeViews.add(view);
    }
    // 新建控制器
    for (const view of activeViews) {
      if (!this.pdfControllers.has(view)) {
        const ctrl = new PdfOverlayController(this, view);
        this.pdfControllers.set(view, ctrl);
        void ctrl.activate();
      }
    }
    // 清理已关闭视图
    for (const [view, ctrl] of Array.from(this.pdfControllers.entries())) {
      if (!activeViews.has(view)) {
        ctrl.destroy();
        this.pdfControllers.delete(view);
      }
    }
  }

  consumeRevealRequest(file: string): string | null {
    const id = this.revealRequests.get(file);
    if (id) this.revealRequests.delete(file);
    return id ?? null;
  }

  private activePdfFile(): TFile | null {
    const view = this.app.workspace.activeLeaf?.view;
    return isPdfView(view) ? view.file : null;
  }

  /** 出链引用：哪些文件链接到了指定 PDF（nav 侧栏用） */
  backlinksOf(pdfPath: string): Array<[string, number]> {
    const resolved = this.app.metadataCache.resolvedLinks;
    const out: Array<[string, number]> = [];
    for (const [src, links] of Object.entries(resolved)) {
      const count = links[pdfPath];
      if (count) out.push([src, count]);
    }
    return out.sort((a, b) => b[1] - a[1]);
  }

  private refreshMdEditors(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as { editor?: unknown };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cm = (view.editor as any)?.cm as { dispatch: (t: unknown) => void; state: { selection: { main: { head: number } } } } | undefined;
      if (cm) {
        cm.dispatch({ selection: { anchor: cm.state.selection.main.head } });
      }
    }
  }

  /** 供侧栏调用的选中批注入口 */
  async annotateSelection(): Promise<void> {
    await annotateSelection(this);
  }
}

export { MinkSuite };
