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
  /** 0918：自定义每行字数（丢了 → 粘贴出来的卡不再按原规则断行，排版错位） */
  wrapCols?: number;
  /** 0918：话术层角色称呼 / 左右方向 / 卡片宽度 */
  roles?: { agent?: string; cust?: string } | null;
  talkDir?: 'agentLeft' | 'agentRight';
  talkW?: number;
  /** 0918：双视图坐标（丢了 → 切话术层要重新继承结构层坐标，排版与原来不一致） */
  posByView?: Partial<Record<'flow' | 'talk', { x: number; y: number }>>;
  x: number;
  y: number;
}
interface ClipEdge {
  source: string;
  target: string;
  label: string;
  type: string;
  /** 0918：出入侧（丢了 → 粘贴后一律退回「下出上进」，原样 left→left 的线全变形） */
  sourceHandle?: string;
  targetHandle?: string;
  /** 0918：连线数据（钉住锚点 sourceAnchor/targetAnchor/anchorPinned、手动折点 route、
   *  说明拖动偏移 labelOffset）。函数字段不入载荷（JSON 化时自然丢失）。 */
  data?: Record<string, unknown>;
}
interface ClipPayload {
  nodes: ClipNode[];
  edges: ClipEdge[];
  center: { x: number; y: number };
}

/** 边的 data 里只搬运「纯数据」字段：以 _ 开头的运行时字段（_ap/_bp/_et/_onX 等）由渲染层每帧注入 */
function cleanEdgeData(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  Object.entries(data as Record<string, unknown>).forEach(([k, v]) => {
    if (k.startsWith('_') || typeof v === 'function') return;
    out[k] = v;
  });
  return Object.keys(out).length ? out : undefined;
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
  /** 卡片宽高：优先 RF 实测（measured），其次锁尺寸 data.size，最后兜底 148×46。
      原来写死 148/46，keep-shape 大卡复制后落点偏移明显（用户反馈「排版变乱」之一）。 */
  const wOf = (n: SopFlowNode) => n.measured?.width ?? (n.data as { size?: { w: number } })?.size?.w ?? 148;
  const hOf = (n: SopFlowNode) => n.measured?.height ?? (n.data as { size?: { h: number } })?.size?.h ?? 46;
  const xs = sel.map((n) => n.position.x);
  const ys = sel.map((n) => n.position.y);
  const center = {
    x: (Math.min(...xs) + Math.max(...sel.map((n) => n.position.x + wOf(n)))) / 2,
    y: (Math.min(...ys) + Math.max(...sel.map((n) => n.position.y + hOf(n)))) / 2,
  };
  const nodes: ClipNode[] = sel.map((n) => {
    const d = (n.data ?? {}) as Record<string, unknown>;
    return {
      id: n.id,
      label: n.data?.label ?? '',
      kind: (n.data?.kind as ClipNode['kind']) ?? 'step',
      talk: n.data?.talk ?? [],
      color: (n.data?.color as ClipNode['color']) ?? null,
      /* 锁尺寸：复制带过去 → 粘贴出来仍是 keep-shape 居中卡片。
         没尺寸（手动节点 / 老文档）就不带，向后兼容。 */
      size: (d.size as ClipNode['size']) ?? undefined,
      ...(typeof d.wrapCols === 'number' ? { wrapCols: d.wrapCols } : {}),
      ...(d.roles ? { roles: d.roles as ClipNode['roles'] } : {}),
      ...(d.talkDir === 'agentRight' ? { talkDir: 'agentRight' as const } : {}),
      ...(typeof d.talkW === 'number' ? { talkW: d.talkW } : {}),
      ...(n.posByView ? { posByView: n.posByView } : {}),
      x: n.position.x,
      y: n.position.y,
    };
  });
  const edges: ClipEdge[] = st.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      label: typeof e.label === 'string' ? e.label : '',
      type: e.type && e.type !== 'orth' ? e.type : 'smoothstep',
      /* 出入侧 + 连线数据（钉住锚点 / 手动折点 / 说明偏移）：
         丢了这些，跨图粘贴后一律退回「下出上进」+ 无折点，原样排版全丢。 */
      ...(typeof e.sourceHandle === 'string' && e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(typeof e.targetHandle === 'string' && e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      ...(cleanEdgeData(e.data) ? { data: cleanEdgeData(e.data) } : {}),
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
    /* 双视图坐标：整组平移时两套坐标要跟着一起走（相对关系不变），
       否则切话术层时坐标与结构层对不上，排版被打乱。 */
    const dx = x - n.x;
    const dy = y - n.y;
    const pbf = n.posByView?.flow ? { x: n.posByView.flow.x + dx, y: n.posByView.flow.y + dy } : null;
    const pbt = n.posByView?.talk ? { x: n.posByView.talk.x + dx, y: n.posByView.talk.y + dy } : null;
    const node: SopFlowNode = {
      id,
      type: 'sop',
      position: { x, y },
      ...(pbf || pbt ? { posByView: { ...(pbf ? { flow: pbf } : {}), ...(pbt ? { talk: pbt } : {}) } } : {}),
      data: {
        label: n.label,
        kind: n.kind,
        talk: Array.isArray(n.talk) ? n.talk.map((t) => ({ ...t })) : [],
        ...(n.color ? { color: n.color } : {}),
        /* 锁尺寸跟着复制走：粘贴出来的卡片仍按原 w/h 渲染 → 居中与排版一致 */
        ...(n.size && n.size.w > 0 && n.size.h > 0 ? { size: n.size } : {}),
        /* 0918：换行规则 / 话术角色 / 左右方向 / 卡宽一并带回 */
        ...(typeof n.wrapCols === 'number' ? { wrapCols: n.wrapCols } : {}),
        ...(n.roles ? { roles: n.roles } : {}),
        ...(n.talkDir === 'agentRight' ? { talkDir: n.talkDir } : {}),
        ...(typeof n.talkW === 'number' ? { talkW: n.talkW } : {}),
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
        /* 0918：出入侧 + 连线数据（钉住锚点 / 手动折点 / 说明偏移）原样带回 */
        ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
        ...(e.data ? { data: { ...e.data } } : {}),
        selected: false,
      } as Edge;
    })
    .filter((e): e is Edge => e !== null);
  void st;
  useAppStore.getState().applyPaste(nodes, edges);
}

/* 开发期调试钩子：Playwright 探针直接驱动真实的复制/粘贴管线（不重写一套逻辑），
   保证门禁测的是线上代码路径。生产构建不会打进去。 */
if (
  typeof window !== 'undefined' &&
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV
) {
  (window as unknown as Record<string, unknown>).__flowClip = { buildClip, remapAndApply };
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
