/** 入口判定（回路/返工线）—— 回归用：环图不能再退化成「取 nodes[0]」 */
import { describe, expect, it } from 'vitest';
import { buildGraph, computeScenario, deriveVariableCandidates, findEntryNodes } from './engine';
import type { NodeDef, EdgeDef } from './engine';

const N = (id: string, label: string, kind: NodeDef['kind'] = 'step'): NodeDef => ({ id, label, kind });
const E = (s: string, t: string, label = ''): EdgeDef => ({ s, t, label });

describe('findEntryNodes', () => {
  it('有显式开始节点时优先用它（即使它也有入边）', () => {
    const { nodes, edges } = buildGraph(
      [N('X', '旁支'), N('S', '开始', 'io-start'), N('A', '步骤')],
      [E('S', 'A'), E('A', 'S'), E('A', 'X')] // S 有入边，但它是 io-start
    );
    expect(findEntryNodes(nodes, edges)).toEqual(['S']);
  });

  it('无环：取全部无入边节点', () => {
    const { nodes, edges } = buildGraph(
      [N('A', 'a'), N('B', 'b'), N('C', 'c')],
      [E('A', 'C'), E('B', 'C')]
    );
    expect(findEntryNodes(nodes, edges).sort()).toEqual(['A', 'B']);
  });

  it('全环（每个节点都有入边）：SCC 缩点取源分量全部节点，不再只看 nodes[0]', () => {
    /* 返工回路：S 提交 → B 填写 → C 审核 → D 归档；C→B 打回；D→S 重新申请
       节点数组第一个故意放无关节点，模拟飞书导入的随机顺序 */
    const { nodes, edges } = buildGraph(
      [N('Z', '补充说明'), N('S', '提交申请?', 'decision'), N('B', '填写资料'), N('C', '审核?', 'decision'), N('D', '归档')],
      [E('S', 'B', '是'), E('S', 'D', '否'), E('B', 'C'), E('C', 'D', '通过'), E('C', 'B', '打回'), E('D', 'S', '重新申请')]
    );
    const entries = findEntryNodes(nodes, edges);
    /* S 与 Z 各自独立入度为 0 的分量（Z 完全孤立），都应作为入口 */
    expect(entries).toContain('S');
    expect(entries).toContain('Z');
  });

  it('纯环：取源分量一个代表（环强连通，任一入口可达全环，不多取避免幻影到达）', () => {
    const { nodes, edges } = buildGraph(
      [N('A', 'a'), N('B', 'b'), N('C', 'c')],
      [E('A', 'B'), E('B', 'C'), E('C', 'A')]
    );
    expect(findEntryNodes(nodes, edges)).toEqual(['A']);
  });
});

describe('computeScenario · 回路场景', () => {
  it('返工回路下，变量不再被误判为不可达（修复前：全部 N/A 且按钮禁用）', () => {
    const { nodes, edges } = buildGraph(
      [N('Z', '补充说明'), N('S', '提交申请?', 'decision'), N('B', '填写资料'), N('C', '审核?', 'decision'), N('D', '归档')],
      [E('S', 'B', '是'), E('S', 'D', '否'), E('B', 'C'), E('C', 'D', '通过'), E('C', 'B', '打回'), E('D', 'S', '重新申请')]
    );
    const vars = deriveVariableCandidates(nodes, edges);
    expect(vars.map((v) => v.nodeId).sort()).toEqual(['C', 'S']);
    const r = computeScenario(nodes, edges, vars, {});
    /* S 必须可达并处于待选；修复前 activeNodes 只有 'Z'，两个变量全 N/A */
    expect(r.activeNodes.has('S')).toBe(true);
    expect(r.pendingVars.has('S')).toBe(true);
  });

  it('无环图行为不变（回归）', () => {
    const { nodes, edges } = buildGraph(
      [N('A', 'a?', 'decision'), N('B', 'b'), N('C', 'c')],
      [E('A', 'B', '是'), E('A', 'C', '否')]
    );
    const vars = deriveVariableCandidates(nodes, edges);
    const r = computeScenario(nodes, edges, vars, { A: 'A->B' });
    expect([...r.activeNodes].sort()).toEqual(['A', 'B']);
    expect(r.naVars).toHaveLength(0);
  });
});
