/**
 * gifRender.ts — 情景演示 GIF 的「canvas 直绘」渲染层（0919 三修：绕开 DOM 克隆）
 *
 * 旧方案（v1/v2）用 html-to-image 把整个 .react-flow__viewport 克隆成 SVG 再截屏，
 * 单帧 ~200ms（DOM clone + 内联样式遍历是常数项），导致 GIF 只能 10fps、且无法做
 * 逐帧插值的真·流动。
 *
 * 新方案：导出开始时「一次性」从实时 DOM/store 读出几何（节点矩形、边 path d、标签坐标、
 * 主题 CSS 变量），之后每一帧直接在离屏 canvas 上重画——单帧 ~2ms，彻底去掉克隆瓶颈。
 * 动效完全由我们控制：
 *   · 活跃边 = 连续流动的虚线（lineDashOffset 逐帧推进），不再靠 CSS 动画快照；
 *   · 新点亮节点/边 = reveal(0→1) 缓动插值（alpha + 辉光），苹果滑块式连贯。
 *
 * 颜色全部读 CSS 变量 → 自动适配深/浅主题，与画布观感一致。
 */
import type { ReactFlowInstance } from '@xyflow/react';
import type { SopFlowNode } from '@flow/canvas';
import type { NodeKind } from '@flow/core';

export interface NodeGeo {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: NodeKind;
  label: string;
  rail: string;
}

export interface EdgeGeo {
  id: string;
  d: string;
  label: string;
  lx: number;
  ly: number;
}

export interface ThemePalette {
  bg: string;
  surface: string;
  surface2: string;
  ink: string;
  ink3: string;
  edgeIdle: string;
  edgeRoute: string;
  edgeOff: string;
  loop: string;
  routeLabelFg: string;
  routeLabelBg: string;
  selected: string;
}

export interface FlowGeometry {
  nodes: NodeGeo[];
  edges: EdgeGeo[];
  bbox: { x: number; y: number; w: number; h: number };
  palette: ThemePalette;
}

export interface FrameState {
  activeNodes: Set<string>;
  activeEdges: Set<string>;
  /** 上一前缀的命中集合，用于 reveal 插值时判断「哪些是新点亮的元素」 */
  prevNodes: Set<string>;
  prevEdges: Set<string>;
  /** 本段过渡进度 0..1（新点亮元素从 dim→bright 的插值因子） */
  reveal: number;
  /** 流动虚线相位（逐帧递增，制造「沿线流动」的连续动效） */
  dashPhase: number;
  /** 整条路线已确定（末段）：整体辉光增强 */
  routeDone: boolean;
  focusAll: boolean;
}

const DIM = 0.16;

/** 0920 · 流动虚线的周期常量（虚线段长 + 间隔）。
 *  必须导出给 exportGif：循环 GIF 要让「总位移 = 整数个周期」才能首尾无缝，
 *  否则每圈复位时虚线会跳一下（看着像卡顿）。 */
export const DASH_LEN = 9;
export const DASH_GAP = 7;
export const DASH_CYCLE = DASH_LEN + DASH_GAP; /* 16 */

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function readPalette(): ThemePalette {
  return {
    bg: cssVar('--bg', '#ffffff'),
    surface: cssVar('--surface-1', '#ffffff'),
    surface2: cssVar('--surface-2', '#f1f5f9'),
    ink: cssVar('--ink-1', '#0f172a'),
    ink3: cssVar('--ink-3', '#94a3b8'),
    edgeIdle: cssVar('--edge-idle', '#cbd5e1'),
    edgeRoute: cssVar('--edge-route', '#2563eb'),
    edgeOff: cssVar('--edge-off', '#e2e8f0'),
    loop: '#8b5cf6',
    routeLabelFg: cssVar('--route-label-fg', '#1d4ed8'),
    routeLabelBg: cssVar('--route-label-bg', '#dbeafe'),
    selected: cssVar('--accent', '#2563eb'),
  };
}

