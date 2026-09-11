/** 变量与情景核心算法 —— 语义移植自 rf-poc/src/engine.js（源自 interactive-flow-builder.html） */
import dagre from 'dagre';
import type {
  Assignments,
  FlowEdge,
  FlowNode,
  FlowVariable,
  FlowView,
  ScenarioResult,
  ScenarioStep,
} from './types';
import { TALK_W_MAX, TALK_W_MIN, TALK_W_DEFAULT } from './types';
import { flowCardSize } from './nodeSize';

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
 * Tarjan 强连通分量（迭代版，避免深图递归爆栈）。
 * 返回分量数组，每个分量是节点 id 数组。
 */
export function stronglyConnectedComponents(ids: string[], adj: Record<string, string[]>): string[][] {
  const index: Record<string, number> = {};
  const low: Record<string, number> = {};
  const onStack: Record<string, boolean> = {};
  const stack: string[] = [];
  const comps: string[][] = [];
  let counter = 0;

  for (const root of ids) {
    if (index[root] !== undefined) continue;
    /* 显式栈模拟递归：frame = [节点, 邻接游标] */
    const frames: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;

    while (frames.length) {
      const f = frames[frames.length - 1];
      const neighbours = adj[f.v] ?? [];
      if (f.i < neighbours.length) {
        const w = neighbours[f.i++];
        if (index[w] === undefined) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          frames.push({ v: w, i: 0 });
        } else if (onStack[w]) {
          low[f.v] = Math.min(low[f.v], index[w]);
        }
      } else {
        frames.pop();
        if (frames.length) {
          const p = frames[frames.length - 1].v;
          low[p] = Math.min(low[p], low[f.v]);
        }
        if (low[f.v] === index[f.v]) {
          const comp: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack[w] = false;
            comp.push(w);
            if (w === f.v) break;
          }
          comps.push(comp);
        }
      }
    }
  }
  return comps;
}

/**
 * 图的入口（起点）节点集合。优先级：
 *  1. 显式开始节点（kind = io-start）
 *  2. SCC 缩点后「入度为 0 的源分量」中，来自分量外的入边数也是 0 的那些节点
 *
 * 为什么不能直接取「无入边节点」：只要图里存在孤立的旁支节点（没有入边也不在主流程上），
 * 它就会独占入口资格，主流程（尤其带返工回路的那部分）被整体判为不可达 → 变量全变 N/A
 * → 侧栏按钮禁用 → 用户彻底无法赋值（真实死锁，飞书导入的图节点顺序随机时必现）。
 * SCC 缩点把整个环视为一个节点，环上任一入口都能走通全环，因此不会漏。
 */
export function findEntryNodes(nodes: FlowNode[], edges: FlowEdge[]): string[] {
  if (!nodes.length) return [];
  const starts = nodes.filter((n) => n.data?.kind === 'io-start').map((n) => n.id);
  if (starts.length) return starts;

  const ids = nodes.map((n) => n.id);
  const adj: Record<string, string[]> = {};
  ids.forEach((id) => {
    adj[id] = [];
  });
  edges.forEach((e) => {
    if (adj[e.source] && adj[e.target] !== undefined) adj[e.source].push(e.target);
  });
  const comps = stronglyConnectedComponents(ids, adj);
  const compOf: Record<string, number> = {};
  comps.forEach((c, i) => c.forEach((id) => (compOf[id] = i)));

  /* 分量入度（跨分量的边）与节点外部入度（起点不在本分量的边） */
  const compInDeg = comps.map(() => 0);
  const nodeExternalInDeg: Record<string, number> = {};
  ids.forEach((id) => (nodeExternalInDeg[id] = 0));
  edges.forEach((e) => {
    const a = compOf[e.source];
    const b = compOf[e.target];
    if (a === undefined || b === undefined) return;
    if (a !== b) compInDeg[b] += 1;
    nodeExternalInDeg[e.target] = (nodeExternalInDeg[e.target] ?? 0) + (a === b ? 0 : 1);
  });

  const entries = ids.filter(
    (id) => compInDeg[compOf[id]] === 0 && (nodeExternalInDeg[id] ?? 0) === 0
  );
  if (!entries.length) return [ids[0]];
  /* 每个源分量只取一个代表（数组序第一个）：环是强连通的，任一入口都能走遍全环；
     若把环内所有节点都当起点，同一变量会被多路重复到达，决策序列被误耗尽 → 误报 pending */
  const seenComp = new Set<number>();
  return entries.filter((id) => {
    const c = compOf[id];
    if (seenComp.has(c)) return false;
    seenComp.add(c);
    return true;
  });
}

