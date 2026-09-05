/** 示例流程：司机接单客服 SOP —— 数据直接取自 interactive-flow-builder.html 的 SAMPLE_DEF */
import type { Assignments } from './types';
import type { EdgeDef, NodeDef } from './engine';

export const SAMPLE_NAME = '司机接单客服 SOP';

export const SAMPLE_NODE_DEFS: NodeDef[] = [
  {
    id: 's', label: '开始', kind: 'io-start', talk: [
      { side: 'agent', text: '您好，我是平台客服小安。您的用车行程已发布，我来帮您跟进司机接单，请稍等。' },
    ],
  },
  {
    id: 'd1', label: '有没有司机报价？', kind: 'decision', talk: [
      { side: 'agent', text: '我先看一下当前有没有司机在报价，稍等片刻。' },
    ],
  },
  {
    id: 'a1', label: '有报价：核对实时报价', kind: 'step', talk: [
      { side: 'agent', text: '现在有 3 位司机报价：最低 86 元、最快 3 分钟接驾，您看可以吗？' },
      { side: 'cust', text: '这么快，那可以。' },
    ],
  },
  {
    id: 'a2', label: '无报价：平台统一定价', kind: 'step', talk: [
      { side: 'agent', text: '目前还没有司机主动报价，平台已按路线自动定价 92 元并派单，预计 5 分钟内会有司机接单。' },
      { side: 'cust', text: '行，那我等司机接单。' },
    ],
  },
  {
    id: 'd2', label: '司机是否同意报价？', kind: 'decision', talk: [
      { side: 'agent', text: '司机那边已经看到报价，正在确认。需要我帮您催一下吗？' },
    ],
  },
  {
    id: 'n2', label: '安抚话术 · 不要取消订单', kind: 'step', talk: [
      { side: 'agent', text: '师傅这边还在考虑价格，您先别取消订单，我帮您去沟通，争取尽快确认下来。' },
      { side: 'cust', text: '好吧，那我再等等。' },
    ],
  },
  {
    id: 'y2', label: '强调立刻操作同意报价', kind: 'step', talk: [
      { side: 'agent', text: '司机已同意报价！请您在 app 弹窗上点「同意」，点了之后车辆就锁定了。' },
      { side: 'cust', text: '收到，我马上点。' },
    ],
  },
  {
    id: 'd3', label: '用户表示不会操作吗？', kind: 'decision', talk: [
      { side: 'agent', text: '您那边操作还顺利吗？如果找不到确认按钮，随时跟我说。' },
    ],
  },
  {
    id: 'no1', label: '引导：司机报价位置入口', kind: 'step', talk: [
      { side: 'cust', text: '我没找到同意按钮在哪里。' },
      { side: 'agent', text: '您打开 app 首页的「进行中订单」，报价卡片右下角有个蓝色「同意」按钮，点它就行。' },
      { side: 'cust', text: '找到了，已经点同意。' },
    ],
  },
  {
    id: 'ok1', label: '嘱咐注意接听电话', kind: 'step', talk: [
      { side: 'agent', text: '好的，司机确认后会在 5 分钟内联系您，请留意接听电话，保持手机畅通。' },
    ],
  },
  {
    id: 'nt1', label: '提醒关注消息别取消订单', kind: 'step', talk: [
      { side: 'agent', text: '我看司机还在报价中，请您先别取消订单，我会盯着订单状态，司机一确认就第一时间通知您。' },
    ],
  },
  {
    id: 'e', label: '结束语', kind: 'io-end', talk: [
      { side: 'agent', text: '本次用车已安排妥当，祝您出行顺利！有任何问题随时找我小安。' },
      { side: 'cust', text: '好的，谢谢！' },
    ],
  },
];

export const SAMPLE_EDGE_DEFS: EdgeDef[] = [
  { s: 's', t: 'd1', label: '' },
  { s: 'd1', t: 'a1', label: '有报价' },
  { s: 'd1', t: 'a2', label: '无报价' },
  { s: 'a1', t: 'd2', label: '' },
  { s: 'd2', t: 'n2', label: '不同意报价' },
  { s: 'd2', t: 'y2', label: '同意报价' },
  { s: 'a2', t: 'e', label: '' },
  { s: 'n2', t: 'e', label: '' },
  { s: 'y2', t: 'd3', label: '' },
  { s: 'd3', t: 'no1', label: '不会操作' },
  { s: 'd3', t: 'ok1', label: '默认会操作' },
  { s: 'd3', t: 'nt1', label: '没看到实时报价' },
  { s: 'no1', t: 'e', label: '' },
  { s: 'ok1', t: 'e', label: '' },
  { s: 'nt1', t: 'e', label: '' },
];

/** 一键示例赋值：走「有报价 → 同意报价 → 不会操作」的深路径，演示高亮与灰显 */
export const PRESET_ASSIGNMENTS: Assignments = {
  d1: 'd1->a1',
  d2: 'd2->y2',
  d3: 'd3->no1',
};
