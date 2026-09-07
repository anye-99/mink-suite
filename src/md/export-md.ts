import { Modal, Notice, Setting, TFile } from 'obsidian';
import type { MdAnnotation } from '../types';
import type { MinkSuite } from '../main';

type ExportFormat = 'quote' | 'callout' | 'comment';

/**
 * 批注导出为 Markdown：把当前文件的原文批注写入 .md 正文
 * - 位置：各批注段落下方 / 文末汇总区
 * - 格式：引用块 / Obsidian Callout / %%注释%%（仅源码可见）
 * 可选导出后清除侧车批注（转为正文批注）。
 */
export class MdAnnoExportModal extends Modal {
  private format: ExportFormat = 'quote';
  private atEnd = false;
  private clearAfter = false;
  private previewEl: HTMLElement | null = null;

  constructor(
    private plugin: MinkSuite,
    private file: TFile,
    private annos: MdAnnotation[],
  ) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`导出 ${this.annos.length} 条批注到文件`);
    const { contentEl } = this;

    new Setting(contentEl)
      .setName('插入位置')
      .setDesc('段落下方：批注紧跟对应原文；文末：追加一个批注汇总区')
      .addDropdown(d => {
        d.addOption('inline', '各批注段落下方');
        d.addOption('end', '文末汇总区');
        d.setValue('inline');
        d.onChange(v => { this.atEnd = v === 'end'; this.renderPreview(); });
      });

    new Setting(contentEl)
      .setName('格式')
      .setDesc('引用块与 Callout 在阅读视图可见；%%注释%% 仅源码可见')
      .addDropdown(d => {
        d.addOption('quote', '引用块（> 批注：…）');
        d.addOption('callout', 'Obsidian Callout');
        d.addOption('comment', '%%注释%%（不渲染）');
        d.setValue('quote');
        d.onChange(v => { this.format = v as ExportFormat; this.renderPreview(); });
      });

    new Setting(contentEl)
      .setName('导出后清除侧车批注')
      .setDesc('勾选后批注完全转为正文（编辑器角标与侧栏将清空）；默认保留，两种会并存')
      .addToggle(t => {
        t.setValue(false);
        t.onChange(v => { this.clearAfter = v; });
      });

    const preview = contentEl.createEl('div', { cls: 'mink-export-preview' });
    const renderPreview = () => {
      preview.empty();
      preview.createEl('div', { cls: 'mink-nav-section', text: '预览' });
      const pre = preview.createEl('pre', { cls: 'mink-export-pre' });
      pre.setText(this.blockFor(this.annos[0] ?? {
        id: '', file: this.file.path, line: 0,
        quote: '被批注的原句…', note: '这里是我的批注内容',
        created: 0, modified: 0,
      }, this.atEnd));
    };
    renderPreview();

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('导出')
        .setCta()
        .onClick(() => void this.doExport()))
      .addButton(btn => btn
        .setButtonText('取消')
        .onClick(() => this.close()));
  }

  /** 预览第一条批注的导出效果 */
  private renderPreview(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.createEl('div', { cls: 'mink-nav-section', text: '预览' });
    const pre = this.previewEl.createEl('pre', { cls: 'mink-export-pre' });
    pre.setText(this.blockFor(this.annos[0] ?? {
      id: '', file: this.file.path, line: 0,
      quote: '被批注的原句…', note: '这里是我的批注内容',
      created: 0, modified: 0,
    }, this.atEnd));
  }

  /** 单条批注 → Markdown 文本块 */
  private blockFor(a: MdAnnotation, atEnd: boolean): string {
    const note = a.note.trim() || '（未填写批注）';
    const noteLines = note.split('\n').map(l => l.trim()).filter(Boolean);
    const label = atEnd ? `第 ${a.line + 1} 行批注` : '批注';
    switch (this.format) {
      case 'callout':
        return [
          `> [!note] ✎ ${label}`,
          ...(atEnd ? [`> 「${a.quote}」`] : []),
          ...noteLines.map(l => `> ${l}`),
        ].join('\n');
      case 'comment':
        return [
          `%%✎ ${label}${atEnd ? `：「${a.quote}」` : ''}`,
          ...noteLines,
          '%%',
        ].join('\n');
      default:
        return [
          `> ✎ ${label}${atEnd ? `：「${a.quote}」` : ''}`,
          ...noteLines.map(l => `> ${l}`),
        ].join('\n');
    }
  }

  private async doExport(): Promise<void> {
    try {
      const raw = await this.plugin.app.vault.read(this.file);
      const lines = raw.split('\n');
      let count = 0;

      if (this.atEnd) {
        // 文末汇总区：按行号升序列出
        const sorted = [...this.annos].sort((a, b) => a.line - b.line);
        const blocks = sorted.map(a => this.blockFor(a, true));
        const section = ['', '', '## 📝 Mink 批注', '', ...blocks.join('\n\n').split('\n')];
        lines.push(...section);
        count = sorted.length;
      } else {
        // 段落下插入：按行号降序处理，避免插入导致后续行号位移
        const sorted = [...this.annos].sort((a, b) => b.line - a.line);
        for (const a of sorted) {
          const idx = Math.min(a.line + 1, lines.length); // 插到被批注行的下一行
          lines.splice(idx, 0, '', this.blockFor(a, false));
          count++;
        }
      }

      await this.plugin.app.vault.modify(this.file, lines.join('\n'));

      if (this.clearAfter) {
        for (const a of [...this.annos]) await this.plugin.mdStore.remove(this.file.path, a.id);
      }

      this.close();
      new Notice(`已导出 ${count} 条批注${this.clearAfter ? '（侧车批注已清除）' : ''}`);
    } catch (e) {
      new Notice(`导出失败：${(e as Error).message}`);
    }
  }
}
