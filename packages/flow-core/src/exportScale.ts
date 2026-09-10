/**
 * exportScale.ts — 导出分辨率规划（0922 高清导出）
 *
 * 旧实现的病根：把任何尺寸的图都塞进「长边固定像素」的画布（PNG 2400 / GIF 1600）。
 * 50～70 节点的大图 bounds 动辄 8000～10000px，于是缩放比被压到 0.1～0.3，
 * 13px 的节点正文被渲染成 2～4 个物理像素 —— 无论怎么提高画质都是一团糊。
 *
 * 新原则（用户拍板：不在乎文件体积，只要清晰）：
 *   ① 布局尺寸 = 内容原始尺寸（flow 坐标 1:1，不再整体缩小）；
 *   ② 输出像素 = 布局尺寸 × 超采样倍率 ratio（默认 2，即 2 倍像素）；
 *   ③ 只有在会撞到浏览器画布硬上限（长边 / 总像素）时才回退倍率。
 *
 * 这样输出图里的物理字号 = baseFont × zoom × ratio ≈ 13 × ratio，
 * 与屏幕上 100% 观感一致甚至更锐利，放大看每个字都是清晰的。
 */

export interface SizePlanInput {
  /** 内容包围盒宽（flow 坐标，含 padding 前的真实内容） */
  boundsW: number;
  /** 内容包围盒高 */
  boundsH: number;
  /** 四周留白：相对内容尺寸的「总」比例（0.12 = 每边 6%） */
  pad?: number;
  /** 画布上节点正文的基准字号（CSS px，flow 坐标系下约 13） */
  baseFont?: number;
  /** 期望超采样倍率（1 = 与画布同尺寸，2 = 两倍像素） */
  ratio?: number;
  /** 输出最长边硬上限（浏览器画布限制） */
  maxSide?: number;
  /** 输出总像素硬上限（避免 OOM） */
  maxPixels?: number;
  /** 输出最短边下限（极扁/极瘦的图也留个体面尺寸） */
  minSide?: number;
}

export interface SizePlan {
  /** 布局尺寸（CSS px，喂给 html-to-image 的 width/height） */
  cssW: number;
  cssH: number;
  /** 实际采用的超采样倍率 */
  ratio: number;
  /** 最终输出像素 */
  outW: number;
  outH: number;
  /** flow → CSS 的视口缩放（正常恒为 1） */
  zoom: number;
  /** 输出图里节点正文的物理字号估计（px） */
  fontPx: number;
  /** 采用的留白比例（回传给 getViewportForBounds） */
  pad: number;
}

/** PNG：静态图，尽量给足像素（默认 2× → 正文约 26px） */
export const PNG_PRESET: Required<Omit<SizePlanInput, 'boundsW' | 'boundsH'>> = {
  pad: 0.12,
  baseFont: 13,
  ratio: 2,
  maxSide: 13000,
  maxPixels: 60_000_000,
  minSide: 480,
};

/** GIF：逐帧编码，像素预算比 PNG 保守，但仍是旧版（≈1.3MP）的十几倍 */
export const GIF_PRESET: Required<Omit<SizePlanInput, 'boundsW' | 'boundsH'>> = {
  pad: 0.1,
  baseFont: 13,
  ratio: 2,
  maxSide: 9000,
  maxPixels: 24_000_000,
  minSide: 320,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 规划导出分辨率。纯函数、无 DOM 依赖（可单测）。
 *
 * 不变量：
 *   · zoom ≈ 1（除非被 minSide 撑大）—— 内容永远 1:1 布局，不整体缩小；
 *   · ratio ≤ 期望倍率，且受 maxSide / maxPixels 双重夹；
 *   · outW/outH ≥ 1，即使输入是 0。
 */
export function planExportSize(input: SizePlanInput, preset = PNG_PRESET): SizePlan {
  const pad = clamp(input.pad ?? preset.pad, 0, 0.5);
  const baseFont = input.baseFont ?? preset.baseFont;
  const want = Math.max(1, input.ratio ?? preset.ratio);
  const maxSide = input.maxSide ?? preset.maxSide;
  const maxPixels = input.maxPixels ?? preset.maxPixels;
  const minSide = Math.max(1, input.minSide ?? preset.minSide);

  const bw = Math.max(1, input.boundsW);
  const bh = Math.max(1, input.boundsH);

  /* ① 布局尺寸 = 内容原始尺寸 × (1 + pad) */
  const cssW = Math.max(minSide, Math.round(bw * (1 + pad)));
  const cssH = Math.max(minSide, Math.round(bh * (1 + pad)));

  /* ② flow → CSS 的缩放（内容 1:1 时恒为 1，小图被 minSide 撑大时 >1） */
  const zoom = clamp(Math.min(cssW / (bw * (1 + pad)), cssH / (bh * (1 + pad))), 0.01, 4);

  /* ③ 超采样倍率：期望值 + 两道硬上限夹取。
   *  上限是硬的 —— 突破浏览器画布上限会直接 OOM / 导出失败，宁可少一点像素。 */
  let ratio = want;
  ratio = Math.min(ratio, maxSide / Math.max(cssW, cssH));
  ratio = Math.min(ratio, Math.sqrt(maxPixels / (cssW * cssH)));
  ratio = Math.max(ratio, 0.0005); // 防御性：输入极端时不至于算出 0

  const outW = Math.max(1, Math.round(cssW * ratio));
  const outH = Math.max(1, Math.round(cssH * ratio));

  return {
    cssW,
    cssH,
    ratio,
    outW,
    outH,
    zoom,
    fontPx: baseFont * zoom * ratio,
    pad,
  };
}
