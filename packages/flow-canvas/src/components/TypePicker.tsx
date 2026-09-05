/** 新建节点类型选择器（US-01）：步骤 / 决策 / 开始 / 结束
 *  fixed 定位（视口坐标），由 App 层 createPortal 到 body 渲染，避开 RF transform 容器 */
import { useEffect, useRef, type CSSProperties } from 'react';
import type { NodeKind } from '@flow/core';
import { KIND_OPTIONS } from '../appearance';

export interface TypePickerProps {
  /** 视口坐标（clientX/Y） */
  x: number;
  y: number;
  /** 全图是否已有 start/end（限制至多 1 个） */
  hasStart: boolean;
  hasEnd: boolean;
  onPick: (kind: NodeKind) => void;
  onClose: () => void;
}

export function TypePicker({ x, y, hasStart, hasEnd, onPick, onClose }: TypePickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [onClose]);

  // 超出视口右侧/底部时往回收
  const style: CSSProperties = { left: x, top: y };
  if (x > window.innerWidth - 220) style.left = x - 200;
  if (y > window.innerHeight - 190) style.top = y - 176;

  return (
    <div ref={ref} className="type-picker" style={style} data-testid="type-picker">
      <div className="tp-title">新建节点</div>
      {KIND_OPTIONS.map((opt) => {
        const banned = (opt.kind === 'io-start' && hasStart) || (opt.kind === 'io-end' && hasEnd);
        return (
          <button
            key={opt.kind}
            className="tp-item"
            disabled={banned}
            title={banned ? `全图至多 1 个${opt.label}` : opt.desc}
            onClick={() => {
              if (!banned) onPick(opt.kind);
            }}
          >
            <span className={`tp-dot k-${opt.kind}`} />
            <span className="tp-label">{opt.label}</span>
            <span className="tp-desc">{opt.desc}</span>
          </button>
        );
      })}
    </div>
  );
}
