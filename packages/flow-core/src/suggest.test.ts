/** suggestScenarioSteps：通用「一键示例路线」——不依赖任何硬编码 id */
import { describe, expect, it } from 'vitest';
import {
  assignmentsOf,
  buildGraph,
  computeScenario,
  deriveVariables,
  findBackEdges,
  suggestScenarioSteps,
} from './engine';
import type { FlowEdge, FlowNode } from './types';
import { SAMPLE_EDGE_DEFS, SAMPLE_NODE_DEFS } from './sample';

const sampleGraph = () => {
  const { nodes, edges } = buildGraph(SAMPLE_NODE_DEFS, SAMPLE_EDGE_DEFS);
  return { nodes, edges, vars: deriveVariables(nodes, edges) };
};

describe('suggestScenarioSteps', () => {
  it('示例模板：走「有报价 → 同意报价 → 不会操作」深路径', () => {
    const { nodes, edges, vars } = sampleGraph();
    const steps = suggestScenarioSteps(nodes, edges, vars);
    expect(steps).toEqual([
      { nodeId: 'd1', edgeId: 'd1->a1' },
      { nodeId: 'd2', edgeId: 'd2->y2' },
      { nodeId: 'd3', edgeId: 'd3->no1' },
    ]);
    const sc = computeScenario(nodes, edges, vars, steps);
    expect([...sc.pendingVars]).toEqual([]);
    expect([...sc.activeNodes].sort()).toEqual(['a1', 'd1', 'd2', 'd3', 'e', 'no1', 's', 'y2']);
  });

  it('任意图（id 全部换掉）也能一键生成路线，且不留下 pending 断点', () => {
    const { nodes: rawNodes, edges: rawEdges } = sampleGraph();
    /* 模拟飞书导入：节点/边 id 全部重签发 */
    const nodes: FlowNode[] = rawNodes.map((n, i) => ({
      id: `n${i}`,
      type: 'sop',
      position: { x: 0, y: 0 },
      data: n.data,
    }));
    const idMap = new Map(rawNodes.map((n, i) => [n.id, `n${i}`]));
    const edges: FlowEdge[] = rawEdges.map((e, i) => ({
      id: `e${i}`,
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
      type: 'step',
      label: e.label,
    }));
    const vars = deriveVariables(nodes, edges);
    const steps = suggestScenarioSteps(nodes, edges, vars);
    expect(steps.length).toBe(3);
    const sc = computeScenario(nodes, edges, vars, steps);
    expect([...sc.pendingVars]).toEqual([]);
    expect(sc.activeNodes.size).toBe(8); // s→d1→a1→d2→y2→d3→no1→e
  });

  it('带返工回路：两轮决策后停下，不死循环', () => {
    /* s→d1(通过→e / 打回→fix) ; fix→d1（回边） */
    const nodes: FlowNode[] = [
      { id: 's', type: 'sop', position: { x: 0, y: 0 }, data: { label: '开始', kind: 'io-start', talk: [] } },
      { id: 'd1', type: 'sop', position: { x: 0, y: 0 }, data: { label: '检查通过？', kind: 'decision', talk: [] } },
      { id: 'fix', type: 'sop', position: { x: 0, y: 0 }, data: { label: '返工修正', kind: 'step', talk: [] } },
      { id: 'e', type: 'sop', position: { x: 0, y: 0 }, data: { label: '结束', kind: 'io-end', talk: [] } },
    ];
    const edges: FlowEdge[] = [
      { id: 'e1', source: 's', target: 'd1', type: 'step', label: '' },
      { id: 'e2', source: 'd1', target: 'fix', type: 'step', label: '打回' },
      { id: 'e3', source: 'fix', target: 'd1', type: 'step', label: '' },
      { id: 'e4', source: 'd1', target: 'e', type: 'step', label: '通过' },
    ];
    const vars = deriveVariables(nodes, edges);
    expect(vars.map((v) => v.nodeId)).toEqual(['d1']);
    const steps = suggestScenarioSteps(nodes, edges, vars);
    /* 第一次取「打回」（下游更远）→ 回到 d1；第二次仍取「打回」会无限绕 → 第 3 次到达停下 */
    expect(steps.length).toBe(2);
    expect(steps.every((s) => s.edgeId === 'e2')).toBe(true);
    expect(findBackEdges(nodes, edges).has('e3')).toBe(true);
    const sc = computeScenario(nodes, edges, vars, steps);
    expect(sc.pendingVars.has('d1')).toBe(true); // 留给用户手选第 3 次
    expect(sc.visitCounts['d1']).toBe(3);
  });

  it('没有变量 / 空图：返回空数组（按钮语义上不会发生）', () => {
    const { nodes, edges } = sampleGraph();
    expect(suggestScenarioSteps([], [], [])).toEqual([]);
    expect(suggestScenarioSteps(nodes, edges, [])).toEqual([]);
  });

  it('生成的 steps 可稳定转成旧式取值表（最后一次决策为准）', () => {
    const { nodes, edges, vars } = sampleGraph();
    const steps = suggestScenarioSteps(nodes, edges, vars);
    const a = assignmentsOf(steps);
    expect(Object.keys(a).length).toBe(3);
    expect(a.d1).toBe('d1->a1');
  });
});
