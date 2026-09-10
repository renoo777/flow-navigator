/**
 * exportGif.ts — 情景演练「当前高亮状态」导出 GIF
 *
 * 语义（0920 v3 定下来的，保持不变）：不重放过程演示 —— 直接把此刻画布上的
 * 高亮 + 流动状态导成一段首尾无缝的循环动图（高亮不动，只有活跃边的虚线在流）。
 *
 * 0922 重写「大图必糊」（用户实测：50～70 节点导出一片糊、字看不见）：
 *   病因：输出画布被写死成长边 820 / 1600，大图缩放比被压到 0.1～0.3，
 *        13px 正文只剩 2～4 个物理像素；且文字是 canvas fillText 手工画的，
 *        8px 下限 + 256 色量化后彻底糊成一团。
 *
 *   新方案 =「矢量高清底图 + 逐帧只重画连线」：
 *     ① 取景改为整图（内容 1:1）＋超采样，分辨率由 planExportSize 统一规划
 *       （默认 2×，撞浏览器画布上限才回退），与 PNG 共用同一套清晰度口径；
 *     ② 底图用 html-to-image 采一次 —— 节点文字是**真 DOM 文字**按矢量重新栅格化，
 *       再大再多的节点都清晰，话术层卡片、富文本标题也都原样保留；
 *       采样瞬间给视口加 .gif-export：把 DOM 连线描边设为透明（由 canvas 逐帧重画），
 *       并停掉 dash 动画，避免采到随机相位的静态虚线；
 *     ③ 每帧 = 背景 → 连线层（流动虚线）→ 底图盖上去。底图背景透明、节点不透明，
 *       于是节点自然遮住连线，层次与画布完全一致；
 *     ④ 调色板只在首帧算一次（全局调色板）：每帧颜色几乎不变，
 *       既消除逐帧换色板的闪烁，又省掉 N-1 次 256 色量化。
 *
 * 编码：gifenc（扁平矢量图友好），逐帧 getImageData → applyPalette → writeFrame。
 * 保存：桌面 = save dialog + export_save_bytes；纯 Web = a.download。
 */
import type { ReactFlowInstance } from '@xyflow/react';
import type { SopFlowNode } from '@flow/canvas';
import { planExportSize, GIF_PRESET } from '@flow/core';
import {
  readGeometry,
  drawFrame,
  drawEdgeLayer,
  DASH_CYCLE,
  type FrameState,
} from './gifRender';
import { saveBlobFile } from './saveBlob';

export interface ExportGifOptions {
  rf: ReactFlowInstance<SopFlowNode>;
  docName: string;
  /** 当前画布上高亮的节点（情景演练 = scenario.activeNodes；编辑态 = 全部节点） */
  activeNodes: Set<string>;
  /** 当前画布上高亮的连线（同上） */
  activeEdges: Set<string>;
  /** 整条路线已确定（末态）：整体辉光增强 */
  routeDone?: boolean;
  /** 全图视角（路线外节点也保持常亮） */
  focusAll?: boolean;
  /** 帧进度回调（导出期间 UI 提示） */
  onProgress?: (done: number, total: number, msg: string) => void;
  backgroundColor?: string;
}

/** 一轮循环的总时长（ms）：虚线流速 ≈ 20px/s，与画布上 CSS dash-flow 观感一致 */
const LOOP_MS = 2400;

interface GifEncoderLike {
  writeFrame: (index: Uint8Array, w: number, h: number, opts?: object) => void;
  finish: () => void;
  bytes: () => Uint8Array;
}

/** 帧数随画面像素自适应：GIF 是逐帧编码，像素越多单帧越贵，
 *  用「少几帧 + 每帧长一点」换总时长不变（循环仍然是 LOOP_MS）。 */
function framesFor(pixels: number): number {
  if (pixels > 20_000_000) return 14;
  if (pixels > 12_000_000) return 18;
  if (pixels > 6_000_000) return 24;
  if (pixels > 2_500_000) return 32;
  return 40;
}

