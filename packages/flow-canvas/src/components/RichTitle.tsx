/**
 * RichTitle.tsx — 0920 标题富文本（渲染 + 话术层就地编辑）
 *
 * 数据约定：`label` 是唯一真相，`labelSegments` 只是渲染层增强。
 *   · 静态态：resolveRenderSegments(label, labelSegments) → 带样式的 span；
 *     label 被别处改过（不一致）自动降级回纯文本，样式绝不错位。
 *   · 编辑态：同一个 span 原地切 contentEditable，不换组件不改布局（沿用
 *     结构层「节点即输入框」的做法），配浮动工具条给选中片段加粗 / 设色。
 *
 * 三个关键工程决策：
 *   1. 零 XSS：paintDom 只用 createElement/createTextNode 重建 DOM，从不碰 innerHTML；
 *      readDom 只读我们自己写进去的 inline style，不解析外部 HTML。
 *   2. 不受控 contenteditable：编辑态 React 不渲染 children（交给 paintDom 管），
 *      避免受控重渲染导致的**光标跳动 / 选区丢失**——这是富文本编辑最常见的坑。
 *   3. Enter 插入真 \n（execCommand insertText）而不是 <div>/<br>，配合 CSS
 *      white-space:pre-wrap 得到真实换行，且纯文本 offset 与 segments 严格对齐。
 *
 * 必须 nodrag nopan：否则 RF 会把 mousedown 认成拖拽起点（同 0920 那个 bug）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Fragment } from 'react';
import {
  resolveRenderSegments,
  segmentsToPlain,
  toggleBoldInRange,
  setColorInRange,
  isRangeBold,
  rangeColor,
  type RichSegment,
} from '@flow/core';

/** 预设色板（与节点 rail 色系一致） */
export const RICH_COLORS = ['#dc2626', '#d97706', '#16a34a', '#2563eb', '#7c3aed'];
const BOLD_W = '600';

/* ─────────────── DOM ⇄ segments ─────────────── */

function readDom(el: HTMLElement): RichSegment[] {
  const segs: RichSegment[] = [];
  const push = (text: string, bold?: boolean, color?: string) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && !!last.bold === !!bold && (last.color ?? '') === (color ?? '')) {
      last.text += text;
      return;
    }
    const s: RichSegment = { text };
    if (bold) s.bold = true;
    if (color) s.color = color;
    segs.push(s);
  };
  const walk = (parent: Node) => {
    parent.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        push(n.textContent ?? '');
        return;
      }
      if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as HTMLElement;
        if (e.tagName === 'BR') {
          push('\n');
          return;
        }
        const fw = e.style.fontWeight;
        push(e.textContent ?? '', fw === BOLD_W || parseInt(fw, 10) >= 600, normColor(e.style.color));
      }
    });
  };
  walk(el);
  return segs;
}

/** 颜色回落成 #rrggbb：浏览器会把 inline style 的 #dc2626 规范化成 rgb(220, 38, 38)，
 *  直接存 rgb 也能渲染，但统一成 hex 更好读、更小，且 store 的清洗守卫只认 hex。 */
function normColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) {
    return (
      '#' +
      [m[1], m[2], m[3]]
        .map((x) => Number(x).toString(16).padStart(2, '0'))
        .join('')
    );
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  return undefined;
}

function paintDom(el: HTMLElement, segs: RichSegment[]): void {
  el.textContent = '';
  for (const s of segs) {
    if (!s.text) continue;
    if (s.bold || s.color) {
      const span = document.createElement('span');
      if (s.bold) span.style.fontWeight = BOLD_W;
      if (s.color) span.style.color = s.color;
      span.textContent = s.text;
      el.appendChild(span);
    } else {
      el.appendChild(document.createTextNode(s.text));
    }
  }
}

/** 选区 → 纯文本 offset（把 <br> 计 1 字符，与 \n 对齐） */
function selOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.commonAncestorContainer)) return null;
  const lenBefore = (node: Node, offset: number) => {
    const pre = document.createRange();
    pre.setStart(root, 0);
    pre.setEnd(node, offset);
    const frag = pre.cloneContents();
    let n = 0;
    const w = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (w.nextNode()) {
      const cur = w.currentNode as Node;
      if (cur.nodeName === 'BR') n += 1;
      else if (cur.nodeType === Node.TEXT_NODE) n += (cur.nodeValue ?? '').length;
    }
    return n;
  };
  const a = lenBefore(r.startContainer, r.startOffset);
  const b = lenBefore(r.endContainer, r.endOffset);
  if (b <= a) return null;
  return { start: a, end: b };
}

