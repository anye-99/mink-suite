import type { AnnoObject } from '../types';
import type { MinkSuite } from '../main';
import { drawObject } from '../ink/render';
import { objectBBox } from '../ink/render';
import { blobToDataUrl, canvasToBlob } from '../core/snapshot';

/** 把批注对象渲染为独立 PNG（白底），供 AI 视觉转文字 */
export async function renderAnnoToDataUrl(anno: AnnoObject): Promise<string | null> {
  const box = objectBBox(anno);
  if (!box || box.w <= 0 || box.h <= 0) return null;
  const pad = 20;
  const scale = Math.min(4, Math.max(1.5, 600 / Math.max(box.w, box.h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((box.w + pad * 2) * scale);
  canvas.height = Math.round((box.h + pad * 2) * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(pad * scale - box.x * scale, pad * scale - box.y * scale);
  ctx.scale(scale, scale);
  drawObject(ctx, anno, 1);
  const blob = await canvasToBlob(canvas);
  return blobToDataUrl(blob);
}

/** 手写笔迹 → AI 视觉转文字（要求已配置 vision 模型） */
export async function inkToText(plugin: MinkSuite, anno: AnnoObject): Promise<string> {
  const dataUrl = await renderAnnoToDataUrl(anno);
  if (!dataUrl) throw new Error('批注内容为空，无法转文字');
  if (!plugin.ai.configured()) throw new Error('AI 未配置：请在设置中填写 AI 接口');
  const model = plugin.settings.aiVisionModel || plugin.settings.aiModel;
  return plugin.ai.chat(
    [
      {
        role: 'user',
        content: '请识别图中的手写文字或图形内容，仅输出转写文本，不要解释。',
        images: [dataUrl],
      },
    ],
    { model },
  );
}
