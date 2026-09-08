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

/* ============================================================
 * 批量图级推断（飞书粘贴增强）：比单边 inferAnchorSides 多几件事
 *   1) 判断整图主流向（TB / LR），识别「远回流」边 —— 目标在源
 *      上游且中心横向有位移（要跨过中间节点绕回）时，飞书画的是
 *      同侧长弧（都从 left 或都从 right 走），不是最近侧直连。
 *      裸 inferAnchorSides 会把它们判成 top/bottom 直连，与主链
 *      重叠、视觉错乱 —— 37 边真值样本里 13 条推断错的根因。
 *      （注意：同列紧邻的往返回流飞书走 top/bottom 直连，不可误伤）
 *   2) 判断菱形节点：多条出边按目标水平位置分到左/右尖角，
 *      而不是全挤「最近侧」（菱形天然水平分叉）。
 *   3) 环对（A→B 与 B→A 并存）：上下两条往返线分侧，下方那条绕弧，
 *      否则两条线叠在同一个直连通道上。
 * ============================================================ */
export type GraphDirection = 'TB' | 'LR';

/** 词义偏右的（视觉上飞书多绕右侧）：返回/失败/放弃 类 */
const BACKFLOW_RIGHT_WORDS = ['返回', '失败', '放弃', '退出', '回到', '上一步'];

/** 一个需要参与图级推断的边（source/target 已在 box 集合里） */
export interface AnchorEdgeRef {
  source: string;
  target: string;
  label: string;
}

/**
 * 全图主流向：所有边的中心位移投票。纵向位移更大 → TB，否则 LR。
 */
export function inferGraphDirection(
  boxById: ReadonlyMap<string, AnchorBox>,
  edges: AnchorEdgeRef[]
): GraphDirection {
  let dxs = 0;
  let dys = 0;
  for (const e of edges) {
    const a = boxById.get(e.source);
    const b = boxById.get(e.target);
    if (!a || !b) continue;
    dxs += Math.abs(b.x + b.w / 2 - (a.x + a.w / 2));
    dys += Math.abs(b.y + b.h / 2 - (a.y + a.h / 2));
  }
  return dys > dxs ? 'TB' : 'LR';
}

const cyOf = (b: AnchorBox) => b.y + b.h / 2;
const cxOf = (b: AnchorBox) => b.x + b.w / 2;

/** 判定一条边是否为「远回流/环绕」边：
 *  目标在源的上游方向、且中心横向错位明显（非同一列紧邻直连）。
 *  语义词表只做弱提示（需目标确实在上游半高以上，防止把同排水平分支误伤）。 */
export function isFarBackflow(
  dir: GraphDirection,
  from: AnchorBox,
  to: AnchorBox,
  label: string
): boolean {
  const hitWord = BACKFLOW_RIGHT_WORDS.some((w) => label.includes(w));
  if (dir === 'TB') {
    /* 目标中心显著高于源中心（至少半高之和的 1/2 抬升） */
    const lifted = cyOf(to) < cyOf(from) - (from.h + to.h) / 4;
    if (!lifted) return false;
    /* 横向错位必须够明显：非同一列（dx 大）或词义提示 */
    const xGap = Math.abs(cxOf(to) - cxOf(from));
    const halfSum = (from.w + to.w) / 2;
    return xGap > halfSum * 0.35 || (hitWord && xGap > halfSum * 0.12);
  }
  const shifted = cxOf(to) < cxOf(from) - (from.w + to.w) / 4;
  if (!shifted) return false;
  const yGap = Math.abs(cyOf(to) - cyOf(from));
  const halfH = (from.h + to.h) / 2;
  return yGap > halfH * 0.35 || (hitWord && yGap > halfH * 0.12);
}

/** 回流边弧向：词义偏右词 → right，否则 left */
export function backflowArcSide(label: string): AnchorSide {
  return BACKFLOW_RIGHT_WORDS.some((w) => label.includes(w)) ? 'right' : 'left';
}

export interface InferredEdgeSide {
  sourceSide: AnchorSide;
  targetSide: AnchorSide;
  /** 这条边被判定为远回流（绕弧） */
  backflow: boolean;
}

/** 两点中心的水平/垂直相对方向（供菱形分叉/环对分侧） */
const dxOf = (a: AnchorBox, b: AnchorBox) => cxOf(b) - cxOf(a);
const dyOf = (a: AnchorBox, b: AnchorBox) => cyOf(b) - cyOf(a);

