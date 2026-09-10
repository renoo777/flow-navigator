/**
 * richText.test.ts — 0920 标题富文本引擎单测
 *
 * 核心不变量（每条用例都顺带校验）：
 *   任何 togglt/setColor 变换之后，segmentsToPlain(result) 必须 === 原纯文本。
 * 这条守不住，label（唯一真相）就会和 labelSegments 错位，渲染层会降级丢样式。
 */
import { describe, it, expect } from 'vitest';
import {
  segmentsToPlain,
  plainToSegments,
  resolveRenderSegments,
  toggleBoldInRange,
  setColorInRange,
  isRangeBold,
  rangeColor,
} from './richText';
import type { RichSegment } from './types';

const PLAIN = '核对报价明细';

/** 不变量：变换后拼回纯文本不能变 */
function expectSameText(result: RichSegment[], source: RichSegment[]) {
  expect(segmentsToPlain(result)).toBe(segmentsToPlain(source));
}

describe('segmentsToPlain / plainToSegments', () => {
  it('拼接多片段为纯文本', () => {
    expect(segmentsToPlain([{ text: '核对', bold: true }, { text: '报价' }])).toBe('核对报价');
  });

  it('空 / undefined 得空串', () => {
    expect(segmentsToPlain(undefined)).toBe('');
    expect(segmentsToPlain([])).toBe('');
  });

  it('纯文本转单片段，空串得空数组', () => {
    expect(plainToSegments('核对')).toEqual([{ text: '核对' }]);
    expect(plainToSegments('')).toEqual([]);
  });
});

describe('toggleBoldInRange', () => {
  it('选中前两字 → 只加粗这两字', () => {
    const src = plainToSegments(PLAIN);
    const r = toggleBoldInRange(src, 0, 2);
    expect(r).toEqual([{ text: '核对', bold: true }, { text: '报价明细' }]);
    expectSameText(r, src);
  });

  it('选中中间两字 → 拆成三段', () => {
    const src = plainToSegments(PLAIN);
    const r = toggleBoldInRange(src, 2, 4);
    expect(r).toEqual([{ text: '核对' }, { text: '报价', bold: true }, { text: '明细' }]);
    expectSameText(r, src);
  });

  it('整段已加粗时再 toggle → 取消加粗', () => {
    const src: RichSegment[] = [{ text: PLAIN, bold: true }];
    const r = toggleBoldInRange(src, 0, PLAIN.length);
    expect(r).toEqual([{ text: PLAIN }]);
    expectSameText(r, src);
  });

  it('跨片段选中且部分已加粗 → 整个区间统一加粗', () => {
    const src: RichSegment[] = [{ text: '核对', bold: true }, { text: '报价明细' }];
    const r = toggleBoldInRange(src, 0, PLAIN.length);
    expect(r).toEqual([{ text: PLAIN, bold: true }]);
    expectSameText(r, src);
  });

  it('空选（start === end）不产生副作用', () => {
    const src = plainToSegments(PLAIN);
    expect(toggleBoldInRange(src, 2, 2)).toEqual(src);
  });

  it('越界区间被夹紧到边界且不丢字', () => {
    const src = plainToSegments(PLAIN);
    const r = toggleBoldInRange(src, -5, 999);
    expect(r).toEqual([{ text: PLAIN, bold: true }]);
    expectSameText(r, src);
  });

  it('区间反写（start > end）自动交换', () => {
    const src = plainToSegments(PLAIN);
    expect(toggleBoldInRange(src, 4, 2)).toEqual(toggleBoldInRange(src, 2, 4));
  });
});

describe('setColorInRange', () => {
  it('给选中段设色', () => {
    const src = plainToSegments(PLAIN);
    const r = setColorInRange(src, 2, 4, '#cc0000');
    expect(r).toEqual([
      { text: '核对' },
      { text: '报价', color: '#cc0000' },
      { text: '明细' },
    ]);
    expectSameText(r, src);
  });

  it('传 null 清除颜色', () => {
    const src: RichSegment[] = [{ text: '核对' }, { text: '报价', color: '#cc0000' }];
    const r = setColorInRange(src, 2, 4, null);
    expect(r).toEqual([{ text: '核对报价' }]);
    expectSameText(r, src);
  });

  it('相邻同色自动合并成一个片段', () => {
    const src = plainToSegments(PLAIN);
    const once = setColorInRange(src, 0, 2, '#cc0000');
    const twice = setColorInRange(once, 2, 4, '#cc0000');
    expect(twice).toEqual([
      { text: '核对报价', color: '#cc0000' },
      { text: '明细' },
    ]);
  });

  it('颜色不同不会合并', () => {
    const once = setColorInRange(plainToSegments(PLAIN), 0, 2, '#cc0000');
    const twice = setColorInRange(once, 2, 4, '#0000cc');
    expect(twice).toEqual([
      { text: '核对', color: '#cc0000' },
      { text: '报价', color: '#0000cc' },
      { text: '明细' },
    ]);
  });

  it('加粗与颜色可叠加在同一片段上', () => {
    let r = plainToSegments(PLAIN);
    r = toggleBoldInRange(r, 0, 2);
    r = setColorInRange(r, 0, 2, '#cc0000');
    expect(r).toEqual([
      { text: '核对', bold: true, color: '#cc0000' },
      { text: '报价明细' },
    ]);
  });

  it('空选不产生副作用', () => {
    const src = plainToSegments(PLAIN);
    expect(setColorInRange(src, 3, 3, '#cc0000')).toEqual(src);
  });
});

describe('工具条状态查询', () => {
  it('isRangeBold：全部加粗才为 true', () => {
    const segs: RichSegment[] = [{ text: '核对', bold: true }, { text: '报价' }];
    expect(isRangeBold(segs, 0, 2)).toBe(true);
    expect(isRangeBold(segs, 0, 4)).toBe(false);
    expect(isRangeBold(segs, 1, 1)).toBe(false);
  });

  it('rangeColor：返回区间起点颜色', () => {
    const segs: RichSegment[] = [{ text: '核对', color: '#cc0000' }, { text: '报价' }];
    expect(rangeColor(segs, 0, 2)).toBe('#cc0000');
    expect(rangeColor(segs, 2, 4)).toBeUndefined();
  });
});

describe('resolveRenderSegments（label 是唯一真相）', () => {
  it('无 segments → 按纯文本渲染', () => {
    expect(resolveRenderSegments(PLAIN, undefined)).toEqual([{ text: PLAIN }]);
  });

  it('segments 拼回等于 label → 用 segments（富文本生效）', () => {
    const segs: RichSegment[] = [{ text: '核对', bold: true }, { text: '报价明细' }];
    expect(resolveRenderSegments(PLAIN, segs)).toEqual(segs);
  });

  it('label 被别处改过（不一致）→ 降级回纯文本，样式绝不错位', () => {
    const segs: RichSegment[] = [{ text: '核对', bold: true }, { text: '报价明细' }];
    const r = resolveRenderSegments('核对报价', segs);
    expect(r).toEqual([{ text: '核对报价' }]);
    expect(segmentsToPlain(r)).toBe('核对报价');
  });

  it('label 为空时不渲染任何片段', () => {
    expect(resolveRenderSegments('', [{ text: '旧', bold: true }])).toEqual([]);
  });
});
