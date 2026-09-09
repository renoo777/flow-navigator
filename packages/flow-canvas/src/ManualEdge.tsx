/**
 * ManualEdge：手动路由边（fn-manual）
 *
 * 四档渲染，逐级回退，保证任何异常都不会画坏：
 *   1. v3 段平移（data.route.bends，现行）→ bendRoutePath：只推开被选中的那一段，
 *      端点出线方向锁死、只有局部变形（WP5c 修复「拉一处另一处变形」的核心）；
 *   2. v2 折点路由（data.route.points，旧文档）→ routePathByType，行为不变；
 *   3. v1 单轴路由（data.route.{axis,pos}，旧文档）→ orthoRoutePath，行为不变；
 *   4. 以上都不成立 → 用 RF 的路径函数自绘（Bezier / Straight / SmoothStep）。
 *
 * 第 4 档刻意不用内置组件 <SmoothStepEdge />：所有边统一自绘之后，
 * 标签才能统一走 HTML chip。React Flow 的 EdgeText 是单行 <text>
 * （源码里连 tspan 都没有），长标签会被拉成一条横穿画布的线 ——
 * 而飞书的连线说明是能换行的。
 *
 * 端点坐标优先用 data._ap/_bp（用户把端点吸到边框任意位置后的锚点），
 * 否则用 RF 给的 handle 中心。
 *
 * 注：折点 / 端点手柄不在这里画 —— 由 FlowCanvas 的统一覆盖层负责。
 * 原因：没有折点的边走的是 RF 内置渲染器，若手柄挂在自定义边里，
 * 这些边就永远没有端点手柄可用（用户得先拖出折点才能调端点，不合理）。
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useReactFlow,
  type EdgeProps,
  Position,
} from '@xyflow/react';
import {
  bendRoutePath,
  isBendRoute,
  isLegacyRoute,
  isWaypointRoute,
  orthoRoutePath,
  routePathByType,
  type AnchorSide,
  type BendRoute,
  type EdgeRoute,
  type LegacyRoute,
  type WaypointRoute,
} from '@flow/core';

function posToSide(p?: Position): AnchorSide {
  if (p === Position.Top) return 'top';
  if (p === Position.Bottom) return 'bottom';
  if (p === Position.Left) return 'left';
  return 'right';
}

interface ManualEdgeData {
  route?: EdgeRoute | null;
  /** 连线类型（肘线 / 曲线 / 直线）—— 决定折点之间的「穿线方式」 */
  _et?: string;
  /** 端点锚点坐标（由 FlowCanvas 按 {side,t} 现算，随节点移动/缩放更新） */
  _ap?: { x: number; y: number };
  _aSide?: AnchorSide;
  _bp?: { x: number; y: number };
  _bSide?: AnchorSide;
  /** 标签是否高亮（路线主干），影响 chip 配色 */
  _lblActive?: boolean;
  /** 点2(b) 自动亮暗：情景路线外（所在边被压暗）→ chip 跟着淡出 */
  _lblDim?: boolean;
  /** 点2(b) 自动亮暗：链路追踪结果（FlowCanvas 从 chain 类名推导传入） */
  _chain?: 'hit' | 'miss';
  /** 0918 二修：说明在连线上的位置 = 弧长比例 0~1（持久化在 edge.data.labelT）。
   *  存「沿线比例」而不是自由偏移 —— chip 必须贴在线上，只允许沿线滑动。 */
  _lblT?: number;
  /** 旧版自由偏移（edge.data.labelOffset）—— 仅用于一次性迁移到 _lblT，之后不再写 */
  _lblOff?: { dx: number; dy: number };
  /** 标签改名回调（由 FlowCanvas 注入；函数字段不参与持久化） */
  _onRename?: (edgeId: string, text: string) => void;
  /** 0918 二修：拖动提交（写 labelT）。silent = 迁移用，不进撤销历史 */
  _onMoveLabel?: (edgeId: string, t: number, opts?: { silent?: boolean }) => void;
}

