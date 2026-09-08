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

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
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
  /** 标签改名回调（由 FlowCanvas 注入；函数字段不参与持久化） */
  _onRename?: (edgeId: string, text: string) => void;
}

function ManualEdgeImpl(props: EdgeProps) {
  const d0 = (props.data ?? {}) as ManualEdgeData;
  const route = d0.route;

  /* —— 连线说明标签：HTML chip（限宽换行 + 就地编辑） —— */
  const labelText = typeof props.label === 'string' ? props.label : '';
  const [editing, setEditing] = useState(false);
  const chipRef = useRef<HTMLSpanElement>(null);

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

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        markerStart={props.markerStart}
        style={props.style}
        /* 加宽命中带：2px 的线不该只有 2px 的可抓范围 */
        interactionWidth={props.interactionWidth ?? 26}
      />
      {labelText && (
        <EdgeLabelRenderer>
          <div
            className={`edge-chip${d0._lblActive ? ' is-active' : ''}${
              editing ? ' is-editing' : ''
            }`}
            style={{
              transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
              /* 未选中时穿透：否则 chip 会挡住「拖线身改走向」这个高频操作。
                 选中后才可交互 —— 与飞书「选中连线说明才能拖动 / 编辑」一致。 */
              pointerEvents: props.selected || editing ? 'all' : 'none',
            }}
            data-testid="edge-chip"
            title={props.selected ? '双击编辑连线说明' : undefined}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
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