/**
 * 情景演算：给定决策序列，从入口节点深度遍历出情景子图。
 * - 非决策节点：所有出口都走（同一节点重复经过时不再重复展开）
 * - 决策节点：第 k 次经过时取决策序列里该节点的第 k 条出口（支持回路上
 *   「第一次打回、第二次通过」这种同一判断点多次不同选择）；无对应决策 →
 *   停在该节点（pending，不继续下钻）
 * - 走不到的决策变量 → naVars（未经过）
 * 终止性：每次经过变量节点消耗一条决策，决策序列有限 → 必然停机。
 * 第 4 参兼容旧的 Assignments（每节点一条，顺序即变量声明序）。
 */
export function computeScenario(
  nodes: FlowNode[],
  edges: FlowEdge[],
  variables: FlowVariable[],
  picks: ScenarioStep[] | Assignments
): ScenarioResult {
  const out = outgoingByNode(edges);
  const varByNode: Record<string, FlowVariable> = {};
  variables.forEach((v) => {
    varByNode[v.nodeId] = v;
  });

  /* 决策序列 → 每节点按经过次序排列的出口选择表 */
  const picksByNode: Record<string, string[]> = {};
  if (Array.isArray(picks)) {
    picks.forEach((s) => (picksByNode[s.nodeId] = [...(picksByNode[s.nodeId] ?? []), s.edgeId]));
  } else {
    Object.entries(picks).forEach(([n, e]) => (picksByNode[n] = [e]));
  }

  const starters = findEntryNodes(nodes, edges);

  const activeNodes = new Set<string>();
  const activeEdges = new Set<string>();
  const pendingVars = new Set<string>();
  const visitCounts: Record<string, number> = {};
  const pendingVisits: Record<string, number> = {};
  const seenVisits = new Set<string>();
  const stack = [...starters];
  /* 遍历终止性（两处独立保证，缺一不可）：
   * ① 变量节点：每次经过消耗决策序列里的一条决策，序列有限 → 用完即 pending 停住。
   * ② 非决策节点：**只有「落在含决策点的回路上的节点」才允许重复展开**（`reExpandable`），
   *    其余节点每节点至多展开一次。
   *
   *    ——历史 bug（Bug2 · 链路高亮不全）：这里曾经按「图里有没有变量」分流，有变量时
   *    保留**所有**非决策节点的重复展开，理由是「打回后重走必须重新经过非决策节点」。
   *    但那个理由只对**回路上的节点**成立：控制流要第二次抵达回路上的决策点，必须重新
   *    经过回边起点的前驱链。环外节点（尤其多条分支的公共后继，如「订单完结」有 4 条
   *    入边）重复展开不会带来任何新信息，却让 visitCounts 指数级膨胀 —— 实测 51 节点图
   *    上「订单完结」被展开 43474 次、「退款处理/资金原路返回」各 17389 次；步数预算
   *    budget = 51*4 + 2*4 + 128 = 340 在第 340 步就被烧光 → 遍历硬截断，只覆盖
   *    42/51 节点、45/62 边，用户观感即「选了这条链路，但链路中后段一批节点没亮」。
   *
   *    判定方式（纯拓扑，与取值无关）：非决策节点 n 会被重复展开 ⇔ n 能到达某个
   *    **决策节点**，且该决策节点能回到 n（即二者同属一个「含决策点的回路」）。
   *    用可到达性（`canReach`）表达，天然含跨分量的情形。
   *    本例：B 能到达决策点 C，且 C 能回到 B → B 可重复展开（保住 M3 两次决策语义）；
   *    而「订单完结」不落在任何含决策点的回路上 → 只展开一次（截断消失）。 */
  const decisionIds = new Set(Object.keys(varByNode));
  const canReach = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const q = [from];
    while (q.length) {
      const cur = q.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      (out[cur] ?? []).forEach((e) => {
        if (!seen.has(e.target)) q.push(e.target);
      });
    }
    return false;
  };
  /** 非决策节点 n 是否允许重复展开：n 能到达某决策点 d，且 d 能回到 n */
  const reExpandable = new Set<string>();
  nodes.forEach((nd) => {
    if (varByNode[nd.id]) return;
    for (const d of decisionIds) {
      if (canReach(nd.id, d) && canReach(d, nd.id)) {
        reExpandable.add(nd.id);
        return;
      }
    }
  });
  /* 步数预算：纯兜底防御。终止主要靠 ① + ②（决策序列有限 + 环外节点不重复展开）。 */
  const budget = nodes.length * 4 + stack.length * 4 + 128;
  let walked = 0;
  while (stack.length && walked < budget) {
    walked += 1;
    const id = stack.pop()!;
    const k = visitCounts[id] ?? 0;
    visitCounts[id] = k + 1;
    const key = `${id}#${k}`;
    if (seenVisits.has(key)) continue;
    seenVisits.add(key);
    activeNodes.add(id);
    const outs = out[id] || [];
    const v = varByNode[id];
    if (v) {
      const pick = (picksByNode[id] ?? [])[k];
      if (!pick) {
        pendingVars.add(id);
        pendingVisits[id] = k;
        continue; // 第 k 次走到该判断点但还没做第 k 次决策 → 停住，等用户导航
      }
      outs.forEach((e) => {
        if (e.id === pick) {
          activeEdges.add(e.id);
          stack.push(e.target);
        }
      });
    } else {
      /* 环外节点：重复展开无新信息，只会烧预算 → 至多展开一次。
         含决策点的回路上的节点：允许重复展开，把控制流送回决策点取新决策。 */
      if (k > 0 && !reExpandable.has(id)) continue;
      outs.forEach((e) => {
        activeEdges.add(e.id);
        stack.push(e.target);
      });
    }
  }
  /* 预算兜底退出时，栈里还压着「活跃边指向、但没走到」的节点 —— 补亮它们，
     维持不变量「活跃边的 target 必活跃」，杜绝边亮节点不亮的观感断裂（Bug1）。 */
  while (stack.length) activeNodes.add(stack.pop()!);
  const naVars = variables.filter((v) => !activeNodes.has(v.nodeId));
  /* 回边（拓扑性质，与取值无关）：路径上被走到的回边就是「转了一圈」的那一段 */
  const backIds = findBackEdges(nodes, edges);
  const loopEdges = new Set<string>();
  edges.forEach((e) => {
    if (backIds.has(e.id) && activeEdges.has(e.id)) loopEdges.add(e.id);
  });
  return {
    activeNodes,
    activeEdges,
    pendingVars,
    naVars,
    visitCounts,
    pendingVisits,
    loopEdges,
  };
}

