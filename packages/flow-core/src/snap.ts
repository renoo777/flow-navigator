/** 拖拽吸附（Build L）—— 纯函数，画参考线与位置吸附共用同一份计算。
 *  为什么吸附必须做在 onNodesChange 入口：受控模式下 RF 的拖拽引擎每次
 *  pointer move 都会用「起点 + 累计位移」重算位置，任何中途写进 store 的
 *  修正都会被下一次 change 覆盖；只有拦在 change 入口改 position 才留得住。 */

export interface SnapBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  /** 命中的竖直参考线（x 坐标，flow 单位） */
  vLines: number[];
  /** 命中的水平参考线（y 坐标，flow 单位） */
  hLines: number[];
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, vLines: [], hLines: [] };

/** 拖动组（用第一个节点做锚）的 左/中/右 × 上/中/下 六条轴，
 *  与其他节点的三条轴比对，取最近的命中（|d| < tol）作为整组吸附量。 */
export function computeSnap(
  dragging: SnapBox[],
  others: SnapBox[],
  tol = 5
): SnapResult {
  if (!dragging.length || !others.length) return NO_SNAP;
  const a = dragging[0];
  const axs = [a.x, a.x + a.w / 2, a.x + a.w];
  const ays = [a.y, a.y + a.h / 2, a.y + a.h];

  const vLines = new Set<number>();
  const hLines = new Set<number>();
  let dx = 0;
  let dy = 0;
  let bestX = tol;
  let bestY = tol;

  for (const o of others) {
    const oxs = [o.x, o.x + o.w / 2, o.x + o.w];
    const oys = [o.y, o.y + o.h / 2, o.y + o.h];
    for (const t of oxs) {
      for (const f of axs) {
        const d = t - f;
        const ad = Math.abs(d);
        if (ad < bestX) {
          bestX = ad;
          dx = d;
          vLines.add(t);
        }
      }
    }
    for (const t of oys) {
      for (const f of ays) {
        const d = t - f;
        const ad = Math.abs(d);
        if (ad < bestY) {
          bestY = ad;
          dy = d;
          hLines.add(t);
        }
      }
    }
  }
  return { dx, dy, vLines: [...vLines], hLines: [...hLines] };
}
