/** App：boot 门 → 库首页 / 编辑器；编辑器含 Dock + FlowCanvas + 空态 + 变量管理/引导 + E1-E7 打磨接线 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import {
  computeScenario,
  deriveVariableCandidates,
  estimateNodeSize,
  inferAnchorSides,
  inferLayoutDirection,
  layeredLayout,
  layoutGraph,
  resolveVariables,
  type FlowVariable,
  type ImportedGraph,
  type NodeKind,
} from '@flow/core';
import {
  FlowCanvas,
  TypePicker,
  isExprNode,
  type CommandItem,
  type EdgeRoutePatch,
  type ExprType,
  type NodePaint,
  type SopFlowNode,
  type SopNodeData,
} from '@flow/canvas';
import { VariableDock } from '@flow/dock';
import { VariableGuideModal, VariableManageModal } from './VarModals';
import { PasteImportModal, type ImportLayout } from './PasteImportModal';
import { LibraryScreen } from './LibraryScreen';
import { useAppStore } from './store';
import { useEditorShortcuts } from './useEditorShortcuts';
import { exportFlowPng } from './exportPng';
import { exportShareCard } from './exportShareCard';

const THEME_KEY = 'flow-app:theme';

function Root() {
  const ready = useAppStore((s) => s.ready);
  const docId = useAppStore((s) => s.docId);
  const boot = useAppStore((s) => s.boot);

  useEffect(() => {
    boot();
  }, [boot]);

  /* B7：URL ?doc=<id> 深链 — boot 后若 URL 有 doc 覆盖恢复；docId 变化同步到 URL；popstate 同步 */
  useEffect(() => {
    if (!ready) return;
    if (typeof window === 'undefined') return;
    const syncUrl = () => {
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get('doc');
      const current = useAppStore.getState().docId;
      if (fromUrl && fromUrl !== current) {
        void useAppStore.getState().openDoc(fromUrl);
        return;
      }
      if (current && fromUrl !== current) {
        url.searchParams.set('doc', current);
        window.history.replaceState(null, '', url);
      } else if (!current && fromUrl) {
        url.searchParams.delete('doc');
        window.history.replaceState(null, '', url);
      }
    };
    syncUrl();
    window.addEventListener('popstate', syncUrl);
    return () => window.removeEventListener('popstate', syncUrl);
  }, [ready, docId]);

  if (!ready) return <div className="boot-splash">正在打开流程图库…</div>;
  return docId ? <EditorScreen /> : <LibraryScreen />;
}

