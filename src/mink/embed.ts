import { TFile } from 'obsidian';
import type { MinkSuite } from '../main';
import { preloadImages, readDoc, renderMinkPageToCanvas } from './file';

/** 在 Markdown 中嵌入预览 ![[x.mink]]（只读缩略渲染，点击打开） */
export function registerMinkEmbed(plugin: MinkSuite): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    window.setTimeout(() => {
      const embeds = el.querySelectorAll<HTMLElement>('.internal-embed');
      for (const embed of Array.from(embeds)) {
        const src = embed.getAttribute('src') ?? '';
        if (!src.toLowerCase().endsWith('.mink') || embed.dataset.minkEmbedded === '1') continue;
        embed.dataset.minkEmbedded = '1';
        const file = plugin.app.metadataCache.getFirstLinkpathDest(src, ctx.sourcePath);
        if (!(file instanceof TFile)) continue;
        void renderMinkEmbed(plugin, embed, file);
      }
    }, 60);
  });
}

async function renderMinkEmbed(plugin: MinkSuite, embed: HTMLElement, file: TFile): Promise<void> {
  try {
    const doc = await readDoc(plugin.app, file);
    const images = await preloadImages(plugin.app, doc.objects);
    const wrap = embed.createEl('div', { cls: 'mink-embed-wrap' });
    embed.setCssStyles({ textAlign: 'left' });

    const pageCount = doc.pages.length;
    const maxW = Math.min(680, embed.clientWidth || 680);
    // 最多渲染前 3 页缩略
    for (let i = 0; i < Math.min(3, pageCount); i++) {
      const canvas = await renderMinkPageToCanvas(plugin.app, doc.pages[i], doc.objects, maxW, images);
      canvas.addClass('mink-embed-canvas');
      wrap.appendChild(canvas);
    }
    if (pageCount > 3) {
      wrap.createEl('div', { cls: 'mink-embed-more', text: `共 ${pageCount} 页，点击打开查看全部` });
    }
    wrap.addEventListener('click', () => {
      void plugin.app.workspace.openLinkText(file.path, '', false);
    });
  } catch (e) {
    console.warn('[mink-suite] embed render failed', e);
  }
}
