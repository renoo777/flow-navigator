/**
 * SegmentedControl —— Apple Liquid Glass 风格分段控件（Build M）
 *
 * 依据 WWDC25 session 284《Build a UIKit app with the new design》：
 *  - "segmentedControl thumbs … liquid glass appearance for interactions"
 *  - "sliders preserve momentum and **stretch** when they are moved"
 *  - Liquid Glass 不靠淡入淡出显形，而是靠形变位移
 *
 * 实现要点：
 *  1. 层次相反：容器是**磨砂玻璃**（blur+saturate），滑块是**高透玻璃**（无 blur）。
 *     官方说法：切换中的按钮是「一块高透玻璃，而非磨砂玻璃」。
 *  2. FLIP 位移：useLayoutEffect 实测激活项的 offsetLeft/offsetWidth 写入 CSS 变量，
 *     只动 translate（合成线程），绝不动画 left/width（触发布局抖动）。
 *  3. squash & stretch：位移的同时叠加关键帧——移动中沿运动轴拉伸、到站挤压回弹，
 *     这是「水滴感」的来源。用独立变换属性 scale，与 translate 互不覆盖。
 *  4. 双层结构：外层只管位移（transition，不可重挂载否则丢起点）；
 *     内层 key={beat} 重挂载来重播拉伸关键帧。二者叠加 = 边滑边拉。
 *  5. 首帧无动画：初次挂载直接就位，避免从 0 位置滑过来。
 *  6. DOM 契约：button 的顺序/数量保持不变（既有探针按 .seg button 索引定位）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface SegOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  /** sm = 视图切换（结构层/话术层）等次级分组 */
  size?: 'md' | 'sm';
  /** 无障碍标签，同时用于测试定位 */
  ariaLabel: string;
  testId?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  ariaLabel,
  testId,
  className = '',
}: SegmentedControlProps<T>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** 滑块几何（px）；null = 尚未测量 */
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  /** 拉伸相位：每次切换 +1 → 内层重挂载 → 重播 squash&stretch 关键帧 */
  const [beat, setBeat] = useState(0);
  const prevIdx = useRef<number>(-1);
  /** 移动格数：决定拉伸幅度（跨 2 格比跨 1 格拉得更长） */
  const [travel, setTravel] = useState(0);

  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  /** 选项签名：readonly 切换会让 options 整体换血（编辑画布→查看），须触发重测 */
  const sig = options.map((o) => o.value).join('|');

  /** 实测激活项几何（FLIP 的 First/Last 都取真实布局值，不猜） */
  const measure = useCallback(() => {
    const el = btnRefs.current[idx];
    if (!el) return;
    const x = el.offsetLeft;
    const w = el.offsetWidth;
    setBox((prev) => (prev && prev.x === x && prev.w === w ? prev : { x, w }));
  }, [idx]);

  useLayoutEffect(measure, [measure, sig]);

  /** 容器尺寸变化（Dock 宽度变化 / 字体加载）→ 重测，避免滑块错位 */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  /**
   * 切换时触发水滴拉伸。
   * 顺序很关键：先无条件把 prevIdx 推进到当前 idx，再判断是否放动画。
   * 若按「box 是否已测量」提前 return，首帧会漏掉记录，导致第一次切换放不出动画。
   */
  useLayoutEffect(() => {
    const prev = prevIdx.current;
    prevIdx.current = idx;
    if (prev === -1 || prev === idx) return; // 首帧 or 索引未变 → 不放动画
    setTravel(Math.abs(idx - prev));
    setBeat((b) => b + 1);
  }, [idx]);

  return (
    <div
      ref={wrapRef}
      className={`seg glass-seg ${size === 'sm' ? 'sm' : ''} ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      data-travel={travel}
    >
      {/* 外层：只做位移（translate transition） */}
      <span
        className="seg-thumb"
        aria-hidden="true"
        style={
          box
            ? ({
                '--seg-x': `${box.x}px`,
                '--seg-w': `${box.w}px`,
                '--seg-travel': travel,
              } as React.CSSProperties)
            : undefined
        }
      >
        {/* 内层：只做拉伸（key 变化 → 重挂载 → 关键帧重播） */}
        <span className="seg-drop" key={beat} data-beat={beat} />
      </span>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          type="button"
          className={o.value === value ? 'on' : ''}
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
