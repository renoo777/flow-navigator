/** 左侧 Dock：文档头 · 撤销/重做 · 模式/视图切换 · 变量列表（启用集）· 布局面板 · 动作区 */
import type {
  Assignments,
  FlowMode,
  FlowVariable,
  FlowView,
  ScenarioResult,
} from '@flow/core';
import { SegmentedControl, type SegOption } from './components/SegmentedControl';

/** 视图分段：结构层 / 话术层（与模式无关，故提为模块级常量） */
const VIEW_OPTIONS: SegOption<FlowView>[] = [
  { value: 'flow', label: '结构层', title: '紧凑节点视图' },
  { value: 'talk', label: '话术层', title: '客服/客户对话气泡视图' },
];

export interface DockProps {
  docName: string;
  nodesCount: number;
  /** 启用变量数（导航展示） */
  varsCount: number;
  /** 候选变量数（可设未全设时提示 + 管理入口） */
  candidateCount: number;
  /** 只读查看态 */
  readonly: boolean;
  mode: FlowMode;
  onModeChange: (m: FlowMode) => void;
  view: FlowView;
  onViewChange: (v: FlowView) => void;
  variables: FlowVariable[];
  assignments: Assignments;
  /** 情景（scenario/view 模式时非空），用于变量状态徽章 N/A/待定 */
  scenario: ScenarioResult | null;
  onAssign: (nodeId: string, edgeId: string) => void;
  onClearAll: () => void;
  onPreset: () => void;
  onAddNode: () => void;
  /** 返回流程图库（先保存） */
  onBackToLibrary: () => void;
  /** 只读 → 转为编辑（打开为可编辑） */
  onExitView: () => void;
  /** 打开「管理变量」面板（候选勾选） */
  onManageVars: () => void;
  /** 快捷移出变量（不删节点/线） */
  onRemoveVar: (nodeId: string) => void;
  onExport: () => void;
  /** B2 PNG 图片导出（懒加载 html-to-image） */
  onExportPng: () => void;
  /** Build K-③ · 1200×630 社交分享卡导出 */
  onShareCard: () => void;
  /** B3 主题切换 */
  theme: 'light' | 'dark';
  onToggleTheme: () => void;

  /* --- E1 历史 --- */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;

  /* --- E6 网格 + 布局 --- */
  snapEnabled: boolean;
  gridVisible: boolean;
  onSnapChange: (b: boolean) => void;
  onGridChange: (b: boolean) => void;
  /** 一键整理（dagre TB + fitView，US-07/F5） */
  onRunLayout: () => void;
  /** 局部整理（仅选中节点，B5/P1-F14） */
  onLocalLayout: () => void;
  selectedCount: number;
}

const STATUS_TEXT: Record<string, string> = { done: '已选', pending: '待定', na: 'N/A', free: '未选' };

function varStatus(
  v: FlowVariable,
  assignments: Assignments,
  scenario: ScenarioResult | null
): 'done' | 'pending' | 'na' | 'free' {
  if (scenario) {
    if (scenario.naVars.some((x) => x.nodeId === v.nodeId)) return 'na';
    if (scenario.pendingVars.has(v.nodeId)) return 'pending';
  }
  return assignments[v.nodeId] ? 'done' : 'free';
}

