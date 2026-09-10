import { describe, it, expect } from 'vitest';
import { planExportSize, PNG_PRESET, GIF_PRESET } from './exportScale';

describe('planExportSize — 导出分辨率规划', () => {
  it('小图：1:1 布局 + 2 倍超采样，字号翻倍', () => {
    const p = planExportSize({ boundsW: 800, boundsH: 600 });
    expect(p.zoom).toBeCloseTo(1, 3);
    expect(p.ratio).toBe(2);
    expect(p.outW).toBe(1792); // 800 * 1.12 * 2
    expect(p.outH).toBe(1344); // 600 * 1.12 * 2
    expect(p.fontPx).toBeCloseTo(26, 1);
  });

  it('70 节点大图：不再被压到 0.1 缩放（旧版长边 2400 会糊成一团）', () => {
    const p = planExportSize({ boundsW: 9000, boundsH: 3000 });
    /* 旧实现：2520×840 ≈ 2.1MP，fontPx≈3.6；新实现至少二十几倍像素 */
    expect(p.outW * p.outH).toBeGreaterThan(20_000_000);
    expect(p.fontPx).toBeGreaterThan(12);
    expect(p.zoom).toBeCloseTo(1, 2);
  });

  it('夹取：撞长边上限时长边正好等于 maxSide', () => {
    const p = planExportSize({ boundsW: 20000, boundsH: 10000, maxSide: 8000 });
    expect(Math.max(p.outW, p.outH)).toBe(8000);
  });

  it('夹取：撞总像素上限时不超过 maxPixels', () => {
    const p = planExportSize({ boundsW: 30000, boundsH: 30000, maxPixels: 10_000_000 });
    expect(p.outW * p.outH).toBeLessThanOrEqual(10_000_000 + 1000);
  });

  it('极端巨图：严格服从上限（宁可少像素也不 OOM）', () => {
    const p = planExportSize({ boundsW: 1e6, boundsH: 1e6, maxPixels: 1_000_000 });
    expect(p.outW * p.outH).toBeLessThanOrEqual(1_000_000 + 1000);
    expect(p.outW).toBeGreaterThan(0);
    expect(p.outH).toBeGreaterThan(0);
  });

  it('极小的图：短边被 minSide 兜住，zoom 被撑到上限 4', () => {
    const p = planExportSize({ boundsW: 10, boundsH: 10, minSide: 480 });
    expect(p.cssH).toBe(480);
    expect(p.zoom).toBe(4);
  });

  it('极扁的图：短边被 minSide 兜住，长边仍 1:1', () => {
    const p = planExportSize({ boundsW: 4000, boundsH: 20, minSide: 480 });
    expect(p.cssH).toBe(480);
    expect(p.cssW).toBe(4480);
    expect(p.zoom).toBeCloseTo(1, 3);
  });

  it('零尺寸输入不产生 NaN / 0 输出', () => {
    const p = planExportSize({ boundsW: 0, boundsH: 0 });
    expect(Number.isFinite(p.outW)).toBe(true);
    expect(p.outW).toBeGreaterThan(0);
    expect(p.outH).toBeGreaterThan(0);
  });

  it('GIF 预设比 PNG 保守，但仍远高于旧版 1600 长边', () => {
    const p = planExportSize({ boundsW: 9000, boundsH: 3000 }, GIF_PRESET);
    expect(p.outW * p.outH).toBeGreaterThan(15_000_000);
    expect(p.outW * p.outH).toBeLessThanOrEqual(24_000_000 + 1000);
    expect(p.fontPx).toBeGreaterThan(9);
  });

  it('倍率永远不会超过期望值（不会无意义放大）', () => {
    const p = planExportSize({ boundsW: 10, boundsH: 10, ratio: 3 });
    expect(p.ratio).toBe(3);
    expect(p.fontPx).toBeGreaterThan(26);
  });
});
