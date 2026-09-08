/**
 * edgeRoute：手动路由（用户拽线身产生的「中段位置记忆」）
 *
 * 白板连线默认由 React Flow 的 smoothstep 自动决定拐弯位置。用户想「自己拉线排版」时，
 * 我们把该边中段（交叉运行）所在坐标记进 EdgeRoute，渲染时按这个坐标生成正交圆角路径：
 *   - 两端 handle 都在 top/bottom → 中段是横向运行，axis='y'，用户上下拉（改变 y）
 *   - 两端 handle 都在 left/right → 中段是纵向运行，axis='x'，用户左右拉（改变 x）
 * 端点仍吸附在节点上（拖动节点时端点跟随、中段坐标保持不变，像 draw.io 的折线记忆）。
 * 家族（两端同为上下 / 同为左右）之外的边不支持手动路由（返回 null，调用方回退内置渲染）。
 */

import { isAnchorSide, type AnchorBox, type AnchorSide } from './anchor';

export type { AnchorSide };

/* ── 路由模型的三代 ──────────────────────────────────────────────────────────
 * v1（legacy，WP3）：{ axis, pos } —— 只有一个自由度，中段只能沿一个轴平移，
 *   且只支持两端同家族（都上下 / 都左右）。用户体感「只能上下拉」即源于此。
 * v2（WP5）：{ points: [{x,y}...] } —— 二维「必经点」数组。语义是「路径必须经过
 *   这些绝对点」，于是每次拖动都要把整条线重算一遍：Catmull-Rom 的控制点会向
 *   相邻段传播（曲线两端被带弯），正交路由的拐向会被重新判断（拓扑重排）。
 *   实测拖中点 170px，贴节点的 5% 处被动位移 8–17px —— 用户说的「拉一处另一处变形」。
 * v3（现行，WP5c）：{ bends: [{t,dx,dy}] } —— 「段平移」语义，对齐飞书画板 /
 *   draw.io / Figma。t 是基础（自动）路径上的弧长比例，用来锁定「拖的是哪一段」；
 *   dx/dy 是这一段被推开的偏移量。渲染时先算基础路径，再把被选中的那段平移、
 *   两端各补一段连接线 —— 于是：
 *     · 只有被拖的那一段动（局部性）；
 *     · 端点的出线方向永远垂直于节点边（肘线）/ 切线方向恒定（曲线），永不变形；
 *     · 拓扑变化是对称、可预期的（一段变三段），不会突然重排。
 * 三代并存：旧文档仍按各自方式渲染（零回归），新建的一律走 v3。
 * ───────────────────────────────────────────────────────────────────────── */

/** 折点：画布（flow）坐标系下的绝对点 */
export interface Waypoint {
  x: number;
  y: number;
}

/** v2 路由：用户拖出的折点序列（按路径经过顺序） */
export interface WaypointRoute {
  points: Waypoint[];
}

/** v1 路由：单轴中段偏移（旧文档兼容用） */
export interface LegacyRoute {
  axis: 'x' | 'y';
  pos: number;
}

/**
 * v3 的一个「弯」：把基础路径上 t 处所在的那一整段推开 (dx,dy)。
 * t 用弧长比例而不是段下标 —— 节点挪动后基础路径会变，比例仍指向「同一段路上」。
 */
export interface EdgeBend {
  t: number;
  dx: number;
  dy: number;
}

/** v3 路由：段平移偏移列表（按 t 升序） */
export interface BendRoute {
  bends: EdgeBend[];
}

export type EdgeRoute = WaypointRoute | LegacyRoute | BendRoute;

/** 折弯/圆角时中段离节点边缘的最小距离：圆角半径 10 + 一点余量 */
export const ROUTE_STUB = 26;
/** 圆角半径（与 smoothstep pathOptions.borderRadius=10 对齐，视觉一致） */
export const ROUTE_RADIUS = 10;

const V = (s: AnchorSide) => s === 'top' || s === 'bottom';
const isFin = (n: number) => Number.isFinite(n);

export function isWaypoint(v: unknown): v is Waypoint {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as Waypoint).x === 'number' &&
    typeof (v as Waypoint).y === 'number' &&
    Number.isFinite((v as Waypoint).x) &&
    Number.isFinite((v as Waypoint).y)
  );
}

/** v2：二维折点路由（至少 1 个点，且每个点坐标有效） */
export function isWaypointRoute(v: unknown): v is WaypointRoute {
  if (!v || typeof v !== 'object') return false;
  const pts = (v as WaypointRoute).points;
  if (!Array.isArray(pts) || pts.length === 0) return false;
  return pts.every(isWaypoint);
}