/** 回流/异常语义词：环对中命中者绕弧；直线通道留给无词主链 */
const LOOP_ABNORMAL_WORDS = ['返回', '失败', '放弃', '退出', '否', '退回', '上一步', '重试'];

/** 直连路径（TB 回流：源底→目标顶之间）是否被中间节点阻挡 */
function blockedByMiddle(
  from: AnchorBox,
  to: AnchorBox,
  all: ReadonlyMap<string, AnchorBox>,
  skip: ReadonlySet<string>
): boolean {
  const x0 = Math.min(from.x, to.x);
  const x1 = Math.max(from.x + from.w, to.x + to.w);
  const y0 = to.y + to.h; // 目标在下界以下（目标在上游时）
  const y1 = from.y; // 源的上缘
  const band = { x0, x1, y0, y1 };
  for (const [id, c] of all) {
    if (skip.has(id)) continue;
    /* 与竖直带相交且落在 y0..y1 中间区 */
    if (c.y + c.h <= y0 + 1 || c.y >= y1 - 1) continue;
    if (c.x + c.w <= band.x0 + 1 || c.x >= band.x1 - 1) continue;
    return true;
  }
  return false;
}

/**
 * 图级批量推断每条边的出/入侧（粘贴增强版）。
 * - 普通顺流边：与 inferAnchorSides 一致（最近侧直连）。
 * - 远回流边（目标在上游且直连会穿中间节点）：源与目标同侧绕弧。
 * - 环对（A→B 与 B→A 并存）：异常词那条（或逆流那条）绕弧，直线
 *   通道留给主链，避免一正一反两条线叠在同一个 top/bottom 通道。
 * - 菱形节点：出边目标水平主导（|dx| ≥ 1.8|dy|）才从左右尖走，
 *   正下/正上仍走底/顶（防把「是/成功」下行走线误分到侧边）。
 * - 同 target 的 top/bottom 入线被多条普通边共享时：后到者挪到水平侧
 *   （我们每侧只有一个 handle，飞书会自动分散入口）。
 */
