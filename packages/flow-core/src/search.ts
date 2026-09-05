/** 画布搜索（Build K-④）—— 纯函数，便于单测。
 *  检索范围：节点名 > 类型名 > 话术内容；不区分大小写；空串返回空。 */

export interface SearchableNode {
  id: string;
  label?: string;
  kind?: string;
  talk?: { text?: string }[];
}

export interface SearchHit {
  id: string;
  label: string;
  /** 命中来源：「节点名」/「类型」/「话术」 */
  where: string;
  /** 话术命中时的片段预览 */
  snippet?: string;
}

/** kind -> 展示名（与画布 KIND_TAG 一致；由调用方传入避免反向依赖） */
export type KindLabel = (kind: string) => string;

export function searchNodes(
  nodes: SearchableNode[],
  query: string,
  kindLabel?: KindLabel
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const n of nodes) {
    const label = (n.label ?? '').trim();
    if (label.toLowerCase().includes(q)) {
      hits.push({ id: n.id, label, where: '节点名' });
      continue;
    }
    const kindName = n.kind ? (kindLabel?.(n.kind) ?? '') : '';
    if (kindName && kindName.toLowerCase().includes(q)) {
      hits.push({ id: n.id, label, where: '类型', snippet: kindName });
      continue;
    }
    const t = (n.talk ?? []).find((x) => (x.text ?? '').toLowerCase().includes(q));
    if (t) {
      const text = (t.text ?? '').trim();
      const at = text.toLowerCase().indexOf(q);
      const start = Math.max(0, Math.min(at - 6, text.length - 24));
      const snippet = (start > 0 ? '…' : '') + text.slice(start, start + 24) + (start + 24 < text.length ? '…' : '');
      hits.push({ id: n.id, label, where: '话术', snippet });
    }
  }
  return hits;
}
