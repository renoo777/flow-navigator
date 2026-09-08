/** 飞书文档画板（Whiteboard）剪贴板 → 本软件流程图
 *
 * ## 背景
 * 在飞书文档画板里 Ctrl+C 复制流程图时，系统剪贴板的 `text/html` 里会带一段私有负载：
 * `<span data-info="--%whiteboard-x--<base64>">文字</span>`
 * base64 解出来是 URL 编码的 JSON（`{"data":[...]}`），`type:13`=形状、`type:15`=连线。
 * 本模块把这段负载解析成我们的节点/边结构，实现「复制飞书流程图 → 粘贴进本软件」。
 *
 * ## 编码链（实测确认，勿改）
 * base64 → UTF-8 字节 → URL 编码字符串 → decodeURIComponent → JSON（尾部可能有多余字节）
 *
 * ## 坐标语义（实测确认）
 * `info.baseV2` 的 x/y 是**左上角**（不是中心）：三个居中对齐、宽度不同的节点，
 * 其 x 各不相同但 x+width/2 完全一致。width/height 为原始尺寸。
 * 注意：我们卡片比飞书图元大 1.5~2 倍，坐标照搬会重叠 —— 落地前请过 `layeredLayout`。
 *
 * ## 形状映射
 * `info.compositeShape.shapeType`：10 = 菱形（判断）→ decision；其余（8 = 矩形等）→ step。
 * **结构兜底**：矩形但两条出边文字恰好是一对判断词（通过/不通过、是/否…）也判为 decision
 * —— 真实流程图里大量判断节点不是菱形画的（如「财务负责人审批」矩形带同意/驳回）。
 *
 * ## 平行边（重要）
 * 同一对节点之间可能有多条连线（如「正确」「不正确」都指向同一节点）。
 * 早期版本按 `source->target` 去重，会吞掉其中一条 —— 既丢分支文字，
 * 又让该判断点出边数从 2 变 1 而不再是变量。现在按飞书连线 id 去重，平行边全部保留。
 *
 * ## 文本
 * 文本在 `info.textV2.text`（URL 编码，`\n` 分行）；我们卡片是单行 nowrap，故换行折叠为空格。
 */
import { inferAnchorSides } from './anchor';
import { flowCardSize } from './nodeSize';
import type { AnchorSide } from './anchor';
import type { NodeKind } from './types';

/** 飞书私有剪贴板负载的标识 */
const MARKER = 'whiteboard-x--';

/** 解析出的节点（坐标为画布坐标，左上角；w/h 为飞书原始尺寸，供重排参考） */
export interface ImportedNode {
  id: string;
  label: string;
  kind: Extract<NodeKind, 'step' | 'decision'>;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 解析出的连线（source/target 为 ImportedNode.id） */
export interface ImportedEdge {
  source: string;
  target: string;
  label: string;
  /** 按飞书原始坐标推断的「出线侧」（两端中心射线与盒子求交 = 原画里线贴的那一侧） */
  sourceSide?: AnchorSide;
  /** 按飞书原始坐标推断的「入线侧」 */
  targetSide?: AnchorSide;
}

export interface ImportStats {
  nodes: number;
  edges: number;
  /** 菱形判断节点数 */
  decisions: number;
  /** 带分支文字的连线数（这些会变成变量选项） */
  labeled: number;
  /** 平行边数（同一对节点之间的多条连线，全部保留） */
  parallel: number;
  /** 判断形态但出边不足 2 条、因而不会成为变量的节点数（导入后提示用户补线） */
  weak: number;
}

export interface ImportedGraph {
  nodes: ImportedNode[];
  edges: ImportedEdge[];
  stats: ImportStats;
}

/** 归一化后留白（px），避免图形贴着画布 0,0 */
const PAD = 60;

/** 成对判断词：用于把「不是菱形但确实是判断」的矩形节点也识别成 decision */
const PAIR_WORDS: [string, string][] = [
  ['通过', '不通过'],
  ['是', '否'],
  ['正确', '不正确'],
  ['正确', '错误'],
  ['平衡', '不平衡'],
  ['有', '无'],
  ['同意', '不同意'],
  ['同意', '驳回'],
  ['合格', '不合格'],
  ['符合', '不符合'],
  ['需要', '不需要'],
  ['达标', '未达标'],
  ['一致', '不一致'],
  ['完成', '未完成'],
  ['齐全', '不齐全'],
  ['对', '错'],
  ['可以', '不可以'],
  ['支持', '不支持'],
  ['满足', '不满足'],
  ['有效', '无效'],
];

/** 两条出边文字恰好构成一对判断词 → 判为 decision */
function isDecisionLabels(labels: string[]): boolean {
  if (labels.length !== 2) return false;
  const a = labels[0].trim();
  const b = labels[1].trim();
  if (!a || !b) return false;
  return PAIR_WORDS.some(([p, n]) => (a === p && b === n) || (a === n && b === p));
}

/** 判断一段 HTML 是否含飞书画板负载（只做廉价的子串检查，供粘贴事件快速过滤） */
export function isFeishuWhiteboardHtml(html: string | undefined | null): boolean {
  return typeof html === 'string' && html.length > 0 && html.includes(MARKER);
}

/** 取出 base64 负载段
 *  飞书完整格式：--%whiteboard-x--<base64>--whiteboard-x%--（双向包裹）。
 *  有闭合标记就截到闭合标记；没有（部分客户端）就退回引号/标签边界。
 *  最后再按 base64 字符集硬截一次，防止残留字符让 atob 抛错。 */
function extractPayload(html: string): string {
  const at = html.indexOf(MARKER);
  if (at < 0) throw new Error('不是飞书画板数据');
  const start = at + MARKER.length;
  const closing = html.indexOf('--whiteboard-x%', start);
  const stop = closing > start ? closing : html.length;
  const m = html.slice(start, stop).match(/^[A-Za-z0-9+/=_-]+/);
  const payload = m ? m[0] : '';
  if (!payload) throw new Error('剪贴板里的画板数据为空');
  return payload;
}

/** base64 → 文本（兼容 Node/浏览器） */
function decodeBase64(b64: string): string {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const norm = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const bin =
    typeof atob === 'function'
      ? atob(norm)
      : Buffer.from(norm, 'base64').toString('binary');
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0) & 0xff);
  return new TextDecoder('utf-8').decode(bytes);
}

