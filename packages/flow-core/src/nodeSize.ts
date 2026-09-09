/** 流程视图卡片尺寸规则（估算值必须与 CSS 实际渲染一致）
 *
 * ## 为什么要单独一个模块
 * 同一套尺寸被三处消费：dagre 自动布局、飞书导入的智能重排、连线自动选边。
 * 之前 engine.ts 的 estimateNodeSize 与 reflow.ts 的 sizeOf 各写一份公式，
 * 一旦改样式就会对不上 —— 布局按小值排、实际渲染更宽，节点直接压在一起。
 * 现在收敛到本模块，两处共用。
 *
 * ## 为什么要「长文本换行增高」而不是无限拉宽
 * 早期 .sop-label 是 white-space: nowrap，卡片宽度随字数线性增长、高度固定 46px，
 * 于是长标签会把卡片拉成 300+ × 46 的长条（宽高比 6.5:1）。两个后果：
 *  ① 与飞书画板卡片（实测平均 134×97，宽高比 1.39）形状差异巨大，
 *     自动选边的射线法在扁盒子上更容易先撞上下边，把「侧边连侧边」误判成上下连线；
 *  ② 估算值封顶 300 而 CSS 无上限，长标签实际比估算宽，重排后互相压住。
 * 现在给宽度设上限、超出就换行增高，宽高比收敛到 2.7~4.8，两个问题一起缓解。
 *
 * 三个常量与 style.css 的 .sop-node[data-view='flow'] 一一对应，改样式请同步改这里。
 */

/** 卡片最大宽度（对应 CSS max-width） */
export const FLOW_W_MAX = 216;
/** 卡片最小宽度（对应 CSS min-width） */
export const FLOW_W_MIN = 148;
/** 单行卡片高度（padding + 一行文字 + 边框 + 余量） */
export const FLOW_H_BASE = 46;
/** 每多一行增加的高度（13px 字号 × line-height 1.35 ≈ 17.6，取整 18） */
export const FLOW_LINE_H = 18;
/** 标签以外的固定占用：rail 4 + 左右 padding 24 + gap 7 + kind 小标 ~30 + 余量 ~11 */
export const FLOW_CHROME = 76;
/** 13px 字号下一个汉字的宽度 */
export const FLOW_CHAR_W = 13;

/**
 * 按每行字数硬折行（点1 自定义换行 B 规则）：
 * 先尊重文本里已有的 \n（手动换行 A 规则），再对每个超长段按 cols 个字（码点）切开。
 * cols 缺失 / <2 → 原文返回。显示与尺寸估算共用，保证两处永远一致。
 */
export function wrapByCols(label: string, cols?: number): string {
  const n =
    typeof cols === 'number' && Number.isFinite(cols) && cols >= 2 ? Math.floor(cols) : 0;
  if (!n) return label ?? '';
  return (label ?? '')
    .split('\n')
    .map((seg) => {
      const chars = [...seg];
      const out: string[] = [];
      for (let i = 0; i < chars.length; i += n) out.push(chars.slice(i, i + n).join(''));
      return out.join('\n');
    })
    .join('\n');
}

/**
 * 按标签长度算卡片尺寸：短标签单行撑宽，长标签到顶换行增高。
 * 点1 自定义换行：label 里已有 \n（手动换行）或 wrapCols（每行 N 字）时，
 * 以「最长一行」定宽、行数定高 —— 与 CSS pre-wrap 渲染一致。
 * @param label 节点标题（按字符数计，不是字节数）
 * @param wrapCols 每行字数（节点 data.wrapCols；缺省 = 不启用字数规则）
 */
export function flowCardSize(label: string, wrapCols?: number): { w: number; h: number } {
  const lines = wrapByCols(label ?? '', wrapCols).split('\n');
  if (lines.length > 1) {
    const longest = Math.max(...lines.map((l) => [...l].length));
    const w = Math.min(FLOW_W_MAX, Math.max(FLOW_W_MIN, longest * FLOW_CHAR_W + FLOW_CHROME));
    return { w, h: FLOW_H_BASE + (lines.length - 1) * FLOW_LINE_H };
  }
  const len = [...(label ?? '')].length;
  const oneLine = len * FLOW_CHAR_W + FLOW_CHROME;
  if (oneLine <= FLOW_W_MAX) {
    return { w: Math.max(FLOW_W_MIN, oneLine), h: FLOW_H_BASE };
  }
  const perLine = Math.max(4, Math.floor((FLOW_W_MAX - FLOW_CHROME) / FLOW_CHAR_W));
  const rows = Math.ceil(len / perLine);
  return { w: FLOW_W_MAX, h: FLOW_H_BASE + (rows - 1) * FLOW_LINE_H };
}
