/** resolveOverlaps 单测：继承坐标后的最小位移防重叠（Bug2 方案 A 配套） */
import { describe, expect, test } from 'vitest';
import { resolveOverlaps } from './overlap';

describe('resolveOverlaps', () => {
  test('无重叠时保持原坐标（一个都不动）', () => {
    const out = resolveOverlaps([
      { id: 'a', x: 0, y: 0, w: 100, h: 46 },
      { id: 'b', x: 0, y: 200, w: 100, h: 46 },
    ]);
    expect(out.get('a')).toEqual({ x: 0, y: 0 });
    expect(out.get('b')).toEqual({ x: 0, y: 200 });
  });

  test('纵向挤压时只把下方卡下推（最小位移），x 不变（话术层继承主场景）', () => {
    const out = resolveOverlaps([
      { id: 'a', x: 100, y: 0, w: 120, h: 160 },
      { id: 'b', x: 100, y: 80, w: 120, h: 160 },
    ]);
    const pa = out.get('a')!;
    const pb = out.get('b')!;
    expect(pa).toEqual({ x: 100, y: 0 }); /* 上方卡不动 */
    expect(pb.x).toBe(100);
    /* 顶点模型：下方卡顶边 ≥ 上方卡底边 + gap → y 差 ≥ h + 12 */
    expect(pb.y - pa.y).toBeGreaterThanOrEqual(172);
  });

  test('异高卡按顶点模型分离（RF position 是左上角，历史中心模型会少推 (h1-h2)/2）', () => {
    const out = resolveOverlaps([
      { id: 'a', x: 0, y: 0, w: 120, h: 247 },
      { id: 'b', x: 0, y: 120, w: 120, h: 176 },
    ]);
    const pa = out.get('a')!;
    const pb = out.get('b')!;
    expect(pb.y - pa.y).toBeGreaterThanOrEqual(247 + 12);
  });

  test('多卡链式挤压全部分离（模拟 51 节点板继承后）', () => {
    const boxes = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      x: 50,
      y: i * 60, /* 结构层间距 60 < 话术层卡高 140 → 全线重叠 */
      w: 120,
      h: 140,
    }));
    const out = resolveOverlaps(boxes);
    const sorted = [...out.entries()].sort((a, b) => a[1].y - b[1].y);
    for (let i = 1; i < sorted.length; i += 1) {
      /* 同高卡分离：中心距 ≥ h + gap = 152 */
      expect(sorted[i][1].y - sorted[i - 1][1].y).toBeGreaterThanOrEqual(152);
    }
  });

  test('x 不相交的卡互不影响（左右两列各排各的）', () => {
    const out = resolveOverlaps([
      { id: 'l1', x: 0, y: 0, w: 100, h: 300 },
      { id: 'r1', x: 500, y: 10, w: 100, h: 300 },
    ]);
    expect(out.get('l1')).toEqual({ x: 0, y: 0 });
    expect(out.get('r1')).toEqual({ x: 500, y: 10 });
  });

  test('空数组安全', () => {
    expect(resolveOverlaps([]).size).toBe(0);
  });
});