/** 宽容的 URL 解码：非法 % 序列时退回原串（飞书文本里偶发孤立 %） */
function safeDecode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 宽容的 JSON 解析：飞书负载尾部常有多余字节（截断的下一帧），截到最后一个 '}' */
function parseTolerantJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const last = text.lastIndexOf('}');
    if (last > 0) return JSON.parse(text.slice(0, last + 1));
    throw new Error('画板数据无法解析');
  }
}

/** 文本清洗：URL 解码 → 换行/制表折叠为空格 → 压缩空白 */
function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return safeDecode(raw).replace(/\s+/g, ' ').trim();
}

interface FsItem {
  id?: string;
  type?: number;
  info?: Record<string, unknown>;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 图形文本兜底：textV2.text → textV2.contents[] → info.text → 子形状文本 */
function pickShapeText(info: Record<string, unknown>): string {
  const tv = asRecord(info.textV2);
  const direct = cleanText(tv.text);
  if (direct) return direct;
  const contents = asArray(tv.contents);
  for (const c of contents) {
    const t = cleanText(typeof c === 'string' ? c : asRecord(c).text);
    if (t) return t;
  }
  const plain = cleanText(info.text ?? info.title);
  if (plain) return plain;
  /* 组合图形：文本挂在子形状上 */
  const comp = asRecord(info.compositeShape);
  for (const child of asArray(comp.children ?? comp.childShapes ?? comp.shapes)) {
    const t = pickShapeText(asRecord(asRecord(child).info));
    if (t) return t;
  }
  return '';
}

/** 连线端点 id 兜底：objectId → id → parentId */
function pickEndId(end: unknown): string {
  const r = asRecord(end);
  const v = r.objectId ?? r.id ?? r.parentId;
  return typeof v === 'string' ? v : '';
}

/**
 * 解析飞书画板剪贴板 HTML。
 * @throws 不是飞书数据 / 数据为空 / 结构异常 时抛错，调用方需 try-catch
 */
export function parseFeishuWhiteboard(html: string): ImportedGraph {
  const text = safeDecode(decodeBase64(extractPayload(html)));
  const root = asRecord(parseTolerantJson(text));
  const items = Array.isArray(root.data) ? (root.data as FsItem[]) : [];
  if (!items.length) throw new Error('画板里没有可导入的图形');

  /* ---------- 1) 形状 → 节点（先只收，kind 待连线解析后定） ---------- */
  const idMap = new Map<string, string>(); // 飞书 id → 本地 id
  interface Raw {
    id: string;
    label: string;
    diamond: boolean;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const raws: Raw[] = [];

  items.forEach((it) => {
    if (it?.type !== 13) return;
    const info = asRecord(it.info);
    const id = typeof it.id === 'string' ? it.id : '';
    if (!id) return;
    const label = pickShapeText(info);
    const base = asRecord(info.baseV2);
    const localId = `imp-${raws.length + 1}`;
    idMap.set(id, localId);
    raws.push({
      id: localId,
      label,
      diamond: asRecord(info.compositeShape).shapeType === 10,
      x: typeof base.x === 'number' ? base.x : 0,
      y: typeof base.y === 'number' ? base.y : 0,
      w: typeof base.width === 'number' ? base.width : 140,
      h: typeof base.height === 'number' ? base.height : 56,
    });
  });

  if (!raws.length) throw new Error('画板里没有可识别的图形');

  /* ---------- 2) 连线 → 边（按飞书连线 id 去重，保留平行边） ---------- */
  const outLabels = new Map<string, string[]>(); // 本地 id → 出边文字
  const edges: ImportedEdge[] = [];
  const pairCount = new Map<string, number>();
  let labeled = 0;
  let parallel = 0;

  /** 节点原始盒子（画板坐标；baseV2 的 x/y 是左上角）—— 用于把每条线的出/入侧反推回
   * 飞书原画的样子（上游在下 → 下出上进；左右排布 → 右出左进/左出右进）。 */
  const rawBoxById = new Map<string, { x: number; y: number; w: number; h: number }>(
    raws.map((n) => [n.id, n])
  );

  items.forEach((it) => {
    const info = asRecord(it?.info);
    const conn = asRecord(info.connectorV2);
    if (it?.type !== 15 && !conn.startObject && !conn.endObject) return;
    const sId = pickEndId(conn.startObject);
    const tId = pickEndId(conn.endObject);
    const source = idMap.get(sId);
    const target = idMap.get(tId);
    if (!source || !target || source === target) return; // 悬空 / 自环丢弃
    const caps = asArray(asRecord(conn.captions).data);
    const first = caps[0];
    const label = cleanText(asRecord(asRecord(first).textStyle).text);
    const key = `${source}->${target}`;
    const n = (pairCount.get(key) ?? 0) + 1;
    pairCount.set(key, n);
    if (n > 1) parallel += 1;
    if (label) {
      labeled += 1;
      const arr = outLabels.get(source) ?? [];
      arr.push(label);
      outLabels.set(source, arr);
    }
    const bs = rawBoxById.get(source);
    const bt = rawBoxById.get(target);
    const sides = bs && bt ? inferAnchorSides(bs, bt) : null;
    edges.push({
      source,
      target,
      label,
      sourceSide: sides?.source,
      targetSide: sides?.target,
    });
  });

  /* ---------- 3) 定 kind：菱形 → decision；矩形 + 成对判断词 → decision ---------- */
  let decisions = 0;
  let weak = 0;
  const kindOf = (r: Raw): ImportedNode['kind'] => {
    if (r.diamond) return 'decision';
    if (isDecisionLabels(outLabels.get(r.id) ?? [])) return 'decision';
    return 'step';
  };

  /* ---------- 4) 坐标归一化：整体平移到 (PAD, PAD)，保持相对位置 ----------
     不能照搬飞书坐标：飞书原画节点是 106~160 宽 × 73~131 高（接近方形），
     而我们的流程卡片是 ≤216 宽 × 46~53 高（更宽更矮）。
     直接套用的话，水平方向卡片会互相压住，垂直方向又空得过头 ——
     这就是「节点重叠 / 整体比例失真」的来源。
     所以这里按「中心点 + 卡片尺寸比例」做分轴缩放：
       横向放大（我们更宽，需要更多水平间距）、纵向压缩（我们更矮，不需要那么多），
     目的是保住飞书的相对布局与走向，同时用我们自己的卡片尺寸排布、不重叠。 */
  const avgFW = raws.reduce((s, n) => s + n.w, 0) / (raws.length || 1);
  const avgFH = raws.reduce((s, n) => s + n.h, 0) / (raws.length || 1);
  const ourSize = new Map(raws.map((n) => [n.id, flowCardSize(n.label)]));
  const avgOW =
    [...ourSize.values()].reduce((s, z) => s + z.w, 0) / (ourSize.size || 1);
  const avgOH =
    [...ourSize.values()].reduce((s, z) => s + z.h, 0) / (ourSize.size || 1);
  const kx = Math.min(2.4, Math.max(1, avgOW / (avgFW || 1)));
  const ky = Math.min(1.8, Math.max(0.55, avgOH / (avgFH || 1)));

  const minCX = Math.min(...raws.map((n) => n.x + n.w / 2));
  const minCY = Math.min(...raws.map((n) => n.y + n.h / 2));
  /* 先按缩放后的中心点落位，再整体把左上角贴回 PAD。
     不能只减「自己的半高」就当左上角 —— 节点高度不一样时，
     中心最小的那个节点未必是左上角最小的那个（会出现负坐标）。 */
  const placed = raws.map((n) => {
    const os = ourSize.get(n.id) ?? { w: 180, h: 46 };
    return {
      x: (n.x + n.w / 2 - minCX) * kx - os.w / 2,
      y: (n.y + n.h / 2 - minCY) * ky - os.h / 2,
    };
  });
  const minPX = Math.min(...placed.map((p) => p.x));
  const minPY = Math.min(...placed.map((p) => p.y));
  const nodes: ImportedNode[] = raws.map((n, i) => {
    const kind = kindOf(n);
    if (kind === 'decision') {
      decisions += 1;
      if ((outLabels.get(n.id) ?? []).length < 2) weak += 1;
    }
    return {
      id: n.id,
      label: n.label,
      kind,
      x: Math.round(placed[i].x - minPX + PAD),
      y: Math.round(placed[i].y - minPY + PAD),
      w: Math.round(n.w),
      h: Math.round(n.h),
    };
  });

  return {
    nodes,
    edges,
    stats: { nodes: nodes.length, edges: edges.length, decisions, labeled, parallel, weak },
  };
}
