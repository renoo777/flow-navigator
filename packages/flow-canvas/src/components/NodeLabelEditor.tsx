/** 双击进入编辑 → 就地编辑（contenteditable 复用 .sop-label 的全部排版）
 *
 * 设计要点（对标飞书画板「双击图形进入文本编辑模式，文本超过文本框长度会自动换行」）：
 * 编辑态复用的就是非编辑态那个 .sop-label —— 同一套 font / line-height / text-align /
 * 换行规则 / max-width，所以点进去的瞬间尺寸、字形、折行位置完全不变，只是多了光标
 * 和一圈极细的高亮框。编辑时继续打字，框随文字撑高，跟飞书一致。
 *
 * 这里刻意不用 <textarea>：textarea 需要 JS 现算宽度与行数，跟卡片的真实排版永远对不齐
 * （旧实现的症状就是「双击后变成一个很小的单行框，长话术根本改不了」）。 */
import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { SopFlowNode } from './SopNode';

export function NodeLabelEditor({
  nodeId,
  initial,
  onDone,
  caret,
}: {
  nodeId: string;
  initial: string;
  onDone: () => void;
  /** 双击进入时的屏幕坐标：把光标放到这里而不是全选（只改两个字不必整段重敲） */
  caret?: { x: number; y: number } | null;
}) {
  const { updateNodeData } = useReactFlow<SopFlowNode>();
  const ref = useRef<HTMLSpanElement>(null);

  /* 只在进入编辑时灌一次初始值：之后内容由浏览器自己管，
     不经过 React 重渲染（否则受控更新会把光标顶回开头）。
     光标策略：优先放到双击处（改了中间两个字就不用整段重敲），
     双击位置落在编辑层外则退回「光标放末尾」。

     用 rAF 包一层：React StrictMode 会 mount→unmount→mount 双调用 effect，
     第一次 focus 完立刻被卸载，浏览器焦点丢失；rAF 等 React 这次 commit 真正落幕
     后再 focus，躲过 StrictMode 干扰。 */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initial;
    const raf = requestAnimationFrame(() => {
      const e2 = ref.current;
      if (!e2) return;
      e2.focus();
      const sel = window.getSelection();
      sel?.removeAllRanges();
      let placed = false;
      if (caret) {
        const r = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
          .caretRangeFromPoint?.(caret.x, caret.y);
        if (r && e2.contains(r.startContainer)) {
          sel?.addRange(r);
          placed = true;
        }
      }
      if (!placed) {
        const range = document.createRange();
        range.selectNodeContents(e2);
        range.collapse(false); // 光标放末尾
        sel?.addRange(range);
      }
    });
    return () => cancelAnimationFrame(raf);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const commit = useCallback(() => {
    const v = (ref.current?.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .trim();
    if (v) updateNodeData(nodeId, { label: v });
    onDone();
  }, [nodeId, updateNodeData, onDone]);

  return (
    <span
      ref={ref}
      className="sop-label node-label-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="节点名称"
      spellCheck={false}
      data-testid="node-label-editor"
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
      onPaste={(e) => {
        /* 只吃纯文本，避免把飞书/网页的富文本格式带进来 */
        e.preventDefault();
        const t = e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ');
        document.execCommand('insertText', false, t);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
