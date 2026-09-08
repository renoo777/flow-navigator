/**
 * ManualEdge：手动路由边（fn-manual）
 *
 * 四档渲染，逐级回退，保证任何异常都不会画坏：
 *   1. v3 段平移（data.route.bends，现行）→ bendRoutePath：只推开被选中的那一段，
 *      端点出线方向锁死、只有局部变形（WP5c 修复「拉一处另一处变形」的核心）；
 *   2. v2 折点路由（data.route.points，旧文档）→ routePathByType，行为不变；
 *   3. v1 单轴路由（data.route.{axis,pos}，旧文档）→ orthoRoutePath，行为不变；
 *   4. 以上都不成立 → 透传 RF 内置渲染（按类型选 Bezier / Straight / SmoothStep）。
 *
 * 端点坐标优先用 data._ap/_bp（用户把端点吸到边框任意位置后的锚点），
 * 否则用 RF 给的 handle 中心。
 *
 * 注：折点 / 端点手柄不在这里画 —— 由 FlowCanvas 的统一覆盖层负责。
 * 原因：没有折点的边走的是 RF 内置渲染器，若手柄挂在自定义边里，
 * 这些边就永远没有端点手柄可用（用户得先拖出折点才能调端点，不合理）。
 */

import { memo } from 'react';
import {
  BaseEdge,
  BezierEdge,
  SmoothStepEdge,
  StraightEdge,
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
}

function ManualEdgeImpl(props: EdgeProps) {
  const d0 = (props.data ?? {}) as ManualEdgeData;
  const route = d0.route;

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

  if (bendRes === null && res === null && legacyRes === null) {
    if (d0._et === 'default') return <BezierEdge {...props} />;
    if (d0._et === 'straight') return <StraightEdge {...props} />;
    return <SmoothStepEdge {...props} />;
  }

  return (
    <BaseEdge
      id={props.id}
      path={bendRes?.d ?? res?.d ?? legacyRes?.d ?? ''}
      markerEnd={props.markerEnd}
      markerStart={props.markerStart}
      style={props.style}
      labelX={bendRes?.lx ?? res?.lx ?? legacyRes?.lx ?? 0}
      labelY={bendRes?.ly ?? res?.ly ?? legacyRes?.ly ?? 0}
      label={props.label}
      labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg}
      labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding}
      labelBgBorderRadius={props.labelBgBorderRadius}
      /* 加宽命中带：2px 的线不该只有 2px 的可抓范围 */
      interactionWidth={props.interactionWidth ?? 26}
    />
  );
}

export const ManualEdge = memo(ManualEdgeImpl);
ManualEdge.displayName = 'ManualEdge';
