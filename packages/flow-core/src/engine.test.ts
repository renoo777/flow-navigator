import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  computeScenario,
  deriveVariableCandidates,
  deriveVariables,
  layoutGraph,
  resolveVariables,
  edgeIdOf,
} from './engine';
import { SAMPLE_EDGE_DEFS, SAMPLE_NODE_DEFS } from './sample';

const g = buildGraph(SAMPLE_NODE_DEFS, SAMPLE_EDGE_DEFS);
const { nodes, edges } = g;

/** 断言两个 id 数组相等（顺序无关） */
function sameSet(actual: Set<string>, expected: string[]) {
  expect([...actual].sort()).toEqual([...expected].sort());
}

describe('deriveVariables：≥2 出线即变量', () => {
  const vars = deriveVariables(nodes, edges);

  it('d1/d2/d3 是变量（2/2/3 出口），s/a1/a2/e 等不是', () => {
    const ids = vars.map((v) => v.nodeId).sort();
    expect(ids).toEqual(['d1', 'd2', 'd3']);
  });

  it('出口名取 edge.label，缺失时兜底「出口 n」', () => {
    const d1 = vars.find((v) => v.nodeId === 'd1')!;
    expect(d1.options.map((o) => o.label)).toEqual(['有报价', '无报价']);
    // 造一条无 label 的第三出口 → 兜底出口 3
    const fake = buildGraph(
      [{ id: 'x', label: '有没有货？', kind: 'decision' }],
      [
        { s: 'x', t: 'a', label: '有' },
        { s: 'x', t: 'b', label: '' },
      ]
    );
    const x = deriveVariables(fake.nodes, fake.edges)[0];
    expect(x.options.map((o) => o.label)).toEqual(['有', '出口 2']);
  });

  it('label 去「？」尾', () => {
    const d1 = vars.find((v) => v.nodeId === 'd1')!;
    expect(d1.name).toBe('有没有司机报价'); // 源 label「有没有司机报价？」去问号
  });

  it('单出线节点不是变量', () => {
    const single = buildGraph(
      [{ id: 'p', label: '纯步骤', kind: 'step' }],
      [{ s: 'p', t: 'q', label: '' }]
    );
    expect(deriveVariables(single.nodes, single.edges)).toHaveLength(0);
  });

  it('US-08 AC2: 变量按 BFS 拓扑序（非节点声明序）排列', () => {
    // 故意让 nodes 数组中变量顺序颠倒：BFS 应按 s→v1→v2→v3 顺序遇到三个变量
    const g = buildGraph(
      [
        { id: 's', label: '起点', kind: 'io-start' },
        { id: 'v3', label: '决策C？', kind: 'decision' }, // 排在数组前面
        { id: 'v2', label: '决策B？', kind: 'decision' }, // 排在数组前面
        { id: 'v1', label: '决策A？', kind: 'decision' }, // 真实应最先遇到（s→v1）
        { id: 'a', label: '走A', kind: 'step' },
        { id: 'b', label: '走B', kind: 'step' },
        { id: 'c', label: '走C', kind: 'step' },
        { id: 'd', label: '走D', kind: 'step' },
      ],
      [
        { s: 's', t: 'v1', label: '' },
        { s: 'v1', t: 'a', label: 'A 路径' },
        { s: 'v1', t: 'v2', label: 'B 路径' },
        { s: 'v2', t: 'b', label: 'b1' },
        { s: 'v2', t: 'v3', label: 'b2' },
        { s: 'v3', t: 'c', label: 'c1' },
        { s: 'v3', t: 'd', label: 'c2' },
      ]
    );
    const vars = deriveVariables(g.nodes, g.edges);
    // 拓扑序应为 v1 → v2 → v3；不是数组声明序 v3, v2, v1
    expect(vars.map((v) => v.nodeId)).toEqual(['v1', 'v2', 'v3']);
    expect(vars.map((v) => v.name)).toEqual(['决策A', '决策B', '决策C']);
  });
});

describe('deriveVariableCandidates：候选 = 全部 ≥2 出线节点（与启用无关）', () => {
  it('与 deriveVariables 结果一致（d1/d2/d3）', () => {
    const c = deriveVariableCandidates(nodes, edges);
    expect(c.map((v) => v.nodeId)).toEqual(['d1', 'd2', 'd3']);
  });
});