/**
 * 通用「一键示例路线」推演：不依赖任何硬编码 id，任意图（含从飞书粘贴进来的图）都能用。
 *
 * 规则：从入口节点出发 DFS；遇到**启用中的变量**节点时，取「下游最深」的那条出口
 *       （能往后带出最多节点，演示价值最大，等价于示例模板里那条深路径）；
 *       非变量节点照常全展开。遇到终点或步数预算即停。
 * 回路：**每条回路最多只走一圈**，绝不会绕成无限循环（见下）。
 *
 * 「只循环一次」的实现：
 *  ① 每个决策节点最多代选 1 轮 —— 决策序列里同一 nodeId 只出现一次。运行时该判断点
 *     第二次被经过时没有第 2 条决策 → 自然停住交给用户手选。旧实现是 MAX_ROUNDS=2
 *     （同一判断点连代选两轮「打回」），结果路线绕两圈还到不了终点 —— 就是用户看到
 *     「示例路线在无限循环」的表现。
 *  ② 选路优先级用「离终点的距离」，而不是「下游深度」。「下游深度」在含环的图上会被
 *     环撑大（打回分支因为能绕回来，depth 反而比直达分支大），导致示例路线总是倾向
 *     选回退边。改用 `distToEnd`（到最近终点的最短步数，环内记 ∞）后，**推进型出口
 *     天然排在前**：如「检查通过？→打回/通过」，示例选「通过」直达终点；「打回」这条
 *     回退路留给用户手点。等价于「示例路线绕开回路、一圈即止」。
 *     若某判断点所有出口都在环里（纯死循环、无推进出路），则退回原「下游最深」策略，
 *     由保证 ① 负责终止。
 *
 * 与 computeScenario 的契约：本函数完全复刻 computeScenario 的遍历顺序
 * （同起点、同 DFS 出栈序），产出的 steps 顺序 == 运行时消费顺序。
 */
