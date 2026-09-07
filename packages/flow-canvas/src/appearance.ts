/** 节点外观常量：kind 左彩条 rail / 类型 tag（与 PoC 视觉一致） */
import type { NodeKind } from '@flow/core';

export const KIND_RAIL: Record<NodeKind, string> = {
  'io-start': '#16a34a',
  'io-end': '#dc2626',
  decision: '#d97706',
  step: 'transparent',
};

export const KIND_TAG: Record<NodeKind, string> = {
  'io-start': '开始',
  'io-end': '结束',
  decision: '分支决策',
  step: '',
};

/** 节点类型菜单选项（新建节点时选择） */
export const KIND_OPTIONS: { kind: NodeKind; label: string; desc: string }[] = [
  { kind: 'step', label: '步骤', desc: '普通操作节点' },
  { kind: 'decision', label: '分支决策', desc: '连出 ≥2 条分支即自动成为变量' },
  { kind: 'io-start', label: '开始', desc: '全图至多 1 个' },
  { kind: 'io-end', label: '结束', desc: '全图至多 1 个' },
];

/* ===== 连线样式（RF 内置 type 名 → 中文） ===== */
/** 连线样式三选（产品口径统一为「肘线 / 曲线 / 直线」；smoothstep 仍可被旧数据携带） */
export const EDGE_TYPE_DEFAULT = 'step';
export const EDGE_TYPE_OPTIONS: { id: string; label: string; hint: string }[] = [
  { id: 'step', label: '肘线', hint: '直角折线' },
  { id: 'default', label: '曲线', hint: '贝塞尔曲线' },
  { id: 'straight', label: '直线', hint: '直连两点' },
];
