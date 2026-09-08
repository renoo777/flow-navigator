import { describe, expect, it } from 'vitest';
import { inferAnchorSides, isAnchorPinned, oppositeSide, type AnchorBox } from './anchor';

const box = (x: number, y: number, w = 180, h = 46): AnchorBox => ({ x, y, w, h });

describe('inferAnchorSides（连线端点自动选边）', () => {
  it('正下方 → 下出上进（标准流程图走向）', () => {
    expect(inferAnchorSides(box(0, 0), box(0, 90))).toEqual({ source: 'bottom', target: 'top' });
  });

  it('正右方 → 右出左进（横向流程）', () => {
    expect(inferAnchorSides(box(0, 0), box(320, 0))).toEqual({ source: 'right', target: 'left' });
  });

  it('右下方（偏右更多）→ 右出左进，不再绕成下出上进', () => {
    expect(inferAnchorSides(box(0, 0), box(420, 90))).toEqual({ source: 'right', target: 'left' });
  });

  it('判断的左分支（横向拉开为主）→ 左出右进', () => {
    expect(inferAnchorSides(box(300, 0), box(0, 20))).toEqual({ source: 'left', target: 'right' });
  });

  it('判断的左分支（仅低一行、横向 300）→ 仍是下出上进，符合流程图观感', () => {
    expect(inferAnchorSides(box(300, 0), box(0, 90))).toEqual({ source: 'bottom', target: 'top' });
  });

  it('下游被拖到上游上方 → 上出下进，箭头不再朝反', () => {
    expect(inferAnchorSides(box(0, 200), box(0, 0))).toEqual({ source: 'top', target: 'bottom' });
  });

  it('回边（返工：右下源 → 左上目标）方向正确', () => {
    const r = inferAnchorSides(box(400, 300), box(0, 0));
    expect(r.source).toBe('top');
    expect(r.target).toBe('bottom');
  });

  it('尺寸差异大时不被横向距离带偏（宽卡片纵向只差一点 → 仍走上下）', () => {
    expect(inferAnchorSides(box(0, 0, 600, 40), box(500, 80, 600, 40))).toEqual({
      source: 'bottom',
      target: 'top',
    });
  });

  it('退化输入（零尺寸 / 重合中心）退回下出上进，不抛错', () => {
    expect(inferAnchorSides(box(10, 10, 0, 0), box(10, 10, 0, 0))).toEqual({
      source: 'bottom',
      target: 'top',
    });
  });

  it('扁卡片纵向几乎对齐、横向已分开 → 左右连（投影重叠优先，不被扁盒子带偏）', () => {
    /* 中心距 dx=190、dy=43，卡片高 46：纵向投影仍重叠 → 能水平直达，就该走侧边。
       纯射线法在 w=216 / h=46 的扁盒子上会算出 bottom（tx=0.568 > ty=0.535）。 */
    const from: AnchorBox = { x: 0, y: 0, w: 216, h: 46 };
    const to: AnchorBox = { x: 224, y: 43, w: 148, h: 46 };
    expect(inferAnchorSides(from, to)).toEqual({ source: 'right', target: 'left' });
  });

  it('横向投影重叠、纵向拉开 → 上下连', () => {
    const from: AnchorBox = { x: 0, y: 0, w: 216, h: 46 };
    const to: AnchorBox = { x: 30, y: 260, w: 148, h: 46 };
    expect(inferAnchorSides(from, to)).toEqual({ source: 'bottom', target: 'top' });
  });

  it('两盒相交（两轴都重叠）→ 退回射线法，不报错也不跳变', () => {
    const from: AnchorBox = { x: 0, y: 0, w: 216, h: 46 };
    const to: AnchorBox = { x: 40, y: 10, w: 216, h: 46 };
    const r = inferAnchorSides(from, to);
    expect(['top', 'right', 'bottom', 'left']).toContain(r.source);
    expect(r.target).toBe(oppositeSide(r.source));
  });

  it('oppositeSide 互为反侧', () => {
    expect(oppositeSide('right')).toBe('left');
    expect(oppositeSide('top')).toBe('bottom');
  });

  it('isAnchorPinned 只认显式钉住的边', () => {
    expect(isAnchorPinned({ anchorPinned: true })).toBe(true);
    expect(isAnchorPinned({})).toBe(false);
    expect(isAnchorPinned(undefined)).toBe(false);
  });
});