export function suggestScenarioSteps(
  nodes: FlowNode[],
  edges: FlowEdge[],
  variables: FlowVariable[]
): ScenarioStep[] {
  if (!nodes.length || !variables.length) return [];
  const out = outgoingByNode(edges);
  const varByNode: Record<string, FlowVariable> = {};
  variables.forEach((v) => {
    varByNode[v.nodeId] = v;
  });
  const targetOf = new Map<string, string>();
  edges.forEach((e) => targetOf.set(e.id, e.target));

  /** 下游深度（到最远出口的层数；回到 visiting 中的节点记 0，避免环上自加无限递归） */
  const depth: Record<string, number> = {};
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (depth[id] !== undefined) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    (out[id] ?? []).forEach((e) => {
      best = Math.max(best, 1 + depthOf(e.target));
    });
    visiting.delete(id);
    depth[id] = best;
    return best;
  };
  nodes.forEach((n) => depthOf(n.id));

  /** 回退型出口的判定：目标节点落在**真回路（非平凡强连通分量）**上 ⇒ 选它就会绕圈。
   *  用 Tarjan 缩点：目标节点所在分量大小 > 1，或存在自环 → 是回退型。
   *  「先能走到终点」不够用 —— 环内节点同样能走出去（fix→d1→e），必须用 SCC 才认得出环。
   *  含自环的节点（a→a）也算，由 compOf 大小 1 + 自环检测覆盖。 */
  const adjList: Record<string, string[]> = {};
  nodes.forEach((n) => (adjList[n.id] = []));
  edges.forEach((e) => {
    if (adjList[e.source] && adjList[e.target] !== undefined) adjList[e.source].push(e.target);
  });
  const comps = stronglyConnectedComponents(
    nodes.map((n) => n.id),
    adjList
  );
  const compSize: Record<string, number> = {};
  comps.forEach((c) => c.forEach((id) => (compSize[id] = c.length)));
  const hasSelfLoop = new Set<string>();
  edges.forEach((e) => {
    if (e.source === e.target) hasSelfLoop.add(e.source);
  });
  const inCycle = (id: string): boolean => compSize[id] > 1 || hasSelfLoop.has(id);

  const steps: ScenarioStep[] = [];
  const visits: Record<string, number> = {};
  const stack: string[] = [...findEntryNodes(nodes, edges)];
  const budget = nodes.length * 4 + variables.length * 4 + 128;
  let walked = 0;

  while (stack.length && walked < budget) {
    walked += 1;
    const id = stack.pop()!;
    const k = visits[id] ?? 0;
    visits[id] = k + 1;
    const outs = out[id] ?? [];
    if (!outs.length) continue;
    const v = varByNode[id];
    if (!v) {
      outs.forEach((e) => stack.push(e.target));
      continue;
    }
    /* 保证 ①：每个决策节点最多代选 1 轮，示范「路过一次」即可 */
    if (k >= 1) continue;
    const opts = v.options.filter((o) => targetOf.has(o.edgeId));
    if (!opts.length) continue;
    /* 保证 ②：**排除回退型出口**（目标在回路上 ⇒ 走它就要绕圈），只在「往前走」的
       出口里选。这样示例路线天然绕开回路、一圈即止：
       「检查通过？→打回(fix 在环上，跳过) / 通过(→e，选它)」→ 直达终点；
       「打回」这条回退路留给用户在导航里自己点。
       选路仍用「下游更深者优先」，保留原有「演示价值最大」的取舍（如 d1 有报价
       =3 层 vs 无报价=1 层 → 选有报价，才能串起 d2/d3 两个后续判断点）。
       若某判断点**所有**出口都是回退型（纯死循环、无推进出路），退回原策略，
       由保证 ① 负责终止。 */
    const advancing = opts.filter((o) => !inCycle(targetOf.get(o.edgeId)!));
    const pool = advancing.length ? advancing : opts;
    /* 取下游最深的分支；同深度取声明序第一条（稳定可复现） */
    const best = pool.reduce((a, b) =>
      (depth[targetOf.get(b.edgeId)!] ?? 0) > (depth[targetOf.get(a.edgeId)!] ?? 0) ? b : a
    );
    steps.push({ nodeId: id, edgeId: best.edgeId });
    stack.push(targetOf.get(best.edgeId)!);
  }
  return steps;
}

