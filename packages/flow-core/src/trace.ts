/** 链路追踪（上下游高亮）—— 纯函数，便于单测。
 *  用法：点击某节点 → 高亮它的来龙（上游）与去脉（下游），其余淡出。
 *  入参只取 id/source/target，React Flow 的 Edge 可直接传进来。 */
type EdgeLike = Pick<FlowEdge, 'id' | 'source' | 'target'>;
import type { FlowEdge } from './types';

export type ChainScope = 'adjacent' | 'full';

export interface ChainResult {
  /** 命中节点 id（含起点本身） */
  nodes: Set<string>;
  /** 命中连线 id */
  edges: Set<string>;
  /** 上游节点 id（不含起点） */
  upstream: Set<string>;
  /** 下游节点 id（不含起点） */
  downstream: Set<string>;
}

const EMPTY: ChainResult = {
  nodes: new Set(),
  edges: new Set(),
  upstream: new Set(),
  downstream: new Set(),
};

/** 广度优先走单向（dir: 'down' 顺出边 / 'up' 逆入边），命中节点与边写进 acc。
 *  maxDepth: Infinity = 走到尽头；1 = 只走一跳（相邻）。 */
function walk(
  start: string,
  edges: EdgeLike[],
  dir: 'down' | 'up',
  maxDepth: number
): { nodes: Set<string>; edges: Set<string> } {
  const out: Record<string, EdgeLike[]> = {};
  const inn: Record<string, EdgeLike[]> = {};
  edges.forEach((e) => {
    (out[e.source] = out[e.source] || []).push(e);
    (inn[e.target] = inn[e.target] || []).push(e);
  });

  const nodes = new Set<string>();
  const hit = new Set<string>();
  let frontier = [start];
  let depth = 0;

  while (frontier.length && depth < maxDepth) {
    const next: string[] = [];
    for (const id of frontier) {
      const list = dir === 'down' ? out[id] || [] : inn[id] || [];
      for (const e of list) {
        hit.add(e.id);
        const nb = dir === 'down' ? e.target : e.source;
        if (nb === start || nodes.has(nb)) continue;
        nodes.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
    depth += 1;
  }
  return { nodes, edges: hit };
}

/**
 * 追踪某节点的上下游链路。
 * - scope='adjacent'：只取直接上下游一跳（快速看「谁连着我」）
 * - scope='full'：全链路（来龙去脉一路到底），环图靠 visited 集合终止
 * 起点自身恒在 nodes 里；孤立节点返回仅含自身。
 */
export function traceChain(
  nodeId: string | null,
  edges: EdgeLike[],
  scope: ChainScope = 'full'
): ChainResult {
  if (!nodeId) return { nodes: new Set(), edges: new Set(), upstream: new Set(), downstream: new Set() };
  const maxDepth = scope === 'adjacent' ? 1 : Infinity;
  const down = walk(nodeId, edges, 'down', maxDepth);
  const up = walk(nodeId, edges, 'up', maxDepth);
  const nodes = new Set<string>([nodeId, ...down.nodes, ...up.nodes]);
  const hit = new Set<string>([...down.edges, ...up.edges]);
  return {
    nodes,
    edges: hit,
    upstream: up.nodes,
    downstream: down.nodes,
  };
}

export { EMPTY as EMPTY_CHAIN };
