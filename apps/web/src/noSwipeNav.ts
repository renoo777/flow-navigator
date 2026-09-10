/**
 * noSwipeNav.ts — 屏蔽 Mac 触控板「双指左右滑 = 浏览器前进/后退」
 *
 * 现象：Mac 上双指向右滑，浏览器左边缘弹出返回箭头并直接退出当前页面；
 *       向左滑又翻回上一页。换 Chrome / Safari / Edge 都一样。
 *
 * 根因：这是浏览器的 **Overscroll history navigation**（滑动翻页）——
 * 属于「滚动溢出」类系统手势：页面没有可横向滚动的内容时，浏览器把
 * 横向滑动的溢出量解释成「翻上一页 / 下一页」。它不是我们代码的 bug，
 * 但会把正在编辑的流程图整页带走。
 *
 * 为什么光靠 React Flow 不够：
 *   RF 的 panOnScroll 处理器确实会 preventDefault + stopImmediatePropagation，
 *   但只在指针位于画布 pane 上时生效；而且这是浏览器进程级手势，
 *   WebKit 官方 bug 240892 明确记录了 Safari 下 overscroll-behavior 挡不住，
 *   只有对 wheel 事件 preventDefault 才有效。
 *
 * 两层防线（缺一不可）：
 *   ① CSS `overscroll-behavior: none`（style.css）—— 关掉 Chrome/Edge 的
 *      横向滑动翻页、下拉刷新、橡皮筋回弹。
 *   ② 本文件：capture 阶段的**非被动** wheel 监听，横向分量为主时直接
 *      preventDefault。capture 阶段先于任何元素监听器，且只吃掉
 *      「浏览器默认行为」，不影响 React Flow 继续读 deltaX 平移画布。
 *
 * 只拦「横向为主」：全应用没有任何横向滚动区域（所有 overflow 都是 -y: auto），
 * 所以吃掉横向 wheel 不会损失功能；纵向滑动照常滚动 Dock 列表 / 弹窗内容。
 */

/** 判定为「横向滑动」的阈值：横向分量 ≥ 纵向分量 */
function isHorizontal(e: WheelEvent): boolean {
  const dx = Math.abs(e.deltaX);
  const dy = Math.abs(e.deltaY);
  return dx > 0 && dx >= dy;
}

/**
 * 安装守卫。返回卸载函数（StrictMode 双调用 / 热更新都安全）。
 * 被动监听无法 preventDefault —— 必须显式 `passive: false`。
 */
export function installNoSwipeNav(): () => void {
  const onWheel = (e: WheelEvent) => {
    /* 捏合缩放（Mac 触控板会伪造成 ctrlKey）与 Ctrl+滚轮：交给 React Flow 缩放，不拦 */
    if (e.ctrlKey || e.metaKey) return;
    if (!isHorizontal(e)) return;
    e.preventDefault();
  };
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return () => window.removeEventListener('wheel', onWheel, { capture: true });
}
