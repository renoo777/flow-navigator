/** 左侧 Dock：文档头 · 撤销/重做 · 模式/视图切换 · 变量列表（启用集）· 布局面板 · 动作区 */
import { useState } from 'react';
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
  /** 就地改名（Bug3）：双击标题进入编辑，Enter/失焦提交；只读态不提供 */
  onRename: (name: string) => void;
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
  /** 全图视角（true=路线外不压暗），仅情景导航模式有意义 */
  focusAll: boolean;
  onToggleFocus: () => void;
  /** 情景步进历史（M3）：有序决策序列与回退/前进 */
  stepsCount: number;
  redoCount: number;
  onStepBack: () => void;
  onStepForward: () => void;
  onAssign: (nodeId: string, edgeId: string, visit?: number) => void;
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
  /** 0918 · 情景演示动画导出 GIF（按路线重放逐帧截屏；仅 scenario 有意义） */
  onExportGif: () => void;
  /** GIF 导出进行中（按钮禁用 + 显示进度） */
  gifBusy: boolean;
  /** 导出进度文本（如 12/34）；null = 未在导出 */
  gifProgress: string | null;
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

const STATUS_TEXT: Record<string, string> = { done: '已选', pending: '待定', na: '未经过', free: '未选' };

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

/** 变量级联展示（用户拍板 2026-09-09）：情景导航下，当前路线走不到的变量
 *  （naVars=「未经过」）不占列表位，只显示已选 + 待定；上层变量换值后
 *  computeScenario 重算，下游变量随可达性自动出现/消失。编辑态 scenario
 *  为 null，展示全量启用变量（此时无路线概念）。 */
function visibleVars(
  variables: FlowVariable[],
  scenario: ScenarioResult | null
): FlowVariable[] {
  if (!scenario) return variables;
  const na = new Set(scenario.naVars.map((x) => x.nodeId));
  return variables.filter((v) => !na.has(v.nodeId));
}

