/** 编辑器 PNG 图片导出（依赖懒加载 html-to-image）
 *
 * 0922 重写「大图导出必糊」：
 *   旧实现把任何尺寸的图都压进「长边 2400」的画布 —— 50～70 节点的大图
 *   bounds 动辄 8000～10000px，缩放比被压到 0.2 上下，13px 的正文在输出图里
 *   只剩 2～4 个物理像素，放大就是一团糊（用户实测反馈）。
 *
 * 新原则（用户拍板：不在乎文件体积，只要清晰）：
 *   ① 布局尺寸 = 内容原始尺寸（flow 坐标 1:1，不整体缩小），由 planExportSize 统一算；
 *   ② 输出像素 = 布局尺寸 × 超采样倍率（默认 2×）；
 *   ③ 只有在会撞浏览器画布硬上限时才回退倍率；
 *   ④ 万一还是渲染失败（极端大图 OOM），自动降倍率重试，绝不静默糊图。
 *
 * 输出用 toBlob（不再 toDataURL）：60MP 的图转 base64 会多出 1/3 内存峰值。
 */
import { getViewportForBounds, type ReactFlowInstance } from '@xyflow/react';
import type { SopFlowNode } from '@flow/canvas';
import { planExportSize } from '@flow/core';
import { saveBlobFile } from './saveBlob';

export async function exportFlowPng(
  rf: ReactFlowInstance<SopFlowNode>,
  viewportEl: HTMLElement,
  docName: string,
  opts: { backgroundColor?: string; pixelRatio?: number } = {},
): Promise<void> {
  const { backgroundColor = '#ffffff' } = opts;
  const nodes = rf.getNodes();
  if (!nodes.length) return;
  const bounds = rf.getNodesBounds(nodes);

  const plan = planExportSize({
    boundsW: bounds.width || 1,
    boundsH: bounds.height || 1,
    ...(opts.pixelRatio ? { ratio: opts.pixelRatio } : {}),
  });
  /* minZoom 0.005：配合内容 1:1 的布局，任何尺寸都装得下 */
  const vp = getViewportForBounds(bounds, plan.cssW, plan.cssH, 0.005, 4, plan.pad);

  const { toBlob } = await import('html-to-image');
  const shot = () =>
    toBlob(viewportEl, {
      backgroundColor,
      width: plan.cssW,
      height: plan.cssH,
      pixelRatio: ratio,
      style: {
        width: `${plan.cssW}px`,
        height: `${plan.cssH}px`,
        transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
        transformOrigin: 'top left',
      },
      cacheBust: true,
    });

  let ratio = plan.ratio;
  let blob: Blob | null = null;
  let lastErr: unknown = null;
  /* 最多三轮：原倍率 → 一半 → 四分之一。撞内存上限时至少还能出一张图 */
  for (let attempt = 0; attempt < 3 && !blob; attempt++) {
    try {
      blob = await shot();
    } catch (e) {
      lastErr = e;
    }
    if (!blob) ratio = Math.max(0.15, ratio * 0.5);
  }
  if (!blob) {
    throw new Error(
      `渲染失败（可能是图太大，浏览器画布放不下）${lastErr ? '：' + (lastErr as Error)?.message : ''}`,
    );
  }

  const safeName = (docName || 'flow').replace(/[\\/:*?"<>|]/g, '_');
  await saveBlobFile(blob, `${safeName}.png`, [
    { name: 'PNG 图片', extensions: ['png'] },
  ]);
}
