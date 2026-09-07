import { describe, expect, it } from 'vitest';
import { layeredLayout, type ReflowNode } from './reflow';

const N = (id: string, x = 0, y = 0, label?: string): ReflowNode => ({
  id,
  label: label ?? id,
  x,
  y,
});
const E = (source: string, target: string) => ({ source, target });

/** 任意两节点不重叠（按流程卡片估算尺寸 148~300 × 46） */
function expectNoOverlap(nodes: ReflowNode[], pos: Record<string, { x: number; y: number }>) {
  const box = nodes.map((n) => {
    const w = Math.max(148, Math.min(300, n.label.length * 15 + 56));
    const p = pos[n.id];
    return { id: n.id, x1: p.x, y1: p.y, x2: p.x + w, y2: p.y + 46 };
  });
  for (let i = 0; i < box.length; i += 1) {
    for (let j = i + 1; j < box.length; j += 1) {
      const a = box[i];
      const b = box[j];
      const hit = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
      expect(hit, `${a.id} 与 ${b.id} 重叠`).toBe(false);
    }
  }
}

describe('layeredLayout', () => {
  it('链式图逐层下排，互不重叠', () => {
    const nodes = [N('A', 0, 0), N('B', 0, 100), N('C', 0, 200)];
    const pos = layeredLayout(nodes, [E('A', 'B'), E('B', 'C')]);
    expect(pos.A.y).toBeLessThan(pos.B.y);
    expect(pos.B.y).toBeLessThan(pos.C.y);
    expectNoOverlap(nodes, pos);
  });

  it('回边不拉长布局（环 A→B→C→A 只占 3 层）', () => {
    const nodes = [N('A'), N('B'), N('C')];
    const pos = layeredLayout(nodes, [E('A', 'B'), E('B', 'C'), E('C', 'A')]);
    const ys = new Set(Object.values(pos).map((p) => p.y));
    expect(ys.size).toBe(3); // 不是被回边拉成无限深
    expectNoOverlap(nodes, pos);
  });

  it('分支的左右关系被保留（父在左则子靠左）', () => {
    const nodes = [
      N('root', 0, 0),
      N('left', -300, 200),
      N('right', 300, 200),
      N('l2', -300, 400),
      N('r2', 300, 400),
    ];
    const pos = layeredLayout(nodes, [
      E('root', 'left'),
      E('root', 'right'),
      E('left', 'l2'),
      E('right', 'r2'),
    ]);
    expect(pos.left.x).toBeLessThan(pos.right.x);
    expect(pos.l2.x).toBeLessThan(pos.r2.x);
    expectNoOverlap(nodes, pos);
  });

  it('同一层多个分支横向排开，不叠在一起', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => N(`n${i}`, i * 20, 300, `节点${i}`));
    const pos = layeredLayout(nodes, []);
    expectNoOverlap(nodes, pos);
  });

  it('孤立节点也拿到坐标，不丢', () => {
    const nodes = [N('solo', 5, 9)];
    const pos = layeredLayout(nodes, []);
    expect(pos.solo).toBeTruthy();
  });
});
