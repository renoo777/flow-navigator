/**
 * exportGif.ts — 情景模拟「路线演示动画」导出 GIF（0918 MVP）
 *
 * 机制（为何可行）：情景高亮 = computeScenario(nodes, edges, variables, steps)
 * 纯函数输出的 activeNodes/activeEdges；steps 是有序决策序列（ScenarioStep[]）。
 * 导出 = 按前缀逐步重放（advance(k) 由调用方把 store.steps 设为 slice(0,k)），
 * 每推进一段，命中链路经 CSS transition（--dur-base 200ms）渐亮 —— 帧调度在
 * transition 中途截「过渡帧」、结束后截「稳定帧」；末段（路线确定 route-done）
 * 额外等 route-sheen 流光扫过截一组帧，作为 GIF 收尾高潮。
 *
 * 编码：gifenc（纯 JS、官方适配扁平矢量图），每帧 toCanvas → getImageData →
 * quantize(256) → writeFrame。保存：桌面 = save dialog + export_save_bytes 写盘；
 * 纯 Web = a.download 触发浏览器下载。
 */
import { getViewportForBounds, type ReactFlowInstance } from '@xyflow/react';
import type { SopFlowNode } from '@flow/canvas';
import { isDesktop } from './vault';

/** 重放步进（k = 已走的决策数，0..steps.length） */
export type GifAdvance = (k: number) => void;

export interface ExportGifOptions {
  rf: ReactFlowInstance<SopFlowNode>;
  /** 截图容器：.react-flow__viewport（同 exportPng） */
  viewportEl: HTMLElement;
  docName: string;
  /** 要重放的有序决策序列（当前情景的 store.steps 快照） */
  steps: { nodeId: string; edgeId: string }[];
  /** 把画布状态推到「已完成前 k 条决策」的回调（调用方写 store.steps 前缀） */
  advance: GifAdvance;
  /** 帧进度回调（导出期间 UI 提示） */
  onProgress?: (done: number, total: number, msg: string) => void;
  backgroundColor?: string;
}

/** 渲染线宽：GIF 按内容 bounds 适配到固定画布（留白省心，防过度拉伸） */
const OUT_W = 1200;
const OUT_H = 900;
/** 帧率：10fps（GIF 动图通用观感，体积/流畅平衡点） */
const FRAME_DELAY_MS = 100;
/** 前缀段数上限（决策 >15 时按 1 帧/段并降 sheen 帧，防 GIF 超长） */
const MAX_DECISIONS = 15;
/** 总帧硬上限（超出则提示图太复杂） */
const MAX_FRAMES = 52;

interface GifEncoderLike {
  writeFrame: (index: Uint8Array, w: number, h: number, opts?: object) => void;
  finish: () => void;
  bytes: () => Uint8Array;
}

export async function exportFlowGif(opts: ExportGifOptions): Promise<void> {
  const { rf, viewportEl, docName, steps, advance, onProgress, backgroundColor = '#ffffff' } = opts;
  const N = steps.length;
  if (N === 0) throw new Error('先走一条路线（逐个给变量取值，或点「一键示例路线」），再导出 GIF');

  const nodes = rf.getNodes();
  if (!nodes.length) throw new Error('画布为空，没有可导出的流程');

  /* 全图适配视口的 transform（与 PNG 导出同一套：不依赖用户当前视口/缩放） */
  const bounds = rf.getNodesBounds(nodes);
  const vp = getViewportForBounds(bounds, OUT_W, OUT_H, 0.5, 2, 0.08);
  const shotStyle: Record<string, string> = {
    width: `${OUT_W}px`,
    height: `${OUT_H}px`,
    transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
    transformOrigin: 'top left',
  };

  /* —— 帧计划 ——
   * 前缀段 k=0..N（N+1 段）。每段推进后：t≈90ms 截过渡帧（transition 中途，
   * 视觉 = 新一段渐亮），t≈250ms 截稳定帧。末段（k=N，路线确定）等 route-sheen
   * 900ms 流光，每 ~150ms 截一帧收尾。决策多时退化为每段 1 帧控总帧数。 */
  const dense = N <= MAX_DECISIONS;
  const perSegment = dense ? 2 : 1;
  const sheenFrames = dense ? 6 : 3;
  const segmentFrames = (N + 1) * perSegment + sheenFrames;
  if (segmentFrames > MAX_FRAMES) {
    throw new Error(`这条路线有 ${N} 步决策，GIF 帧数会超上限（${segmentFrames} > ${MAX_FRAMES}）；先少走几步或缩短路线再导出`);
  }

  interface PlanItem { k: number; waitMs: number; }
  const plan: PlanItem[] = [];
  /* 首帧：k=0 初始态，多等一拍让画面稳定 */
  advance(0);
  plan.push({ k: 0, waitMs: 500 });
  for (let k = 1; k <= N; k++) {
    if (perSegment === 2) plan.push({ k, waitMs: 90 });
    plan.push({ k, waitMs: k === N ? 320 : 250 });
  }
  /* 末段 sheen 收尾帧（k=N 状态不变，等流光逐帧走） */
  for (let i = 0; i < sheenFrames; i++) plan.push({ k: N, waitMs: 150 });

  const { toCanvas } = await import('html-to-image');
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');

  const frames: { index: Uint8Array; palette: number[][] }[] = [];
  let w = 0;
  let h = 0;
  let done = 0;
  const total = plan.length;
  onProgress?.(0, total, '准备'); /* 先把总帧数报给 UI，避免短暂显示 0/0 */
  const pushFrame = async () => {
    const canvas = await toCanvas(viewportEl, {
      backgroundColor,
      width: OUT_W,
      height: OUT_H,
      pixelRatio: 1,
      style: shotStyle,
      cacheBust: true,
    });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('取不到截图上下文');
    const { data, width: cw, height: ch } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    w = cw;
    h = ch;
    const palette = quantize(data, 256);
    frames.push({ index: applyPalette(data, palette), palette });
    onProgress?.(++done, total, '截帧');
  };

  for (const it of plan) {
    if (it.k > 0) advance(it.k); /* 推进前缀（k=0 首次已提前推进，避免重复渲染第一帧） */
    await wait(it.waitMs); /* 真实等待：让 React 渲染 + CSS transition 走一段 */
    await pushFrame();
  }

  onProgress?.(done, total, '编码 GIF');
  const gif = GIFEncoder() as GifEncoderLike;
  for (const f of frames) {
    gif.writeFrame(f.index, w, h, { palette: f.palette, delay: FRAME_DELAY_MS });
  }
  gif.finish();
  const bytes = gif.bytes();

  await saveGif(new Blob([bytes as unknown as BlobPart], { type: 'image/gif' }), docName);
  onProgress?.(done, total, '完成');
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    /* 二进制经 IPC 命名参数会 JSON 化成对象，先 base64 再写（桌面 GIF ≤ 数 MB 可接受） */
    const b64 = await blobToBase64(blob);
    await invoke('export_save_bytes', { path: p, b64 });
    return;
  }
  /* 纯 Web：a.download 走浏览器下载 */
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
      resolve(r.slice(r.indexOf(',') + 1)); /* 去掉 data:image/gif;base64, 前缀 */
    };
    fr.onerror = () => reject(fr.error ?? new Error('读 Blob 失败'));
    fr.readAsDataURL(blob);
  });
}
