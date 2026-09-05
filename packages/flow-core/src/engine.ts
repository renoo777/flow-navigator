/** 变量与情景核心算法 —— 语义移植自 rf-poc/src/engine.js（源自 interactive-flow-builder.html） */
import dagre from 'dagre';
import type {
  Assignments,
  FlowEdge,
  FlowNode,
  FlowVariable,
  FlowView,
  ScenarioResult,
} from './types';
import { TALK_W_MAX, TALK_W_MIN, TALK_W_DEFAULT } from './types';

/** 连线 id 构造（与画布 edgeId 约定一致） */
export const edgeIdOf = (s: string, t: string) => `${s}->${t}`;

/** 节点出口表：nodeId -> 出边数组 */
function outgoingByNode(edges: FlowEdge[]): Record<string, FlowEdge[]> {
  const out: Record<string, FlowEdge[]> = {};
  edges.forEach((e) => {
    (out[e.source] = out[e.source] || []).push(e);
  });
  return out;
}

/**
 * 情景演算：给定变量取值，从「无入边起点」深度遍历出情景子图。
 * - 非决策节点：所有出口都走
 * - 决策节点：只走选中出口；未赋值 → 停在该节点（pending，不继续下钻）
 * - 走不到的决策变量 → naVars（N/A）
 */
export function computeScenario(
  nodes: FlowNode[],
  edges: FlowEdge[],
  variables: FlowVariable[],
  assignments: Assignments
): ScenarioResult {
  const out = outgoingByNode(edges);
  const varByNode: Record<string, FlowVariable> = {};
  variables.forEach((v) => {
    varByNode[v.nodeId] = v;
  });

  const hasIn: Record<string, boolean> = {};
  edges.forEach((e) => {
    hasIn[e.target] = true;
  });
  const starters = nodes.filter((n) => !hasIn[n.id]).map((n) => n.id);
  if (!starters.length && nodes.length) starters.push(nodes[0].id);

  const activeNodes = new Set<string>();
  const activeEdges = new Set<string>();
  const pendingVars = new Set<string>();
  const seen = new Set<string>();
  const stack = [...starters];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    activeNodes.add(id);
    const outs = out[id] || [];
    const v = varByNode[id];
    if (v) {
      const pick = assignments[v.nodeId];
      if (!pick) {
        pendingVars.add(id);
        continue; // 走到决策点但未赋值 → 停住，等用户导航
      }
      outs.forEach((e) => {
        if (e.id === pick) {
          activeEdges.add(e.id);
          stack.push(e.target);
        }
      });
    } else {
      outs.forEach((e) => {
        activeEdges.add(e.id);
        stack.push(e.target);
      });
    }
  }
  const naVars = variables.filter((v) => !activeNodes.has(v.nodeId));
  return { activeNodes, activeEdges, pendingVars, naVars };
}

/**
 * 按图遍历序返回节点 id 序列（BFS 从无入边起点出发；无起点取 nodes[0]）。
 * 用于变量按首次出现序排列（US-08 AC2）。
 */
export function traversalOrder(nodes: FlowNode[], edges: FlowEdge[]): string[] {
  const hasIn: Record<string, boolean> = {};
  edges.forEach((e) => {
    hasIn[e.target] = true;
  });
  const starters = nodes.filter((n) => !hasIn[n.id]).map((n) => n.id);
  const queue: string[] = starters.length ? starters : nodes.length ? [nodes[0].id] : [];
  const seen = new Set<string>();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    edges
      .filter((e) => e.source === id)
      .forEach((e) => {
        if (!seen.has(e.target)) queue.push(e.target);
      });
  }
  // 不连通节点兜底按声明序追加
  nodes.forEach((n) => {
    if (!seen.has(n.id)) order.push(n.id);
  });
  return order;
}

/** 从图数据推导变量：连出 >=2 个出口的节点自动提升为变量，按 BFS 遍历首次出现序排列 */
export function deriveVariables(nodes: FlowNode[], edges: FlowEdge[]): FlowVariable[] {
  return deriveVariableCandidates(nodes, edges);
}

/**
 * 变量候选池（US：管理面板数据源）：连出 >=2 个出口的全部节点，按 BFS 序。
 * 「候选」与「启用」分离：候选是客观可设变量，启用集合决定导航时哪些停驻。
 */
export function deriveVariableCandidates(nodes: FlowNode[], edges: FlowEdge[]): FlowVariable[] {
  const out = outgoingByNode(edges);
  const order = traversalOrder(nodes, edges);
  const vars: FlowVariable[] = [];
  order.forEach((id) => {
    const n = nodes.find((x) => x.id === id);
    if (!n) return;
    const outs = out[n.id] || [];
    if (outs.length >= 2) {
      vars.push({
        nodeId: n.id,
        name: String(n.data.label || '').replace(/[？?]+$/, '').trim() || '变量',
        options: outs.map((e, i) => ({
          edgeId: e.id,
          label: e.label?.trim() || `出口 ${i + 1}`,
        })),
      });
    }
  });
  return vars;
}

