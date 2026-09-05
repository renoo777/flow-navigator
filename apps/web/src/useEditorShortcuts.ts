/** E2 编辑器键盘层：Ctrl+C/V/X/D · Ctrl+Z/Y(Shift+Z) · 方向键微调 · F2/Enter 改名 · Esc · Ctrl+A
 *  只在「编辑模式且非只读」生效；输入框/浮层/Modal 打开时自动让位。 */
import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow, type Edge } from '@xyflow/react';
import { useAppStore, type FlowContent } from './store';
import type { SopFlowNode } from '@flow/canvas';

const CLIP_KEY = 'flow-app:clip';

interface ClipNode {
  id: string;
  label: string;
  kind: 'io-start' | 'io-end' | 'decision' | 'step';
  talk: { side: 'agent' | 'cust'; text: string }[];
  color?: { bg?: string; stroke?: string; text?: string } | null;
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
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable ||
    !!el.closest('[contenteditable="true"]')
  );
}

/** 从当前选中构造剪贴板载荷 */
function buildClip(): ClipPayload | null {
  const st = useAppStore.getState();
  const sel = st.nodes.filter((n) => n.selected);
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
    x: n.position.x,
    y: n.position.y,
  }));
  const edges = st.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      label: typeof e.label === 'string' ? e.label : '',
      type: e.type && e.type !== 'orth' ? e.type : 'step',
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

export function useEditorShortcuts() {
  const rf = useReactFlow<SopFlowNode, Edge>();
  const clipRef = useRef<ClipPayload | null>(null);

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
      }
      if (!payload) return;
      const atFlow = eventPoint ? rf.screenToFlowPosition(eventPoint) : null;
      remapAndApply(payload, atFlow);
    },
    [rf]
  );

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (inOverlay() || isTypingTarget(e.target)) return;
      const s = useAppStore.getState();
      if (!s.docId || s.readonly || s.mode !== 'edit' || s.view !== 'flow') return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;

      if (mod && (key === 'z' || key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && key === 'c') {
        if (selectedCount() > 0) {
          e.preventDefault();
          void doCopy(false);
        }
        return;
      }
      if (mod && key === 'x') {
        if (selectedCount() > 0) {
          e.preventDefault();
          void doCopy(true);
        }
        return;
      }
      // Ctrl+V 统一走 capture 阶段 onPasteAt（可判断鼠标是否在画布内）
      if (mod && key === 'd') {
        e.preventDefault();
        const payload = clipRef.current ?? buildClip();
        if (!payload) return;
        clipRef.current = payload;
        remapAndApply(payload, null);
        return;
      }
      if (mod && (key === 'a' || key === 'A')) {
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

  /** 供画布在粘贴点使用：Ctrl+V 时若鼠标在画布内，粘贴跟随鼠标（FlowCanvas onPaneClick detail2 之外）
   *  简化：由全局 keydown 直接取 e.clientX/Y 画布区域坐标 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(e);
    const onPasteAt = (e: KeyboardEvent) => {
      if (inOverlay() || isTypingTarget(e.target)) return;
      const s = useAppStore.getState();
      if (!s.docId || s.readonly || s.mode !== 'edit') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        // 键盘事件无指针坐标：粘贴落到画布可视中心
        const wrap = document.querySelector('.canvas-wrap');
        const r = wrap?.getBoundingClientRect();
        if (r) {
          e.preventDefault();
          e.stopPropagation();
          void doPaste({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onPasteAt, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onPasteAt, true);
    };
  }, [handleKey, doPaste]);

  return null;
}

export type { FlowContent };