/** offset → 恢复选区（改完 DOM 后把选中状态还回去，否则工具条会掉） */
function restoreSel(root: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  let acc = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cur = w.nextNode() as Text | null;
  while (cur) {
    const len = cur.nodeValue?.length ?? 0;
    if (!startNode && start <= acc + len) {
      startNode = cur;
      startOff = start - acc;
    }
    if (end <= acc + len) {
      endNode = cur;
      endOff = end - acc;
      break;
    }
    acc += len;
    cur = w.nextNode() as Text | null;
  }
  if (!startNode || !endNode) return;
  const range = document.createRange();
  try {
    range.setStart(startNode, Math.min(startOff, startNode.nodeValue?.length ?? 0));
    range.setEnd(endNode, Math.min(endOff, endNode.nodeValue?.length ?? 0));
  } catch {
    return;
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ─────────────── 静态渲染 ─────────────── */

/** 把 segments 渲染成 React 节点（无样式时只输出纯文本，DOM 零变化） */
export function richNodes(segs: RichSegment[]): ReactNode {
  return segs.map((s, i) => {
    if (!s.bold && !s.color) return <Fragment key={i}>{s.text}</Fragment>;
    const style: CSSProperties = {};
    if (s.bold) style.fontWeight = 600;
    if (s.color) style.color = s.color;
    return (
      <span key={i} style={style} data-rich={s.bold && s.color ? 'bc' : s.bold ? 'b' : 'c'}>
        {s.text}
      </span>
    );
  });
}

/* ─────────────── 组件 ─────────────── */

export interface RichTitleProps {
  label: string;
  segments?: RichSegment[];
  /** false = 只读渲染（情景导航 / 查看模式） */
  editable?: boolean;
  className?: string;
  testId?: string;
  onCommit?: (next: { label: string; labelSegments?: RichSegment[] }) => void;
}

export function RichTitle({
  label,
  segments,
  editable = false,
  className = 'tk-label',
  testId = 'tk-label',
  onCommit,
}: RichTitleProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [bar, setBar] = useState<{ x: number; y: number; start: number; end: number; tick: number } | null>(null);

  const commitRate = useRef<(() => void) | null>(null);

  const startEdit = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    if (!editable || editing) return;
    setEditing(true);
  }, [editable, editing]);

  const commit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const segs = readDom(el);
    /* 与结构层 endEdit 保持一致：只吃掉 contenteditable 末尾自动补的那一个换行，
       用户主动敲的换行符（含中间换行）全部保留。 */
    const text = segmentsToPlain(segs).replace(/\n$/, '');
    const styled = segs.some((s) => s.bold || s.color);
    el.contentEditable = 'false';
    setEditing(false);
    setBar(null);
    onCommit?.({ label: text, labelSegments: !text || !styled ? undefined : segs });
  }, [onCommit]);
  commitRate.current = commit;

  /* 进入编辑：切 contentEditable + 用 DOM 铺好富文本 + 光标落末尾 */
  useEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.contentEditable = 'true';
    paintDom(el, resolveRenderSegments(label, segments));
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(range);

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        /* 插入真 \n：pre-wrap 下换行显示，且不会生成 <div>/<br> 破坏 offset 对齐 */
        ev.preventDefault();
        document.execCommand('insertText', false, '\n');
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        commitRate.current?.();
      }
    };
    el.addEventListener('keydown', onKey);

    const onSel = () => {
      const o = selOffsets(el);
      if (!o) {
        setBar(null);
        return;
      }
      const sel = window.getSelection();
      const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      setBar({
        x: rect ? rect.left + rect.width / 2 : 0,
        y: rect ? rect.top : 0,
        start: o.start,
        end: o.end,
        tick: Date.now(),
      });
    };
    document.addEventListener('selectionchange', onSel);
    return () => {
      el.removeEventListener('keydown', onKey);
      document.removeEventListener('selectionchange', onSel);
    };
    /* 只在进入/退出编辑时重建；编辑过程中受 DOM 自主演进 */
  }, [editing, label, segments]);

  const applyBold = () => {
    const el = ref.current;
    if (!el || !bar) return;
    const next = toggleBoldInRange(readDom(el), bar.start, bar.end);
    paintDom(el, next);
    restoreSel(el, bar.start, bar.end);
    setBar({ ...bar });
  };

  const applyColor = (c: string | null) => {
    const el = ref.current;
    if (!el || !bar) return;
    const next = setColorInRange(readDom(el), bar.start, bar.end, c);
    paintDom(el, next);
    restoreSel(el, bar.start, bar.end);
    setBar({ ...bar });
  };

  if (!editable) {
    return (
      <span className={`${className} nodrag nopan`} data-testid={testId}>
        {richNodes(resolveRenderSegments(label, segments))}
      </span>
    );
  }

  const curSegs = ref.current && editing ? readDom(ref.current) : resolveRenderSegments(label, segments);
  const boldOn = !!bar && isRangeBold(curSegs, bar.start, bar.end);
  const colorOn = !!bar ? rangeColor(curSegs, bar.start, bar.end) : undefined;

  return (
    <>
      <span
        key={editing ? 'title-editing' : 'title-static'}
        ref={ref}
        className={`${className} nodrag nopan${editing ? ' rich-editing' : ''}`}
        data-testid={editing ? 'tk-label-editor' : testId}
        onDoubleClick={startEdit}
        onBlur={editing ? commit : undefined}
      >
        {/* 编辑态 children 必须为空：内容由 paintDom 全权接管（见文件头决策 2） */}
        {editing ? null : richNodes(resolveRenderSegments(label, segments))}
      </span>

      {editing && bar && (
        <div
          className="rich-bar nodrag nopan"
          data-testid="rich-bar"
          /* 关键：按住工具条不能抢走选区，否则点击瞬间 selection 被清、工具条自己消失 */
          onMouseDown={(e) => e.preventDefault()}
          style={{ left: bar.x, top: bar.y }}
        >
          <button
            type="button"
            className={`rich-btn${boldOn ? ' on' : ''}`}
            onClick={applyBold}
            title="加粗"
            data-testid="rich-bold"
          >
            B
          </button>
          <span className="rich-sep" />
          {RICH_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`rich-swatch${colorOn === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => applyColor(c)}
              title={c}
              data-testid={`rich-color-${c.slice(1)}`}
              aria-label={`设为 ${c}`}
            />
          ))}
          <button
            type="button"
            className="rich-btn"
            onClick={() => applyColor(null)}
            title="清除颜色"
            data-testid="rich-clear"
          >
            ⌫
          </button>
        </div>
      )}
    </>
  );
}