/**
 * 解析「当前生效的变量」：enabled 为空数组 → 明确不启用任何变量；
 * enabled 为 null/undefined → 兼容旧数据，默认全部候选启用。
 */
export function resolveVariables(
  nodes: FlowNode[],
  edges: FlowEdge[],
  enabled: string[] | null | undefined
): FlowVariable[] {
  const candidates = deriveVariableCandidates(nodes, edges);
  if (!enabled) return candidates;
  const on = new Set(enabled);
  return candidates.filter((c) => on.has(c.nodeId));
}

/** 从 nodeDefs/edges（s/t 简写）构建画布数据 */
export interface NodeDef {
  id: string;
  label: string;
  kind: FlowNode['data']['kind'];
  talk?: FlowNode['data']['talk'];
}
export interface EdgeDef {
  s: string;
  t: string;
  label?: string;
}

export function buildGraph(nodeDefs: NodeDef[], edges: EdgeDef[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = nodeDefs.map((d) => ({
    id: d.id,
    type: 'sop',
    position: { x: 0, y: 0 },
    data: {
      label: d.label,
      kind: d.kind,
      talk: Array.isArray(d.talk) ? d.talk.map((t) => ({ ...t })) : [],
    },
  }));
  const es: FlowEdge[] = edges.map((e) => ({
    id: edgeIdOf(e.s, e.t),
    source: e.s,
    target: e.t,
    type: 'step',
    label: e.label || '',
  }));
  return { nodes, edges: es };
}

/** 估算节点宽高，供 dagre 布局（结构层 / 话术层两套）
 *  话术层需兼容两种渲染态：
 *  - 锁定态（情景导航 / 只读）：气泡列表（rows.length * 34 + 64）
 *  - 编辑态：可设置可编辑的表单（head + 行×40 + add 按钮 + 边距，更高一些）
 *  取两者大值，避免 dagre 按小值布局后编辑态节点互相覆盖。 */
export function estimateNodeSize(node: FlowNode, view: FlowView): { w: number; h: number } {
  const data = node.data;
  const label = data?.label ?? '';
  const w = Math.max(140, Math.min(300, label.length * 15 + 56));
  if (view === 'talk') {
    const rows = (data?.talk ?? []).filter((t) => t && t.text.trim());
    /** 卡片宽度：用户拖过把手就用 talkW，否则按最长一句自动撑开（上限 TALK_W_MAX） */
    const cardW = data?.talkW
      ? Math.min(TALK_W_MAX, Math.max(TALK_W_MIN, data.talkW))
      : (() => {
          const maxText = rows.reduce((m, r) => Math.max(m, r.text.length), 0);
          const auto = Math.max(w, Math.min(TALK_W_DEFAULT, maxText * 13 + 120));
          return Math.max(Math.min(auto, TALK_W_MAX), 250);
        })();

    /** 字数 → 折行行数：编辑态输入区宽 ≈ cardW - 108（side 60 + 删除 24 + gap/padding 24），
     *  12px 字号下中文按 12px/字估；气泡宽 ≈ cardW - 44。 */
    const wrapCount = (perLine: number) =>
      rows.reduce((s, r) => s + Math.max(1, Math.ceil(r.text.length / perLine)), 0);
    const editPerLine = Math.max(8, Math.floor((cardW - 108) / 12));
    const bubblePerLine = Math.max(8, Math.floor((cardW - 44) / 12));
    const editWrapped = wrapCount(editPerLine);
    const bubbleWrapped = wrapCount(bubblePerLine);

    /** 气泡态：每行 = 气泡(行高 22/行 + padding 12) + who 标签 14，再加 head 与卡片边距 */
    const bubbleH = bubbleWrapped * 22 + rows.length * (12 + 14) + 46;
    /** 编辑态：head 24 + gap 7 + 行(框 44 + 折行增量 18/行) + add 28 + 内边距 19 + 30 buffer
     *  （+30 buffer 沿用既有经验：覆盖 row-gap 与 textarea 高度抖动，避免 dagre 用小值定位后互相覆盖） */
    const formH =
      24 + 7 + rows.length * 44 + (editWrapped - rows.length) * 18 + 28 + 19 + 30;
    return { w: cardW, h: Math.max(bubbleH, formH) };
  }
  return { w, h: 46 };
}

/** dagre 自动布局（固定 TB 纵向 + 标准间距，US-07/F5 原始设计），只重排 position，不修改节点内容 */
export function layoutGraph(nodes: FlowNode[], edges: FlowEdge[], view: FlowView): FlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: 64,
    ranksep: 88,
    edgesep: 24,
    marginx: 60,
    marginy: 60,
  });
  g.setDefaultEdgeLabel(() => ({}));
  const sizes: Record<string, { w: number; h: number }> = {};
  nodes.forEach((n) => {
    const s = estimateNodeSize(n, view);
    sizes[n.id] = s;
    g.setNode(n.id, { width: s.w, height: s.h });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    const s = sizes[n.id];
    return { ...n, position: { x: p.x - s.w / 2, y: p.y - s.h / 2 } };
  });
}