export function isBend(v: unknown): v is EdgeBend {
  if (!v || typeof v !== 'object') return false;
  const b = v as EdgeBend;
  return isFin(b.t) && isFin(b.dx) && isFin(b.dy);
}

/** v3：段平移路由（至少一个弯） */
export function isBendRoute(v: unknown): v is BendRoute {
  if (!v || typeof v !== 'object') return false;
  const bs = (v as BendRoute).bends;
  return Array.isArray(bs) && bs.length > 0 && bs.every(isBend);
}

/** v1：单轴中段路由 */
export function isLegacyRoute(v: unknown): v is LegacyRoute {
  return (
    !!v &&
    typeof v === 'object' &&
    ((v as LegacyRoute).axis === 'x' || (v as LegacyRoute).axis === 'y') &&
    typeof (v as LegacyRoute).pos === 'number' &&
    Number.isFinite((v as LegacyRoute).pos)
  );
}

/** 任一版本的手动路由（调用方再用 isWaypointRoute / isLegacyRoute 分流） */
export function isEdgeRoute(v: unknown): v is EdgeRoute {
  return isBendRoute(v) || isWaypointRoute(v) || isLegacyRoute(v);
}

/**
 * 计算手动路由的合法区间。
 * 端点侧都竖（top/bottom）→ 返回 axis='y'；都横（left/right）→ axis='x'；混合 → null（不支持）。
 * 区间按「中段必须在每个端点外侧留出 ROUTE_STUB」推导，可能一端无界（lo=-∞ / hi=+∞）。
 */
export function routeBounds(
  ax: number,
  ay: number,
  aSide: AnchorSide,
  bx: number,
  by: number,
  bSide: AnchorSide
): { axis: 'x' | 'y'; lo: number; hi: number } | null {
  if (V(aSide) !== V(bSide)) return null;
  const vertical = V(aSide);
  let lo = -Infinity;
  let hi = Infinity;
  const bounds = (coord: number, side: AnchorSide) => {
    if (vertical) {
      // top：中段在上方（更小的 y）；bottom：中段在下方（更大的 y）
      if (side === 'top') hi = Math.min(hi, coord - ROUTE_STUB);
      else lo = Math.max(lo, coord + ROUTE_STUB);
    } else {
      // left：中段在左侧（更小的 x）；right：中段在右侧（更大的 x）
      if (side === 'left') hi = Math.min(hi, coord - ROUTE_STUB);
      else lo = Math.max(lo, coord + ROUTE_STUB);
    }
  };
  bounds(vertical ? ay : ax, aSide);
  bounds(vertical ? by : bx, bSide);
  if (lo > hi) return null;
  return { axis: vertical ? 'y' : 'x', lo, hi };
}

/** 区间默认中段位置（无 override 时选择的中点）；两侧无界的情况在此不会出现（有界的一侧必有） */
export function defaultRoutePos(lo: number, hi: number): number {
  if (isFin(lo) && isFin(hi)) return (lo + hi) / 2;
  if (isFin(lo)) return lo + 96;
  return hi - 96;
}

export function clampRoutePos(pos: number, lo: number, hi: number): number {
  const p = isFin(lo) && pos < lo ? lo : pos;
  return isFin(hi) && p > hi ? hi : p;
}

