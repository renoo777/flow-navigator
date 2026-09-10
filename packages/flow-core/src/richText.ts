/**
 * richText.ts — 0920 标题富文本引擎（flow-core 纯函数，零 UI 依赖）
 *
 * 数据结构：`RichSegment[]` —— 每段连续文字带自己的样式。
 *
 * 存储约定（非常重要）：
 *   · `label` 始终是**唯一数据真相**——搜索、尺寸估算、飞书往返、复制粘贴、
 *     GIF/PNG 导出全部只读 label，因此引入富文本后它们**一个都不用改**。
 *   · `labelSegments` 只有渲染层消费；缺省或缺失 → 按纯文本渲染（行为与旧版完全一致）。
 *   · `segmentsToPlain(segments)` 必须等于 label；不等就说明 label 被别处改过
 *     （例如结构层 plaintext-only 就地编辑），此时**降级回纯文本**，样式失效但绝不错位。
 *
 * 算法：先把 segments 摊平成「字符级」格子（每字符继承所在段样式），按 [start,end)
 * 施加样式后，再按相邻同样式合并回片段。摊平 + 合并让「跨片段选中」「间隔选中」
 * 都自动正确，不需要手写切片拼接。
 */
import type { RichSegment } from './types';

interface Cell {
  ch: string;
  bold: boolean;
  color?: string;
}

/** segments → 纯文本（应与 label 相等） */
export function segmentsToPlain(segs: RichSegment[] | undefined | null): string {
  if (!segs || segs.length === 0) return '';
  return segs.map((s) => s.text ?? '').join('');
}

/** 纯文本 → 单片段 */
export function plainToSegments(text: string): RichSegment[] {
  return text ? [{ text }] : [];
}

/**
 * 决定实际渲染用什么片段：
 * label 与 segments 不一致时（label 被别处改过）降级回纯文本，避免样式错位。
 */
export function resolveRenderSegments(label: string, segs?: RichSegment[] | null): RichSegment[] {
  if (!segs || segs.length === 0) return plainToSegments(label ?? '');
  if (segmentsToPlain(segs) !== (label ?? '')) return plainToSegments(label ?? '');
  return segs;
}

function flatten(segs: RichSegment[]): Cell[] {
  const cells: Cell[] = [];
  for (const s of segs ?? []) {
    for (const ch of s?.text ?? '') {
      cells.push({ ch, bold: !!s.bold, color: s.color });
    }
  }
  return cells;
}

/** 合并相邻同样式字符回片段；顺带丢弃空片段 */
function merge(cells: Cell[]): RichSegment[] {
  const out: RichSegment[] = [];
  for (const c of cells) {
    const last = out[out.length - 1];
    if (last && !!last.bold === c.bold && (last.color ?? undefined) === (c.color ?? undefined)) {
      last.text += c.ch;
    } else {
      const seg: RichSegment = { text: c.ch };
      if (c.bold) seg.bold = true;
      if (c.color) seg.color = c.color;
      out.push(seg);
    }
  }
  return out;
}

function normalizeRange(total: number, start: number, end: number): { s: number; e: number } {
  const s = Math.max(0, Math.min(total, Math.floor(start)));
  const e = Math.max(0, Math.min(total, Math.floor(end)));
  return s <= e ? { s, e } : { s: e, e: s };
}

/** 加粗开关：区间内若**全部**已加粗 → 取消；否则 → 整个区间加粗 */
export function toggleBoldInRange(segs: RichSegment[], start: number, end: number): RichSegment[] {
  const cells = flatten(segs);
  const { s, e } = normalizeRange(cells.length, start, end);
  if (s === e) return merge(cells);
  const allBold = cells.slice(s, e).every((c) => c.bold);
  for (let i = s; i < e; i++) cells[i].bold = !allBold;
  return merge(cells);
}

/** 设色：`color` 传 null / 空串表示清除该区间颜色 */
export function setColorInRange(
  segs: RichSegment[],
  start: number,
  end: number,
  color: string | null,
): RichSegment[] {
  const cells = flatten(segs);
  const { s, e } = normalizeRange(cells.length, start, end);
  if (s === e) return merge(cells);
  for (let i = s; i < e; i++) cells[i].color = color || undefined;
  return merge(cells);
}

/** 区间是否全部加粗（工具条高亮态） */
export function isRangeBold(segs: RichSegment[], start: number, end: number): boolean {
  const cells = flatten(segs);
  const { s, e } = normalizeRange(cells.length, start, end);
  if (s === e) return false;
  return cells.slice(s, e).every((c) => c.bold);
}

/** 区间首个颜色（工具条色块激活态）；无色返回 undefined */
export function rangeColor(segs: RichSegment[], start: number, end: number): string | undefined {
  const cells = flatten(segs);
  const { s, e } = normalizeRange(cells.length, start, end);
  if (s === e) return undefined;
  return cells[s].color;
}
