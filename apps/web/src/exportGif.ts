/**
 * exportGif.ts — 情景演练「当前画面」导出 GIF（0920 v3：不再重放路线）
 *
 * v1/v2 的做法是"按 steps 前缀逐段重放"：每步决策画一段 reveal 缓动，把一个节点
 * 亮起再顺滑到下一个。用户实测反馈：不想看过程演示，就想把**此刻画面上的高亮 +
 * 流动状态**直接导出去（跟变量选了几个无关）。
 *
 * v3 语义：
 *   · 入参 = 画布当前的高亮集合（activeNodes / activeEdges），由 App 从当前
 *     scenario（或编辑态下的全量节点）直接传入，不做任何 steps 推导、不改动画布；
 *   · 输出 = 一段**首尾无缝的循环动图**：高亮保持当前状态不动，只有活跃边上的
 *     虚线在持续流动 —— 就是你在情景演练里看到的那个流动感；
 *   · 无缝的关键：一个循环内 dash 总位移必须是整数个周期（DASH_CYCLE），
 *     否则每圈复位时虚线会跳一下。
 *
 * 绘制层沿用 0919 的 canvas 直绘（gifRender.ts）：一次性读几何 → 逐帧离屏重画，
 * 单帧 ~2ms，绕开 html-to-image 的 ~200ms/帧 DOM 克隆瓶颈。
 *
 * 编码：gifenc（扁平矢量图友好），逐帧 getImageData → quantize(256) → writeFrame。
 * 保存：桌面 = save dialog + export_save_bytes；纯 Web = a.download。
 */
import type { ReactFlowInstance } from '@xyflow/react';
import type { SopFlowNode } from '@flow/canvas';
import { isDesktop } from './vault';
import { readGeometry, drawFrame, DASH_CYCLE, type FrameState } from './gifRender';

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

/** 渲染画布尺寸（4:3；canvas 直绘很便宜，可上分辨率换清晰度） */
const OUT_W = 820;
const OUT_H = 615;
/** 内容边距 */
const MARGIN = 28;
/** 循环帧数与帧间隔：48 帧 × 50ms = 2.4s 一轮（20fps，浏览器普遍按实际播放） */
const LOOP_FRAMES = 48;
const PLAY_MS = 50;
/** 一轮里虚线走几个周期（3 个 × 16px = 48px，除以 48 帧 → 每帧 1px，约 20px/s，
 *  与画布上 CSS dash-flow 的 ~17.8px/s 观感一致） */
const DASH_CYCLES = 3;
const DASH_STEP = (DASH_CYCLES * DASH_CYCLE) / LOOP_FRAMES;

interface GifEncoderLike {
  writeFrame: (index: Uint8Array, w: number, h: number, opts?: object) => void;
  finish: () => void;
  bytes: () => Uint8Array;
}

export async function exportFlowGif(opts: ExportGifOptions): Promise<void> {
  const {
    rf,
    docName,
    activeNodes,
    activeEdges,
    routeDone = false,
    focusAll = false,
    onProgress,
    backgroundColor = '#ffffff',
  } = opts;

  /* 一次性几何（节点矩形 + 边 path d + 标签坐标 + 主题色） */
  const geo = readGeometry(rf);
  if (!geo.nodes.length) throw new Error('画布是空的，先画点东西再导出 GIF');

  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');

  /* 离屏 canvas（画布直绘，无 DOM 克隆） */
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('取不到绘制上下文');

  const scale = Math.min(
    (OUT_W - 2 * MARGIN) / Math.max(1, geo.bbox.w),
    (OUT_H - 2 * MARGIN) / Math.max(1, geo.bbox.h),
  );
  const contentW = geo.bbox.w * scale;
  const contentH = geo.bbox.h * scale;
  const tx = (OUT_W - contentW) / 2 - geo.bbox.x * scale;
  const ty = (OUT_H - contentH) / 2 - geo.bbox.y * scale;

  const frames: { index: Uint8Array; palette: number[][] }[] = [];
  const delays: number[] = [];

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
    ctx.setTransform(scale, 0, 0, scale, tx, ty);
    drawFrame(ctx, geo, state, scale);
    const { data } = ctx.getImageData(0, 0, OUT_W, OUT_H);
    const palette = quantize(data, 256);
    frames.push({ index: applyPalette(data, palette), palette });
  };

  /* 让出主线程：逐帧绘制是同步 CPU 工作，若不让出 React 永远没机会渲染
   * 「导出中 n/total…」中间态（大图导出时用户也看不到进度）。 */
  const yieldToPaint = () => new Promise<void>((r) => setTimeout(r, 0));

  const total = LOOP_FRAMES;
  let done = 0;
  onProgress?.(0, total, '绘制');
  await yieldToPaint();

  for (let i = 0; i < LOOP_FRAMES; i++) {
    paintAt(i * DASH_STEP);
    delays.push(PLAY_MS);
    onProgress?.(++done, total, '绘制');
    await yieldToPaint();
  }

  onProgress?.(done, total, '编码 GIF');
  const gif = GIFEncoder() as GifEncoderLike;
  for (let idx = 0; idx < frames.length; idx++) {
    const f = frames[idx];
    gif.writeFrame(f.index, OUT_W, OUT_H, { palette: f.palette, delay: delays[idx] ?? PLAY_MS });
  }
  gif.finish();
  const bytes = gif.bytes();

  await saveGif(new Blob([bytes as unknown as BlobPart], { type: 'image/gif' }), docName);
  onProgress?.(done, total, '完成');
}

async function saveGif(blob: Blob, docName: string): Promise<void> {
  const safeName = (docName || 'flow').replace(/[\\/:*?"<>|]/g, '_');
  if (isDesktop) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const p = await save({
      defaultPath: `${safeName}-情景流动.gif`,
      filters: [{ name: 'GIF 动图', extensions: ['gif'] }],
    });
    if (!p) return; /* 用户取消：静默返回 */
    const b64 = await blobToBase64(blob);
    await invoke('export_save_bytes', { path: p, b64 });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = `${safeName}-情景流动.gif`;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const r = fr.result as string;
      resolve(r.slice(r.indexOf(',') + 1));
    };
    fr.onerror = () => reject(fr.error ?? new Error('读 Blob 失败'));
    fr.readAsDataURL(blob);
  });
}
