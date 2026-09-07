/** 智能重排：把「外部来源（飞书画板等）的流程图」重新排成不重叠、层次清晰的布局
 *
 * ## 为什么需要
 * 飞书画板的图元宽 92~190、高 52~130，而我们的流程卡片最小 148 宽、随文字还能撑到 300。
 * 直接照搬原坐标，卡片会互相压在一起、连线糊成一团。dagre 又会被回边（返工回路）
 * 拉出极长的纵向链。所以这里做一套「回路安全的分层布局」：
 *
 *  1. 先剥掉回边（DFS 中指向栈内节点的边），剩下的 DAG 上做最长路径分层 —— 回路不会拉长图；
 *  2. 层内顺序按**父节点位置重心（barycenter）**排，没有父的按原图 x —— 左右分支关系得以保留；
 *  3. 按估算的卡片真实尺寸排布，层内留 hGap、层间留 vGap —— 保证不重叠。
 */
import { findEntryNodes } from './engine';
import type { FlowEdge, FlowNode } from './types';

export interface ReflowNode {
  id: string;
  label: string;
  /** 原始坐标（左上角），用于保持左右分支关系 */
  x: number;
  y: number;
}

export interface ReflowEdge {
  source: string;
  target: string;
}

export interface ReflowOptions {
  /** 层内水平间距 */
  hGap?: number;
  /** 层间垂直间距 */
  vGap?: number;
  /** 整体留白 */
  pad?: number;
}

/** 流程视图卡片尺寸估算（与 style.css / estimateNodeSize 的 flow 分支保持一致） */
function sizeOf(label: string): { w: number; h: number } {
  return { w: Math.max(148, Math.min(300, label.length * 15 + 56)), h: 46 };
}

/**
 * 智能重排。返回 节点 id → 新坐标（左上角）。
 * 入参节点即使顺序混乱也不影响结果（分层只依赖边）。
 */
