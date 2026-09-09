import { describe, expect, it } from 'vitest';
import { inferLayoutDirection, layeredLayout, type ReflowNode } from './reflow';
import { flowCardSize } from './nodeSize';

const N = (id: string, x = 0, y = 0, label?: string): ReflowNode => ({
  id,
  label: label ?? id,
  x,
  y,
});
const E = (source: string, target: string) => ({ source, target });

/** 任意两节点不重叠（尺寸按 nodeSize 规则：宽度封顶 + 长文本换行增高） */
function expectNoOverlap(nodes: ReflowNode[], pos: Record<string, { x: number; y: number }>) {
  const box = nodes.map((n) => {
    const s = flowCardSize(n.label);
    const p = pos[n.id];
    return { id: n.id, x1: p.x, y1: p.y, x2: p.x + s.w, y2: p.y + s.h };
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

  it('LR：横向图按竖列排，整体保持横向（不再被竖成一根柱子）', () => {
    const nodes = [N('A', 0, 100), N('B', 260, 100), N('C', 520, 100), N('D', 780, 100)];
    const pos = layeredLayout(nodes, [E('A', 'B'), E('B', 'C'), E('C', 'D')], {
      direction: 'LR',
    });
    expect(pos.A.x).toBeLessThan(pos.B.x);
    expect(pos.B.x).toBeLessThan(pos.C.x);
    expect(pos.C.x).toBeLessThan(pos.D.x);
    const xs = Object.values(pos).map((p) => p.x);
    const ys = Object.values(pos).map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(
      Math.max(...ys) - Math.min(...ys)
    );
    expectNoOverlap(nodes, pos);
  });

  it('LR：分支的上下关系被保留（父在上则子靠上）', () => {
    const nodes = [
      N('root', 0, 0),
      N('up', 300, -200),
      N('down', 300, 200),
      N('u2', 600, -200),
      N('d2', 600, 200),
    ];
    const pos = layeredLayout(
      nodes,
      [E('root', 'up'), E('root', 'down'), E('up', 'u2'), E('down', 'd2')],
      { direction: 'LR' }
    );
    expect(pos.up.y).toBeLessThan(pos.down.y);
    expect(pos.u2.y).toBeLessThan(pos.d2.y);
    expectNoOverlap(nodes, pos);
  });

  it('LR：同一层多个分支纵向排开，不叠在一起', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => N(`n${i}`, 100, i * 20, `节点${i}`));
    const pos = layeredLayout(nodes, [], { direction: 'LR' });
    expectNoOverlap(nodes, pos);
  });

  it('LR：长标签节点换行增高后仍不重叠', () => {
    const nodes = [
      N('a', 0, 0, '这是一个非常长的节点标题用于验证换行增高'),
      N('b', 300, 0, '短'),
    ];
    const pos = layeredLayout(nodes, [E('a', 'b')], { direction: 'LR' });
    expect(flowCardSize(nodes[0].label).h).toBeGreaterThan(46);
    expectNoOverlap(nodes, pos);
  });
});

describe('inferLayoutDirection', () => {
  it('横向排布的图判为 LR', () => {
    const nodes = [N('A', 0, 100), N('B', 260, 100), N('C', 520, 100)];
    expect(inferLayoutDirection(nodes, [E('A', 'B'), E('B', 'C')])).toBe('LR');
  });

  it('纵向排布的图判为 TB', () => {
    const nodes = [N('A', 100, 0), N('B', 100, 120), N('C', 100, 240)];
    expect(inferLayoutDirection(nodes, [E('A', 'B'), E('B', 'C')])).toBe('TB');
  });

  it('没有边 / 两端不存在时退回 TB', () => {
    const nodes = [N('A', 0, 0), N('B', 300, 0)];
    expect(inferLayoutDirection(nodes, [])).toBe('TB');
    expect(inferLayoutDirection(nodes, [E('A', 'zzz')])).toBe('TB');
  });

  it('横向图走自动方向重排后仍是横向（端到端：飞书侧边连线不被改上下）', () => {
    const nodes = [N('A', 0, 100), N('B', 260, 100), N('C', 520, 100)];
    const edges = [E('A', 'B'), E('B', 'C')];
    const pos = layeredLayout(nodes, edges, { direction: inferLayoutDirection(nodes, edges) });
    const xs = Object.values(pos).map((p) => p.x);
    const ys = Object.values(pos).map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(
      Math.max(...ys) - Math.min(...ys)
    );
  });
});

describe('layeredLayout：WP7-3d 锁尺寸节点按真实尺寸排布', () => {
  const N2 = (id: string, size?: { w: number; h: number }): ReflowNode => ({
    id, label: id, x: 0, y: 0, ...(size ? { size } : {}),
  });

  it('锁尺寸 200×120 的大卡：纵向不重叠（间距按 size 而非文本估算）', () => {
    const pos = layeredLayout([N2('A', { w: 200, h: 120 }), N2('B', { w: 200, h: 120 })], [E('A', 'B')]);
    // A、B 上下相邻（TB），B 顶 ≥ A 顶 + 120 + vGap(90) - 容差
    expect(pos.B.y).toBeGreaterThanOrEqual(pos.A.y + 120 + 90 - 1);
    expect(pos.A.x).toBeCloseTo(pos.B.x, 6); // 单列居中同 x
  });

  it('锁尺寸 92×52 小卡（飞书窄卡）：宽度不再被 148 下限撑大 → 层内可更紧凑', () => {
    const pos = layeredLayout(
      [N2('A', { w: 92, h: 52 }), N2('B', { w: 92, h: 52 }), N2('C', { w: 92, h: 52 })],
      []
    );
    // 同层三卡横向排：C.x ≥ A.x + 92 + 2*hGap(40) - 容差（若按文本 148+ 会排不下/更宽）
    expect(pos.C.x).toBeGreaterThanOrEqual(pos.A.x + 92 + 2 * 40 - 1);
  });

  it('无 size → 布局仍按文本估算（向后兼容）', () => {
    const pos = layeredLayout([N2('A'), N2('B')], [E('A', 'B')]);
    const s = flowCardSize('A');
    expect(pos.B.y).toBeGreaterThanOrEqual(pos.A.y + s.h + 90 - 1);
  });
});
