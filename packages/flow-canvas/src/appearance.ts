/** 节点外观常量：kind 左彩条 rail / 类型 tag（与 PoC 视觉一致） */
import type { NodeKind } from '@flow/core';
import type { ExprType } from './components/ExprNodes';

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

/** WP4 自由表达元素（白板批注层，不参与演算）：便签 / 贴图 / 标注 */
export const EXPR_OPTIONS: { type: ExprType; label: string; desc: string }[] = [
  { type: 'note', label: '便签', desc: '记事贴纸 · 双击写多行' },
  { type: 'image', label: '贴图', desc: '本地图片 / 图片链接' },
  { type: 'label', label: '标注', desc: '说明文字 · 可拖指示箭头' },
];

/* ===== 连线样式（产品口径「肘线 / 曲线 / 直线」→ RF 内置 type） ===== */
/**
 * 「肘线」底层用 smoothstep（圆角正交）而非 step（直角）：
 * 用户反馈直角肘线「僵硬」，且导入弹窗的预览 SVG 本就是圆角（Q 拐角）——
 * 现在预览与落地一致。旧数据里 step 读入时由 normalizeEdge 迁移为 smoothstep。
 */
export const EDGE_TYPE_DEFAULT = 'smoothstep';
export const EDGE_TYPE_OPTIONS: { id: string; label: string; hint: string }[] = [
  { id: 'smoothstep', label: '肘线', hint: '圆角折线' },
  { id: 'default', label: '曲线', hint: '贝塞尔曲线' },
  { id: 'straight', label: '直线', hint: '直连两点' },
];
