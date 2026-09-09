/** 飞书画板剪贴板解析 · 单测（fixture 来自真实飞书复制样本，已脱敏精简） */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isFeishuWhiteboardHtml, parseFeishuWhiteboard, shapeToEdgeType } from './feishu';
import type { ImportedEdge, ImportedNode } from './feishu';

const fixture = readFileSync(
  new URL('./__fixtures__/feishu-clip.html', import.meta.url),
  'utf-8'
);

/** 用给定 data 数组伪造一段飞书剪贴板 HTML（覆盖真实编码链：JSON → URL 编码 → base64） */
function buildHtml(data: unknown[], tail = ''): string {
  const json = JSON.stringify({ token: 'x', data }) + tail;
  const b64 = Buffer.from(encodeURIComponent(json), 'utf-8').toString('base64');
  return `<div><span data-info="--%whiteboard-x--${b64}">文字</span></div>`;
}

const shape = (id: string, shapeType: number, text: string, x = 0, y = 0) => ({
  id,
  type: 13,
  info: {
    baseV2: { x, y, width: 120, height: 60 },
    textV2: { text: encodeURIComponent(text) },
    compositeShape: { shapeType },
  },
});

const conn = (from: string, to: string, label = '') => ({
  id: `c:${from}-${to}`,
  type: 15,
  info: {
    connectorV2: {
      startObject: { objectId: from },
      endObject: { objectId: to },
      captions: label ? { data: [{ textStyle: { text: encodeURIComponent(label) } }] } : {},
    },
  },
});

/** o1 型连线：connectorV2 两端带归一化附着锚点 position（用户真实拖拽落点） */
const connP = (from: string, to: string, ps: [number, number], pt: [number, number], label = '') => ({
  id: `cp:${from}-${to}`,
  type: 15,
  info: {
    connectorV2: {
      startObject: { objectId: from, position: { x: ps[0], y: ps[1] } },
      endObject: { objectId: to, position: { x: pt[0], y: pt[1] } },
      captions: label ? { data: [{ textStyle: { text: encodeURIComponent(label) } }] } : {},
    },
  },
});

describe('isFeishuWhiteboardHtml', () => {
  it('识别飞书负载', () => {
    expect(isFeishuWhiteboardHtml(fixture)).toBe(true);
  });
  it('普通 HTML / 空值返回 false', () => {
    expect(isFeishuWhiteboardHtml('<div>hello</div>')).toBe(false);
    expect(isFeishuWhiteboardHtml('')).toBe(false);
    expect(isFeishuWhiteboardHtml(undefined)).toBe(false);
  });
});

describe('parseFeishuWhiteboard · 真实样本', () => {
  const g = parseFeishuWhiteboard(fixture);

  it('节点数 / 边数与样本一致，悬空边被丢弃', () => {
    expect(g.nodes).toHaveLength(12);
    expect(g.edges).toHaveLength(13); // 样本 14 条，其中 1 条两端都不存在
  });

  it('菱形→decision，矩形→step', () => {
    expect(g.stats.decisions).toBe(5);
    const d = g.nodes.filter((n) => n.kind === 'decision');
    expect(d).toHaveLength(5);
    expect(g.nodes.filter((n) => n.kind === 'step')).toHaveLength(7);
  });

  it('分支文字落到边 label 上', () => {
    expect(g.stats.labeled).toBe(10);
    const labels = g.edges.map((e) => e.label).filter(Boolean);
    expect(labels).toEqual(
      expect.arrayContaining(['通过', '不通过', '平衡', '不平衡', '相符', '不符'])
    );
  });

  it('多行文本折叠成单行（卡片 nowrap）', () => {
    const first = g.nodes[0];
    expect(first.label).toBe('加盖收讫/付讫章 登记日记账');
    expect(first.label).not.toContain('\n');
  });

  it('坐标归一化：左上角贴到留白，相对位置不变', () => {
    const xs = g.nodes.map((n) => n.x);
    const ys = g.nodes.map((n) => n.y);
    expect(Math.min(...xs)).toBe(60);
    expect(Math.min(...ys)).toBe(60);
  });

  it('每个节点 id 唯一，边的端点都能对上', () => {
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.size).toBe(g.nodes.length);
    g.edges.forEach((e: ImportedEdge) => {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    });
  });

  it('每条线按原画几何反推出出/入侧（锚点复用数据源）', () => {
    const valid = new Set(['top', 'right', 'bottom', 'left']);
    g.edges.forEach((e: ImportedEdge) => {
      expect(e.sourceSide).toBeDefined();
      expect(e.targetSide).toBeDefined();
      expect(valid.has(e.sourceSide as string)).toBe(true);
      expect(valid.has(e.targetSide as string)).toBe(true);
    });
    /* 真实样本里存在横向连线（判断左/右分支）→ 证明不是全员默认「下出上进」 */
    const horizontal = g.edges.some(
      (e) => e.sourceSide === 'left' || e.sourceSide === 'right'
    );
    expect(horizontal).toBe(true);
  });
});