/** 把正交折线顶点序列转成带圆角的 path d（M/L + Q 圆角，半径 R）。 */
export function roundedOrthoD(verts: Array<[number, number]>, radius = ROUTE_RADIUS): string {
  // 先去掉连续重复点 & 退化段
  const pts: Array<[number, number]> = [];
  for (const p of verts) {
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  if (pts.length < 2) return '';
  const segs: Array<{ from: [number, number]; to: [number, number]; len: number; axis: 'h' | 'v' }> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) continue;
    segs.push({
      from: pts[i],
      to: pts[i + 1],
      len: Math.abs(dx) + Math.abs(dy),
      axis: dx === 0 ? 'v' : 'h',
    });
  }
  if (!segs.length) return '';
  if (segs.length === 1) return `M${segs[0].from[0]},${segs[0].from[1]} L${segs[0].to[0]},${segs[0].to[1]}`;

  let d = `M${segs[0].from[0]},${segs[0].from[1]}`;
  let cursor: [number, number] = segs[0].from;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dir: [number, number] = [
      Math.sign(s.to[0] - s.from[0]),
      Math.sign(s.to[1] - s.from[1]),
    ];
    // 与本段同向但和上段同轴的退化（轴向未变）→ 上段圆角未产生拐弯
    const next = segs[i + 1];
    const turns = !!next && next.axis !== s.axis;
    if (!turns) {
      d += ` L${s.to[0]},${s.to[1]}`;
      cursor = s.to;
      continue;
    }
    const nextDir: [number, number] = [
      Math.sign(next.to[0] - next.from[0]),
      Math.sign(next.to[1] - next.from[1]),
    ];
    const rr = Math.min(radius, s.len * 0.45, next.len * 0.45);
    const corner = s.to;
    // 弧的起点（本段上离拐角 rr 处）
    const a1: [number, number] = [corner[0] - dir[0] * rr, corner[1] - dir[1] * rr];
    // 弧的终点（下一段上离拐角 rr 处）
    const a2: [number, number] = [corner[0] + nextDir[0] * rr, corner[1] + nextDir[1] * rr];
    if (cursor[0] !== a1[0] || cursor[1] !== a1[1]) d += ` L${a1[0]},${a1[1]}`;
    d += ` Q${corner[0]},${corner[1]} ${a2[0]},${a2[1]}`;
    cursor = a2;
    // 下一段从 a2 出发（其 from 仍是 corner，需要把终点修正：跳到下一段完整长度时注意）
    segs[i + 1] = { ...next, from: a2, len: next.len - rr, to: next.to };
  }
  // 收尾：最后一段的终点（若上一步已把最后一段改为 from=a2 但未走到 to）
  const last = segs[segs.length - 1];
  if (cursor[0] !== last.to[0] || cursor[1] !== last.to[1]) d += ` L${last.to[0]},${last.to[1]}`;
  return d;
}

export interface RouteSource {
  ax: number;
  ay: number;
  aSide: AnchorSide;
  bx: number;
  by: number;
  bSide: AnchorSide;
  /** v1 单轴路由（v2 折点不走这里，见 waypointRoutePath） */
  route?: LegacyRoute | null;
}

export interface RoutePathResult {
  d: string;
  /** 标签中点（flow 坐标）：中段交叉运行的中间 */
  lx: number;
  ly: number;
  pos: number;
}

/**
 * 生成手动路由路径。不支持家族（混合侧）/ 区间无解 / route.axis 与家族不符时返回 null。
 * pos 会按区间夹取，保证端点 stub 方向不反转、不与节点相交。
 */
export function orthoRoutePath(src: RouteSource): RoutePathResult | null {
  const { ax, ay, aSide, bx, by, bSide, route } = src;
  const bds = routeBounds(ax, ay, aSide, bx, by, bSide);
  if (!bds) return null;
  const wantAxis = route?.axis;
  if (wantAxis && wantAxis !== bds.axis) return null;
  const pos =
    typeof route?.pos === 'number'
      ? clampRoutePos(route.pos, bds.lo, bds.hi)
      : defaultRoutePos(bds.lo, bds.hi);
  const verts: Array<[number, number]> =
    bds.axis === 'y'
      ? [
          [ax, ay],
          [ax, pos],
          [bx, pos],
          [bx, by],
        ]
      : [
          [ax, ay],
          [pos, ay],
          [pos, by],
          [bx, by],
        ];
  const d = roundedOrthoD(verts);
  const lx = bds.axis === 'y' ? (ax + bx) / 2 : pos;
  const ly = bds.axis === 'y' ? pos : (ay + by) / 2;
  return { d, lx, ly, pos };
}

/* ══ v2：二维折点路由（WP5）══════════════════════════════════════════════════
 * 与 v1 的本质差别：折点是「路径必须经过的二维点」，而不是某个轴的标量偏移。
 * 路由器把 A → wp1 → … → wpN → B 之间逐段用 L 型（两段一拐）连起来，
 * 因此每个折点的 x / y 都能自由改，画出绕行、阶梯、汇流等任意正交形态。
 *
 * 拐向选择：优先延续上一段的轴向（视觉最少拐弯）；若那样会「回头」
 * （与上一段同轴向且方向相反）则改用另一轴，避免出现重叠回去的脏线。
 * 最后一段强制沿 bSide 的轴向进入目标，否则箭头方向会错。
 * ═══════════════════════════════════════════════════════════════════════════ */

type Axis = 'h' | 'v';

function sideDir(side: AnchorSide): { dx: number; dy: number } {
  if (side === 'top') return { dx: 0, dy: -1 };
  if (side === 'bottom') return { dx: 0, dy: 1 };
  if (side === 'left') return { dx: -1, dy: 0 };
  return { dx: 1, dy: 0 };
}

function sideAxis(side: AnchorSide): Axis {
  return side === 'top' || side === 'bottom' ? 'v' : 'h';
}

