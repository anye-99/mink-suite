import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { MarkdownView, Notice, editorInfoField } from 'obsidian';
import type { MinkSuite } from '../main';
import type { MdAnnotation } from '../types';
import { uid } from '../core/ids';
import { VIEW_TYPE_MD_SIDEBAR } from '../constants';

/** 行首批注角标 Widget（点击打开批注侧栏定位） */
class MdAnnoMark extends WidgetType {
  constructor(
    private plugin: MinkSuite,
    private file: string,
    private annoId: string,
    private note: string,
  ) {
    super();
  }

  eq(other: MdAnnoMark): boolean {
    return other.annoId === this.annoId && other.note === this.note && other.file === this.file;
  }

  toDOM(view: EditorView): HTMLElement {
    void view;
    const wrap = document.createElement('span');
    wrap.className = 'mink-md-anno-mark';
    wrap.textContent = '✎';
    wrap.title = this.note ? `批注：${this.note.slice(0, 80)}` : '查看批注';
    wrap.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      void openMdSidebar(this.plugin, this.file, this.annoId);
    });
    return wrap;
  }

  ignoreEvent(): boolean { return false; }
}

/** 编辑器装饰：有批注的行 → 角标 + 淡黄底纹 */
export function buildMdAnnoExtension(plugin: MinkSuite): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private plugin: MinkSuite;

      constructor(view: EditorView) {
        this.plugin = plugin;
        this.decorations = this.buildDeco(view);
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.selectionSet
          || plugin.__mdAnnoVersion !== this.seenVersion) {
          this.seenVersion = plugin.__mdAnnoVersion;
          this.decorations = this.buildDeco(u.view);
        }
      }

      private seenVersion = 0;

      private buildDeco(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const info = view.state.field(editorInfoField, false) as { file?: import('obsidian').TFile } | undefined;
        const file = info?.file?.path;
        if (!file) return builder.finish();
        for (const a of this.plugin.mdStore.list(file)) {
          const lineNo = Math.min(a.line, view.state.doc.lines - 1) + 1;
          const l = view.state.doc.line(Math.max(1, lineNo));
          builder.add(
            l.from, l.from,
            Decoration.widget({ widget: new MdAnnoMark(this.plugin, file, a.id, a.note), side: -10 }),
          );
          builder.add(
            l.from, l.to,
            Decoration.line({ class: 'mink-md-anno-line' }),
          );
        }
        return builder.finish();
      }
    },
    { decorations: v => v.decorations },
  );
}

/** 为编辑器当前选区创建原文批注（命令入口） */
export async function annotateSelection(plugin: MinkSuite): Promise<void> {
  const active = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!active) return;
  const file = active.file;
  if (!file) return;
  const sel = active.editor?.getSelection().trim();
  if (!sel) {
    new Notice('请先选中要批注的文字');
    return;
  }
  const line = active.editor?.getCursor('from').line ?? 0;
  const anno: MdAnnotation = {
    id: uid(),
    file: file.path,
    line,
    quote: sel,
    note: '',
    created: Date.now(),
    modified: Date.now(),
  };
  await plugin.mdStore.add(file.path, anno);
  await openMdSidebar(plugin, file.path, anno.id);
}

/** 打开（或复用）原文批注侧栏并定位到指定批注 */
export async function openMdSidebar(plugin: MinkSuite, file: string, annoId?: string): Promise<void> {
  const { MdSidebarView } = await import('./sidebar');
  const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_MD_SIDEBAR);
  let leaf;
  if (existing.length) {
    leaf = existing[0];
  } else {
    leaf = plugin.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_MD_SIDEBAR, active: true });
  }
  plugin.app.workspace.revealLeaf(leaf);
  const view = leaf.view;
  if (view instanceof MdSidebarView) {
    await view.setTarget(file, annoId);
  }
}