describe('position 真值钉住出/入侧（o1 型负载）', () => {
  /* 布局：菱形 A 在 (0,0)，step B 在正下方同列 (0,200) —— 几何必然判 bottom->top。
     o1 型负载若带 position 真值（如 A 右侧出、B 左侧入），必须钉住而不被几何覆盖。 */
  const layout = () => [
    shape('a', 10, '判断?', 0, 0),
    shape('b', 8, '下方结果', 0, 200),
  ];

  it('带 position 时按用户真实落点定侧（覆盖几何推断）', () => {
    const html = buildHtml([
      ...layout(),
      connP('a', 'b', [1, 0.5], [0, 0.5], '去'),
    ]);
    const g = parseFeishuWhiteboard(html);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].sourceSide).toBe('right');
    expect(g.edges[0].targetSide).toBe('left');
  });

  it('无 position 时退回几何推断（o2 型行为不变）', () => {
    const html = buildHtml([
      ...layout(),
      conn('a', 'b', '去'),
    ]);
    const g = parseFeishuWhiteboard(html);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].sourceSide).toBe('bottom');
    expect(g.edges[0].targetSide).toBe('top');
  });

  it('贴边锚点走对应侧（y≈1 底 / y≈0 顶 / x≈0 左 / x≈1 右）', () => {
    const html = buildHtml([
      shape('a', 8, 'A', 0, 0),
      shape('b', 8, 'B', 0, 400),
      shape('c', 8, 'C', 0, 800),
      connP('a', 'b', [0.5, 1], [0.5, 0.007], '下出上进'),
      connP('a', 'c', [0.5, 0], [0.5, 0.993], '上出下进'),
    ]);
    const g = parseFeishuWhiteboard(html);
    const [e1, e2] = g.edges;
    expect(`${e1.sourceSide}->${e1.targetSide}`).toBe('bottom->top');
    expect(`${e2.sourceSide}->${e2.targetSide}`).toBe('top->bottom');
  });
});

describe('parseFeishuWhiteboard · 容错', () => {
  it('自环被丢弃', () => {
    const html = buildHtml([
      shape('a', 8, 'A', 0, 0),
      shape('b', 8, 'B', 100, 0),
      conn('a', 'b', '去'),
      conn('a', 'a', '自环'),
    ]);
    const g = parseFeishuWhiteboard(html);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].label).toBe('去');
  });

  /* 回归：真实飞书图里「报表勾稽关系是否正确?」的两条出边（正确 / 不正确）都指向同一节点。
     早期按 source->target 去重会吞掉一条 —— 既丢分支文字，又让该判断点出边从 2 变 1 而不再是变量。 */
  it('平行边全部保留（同一对节点的多条分支）', () => {
    const html = buildHtml([
      shape('a', 10, '勾稽是否正确?', 0, 0),
      shape('b', 8, 'B', 100, 200),
      conn('a', 'b', '不正确'),
      conn('a', 'b', '正确'),
    ]);
    const g = parseFeishuWhiteboard(html);
    expect(g.edges).toHaveLength(2);
    expect(g.edges.map((e) => e.label).sort()).toEqual(['不正确', '正确'].sort());
    expect(g.stats.parallel).toBe(1);
    expect(g.nodes[0].kind).toBe('decision');
  });

  it('矩形但出边是一对判断词 → 也识别为 decision', () => {
    const html = buildHtml([
      shape('a', 8, '财务负责人审批', 0, 0),
      shape('b', 8, '通过后续', -120, 200),
      shape('c', 8, '退回', 120, 200),
      conn('a', 'b', '通过'),
      conn('a', 'c', '不通过'),
    ]);
    const g = parseFeishuWhiteboard(html);
    expect(g.nodes.find((n) => n.label === '财务负责人审批')!.kind).toBe('decision');
  });

  it('非飞书 HTML 抛错', () => {
    expect(() => parseFeishuWhiteboard('<div>plain</div>')).toThrow();
  });

  it('负载尾部有多余字节也能解析（raw_decode 场景）', () => {
    const withTail = buildHtml(
      [shape('a', 8, '起始', 10, 20), shape('b', 10, '判断?', 10, 100)],
      'ZZZ truncated'
    );
    const g = parseFeishuWhiteboard(withTail);
    expect(g.nodes.map((n: ImportedNode) => n.label)).toEqual(['起始', '判断?']);
  });

  it('空画板抛错而不是静默返回空图', () => {
    expect(() => parseFeishuWhiteboard(buildHtml([]))).toThrow();
    expect(() => parseFeishuWhiteboard(buildHtml([{ id: 'x', type: 99 }]))).toThrow();
  });
});