function sgn(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function clampNum(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** 端点锚点：节点某条边上的相对位置（t 为该边长度方向的比例 0..1） */
export interface EdgeAnchor {
  side: AnchorSide;
  t: number;
}

export function isEdgeAnchor(v: unknown): v is EdgeAnchor {
  return (
    !!v &&
    typeof v === 'object' &&
    isAnchorSide((v as EdgeAnchor).side) &&
    typeof (v as EdgeAnchor).t === 'number' &&
    Number.isFinite((v as EdgeAnchor).t)
  );
}

/** 锚点 → 画布绝对坐标（随节点位置/尺寸实时换算，节点缩放时锚点跟着走） */
export function anchorPoint(box: AnchorBox, a: EdgeAnchor): Waypoint {
  const { x, y, w, h } = box;
  const t = clamp01(a.t);
  switch (a.side) {
    case 'top':
      return { x: x + w * t, y };
    case 'bottom':
      return { x: x + w * t, y: y + h };
    case 'left':
      return { x, y: y + h * t };
    default:
      return { x: x + w, y: y + h * t };
  }
}

/** 端点落在某条边上时的「中点磁吸」阈值：t 落在 0.5±SNAP 内就吸到正中。
 *  飞书画板 / FigJam 的端点吸附到边时默认落在中点，用户拖到附近就该停得住。
 *  没有这个磁吸时 t 是连续值，用户能停在 0.47 / 0.53，唯独停不到 0.5，
 *  表现为「四周都能移，正中间那 4 个点却选不中」。 */
export const CENTER_SNAP = 0.08;

/** 中点磁吸：靠近正中就吸死，否则保持原值 */
function snapToCenter(t: number): number {
  return Math.abs(t - 0.5) <= CENTER_SNAP ? 0.5 : t;
}

/** 任意点 → 最近边框上的锚点（端点自由吸附：拖到哪就吸到哪条边） */
export function projectToBorder(box: AnchorBox, px: number, py: number): EdgeAnchor {
  const { x, y, w, h } = box;
  const ww = w > 0 ? w : 1;
  const hh = h > 0 ? h : 1;
  const cx = clampNum(px, x, x + w);
  const cy = clampNum(py, y, y + h);
  /* 点在框外 → 直接投影到最近的那条边 */
  if (cx !== px || cy !== py) {
    if (cx === x) return { side: 'left', t: snapToCenter(clamp01((cy - y) / hh)) };
    if (cx === x + w) return { side: 'right', t: snapToCenter(clamp01((cy - y) / hh)) };
    if (cy === y) return { side: 'top', t: snapToCenter(clamp01((cx - x) / ww)) };
    return { side: 'bottom', t: snapToCenter(clamp01((cx - x) / ww)) };
  }
  /* 点在框内 → 推到距离最近的边 */
  const dTop = py - y;
  const dBottom = y + h - py;
  const dLeft = px - x;
  const dRight = x + w - px;
  const m = Math.min(dTop, dBottom, dLeft, dRight);
  if (m === dTop) return { side: 'top', t: snapToCenter(clamp01((px - x) / ww)) };
  if (m === dBottom) return { side: 'bottom', t: snapToCenter(clamp01((px - x) / ww)) };
  if (m === dLeft) return { side: 'left', t: snapToCenter(clamp01((py - y) / hh)) };
  return { side: 'right', t: snapToCenter(clamp01((py - y) / hh)) };
}

export interface WaypointSource {
  ax: number;
  ay: number;
  aSide: AnchorSide;
  bx: number;
  by: number;
  bSide: AnchorSide;
  /** v2 必经点（v3 段平移不用它，故可选） */
  points?: Waypoint[];
}

export interface WaypointPathResult {
  d: string;
  /** 标签锚点（路径弧长中点） */
  lx: number;
  ly: number;
  verts: Array<[number, number]>;
}

/** 折线弧长中点（标签位置：路径正中间，而不是首尾中点） */
function polylineMidpoint(verts: Array<[number, number]>): [number, number] {
  if (!verts.length) return [0, 0];
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    const l =
      Math.abs(verts[i + 1][0] - verts[i][0]) + Math.abs(verts[i + 1][1] - verts[i][1]);
    lens.push(l);
    total += l;
  }
  if (total === 0) return verts[0];
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] >= half) {
      const t = lens[i] === 0 ? 0 : (half - acc) / lens[i];
      return [
        verts[i][0] + (verts[i + 1][0] - verts[i][0]) * t,
        verts[i][1] + (verts[i + 1][1] - verts[i][1]) * t,
      ];
    }
    acc += lens[i];
  }
  return verts[verts.length - 1];
}