export function inferGraphSides(
  boxById: ReadonlyMap<string, AnchorBox>,
  edges: AnchorEdgeRef[],
  diamondIds?: ReadonlySet<string>
): InferredEdgeSide[] {
  const dir = inferGraphDirection(boxById, edges);

  /* 环对检测：存在反向边 B→A */
  const directed = new Set(edges.map((e) => `${e.source}>${e.target}`));
  const hasReverseOf = (src: string, tgt: string) => directed.has(`${tgt}>${src}`);

  /* 每个菱形节点的出边数（分叉用） */
  const outDeg = new Map<string, number>();
  for (const e of edges) outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);

  const out = edges.map((e, idx) => {
    const a = boxById.get(e.source);
    const b = boxById.get(e.target);
    if (!a || !b) {
      return { sourceSide: 'bottom' as AnchorSide, targetSide: 'top' as AnchorSide, backflow: false };
    }
    const label = e.label;
    const abnormal = LOOP_ABNORMAL_WORDS.some((w) => label.includes(w));
    /* 1) 环对：异常词条绕弧；两条都无词 → 逆流条（目标在上游）绕弧 */
    if (hasReverseOf(e.source, e.target)) {
      const meUpward = cyOf(b) < cyOf(a); // 目标在源上方
      if (abnormal || (!otherHasAbnormal(edges, idx, e, LOOP_ABNORMAL_WORDS) && meUpward)) {
        const side = backflowArcSide(label);
        return { sourceSide: side, targetSide: side, backflow: true };
      }
    }
    /* 2) 远回流（目标显著在上游）且直连会穿中间节点 → 同侧绕弧 */
    if (dir === 'TB' ? cyOf(b) < cyOf(a) - (a.h + b.h) / 4 : cxOf(b) < cxOf(a) - (a.w + b.w) / 4) {
      const lifted = dir === 'TB' ? cyOf(b) < cyOf(a) - (a.h + b.h) / 4 : true;
      if (lifted) {
        const skip = new Set([e.source, e.target]);
        const blocked = dir === 'TB' ? blockedByMiddle(a, b, boxById, skip) : true;
        if (blocked) {
          const side = backflowArcSide(label);
          return { sourceSide: side, targetSide: side, backflow: true };
        }
      }
    }
    /* 3) 菱形多出边且目标水平主导 → 左右尖 */
    const diamond = diamondIds?.has(e.source);
    const dAbs = Math.abs(dxOf(a, b));
    const dyAbs = Math.abs(dyOf(a, b));
    if (diamond && (outDeg.get(e.source) ?? 0) >= 2 && dAbs >= dyAbs * 1.8) {
      const srcSide: AnchorSide = dxOf(a, b) >= 0 ? 'right' : 'left';
      const bs = inferAnchorSides(a, b);
      return { sourceSide: srcSide, targetSide: bs.target, backflow: false };
    }
    const s = inferAnchorSides(a, b);
    return { sourceSide: s.source, targetSide: s.target, backflow: false };
  });

  /* 第二遍：
     A) 同 source 的 top/bottom 出边被 ≥2 条非回流边共享 → 组内第一条挪水平侧
        （按它目标的水平方向定左右），后续保留直连。每侧只有一个 handle，
        飞书会自动分散出口，真实样本 c2:66/70 都从「返回登录页」向下出，
        飞书把先画的 c2:66 放到了左缘、后画的 c2:70 保持直下。 */
  const srcCount = new Map<string, Map<AnchorSide, number>>();
  out.forEach((o, i) => {
    if (o.backflow) return;
    const side = o.sourceSide;
    if (side !== 'top' && side !== 'bottom') return;
    if (!srcCount.has(edges[i].source)) srcCount.set(edges[i].source, new Map());
    const m = srcCount.get(edges[i].source)!;
    m.set(side, (m.get(side) ?? 0) + 1);
  });
  const srcShifted = new Set<string>();
  for (let i = 0; i < out.length; i += 1) {
    const e = edges[i];
    if (out[i].backflow) continue;
    const side = out[i].sourceSide;
    if (side !== 'top' && side !== 'bottom') continue;
    /* 菱形源出边真值允许同 bottom 多线（飞书在菱形底缘错开锚点），不拆 */
    if (diamondIds?.has(e.source)) continue;
    const key = `${e.source}@${side}`;
    const cnt = srcCount.get(e.source)?.get(side) ?? 0;
    if (cnt > 1 && !srcShifted.has(key)) {
      srcShifted.add(key);
      const a = boxById.get(e.source);
      const b = boxById.get(e.target);
      if (a && b) {
        /* 目标在正下/正上（几乎同列）时不硬挪，维持直连 */
        const nearVertical = Math.abs(dxOf(a, b)) < (a.w + b.w) / 4;
        if (!nearVertical) out[i].sourceSide = dxOf(a, b) >= 0 ? 'right' : 'left';
      }
    }
  }
  /* B) 同 target 的 top/bottom 入口被 ≥2 条非回流边共享 → 后到者挪水平侧。
     真值样本（c2:55/70 都进 o2:45.top）里飞书把第二条放到了 right 尖。 */
  const usedIn = new Map<string, Set<AnchorSide>>();
  for (let i = 0; i < out.length; i += 1) {
    const e = edges[i];
    if (out[i].backflow) continue;
    const side = out[i].targetSide;
    if (side === 'top' || side === 'bottom') {
      const used = usedIn.get(e.target);
      if (used?.has(side)) {
        const free = (['right', 'left'] as AnchorSide[]).find((s) => !used.has(s));
        if (free) {
          used.add(free);
          out[i].targetSide = free;
          continue;
        }
      } else {
        if (!usedIn.has(e.target)) usedIn.set(e.target, new Set());
        usedIn.get(e.target)!.add(side);
      }
    } else {
      if (!usedIn.has(e.target)) usedIn.set(e.target, new Set());
      usedIn.get(e.target)!.add(side);
    }
  }
  return out;
}

/** 环对另一条是否命中异常词（决定本边是否把绕弧让给对方） */
function otherHasAbnormal(
  edges: AnchorEdgeRef[],
  idx: number,
  self: AnchorEdgeRef,
  words: string[]
): boolean {
  for (let j = 0; j < edges.length; j += 1) {
    if (j === idx) continue;
    const e2 = edges[j];
    if (e2.source === self.target && e2.target === self.source) {
      return words.some((w) => e2.label.includes(w));
    }
  }
  return false;
}
