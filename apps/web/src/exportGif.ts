/**
 * exportGif.ts — 情景模拟「路线演示动画」导出 GIF（0919 三修：canvas 直绘）
 *
 * 机制：情景高亮 = computeScenario(nodes, edges, variables, steps) 纯函数输出的
 * activeNodes/activeEdges；steps 是有序决策序列（ScenarioStep[]）。导出 = 按前缀
 * 逐步重放，每段用 reveal(0→1) 缓动插值把新点亮节点/边从 dim 渐入，活跃边画
 * 连续流动虚线（lineDashOffset 逐帧推进）。
 *
 * 与 v1/v2 的本质区别：不再用 html-to-image 克隆整个视口 DOM（单帧 ~200ms 的
 * 常数项瓶颈），而是「一次性」读出几何后逐帧在离屏 canvas 重画（单帧 ~2ms），
 * 因此能上 20fps + 真·逐帧插值流动，苹果滑块式连贯。
 *
 * 编码：gifenc（扁平矢量图友好），逐帧 getImageData → quantize(256) → writeFrame。
 * 保存：桌面 = save dialog + export_save_bytes；纯 Web = a.download。
 */
import type { ReactFlowInstance, Edge } from '@xyflow/react';
import type { SopFlowNode } from '@flow/canvas';
import { computeScenario, type FlowNode, type FlowEdge, type FlowVariable } from '@flow/core';
import type { ScenarioStep } from '@flow/core';
import { isDesktop } from './vault';
import { readGeometry, drawFrame, type FrameState } from './gifRender';

export interface ExportGifOptions {
  rf: ReactFlowInstance<SopFlowNode>;
  /** 截图容器：.react-flow__viewport（仅用于 readGeometry 取边 path；不再逐帧克隆） */
  viewportEl: HTMLElement;
  docName: string;
  /** 要重放的有序决策序列（当前情景的 store.steps 快照） */
  steps: ScenarioStep[];
  /** 核心图（react-flow 数据），computeScenario 只用 id/source/target，内部转 flow-core 类型 */
  nodes: FlowNode[];
  edges: Edge[];
  variables: FlowVariable[];
  /** 帧进度回调（导出期间 UI 提示） */
  onProgress?: (done: number, total: number, msg: string) => void;
  backgroundColor?: string;
}

/** 渲染画布尺寸（4:3；canvas 直绘很便宜，可上分辨率换清晰度） */
const OUT_W = 820;
const OUT_H = 615;
/** 内容边距 */
const MARGIN = 28;
/** 首帧定格（观众先看到起点全貌） */
const HEAD_MS = 420;
/** 每段帧数（reveal 0→1 的插值采样数） */
const FRAMES_PER_SEG = 10;
/** GIF 播放帧 delay（50ms ≈ 20fps；浏览器对 <100ms 普遍按实际播放，比 v2 的 10fps 丝滑一倍） */
const PLAY_MS = 50;
/** 段末定格（亮起后停留，看清再走） */
const STABLE_MS = 320;
/** 流动虚线每帧推进量（流程坐标系 px；逐帧递增制造「沿线流动」连续动效） */
const DASH_STEP = 5;
/** 总帧硬上限 */
const MAX_FRAMES = 220;

interface GifEncoderLike {
  writeFrame: (index: Uint8Array, w: number, h: number, opts?: object) => void;
  finish: () => void;
  bytes: () => Uint8Array;
}

export async function exportFlowGif(opts: ExportGifOptions): Promise<void> {
  const {
    rf,
    docName,
    steps,
    nodes,
    edges,
    variables,
    onProgress,
    backgroundColor = '#ffffff',
  } = opts;
  const N = steps.length;
  if (N === 0) throw new Error('先走一条路线（逐个给变量取值，或点「一键示例路线」），再导出 GIF');

  /* 一次性几何（节点矩形 + 边 path d + 标签坐标 + 主题色）；命中集合由 computeScenario
   * 按前缀独立算，不改动实时画布，导出期间无闪烁 */
  const geo = readGeometry(rf);

  /* 每个前缀 k 的命中集合（k=0..N）。
   * react-flow 的 Edge.type 是可选（string | undefined），flow-core 的 FlowEdge.type 必填；
   * computeScenario 不消费 type，故内部安全强转（字段 id/source/target 完全对齐）。 */
  const coreEdges = edges as unknown as FlowEdge[];
  const sets: { nodes: Set<string>; edges: Set<string> }[] = [];
  for (let k = 0; k <= N; k++) {
    const r = computeScenario(nodes, coreEdges, variables, steps.slice(0, k));
    sets.push({ nodes: r.activeNodes, edges: r.activeEdges });
  }

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

  const paintSet = (
    cur: { nodes: Set<string>; edges: Set<string> },
    prev: { nodes: Set<string>; edges: Set<string> },
    reveal: number,
    routeDone: boolean,
    dashPhase: number,
  ): void => {
    paint({
      activeNodes: cur.nodes,
      activeEdges: cur.edges,
      prevNodes: prev.nodes,
      prevEdges: prev.edges,
      reveal,
      dashPhase,
      routeDone,
      focusAll: false,
    });
  };

  const paint = (state: FrameState) => {
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
   * 「导出中 n/total…」中间态（大图导出时用户也看不到进度）。每次 onProgress
   * 后让一个宏任务，React 即可 flush 并重绘按钮。 */
  const yieldToPaint = () => new Promise<void>((r) => setTimeout(r, 0));

  let done = 0;
  let dashPhase = 0;
  let total = 1 + N * FRAMES_PER_SEG;
  if (total > MAX_FRAMES) {
    throw new Error(`这条路线有 ${N} 步决策，GIF 帧数会超上限（${total} > ${MAX_FRAMES}）；先少走几步再导出`);
  }
  onProgress?.(0, total, '绘制');
  await yieldToPaint();

  /* 首帧：起点全貌（reveal=1，dash 起始） */
  paintSet(sets[0], sets[0], 1, false, dashPhase);
  delays.push(HEAD_MS);
  onProgress?.(++done, total, '起点');
  await yieldToPaint();

  for (let k = 1; k <= N; k++) {
    const prev = sets[k - 1];
    const active = sets[k];
    const routeDone = k === N;
    for (let i = 0; i < FRAMES_PER_SEG; i++) {
      const reveal = (i + 1) / FRAMES_PER_SEG;
      dashPhase += DASH_STEP;
      paintSet(active, prev, reveal, routeDone, dashPhase);
      const last = i === FRAMES_PER_SEG - 1;
      delays.push(last ? STABLE_MS : PLAY_MS);
      onProgress?.(++done, total, `第 ${k} 段`);
      await yieldToPaint();
    }
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
      defaultPath: `${safeName}-情景演示.gif`,
      filters: [{ name: 'GIF 动图', extensions: ['gif'] }],
    });
    if (!p) return; /* 用户取消：静默返回 */
    const b64 = await blobToBase64(blob);
    await invoke('export_save_bytes', { path: p, b64 });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = `${safeName}-情景演示.gif`;
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
