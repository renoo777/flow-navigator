/** 变量导航器 · flow-core 数据模型（纯 TS，零 UI 依赖） */

/** 节点种类：开始 / 结束 / 分支决策 / 普通步骤 */
export type NodeKind = 'io-start' | 'io-end' | 'decision' | 'step';

/** 话术层一句话（对话气泡） */
export interface TalkLine {
  side: 'agent' | 'cust';
  text: string;
}

/** 话术卡片里两个说话方的自定义称呼（缺省：客服 / 客户） */
export interface TalkRoles {
  agent?: string;
  cust?: string;
}

/** 话术卡片左右布局：agentLeft=客服在左（默认）；agentRight=客服在右 */
export type TalkDir = 'agentLeft' | 'agentRight';

/** 话术卡片宽度档位（px），拖拽把手写入，缺省走 TALK_W_DEFAULT */
export const TALK_W_MIN = 240;
export const TALK_W_MAX = 620;
export const TALK_W_DEFAULT = 340;

/** 画布节点数据（自定义节点 sop 的 data 载荷） */
export interface SopData {
  label: string;
  kind: NodeKind;
  /** 话术层对话列表（可为空） */
  talk: TalkLine[];
  /** 自定义说话方称呼（节点级） */
  roles?: TalkRoles;
  /** 话术卡片左右方向（节点级） */
  talkDir?: TalkDir;
  /** 话术卡片宽度 px（拖拽把手写入） */
  talkW?: number;
}

/** 画布节点（与 React Flow Node 解耦，纯数据） */
export interface FlowNode {
  id: string;
  type: 'sop';
  position: { x: number; y: number };
  /**
   * 双视图独立坐标（Bug2 修复）：结构层卡片矮（h≈46）、话术层卡片高（h≈rows*40+80），
   * 共用一份 position 会导致切视图后必然重叠。结构层/话术层各自记一份坐标，互不干扰。
   */
  posByView?: Partial<Record<'flow' | 'talk', { x: number; y: number }>>;
  data: SopData;
}

/** 画布连线（source/target 为节点 id；label 为空串表示未命名出口） */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: 'step';
  label: string;
}

/** 变量定义：某节点连出 >=2 条线即自动提升为变量 */
export interface FlowVariable {
  nodeId: string;
  /** 展示名：取节点 label 去「？」尾；空时兜底「变量」 */
  name: string;
  options: { edgeId: string; label: string }[];
}

/** 情景演算结果 */
export interface ScenarioResult {
  /** 当前路径上被激活的节点 id 集合 */
  activeNodes: Set<string>;
  /** 当前路径上被激活的连线 id 集合 */
  activeEdges: Set<string>;
  /** 遍历中遇到、但尚未赋值的决策节点 id 集合（停驻等待导航） */
  pendingVars: Set<string>;
  /** 本轮情景走不到的决策变量（N/A） */
  naVars: FlowVariable[];
}

/** 变量取值表：变量节点 id -> 选中出口的 edge id（缺省=未赋值） */
export type Assignments = Record<string, string>;

/** 视图层：结构层（紧凑） / 话术层（对话卡片） */
export type FlowView = 'flow' | 'talk';

/** 模式：编辑画布 / 情景导航 / 只读查看（查看=禁一切写操作，情景导航与话术层仍可用） */
export type FlowMode = 'edit' | 'scenario' | 'view';