export function VariableDock({
  docName,
  onRename,
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
  focusAll,
  onToggleFocus,
  stepsCount,
  redoCount,
  onStepBack,
  onStepForward,
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
  onExportGif,
  gifBusy,
  gifProgress,
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
  const shownVars = visibleVars(variables, scenario);
  /** Bug3：双击标题就地改名 —— setDocName 已落库+镜像，这里只补触发点 */
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(docName);
  const commitRename = () => {
    setRenaming(false);
    const clean = renameDraft.trim();
    if (clean && clean !== docName) onRename(clean);
  };
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
        {renaming ? (
          <input
            className="dock-title-input"
            data-testid="doc-title-input"
            value={renameDraft}
            autoFocus
            maxLength={60}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') {
                setRenameDraft(docName);
                setRenaming(false);
              }
            }}
            aria-label="流程图名称"
          />
        ) : (
          <h1
            className={`dock-title${editable ? ' renamable' : ''}`}
            title={editable ? `${docName}（双击重命名）` : docName}
            data-testid="doc-title"
            onDoubleClick={
              editable
                ? () => {
                    setRenameDraft(docName);
                    setRenaming(true);
                  }
                : undefined
            }
          >
            {docName}
          </h1>
        )}
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
        {/* 计数跟随列表（级联隐藏后只见「当前路线上的变量」，与下方条目一致） */}
        <span className="vh-title">变量 {shownVars.length > 0 ? `(${shownVars.length})` : ''}</span>
        {editable && candidateCount > varsCount && (
          <span className="vh-hint">另有 {candidateCount - varsCount} 个候选</span>
        )}
        <span className="dock-top-spacer" />
        {/* 情景导航：视角切换 + 重置（原「清除赋值」在底部易被忽略，上移到变量区头部） */}
        {showNavActions && (
          <>
            <button
              className="vh-focus"
              onClick={onToggleFocus}
              data-testid="focus-toggle"
              title={focusAll ? '回到「仅路径」视角：路线之外压暗' : '切到「全图」视角：保留路线强调，不再压暗其他内容'}
            >
              {focusAll ? '仅路径' : '全图'}
            </button>
            <button
              className="vh-reset"
              onClick={onClearAll}
              disabled={!hasAssignments}
              data-testid="reset-nav"
              aria-label="重置导航"
              title="清空所有已选分支，从入口重新开始"
            >
              ⟲
            </button>
          </>
        )}
        {editable && candidateCount > 0 && (
          <button className="vh-manage" onClick={onManageVars}>
            管理变量
          </button>
        )}
      </div>
      {/* 情景步进条（M3）：上一步/下一步 + 决策计数；有历史或可恢复时出现 */}
      {showNavActions && (stepsCount > 0 || redoCount > 0) && (
        <div className="step-bar" data-testid="step-bar">
          <button
            className="sb-btn"
            onClick={onStepBack}
            disabled={stepsCount === 0}
            data-testid="step-back"
            title="回退一条决策（可穿越回路）"
          >
            ⟲ 上一步
          </button>
          <span className="sb-count">决策 {stepsCount}{redoCount > 0 ? ` · 可恢复 ${redoCount}` : ''}</span>
          <button
            className="sb-btn"
            onClick={onStepForward}
            disabled={redoCount === 0}
            data-testid="step-forward"
            title="恢复被回退的决策"
          >
            下一步 ⟳
          </button>
        </div>
      )}

      <div className="var-list">
        {variables.length === 0 && (
          <div className="var-empty">
            {candidateCount > 0
              ? '已停用全部变量，遍历不再停顿。点「管理变量」可重新启用。'
              : '画布上还没有可设变量。给一个节点连出两条分支，即可设为变量。'}
          </div>
        )}
        {/* 级联隐藏：启用变量非空、但当前路线全都没经过 → 明确告知而非空白 */}
        {variables.length > 0 && shownVars.length === 0 && (
          <div className="var-empty" data-testid="vars-all-hidden">
            当前路线没有经过任何变量。换一个上游取值，或点「管理变量」查看全部。
          </div>
        )}
        {shownVars.map((v, i) => {
          const st = varStatus(v, assignments, scenario);
          /* 环上第 N 次经过该判断点（N>0）：徽章标注，让用户知道这是回路中的再次决策 */
          const visit = scenario?.pendingVisits?.[v.nodeId] ?? 0;
          return (
            <div key={v.nodeId} className={`var-row st-${st}`} data-var={v.nodeId}>
              <div className="var-name">
                <span className="var-idx">{i + 1}</span>
                <span className="var-label">{v.name}</span>
                <span className={`var-badge ${st}`}>
                  {STATUS_TEXT[st]}{st === 'pending' && visit > 0 ? ` · 第${visit + 1}次` : ''}
                </span>
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
                      /* N/A（未经过）不再禁用：回路/分支未接通时仍可预选，
                         否则用户失去赋值入口 → 起点判错会演变成永久死锁 */
                      disabled={mode === 'edit' || mode === 'view'}
                      onClick={() =>
                        onAssign(
                          v.nodeId,
                          o.edgeId,
                          st === 'pending' ? scenario?.pendingVisits?.[v.nodeId] : undefined
                        )
                      }
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
            data-testid="preset-btn"
            title={
              !variables.length
                ? '当前没有启用变量'
                : '从入口自动走一条示例路线：每个判断点取分支最多、走得最远的一条'
            }
          >
            一键示例路线
          </button>
          <button
            className="ghost"
            onClick={onExportGif}
            disabled={gifBusy}
            data-testid="export-gif-btn"
            title="把画布此刻的高亮 + 流动状态导出为 GIF 动图（无缝循环，直线/曲线/肘线各自保留，可直接发微信/PPT）"
          >
            {gifBusy ? `导出中 ${gifProgress ?? ''}…` : '导出 GIF'}
          </button>
        </div>
      )}

      {/* 文件区 */}
      <div className="dock-divider" />
      <div className="dock-actions" data-testid="file-actions">
        <button className="ghost" onClick={onExport} title="导出当前流程图为 JSON 备份">
          导出 JSON
        </button>
        <button className="ghost" onClick={onExportPng} disabled={nodesCount === 0} data-testid="export-png-btn" title="导出当前流程图为 PNG 图片（含变量名，可直接喂公众号）">
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