export function layeredLayout(
  nodes: ReflowNode[],
  edges: ReflowEdge[],
  opts: ReflowOptions = {}
): Record<string, { x: number; y: number }> {
  const hGap = opts.hGap ?? 40;
  const vGap = opts.vGap ?? 90;
  const pad = opts.pad ?? 60;
  if (!nodes.length) return {};

  const size: Record<string, { w: number; h: number }> = {};
  nodes.forEach((n) => (size[n.id] = sizeOf(n.label || '')));

  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const valid = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));

  /* ---------- 1) 剥回边：DFS 中指向栈内节点的边 ---------- */
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  ids.forEach((id) => {
    out.set(id, []);
    inn.set(id, []);
  });
  valid.forEach((e) => {
    out.get(e.source)!.push(e.target);
    inn.get(e.target)!.push(e.source);
  });

  const back = new Set<string>();
  const key = (a: string, b: string) => `${a}->${b}`;
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 / 1 在栈 / 2 完成
  const stack: string[] = [];

  const entries = findEntryNodes(
    nodes.map((n) => ({ id: n.id, position: { x: n.x, y: n.y }, data: { label: n.label } }) as FlowNode),
    valid as FlowEdge[]
  );
  const roots = entries.length ? entries : [ids[0]];

  const visit = (start: string) => {
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
      if (st === 1) {
        back.add(key(top.id, next)); // 回边：指向仍在 DFS 栈里的节点
      } else if (st === 0) {
        state.set(next, 1);
        stack.push(next);
        work.push({ id: next, i: 0 });
      }
    }
  };
  roots.forEach(visit);
  ids.forEach(visit); // 兜底：孤立 / 不可达子图也走一遍

  const dagEdges = valid.filter((e) => !back.has(key(e.source, e.target)));

  /* ---------- 2) 最长路径分层（Kahn） ---------- */
  const dagOut = new Map<string, string[]>();
  const dagIn = new Map<string, string[]>();
  const deg = new Map<string, number>();
  ids.forEach((id) => {
    dagOut.set(id, []);
    dagIn.set(id, []);
    deg.set(id, 0);
  });
  dagEdges.forEach((e) => {
    dagOut.get(e.source)!.push(e.target);
    dagIn.get(e.target)!.push(e.source);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  });

  const layer = new Map<string, number>();
  const queue = ids.filter((id) => (deg.get(id) ?? 0) === 0);
  queue.forEach((id) => layer.set(id, 0));
  let head = 0;
  while (head < queue.length) {
    const id = queue[head];
    head += 1;
    (dagOut.get(id) ?? []).forEach((to) => {
      layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(id) ?? 0) + 1));
      const d = (deg.get(to) ?? 0) - 1;
      deg.set(to, d);
      if (d === 0) queue.push(to);
    });
  }

  /* 有环残留（理论上不会，回边已剥）：按剩余节点的原 y 就近分配 */
  let maxLayer = 0;
  layer.forEach((v) => (maxLayer = Math.max(maxLayer, v)));
  const leftovers = ids.filter((id) => !layer.has(id));
  if (leftovers.length) {
    const ys = nodes.map((n) => n.y);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const span = maxY - minY || 1;
    leftovers.forEach((id) => {
      const n = nodes.find((x) => x.id === id)!;
      layer.set(id, Math.round(((n.y - minY) / span) * maxLayer));
    });
  }

  /* ---------- 3) 分组 + 层内排序（barycenter，保留左右分支关系） ---------- */
  const byLayer = new Map<number, string[]>();
  ids.forEach((id) => {
    const L = layer.get(id) ?? 0;
    const arr = byLayer.get(L) ?? [];
    arr.push(id);
    byLayer.set(L, arr);
  });

  const posX = new Map<string, number>();
  nodes.forEach((n) => posX.set(n.id, n.x));
  const order = new Map<string, number>();
  const sortedLayers = [...byLayer.keys()].sort((a, b) => a - b);

  /* 初始：按原图 x */
  sortedLayers.forEach((L) => {
    const arr = [...(byLayer.get(L) ?? [])].sort((a, b) => (posX.get(a) ?? 0) - (posX.get(b) ?? 0));
    arr.forEach((id, i) => order.set(id, i));
  });

  /* 两轮重心排序：先自上而下（看父），再自下而上（看子） */
  const bary = (id: string, from: 'in' | 'out') => {
    const rel = (from === 'in' ? dagIn.get(id) : dagOut.get(id)) ?? [];
    if (!rel.length) return order.get(id) ?? 0;
    const vals = rel.map((r) => order.get(r)).filter((v): v is number => v !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : (order.get(id) ?? 0);
  };
  (['in', 'out'] as const).forEach((dir) => {
    const seq = dir === 'in' ? sortedLayers : [...sortedLayers].reverse();
    seq.forEach((L) => {
      const arr = [...(byLayer.get(L) ?? [])].sort((a, b) => {
        const d = bary(a, dir) - bary(b, dir);
        return Math.abs(d) < 1e-6 ? (posX.get(a) ?? 0) - (posX.get(b) ?? 0) : d;
      });
      arr.forEach((id, i) => order.set(id, i));
    });
  });

  /* ---------- 4) 排布：层内依次排开，层整体水平居中 ---------- */
  const rowWidth: number[] = [];
  sortedLayers.forEach((L) => {
    const arr = [...(byLayer.get(L) ?? [])].sort(
      (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)
    );
    byLayer.set(L, arr);
    const w = arr.reduce((s, id) => s + size[id].w, 0) + hGap * Math.max(0, arr.length - 1);
    rowWidth.push(w);
  });
  const maxW = Math.max(...rowWidth, 0);

  const result: Record<string, { x: number; y: number }> = {};
  let y = pad;
  sortedLayers.forEach((L, li) => {
    const arr = byLayer.get(L) ?? [];
    const rowH = Math.max(...arr.map((id) => size[id].h), 0);
    let x = pad + (maxW - rowWidth[li]) / 2;
    arr.forEach((id) => {
      result[id] = { x: Math.round(x), y: Math.round(y + (rowH - size[id].h) / 2) };
      x += size[id].w + hGap;
    });
    y += rowH + vGap;
  });

  return result;
}
