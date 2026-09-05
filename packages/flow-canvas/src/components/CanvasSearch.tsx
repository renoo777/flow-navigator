/** 画布搜索浮层（Build K-④）：Ctrl/Cmd+F 呼出，按节点名 / 类型 / 话术检索并定位。
 *  交互对标 Figma：输入即时过滤，250ms 防抖后自动飞向第一项；↑↓/Enter 换项；Esc 关闭。 */
import { useEffect, useRef } from 'react';
import type { SearchHit } from '@flow/core';

export interface CanvasSearchProps {
  query: string;
  hits: SearchHit[];
  activeId: string | null;
  onQuery: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onPick: (id: string, idx: number) => void;
  onClose: () => void;
}

export function CanvasSearch({
  query,
  hits,
  activeId,
  onQuery,
  onNext,
  onPrev,
  onPick,
  onClose,
}: CanvasSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* 呼出时聚焦输入框；结果变化时把当前项滚进视野 */
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const el = listRef.current?.querySelector('.cs-item.on');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  return (
    <div className="canvas-search" data-testid="canvas-search" role="search" aria-label="搜索节点">
      <svg className="cs-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="10.2" y1="10.2" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        className="cs-input"
        value={query}
        placeholder="搜索节点 / 类型 / 话术…"
        aria-label="搜索关键词"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            onNext();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            onPrev();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="cs-count" data-testid="search-count">
        {hits.length ? `${hits.findIndex((h) => h.id === activeId) + 1 || 1}/${hits.length}` : query.trim() ? '0/0' : ''}
      </span>
      <button className="cs-nav" title="上一项（Shift+Enter）" aria-label="上一项" onClick={onPrev}>
        ↑
      </button>
      <button className="cs-nav" title="下一项（Enter）" aria-label="下一项" onClick={onNext}>
        ↓
      </button>
      <button className="cs-x" title="关闭（Esc）" aria-label="关闭搜索" onClick={onClose}>
        ✕
      </button>
      {hits.length > 0 && (
        <div className="cs-list" ref={listRef}>
          {hits.map((h, i) => (
            <button
              key={h.id}
              className={`cs-item ${h.id === activeId ? 'on' : ''}`}
              onClick={() => onPick(h.id, i)}
            >
              <span className="csi-label">{h.label || '（未命名）'}</span>
              <span className="csi-where">{h.where}</span>
              {h.snippet && <span className="csi-snip">{h.snippet}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