/** 带线型字段的连线（connectorV2.shape：0=直线 1=肘线 2=曲线，真实样本自证） */
const connShaped = (from: string, to: string, sh?: number) => ({
  id: `c:${from}-${to}`,
  type: 15,
  info: {
    connectorV2: {
      ...(sh === undefined ? {} : { shape: sh }),
      startObject: { objectId: from },
      endObject: { objectId: to },
      captions: {},
    },
  },
});

describe('飞书连线线型（0918 新增「按飞书原样」粘贴方式）', () => {
  const base = () => [
    shape('a', 8, '开始', 0, 0),
    shape('b', 8, '步骤一', 0, 200),
    shape('c', 8, '步骤二', 0, 400),
    shape('d', 8, '结束', 0, 600),
  ];

  it('shape 0/1/2 分别解析为 straight / elbow / curve', () => {
    const g = parseFeishuWhiteboard(
      buildHtml([...base(), connShaped('a', 'b', 0), connShaped('b', 'c', 1), connShaped('c', 'd', 2)])
    );
    expect(g.edges.map((e: ImportedEdge) => e.shape)).toEqual(['straight', 'elbow', 'curve']);
    expect(g.stats.shaped).toBe(3);
    expect(g.stats.shapes).toEqual({ straight: 1, elbow: 1, curve: 1 });
  });

  it('老剪贴板无 shape 字段 → edge.shape 为 undefined、shaped 为 0', () => {
    const g = parseFeishuWhiteboard(buildHtml([...base(), connShaped('a', 'b'), connShaped('b', 'c')]));
    expect(g.edges.every((e: ImportedEdge) => e.shape === undefined)).toBe(true);
    expect(g.stats.shaped).toBe(0);
    expect(g.stats.shapes).toEqual({ straight: 0, elbow: 0, curve: 0 });
  });

  it('混用线型时各条按自己类型保留，不会互相覆盖', () => {
    const g = parseFeishuWhiteboard(
      buildHtml([
        ...base(),
        connShaped('a', 'b', 2),
        connShaped('b', 'c', 2),
        connShaped('c', 'd', 1),
      ])
    );
    expect(g.edges.map((e: ImportedEdge) => e.shape)).toEqual(['curve', 'curve', 'elbow']);
    expect(g.stats.shapes).toEqual({ straight: 0, elbow: 1, curve: 2 });
  });

  it('未知 shape 值不误判，按缺失处理', () => {
    const g = parseFeishuWhiteboard(buildHtml([...base(), connShaped('a', 'b', 9)]));
    expect(g.stats.shaped).toBe(0);
    expect(g.edges[0].shape).toBeUndefined();
  });

  it('shapeToEdgeType：直线→straight、曲线→default、肘线与缺失→smoothstep', () => {
    expect(shapeToEdgeType('straight')).toBe('straight');
    expect(shapeToEdgeType('curve')).toBe('default');
    expect(shapeToEdgeType('elbow')).toBe('smoothstep');
    expect(shapeToEdgeType(undefined)).toBe('smoothstep');
  });
});
