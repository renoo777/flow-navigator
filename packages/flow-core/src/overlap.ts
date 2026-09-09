/**
 * 最小位移防重叠（Bug2 方案 A 配套）：话术层继承结构层坐标后，卡片从 h≈46
 * 变高（rows*40+80），原坐标可能纵向挤压 —— 对 x 投影相交的卡片自上而下
 * 扫描下推，一次到位、绝对收敛，且不动无重叠的卡片，保住
 * 「话术层 = 结构层排版」的直觉。
 *
 * 算法：按 y 排序逐卡落位；对每张卡，回看所有 x 投影相交的已落位卡，
 * 取所需的最大下移（下方留 gap 间隙）一步落位。O(n²) 最坏，流程图节点量级毫秒级。
 */
export interface OverlapBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function resolveOverlaps(
  boxes: OverlapBox[],
  gap = 12
): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const arr = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  arr.forEach((box) => {
    let y = box.y;
    placed.forEach((p, id) => {
      const prev = byId.get(id)!;
      /* x 投影不相交 → 永不重叠，跳过 */
      if (Math.min(box.x + box.w, prev.x + prev.w) - Math.max(box.x, prev.x) <= 0) return;
      /* React Flow 的 position 是左上角（不是中心）：下边卡顶边须 ≥ 上边卡底边 + gap */
      const need = p.y + prev.h + gap;
      if (need > y) y = need;
    });
    placed.set(box.id, { x: box.x, y });
  });
  return placed;
}
