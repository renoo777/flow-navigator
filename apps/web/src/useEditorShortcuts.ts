/** E2 编辑器键盘层：Ctrl+C/V/X/D · Ctrl+Z/Y(Shift+Z) · 方向键微调 · F2/Enter 改名 · Esc · Ctrl+A
 *  只在「编辑模式且非只读」生效；输入框/浮层/Modal 打开时自动让位。
 *
 *  粘贴（Ctrl+V）两套路：
 *  ① paste 事件（首选）：临时把焦点交给离屏可编辑元素，浏览器把剪贴板内容派发到它上面，
 *     可同时拿到 text/html（飞书画板）与 text/plain（本软件内部载荷），完全不依赖剪贴板权限；
 *  ② clipboard API 兜底：浏览器没派发 paste 时（焦点受限 / 权限拒绝）退回 readText + read()。 */
import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow, type Edge } from '@xyflow/react';
import { isFeishuWhiteboardHtml, parseFeishuWhiteboard, type ImportedGraph } from '@flow/core';
import { useAppStore, type FlowContent } from './store';
import { isExprNode, type SopFlowNode } from '@flow/canvas';

const CLIP_KEY = 'flow-app:clip';

interface ClipNode {
  id: string;
  label: string;
  kind: 'io-start' | 'io-end' | 'decision' | 'step';
  talk: { side: 'agent' | 'cust'; text: string }[];
  color?: { bg?: string; stroke?: string; text?: string } | null;
  /** WP7-3d 锁尺寸：飞书导入的卡片原 w/h。复制要带着走，粘贴出来仍是同形状 → 居中/排版不丢 */
  size?: { w: number; h: number };
  x: number;
  y: number;
}
interface ClipPayload {
  nodes: ClipNode[];
  edges: { source: string; target: string; label: string; type: string }[];
  center: { x: number; y: number };
}

