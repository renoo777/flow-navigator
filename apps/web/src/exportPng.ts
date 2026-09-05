/** 编辑器 PNG 图片导出（依赖懒加载 html-to-image，按 RF 视口 bounds 渲染全图） */
import { getViewportForBounds, type ReactFlowInstance } from '@xyflow/react';
import type { SopFlowNode } from '@flow/canvas';

export async function exportFlowPng(
  rf: ReactFlowInstance<SopFlowNode>,
  viewportEl: HTMLElement,
  docName: string,
  opts: { backgroundColor?: string; width?: number; height?: number; pixelRatio?: number } = {}
): Promise<void> {
  const { backgroundColor = '#ffffff', width = 1600, height = 1000, pixelRatio = 2 } = opts;
  const nodes = rf.getNodes();
  if (!nodes.length) return;
  const bounds = rf.getNodesBounds(nodes);
  const vp = getViewportForBounds(bounds, width, height, 0.5, 2, 0.1);
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