/**
 * 生成折点路由路径（points 为空时也返回合法路径 —— 端点锚点单独生效时要用，
 * 此时退化为「中点拐弯」的标准正交连线，与内置 smoothstep 观感一致）。
 * 坐标非法 → null（调用方回退内置渲染）。
 */
export function waypointRoutePath(src: WaypointSource): WaypointPathResult | null {
  const { ax, ay, aSide, bx, by, bSide } = src;
  const pts = (src.points ?? []).filter((p) => isWaypoint(p));
  if (![ax, ay, bx, by].every((n) => Number.isFinite(n))) return null;

  const da = sideDir(aSide);
  const db = sideDir(bSide);
  const verts: Array<[number, number]> = [[ax, ay]];
  const push = (x: number, y: number) => {
    const last = verts[verts.length - 1];
    if (!last || last[0] !== x || last[1] !== y) verts.push([x, y]);
  };
  let lastDir: { dx: number; dy: number } = { dx: da.dx, dy: da.dy };

  /**
   * 连到 to。
   *  - lastAxis 为空：延续上一段轴向，回头则换轴（折点之间的连接，2 段 L 型）；
   *  - lastAxis 给定：保证最后一段沿该轴进入（进 B 用），2 段 L 型；
   *    若那样会回折，改用 3 段 Z 型（拐在中点）绕开，避免画出「去了又回来」的重叠线。
   */
  const connect = (to: [number, number], lastAxis?: Axis) => {
    const from = verts[verts.length - 1];
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (dx === 0 || dy === 0) {
      push(to[0], to[1]);
      lastDir = { dx: sgn(dx), dy: sgn(dy) };
      return;
    }
    const backV = lastDir.dx === 0 && lastDir.dy !== 0 && sgn(dy) === -lastDir.dy;
    const backH = lastDir.dy === 0 && lastDir.dx !== 0 && sgn(dx) === -lastDir.dx;

    let first: Axis;
    let mid = false;
    if (lastAxis) {
      first = lastAxis === 'v' ? 'h' : 'v';
      const back = first === 'h' ? backH : backV;
      /* 无折点时强制走 Z 型：把拐点放在中点，观感与内置 smoothstep 一致 */
      if (back || pts.length === 0) {
        mid = true;
        first = lastAxis;
      }
    } else {
      first = lastDir.dx !== 0 ? 'h' : 'v';
      if (first === 'v' && backV && !backH) first = 'h';
      else if (first === 'h' && backH && !backV) first = 'v';
    }

    if (first === 'v') {
      if (mid) {
        const ey = (from[1] + to[1]) / 2;
        push(from[0], ey);
        push(to[0], ey);
      } else {
        push(from[0], to[1]);
      }
    } else {
      if (mid) {
        const ex = (from[0] + to[0]) / 2;
        push(ex, from[1]);
        push(ex, to[1]);
      } else {
        push(to[0], from[1]);
      }
    }
    push(to[0], to[1]);
    const lastIsV = mid ? first === 'v' : first === 'h';
    lastDir = lastIsV ? { dx: 0, dy: sgn(dy) } : { dx: sgn(dx), dy: 0 };
  };

  /* 出 A：沿 aSide 先走 stub，保证线从节点边缘垂直引出 */
  push(ax + da.dx * ROUTE_STUB, ay + da.dy * ROUTE_STUB);

  for (const w of pts) {
    connect([w.x, w.y]);
  }

  /* 进 B：最后一段必须沿 bSide 轴向进入，否则箭头朝向会错 */
  const bStub: [number, number] = [bx + db.dx * ROUTE_STUB, by + db.dy * ROUTE_STUB];
  connect(bStub, sideAxis(bSide));
  push(bx, by);

  const d = roundedOrthoD(verts);
  if (!d) return null;
  const [lx, ly] = polylineMidpoint(verts);
  return { d, lx, ly, verts };
}

/* ══ v2.1：曲线 / 直线的折点路径（WP5b）══════════════════════════════════════
 * 三种连线类型共用同一份 points（折点模型统一），差别只在「穿点的方式」：
 *   肘线 smoothstep → 正交圆角（waypointRoutePath）
 *   曲线 default    → Catmull-Rom 平滑曲线，严格穿过每个折点
 *   直线 straight   → 尖角折线，直连每个折点
 * 这样曲线 / 直线同样能拖动，不会出现「只有肘线能编辑」的割裂感。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 公共部分：把「出 A 的 stub → 各折点 → 进 B 的 stub」摊平成一条点序列 */
