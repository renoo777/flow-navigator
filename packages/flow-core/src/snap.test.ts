import { describe, expect, it } from 'vitest';
import { computeSnap, type SnapBox } from './snap';

const B = (id: string, x: number, y: number, w = 148, h = 46): SnapBox => ({ id, x, y, w, h });

describe('computeSnap', () => {
  it('左缘对左缘：命中并给出吸附量', () => {
    const r = computeSnap([B('a', 102, 0)], [B('b', 100, 200)]);
    expect(r.dx).toBe(-2);
    expect(r.dy).toBe(0);
    expect(r.vLines).toEqual([100]);
  });

  it('中心对中心', () => {
    const r = computeSnap([B('a', 100, 0)], [B('b', 0, 200)]);
    // a 中心 174，b 中心 74 → dx = -100 超阈值；a 左 100 vs b 中 74 差 26 超阈值 → 无命中
    expect(r.dx).toBe(0);
    expect(r.vLines).toEqual([]);
    const r2 = computeSnap([B('a', 0, 0)], [B('b', 0, 0)]);
    expect(r2.dx).toBe(0);
    expect(r2.vLines.length).toBeGreaterThan(0);
  });

  it('水平与垂直可同时命中', () => {
    const r = computeSnap([B('a', 102, 203)], [B('b', 100, 200)]);
    expect(r.dx).toBe(-2);
    expect(r.dy).toBe(-3);
    expect(r.hLines).toEqual([200]);
  });

  it('超出阈值不吸附', () => {
    const r = computeSnap([B('a', 120, 0)], [B('b', 100, 200)]);
    expect(r.dx).toBe(0);
    expect(r.vLines).toEqual([]);
  });

  it('右缘对左缘也命中（边贴边）', () => {
    const r = computeSnap([B('a', 251, 0)], [B('b', 100, 200)]);
    // a 右 399？不对：251+148=399；b 左 100；a 左 251 vs b 右 248 差 3 → 命中 dx=-3
    expect(r.dx).toBe(-3);
  });

  it('空入参安全', () => {
    expect(computeSnap([], [B('b', 0, 0)])).toEqual({ dx: 0, dy: 0, vLines: [], hLines: [] });
    expect(computeSnap([B('a', 0, 0)], [])).toEqual({ dx: 0, dy: 0, vLines: [], hLines: [] });
  });
});
