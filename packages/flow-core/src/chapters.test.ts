import { describe, expect, it } from 'vitest';
import { deriveChapters } from './chapters';
import type { SearchableNode } from './search';

const N = (id: string, label = id): SearchableNode => ({ id, label });
const E = (source: string, target: string) => ({ source, target });

describe('deriveChapters', () => {
  it('链式图：每层一章，label 取该层首节点', () => {
    const ch = deriveChapters([N('a', '开始'), N('b', '处理'), N('c', '结束')], [E('a', 'b'), E('b', 'c')]);
    expect(ch).toHaveLength(3);
    expect(ch.map((x) => x.label)).toEqual(['开始', '处理', '结束']);
    expect(ch[2].nodeIds).toEqual(['c']);
  });

  it('同层并行节点归同一章', () => {
    const ch = deriveChapters(
      [N('a'), N('b1'), N('b2'), N('c')],
      [E('a', 'b1'), E('a', 'b2'), E('b1', 'c'), E('b2', 'c')]
    );
    expect(ch).toHaveLength(3);
    expect(ch[1].nodeIds.sort()).toEqual(['b1', 'b2']);
  });

  it('超过 max 章时均匀合并', () => {
    const ns = Array.from({ length: 10 }, (_, i) => N(`n${i}`));
    const es = Array.from({ length: 9 }, (_, i) => E(`n${i}`, `n${i + 1}`));
    const ch = deriveChapters(ns, es, 5);
    expect(ch.length).toBe(5);
    expect(ch.flat().map((c) => c.nodeIds).flat()).toHaveLength(10);
  });

  it('环中节点不丢：归入最深一层', () => {
    const ch = deriveChapters([N('r1'), N('r2'), N('r3')], [E('r1', 'r2'), E('r2', 'r3'), E('r3', 'r1')]);
    expect(ch).toHaveLength(1);
    expect(ch[0].nodeIds.sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('空图返回空', () => {
    expect(deriveChapters([], [])).toEqual([]);
  });
});