export async function exportFlowGif(opts: ExportGifOptions): Promise<void> {
  const { rf, docName, activeNodes, activeEdges, routeDone = false, focusAll = false, onProgress } = opts;

  /* 一次性几何（节点矩形 + 边 path d + 标签坐标 + 主题色） */
  const geo = readGeometry(rf);
  if (!geo.nodes.length) throw new Error('画布是空的，先画点东西再导出 GIF');
  const backgroundColor = opts.backgroundColor ?? geo.palette.bg ?? '#ffffff';

  /* ① 整图取景 + 超采样：与 PNG 同一套清晰度口径（内容 1:1，不再整体缩小） */
  const plan = planExportSize(
    { boundsW: geo.bbox.w || 1, boundsH: geo.bbox.h || 1 },
    GIF_PRESET,
  );
  const { cssW, cssH, ratio, outW: OUT_W, outH: OUT_H } = plan;
  const zoom = plan.zoom;
  const vpX = (cssW - geo.bbox.w * zoom) / 2 - geo.bbox.x * zoom;
  const vpY = (cssH - geo.bbox.h * zoom) / 2 - geo.bbox.y * zoom;
  /* flow → 输出像素 */
  const s = zoom * ratio;
  const tx = vpX * ratio;
  const ty = vpY * ratio;

  const LOOP_FRAMES = framesFor(OUT_W * OUT_H);
  /** 一轮里虚线走几个周期（帧数少就少走一圈，避免每帧跳太远） */
  const DASH_CYCLES = LOOP_FRAMES >= 28 ? 3 : 2;
  /** 每帧虚线相位步长：均分整数个周期 → 循环无缝（与帧数无关） */
  const DASH_STEP = (DASH_CYCLES * DASH_CYCLE) / LOOP_FRAMES;
  const DELAY_CS = Math.max(2, Math.round(LOOP_MS / LOOP_FRAMES / 10));

  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');

  /* ② 矢量高清底图（采一次，之后每帧复用） */
  const viewportEl = document.querySelector<HTMLElement>(
    '.canvas-wrap .react-flow__viewport',
  ) ?? document.querySelector<HTMLElement>('.react-flow__viewport');
  let base: HTMLCanvasElement | null = null;
  if (viewportEl) {
    viewportEl.classList.add('gif-export');
    try {
      const { toCanvas } = await import('html-to-image');
      onProgress?.(0, LOOP_FRAMES, '取景');
      base = await toCanvas(viewportEl, {
        width: cssW,
        height: cssH,
        pixelRatio: ratio,
        style: {
          width: `${cssW}px`,
          height: `${cssH}px`,
          transform: `translate(${vpX}px, ${vpY}px) scale(${zoom})`,
          transformOrigin: 'top left',
        },
        cacheBust: true,
      });
    } catch {
      base = null; /* 采底图失败 → 退回全 canvas 直绘（清晰度打折但不会失败） */
    } finally {
      viewportEl.classList.remove('gif-export');
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('取不到绘制上下文');

  /* 当前状态：prev 集合与 active 相同 → reveal 视为已完成（alpha/辉光直接满值），
   * 因此画面上是"已经亮着"的稳态，只有 dashPhase 在推进。 */
  const paintAt = (dashPhase: number) => {
    const state: FrameState = {
      activeNodes,
      activeEdges,
      prevNodes: activeNodes,
      prevEdges: activeEdges,
      reveal: 1,
      dashPhase,
      routeDone,
      focusAll,
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    if (base) {
      /* ③ 先画连线（含流动虚线），再把透明底的矢量底图盖上去 → 节点自然遮住连线 */
      ctx.setTransform(s, 0, 0, s, tx, ty);
      drawEdgeLayer(ctx, geo, state, s);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(base, 0, 0, OUT_W, OUT_H);
    } else {
      ctx.setTransform(s, 0, 0, s, tx, ty);
      drawFrame(ctx, geo, state, s);
    }
  };

  /* 让出主线程：逐帧绘制是同步 CPU 工作，若不让出 React 永远没机会渲染
   * 「导出中 n/total…」中间态（大图导出时用户也看不到进度）。 */
  const yieldToPaint = () => new Promise<void>((r) => setTimeout(r, 0));

  const gif = GIFEncoder() as GifEncoderLike;
  let palette: number[][] | null = null;
  let done = 0;
  onProgress?.(0, LOOP_FRAMES, '绘制');
  await yieldToPaint();

  for (let i = 0; i < LOOP_FRAMES; i++) {
    paintAt(i * DASH_STEP);
    const { data } = ctx.getImageData(0, 0, OUT_W, OUT_H);
    /* ④ 全局调色板：只量化首帧，其余帧复用。
     *  注意 palette 只在首帧写进流里（gifenc：非首帧带 palette 会多写一张
     *  768 字节的局部色表，还会让各帧颜色各自取整）—— 后续帧用全局色表解码。 */
    if (!palette) palette = quantize(data, 256);
    gif.writeFrame(
      applyPalette(data, palette),
      OUT_W,
      OUT_H,
      i === 0 ? { palette, delay: DELAY_CS } : { delay: DELAY_CS },
    );
    onProgress?.(++done, LOOP_FRAMES, '绘制');
    await yieldToPaint();
  }

  onProgress?.(done, LOOP_FRAMES, '编码 GIF');
  await yieldToPaint();
  gif.finish();
  const bytes = gif.bytes();

  const safeName = (docName || 'flow').replace(/[\\/:*?"<>|]/g, '_');
  await saveBlobFile(new Blob([bytes as unknown as BlobPart], { type: 'image/gif' }), `${safeName}-情景流动.gif`, [
    { name: 'GIF 动图', extensions: ['gif'] },
  ]);
  onProgress?.(done, LOOP_FRAMES, '完成');
}