function stubVerts(src: WaypointSource): Array<[number, number]> {
  const { ax, ay, aSide, bx, by, bSide } = src;
  const da = sideDir(aSide);
  const db = sideDir(bSide);
  const pts = (src.points ?? []).filter((p) => isWaypoint(p));
  const verts: Array<[number, number]> = [[ax, ay]];
  const push = (x: number, y: number) => {
    const last = verts[verts.length - 1];
    if (!last || last[0] !== x || last[1] !== y) verts.push([x, y]);
  };
  push(ax + da.dx * ROUTE_STUB, ay + da.dy * ROUTE_STUB);
  for (const w of pts) push(w.x, w.y);
  push(bx + db.dx * ROUTE_STUB, by + db.dy * ROUTE_STUB);
  push(bx, by);
  return verts;
}

/** 坐标取整到 2 位小数，避免 path 字符串过长 */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * 曲线（贝塞尔）折点路由：Catmull-Rom 转三次贝塞尔。
 * 曲线严格穿过每个折点，转折处自动平滑 —— 拖出来的弯是「柔和的绕行」而不是硬拐。
 */
export function curveRoutePath(src: WaypointSource): WaypointPathResult | null {
  if (![src.ax, src.ay, src.bx, src.by].every((n) => Number.isFinite(n))) return null;
  const verts = stubVerts(src);
  if (verts.length < 2) return null;
  let d = `M ${fmt(verts[0][0])} ${fmt(verts[0][1])}`;
  for (let i = 0; i < verts.length - 1; i++) {
    const p0 = verts[i - 1] ?? verts[i];
    const p1 = verts[i];
    const p2 = verts[i + 1];
    const p3 = verts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  const [lx, ly] = polylineMidpoint(verts);
  return { d, lx, ly, verts };
}

/** 直线折点路由：尖角折线，直线类型带上折点后就变成「手绘折线」 */
export function straightRoutePath(src: WaypointSource): WaypointPathResult | null {
  if (![src.ax, src.ay, src.bx, src.by].every((n) => Number.isFinite(n))) return null;
  const verts = stubVerts(src);
  if (verts.length < 2) return null;
  let d = `M ${fmt(verts[0][0])} ${fmt(verts[0][1])}`;
  for (let i = 1; i < verts.length; i++) d += ` L ${fmt(verts[i][0])} ${fmt(verts[i][1])}`;
  const [lx, ly] = polylineMidpoint(verts);
  return { d, lx, ly, verts };
}

/** 按连线类型挑对应的折点路由器（肘线 / 曲线 / 直线） */
export function routePathByType(
  type: string | undefined,
  src: WaypointSource
): WaypointPathResult | null {
  if (type === 'default') return curveRoutePath(src);
  if (type === 'straight') return straightRoutePath(src);
  return waypointRoutePath(src);
}

/* ══ v3：段平移路由（WP5c）══════════════════════════════════════════════════
 * 语义对齐飞书画板 / draw.io / Figma：拖的是「一段」，不是「一个必经点」。
 *
 *  基础路径（自动路由结果）
 *      ↓  bend.t 选出被拖的那一整段
 *  把这一段整体推开 (dx,dy)，两端各补一段连接线
 *
 * 关键性质（也是修掉「拉一处、另一处变形」的根本）：
 *   1. 局部性 —— 只有被选中的那一段位移，其余顶点原封不动；
 *   2. 端点锁定 —— 首尾的 stub 段永不参与平移，出线方向恒等于节点边的法向；
 *   3. 可预期 —— 一段变三段，拓扑变化对称，不会出现拐向突然翻转。
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface BendSource extends WaypointSource {
  bends: EdgeBend[];
}

export interface BendPathResult extends WaypointPathResult {
  /** 每个弯当前所在的抓手位置（供悬停时浮出蓝色标识） */
  handles: Array<{ x: number; y: number }>;
}

/**
 * 按弧长比例 t 选中要平移的那一段。
 * 首尾两段是贴着节点的 stub（出线方向由 aSide/bSide 决定），**永不参与平移** ——
 * 这正是「顶部跟节点连接的位置不变形」的保证。
 */
function pickSegment(
  verts: Array<[number, number]>,
  t: number
): { idx: number; u: number } | null {
  const n = verts.length - 1;
  if (n < 3) return null;
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(verts[i + 1][0] - verts[i][0], verts[i + 1][1] - verts[i][1]);
    lens.push(l);
    total += l;
  }
  if (total <= 0) return null;
  const lo = lens[0];
  const hi = total - lens[n - 1];
  if (hi - lo <= 0.001) return null;
  const target = lo + (hi - lo) * clamp01(t);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (acc + lens[i] > target) {
      const li = lens[i] || 1;
      return { idx: i, u: clamp01((target - acc) / li) };
    }
    acc += lens[i];
  }
  return { idx: n - 2, u: 1 };
}

