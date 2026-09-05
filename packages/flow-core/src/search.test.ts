import { describe, expect, it } from 'vitest';
import { searchNodes, type SearchableNode } from './search';

const nodes: SearchableNode[] = [
  { id: 'n1', label: '开始：客户来电', kind: 'io-start', talk: [{ text: '您好，我是客服小安' }] },
  { id: 'd1', label: '有没有司机报价？', kind: 'decision', talk: [{ text: '我先看一下当前有没有司机在报价。' }] },
  { id: 'a1', label: '核对实时报价', kind: 'step', talk: [{ text: '现在有 3 位司机报价：最低 86 元。' }] },
];

describe('searchNodes', () => {
  it('空/纯空白查询返回空', () => {
    expect(searchNodes(nodes, '')).toEqual([]);
    expect(searchNodes(nodes, '   ')).toEqual([]);
  });

  it('节点名命中（不区分大小写）', () => {
    const r = searchNodes(nodes, '报价');
    expect(r.map((h) => h.id).sort()).toEqual(['a1', 'd1']);
    expect(r[0].where).toBe('节点名');
  });

  it('大小写不敏感', () => {
    const ns: SearchableNode[] = [{ id: 'x', label: 'Call Customer' }];
    expect(searchNodes(ns, 'call')).toHaveLength(1);
  });

  it('类型名命中（传入 kindLabel）', () => {
    const r = searchNodes(nodes, '决策', (k) => (k === 'decision' ? '分支决策' : '步骤'));
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('d1');
    expect(r[0].where).toBe('类型');
  });

  it('话术内容命中，带片段预览', () => {
    const r = searchNodes(nodes, '客服小安');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('n1');
    expect(r[0].where).toBe('话术');
    expect(r[0].snippet).toContain('小安');
  });

  it('优先级：节点名 > 类型 > 话术', () => {
    // a1 的 label 含「报价」，话术也含「报价」——只应出现一次，且标为节点名
    const r = searchNodes(nodes, '报价').filter((h) => h.id === 'a1');
    expect(r).toHaveLength(1);
    expect(r[0].where).toBe('节点名');
  });
});