/** 编辑器（需在 ReactFlowProvider 内，为坐标转换） */
function EditorScreen() {
  const selectedCount = useAppStore(
    (s) => s.nodes.reduce((a, n) => a + (n.selected ? 1 : 0), 0)
  );
  const themeVal = useAppStore((s) => s.theme);

  /* B3：恢复主题偏好 + 主题同步 DOM */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'dark' || saved === 'light') useAppStore.getState().setTheme(saved);
    } catch {}
  }, []);
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = themeVal;
    try {
      localStorage.setItem(THEME_KEY, themeVal);
    } catch {}
  }, [themeVal]);

  const {
    docId,
    docName,
    setDocName,
    calibrateViewOverlaps,
    readonly,
    nodes,
    edges,
    mode,
    view,
    assignments,
    steps,
    redoSteps,
    enabledVarNodeIds,
    defaultEdgeType,
    picker,
    undoStack,
    redoStack,
    snapEnabled,
    gridVisible,
    focusAll,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onReconnect,
    setMode,
    setView,
    assign,
    clearAssignments,
    presetAssignments,
    stepBack,
    stepForward,
    relayout,
    localRelayout,
    openPicker,
    closePicker,
    addNodeAt,
    addExprNode,
    renameEdge,
    setDefaultEdgeType,
    setEdgeTypes,
    resetEdgeAnchors,
    resetAllEdgeRoutes,
    setEdgeRoute,
    setEnabledVars,
    toggleVarEnabled,
    openDoc,
    closeToLibrary,
    exportJSON,
    mark,
    undo,
    redo,
    setSnap,
    setGridVisible,
    setFocusAll,
    paintNodes,
    deleteSelected,
    clearSelection,
    changeKind,
    setWrapCols,
    moveEdgeLabel,
    syncEdgeSides,
    deleteNodes,
    toggleTheme,
  } = useAppStore();
  const rf = useReactFlow<SopFlowNode, Edge>();

  /* —— 外部画板粘贴导入（飞书）：hook 识别后交给这里确认再落地 —— */
  const [pendingImport, setPendingImport] = useState<ImportedGraph | null>(null);
  const handleExternalGraph = useCallback((g: ImportedGraph) => setPendingImport(g), []);
  useEditorShortcuts({ onExternalGraph: handleExternalGraph });

  /* —— 变量派生：候选（全 ≥2 分支）/ 启用（导航决策点）——
     WP4：表达节点（便签/贴图/标注）不喂给核心算法（引擎/dagre/变量/分享卡都不碰它） */
  const coreFrom = useCallback(
    () => ({
      nodes: nodes
        .filter((n) => !isExprNode(n))
        .map((n) => ({
          id: n.id,
          type: 'sop' as const,
          position: { x: 0, y: 0 },
          data: n.data,
        })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep' as const,
        label: typeof e.label === 'string' ? e.label : '',
      })),
    }),
    [nodes, edges]
  );

  const candidates: FlowVariable[] = useMemo(() => {
    const { nodes: cn, edges: ce } = coreFrom();
    return deriveVariableCandidates(cn, ce);
  }, [coreFrom]);

  const variables: FlowVariable[] = useMemo(() => {
    const { nodes: cn, edges: ce } = coreFrom();
    return resolveVariables(cn, ce, enabledVarNodeIds);
  }, [coreFrom, enabledVarNodeIds]);

  const scenario = useMemo(() => {
    if (mode !== 'scenario') return null;
    const { nodes: cn, edges: ce } = coreFrom();
    /* 传有序决策序列而非 assignments：环上同一判断点可有多次不同选择（M3） */
    return computeScenario(cn, ce, variables, steps);
  }, [mode, coreFrom, variables, steps]);

  const hasStart = nodes.some((n) => n.data?.kind === 'io-start');
  const hasEnd = nodes.some((n) => n.data?.kind === 'io-end');
  const editable = !readonly;

  /* —— 首次识别引导（4.1）：导入/空白新增后候选出现时弹一次 —— */
  const [guideOpen, setGuideOpen] = useState(false);
  const guideLock = useRef(false);
  useEffect(() => {
    if (!docId) return;
    if (readonly) return;
    if (candidates.length > 0 && enabledVarNodeIds === null && !guideLock.current) {
      guideLock.current = true;
      setGuideOpen(true);
    }
    if (enabledVarNodeIds !== null) guideLock.current = false;
  }, [docId, readonly, candidates, enabledVarNodeIds]);

  /* —— 测试钩子：探针需要编程式控制视口（选中边后拖端点等真机断言）。
        只读暴露 RF 实例，不触碰业务状态。 */
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__flowRF = rf;
    return () => {
      delete (window as unknown as Record<string, unknown>).__flowRF;
    };
  }, [rf]);

  const handleGuideDecide = useCallback(
    (ids: string[] | null) => {
      setGuideOpen(false);
      setEnabledVars(ids ?? []);
    },
    [setEnabledVars]
  );

  const [manageOpen, setManageOpen] = useState(false);
  const handleSaveEnabled = useCallback(
    (ids: string[]) => {
      setEnabledVars(ids);
      setManageOpen(false);
    },
    [setEnabledVars]
  );

  /* —— 画布动作（只读禁写）—— */
  const handleConnect = useCallback(
    (conn: Connection) => {
      onConnect(conn);
      setMode('edit');
    },
    [onConnect, setMode]
  );

  const handlePaneDoubleClick = useCallback(
    (clientX: number, clientY: number) => {
      if (!editable || mode !== 'edit') return;
      openPicker(clientX, clientY);
    },
    [editable, mode, openPicker]
  );

  /** Build K-④ · 画布搜索定位：选中目标节点 + 视口平滑飞过去（不放大过头） */
  const handleFocusNode = useCallback(
    (id: string) => {
      useAppStore.setState((s) => ({
        nodes: s.nodes.map((n) => ({ ...n, selected: n.id === id })),
      }));
      requestAnimationFrame(() =>
        rf.fitView({ nodes: [{ id }], duration: 420, padding: 0.6, maxZoom: 1.15 })
      );
    },
    [rf]
  );

  const handlePaneClickClear = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  const handleAddClick = useCallback(() => {
    if (!editable || mode !== 'edit') return;
    const el = document.querySelector('.canvas-wrap');
    const r = el?.getBoundingClientRect();
    openPicker(
      r ? r.left + r.width / 2 : window.innerWidth / 2,
      r ? r.top + r.height / 2 : window.innerHeight / 2
    );
  }, [editable, mode, openPicker]);

  /** WP4：sop 四种 + 表达三类统一落点（双击空白 picker） */
  const handleTypePick = useCallback(
    (pick: NodeKind | ExprType) => {
      if (!picker) return;
      const pos = rf.screenToFlowPosition({ x: picker.x, y: picker.y });
      if (pick === 'note' || pick === 'image' || pick === 'label') addExprNode(pick, pos.x, pos.y);
      else addNodeAt(pick, pos.x, pos.y);
      closePicker();
    },
    [picker, rf, addNodeAt, addExprNode, closePicker]
  );

  /** 一键整理：dagre TB 布局 + fitView（US-07/F5，Build E 双引擎参数化已还原） */
  const handleRunLayout = useCallback(() => {
    const s = useAppStore.getState();
    if (!s.nodes.length) return;
    s.mark();
    relayout();
    requestAnimationFrame(() => rf.fitView({ padding: 0.12, duration: 250 }));
  }, [rf, relayout]);

  /** 局部整理：仅重排选中节点，dock / selbar 触发 */
  const handleLocalLayout = useCallback(() => {
    const s = useAppStore.getState();
    if (!s.nodes.some((n) => n.selected)) return;
    localRelayout();
    requestAnimationFrame(() => rf.fitView({ padding: 0.18, duration: 250 }));
  }, [rf, localRelayout]);

  /** 外部画板导入落地：节点 id 重新签发（避免与既有节点/二次导入撞号），可替换或追加
   *  edgeType = 用户在弹窗里挑的连线样式（肘线 / 曲线 / 直线），同时成为本图新连线的默认样式 */
  const handleImportApply = useCallback(
    (layout: ImportLayout, replace: boolean, edgeType: string) => {
      const g = pendingImport;
      if (!g) return;
      const s = useAppStore.getState();
      s.mark();
      const remap = new Map<string, string>();
      const stamp = Date.now().toString(36);
      const nodes: SopFlowNode[] = g.nodes.map((n, i) => {
        const id = `n${stamp}${i.toString(36)}`;
        remap.set(n.id, id);
        /* 锁尺寸：飞书解析出的每张卡原始 w/h 一并落进 data.size，
           SopNode 渲染 + 布局估算都优先读它（WP7-3d 卡片形状向飞书收敛）。
           没有尺寸（旧文档/极老负载）→ 不锁，走文本自适应，向后兼容。 */
        const size =
          typeof n.w === 'number' && typeof n.h === 'number' && n.w > 0 && n.h > 0
            ? { w: Math.round(n.w), h: Math.round(n.h) }
            : undefined;
        return {
          id,
          type: 'sop',
          position: { x: n.x, y: n.y },
          data: { label: n.label, kind: n.kind, talk: [], ...(size ? { size } : {}) },
          selected: false,
        };
      });
      /* 智能重排：按连线分层 + 保留分支顺序 + 按卡片真实尺寸拉开间距（默认）
         方向跟着飞书原画走：原图横着画的就按横向（LR）分层，竖着画的按纵向（TB）。
         早期一律 TB，把横向流程图重排成一根竖柱，侧边连线全被改成上下连线。 */
      const reflowNodes = nodes.map((n) => ({
        id: n.id,
        label: String(n.data.label ?? ''),
        x: n.position.x,
        y: n.position.y,
        /* 锁尺寸节点把真实 w/h 传给布局引擎（空隙按飞书卡实际大小拉开） */
        ...((n.data as SopNodeData).size ? { size: (n.data as SopNodeData).size } : {}),
        /* 点1：每行字数规则影响行数 → 估算高度要同步 */
        ...((n.data as SopNodeData).wrapCols
          ? { wrapCols: (n.data as SopNodeData).wrapCols }
          : {}),
      }));
      const reflowEdges = g.edges
        .map((e) => ({ source: remap.get(e.source) ?? '', target: remap.get(e.target) ?? '' }))
        .filter((e) => e.source && e.target);
      if (layout === 'reflow') {
        const pos = layeredLayout(reflowNodes, reflowEdges, {
          direction: inferLayoutDirection(reflowNodes, reflowEdges),
        });
        nodes.forEach((n) => {
          const p = pos[n.id];
          if (p) n.position = { x: p.x, y: p.y };
        });
      }
      /* 锚点复用：飞书剪贴板只给了「谁连谁」（startObject/endObject），没有端口字段，
         解析器已按飞书原始坐标反推出每条线的出/入侧（sourceSide/targetSide）。
         「保留原布局」直接信任解析出的原画锚点 —— 粘贴出来就是你飞书里看到的那一侧；
         「智能重排」坐标变了，按重排后的相对位置重新推（射线求交 = 最短连法）。 */
      const boxOf = (n: SopFlowNode) => {
        const s = estimateNodeSize(n, 'flow');
        return { x: n.position.x, y: n.position.y, w: s.w, h: s.h };
      };
      const boxes = new Map(nodes.map((n) => [n.id, boxOf(n)]));
      const edges: Edge[] = g.edges.flatMap((e, i) => {
        const source = remap.get(e.source);
        const target = remap.get(e.target);
        if (!source || !target) return [];
        let sides: { source?: string; target?: string } | null = null;
        /* 连线的出/入侧一律按飞书原画锁住（keep 与智能重排都锁）：
           导入的是别人画好的图，第一步是把原样还原出来。不锁的话画布每帧会用
           我们自己的卡片尺寸重算 —— 卡片 ≤216×46/53，飞书原画 106~160×73~131，
           形状差很多，侧边连线会被判成上下，原画就白解析了。
           锁住后挪节点不会自动换边 —— 右键连线「端点自动」可随时解除。 */
        const pinKeep = !!e.sourceSide && !!e.targetSide;
        if (pinKeep) {
          sides = { source: e.sourceSide, target: e.targetSide };
        } else {
          const bs = boxes.get(source);
          const bt = boxes.get(target);
          sides = bs && bt ? inferAnchorSides(bs, bt) : null;
        }
        return [
          {
            id: `e${stamp}-${i}`,
            source,
            target,
            /* 平行边（同一对节点间多条分支）各自独立 id，否则后者覆盖前者 */
            type: edgeType,
            label: e.label,
            selected: false,
            sourceHandle: sides?.source,
            targetHandle: sides?.target,
            /* 未能反推出原画侧的线：只做初始落位，不打 pin，之后挪节点仍自动换边 */
            ...(pinKeep ? { data: { anchorPinned: true } } : {}),
          } as Edge,
        ];
      });
      useAppStore.setState({
        nodes: replace ? nodes : [...s.nodes, ...nodes],
        edges: replace ? edges : [...s.edges, ...edges],
        assignments: replace ? {} : s.assignments,
        ...(replace ? { steps: [], redoSteps: [] } : {}),
        /* 替换 = 一张新图：变量启用集合回到未决定，让「设为变量」引导再走一次 */
        ...(replace ? { enabledVarNodeIds: null } : {}),
        /* 顺手把本次选的连线样式记为本图默认，之后手拉的线也跟它一致 */
        defaultEdgeType: replace ? edgeType : s.defaultEdgeType,
        mode: 'edit',
      });
      setPendingImport(null);
      requestAnimationFrame(() => rf.fitView({ padding: 0.15, duration: 320 }));
    },
    [pendingImport, rf, relayout, defaultEdgeType]
  );

  /** B2 PNG 图片导出：按节点 bounds 计算视口 + 懒加载 html-to-image */
  const handleExportPng = useCallback(async () => {
    const el = document.querySelector('.canvas-wrap .react-flow__viewport') as HTMLElement | null;
    if (!el) return;
    try {
      await exportFlowPng(rf, el, docName);
    } catch (e) {
      window.alert(`PNG 导出失败：${(e as Error)?.message ?? e}`);
    }
  }, [rf, docName]);

  /** Build K-③ · 1200×630 社交分享卡：纯 Canvas 重绘（非截图），零依赖。
   *  位置用 dagre 现算一份布局——用户可能从没整理过画布（节点全在 0,0），
   *  分享卡必须永远呈现「整理过」的样子，但不能动用户画布上的真实坐标。 */
  const handleShareCard = useCallback(async () => {
    const wOf = (label: string) => Math.max(148, Math.min(300, (label || '').length * 15 + 56));
    /* WP4：分享卡只讲流程 —— 表达节点（便签/贴图/标注）是本地批注，不进入社交图 */
    const sopNodes = nodes.filter((n) => !isExprNode(n));
    try {
      const laid = layoutGraph(
        sopNodes.map((n) => ({ id: n.id, type: 'sop' as const, position: n.position, data: n.data })),
        edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep' as const,
          label: typeof e.label === 'string' ? e.label : '',
        })),
        'flow'
      );
      const posById = new Map(laid.map((n) => [n.id, n.position]));
      await exportShareCard(
        {
          title: docName || '未命名流程图',
          nodes: sopNodes.map((n) => {
            const p = posById.get(n.id) ?? n.position;
            return {
              id: n.id,
              label: n.data?.label ?? '',
              kind: (n.data?.kind as string) ?? 'step',
              x: p.x,
              y: p.y,
              w: wOf(n.data?.label ?? ''),
              h: 46,
            };
          }),
          edges: edges.map((e) => ({ source: e.source, target: e.target })),
          varCount: variables.length,
        },
        `${docName || 'flow'}-分享卡-1200x630.png`.replace(/[\\/:*?"<>|]/g, '_')
      );
    } catch (e) {
      window.alert(`分享卡生成失败：${(e as Error)?.message ?? e}`);
    }
  }, [nodes, edges, variables, docName]);

  const handleViewChange = useCallback(
    (v: 'flow' | 'talk') => {
      setView(v);
      /* Build J：切换时整块画布交叉淡入——先重启动画 class，再让 fitView 平移过去 */
      const wrap = document.querySelector('.canvas-wrap');
      if (wrap instanceof HTMLElement) {
        wrap.classList.remove('view-swap');
        void wrap.offsetWidth; /* 强制重排，确保连续切换也能重播动画 */
        wrap.classList.add('view-swap');
        window.setTimeout(() => wrap.classList.remove('view-swap'), 340);
      }
      requestAnimationFrame(() => rf.fitView({ padding: 0.1, duration: 300 }));
    },
    [setView, rf]
  );

  /** 连线样式：无选中 → 设默认；有选中 → 批量改选中边 */
  const handleEdgeTypeApply = useCallback(
    (edgeIds: string[] | null, t: string) => {
      if (edgeIds) setEdgeTypes(edgeIds, t);
      else setDefaultEdgeType(t);
    },
    [setEdgeTypes, setDefaultEdgeType]
  );

  /** 0918：连线说明拖动 —— 只读查看态不落任何改动（chip 视觉上仍可拖，松手回原位） */
  const handleMoveLabel = useCallback(
    (edgeId: string, off: { dx: number; dy: number }) => {
      if (readonly) return;
      moveEdgeLabel(edgeId, off);
    },
    [readonly, moveEdgeLabel]
  );

  const handlePaintSel = useCallback(
    (paint: NodePaint | null) => {
      const ids = useAppStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);
      if (!ids.length) return;
      mark();
      paintNodes(ids, paint);
    },
    [mark, paintNodes]
  );

  const handleExport = useCallback(() => {
    const text = exportJSON();
    if (!text) return;
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docName || 'flow'}-${date}.json`.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [exportJSON, docName]);

  const handleBack = useCallback(() => {
    /* B7：回库前先清 URL，否则 B7 的 docId 监听 useEffect 会因 URL 仍有 ?doc 而反向打开 */
    if (typeof window !== 'undefined') {
      const u = new URL(window.location.href);
      u.searchParams.delete('doc');
      window.history.replaceState(null, '', u);
    }
    closeToLibrary();
  }, [closeToLibrary]);

  const handleExitView = useCallback(() => {
    if (docId) openDoc(docId, false);
  }, [docId, openDoc]);

  const handleReconnect = useCallback(
    (oldEdge: Edge, conn: Connection) => {
      onReconnect(oldEdge, conn);
      setMode('edit');
    },
    [onReconnect, setMode]
  );

  const handleAnchorReset = useCallback(
    (edgeIds: string[]) => {
      resetEdgeAnchors(edgeIds);
      setMode('edit');
    },
    [resetEdgeAnchors, setMode]
  );

  const handleEdgeRoute = useCallback(
    (edgeId: string, patch: EdgeRoutePatch, commit: boolean) => {
      setEdgeRoute(edgeId, patch, commit);
      setMode('edit');
    },
    [setEdgeRoute, setMode]
  );

  /** Build L · 命令面板：全局动作一键直达（节点跳转项由画布自动生成） */
  const addAtCenter = useCallback(
    (kind: NodeKind) => {
      const el = document.querySelector('.canvas-wrap');
      const r = el?.getBoundingClientRect();
      const p = rf.screenToFlowPosition({
        x: r ? r.left + r.width / 2 : window.innerWidth / 2,
        y: r ? r.top + r.height / 2 : window.innerHeight / 2,
      });
      addNodeAt(kind, p.x, p.y);
    },
    [rf, addNodeAt]
  );
  /** WP4：命令面板在画布中心新建表达节点 */
  const addExprAtCenter = useCallback(
    (type: ExprType) => {
      const el = document.querySelector('.canvas-wrap');
      const r = el?.getBoundingClientRect();
      const p = rf.screenToFlowPosition({
        x: r ? r.left + r.width / 2 : window.innerWidth / 2,
        y: r ? r.top + r.height / 2 : window.innerHeight / 2,
      });
      addExprNode(type, p.x, p.y);
    },
    [rf, addExprNode]
  );
  const dockCommands = useMemo<CommandItem[]>(
    () => [
      { id: 'layout', title: '整理布局', group: '视图', hint: '一键 dagre', run: handleRunLayout },
      { id: 'edge-reset-all', title: '重置全部连线', group: '视图', hint: '清空所有折点与端点吸附', run: resetAllEdgeRoutes },
      { id: 'view-talk', title: `切换到${view === 'flow' ? '话术层' : '结构层'}`, group: '视图', run: () => handleViewChange(view === 'flow' ? 'talk' : 'flow') },
      { id: 'theme', title: `切换到${themeVal === 'dark' ? '浅色' : '深色'}主题`, group: '视图', run: toggleTheme },
      { id: 'grid', title: gridVisible ? '隐藏网格' : '显示网格', group: '视图', run: () => setGridVisible(!gridVisible) },
      { id: 'snap', title: snapEnabled ? '关闭网格吸附' : '开启网格吸附', group: '视图', run: () => setSnap(!snapEnabled) },
      { id: 'mode', title: mode === 'edit' ? '进入情景推演' : '返回编辑模式', group: '视图', run: () => setMode(mode === 'edit' ? 'scenario' : 'edit') },
      { id: 'add-step', title: '新建：步骤节点', group: '编辑', run: () => addAtCenter('step') },
      { id: 'add-decision', title: '新建：分支决策', group: '编辑', run: () => addAtCenter('decision') },
      { id: 'add-start', title: '新建：开始节点', group: '编辑', run: () => addAtCenter('io-start') },
      { id: 'add-end', title: '新建：结束节点', group: '编辑', run: () => addAtCenter('io-end') },
      { id: 'add-note', title: '新建：便签', group: '编辑', run: () => addExprAtCenter('note') },
      { id: 'add-image', title: '新建：贴图', group: '编辑', run: () => addExprAtCenter('image') },
      { id: 'add-label', title: '新建：标注', group: '编辑', run: () => addExprAtCenter('label') },
      { id: 'undo', title: '撤销', group: '编辑', hint: 'Ctrl+Z', run: undo },
      { id: 'redo', title: '重做', group: '编辑', hint: 'Ctrl+Shift+Z', run: redo },
      { id: 'vars', title: '管理变量', group: '编辑', run: () => setManageOpen(true) },
      { id: 'export-json', title: '导出 JSON 备份', group: '导出', run: handleExport },
      { id: 'export-png', title: '导出画布 PNG', group: '导出', run: () => void handleExportPng() },
      { id: 'share', title: '生成分享卡（1200×630）', group: '导出', run: () => void handleShareCard() },
      { id: 'back', title: '返回流程图库', group: '导出', run: handleBack },
    ],
    [
      handleRunLayout, handleViewChange, view, themeVal, toggleTheme, gridVisible, setGridVisible,
      snapEnabled, setSnap, mode, setMode, addAtCenter, addExprAtCenter, undo, redo, setManageOpen,
      handleExport, handleExportPng, handleShareCard, handleBack,
    ]
  );

  const canEditGraph = editable && mode === 'edit';
  /* WP4：空态按「流程节点数」判定（只有便签/贴图/标注的画布不算流程空，但也提示去搭 SOP） */
  const flowNodeCount = useMemo(() => nodes.filter((n) => !isExprNode(n)).length, [nodes]);

  return (
    <div className="app">
      <VariableDock
        docName={docName}
        onRename={setDocName}
        nodesCount={nodes.length}
        varsCount={variables.length}
        candidateCount={candidates.length}
        readonly={readonly}
        mode={mode}
        onModeChange={setMode}
        view={view}
        onViewChange={handleViewChange}
        variables={variables}
        assignments={assignments}
        scenario={scenario}
        focusAll={focusAll}
        onToggleFocus={() => setFocusAll(!focusAll)}
        stepsCount={steps.length}
        redoCount={redoSteps.length}
        onStepBack={stepBack}
        onStepForward={stepForward}
        onAssign={assign}
        onClearAll={clearAssignments}
        onPreset={presetAssignments}
        onAddNode={handleAddClick}
        onBackToLibrary={handleBack}
        onExitView={handleExitView}
        onManageVars={() => setManageOpen(true)}
        onRemoveVar={toggleVarEnabled}
        onExport={handleExport}
        onExportPng={() => void handleExportPng()}
        onShareCard={() => void handleShareCard()}
        onToggleTheme={toggleTheme}
        theme={themeVal}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onUndo={undo}
        onRedo={redo}
        snapEnabled={snapEnabled}
        gridVisible={gridVisible}
        onSnapChange={setSnap}
        onGridChange={setGridVisible}
        onRunLayout={handleRunLayout}
        onLocalLayout={handleLocalLayout}
        selectedCount={selectedCount}
      />
      <main className="canvas">
        {flowNodeCount === 0 && (
          <div className="canvas-empty" data-testid="empty-hint">
            <div className="ce-title">{readonly ? '（空白流程图）' : '空白画布'}</div>
            <div className="ce-sub">
              {readonly
                ? '这张流程图还没有内容'
                : '双击空白处，或点左侧「＋ 添加节点」开始搭建 SOP'}
            </div>
            {!readonly && (
              <button className="ce-load" data-testid="back-to-library-empty" onClick={handleBack}>
                ← 返回流程图库
              </button>
            )}
          </div>
        )}
        <FlowCanvas
          nodes={nodes}
          edges={edges}
          mode={mode}
          view={view}
          onViewStabilized={calibrateViewOverlaps}
          variables={variables}
          scenario={scenario}
          focusAll={focusAll}
          onNodesChange={onNodesChange as (c: NodeChange<SopFlowNode>[]) => void}
          onEdgesChange={onEdgesChange as (c: EdgeChange<Edge>[]) => void}
          onConnect={handleConnect}
          onReconnect={handleReconnect}
          onEdgeRename={renameEdge}
          onPaneDoubleClick={handlePaneDoubleClick}
          onPaneClickClear={handlePaneClickClear}
          onEdgeTypeApply={handleEdgeTypeApply}
          onEdgeAnchorReset={handleAnchorReset}
          onEdgeRouteReset={handleAnchorReset}
          onEdgeRoute={handleEdgeRoute}
          defaultEdgeType={defaultEdgeType}
          editable={canEditGraph}
          onNodeDragStart={mark}
          onPaintSel={handlePaintSel}
          onDeleteSel={deleteSelected}
          onChangeKind={changeKind}
          onChangeWrapCols={setWrapCols}
          onMoveLabel={handleMoveLabel}
          onSyncEdgeSides={readonly ? undefined : syncEdgeSides}
          onDeleteNode={(id) => deleteNodes([id])}
          onTalkEdit={mark}
          onFocusNode={handleFocusNode}
          commands={dockCommands}
          snapToGrid={snapEnabled}
          gridVisible={gridVisible}
        />
      </main>

      {/* 变量首次识别引导（导入/空白新增后首个候选出现） */}
      {guideOpen && candidates.length > 0 && (
        <VariableGuideModal candidates={candidates} onDecide={handleGuideDecide} />
      )}

      {/* 粘贴外部画板（飞书）后的导入确认 */}
      {pendingImport && (
        <PasteImportModal
          graph={pendingImport}
          hasContent={nodes.length > 0}
          onCancel={() => setPendingImport(null)}
          onApply={handleImportApply}
        />
      )}

      {/* 变量管理面板 */}
      {manageOpen && (
        <VariableManageModal
          candidates={candidates}
          enabled={enabledVarNodeIds}
          onSave={handleSaveEnabled}
          onClose={() => setManageOpen(false)}
        />
      )}

      {/* 新建节点类型菜单（portal 到 body） */}
      {picker &&
        createPortal(
          <TypePicker
            x={picker.x}
            y={picker.y}
            hasStart={hasStart}
            hasEnd={hasEnd}
            onPick={handleTypePick}
            onClose={closePicker}
          />,
          document.body
        )}
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Root />
    </ReactFlowProvider>
  );
}