/**
 * 肘线：把选中的那段沿其法向推开。
 * 偏移只取法向分量 —— 沿段自身方向的位移对正交线没有意义（只会改变段长，
 * 等价于换一段），取法向后两端补出来的连接线天然垂直于该段，整体保持正交。
 */
function applyBendOrtho(
  verts: Array<[number, number]>,
  bend: EdgeBend
): { verts: Array<[number, number]>; handle: { x: number; y: number } | null } {
  const pick = pickSegment(verts, bend.t);
  if (!pick) return { verts, handle: null };
  const { idx, u } = pick;
  const p0 = verts[idx];
  const p1 = verts[idx + 1];
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (len < 1e-6) return { verts, handle: null };
  const ux = (p1[0] - p0[0]) / len;
  const uy = (p1[1] - p0[1]) / len;
  const nx = -uy;
  const ny = ux;
  const d = bend.dx * nx + bend.dy * ny;
  if (Math.abs(d) < 0.5) return { verts, handle: null };

  /**
   * 只推开「按下位置四周的一小段」，而不是整段。
   * 整段平移会把拐点推到紧贴节点的地方（比如从起点 26px 处就横着拐出去），
   * 看起来就是「顶部跟节点连接的位置变形了」。取按下点 ±18% 的子段，
   * 凸起的形状才对称、且离两端都留有距离。
   */
  const w = 0.18;
  const lo = Math.max(0, u - w);
  const hi = Math.min(1, u + w);
  if (hi - lo < 0.02) return { verts, handle: null };
  const vx = nx * d;
  const vy = ny * d;
  const at = (r: number): [number, number] => [p0[0] + ux * len * r, p0[1] + uy * len * r];
  const a0 = at(lo);
  const a1 = at(hi);
  const b0: [number, number] = [a0[0] + vx, a0[1] + vy];
  const b1: [number, number] = [a1[0] + vx, a1[1] + vy];

  const ins: Array<[number, number]> = [];
  if (lo > 0.001) ins.push(a0);
  ins.push(b0, b1);
  if (hi < 0.999) ins.push(a1);
  const out: Array<[number, number]> = [
    ...verts.slice(0, idx + 1),
    ...ins,
    ...verts.slice(idx + 1),
  ];
  return { verts: out, handle: { x: (b0[0] + b1[0]) / 2, y: (b0[1] + b1[1]) / 2 } };
}

/** 单段三次贝塞尔上的点（基础曲线用） */
function bez3(
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p3: [number, number],
  t: number
): [number, number] {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return [
    w0 * p0[0] + w1 * c1[0] + w2 * c2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * c1[1] + w2 * c2[1] + w3 * p3[1],
  ];
}

/**
 * 曲线 / 直线共用的「中间点」计算：
 * 在基础曲线（A→B 的单段贝塞尔，两端切线锁定为节点法向）上取 t 处的点，再叠加偏移。
 */
function bendMid(src: BendSource, t: number): [number, number] {
  const { ax, ay, aSide, bx, by, bSide } = src;
  const da = sideDir(aSide);
  const db = sideDir(bSide);
  const k = Math.max(20, Math.hypot(bx - ax, by - ay) / 3);
  const p0: [number, number] = [ax, ay];
  const c1: [number, number] = [ax + da.dx * k, ay + da.dy * k];
  const c2: [number, number] = [bx + db.dx * k, by + db.dy * k];
  const p3: [number, number] = [bx, by];
  return bez3(p0, c1, c2, p3, clamp01(t));
}

function norm(v: [number, number]): [number, number] {
  const l = Math.hypot(v[0], v[1]);
  return l < 1e-6 ? [0, 0] : [v[0] / l, v[1] / l];
}

/**
 * 端点切线锁定的平滑样条：中间各点用 Catmull-Rom 的切线（平滑穿过），
 * 但**首段起点切线恒为 aSide 法向、末段终点切线恒为 bSide 法向** ——
 * 于是无论中间怎么拖，两端与节点的衔接角度永远不变。
 */
