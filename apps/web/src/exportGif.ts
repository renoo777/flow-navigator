/**
 * exportGif.ts — 情景模拟「路线演示动画」导出 GIF（0918 v2：连贯丝滑）
 *
 * 机制：情景高亮 = computeScenario(nodes, edges, variables, steps) 纯函数输出的
 * activeNodes/activeEdges；steps 是有序决策序列（ScenarioStep[]）。导出 = 按前缀
 * 逐步重放（advance(k) 把 store.steps 设为 slice(0,k)），命中链路经 CSS transition
 * 渐亮。v1 卡顿根因：过渡基线仅 200ms，每段只在 t≈90ms 截 1 帧中间态 → GIF 里
 * 一段「亮起」只有半亮→全亮两帧，10fps 硬切跳变。
 *
 * v2 录制节奏（对齐「苹果滑块」式连贯）：
 *   · 注入 .gif-exporting 样式把画布内 transition 拉长到 D = step×8，与每段
 *     8 帧采样窗口 1:1 —— 在过渡窗口内均匀截 7 帧真实中间态 + 1 帧全亮，
 *     CSS ease 曲线自带缓动，播放=录制 → 连续不跳变。
 *   · 段末全亮帧单独停留 450ms：亮起 → 看清 → 再走。
 *   · 截帧间隔 step 按首帧实测截图耗时自适应（≈1.5×T，≥70ms），逐帧不漂移；
 *     虚线流动/流光相位在 GIF 内匀速推进。
 *   · 末段（路线确定 route-done）均匀采样 route-sheen 流光收尾，再定格一帧。
 *
 * 编码：gifenc（纯 JS、官方适配扁平矢量图），逐帧 toCanvas → getImageData →
 * quantize(256) → writeFrame（每帧独立 delay）。保存：桌面 = save dialog +
 * export_save_bytes；纯 Web = a.download。
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

/** 渲染画布尺寸：GIF 按内容 bounds 适配；缩小到 600×450 让单帧 toCanvas + quantize 总耗时 < 80ms，给 10+fps 节奏感留余量。 */
const OUT_W = 600;
const OUT_H = 450;
/** 首帧定格时长（GIF delay：观众先看到起点全貌） */
const HEAD_MS = 500;
/** 每段帧数 = 7 过渡中间帧 + 1 全亮/流光帧 */
const FRAMES_PER_SEG = 8;
/** 非末段全亮帧的 GIF delay：亮起后停留，形成节奏感 */
const STABLE_MS = 450;
/** 末段流光结束后定格帧的 GIF delay */
const FINAL_MS = 600;
/** 流光目标时长下限（真实时长 = max(900, step×8)，与采样窗口同步） */
const SHEEN_MIN_MS = 900;
/** 截帧间隔下限（截图吞吐慢的大图自适应拉大；step 只决定录制节奏与采样精度，不影响 GIF 播放速度） */
const MIN_STEP_MS = 70;
/** GIF 播放帧间 delay（与 step 解耦：录制可慢保证不漂移，播放紧凑 100ms = 10fps 苹果滑块节奏） */
const GIF_PLAY_DELAY_MS = 100;
/** 渲染提交缓冲：advance() 后等 React flush + transition 启动 */
const RENDER_SETTLE_MS = 60;
/** 总帧硬上限（超出提示图太复杂） */
const MAX_FRAMES = 140;

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

  /* —— 导出专用慢过渡：录制窗口与过渡时长 1:1，每个截图时刻都是真实中间态 —— */
  let cssEl: HTMLStyleElement | null = null;
  const setSlowMotion = (durMs: number, animMs: number) => {
    removeSlowMotion();
    cssEl = document.createElement('style');
    cssEl.id = 'gif-export-slowmotion';
    cssEl.textContent = `
      .gif-exporting .react-flow__node,
      .gif-exporting .react-flow__edge,
      .gif-exporting .sop-node,
      .gif-exporting .react-flow__edge-path {
        transition: box-shadow ${durMs}ms ease, opacity ${durMs}ms ease,
                    filter ${durMs}ms ease, stroke ${durMs}ms ease,
                    stroke-width ${durMs}ms ease !important;
        transition-delay: 0ms !important;
      }
      .gif-exporting .react-flow__edge.route-on:not(.route-done) .react-flow__edge-path,
      .gif-exporting .sop-node.route-done::after {
        animation-duration: ${animMs}ms !important;
      }`;
    document.head.appendChild(cssEl);
    document.querySelector('.canvas-wrap')?.classList.add('gif-exporting');
  };
  const removeSlowMotion = () => {
    cssEl?.remove();
    cssEl = null;
    document.querySelector('.canvas-wrap')?.classList.remove('gif-exporting');
  };

  const { toCanvas } = await import('html-to-image');
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');

  const frames: { index: Uint8Array; palette: number[][] }[] = [];
  const delays: number[] = [];
  let w = 0;
  let h = 0;
  let done = 0;

  /** 截一帧，返回耗时（ms）。cacheBust:false 让浏览器复用字体/图片缓存，单帧耗时从 ~300ms 砍到 ~30-60ms，节奏感才出得来。 */
  const shot = async (): Promise<number> => {
    const t0 = performance.now();
    /* 排除 minimap/controls/attribution（这些 DOM 节点 clone 开销大但不参与演示动画） */
    const canvas = await toCanvas(viewportEl, {
      backgroundColor,
      width: OUT_W,
      height: OUT_H,
      pixelRatio: 1,
      style: shotStyle,
      cacheBust: false,
      filter: (node: Element) => {
        const cls = (node.className?.toString?.() ?? '');
        if (/react-flow__minimap|react-flow__controls|react-flow__attribution|react-flow__panel/.test(cls)) return false;
        return true;
      },
    });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('取不到截图上下文');
    const { data, width: cw, height: ch } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    w = cw;
    h = ch;
    /* GIF 调色阶数：流程图是扁平色块风，64 色几乎看不出色带；砍到 64 让 quantize 计算量 ↓ 4x */
    const palette = quantize(data, 64);
    frames.push({ index: applyPalette(data, palette), palette });
    return performance.now() - t0;
  };

  try {
    /* 占位慢过渡（head 截图后按实测耗时校正）+ 首帧定格：k=0 初始态 */
    advance(0);
    setSlowMotion(1000, 1000);
    await wait(HEAD_MS);
    /* warmup：首次 toCanvas 要做字体加载/缓存热身（~200ms），丢弃。第二次起 <60ms */
    await shot();
    frames.length = 0;
    /* 真实 head 帧：从此处开始计 delays/frames */
    const headShotMs = await shot();
    delays.push(HEAD_MS);
    done = 1;

    /* —— 帧率自适应：帧间隔必须 ≥ 截图耗时，否则逐帧漂移、动画发虚 —— */
    const step = Math.max(MIN_STEP_MS, Math.ceil((headShotMs * 1.5) / 10) * 10);
    const transMs = step * FRAMES_PER_SEG; /* 每段过渡窗口 */
    const animMs = Math.max(SHEEN_MIN_MS, transMs); /* 流光/虚线循环周期 */
    setSlowMotion(transMs, animMs);

    /* 总帧数：head + 每段 8 帧（末段同样 7 中间 + 1 定格，删 sheen 多余帧） */
    const total = 1 + N * FRAMES_PER_SEG;
    if (total > MAX_FRAMES) {
      throw new Error(`这条路线有 ${N} 步决策，GIF 帧数会超上限（${total} > ${MAX_FRAMES}）；先少走几步再导出`);
    }
    onProgress?.(done, total, '截帧');

    const waitUntil = async (target: number) => {
      const remain = target - performance.now();
      if (remain > 0) await wait(remain);
    };

    for (let k = 1; k <= N; k++) {
      const pushAt = performance.now();
      advance(k); /* 推进前缀：命中元素 class 变化 → 慢过渡开始 */
      await wait(RENDER_SETTLE_MS); /* 等 React flush + transition 真正开跑 */

      /* —— 过渡中间帧 i=1..7：按绝对相位均匀采样 —— */
      for (let i = 1; i < FRAMES_PER_SEG; i++) {
        await waitUntil(pushAt + (transMs * i) / FRAMES_PER_SEG);
        await shot();
        delays.push(GIF_PLAY_DELAY_MS);
        onProgress?.(++done, total, `第 ${k} 段`);
      }
      /* 末帧：过渡走完，给一段 GIF delay 让观众看清/收尾（末段多停一点当收尾定格） */
      await waitUntil(pushAt + transMs);
      await shot();
      delays.push(k === N ? FINAL_MS : STABLE_MS);
      onProgress?.(++done, total, k === N ? '完成' : `第 ${k} 段完成`);
    }

    onProgress?.(done, total, '编码 GIF');
    const gif = GIFEncoder() as GifEncoderLike;
    for (let idx = 0; idx < frames.length; idx++) {
      const f = frames[idx];
      gif.writeFrame(f.index, w, h, { palette: f.palette, delay: delays[idx] ?? step });
    }
    gif.finish();
    const bytes = gif.bytes();

    await saveGif(new Blob([bytes as unknown as BlobPart], { type: 'image/gif' }), docName);
    onProgress?.(done, total, '完成');
  } finally {
    removeSlowMotion();
  }
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
