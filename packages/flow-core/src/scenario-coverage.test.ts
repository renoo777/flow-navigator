/** Bug1 回归：导入真实飞书板（28 节点/37 边，多返工回路）停用全部变量后，
 *  computeScenario 必须全图遍历完成 —— 历史 bug：非决策节点在回路上被重复
 *  展开烧光步数预算，遍历提前终止，出现「边已记亮、箭头指向的节点未记亮」
 *  （实测 28 节点仅 7 active、2 条 violation 边），用户观感即
 *  「箭头连线高亮了但连接的节点不高亮」。 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeScenario } from './engine';
import type { FlowEdge, FlowNode } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(
  readFileSync(join(here, '__fixtures__/feishu-board1.gold.json'), 'utf-8')
) as {
  nodes: { id: string; text: string; shape: string; bbox: number[] }[];
  edges: { id: string; label: string; fromNode: string | null; toNode: string | null }[];
};

function buildBoard1(): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = gold.nodes.map((n) => ({
    id: n.id,
    type: 'sop',
    position: { x: n.bbox[0], y: n.bbox[1] },
    data: {
      label: n.text ?? n.id,
      kind: n.shape === 'diamond' ? 'decision' : 'step',
      talk: [],
    },
  }));
  const edges: FlowEdge[] = gold.edges
    .filter((e) => e.fromNode && e.toNode)
    .map((e) => ({
      id: e.id,
      source: e.fromNode!,
      target: e.toNode!,
      type: 'smoothstep',
      label: e.label ?? '',
    }));
  return { nodes, edges };
}

describe('Bug1 回归：全图遍历不变量（停用全部变量 = 无变量全展开）', () => {
  const { nodes, edges } = buildBoard1();

  test('真实 28 节点板：所有节点与边都被遍历为活跃', () => {
    const r = computeScenario(nodes, edges, [], []);
    expect(r.activeNodes.size).toBe(nodes.length);
    expect(r.activeEdges.size).toBe(edges.length);
  });

  test('不变量：任意活跃边的两端节点必须都活跃（边亮 ⇒ 节点亮）', () => {
    const r = computeScenario(nodes, edges, [], []);
    const violations = edges.filter(
      (e) => r.activeEdges.has(e.id) && (!r.activeNodes.has(e.source) || !r.activeNodes.has(e.target))
    );
    expect(violations).toEqual([]);
  });

  test('有变量且已全选时同样不应出现半途截断', () => {
    /* 找一个出度 ≥2 的节点造变量，全选第一条出口：非决策回路不再烧预算，
       遍历应覆盖「选中分支的可达全图 + 未选分支截断」，且 violation 恒为 0 */
    const outCount = new Map<string, number>();
    edges.forEach((e) => outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1));
    const branch = [...outCount.entries()].find(([, c]) => c >= 2);
    expect(branch).toBeDefined();
    const [nodeId] = branch!;
    const firstOut = edges.find((e) => e.source === nodeId)!;
    const vars = [{ nodeId, question: nodeId, options: [{ edgeId: firstOut.id, label: firstOut.label }] }];
    const r = computeScenario(nodes, edges, vars as never, [{ nodeId, edgeId: firstOut.id }]);
    const violations = edges.filter(
      (e) => r.activeEdges.has(e.id) && !r.activeNodes.has(e.target)
    );
    expect(violations).toEqual([]);
  });
});
