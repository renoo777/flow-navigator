/** 编辑器 PNG 图片导出（依赖懒加载 html-to-image，按 RF 视口 bounds 渲染全图）
 *
 * 0920 修「导出的图被裁剪」：
 *   旧实现固定 1600×1000 画布 + getViewportForBounds(..., minZoom=0.5, maxZoom=2, padding=0.1)，
 *   minZoom=0.5 是硬夹子——图宽超过约 1600/0.5/1.1 ≈ 2900px 后缩放不再变小，
 *   超出画布的部分被直接裁掉（用户看到"流程图只导出了左上角一块"）。
 * 新实现：
 *   ① 画布尺寸按 bounds 长宽比自适应，不再固定 4:3（既不留大片空白，也不挤掉内容）；
 *   ② minZoom 放到 0.01，任何尺寸的图都能完整装下；
 *   ③ pixelRatio 按输出尺寸自适应，避免超宽图渲染出几百 MB 的位图。
 */
import { getViewportForBounds, type ReactFlowInstance } from '@xyflow/react';
import type { SopFlowNode } from '@flow/canvas';

/** 输出最长边的目标像素（够清晰又不至于爆内存） */
const MAX_SIDE = 2400;
/** 输出最短边下限（极扁/极瘦的图也留个体面尺寸） */
const MIN_SIDE = 480;
/** 内容四周留白比例（相对 bounds 尺寸） */
const PAD = 0.06;
/** 小图最大放大倍数（矢量重渲染，放大不糊；再大纯属浪费） */
const MAX_UPSCALE = 2;

export async function exportFlowPng(
  rf: ReactFlowInstance<SopFlowNode>,
  viewportEl: HTMLElement,
  docName: string,
  opts: { backgroundColor?: string; pixelRatio?: number } = {}
): Promise<void> {
  const { backgroundColor = '#ffffff' } = opts;
  const nodes = rf.getNodes();
  if (!nodes.length) return;
  const bounds = rf.getNodesBounds(nodes);
  const bw = Math.max(1, bounds.width);
  const bh = Math.max(1, bounds.height);

  /* ① 画布尺寸跟着图的长宽比走：长边顶到 MAX_SIDE，短边等比 */
  const fitScale = MAX_SIDE / Math.max(bw, bh);
  const scale = Math.min(MAX_UPSCALE, Math.max(0.01, fitScale));
  const width = Math.max(MIN_SIDE, Math.round(bw * (1 + PAD * 2) * scale));
  const height = Math.max(MIN_SIDE, Math.round(bh * (1 + PAD * 2) * scale));

  /* ② minZoom 0.01：配合上面自适应的画布，任何尺寸都不会再被夹住 */
  const vp = getViewportForBounds(bounds, width, height, 0.01, 4, PAD);
  const pixelRatio =
    opts.pixelRatio ?? (width > 2048 ? 1 : 2); /* ③ 超宽图不要 2 倍，避免爆内存 */

  const { toPng } = await import('html-to-image');
  const dataUrl = await toPng(viewportEl, {
    backgroundColor,
    width,
    height,
    pixelRatio,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
      transformOrigin: 'top left',
    },
    cacheBust: true,
  });
  const a = document.createElement('a');
  const safeName = (docName || 'flow').replace(/[\\/:*?"<>|]/g, '_');
  a.download = `${safeName}.png`;
  a.href = dataUrl;
  a.click();
}