/** 解析 SVG path 的包围盒（仅数字对，忽略弧线标志位；本项目不用弧线，安全） */
function pathBBox(d: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const nums = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  if (nums.length < 2) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i];
    const y = nums[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** 一次性读出导出所需的全部几何（节点矩形、边 path、标签坐标、主题色） */
export function readGeometry(rf: ReactFlowInstance<SopFlowNode>): FlowGeometry {
  const nodes = rf.getNodes();
  const ng: NodeGeo[] = [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  const RAIL: Record<NodeKind, string> = {
    'io-start': '#16a34a',
    'io-end': '#dc2626',
    decision: '#d97706',
    step: 'transparent',
  };

  for (const n of nodes) {
    const w = n.measured?.width ?? (n.width as number) ?? 180;
    const h = n.measured?.height ?? (n.height as number) ?? 46;
    const x = n.position.x;
    const y = n.position.y;
    const kind = ((n.data as { kind?: NodeKind })?.kind ?? 'step') as NodeKind;
    const label = ((n.data as { label?: string })?.label ?? '') as string;
    ng.push({ id: n.id, x, y, w, h, kind, label, rail: RAIL[kind] ?? 'transparent' });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  /* 边 path：从实时 DOM 读已渲染的 d（自绘路由复杂，重算风险高；d 已是视口坐标系） */
  const edges: EdgeGeo[] = [];
  const edgeEls = document.querySelectorAll<SVGElement>('.react-flow__edge');
  edgeEls.forEach((el) => {
    const id = el.getAttribute('data-id') ?? '';
    const pathEl = el.querySelector('path.react-flow__edge-path') as SVGPathElement | null;
    const d = pathEl?.getAttribute('d') ?? '';
    if (!d) return;
    const bb = pathBBox(d);
    if (bb) {
      minX = Math.min(minX, bb.minX);
      minY = Math.min(minY, bb.minY);
      maxX = Math.max(maxX, bb.maxX);
      maxY = Math.max(maxY, bb.maxY);
    }
    /* 标签坐标：读 .edge-chip 的 transform translate(Xpx,Ypx)（视口坐标系） */
    let lx = 0,
      ly = 0,
      label = '';
    const chip = document.querySelector<HTMLElement>(`.edge-chip[data-edge-id="${id}"]`)
      ?? el.querySelector<HTMLElement>('.edge-chip');
    if (chip) {
      label = (chip.querySelector('.edge-chip-text')?.textContent ?? '').trim();
      const tr = chip.style.transform;
      const m = tr.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      if (m) {
        lx = parseFloat(m[1]);
        ly = parseFloat(m[2]);
      }
    }
    edges.push({ id, d, label, lx, ly });
  });

  const pad = 48;
  const bbox = {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
  return { nodes: ng, edges, bbox, palette: readPalette() };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 画一帧。ctx 已按「视口坐标 → canvas」映射好（调用方 setTransform）。
 *  0921 可读性下限：竖/横长图 scale 可能被压到 0.1～0.4，若字号/线宽/虚线
 *  继续跟着 scale 缩，文字会小到 1.7px 直接在 GIF 量化中消失。
 *  px = 视觉像素因子（不低于 0.55）：字号/线宽/辉光/虚线用它；
 *  几何坐标（节点矩形、path）仍用真实 scale —— 物理位置不变，
 *  代价是小图中字号可能略微溢出节点框，但「看得到字」远比「框里空白」重要。 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  geo: FlowGeometry,
  state: FrameState,
  scale: number,
): void {
  const p = geo.palette;
  const px = Math.max(scale, 0.55);
  const reveal = easeInOut(Math.max(0, Math.min(1, state.reveal)));

  // —— 背景 ——
  ctx.fillStyle = p.bg;
  ctx.fillRect(-1e5, -1e5, 2e5, 2e5);

  // —— 边（先画全部，再叠活跃边，保证活跃边压在上方）——
  drawEdgeLayer(ctx, geo, state, scale);

  // —— 边标签 chip ——
  for (const e of geo.edges) {
    if (!e.label) continue;
    const active = state.activeEdges.has(e.id);
    ctx.save();
    ctx.globalAlpha = active ? 1 : DIM;
    const chipFont = Math.max(Math.round(11 * px), 7);
    ctx.font = `${chipFont}px system-ui, -apple-system, sans-serif`;
    const tw = ctx.measureText(e.label).width;
    const padX = 6 * px;
    const bw = tw + padX * 2;
    const bh = Math.max(18 * scale, chipFont * 1.4);
    roundRect(ctx, e.lx - bw / 2, e.ly - bh / 2, bw, bh, 5 * px);
    ctx.fillStyle = active ? p.routeLabelBg : p.surface2;
    ctx.fill();
    ctx.fillStyle = active ? p.routeLabelFg : p.ink3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(e.label, e.lx, e.ly + 0.5 * scale);
    ctx.restore();
  }

  // —— 节点 ——
  for (const n of geo.nodes) {
    const active = state.activeNodes.has(n.id);
    const prev = state.prevNodes.has(n.id);
    const bright = active ? (prev ? 1 : reveal) : DIM;

    ctx.save();
    ctx.globalAlpha = Math.max(0.12, bright);

    // 活跃节点辉光（苹果滑块式柔和外阴影）
    if (active) {
      const glow = (prev ? 14 : 14 * reveal) * px + (state.routeDone ? 6 * px : 0);
      ctx.shadowColor = p.edgeRoute;
      ctx.shadowBlur = glow;
    }

    const x = n.x;
    const y = n.y;
    const w = n.w;
    const h = n.h;
    roundRect(ctx, x, y, w, h, 8 * scale);
    ctx.fillStyle = p.surface;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 边框
    ctx.lineWidth = (active ? 1.8 : 1) * scale;
    ctx.strokeStyle = active ? p.edgeRoute : p.edgeOff;
    ctx.stroke();

    // 左彩条（kind rail）
    if (n.rail !== 'transparent') {
      ctx.save();
      roundRect(ctx, x, y, w, h, 8 * scale);
      ctx.clip();
      ctx.fillStyle = n.rail;
      ctx.fillRect(x, y, Math.max(4 * scale, w * 0.06), h);
      ctx.restore();
    }

    // 标签：字号下限 8px，行高随实际字号走；scale 太小时减少折行数避免溢出成灾
    const fontPx = Math.max(Math.round(13 * px), 8);
    ctx.fillStyle = p.ink;
    ctx.font = `${fontPx}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = n.label || '';
    const maxW = w - 12 * px;
    const maxLines = scale >= 0.5 ? 3 : scale >= 0.3 ? 2 : 1;
    const lines = wrapLabel(text, maxW, ctx, maxLines);
    const lh = Math.max(15 * scale, fontPx * 1.25);
    const startY = y + h / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, x + w / 2, startY + i * lh));
    ctx.restore();
  }
}

/**
 * 只画「连线层」（含流动虚线），不画背景 / 节点 / chip。
 *
 * 0922 用途：GIF 导出改为「html-to-image 采一张矢量高清底图（节点文字是真 DOM 文字，
 * 再大再多的节点也清晰）+ 逐帧只重画连线层做虚线流动」。
 * 绘制顺序 = 先画边、再把底图盖上去 —— 底图背景透明、节点不透明，
 * 于是节点自然把连线挡住，与画布上的层次完全一致。
 */
export function drawEdgeLayer(
  ctx: CanvasRenderingContext2D,
  geo: FlowGeometry,
  state: FrameState,
  scale: number,
): void {
  const p = geo.palette;
  const px = Math.max(scale, 0.55);
  const reveal = easeInOut(Math.max(0, Math.min(1, state.reveal)));

  const drawEdge = (e: EdgeGeo, active: boolean, prevActive: boolean) => {
    let alpha: number;
    let stroke: string;
    let width: number;
    if (active) {
      const a = prevActive ? 1 : reveal; // 新点亮：从 dim 渐入
      alpha = 0.2 + 0.8 * a;
      stroke = p.edgeRoute;
      width = 2.8;
    } else {
      alpha = state.focusAll ? 0.5 : DIM;
      stroke = p.edgeOff;
      width = 1.4;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(width * scale, 0.8);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (active) {
      // 连续流动虚线：dashPhase 逐帧递增强制「沿线流动」
      ctx.setLineDash([DASH_LEN * px, DASH_GAP * px]);
      ctx.lineDashOffset = -state.dashPhase * px;
    }
    const path = new Path2D(e.d);
    ctx.stroke(path);
    ctx.setLineDash([]);
    ctx.restore();
  };

  for (const e of geo.edges) {
    const active = state.activeEdges.has(e.id);
    const prev = state.prevEdges.has(e.id);
    if (!active) drawEdge(e, false, prev);
  }
  for (const e of geo.edges) {
    const active = state.activeEdges.has(e.id);
    if (active) drawEdge(e, true, state.prevEdges.has(e.id));
  }
}

function wrapLabel(text: string, maxW: number, ctx: CanvasRenderingContext2D, maxLines = 3): string[] {
  if (!text.includes('\n') && ctx.measureText(text).width <= maxW) return [text];
  const out: string[] = [];
  const hard = text.split('\n');
  for (const seg of hard) {
    let cur = '';
    for (const ch of seg) {
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        out.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    if (out.length >= maxLines) break;
  }
  return out.slice(0, maxLines);
}