const nextId = () => `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const edgeIdOf = (s: string, t: string) => `${s}->${t}`;

function inOverlay(): boolean {
  return !!document.querySelector(
    '.modal-overlay, .type-picker, .pop-menu, .edge-rename-pop, .talk-zoom'
  );
}
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  /* target 不一定是 Element（合成事件可能直接打在 window/document 上）→ 守卫后再取 tag/closest */
  if (!el || typeof el.closest !== 'function') return false;
  const tag = el.tagName ?? '';
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable ||
    !!el.closest('[contenteditable="true"]')
  );
}

/** 画布可视中心（屏幕坐标），粘贴落点用 */
function canvasCenter(): { x: number; y: number } | null {
  const wrap = document.querySelector('.canvas-wrap');
  const r = wrap?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

/** 离屏可编辑元素：Ctrl+V 时接管焦点，让浏览器把 paste 派发过来（见文件头注释） */
function makePasteProbe(): HTMLElement | null {
  try {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    el.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(el);
    el.focus();
    return el;
  } catch {
    return null;
  }
}

/** 读系统剪贴板里的 text/html（异步剪贴板 API；无权限时静默返回空串） */
async function readClipboardHtml(): Promise<string> {
  try {
    const clip = navigator.clipboard as (Clipboard & { read?: () => Promise<ClipboardItem[]> }) | undefined;
    if (!clip?.read) return '';
    const items = await clip.read();
    for (const item of items) {
      if (item.types.includes('text/html')) {
        const blob = await item.getType('text/html');
        return await blob.text();
      }
    }
  } catch {
    /* 无权限 / 非安全上下文：静默，走 paste 事件路径 */
  }
  return '';
}

function reportImportError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  window.alert(`剪贴板里的画板数据没能解析成功（${msg}）。\n可在飞书画板里重新复制一次再试。`);
}

/** 从当前选中构造剪贴板载荷。WP4：表达节点（便签/贴图/标注）不进本软件剪贴板
 *  （Clip schema 只有 sop 字段；图片 base64 跨粘贴也易爆 localStorage）—— 只复制流程节点 */
function buildClip(): ClipPayload | null {
  const st = useAppStore.getState();
  const sel = st.nodes.filter((n) => n.selected && !isExprNode(n));
  if (!sel.length) return null;
  const ids = new Set(sel.map((n) => n.id));
  const xs = sel.map((n) => n.position.x);
  const ys = sel.map((n) => n.position.y);
  const center = {
    x: (Math.min(...xs) + Math.max(...sel.map((n) => n.position.x + 148))) / 2,
    y: (Math.min(...ys) + Math.max(...sel.map((n) => n.position.y + 46))) / 2,
  };
  const nodes: ClipNode[] = sel.map((n) => ({
    id: n.id,
    label: n.data?.label ?? '',
    kind: (n.data?.kind as ClipNode['kind']) ?? 'step',
    talk: n.data?.talk ?? [],
    color: (n.data?.color as ClipNode['color']) ?? null,
    /* 锁尺寸：复制带过去 → 粘贴出来仍是 keep-shape 居中卡片。
       没尺寸（手动节点 / 老文档）就不带，向后兼容。 */
    size: (n.data as { size?: { w: number; h: number } } | undefined)?.size,
    x: n.position.x,
    y: n.position.y,
  }));
  const edges = st.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      label: typeof e.label === 'string' ? e.label : '',
      type: e.type && e.type !== 'orth' ? e.type : 'smoothstep',
    }));
  return { nodes, edges, center };
}

/** 解析剪贴板 JSON（外部 app / 内部 localStorage 兜底） */
function parseClipText(text: string | undefined): ClipPayload | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as ClipPayload;
    if (Array.isArray(p?.nodes) && p.nodes.length && Array.isArray(p?.edges)) return p;
  } catch {
    /* noop */
  }
  return null;
}

function remapAndApply(payload: ClipPayload, atFlow: { x: number; y: number } | null) {
  const st = useAppStore.getState();
  const remap = new Map<string, string>();
  payload.nodes.forEach((n) => remap.set(n.id, nextId()));
  const nodes: SopFlowNode[] = payload.nodes.map((n) => {
    const id = remap.get(n.id) ?? nextId();
    let x = n.x + 26;
    let y = n.y + 26;
    if (atFlow) {
      x = atFlow.x + (n.x - payload.center.x);
      y = atFlow.y + (n.y - payload.center.y);
    }
    const node: SopFlowNode = {
      id,
      type: 'sop',
      position: { x, y },
      data: {
        label: n.label,
        kind: n.kind,
        talk: Array.isArray(n.talk) ? n.talk.map((t) => ({ ...t })) : [],
        ...(n.color ? { color: n.color } : {}),
        /* 锁尺寸跟着复制走：粘贴出来的卡片仍按原 w/h 渲染 → 居中与排版一致 */
        ...(n.size && n.size.w > 0 && n.size.h > 0 ? { size: n.size } : {}),
      },
      selected: true,
    };
    return node;
  });
  const edges: Edge[] = payload.edges
    .map((e) => {
      const s = remap.get(e.source);
      const t = remap.get(e.target);
      if (!s || !t) return null;
      return {
        id: edgeIdOf(s, t),
        source: s,
        target: t,
        type: e.type,
        label: e.label,
        selected: false,
      } as Edge;
    })
    .filter((e): e is Edge => e !== null);
  void st;
  useAppStore.getState().applyPaste(nodes, edges);
}

export function useEditorShortcuts(opts?: {
  /** 剪贴板里识别出外部画板图（飞书）时的回调，由调用方决定如何落地 */
  onExternalGraph?: (graph: ImportedGraph) => void;
}) {
  const rf = useReactFlow<SopFlowNode, Edge>();
  const clipRef = useRef<ClipPayload | null>(null);
  const probeRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const suppressUntilRef = useRef(0);
  const onExternalGraph = opts?.onExternalGraph;

  const selectedCount = () => useAppStore.getState().nodes.filter((n) => n.selected).length;

  /** 复制/剪切载荷（含系统剪贴板 + 内部兜底） */
  const doCopy = useCallback(async (cut: boolean) => {
    const payload = buildClip();
    if (!payload) return;
    clipRef.current = payload;
    const text = JSON.stringify({ app: 'flow-app', kind: 'flow-clip', ...payload });
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      localStorage.setItem(CLIP_KEY, text);
    }
    if (cut) useAppStore.getState().deleteSelected();
  }, []);

  const doPaste = useCallback(
    async (eventPoint: { x: number; y: number } | null) => {
      let payload = clipRef.current;
      if (!payload) {
        let text: string | undefined;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          text = localStorage.getItem(CLIP_KEY) ?? undefined;
        }
        payload = parseClipText(text);
        if (payload) clipRef.current = payload;
        else if (onExternalGraph) {
          /* 不是本软件内部载荷 → 看看是不是飞书画板 */
          const html = await readClipboardHtml();
          if (isFeishuWhiteboardHtml(html)) {
            try {
              onExternalGraph(parseFeishuWhiteboard(html));
            } catch (err) {
              reportImportError(err);
            }
            return;
          }
        }
      }
      if (!payload) return;
      const atFlow = eventPoint ? rf.screenToFlowPosition(eventPoint) : null;
      remapAndApply(payload, atFlow);
    },
    [rf, onExternalGraph]
  );

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (inOverlay() || isTypingTarget(e.target)) return;
      const s = useAppStore.getState();
      if (!s.docId || s.readonly || s.mode !== 'edit' || s.view !== 'flow') return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      /* 快捷键统一按小写判定：CapsLock / 部分键盘布局下 Ctrl+C 送来的 key 是大写 'C' */
      const k = key.toLowerCase();

      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && k === 'c') {
        if (selectedCount() > 0) {
          e.preventDefault();
          void doCopy(false);
        }
        return;
      }
      if (mod && k === 'x') {
        if (selectedCount() > 0) {
          e.preventDefault();
          void doCopy(true);
        }
        return;
      }
      // Ctrl+V 统一走 capture 阶段 onPasteAt（可判断鼠标是否在画布内）
      if (mod && k === 'd') {
        e.preventDefault();
        const payload = clipRef.current ?? buildClip();
        if (!payload) return;
        clipRef.current = payload;
        remapAndApply(payload, null);
        return;
      }
      if (mod && k === 'a') {
        e.preventDefault();
        useAppStore.setState({
          nodes: s.nodes.map((n) => ({ ...n, selected: true })),
          edges: s.edges.map((ed) => ({ ...ed, selected: true })),
        });
        return;
      }
      if (key === 'Escape') {
        if (s.nodes.some((n) => n.selected) || s.edges.some((ed) => ed.selected)) {
          e.preventDefault();
          s.clearSelection();
        }
        return;
      }
      // 方向键微调：1px / Shift=10px；长按连发不重复入历史
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      if (arrows[key] && selectedCount() > 0) {
        e.preventDefault();
        const [dx, dy] = arrows[key];
        const step = e.shiftKey ? 10 : 1;
        if (!e.repeat) s.mark();
        s.nudgeSelected(dx * step, dy * step);
        return;
      }
      // F2 / Enter：对单一选中节点进入改名
      if ((key === 'F2' || key === 'Enter') && selectedCount() === 1) {
        const only = s.nodes.find((n) => n.selected);
        if (only && !only.data?.editing) {
          e.preventDefault();
          rf.updateNodeData(only.id, { editing: true } as Record<string, unknown>);
        }
      }
    },
    [rf, doCopy, doPaste]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(e);

    const clearProbe = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const el = probeRef.current;
      probeRef.current = null;
      el?.remove();
    };

    /* paste 事件：能拿到完整 clipboardData（text/html + text/plain），无需剪贴板权限 */
    const onPasteEvt = (e: ClipboardEvent) => {
      const fromProbe = !!probeRef.current && e.target === probeRef.current;
      if (probeRef.current) clearProbe();
      if (suppressUntilRef.current > Date.now()) return;
      if (!fromProbe && (inOverlay() || isTypingTarget(e.target))) return;
      const s = useAppStore.getState();
      if (!s.docId || s.readonly || s.mode !== 'edit') return;

      const html = e.clipboardData?.getData('text/html') ?? '';
      if (isFeishuWhiteboardHtml(html)) {
        e.preventDefault();
        e.stopPropagation();
        try {
          onExternalGraph?.(parseFeishuWhiteboard(html));
        } catch (err) {
          reportImportError(err);
        }
        return;
      }
      const payload = parseClipText(e.clipboardData?.getData('text/plain') ?? '');
      if (!payload) return;
      e.preventDefault();
      e.stopPropagation();
      clipRef.current = payload;
      const cp = canvasCenter();
      remapAndApply(payload, cp ? rf.screenToFlowPosition(cp) : null);
    };

    /* Ctrl+V：把焦点短暂交给离屏可编辑元素，等浏览器派发 paste；300ms 没来就走 API 兜底 */
    const onPasteAt = (e: KeyboardEvent) => {
      if (inOverlay() || isTypingTarget(e.target)) return;
      const s = useAppStore.getState();
      if (!s.docId || s.readonly || s.mode !== 'edit') return;
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V'))) return;
      const probe = makePasteProbe();
      if (!probe) return;
      probeRef.current = probe;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!probeRef.current) return; // paste 已到达并被处理
        clearProbe();
        suppressUntilRef.current = Date.now() + 1200; // 防止兜底后再来一次 paste 造成双粘贴
        void doPaste(canvasCenter());
      }, 300);
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onPasteAt, true);
    window.addEventListener('paste', onPasteEvt, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onPasteAt, true);
      window.removeEventListener('paste', onPasteEvt, true);
      clearProbe();
    };
  }, [handleKey, doPaste, onExternalGraph, rf]);

  return null;
}

export type { FlowContent };
