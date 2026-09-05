/** 引导章节条（Build K-⑤）—— 按拓扑层级自动推导流程「章节」。
 *  规则：
 *   · 层级 = Kahn 拓扑 DP（level(n) = 1 + max(level(前置))，入度 0 从 0 起）
 *   · 环里绕不出来的节点归入最深一层（保证不丢节点）
 *   · 超过 max 章时按顺序均匀合并（示例图层多但语义少，合并比硬拆更可读）
 */
import type { SearchableNode } from './search';

export interface Chapter {
  depth: number;
  label: string;
  nodeIds: string[];
}

type EdgeLike = { source: string; target: string };

export function deriveChapters(
  nodes: SearchableNode[],
  edges: EdgeLike[],
  max = 6
): Chapter[] {
  if (!nodes.length) return [];
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);

  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const out: Record<string, EdgeLike[]> = {};
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    (out[e.source] = out[e.source] || []).push(e);
  }

  /* Kahn 分层 */
  const level = new Map<string, number>();
  let frontier = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  frontier.forEach((id) => level.set(id, 0));
  let depth = 0;
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      const lv = level.get(id) ?? 0;
      for (const e of out[id] ?? []) {
        indeg.set(e.target, (indeg.get(e.target) ?? 1) - 1);
        if ((indeg.get(e.target) ?? 0) === 0) {
          level.set(e.target, Math.max(lv + 1, level.get(e.target) ?? 0));
          next.push(e.target);
        }
      }
      depth = Math.max(depth, lv);
    }
    frontier = next;
  }

  /* 环中节点（没分到层）：归入最深一层 */
  const maxLv = level.size ? Math.max(...level.values()) : 0;
  for (const id of ids) if (!level.has(id)) level.set(id, maxLv);

  /* 按层聚合（保持传入顺序），空层跳过 */
  const byLv = new Map<number, string[]>();
  for (const n of nodes) {
    const lv = level.get(n.id) ?? 0;
    (byLv.get(lv) ?? byLv.set(lv, []).get(lv)!).push(n.id);
  }
  const levels = [...byLv.keys()].sort((a, b) => a - b);
  const groups: string[][] = levels.map((lv) => byLv.get(lv)!);

  /* 超额合并：每组 targetSize 层并成一章 */
  let nodeGroups = groups;
  if (groups.length > max) {
    const size = Math.ceil(groups.length / max);
    nodeGroups = [];
    for (let i = 0; i < groups.length; i += size) {
      nodeGroups.push(groups.slice(i, i + size).flat());
    }
  }

  const labelOf = new Map(nodes.map((n) => [n.id, (n.label ?? '').trim()]));
  return nodeGroups
    .filter((g) => g.length > 0)
    .map((g, i) => ({
      depth: i,
      label: labelOf.get(g[0]) || `阶段 ${i + 1}`,
      nodeIds: g,
    }));
}
