import { describe, expect, it } from 'vitest';
import type { FlowEdge } from './types';
import { traceChain } from './trace';

const e = (source: string, target: string): FlowEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  type: 'step',
  label: '',
});

/** 链：s → a → b → c ；另有一条旁路 s → x（x 孤立尾巴） */
const edges: FlowEdge[] = [e('s', 'a'), e('a', 'b'), e('b', 'c'), e('s', 'x')];

/** 环图：r1 → r2 → r3 → r1 */
const cyclic: FlowEdge[] = [e('r1', 'r2'), e('r2', 'r3'), e('r3', 'r1')];

describe('traceChain · 全链路', () => {
  it('空 id 返回空结果', () => {
    const r = traceChain(null, edges);
    expect(r.nodes.size).toBe(0);
    expect(r.edges.size).toBe(0);
  });

  it('中间节点 a：上游 s，下游 b/c，边命中 s->a、a->b、b->c', () => {
    const r = traceChain('a', edges, 'full');
    expect([...r.nodes].sort()).toEqual(['a', 'b', 'c', 's']);
    expect([...r.upstream].sort()).toEqual(['s']);
    expect([...r.downstream].sort()).toEqual(['b', 'c']);
    expect([...r.edges].sort()).toEqual(['a->b', 'b->c', 's->a']);
  });

  it('不误伤旁支：追踪 a 时不带 s 的另一条出边 s->x', () => {
    const r = traceChain('a', edges, 'full');
    expect(r.edges.has('s->x')).toBe(false);
    expect(r.nodes.has('x')).toBe(false);
  });

  it('末端 c：只有上游，无下游', () => {
    const r = traceChain('c', edges, 'full');
    expect([...r.upstream].sort()).toEqual(['a', 'b', 's']);
    expect(r.downstream.size).toBe(0);
    expect([...r.edges].sort()).toEqual(['a->b', 'b->c', 's->a']);
  });

  it('孤立节点：只含自身、无连线', () => {
    const r = traceChain('zz', edges, 'full');
    expect([...r.nodes]).toEqual(['zz']);
    expect(r.edges.size).toBe(0);
  });

  it('环图不死循环', () => {
    const r = traceChain('r1', cyclic, 'full');
    expect([...r.nodes].sort()).toEqual(['r1', 'r2', 'r3']);
    expect(r.edges.size).toBe(3);
  });
});

describe('traceChain · 相邻一跳', () => {
  it('adjacent 只取直接上下游', () => {
    const r = traceChain('b', edges, 'adjacent');
    expect([...r.nodes].sort()).toEqual(['a', 'b', 'c']);
    expect([...r.edges].sort()).toEqual(['a->b', 'b->c']);
  });

  it('adjacent 上游也只一跳', () => {
    const r = traceChain('c', edges, 'adjacent');
    expect([...r.upstream]).toEqual(['b']);
    expect([...r.nodes].sort()).toEqual(['b', 'c']);
  });
});
