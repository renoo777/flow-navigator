import { describe, expect, it } from 'vitest';
import { FLOW_H_BASE, FLOW_LINE_H, FLOW_W_MAX, FLOW_W_MIN, flowCardSize, wrapByCols } from './nodeSize';
import { inferAnchorSides } from './anchor';

describe('flowCardSize（流程卡片尺寸：宽度封顶 + 长文本换行增高）', () => {
  it('短标签单行，宽度随字数增长但不低于最小宽', () => {
    expect(flowCardSize('短').w).toBe(FLOW_W_MIN);
    const a = flowCardSize('原始凭证审核');
    expect(a.h).toBe(46);
    expect(a.w).toBeGreaterThan(FLOW_W_MIN);
    expect(a.w).toBeLessThanOrEqual(FLOW_W_MAX);
  });

  it('长标签不再无限拉宽：到顶后换行增高', () => {
    const long = flowCardSize('这是一个非常长的节点标题用来验证换行增高而不是无限撑宽');
    expect(long.w).toBe(FLOW_W_MAX);
    expect(long.h).toBeGreaterThan(46);
    /* 宽高比必须收敛：早期 300+ × 46 的长条会让自动选边把侧边连线误判成上下 */
    expect(long.w / long.h).toBeLessThan(4.9);
  });

  it('字数越多行越高，但宽度恒定', () => {
    const a = flowCardSize('一二三四五六七八九十一二三四五六');
    const b = flowCardSize('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十');
    expect(b.h).toBeGreaterThan(a.h);
    expect(a.w).toBe(b.w);
  });

  it('空标题 / 超长标题都不崩', () => {
    expect(flowCardSize('').w).toBe(FLOW_W_MIN);
    const huge = flowCardSize('长'.repeat(500));
    expect(huge.w).toBe(FLOW_W_MAX);
    expect(Number.isFinite(huge.h)).toBe(true);
  });

  it('回归：卡片换行增高后，同样几何下的自动选边从「上下」纠正为「侧边」', () => {
    /* 同一对相对位置（中心距 dx=200 / dy=55，即横向拉开、纵向只错开约一行）：
       - 旧卡片 176×46（扁）：纵向投影不重叠，射线先撞上下边 → bottom ✗
       - 新卡片 216×64（两行，更高）：纵向投影重叠 → right ✓，与飞书原画一致 */
    const mk = (w: number, h: number) => ({ x: 0, y: 0, w, h });
    const dx = 200;
    const dy = 55;
    const oldFlat = inferAnchorSides(mk(176, 46), { x: dx - 88, y: dy - 23, w: 176, h: 46 });
    const newTall = inferAnchorSides(mk(216, 64), { x: dx - 108, y: dy - 32, w: 216, h: 64 });
    expect(oldFlat.source).toBe('bottom');
    expect(newTall.source).toBe('right');
  });
});

describe('点1 自定义换行：wrapByCols / flowCardSize(label, wrapCols)', () => {
  it('wrapByCols 按每行 N 字硬折（码点计，不劈汉字）', () => {
    expect(wrapByCols('核对订单金额确认地址', 5)).toBe('核对订单金\n额确认地址');
    expect(wrapByCols('abcdefgh', 3)).toBe('abc\ndef\ngh');
  });

  it('wrapByCols 尊重已有手动换行，只对超长段再切', () => {
    expect(wrapByCols('第一段很长需要切\n短', 3)).toBe('第一段\n很长需\n要切\n短');
  });

  it('cols 缺失 / <2 → 原文返回（不启用规则）', () => {
    expect(wrapByCols('不要动我')).toBe('不要动我');
    expect(wrapByCols('不要动我', 1)).toBe('不要动我');
    expect(wrapByCols('不要动我', undefined)).toBe('不要动我');
  });

  it('flowCardSize 带 wrapCols：最长行定宽、行数定高（与 CSS pre-wrap 渲染一致）', () => {
    const single = flowCardSize('五字标签'); /* 单行 */
    expect(single.h).toBe(FLOW_H_BASE);
    const wrapped = flowCardSize('十二个字的标签占一行吧', 6); /* 11 字 / 每行 6 → 2 行 */
    expect(wrapped.w).toBe(Math.min(FLOW_W_MAX, Math.max(FLOW_W_MIN, 6 * 13 + 76)));
    expect(wrapped.h).toBe(FLOW_H_BASE + FLOW_LINE_H);
  });

  it('flowCardSize 手动 \n 同样按行数增高（编辑态 Enter 断行）', () => {
    const s = flowCardSize('第一行\n第二行\n第三行');
    expect(s.h).toBe(FLOW_H_BASE + 2 * FLOW_LINE_H);
  });
});