export function VariableDock({
  docName,
  nodesCount,
  varsCount,
  candidateCount,
  readonly,
  mode,
  onModeChange,
  view,
  onViewChange,
  variables,
  assignments,
  scenario,
  onAssign,
  onClearAll,
  onPreset,
  onAddNode,
  onBackToLibrary,
  onExitView,
  onManageVars,
  onRemoveVar,
  onExport,
  onExportPng,
  onShareCard,
  theme,
  onToggleTheme,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  snapEnabled,
  gridVisible,
  onSnapChange,
  onGridChange,
  onRunLayout,
  onLocalLayout,
  selectedCount,
}: DockProps) {
  const editable = !readonly;
  const canPreset = mode === 'scenario' && variables.length > 0;
  const hasAssignments = Object.keys(assignments).length > 0;
  /** 情景动作只在情景导航模式出现 */
  const showNavActions = mode === 'scenario';
  /** 编辑态跨视图生效：结构层 / 话术层 都可重排与局部整理 */
  const canEditGraph = editable && mode === 'edit';

  /** 模式分段：只读态下首项是「查看」而非「编辑画布」，编辑入口另行提供 */
  const modeOptions: SegOption<FlowMode>[] = readonly
    ? [
        { value: 'view', label: '查看', title: '只读浏览：可看结构/话术层，不改动任何内容' },
        {
          value: 'scenario',
          label: '情景导航',
          title: '在只读副本上演示：选变量取值走情景（改动不保存）',
        },
      ]
    : [
        { value: 'edit', label: '编辑画布', title: '编辑节点、连线与话术' },
        { value: 'scenario', label: '情景导航', title: '逐个确定变量取值，走通一条完整路线' },
      ];

  return (
    <aside className="dock">
      <div className="dock-head">
        <div className="dock-top">
          {/* Build M：iOS 风格返回按钮 —— chevron 改为 SVG 描边（文字箭头 ← 随字体/系统字形变形，正是"不好看"的根源） */}
          <button
            className="back-btn glass-pill"
            onClick={onBackToLibrary}
            title="返回流程图库（自动保存）"
            aria-label="返回流程图库（自动保存）"
            data-testid="back-to-library"
          >
            <svg className="bb-chev" viewBox="0 0 9 15" aria-hidden="true" focusable="false">
              <path
                d="M7.3 1.1 1.7 7.5l5.6 6.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="bb-text">返回库</span>
          </button>
          {readonly && <span className="ro-badge">只读</span>}
          <span className="dock-top-spacer" />
          <button
            className="hist-btn"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label="撤销"
            title="撤销 Ctrl+Z"
          >
            ⟲
          </button>
          <button
            className="hist-btn"
            onClick={onRedo}
            disabled={!canRedo}
            aria-label="重做"
            title="重做 Ctrl+Shift+Z"
          >
            ⟳
          </button>
          <button
            className="hist-btn"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            title={theme === 'dark' ? '浅色主题' : '深色主题'}
          >
            {theme === 'dark' ? '☀' : '🌙'}
          </button>
        </div>
        <h1 className="dock-title" title={docName}>
          {docName}
        </h1>
        <div className="dock-sub">
          {nodesCount} 节点 · {varsCount} 变量
        </div>
      </div>

      {/* 模式切换：readonly = 查看（纯浏览）或 情景导航（演示赋值）；转编辑单独入口
          Build M：改为水滴玻璃分段控件（容器磨砂 / 滑块高透 + squash&stretch） */}
      <SegmentedControl
        value={mode}
        options={modeOptions}
        onChange={onModeChange}
        ariaLabel="模式切换"
        testId="seg-mode"
      />
      <SegmentedControl
        value={view}
        options={VIEW_OPTIONS}
        onChange={onViewChange}
        size="sm"
        ariaLabel="视图切换"
        testId="seg-view"
      />

      {/* Bug3b：原常驻操作提示（「拖拽移动节点、双击改名…」）删除——
          快捷键已由各按钮 title 承载，常驻文案属噪声，与「合并式精简布局」偏好冲突 */}

      {/* 变量列表（启用集） */}
      <div className="var-head">
        <span className="vh-title">变量 {varsCount > 0 ? `(${varsCount})` : ''}</span>
        {editable && candidateCount > varsCount && (
          <span className="vh-hint">另有 {candidateCount - varsCount} 个候选</span>
        )}
        {editable && candidateCount > 0 && (
          <button className="vh-manage" onClick={onManageVars}>
            管理变量
          </button>
        )}
      </div>
      <div className="var-list">
        {variables.length === 0 && (
          <div className="var-empty">
            {candidateCount > 0
              ? '已停用全部变量，遍历不再停顿。点「管理变量」可重新启用。'
              : '画布上还没有可设变量。给一个节点连出两条分支，即可设为变量。'}
          </div>
        )}
        {variables.map((v, i) => {
          const st = varStatus(v, assignments, scenario);
          return (
            <div key={v.nodeId} className={`var-row st-${st}`} data-var={v.nodeId}>
              <div className="var-name">
                <span className="var-idx">{i + 1}</span>
                <span className="var-label">{v.name}</span>
                <span className={`var-badge ${st}`}>{STATUS_TEXT[st]}</span>
                {editable && (
                  <button
                    className="var-x"
                    onClick={() => onRemoveVar(v.nodeId)}
                    aria-label={`移出变量：${v.name}`}
                    title="移出变量（不删除节点与分支，可在管理变量中恢复）"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="var-opts">
                {v.options.map((o) => {
                  const on = assignments[v.nodeId] === o.edgeId;
                  return (
                    <button
                      key={o.edgeId}
                      className={`opt ${on ? 'on' : ''}`}
                      disabled={st === 'na' || mode === 'edit' || mode === 'view'}
                      onClick={() => onAssign(v.nodeId, o.edgeId)}
                      title={on ? '取消该取值' : `沿「${o.label}」继续演示`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* 整理 + 网格（编辑态 · 结构层）：一键 dagre TB 布局（US-07/F5） */}
      {canEditGraph && (
        <div className="dock-box" data-testid="layout-box">
          <div className="db-title">画布整理</div>
          <div className="db-run">
            <button className="ghost" onClick={onRunLayout} disabled={nodesCount === 0}>
              ⟳ 整理布局
            </button>
            <button
              className="ghost"
              onClick={onLocalLayout}
              disabled={selectedCount === 0}
              title="只整理当前选中节点（与全图布局相对位置一致）"
            >
              ⟲ 局部整理
            </button>
          </div>
          <div className="db-toggles">
            <label className="chk">
              <input
                type="checkbox"
                checked={snapEnabled}
                onChange={(e) => onSnapChange(e.target.checked)}
              />
              网格吸附
            </label>
            <label className="chk">
              <input
                type="checkbox"
                checked={gridVisible}
                onChange={(e) => onGridChange(e.target.checked)}
              />
              显示网格
            </label>
          </div>
        </div>
      )}

      {/* 编辑动作 */}
      {editable && (
        <div className="dock-actions">
          <button className="ghost" onClick={onAddNode}>
            ＋ 添加节点
          </button>
        </div>
      )}
      {readonly && (
        <div className="dock-actions">
          <button className="ghost" onClick={onExitView} title="退出只读，进入编辑（此后改动会保存）">
            转为编辑
          </button>
        </div>
      )}
      {/* 情景导航动作（仅 scenario 模式；edit/view 隐藏） */}
      {showNavActions && (
        <div className="dock-actions" data-testid="scenario-actions">
          <button
            className="ghost"
            onClick={onPreset}
            disabled={!canPreset}
            title={!variables.length ? '当前没有启用变量' : '一键还原示例深路径'}
          >
            一键示例赋值
          </button>
          <button className="ghost" onClick={onClearAll} disabled={!hasAssignments}>
            清除赋值
          </button>
        </div>
      )}

      {/* 文件区 */}
      <div className="dock-divider" />
      <div className="dock-actions" data-testid="file-actions">
        <button className="ghost" onClick={onExport} title="导出当前流程图为 JSON 备份">
          导出 JSON
        </button>
        <button className="ghost" onClick={onExportPng} disabled={nodesCount === 0} title="导出当前流程图为 PNG 图片（含变量名，可直接喂公众号）">
          导出 PNG
        </button>
        <button
          className="ghost"
          onClick={onShareCard}
          disabled={nodesCount === 0}
          data-testid="share-card"
          title="生成 1200×630 社交分享卡（深色品牌底 + 流程缩略 + 统计）"
        >
          分享图
        </button>
      </div>
    </aside>
  );
}
