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
