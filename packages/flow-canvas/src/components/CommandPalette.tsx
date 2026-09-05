/** 命令面板（Build L）：Linear/Raycast 同款 —— 一个入口执行全部动作 + 跳转节点。
 *  动作由 App 组装注入（commands），节点跳转由画布自动生成；
 *  选中项用「跟随光条」平滑滑动（translate + spring），不做逐项重渲染闪烁。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface CommandItem {
  id: string;
  title: string;
  /** 分组名：动作 / 视图 / 导出 / 节点 … */
  group: string;
  /** 右侧快捷键提示（纯展示） */
  hint?: string;
  /** 额外匹配词（如拼音、英文别名） */
  keywords?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  items: CommandItem[];
  onClose: () => void;
}

export function CommandPalette({ items, onClose }: CommandPaletteProps) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const query = q.trim().toLowerCase();
  const filtered = query
    ? items.filter(
        (it) =>
          it.title.toLowerCase().includes(query) ||
          it.group.toLowerCase().includes(query) ||
          (it.keywords ?? '').toLowerCase().includes(query)
      )
    : items;
  const safeIdx = filtered.length ? Math.min(idx, filtered.length - 1) : 0;
  const cur = filtered[safeIdx];

  /* 查询/结果变化时把选中项滚进视野，并把光条滑到该项（DOM 实测 offsetTop，
     因为列表里穿插分组标题，不能用 idx × 定高去算） */
  const [sliderY, setSliderY] = useState(0);
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector('.cp-item.on') as HTMLElement | null;
    if (el) setSliderY(el.offsetTop);
    listRef.current
      ?.querySelector('.cp-item.on')
      ?.scrollIntoView({ block: 'nearest' });
  }, [safeIdx, filtered.length, q]);

  const move = (d: number) => {
    if (!filtered.length) return;
    setIdx((i) => (i + d + filtered.length) % filtered.length);
  };

  return (
    <div className="cmd-palette" data-testid="cmd-palette" role="dialog" aria-label="命令面板">
      <div className="cp-search">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="cs-icon">
          <circle cx="6.5" cy="6.5" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <line x1="10.2" y1="10.2" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className="cs-input"
          value={q}
          placeholder="输入命令或节点名…（↑↓ 选择，Enter 执行）"
          aria-label="命令关键词"
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey && e.altKey)) {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (cur) {
                cur.run();
                onClose();
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <span className="cs-count">{filtered.length ? `${safeIdx + 1}/${filtered.length}` : '0'}</span>
      </div>
      <div className="cp-list" ref={listRef}>
        {filtered.length === 0 && <div className="cp-empty">没有匹配的命令</div>}
        {/* 跟随光条：绝对定位 + spring 滑动，比逐项换背景更顺滑 */}
        {filtered.length > 0 && (
          <div
            className="cp-slider"
            style={{ translate: `0 ${sliderY}px` }}
            aria-hidden="true"
          />
        )}
        {filtered.map((it, i) => {
          const prevGroup = i > 0 ? filtered[i - 1].group : null;
          const showGroup = it.group !== prevGroup;
          return (
            <div key={it.id}>
              {showGroup && <div className="cp-group">{it.group}</div>}
              <button
                className={`cp-item ${i === safeIdx ? 'on' : ''}`}
                data-testid={`cmd-${it.id}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => {
                  it.run();
                  onClose();
                }}
              >
                <span className="cpi-title">{it.title}</span>
                {it.hint && <span className="cpi-hint">{it.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
      <div className="cp-foot">
        <span>↑↓ 选择</span>
        <span>Enter 执行</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
}
