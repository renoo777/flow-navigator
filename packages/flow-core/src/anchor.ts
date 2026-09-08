/** 连线锚点（anchor）：判断一条连线该从节点的哪一侧出发、进入哪一侧
 *
 * ## 为什么需要
 * 早期版本把每条边的端点写死成「下出上进」（sourceHandle='bottom' / targetHandle='top'）。
 * 一旦用户把节点挪成左右关系（或把下游节点拖到上游上方），step 线就会先向下出头再绕回来，
 * 箭头朝向也跟着变得莫名其妙 —— 这就是「连线箭头随位置调整出现奇怪变化」的根因。
 *
 * 真正的画板（飞书 / Figma / Miro）做法是：端点跟着两个图形的相对位置走，
 * 你挪图形，连线自动改从最近的一侧出去。本模块就是这个「自动侧」的判定。
 *
 * ## 判定规则：射线与边框求交（等价于「两点之间最短的连接」）
 * 取两端中心连线方向，看它先从自己盒子的哪条边穿出 —— 那条边就是锚点所在侧。
 * 相比「比较中心点 dx/dy 大小」，射线法在两个卡片尺寸差异大时依然正确：
 * 宽而扁的卡片，纵向只要偏移一点就该从上下出线，而不是被巨大的横向距离带偏。
 *
 * ## 何时不用自动
 * 用户手动把某个端点拖到指定一侧后，该侧被「钉住」（edge.data.anchorPinned），
 * 之后不再自动 —— 否则用户刚摆好的线一挪节点又跳回去。
 */
export type AnchorSide = 'top' | 'right' | 'bottom' | 'left';

/** 参与计算的盒子：左上角 + 宽高（画布坐标） */
export interface AnchorBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ANCHOR_SIDES: AnchorSide[] = ['top', 'right', 'bottom', 'left'];

/** 取反侧（源出 right，则目标进 left） */
export function oppositeSide(side: AnchorSide): AnchorSide {
  switch (side) {
    case 'top':
      return 'bottom';
    case 'bottom':
      return 'top';
    case 'left':
      return 'right';
    default:
      return 'left';
  }
}

export function isAnchorSide(v: unknown): v is AnchorSide {
  return v === 'top' || v === 'right' || v === 'bottom' || v === 'left';
}

/**
 * 射线求交：从盒子中心朝 (dx,dy) 方向射出，返回先穿出的那条边。
 * 做法：比较「撞上左右面」与「撞上上下面」各自需要的步长，谁小先撞谁。
 * 分母为 0（方向与该轴平行）时该轴步长为 Infinity，自然被另一轴胜出。
 */
function rayExitSide(dx: number, dy: number, halfW: number, halfH: number): AnchorSide {
  const tx = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const ty = dy === 0 ? Infinity : halfH / Math.abs(dy);
  if (tx < ty) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/**
 * 推断一条连线两端各自该锚在哪一侧。
 * @param from 源节点盒子（左上角 + 宽高）
 * @param to 目标节点盒子
 * @returns { source, target } 两侧的锚点 id（可直接写进 RF 的 sourceHandle / targetHandle）
 */
export function inferAnchorSides(
  from: AnchorBox,
  to: AnchorBox
): { source: AnchorSide; target: AnchorSide } {
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2;
  const tcy = to.y + to.h / 2;
  /* 防御：盒子尺寸为 0 / NaN 时退回「上下」默认，避免算出 Infinity 侧 */
  const fw = from.w > 0 ? from.w : 1;
  const fh = from.h > 0 ? from.h : 1;
  const tw = to.w > 0 ? to.w : 1;
  const th = to.h > 0 ? to.h : 1;
  const dx = tcx - fcx;
  const dy = tcy - fcy;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return { source: 'bottom', target: 'top' };
  }
  /* 投影重叠优先：某一轴上两盒投影有重叠、另一轴没有时，方向是唯一确定的 ——
     纵向重叠（横向流程图里节点对齐）就能水平直达，走左右侧；横向重叠就走上下。
     这一步是给射线法打补丁：射线从盒子中心射出，卡片越扁（我们 flow 卡片宽高比
     可达 4.7:1，而飞书原画只有 1.39），射线越容易先撞上下边，把明明能左右直连的
     两个节点判成上下连线。投影重叠是硬几何事实，不受卡片形状影响。 */
  const overlapY = Math.abs(dy) < (fh + th) / 2;
  const overlapX = Math.abs(dx) < (fw + tw) / 2;
  if (overlapY && !overlapX) {
    const s: AnchorSide = dx >= 0 ? 'right' : 'left';
    return { source: s, target: oppositeSide(s) };
  }
  if (overlapX && !overlapY) {
    const s: AnchorSide = dy >= 0 ? 'bottom' : 'top';
    return { source: s, target: oppositeSide(s) };
  }
  const source = rayExitSide(dx, dy, fw / 2, fh / 2);
  const target = rayExitSide(-dx, -dy, tw / 2, th / 2);
  return { source, target };
}

/** 一条边是否被用户「钉住」了锚点（拖过端点才有；自动边为 false） */
export function isAnchorPinned(data: unknown): boolean {
  return !!(data && typeof data === 'object' && (data as { anchorPinned?: unknown }).anchorPinned);
}
