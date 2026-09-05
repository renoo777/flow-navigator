/** 双击进入编辑 → 原地 textarea（Enter/失焦保存 · Esc 取消 · 空值拒绝还原）*/
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { SopFlowNode } from './SopNode';

export function NodeLabelEditor({
  nodeId,
  initial,
  onDone,
}: {
  nodeId: string;
  initial: string;
  onDone: () => void;
}) {
  const { updateNodeData } = useReactFlow<SopFlowNode>();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
      el.style.width = `${Math.min(300, Math.max(60, initial.length * 15 + 30))}px`;
    }
  }, [initial]);

  const commit = useCallback(() => {
    const v = text.trim();
    if (v) updateNodeData(nodeId, { label: v });
    onDone();
  }, [text, nodeId, updateNodeData, onDone]);

  return (
    <textarea
      ref={ref}
      className="node-label-editor"
      value={text}
      rows={1}
      aria-label="节点名称"
      onChange={(e) => {
        setText(e.target.value);
        e.target.style.width = `${Math.min(300, Math.max(60, e.target.value.length * 15 + 30))}px`;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone();
        }
      }}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
