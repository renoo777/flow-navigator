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

  it('带返工回路：走一圈就推进到终点，不绕第二圈、不留 pending', () => {
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
    /* 「一圈即止」：d1 只有 1 条决策，且选的是往前推进的「通过」——
       「打回」是回退型出口（会走回路径前序节点），示例路线不代选它，
       留给用户在导航里自己点。这样路线能走到终点，而不是原地绕两圈后卡住。 */
    expect(steps).toEqual([{ nodeId: 'd1', edgeId: 'e4' }]);
    expect(findBackEdges(nodes, edges).has('e3')).toBe(true);
    const sc = computeScenario(nodes, edges, vars, steps);
    expect(sc.pendingVars.size).toBe(0); // 一圈走完直达终点，无待定断点
    expect(sc.visitCounts['d1']).toBe(1); // 判断点只经过一次，不绕第二圈
    expect(sc.activeNodes.has('e')).toBe(true); // 示例路线确实走到了终点
    expect(sc.activeNodes.has('fix')).toBe(false); // 回退分支留给用户手选
  });

  it('所有出口都是回退（纯死循环，无推进出路）也不无限绕', () => {
    /* a(2 出口，都是回退型) →b→a；b→a 是回边，a→b 走回去也是环上 →
       示例路线无「推进型出口」可选，兜底选一条，但每决策点只代选 1 轮 → 有界终止 */
    const nodes: FlowNode[] = [
      { id: 'a', type: 'sop', position: { x: 0, y: 0 }, data: { label: '再试一次？', kind: 'decision', talk: [] } },
      { id: 'b', type: 'sop', position: { x: 0, y: 0 }, data: { label: '重试', kind: 'step', talk: [] } },
      { id: 'c', type: 'sop', position: { x: 0, y: 0 }, data: { label: '再重试', kind: 'step', talk: [] } },
    ];
    const edges: FlowEdge[] = [
      { id: 'x1', source: 'a', target: 'b', type: 'step', label: '重试' },
      { id: 'x2', source: 'a', target: 'c', type: 'step', label: '再重试' },
      { id: 'x3', source: 'b', target: 'a', type: 'step', label: '' },
      { id: 'x4', source: 'c', target: 'a', type: 'step', label: '' },
    ];
    const vars = deriveVariables(nodes, edges);
    expect(vars.map((v) => v.nodeId)).toEqual(['a']);
    const steps = suggestScenarioSteps(nodes, edges, vars);
    /* 纯环：每决策点只代选 1 轮，绝不无限 */
    expect(steps.length).toBe(1);
    const sc = computeScenario(nodes, edges, vars, steps);
    /* 有界终止：a 第 2 次被经过时没有第 2 条决策 → 停在 a 等用户手选 */
    expect(sc.pendingVars.has('a')).toBe(true);
    expect(sc.visitCounts['a']).toBe(2);
    expect(sc.activeNodes.size).toBeLessThanOrEqual(3); // 没在这三个节点间反复打转
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
