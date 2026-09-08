import { describe, expect, it } from 'vitest';
import { FLOW_W_MAX, FLOW_W_MIN, flowCardSize } from './nodeSize';
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
