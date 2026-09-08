/* 飞书 37 边黄金样本回归（WP7-3）：
 * 真实画板（复杂流程图_画板1.svg 导出）解析出的 28 节点 / 37 连线的出/入侧真值。
 * 图级推断 inferGraphSides 必须保持 ≥30/37 一致（当前 32/37，剩 5 条为镜像弧/菱形端点微差），
 * 防止未来改动把回流识别 / 菱形分叉 / 出口分散修退化。 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inferGraphSides } from './anchor';

const here = dirname(fileURLToPath(import.meta.url));
const gold = JSON.parse(
  readFileSync(join(here, '__fixtures__/feishu-board1.gold.json'), 'utf-8')
) as {
  nodes: { id: string; text: string; shape: string; bbox: [number, number, number, number] }[];
  edges: {
    id: string;
    label: string;
    fromNode: string | null;
    toNode: string | null;
    fromSide: string | null;
    toSide: string | null;
  }[];
};

const boxById = new Map(
  gold.nodes.map((n) => [n.id, { x: n.bbox[0], y: n.bbox[1], w: n.bbox[2], h: n.bbox[3] }])
);
const diamondIds = new Set(gold.nodes.filter((n) => n.shape === 'diamond').map((n) => n.id));

describe('SVG 黄金样本 → 图级方向推断一致率（WP7-3 回归护栏）', () => {
  test('37 边中 ≥30 条与飞书真值完全一致', () => {
    const refs = gold.edges
      .filter((e) => e.fromNode && e.toNode && e.fromSide && e.toSide)
      .map((e) => ({ source: e.fromNode!, target: e.toNode!, label: e.label }));
    const res = inferGraphSides(boxById, refs, diamondIds);

    let hit = 0;
    let bi = 0;
    const misses: string[] = [];
    for (const e of gold.edges) {
      if (!e.fromNode || !e.toNode || !e.fromSide || !e.toSide) continue;
      const r = res[bi++];
      if (r.sourceSide === e.fromSide && r.targetSide === e.toSide) hit += 1;
      else {
        misses.push(
          `${e.id} 真值 ${e.fromNode}.${e.fromSide}->${e.toNode}.${e.toSide}` +
            ` 推断 ${e.fromNode}.${r.sourceSide}->${e.toNode}.${r.targetSide}`
        );
      }
    }
    console.log(`一致 ${hit}/${res.length}，不一致：\n${misses.join('\n')}`);
    expect(hit).toBeGreaterThanOrEqual(30);
  });
});
