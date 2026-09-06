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
  layoutGraph,
  resolveVariables,
  type FlowVariable,
  type NodeKind,
} from '@flow/core';
import { FlowCanvas, TypePicker, type CommandItem, type NodePaint, type SopFlowNode } from '@flow/canvas';
import { VariableDock } from '@flow/dock';
import { VariableGuideModal, VariableManageModal } from './VarModals';
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
    readonly,
    nodes,
    edges,
    mode,
    view,
    assignments,
    enabledVarNodeIds,
    defaultEdgeType,
    picker,
    undoStack,
    redoStack,
    snapEnabled,
    gridVisible,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onReconnect,
    setMode,
    setView,
    assign,
    clearAssignments,
    presetAssignments,
    relayout,
    localRelayout,
    openPicker,
    closePicker,
    addNodeAt,
    renameEdge,
    setDefaultEdgeType,
    setEdgeTypes,
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
    paintNodes,
    deleteSelected,
    clearSelection,
    changeKind,
    deleteNodes,
    toggleTheme,
  } = useAppStore();
  const rf = useReactFlow<SopFlowNode, Edge>();
  useEditorShortcuts();

  /* —— 变量派生：候选（全 ≥2 分支）/ 启用（导航决策点）—— */
  const coreFrom = useCallback(
    () => ({
      nodes: nodes.map((n) => ({
        id: n.id,
        type: 'sop' as const,
        position: { x: 0, y: 0 },
        data: n.data,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'step' as const,
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
    return computeScenario(cn, ce, variables, assignments);
  }, [mode, coreFrom, variables, assignments]);

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

  const handleTypePick = useCallback(
    (kind: NodeKind) => {
      if (!picker) return;
      const pos = rf.screenToFlowPosition({ x: picker.x, y: picker.y });
      addNodeAt(kind, pos.x, pos.y);
      closePicker();
    },
    [picker, rf, addNodeAt, closePicker]
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
    try {
      const laid = layoutGraph(
        nodes.map((n) => ({ id: n.id, type: 'sop' as const, position: n.position, data: n.data })),
        edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'step' as const,
          label: typeof e.label === 'string' ? e.label : '',
        })),
        'flow'
      );
      const posById = new Map(laid.map((n) => [n.id, n.position]));
      await exportShareCard(
        {
          title: docName || '未命名流程图',
          nodes: nodes.map((n) => {
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
  const dockCommands = useMemo<CommandItem[]>(
    () => [
      { id: 'layout', title: '整理布局', group: '视图', hint: '一键 dagre', run: handleRunLayout },
      { id: 'view-talk', title: `切换到${view === 'flow' ? '话术层' : '结构层'}`, group: '视图', run: () => handleViewChange(view === 'flow' ? 'talk' : 'flow') },
      { id: 'theme', title: `切换到${themeVal === 'dark' ? '浅色' : '深色'}主题`, group: '视图', run: toggleTheme },
      { id: 'grid', title: gridVisible ? '隐藏网格' : '显示网格', group: '视图', run: () => setGridVisible(!gridVisible) },
      { id: 'snap', title: snapEnabled ? '关闭网格吸附' : '开启网格吸附', group: '视图', run: () => setSnap(!snapEnabled) },
      { id: 'mode', title: mode === 'edit' ? '进入情景推演' : '返回编辑模式', group: '视图', run: () => setMode(mode === 'edit' ? 'scenario' : 'edit') },
      { id: 'add-step', title: '新建：步骤节点', group: '编辑', run: () => addAtCenter('step') },
      { id: 'add-decision', title: '新建：分支决策', group: '编辑', run: () => addAtCenter('decision') },
      { id: 'add-start', title: '新建：开始节点', group: '编辑', run: () => addAtCenter('io-start') },
      { id: 'add-end', title: '新建：结束节点', group: '编辑', run: () => addAtCenter('io-end') },
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
      snapEnabled, setSnap, mode, setMode, addAtCenter, undo, redo, setManageOpen,
      handleExport, handleExportPng, handleShareCard, handleBack,
    ]
  );

  const canEditGraph = editable && mode === 'edit';

  return (
    <div className="app">
      <VariableDock
        docName={docName}
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
        {nodes.length === 0 && (
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
          variables={variables}
          scenario={scenario}
          onNodesChange={onNodesChange as (c: NodeChange<SopFlowNode>[]) => void}
          onEdgesChange={onEdgesChange as (c: EdgeChange<Edge>[]) => void}
          onConnect={handleConnect}
          onReconnect={handleReconnect}
          onEdgeRename={renameEdge}
          onPaneDoubleClick={handlePaneDoubleClick}
          onPaneClickClear={handlePaneClickClear}
          onEdgeTypeApply={handleEdgeTypeApply}
          defaultEdgeType={defaultEdgeType}
          editable={canEditGraph}
          onNodeDragStart={mark}
          onPaintSel={handlePaintSel}
          onDeleteSel={deleteSelected}
          onChangeKind={changeKind}
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