function ManualEdgeImpl(props: EdgeProps) {
  const d0 = (props.data ?? {}) as ManualEdgeData;
  const route = d0.route;

  /* —— 连线说明标签：HTML chip（限宽换行 + 就地编辑 + 可拖动） —— */
  const labelText = typeof props.label === 'string' ? props.label : '';
  const [editing, setEditing] = useState(false);
  const chipRef = useRef<HTMLSpanElement>(null);
  /* 0918 二修：chip 只能「沿线滑动」—— 拖动时把光标投影到连线路径上取最近点，
     位置以「弧长比例 t」持久化（edge.data.labelT），而不是相对中点的自由偏移。
     这样 chip 永远贴在连线上，拖多远都不会跑到两个节点之外。 */
  const rf = useReactFlow();
  const wrapRef = useRef<SVGGElement>(null);
  /** 拖动中的本地坐标（跟手、不进历史），松手后由持久 labelT 接管 */
  const [dragPt, setDragPt] = useState<{ x: number; y: number } | null>(null);
  /** 静止态下按持久 t 算出的坐标（path 变化 → 重算，节点挪了 chip 也跟着走） */
  const [restPt, setRestPt] = useState<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const lblT = typeof d0._lblT === 'number' && Number.isFinite(d0._lblT) ? d0._lblT : undefined;
  const lblOff = d0._lblOff;

  const pathEl = useCallback((): SVGPathElement | null => {
    const g = wrapRef.current;
    if (!g) return null;
    return g.querySelector('path.react-flow__edge-path') as SVGPathElement | null;
  }, []);

  /** 把画布坐标投影到连线路径：粗采样找最近段 → 三分法细化 → 返回 {t, x, y} */
  const projectOnPath = useCallback(
    (fx: number, fy: number) => {
      const p = pathEl();
      if (!p) return null;
      const total = p.getTotalLength();
      if (!total) return null;
      const d2 = (l: number) => {
        const q = p.getPointAtLength(l);
        return (q.x - fx) * (q.x - fx) + (q.y - fy) * (q.y - fy);
      };
      const N = 48;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i <= N; i++) {
        const l = (total * i) / N;
        const dd = d2(l);
        if (dd < bestD) {
          bestD = dd;
          best = l;
        }
      }
      /* 在 ±1 段内三分收敛（12 次 → 精度 ≈ total/48/2^6，远小于 1px） */
      let lo = Math.max(0, best - total / N);
      let hi = Math.min(total, best + total / N);
      for (let k = 0; k < 12; k++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        if (d2(m1) < d2(m2)) hi = m2;
        else lo = m1;
      }
      /* 端点留 5% 余量：chip 不该糊在节点边框上 */
      const t = Math.min(0.95, Math.max(0.05, (lo + hi) / 2 / total));
      const q = p.getPointAtLength(t * total);
      return { t, x: q.x, y: q.y };
    },
    [pathEl]
  );

  const startChipDrag = useCallback(
    (e: React.PointerEvent) => {
      /* 0918：不再要求「先选中连线」。此前未选中时 chip 是 pointer-events:none，
         用户一拖就等于在拖线身（走线变形），chip 只能跟着线走。现在任何状态下都能
         直接抓着 chip 拖 —— 且只能沿连线滑动（投影），不会掉出连线之外。 */
      if (editing) return;
      e.stopPropagation();
      e.preventDefault();
      draggingRef.current = true;
      let last: number | null = null;
      const onMove = (ev: PointerEvent) => {
        const f = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        const pr = projectOnPath(f.x, f.y);
        if (!pr) return;
        last = pr.t;
        setDragPt({ x: pr.x, y: pr.y });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        draggingRef.current = false;
        setDragPt(null);
        if (last !== null) d0._onMoveLabel?.(props.id, last);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [props.id, editing, d0, rf, projectOnPath]
  );

  /* 进入编辑时灌一次初值并全选，之后内容交给浏览器管 ——
     不走 React 受控，否则每次输入都会把光标顶回开头。 */
  useEffect(() => {
    if (!editing) return;
    const el = chipRef.current;
    if (!el) return;
    el.textContent = labelText;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [editing]);

  const commit = useCallback(() => {
    const v = (chipRef.current?.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    d0._onRename?.(props.id, v);
    setEditing(false);
  }, [d0, props.id]);

  /* v3 段平移（WP5c，现行）优先；v2 必经点 / v1 单轴路由按旧方式渲染（零回归） */
  const bd: BendRoute | null = isBendRoute(route) ? route : null;
  const wp: WaypointRoute | null = !bd && isWaypointRoute(route) ? route : null;
  const legacy: LegacyRoute | null = !bd && isLegacyRoute(route) ? route : null;

  const ax = d0._ap?.x ?? props.sourceX;
  const ay = d0._ap?.y ?? props.sourceY;
  const bx = d0._bp?.x ?? props.targetX;
  const by = d0._bp?.y ?? props.targetY;
  const aSide = d0._aSide ?? posToSide(props.sourcePosition);
  const bSide = d0._bSide ?? posToSide(props.targetPosition);

  /* v3 段平移：只把被选中的那一段推开，端点出线方向锁死（WP5c 核心修复） */
  const bendRes =
    bd !== null
      ? bendRoutePath(d0._et, { ax, ay, aSide, bx, by, bSide, bends: bd.bends })
      : null;

  /* v2 折点路由 or 端点被吸到自定义位置 → 走自绘路由（旧路径，仅老文档会走到）。
     穿线方式按连线类型分派：肘线=正交圆角，曲线=平滑穿点，直线=尖角折线。 */
  const res =
    bendRes === null && (wp !== null || d0._ap || d0._bp)
      ? routePathByType(d0._et, { ax, ay, aSide, bx, by, bSide, points: wp?.points ?? [] })
      : null;
  const legacyRes =
    bendRes === null &&
    res === null &&
    legacy !== null
      ? orthoRoutePath({ ax, ay, aSide, bx, by, bSide, route: legacy })
      : null;

  let path = '';
  let lx = 0;
  let ly = 0;
  if (bendRes) {
    path = bendRes.d;
    lx = bendRes.lx;
    ly = bendRes.ly;
  } else if (res) {
    path = res.d;
    lx = res.lx;
    ly = res.ly;
  } else if (legacyRes) {
    path = legacyRes.d;
    lx = legacyRes.lx;
    ly = legacyRes.ly;
  } else {
    const pp = {
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: props.sourcePosition,
      targetX: props.targetX,
      targetY: props.targetY,
      targetPosition: props.targetPosition,
    };
    if (d0._et === 'default') [path, lx, ly] = getBezierPath(pp);
    else if (d0._et === 'straight') [path, lx, ly] = getStraightPath(pp);
    /* borderRadius 与 FlowCanvas 里 pathOptions 的 10 对齐，否则拐角和内置渲染不一致 */
    else [path, lx, ly] = getSmoothStepPath({ ...pp, borderRadius: 10 });
  }

  /* 静止态定位：持久 labelT → 路径上取点；没有 labelT 就用（旧）线中点 lx/ly。
     旧文档只有自由偏移 labelOffset（0918 首版）→ 现场投影成 t 并静默回写一次，
     之后就统一按 labelT 走（老图不会「一键归位」到中点）。 */
  useLayoutEffect(() => {
    if (draggingRef.current) return;
    if (lblT !== undefined) {
      const p = pathEl();
      const total = p?.getTotalLength() ?? 0;
      if (!p || !total) return;
      const t = Math.min(0.95, Math.max(0.05, lblT));
      const q = p.getPointAtLength(t * total);
      setRestPt((prev) =>
        prev && Math.abs(prev.x - q.x) < 0.5 && Math.abs(prev.y - q.y) < 0.5 ? prev : { x: q.x, y: q.y }
      );
      return;
    }
    if (lblOff) {
      const pr = projectOnPath(lx + lblOff.dx, ly + lblOff.dy);
      if (pr) {
        setRestPt({ x: pr.x, y: pr.y });
        d0._onMoveLabel?.(props.id, pr.t, { silent: true });
        return;
      }
    }
    setRestPt(null);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [path, lblT, lblOff, lx, ly]);

  /* chip 最终坐标：拖动中跟手 → 静止按 labelT → 都没有 = 线中点（旧行为） */
  const chipPt = dragPt ?? restPt ?? { x: lx, y: ly };

  return (
    <>
      <g ref={wrapRef}>
        <BaseEdge
          id={props.id}
          path={path}
          markerEnd={props.markerEnd}
          markerStart={props.markerStart}
          style={props.style}
          /* 加宽命中带：2px 的线不该只有 2px 的可抓范围 */
          interactionWidth={props.interactionWidth ?? 26}
        />
      </g>
      {labelText && (
        <EdgeLabelRenderer>
          <div
            className={`edge-chip${d0._lblActive ? ' is-active' : ''}${
              editing ? ' is-editing' : ''
            }${d0._lblDim ? ' is-dim' : ''}${
              d0._chain === 'hit' ? ' is-hit' : d0._chain === 'miss' ? ' is-miss' : ''
            }${dragPt ? ' is-dragging' : ''}`}
            style={{
              /* 0918 二修：坐标直接取「连线上的投影点」—— chip 永远贴在线上，
                 只能前后滑动，拖不出这条线（此前是中点+自由偏移，能拖到画布任何地方）。 */
              transform: `translate(-50%, -50%) translate(${chipPt.x}px, ${chipPt.y}px)`,
              /* 一律可交互 —— 未选中也能直接拖（此前穿透到线身会让用户误以为
                 「描述只能沿连线移动」）。拖线身改走向仍可在线的其他位置进行。 */
              pointerEvents: 'all',
              cursor: editing ? undefined : dragPt ? 'grabbing' : 'grab',
            }}
            data-testid="edge-chip"
            title="沿连线拖动调整位置 · 双击编辑连线说明"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            onPointerDown={startChipDrag}
          >
            {editing ? (
              <span
                ref={chipRef}
                className="edge-chip-text"
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-label="连线名称"
                spellCheck={false}
                data-testid="edge-chip-editor"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditing(false);
                  }
                }}
                onBlur={commit}
                onPaste={(e) => {
                  e.preventDefault();
                  const t = e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ');
                  document.execCommand('insertText', false, t);
                }}
                onPointerDown={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="edge-chip-text">{labelText}</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const ManualEdge = memo(ManualEdgeImpl);
ManualEdge.displayName = 'ManualEdge';