function lockedSpline(
  pts: Array<[number, number]>,
  na: [number, number],
  nb: [number, number],
  straightEnds = false
): string {
  const n = pts.length - 1;
  if (n < 1) return '';
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const segLenV = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const k = segLenV / 3;
    let c1: [number, number];
    let c2: [number, number];
    if (straightEnds && (i === 0 || i === n - 1)) {
      /* 首尾的 stub 段画成严格直线：两端各控制点都贴在本段方向上，
         这样「从节点垂直出来 / 垂直进入」的那一截是一丝不苟的直线。 */
      const dir = norm([p1[0] - p0[0], p1[1] - p0[1]]);
      c1 = [p0[0] + dir[0] * k, p0[1] + dir[1] * k];
      c2 = [p1[0] - dir[0] * k, p1[1] - dir[1] * k];
    } else {
      /* 起点切线：首段锁 na，其余用 Catmull-Rom 的前后点差分 */
      const t0: [number, number] =
        i === 0
          ? na
          : norm([pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]]);
      /* 终点切线：末段锁 -nb（进入节点的方向），其余同上 */
      const t1: [number, number] =
        i === n - 1
          ? [-nb[0], -nb[1]]
          : norm([pts[i + 2][0] - pts[i][0], pts[i + 2][1] - pts[i][1]]);
      c1 = [p0[0] + t0[0] * k, p0[1] + t0[1] * k];
      c2 = [p1[0] - t1[0] * k, p1[1] - t1[1] * k];
    }
    d += ` C ${fmt(c1[0])} ${fmt(c1[1])}, ${fmt(c2[0])} ${fmt(c2[1])}, ${fmt(p1[0])} ${fmt(p1[1])}`;
  }
  return d;
}

/**
 * 段平移路由总入口：按连线类型分派，返回路径 + 每个弯的抓手位置。
 *   肘线 smoothstep → 平移整段（正交，两端补垂线段）
 *   曲线 default    → 端点切线锁定的平滑样条穿中间点
 *   直线 straight   → 尖角折线穿中间点
 */
export function bendRoutePath(
  type: string | undefined,
  src: BendSource
): BendPathResult | null {
  const { ax, ay, aSide, bx, by, bSide } = src;
  if (![ax, ay, bx, by].every((n) => Number.isFinite(n))) return null;
  const bends = (src.bends ?? []).filter(isBend).slice().sort((p, q) => p.t - q.t);
  if (!bends.length) return null;

  if (type === 'default' || type === 'straight') {
    const da = sideDir(aSide);
    const db = sideDir(bSide);
    /**
     * 两端各插一个 stub 点 —— 和肘线一样，强迫线「先从节点垂直出来、最后垂直进入」。
     * 没有它的话，曲线从节点一出来就开始朝中间点弯，视觉上就是
     * 「顶部跟节点连线的位置变形了」。
     * stub 取连线全长的 18%（上限 60px）：太短的话垂直段几乎看不见，
     * 用户仍会觉得「一出来就歪了」。
     */
    const dist = Math.hypot(bx - ax, by - ay) || 1;
    const s = Math.min(60, Math.max(12, dist * 0.18));
    /* 中间点的 t 也要相应收进 stub 之间，否则弯会跑到出线段之前（路径倒退） */
    const span = clamp01(s / dist);
    const mid: Array<[number, number]> = bends.map((b) => {
      const tt = span + clamp01(b.t) * Math.max(0.04, 1 - 2 * span);
      const m = bendMid(src, tt);
      return [m[0] + b.dx, m[1] + b.dy];
    });
    const pts: Array<[number, number]> = [
      [ax, ay],
      [ax + da.dx * s, ay + da.dy * s],
      ...mid,
      [bx + db.dx * s, by + db.dy * s],
      [bx, by],
    ];
    const d =
      type === 'default'
        ? lockedSpline(pts, [da.dx, da.dy], [db.dx, db.dy], true)
        : pts.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p[0])} ${fmt(p[1])}`).join(' ');
    const [lx, ly] = polylineMidpoint(pts);
    return {
      d,
      lx,
      ly,
      verts: pts,
      handles: mid.map((m) => ({ x: m[0], y: m[1] })),
    };
  }

  /* 肘线：先算基础正交路径，再逐段推开 */
  const base = waypointRoutePath({ ax, ay, aSide, bx, by, bSide, points: [] });
  if (!base) return null;
  let verts = base.verts;
  const handles: Array<{ x: number; y: number }> = [];
  for (const b of bends) {
    const r = applyBendOrtho(verts, b);
    verts = r.verts;
    if (r.handle) handles.push(r.handle);
  }
  const d = roundedOrthoD(verts);
  if (!d) return null;
  const [lx, ly] = polylineMidpoint(verts);
  return { d, lx, ly, verts, handles };
}
