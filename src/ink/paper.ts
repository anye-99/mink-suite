import type { PaperTemplate } from '../types';

const LINE = '#c3ccd9';
const MARGIN = '#e8590c';

/** 绘制纸张模板（w/h 为像素尺寸） */
export function drawPaper(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  template: PaperTemplate,
): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = LINE;
  ctx.fillStyle = LINE;
  ctx.lineWidth = 1;

  const grid = 28;
  switch (template) {
    case 'lined': {
      const top = 46;
      for (let y = top; y <= h - 12; y += grid) {
        ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(w - 30, y); ctx.stroke();
      }
      ctx.strokeStyle = MARGIN;
      ctx.beginPath(); ctx.moveTo(64, 0); ctx.lineTo(64, h); ctx.stroke();
      break;
    }
    case 'grid': {
      for (let x = grid; x < w; x += grid) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = grid; y < h; y += grid) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      break;
    }
    case 'dots': {
      for (let x = grid; x < w; x += grid) {
        for (let y = grid; y < h; y += grid) {
          ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
        }
      }
      break;
    }
    case 'cornell': {
      const colX = Math.round(w * 0.3);
      const topY = Math.round(h * 0.12);
      ctx.strokeStyle = MARGIN;
      ctx.beginPath(); ctx.moveTo(colX, topY); ctx.lineTo(colX, h - 20); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(20, topY); ctx.lineTo(w - 20, topY); ctx.stroke();
      ctx.strokeStyle = LINE;
      for (let y = topY + grid; y <= h - 12; y += grid) {
        ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(w - 20, y); ctx.stroke();
      }
      break;
    }
    case 'blank':
    default:
      break;
  }
  ctx.restore();
}