/**
 * 找出图里的回边（指向 DFS 栈内节点的边）—— 即流程里的「返工/循环」连线。
 * 纯拓扑性质，与变量取值无关，回路安全（不会因环而递归爆栈）。
 * @returns 回边的 edge.id 集合
 */
export function findBackEdges(nodes: FlowNode[], edges: FlowEdge[]): Set<string> {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const out = new Map<string, string[]>();
  ids.forEach((id) => out.set(id, []));
  const valid = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
  valid.forEach((e) => out.get(e.source)!.push(e.target));

  const backPairs = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 / 1 在栈 / 2 完成
  const stack: string[] = [];
  const roots = findEntryNodes(nodes, edges);
  const starts = roots.length ? roots : ids.slice(0, 1);

  starts.concat(ids).forEach((start) => {
    if (state.get(start)) return;
    const work: { id: string; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    stack.push(start);
    while (work.length) {
      const top = work[work.length - 1];
      const list = out.get(top.id) ?? [];
      if (top.i >= list.length) {
        work.pop();
        stack.pop();
        state.set(top.id, 2);
        continue;
      }
      const next = list[top.i];
      top.i += 1;
      const st = state.get(next) ?? 0;
      if (st === 1) backPairs.add(`${top.id}->${next}`);
      else if (st === 0) {
        state.set(next, 1);
        stack.push(next);
        work.push({ id: next, i: 0 });
      }
    }
  });

  const back = new Set<string>();
  valid.forEach((e) => {
    if (backPairs.has(`${e.source}->${e.target}`)) back.add(e.id);
  });
  return back;
}

/** 决策序列 → 旧式取值表（每节点取最后一次决策）。供导出/兼容旧视图。 */
export function assignmentsOf(steps: ScenarioStep[]): Assignments {
  const a: Assignments = {};
  steps.forEach((s) => (a[s.nodeId] = s.edgeId));
  return a;
}

/** 旧式取值表 → 决策序列（读取旧持久化数据时一次性迁移）。 */
export function stepsOfAssignments(a: Assignments): ScenarioStep[] {
  return Object.entries(a).map(([nodeId, edgeId]) => ({ nodeId, edgeId }));
}

/**
 * 按图遍历序返回节点 id 序列（BFS 从入口节点出发）。
 * 用于变量按首次出现序排列（US-08 AC2）。
 */
export function traversalOrder(nodes: FlowNode[], edges: FlowEdge[]): string[] {
  const queue: string[] = findEntryNodes(nodes, edges);
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
  /* WP7-3d 锁尺寸：导入节点带 data.size（飞书原始卡宽高）→ 布局按真实形状拉开，
     不再按文本估算。手动卡/旧文档无 size → 走原估算。 */
  const locked =
    view === 'flow' && !!data?.size && data.size.w > 0 && data.size.h > 0
      ? data.size
      : null;
  /* 流程视图尺寸：宽度封顶 + 长文本换行增高（与 style.css、reflow 共用 nodeSize 规则）；
     点1 自定义换行：wrapCols（每行 N 字）影响行数 → 同步进估算 */
  const flow = locked ?? flowCardSize(label, data?.wrapCols);
  const w = flow.w;
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
  return flow;
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