describe('resolveVariables：候选/启用集合分离', () => {
  it('enabled 为 null/undefined → 默认全部候选启用（旧数据兼容）', () => {
    expect(resolveVariables(nodes, edges, null).map((v) => v.nodeId)).toEqual(['d1', 'd2', 'd3']);
    expect(resolveVariables(nodes, edges, undefined).map((v) => v.nodeId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('enabled 空数组 → 明确不启用任何变量（删除变量到零）', () => {
    expect(resolveVariables(nodes, edges, [])).toHaveLength(0);
  });

  it('只启用勾选子集（如仅 d1）→ 仅返回该变量', () => {
    const v = resolveVariables(nodes, edges, ['d1']);
    expect(v.map((x) => x.nodeId)).toEqual(['d1']);
  });

  it('enabled 含已失效 id → 自动忽略（节点删除/少于 2 出线后）', () => {
    const v = resolveVariables(nodes, edges, ['d1', 'ghost']);
    expect(v.map((x) => x.nodeId)).toEqual(['d1']);
  });

  it('停用 d1（≠ 空）→ 仅 d2/d3 生效，且 computeScenario 不再把 d1 当决策点', () => {
    const vars = resolveVariables(nodes, edges, ['d2', 'd3']);
    // d1 被停用 → 遍历时 d1 不停止，a1+a2 都走 → active 扩张，d2 未赋值停驻 pending
    const sc = computeScenario(nodes, edges, vars, {});
    expect(sc.activeNodes.has('a1')).toBe(true);
    expect(sc.activeNodes.has('a2')).toBe(true);
    expect(sc.pendingVars.has('d2')).toBe(true);
    // d3 在 d2 下游，因 d2 停驻而不可达 → 判 N/A（只剩 d3 一个变量可达性未知之外）
    expect(sc.naVars.map((v) => v.nodeId)).toEqual(['d3']);
  });
});

describe('computeScenario：全赋值深路径（有报价→同意→不会操作）', () => {
  const vars = deriveVariables(nodes, edges);
  const sc = computeScenario(nodes, edges, vars, {
    d1: edgeIdOf('d1', 'a1'),
    d2: edgeIdOf('d2', 'y2'),
    d3: edgeIdOf('d3', 'no1'),
  });

  it('active 节点 = 8：s d1 a1 d2 y2 d3 no1 e', () => {
    sameSet(sc.activeNodes, ['s', 'd1', 'a1', 'd2', 'y2', 'd3', 'no1', 'e']);
  });

  it('active 边：深路径 7 条连线', () => {
    sameSet(sc.activeEdges, [
      's->d1',
      'd1->a1',
      'a1->d2',
      'd2->y2',
      'y2->d3',
      'd3->no1',
      'no1->e',
    ]);
    expect(sc.activeEdges.size).toBe(7);
  });

  it('dim 节点 = 4：a2 n2 ok1 nt1；naVars 为空', () => {
    const dim = nodes.filter((n) => !sc.activeNodes.has(n.id)).map((n) => n.id);
    sameSet(new Set(dim), ['a2', 'n2', 'ok1', 'nt1']);
    expect(sc.naVars).toHaveLength(0);
    expect(sc.pendingVars.size).toBe(0);
  });
});

describe('computeScenario：d1=无报价 时 d2/d3 走不到 → N/A', () => {
  const vars = deriveVariables(nodes, edges);
  const sc = computeScenario(nodes, edges, vars, { d1: edgeIdOf('d1', 'a2') });

  it('active 节点 = 4：s d1 a2 e', () => {
    sameSet(sc.activeNodes, ['s', 'd1', 'a2', 'e']);
  });

  it('d2/d3 进入 naVars（N/A）', () => {
    expect(sc.naVars.map((v) => v.nodeId).sort()).toEqual(['d2', 'd3']);
  });

  it('无 pending', () => {
    expect(sc.pendingVars.size).toBe(0);
  });
});

describe('computeScenario：未赋值决策节点 → 停驻 pending，不再下钻', () => {
  const vars = deriveVariables(nodes, edges);

  it('完全不赋值：s→d1 停住，d1 是 pending，其下所有分支都不 active', () => {
    const sc = computeScenario(nodes, edges, vars, {});
    sameSet(sc.activeNodes, ['s', 'd1']);
    expect(sc.pendingVars.has('d1')).toBe(true);
    // 从 d1 没有继续下钻 → a1/a2 等都不在 active，但也不算 N/A（同层兄弟判定与后续导航冲突时收敛）
    expect(sc.activeNodes.has('a1')).toBe(false);
    // d2/d3 不可达（因为 d1 已停驻），但本情景它们应算 N/A
    expect(sc.naVars.map((v) => v.nodeId).sort()).toEqual(['d2', 'd3']);
  });

  it('d1=有报价 → 走到 d2 停驻（d2 pending），d3 未到达为 N/A', () => {
    const sc = computeScenario(nodes, edges, vars, { d1: edgeIdOf('d1', 'a1') });
    sameSet(sc.activeNodes, ['s', 'd1', 'a1', 'd2']);
    expect(sc.pendingVars.has('d2')).toBe(true);
    expect(sc.naVars.map((v) => v.nodeId)).toEqual(['d3']);
  });
});

describe('computeScenario：环保护（seen 去重，不无限循环）', () => {
  it('沿回环走一圈即停，不无限循环', () => {
    const ring = buildGraph(
      [
        { id: 'r1', label: '重试？', kind: 'decision' },
        { id: 'r2', label: '做一步', kind: 'step' },
        { id: 'r3', label: '结束', kind: 'io-end' },
      ],
      [
        { s: 'r1', t: 'r2', label: '重试' },
        { s: 'r2', t: 'r1', label: '' }, // 回环：r2 走回 r1
        { s: 'r1', t: 'r3', label: '成功' },
      ]
    );
    const vars = deriveVariables(ring.nodes, ring.edges);
    // 环上所有节点都有入边 → SCC 源分量兜底，r1 作为入口
    // 赋值 r1 -> r2（走回环分支）：r1→r2→回到 r1（第二次经过）
    const sc = computeScenario(ring.nodes, ring.edges, vars, {
      r1: edgeIdOf('r1', 'r2'),
    });
    sameSet(sc.activeNodes, ['r1', 'r2']);
    // M3 visit 语义：第二次经过 r1 时没有第二条决策 → pending 停下等用户再选
    //（旧实现 seen 去重无声绕圈；现在必须显式决策，杜绝无限打转）
    expect(sc.pendingVars.has('r1')).toBe(true);
    expect(sc.pendingVisits['r1']).toBe(1);
    // r1 是决策节点且在 active → 不算 N/A
    expect(sc.naVars).toHaveLength(0);
  });

  it('回路上第二次决策：两跳各选不同分支可走通（M3 visit 语义）', () => {
    const ring = buildGraph(
      [
        { id: 'r1', label: '重试？', kind: 'decision' },
        { id: 'r2', label: '做一步', kind: 'step' },
        { id: 'r3', label: '结束', kind: 'io-end' },
      ],
      [
        { s: 'r1', t: 'r2', label: '重试' },
        { s: 'r2', t: 'r1', label: '' },
        { s: 'r1', t: 'r3', label: '成功' },
      ]
    );
    const vars = deriveVariables(ring.nodes, ring.edges);
    // 第 1 次经过 r1 选「重试」，第 2 次选「成功」→ 应走到 r3
    const sc = computeScenario(ring.nodes, ring.edges, vars, [
      { nodeId: 'r1', edgeId: edgeIdOf('r1', 'r2') },
      { nodeId: 'r1', edgeId: edgeIdOf('r1', 'r3') },
    ]);
    sameSet(sc.activeNodes, ['r1', 'r2', 'r3']);
    expect(sc.pendingVars.size).toBe(0);
    expect(sc.activeEdges.has(edgeIdOf('r1', 'r3'))).toBe(true);
  });
});

describe('layoutGraph：无重叠 + 拓扑自上而下', () => {
  const laid = layoutGraph(nodes, edges, 'flow');

  it('节点数不变，全部有非 NaN 坐标', () => {
    expect(laid).toHaveLength(nodes.length);
    laid.forEach((n) => {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    });
  });

  it('两两 bbox 不相交', () => {
    const boxes = laid.map((n) => {
      const w = Math.max(140, Math.min(300, n.data.label.length * 15 + 56));
      return { x: n.position.x, y: n.position.y, w, h: 46 };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${laid[i].id} 与 ${laid[j].id} 重叠`).toBe(false);
      }
    }
  });

  it('边源节点在目标节点上方（TB 拓扑）', () => {
    const pos = new Map(laid.map((n) => [n.id, n.position]));
    edges.forEach((e) => {
      const s = pos.get(e.source);
      const t = pos.get(e.target);
      if (s && t) expect(s.y, `${e.source}->${e.target}`).toBeLessThan(t.y);
    });
  });
});

describe('循环可视化：回边识别与经过次数', () => {
  /** 提交? →(是) 填写 → 审核? →(通过) 归档 / (打回) 回到填写 */
  const cyc = buildGraph(
    [
      { id: 'S', label: '提交?', kind: 'decision' },
      { id: 'B', label: '填写', kind: 'step' },
      { id: 'C', label: '审核?', kind: 'decision' },
      { id: 'D', label: '归档', kind: 'step' },
    ],
    [
      { s: 'S', t: 'B', label: '是' },
      { s: 'S', t: 'D', label: '否' },
      { s: 'B', t: 'C', label: '' },
      { s: 'C', t: 'D', label: '通过' },
      { s: 'C', t: 'B', label: '打回' },
    ]
  );
  const vars = deriveVariables(cyc.nodes, cyc.edges);
  const steps = [
    { nodeId: 'S', edgeId: edgeIdOf('S', 'B') },
    { nodeId: 'C', edgeId: edgeIdOf('C', 'B') }, // 第一次：打回
    { nodeId: 'C', edgeId: edgeIdOf('C', 'D') }, // 第二次：通过
  ];
  const sc = computeScenario(cyc.nodes, cyc.edges, vars, steps);

  it('回边（打回）进入 loopEdges，正向边不算', () => {
    expect(sc.loopEdges.has(edgeIdOf('C', 'B'))).toBe(true);
    expect(sc.loopEdges.has(edgeIdOf('B', 'C'))).toBe(false);
  });

  it('被重复经过的节点 visitCounts >= 2（驱动「第N轮」角标）', () => {
    expect(sc.visitCounts['B']).toBe(2);
    expect(sc.visitCounts['C']).toBe(2);
    expect(sc.visitCounts['D']).toBe(1);
  });

  it('打回后再通过，最终到达归档且无待定', () => {
    expect(sc.activeNodes.has('D')).toBe(true);
    expect(sc.pendingVars.size).toBe(0);
  });
});
