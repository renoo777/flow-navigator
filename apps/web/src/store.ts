/** 全局状态（zustand）：多图库 + 编辑器内容态 + 变量启用集合 + 自动保存（IDB）
 *  库 = FlowDoc 存 IndexedDB「docs」；应用元数据（上次打开图）存「kv」。
 *  编辑器只缓存当前打开的一份 FlowContent；变更 500ms debounce 落库。 */
import { create } from 'zustand';
import {
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import {
  assignmentsOf,
  stepsOfAssignments,
  buildGraph,
  deriveVariableCandidates,
  estimateNodeSize,
  layoutGraph,
  resolveOverlaps,
  resolveVariables,
  suggestScenarioSteps,
  SAMPLE_EDGE_DEFS,
  SAMPLE_NODE_DEFS,
  edgeIdOf,
  TALK_W_MAX,
  TALK_W_MIN,
  type Assignments,
  type FlowMode,
  type FlowView,
  type NodeKind,
  type ScenarioStep,
} from '@flow/core';
import {
  EDGE_TYPE_DEFAULT,
  isExprNode,
  type EdgeRoutePatch,
  type ExprType,
  type SopFlowNode,
} from '@flow/canvas';
import { DOCS_STORE, KV_STORE, dbDelete, dbGet, dbGetAll, dbPut } from './idb';
import { isDesktop, vaultLoad, vaultPath, vaultSave } from './vault';

let uid = 1;
const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${uid++}`;

/** 默认节点文案（US-01：步骤/决策/开始/结束） */
export const NODE_PLACEHOLDER: Record<NodeKind, string> = {
  step: '新步骤',
  decision: '新决策？',
  'io-start': '开始',
  'io-end': '结束',
};

/* ============================================================
 * 文档模型
 * ============================================================ */
export interface FlowContent {
  nodes: SopFlowNode[];
  edges: Edge[];
  assignments: Assignments;
  /** 情景导航有序决策（可选，旧数据缺省 → 从 assignments 一次性迁移） */
  steps?: ScenarioStep[];
  view: FlowView;
  /** edit / scenario（view 是打开态，不入库） */
  mode: 'edit' | 'scenario';
  /** null=未初始化（兼容旧数据 → 全部候选启用）；[]=明确不启用 */
  enabledVarNodeIds: string[] | null;
  /** 本图新连线的默认样式 */
  defaultEdgeType: string;
}

export interface FlowDoc {
  id: string;
  name: string;
  /** 分组名，'' = 未分组 */
  group: string;
  createdAt: number;
  updatedAt: number;
  flow: FlowContent;
}

/** 文档 id（复用旧单图 localStorage 迁移入口也走这里） */
export const docIdOf = () => `d${Date.now().toString(36)}${uid++}`;

/** 新空白内容态（供「新建空白流程图」） */
export function blankContent(): FlowContent {
  return {
    nodes: [],
    edges: [],
    assignments: {},
    steps: [],
    view: 'flow',
    mode: 'edit',
    enabledVarNodeIds: null,
    defaultEdgeType: EDGE_TYPE_DEFAULT,
  };
}

/* ============================================================
 * 内容归一化（读库 / 导入 / 迁移共用）——脏字段剔除 + 悬挂引用清理
 * ============================================================ */
const VALID_KINDS = ['io-start', 'io-end', 'decision', 'step'];
const VALID_EDGE_TYPES = new Set(['default', 'straight', 'step', 'smoothstep']);

/** 节点自定义配色（null=用 kind 语义默认色）。仅存合法颜色串。 */
export interface NodePaint {
  bg?: string;
  stroke?: string;
  text?: string;
}
function cleanPaint(raw: unknown): NodePaint | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: NodePaint = {};
  const isColor = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (isColor(o.bg)) out.bg = o.bg;
  if (isColor(o.stroke)) out.stroke = o.stroke;
  if (isColor(o.text)) out.text = o.text;
  return Object.keys(out).length ? out : null;
}

/** WP4 表达节点归一（note/image/label）：
 *  便签/标注 label 可空（渲染兜底占位）；贴图必须 src；标注保留 arrow 世界坐标。
 *  统一清洗 position/posByView/color；不入库字段（editing/locked/_mark）一律丢弃。 */
const EXPR_TYPES = ['note', 'image', 'label'];

function normalizeExprNode(raw: Record<string, unknown>, type: 'note' | 'image' | 'label'): SopFlowNode | null {
  const d = (raw.data ?? {}) as Record<string, unknown>;
  const pos = (raw.position ?? {}) as Record<string, unknown>;
  const color = cleanPaint(d.color);
  const posByView = cleanPosByView(raw.posByView);
  const node = {
    id: raw.id,
    type,
    position: { x: Number(pos.x) || 0, y: Number(pos.y) || 0 },
    ...(posByView ? { posByView } : {}),
    data: {} as Record<string, unknown>,
    selected: false,
  };
  if (type === 'image') {
    if (typeof d.src === 'string' && d.src.trim()) node.data.src = d.src.trim();
    if (typeof d.label === 'string' && d.label.trim()) node.data.label = d.label.trim();
  } else {
    node.data.label = typeof d.label === 'string' ? d.label : '';
  }
  if (type === 'label') {
    const a = d.arrow as Record<string, unknown> | undefined;
    if (a && typeof a === 'object' && Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y))) {
      node.data.arrow = { x: Math.round(Number(a.x)), y: Math.round(Number(a.y)) };
    }
  }
  if (color) node.data.color = color;
  return node as unknown as SopFlowNode;
}

function normalizeNode(raw: unknown): SopFlowNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const d = (n.data ?? {}) as Record<string, unknown>;
  if (typeof n.id !== 'string' || typeof d !== 'object' || d === null) return null;
  /* WP4：自由表达节点走独立清洗（type 判别；旧数据无 type 一律按 sop） */
  if (typeof n.type === 'string' && EXPR_TYPES.includes(n.type)) {
    return normalizeExprNode(n, n.type as 'note' | 'image' | 'label');
  }
  const kind = VALID_KINDS.includes(d.kind as string) ? (d.kind as NodeKind) : 'step';
  const talk = Array.isArray(d.talk)
    ? (d.talk as unknown[])
        .filter(
          (t): t is { side: 'agent' | 'cust'; text: string } =>
            !!t &&
            typeof t === 'object' &&
            ((t as Record<string, unknown>).side === 'agent' ||
              (t as Record<string, unknown>).side === 'cust') &&
            typeof (t as Record<string, unknown>).text === 'string'
        )
        .map((t) => ({ side: t.side, text: t.text }))
    : [];
  const pos = (n.position ?? {}) as Record<string, unknown>;
  const color = cleanPaint(d.color);
  /** Bug2：双视图坐标必须一起持久化，否则刷新后话术层布局丢失、又退回重叠 */
  const posByView = cleanPosByView(n.posByView);
  /** H 轮：话术卡片的角色名 / 左右方向 / 宽度，同样要持久化 */
  const roles = cleanRoles(d.roles);
  const talkDir = d.talkDir === 'agentRight' ? 'agentRight' : null;
  const talkW =
    Number.isFinite(Number(d.talkW)) && Number(d.talkW) >= TALK_W_MIN
      ? Math.min(TALK_W_MAX, Math.round(Number(d.talkW)))
      : null;
  /* keep-shape 锁定尺寸必须持久化：飞书导入卡靠 data.size 保形，丢了会在
     保存/重载后退回文本自适应扁卡、居中失效（v0.1.7 用户实测回归） */
  const size =
    d.size &&
    typeof d.size === 'object' &&
    Number.isFinite(Number((d.size as Record<string, unknown>).w)) &&
    Number((d.size as Record<string, unknown>).w) > 0 &&
    Number.isFinite(Number((d.size as Record<string, unknown>).h)) &&
    Number((d.size as Record<string, unknown>).h) > 0
      ? { w: Math.round(Number((d.size as Record<string, unknown>).w)), h: Math.round(Number((d.size as Record<string, unknown>).h)) }
      : null;
  /* 点1 每行字数：2~30 收敛为整数，非法值直接丢弃（不启用） */
  const wrapColsRaw = Number(d.wrapCols);
  const wrapCols =
    Number.isFinite(wrapColsRaw) && wrapColsRaw >= 2 && wrapColsRaw <= 30
      ? Math.round(wrapColsRaw)
      : null;
  return {
    id: n.id,
    type: 'sop',
    position: { x: Number(pos.x) || 0, y: Number(pos.y) || 0 },
    ...(posByView ? { posByView } : {}),
    data: {
      label: typeof d.label === 'string' && d.label.trim() ? d.label : '未命名',
      kind,
      talk,
      editing: false,
      ...(color ? { color } : {}),
      ...(roles ? { roles } : {}),
      ...(talkDir ? { talkDir } : {}),
      ...(talkW ? { talkW } : {}),
      ...(size ? { size } : {}),
      ...(wrapCols ? { wrapCols } : {}),
    },
    selected: false,
  };
}

/** 清洗自定义说话方称呼：只收非空字符串，空值丢弃走默认「客服 / 客户」 */
function cleanRoles(raw: unknown): { agent?: string; cust?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: { agent?: string; cust?: string } = {};
  (['agent', 'cust'] as const).forEach((k) => {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 8);
  });
  return Object.keys(out).length ? out : null;
}

/** 清洗双视图坐标：只保留合法数字对，脏数据丢弃（不要带 NaN 进画布） */
function cleanPosByView(raw: unknown): SopFlowNode['posByView'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: Record<string, { x: number; y: number }> = {};
  (['flow', 'talk'] as const).forEach((k) => {
    const p = o[k] as Record<string, unknown> | undefined;
    if (p && typeof p === 'object' && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
      out[k] = { x: Number(p.x), y: Number(p.y) };
    }
  });
  return Object.keys(out).length ? out : null;
}

function normalizeEdge(raw: unknown): Edge | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.source !== 'string' || typeof e.target !== 'string') return null;
  /* 肘线统一走 smoothstep（圆角）：旧图数据里的 step（直角）读入即迁移 */
  const rawT = typeof e.type === 'string' && VALID_EDGE_TYPES.has(e.type) ? e.type : null;
  const t = rawT === 'step' ? 'smoothstep' : (rawT ?? EDGE_TYPE_DEFAULT);
  const out: Edge = {
    id: typeof e.id === 'string' && e.id ? e.id : edgeIdOf(e.source, e.target),
    source: e.source,
    target: e.target,
    type: t,
    label: typeof e.label === 'string' ? e.label : '',
  };
  /* 锚点：sourceHandle/targetHandle 是「钉住的端点」坐标，data.anchorPinned 是钉住标记。
     早期 normalizeEdge 只留四个字段，导入/镜像恢复会把它们抹掉 —— 手动摆好的端点一刷新就没了。 */
  if (typeof e.sourceHandle === 'string' && e.sourceHandle) out.sourceHandle = e.sourceHandle;
  if (typeof e.targetHandle === 'string' && e.targetHandle) out.targetHandle = e.targetHandle;
  if (e.data && typeof e.data === 'object') out.data = e.data as Edge['data'];
  return out;
}

/** 清洗「裸 JSON 内容态」→ 可用 FlowContent（null=结构不合法） */
export function sanitizeContent(raw: unknown): FlowContent | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.nodes) || !Array.isArray(s.edges)) return null;
  const nodes = (s.nodes as unknown[]).map(normalizeNode).filter((x): x is SopFlowNode => x !== null);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = (s.edges as unknown[])
    .map(normalizeEdge)
    .filter((e): e is Edge => e !== null && nodeIds.has(e.source) && nodeIds.has(e.target));
  const edgeIds = new Set(edges.map((e) => e.id));
  const assignments: Assignments = {};
  if (s.assignments && typeof s.assignments === 'object') {
    Object.entries(s.assignments as Record<string, unknown>).forEach(([k, v]) => {
      if (nodeIds.has(k) && typeof v === 'string' && edgeIds.has(v)) assignments[k] = v;
    });
  }
  /* 决策序列：优先读 steps；旧数据/不合法时从 assignments 派生（每节点一条） */
  let steps: ScenarioStep[] = [];
  if (Array.isArray(s.steps)) {
    steps = (s.steps as unknown[]).filter(
      (x): x is ScenarioStep =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as ScenarioStep).nodeId === 'string' &&
        typeof (x as ScenarioStep).edgeId === 'string' &&
        nodeIds.has((x as ScenarioStep).nodeId) &&
        edgeIds.has((x as ScenarioStep).edgeId)
    );
  } else {
    steps = stepsOfAssignments(assignments);
  }
  let enabled: string[] | null = null;
  if (Array.isArray(s.enabledVarNodeIds)) {
    enabled = (s.enabledVarNodeIds as unknown[]).filter(
      (x): x is string => typeof x === 'string' && nodeIds.has(x)
    );
  } else if (Array.isArray(s.enabledVars)) {
    enabled = (s.enabledVars as unknown[]).filter(
      (x): x is string => typeof x === 'string' && nodeIds.has(x)
    );
  }
  return {
    nodes,
    edges,
    assignments,
    steps,
    view: s.view === 'talk' ? 'talk' : 'flow',
    mode: s.mode === 'scenario' ? 'scenario' : 'edit',
    enabledVarNodeIds: enabled,
    defaultEdgeType:
      typeof s.defaultEdgeType === 'string' && VALID_EDGE_TYPES.has(s.defaultEdgeType)
        ? s.defaultEdgeType === 'step'
          ? 'smoothstep'
          : (s.defaultEdgeType as string)
        : EDGE_TYPE_DEFAULT,
  };
}

/** 旧 Build C 单图 localStorage（flow-app:v1）→ 库第一张图（迁移一次） */
export const LEGACY_KEY = 'flow-app:v1';
async function migrateLegacy(): Promise<void> {
  const isBrowser = typeof window !== 'undefined' && typeof localStorage !== 'undefined';
  if (!isBrowser) return;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: unknown };
    const content = sanitizeContent((parsed as { state?: unknown })?.state ?? parsed);
    if (!content || content.nodes.length === 0) {
      localStorage.removeItem(LEGACY_KEY); // 空壳直接丢弃
      return;
    }
    const title =
      typeof (parsed as { state?: { title?: unknown } })?.state?.title === 'string'
        ? ((parsed as { state?: { title?: unknown } }).state?.title as string)
        : '迁移的流程图';
    const doc: FlowDoc = {
      id: docIdOf(),
      name: title,
      group: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      flow: content,
    };
    const docs = await dbGetAll<FlowDoc>(DOCS_STORE);
    if (!docs.length) await dbPut(DOCS_STORE, doc); // 库为空才迁移，避免重复
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 迁移失败静默，旧 key 保留等下次 */
  }
}

/* ============================================================
 * 桌面版「图库文件镜像」——更新/重装/清 WebView 数据都不丢图
 * ============================================================ */
interface VaultPayload {
  app?: string;
  kind?: string;
  version?: number;
  savedAt?: number;
  activeDocId?: string | null;
  docs?: unknown[];
}

/** 镜像里的单个图过一遍 sanitize：结构坏的丢弃，绝不把脏数据写回库 */
function normalizeDoc(raw: unknown): FlowDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || !d.id) return null;
  const flow = sanitizeContent(d.flow);
  if (!flow) return null;
  return {
    id: d.id,
    name: typeof d.name === 'string' && d.name.trim() ? d.name : '未命名流程图',
    group: typeof d.group === 'string' ? d.group : '',
    createdAt: Number(d.createdAt) || Date.now(),
    updatedAt: Number(d.updatedAt) || Date.now(),
    flow,
  };
}

/** 立刻把当前整份图库写到镜像文件（同步前端内存里的最新内容，避免漏掉还没落 IDB 的改动） */
async function mirrorNow(): Promise<void> {
  if (!isDesktop) return;
  const s = useAppStore.getState();
  const docs = await dbGetAll<FlowDoc>(DOCS_STORE);
  /* 当前打开的图以内存态为准（未被保存的部分也要进镜像）；只读演示态不改内容 */
  const snap = s.docId && !s.readonly ? snapshotOf(s) : null;
  const merged = docs.map((d) =>
    snap && d.id === s.docId ? { ...d, updatedAt: Date.now(), flow: snap } : d
  );
  const payload = {
    app: 'flow-navigator',
    kind: 'library',
    version: 1,
    savedAt: Date.now(),
    activeDocId: s.docId,
    docs: merged,
  };
  await vaultSave(JSON.stringify(payload));
}

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
/** 合并多次改动的镜像写盘（库操作都会打到这里） */
function scheduleMirror(): void {
  if (!isDesktop) return;
  if (mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    void mirrorNow();
  }, 1200);
}

/**
 * 启动时双向补齐：
 * - 库里有、文件没有 → 写进文件（首次升级就是这条）
 * - 文件有、库里没有 → 补回库（更新/重装/清了 WebView 数据后靠这条救回来）
 * - 两边都有 → 取 updatedAt 新的那份
 */
async function restoreLibraryFromVault(): Promise<{ restored: number; path: string | null }> {
  const empty = { restored: 0, path: null as string | null };
  if (!isDesktop) return empty;
  const path = await vaultPath();
  const raw = await vaultLoad();
  if (!raw) {
    scheduleMirror(); // 还没有镜像 → 现在补一份
    return { restored: 0, path };
  }
  let parsed: VaultPayload;
  try {
    parsed = JSON.parse(raw) as VaultPayload;
  } catch {
    return { restored: 0, path };
  }
  const remoteDocs = (Array.isArray(parsed.docs) ? parsed.docs : [])
    .map(normalizeDoc)
    .filter((d): d is FlowDoc => d !== null);
  const localDocs = await dbGetAll<FlowDoc>(DOCS_STORE);
  if (!remoteDocs.length) {
    if (localDocs.length) await mirrorNow();
    return { restored: 0, path };
  }
  const localMap = new Map(localDocs.map((d) => [d.id, d]));
  let restored = 0;
  for (const remote of remoteDocs) {
    const local = localMap.get(remote.id);
    if (!local) {
      await dbPut(DOCS_STORE, remote);
      restored += 1;
    } else if (remote.updatedAt > local.updatedAt) {
      await dbPut(DOCS_STORE, remote);
    }
  }
  /* 上次打开的图：k/v 丢了就从镜像补（否则用户会以为「图都在，只是没打开」） */
  if (parsed.activeDocId) {
    const cur = await dbGet<{ key: string; value: string }>(KV_STORE, 'activeDocId');
    if (!cur?.value && (await dbGet<FlowDoc>(DOCS_STORE, parsed.activeDocId))) {
      await dbPut(KV_STORE, { key: 'activeDocId', value: parsed.activeDocId });
    }
  }
  await mirrorNow(); // 写回并集，两侧立刻一致
  return { restored, path };
}

/* ============================================================
 * Store
 * ============================================================ */
export interface AppState {
  /** 当前打开文档 id；null = 库首页 */
  docId: string | null;
  docName: string;
  docGroup: string;
  /** 只读查看态（view 模式打开） */
  readonly: boolean;

  nodes: SopFlowNode[];
  edges: Edge[];
  mode: FlowMode;
  view: FlowView;
  assignments: Assignments;
  /** 情景导航有序决策序列（真源）：支持回路上同一判断点多次不同选择；assignments 为派生视图 */
  steps: ScenarioStep[];
  /** 被「上一步」弹出、可被「下一步」恢复的决策 */
  redoSteps: ScenarioStep[];
  /** 变量启用集合（null=未初始化，全部候选） */
  enabledVarNodeIds: string[] | null;
  defaultEdgeType: string;
  /** 新建菜单锚点（client 坐标），null=关闭 */
  picker: { x: number; y: number } | null;
  /** 应用就绪（IDB 打开 + 旧数据迁移 + 镜像比对 + 自动恢复上次图 完成） */
  ready: boolean;
  /** 桌面版图库镜像文件路径（Web 版为 null） */
  vaultPath: string | null;
  /** 启动恢复提示（从镜像文件补回了几张图），null=无需打扰用户 */
  vaultNotice: string | null;

  /* --- E1 撤销/重做（快照 JSON 栈，只覆盖图形内容）--- */
  undoStack: string[];
  redoStack: string[];
  /* --- 编辑器运行时偏好（不入库）--- */
  snapEnabled: boolean;
  gridVisible: boolean;
  /** 情景导航视角：false=仅路径（路线外压暗，默认）；true=全图（保留路线强调，不压暗） */
  focusAll: boolean;
  /** 主题（B3/P1-F18） */
  theme: 'light' | 'dark';
  setTheme: (t: 'light' | 'dark') => void;
  toggleTheme: () => void;

  // --- 画布变更（RF 受控）---
  onNodesChange: (changes: NodeChange<SopFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  onConnect: (conn: Connection) => void;

  // --- 动作 ---
  setMode: (m: FlowMode) => void;
  setView: (v: FlowView) => void;
  /** Bug2 渲染校准：切视图后用 RF 实测尺寸（measured）复检重叠并推开 ——
   *  estimateNodeSize 对话术卡真实渲染高有低估（实测差 ~50px），纯估算防重叠
   *  在 fitView 缩放等场景会残留；无重叠时零位移。由 FlowCanvas 在 view 稳定后调。 */
  calibrateViewOverlaps: () => void;
  /** visit：环上第几次经过（pending 时由 scenario.pendingVisits 提供）；缺省=改最后一次决策并截断其后 */
  assign: (nodeId: string, edgeId: string, visit?: number) => void;
  clearAssignments: () => void;
  presetAssignments: () => void;
  /** 情景步进：回退/恢复一条决策（回路导航用） */
  stepBack: () => void;
  stepForward: () => void;
  relayout: () => void;
  /** 局部整理：只重排选中节点（在完整图布局中取其位置 + bbox 中心偏移补偿），入历史 */
  localRelayout: () => void;
  openPicker: (x: number, y: number) => void;
  closePicker: () => void;
  addNodeAt: (kind: NodeKind, x: number, y: number) => void;
  /** WP4：新建自由表达节点（便签 note / 贴图 image / 标注 label），入历史并进入编辑态 */
  addExprNode: (type: ExprType, x: number, y: number) => void;
  renameEdge: (edgeId: string, label: string) => void;
  /** 0918 二修：连线描述拖动提交：沿线比例 t∈[0,1] 写入 edge.data.labelT */
  moveEdgeLabel: (edgeId: string, t: number, opts?: { silent?: boolean }) => void;
  /**
   * 0918：把「自动推断出的连线出入侧」静默落到数据层（不进撤销历史、不弹提示）。
   * 目的：导出 JSON / 复制 / 保存都带着侧边信息，重新打开（首帧还没测量出节点尺寸）
   * 时按原侧渲染 —— 否则所有未手动钉住的边会临时退回「下出上进」，看起来就是连线乱了。
   */
  syncEdgeSides: (pairs: { id: string; sourceHandle: string; targetHandle: string }[]) => void;
  afterDelete: (removedNodeIds: string[], removedEdgeIds: string[]) => void;
  /** 拖拽连线端点改连（入历史） */
  onReconnect: (oldEdge: Edge, conn: Connection) => void;
  /** 记录一次「操作前」历史快照（几何动作/拖拽起点前调用） */
  mark: () => void;
  undo: () => void;
  redo: () => void;
  setSnap: (b: boolean) => void;
  setGridVisible: (b: boolean) => void;
  setFocusAll: (b: boolean) => void;
  /** 对齐选中节点（≥2，以外接框为基准） */
  alignSelected: (dir: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom') => void;
  /** 等距分布选中节点（≥3） */
  distributeSelected: (axis: 'h' | 'v') => void;
  /** 批量给节点上色（入历史由调用方控制） */
  paintNodes: (nodeIds: string[], paint: NodePaint | null) => void;
  /** 删除选中节点 + 关联边 + 赋值（入历史） */
  deleteSelected: () => void;
  /** 按 id 列表删除节点 + 关联边 + 赋值（右键菜单专用，入历史） */
  deleteNodes: (ids: string[]) => void;
  /** 转换节点 kind（右键菜单专用，io-start/io-end 唯一性约束，入历史） */
  changeKind: (nodeId: string, kind: NodeKind) => void;
  /** 点1 每行字数换行规则：cols=null 关闭（恢复按宽度自动折行）。入历史 */
  setWrapCols: (nodeId: string, cols: number | null) => void;
  /** 点空白清空全部选中（不入历史） */
  clearSelection: () => void;
  /** 按方向键微调选中节点（入历史由调用方控制 repeat） */
  nudgeSelected: (dx: number, dy: number) => void;
  /** 清空当前图画布（入历史） */
  clearCanvas: () => void;
  /** 粘贴一组重映射后的节点/边（入历史） */
  applyPaste: (nodes: SopFlowNode[], edges: Edge[]) => void;

  /** 启动：IDB 迁移 + 恢复上次打开的图 */
  boot: () => Promise<void>;

  // --- 库操作（IDB）---
  /** 打开文档。readonly=true → 只读查看（mode='view'）；false → 编辑打开（mode=doc.flow.mode） */
  openDoc: (id: string, readonly?: boolean) => Promise<void>;
  /** 返回库（保存由 autosave 承担）；清 kv activeDocId */
  closeToLibrary: () => Promise<void>;
  /** 用内容建一张新图并打开 */
  createDoc: (name: string, group: string, content: FlowContent) => Promise<void>;
  /** 从示例 SOP 模板新建（默认全启用变量，不弹引导） */
  createSampleDoc: () => Promise<void>;
  duplicateDoc: (id: string) => Promise<void>;
  renameDoc: (id: string, name: string) => Promise<void>;
  setDocGroup: (id: string, group: string) => Promise<void>;
  deleteDoc: (id: string) => Promise<void>;

  // --- 编辑器级动作 ---
  setDocName: (name: string) => void;
  setDefaultEdgeType: (t: string) => void;
  setEdgeTypes: (edgeIds: string[], t: string) => void;
  /** 端点交还自动（清掉手动钉住的锚点 + 手动折点，整条线交还自动路由） */
  resetEdgeAnchors: (edgeIds: string[]) => void;
  /** WP5b：把本图所有连线一并复位（清空折点 / 端点吸附），一步历史可撤销 */
  resetAllEdgeRoutes: () => void;
  /** WP5 连线编辑：写入折点路由 / 端点锚点 + 把两端钉到当前侧。commit=true 才推历史（每轮拖动只推一次）。 */
  setEdgeRoute: (edgeId: string, patch: EdgeRoutePatch, commit: boolean) => void;
  setEnabledVars: (nodeIds: string[]) => void;
  toggleVarEnabled: (nodeId: string) => void;
  exportJSON: () => string;
  flushSave: () => void;
}

const emptyEditor = {
  docId: null as string | null,
  docName: '未命名流程图',
  docGroup: '',
  readonly: false,
  nodes: [] as SopFlowNode[],
  edges: [] as Edge[],
  mode: 'edit' as FlowMode,
  view: 'flow' as FlowView,
  assignments: {} as Assignments,
  steps: [] as ScenarioStep[],
  redoSteps: [] as ScenarioStep[],
  enabledVarNodeIds: null as string[] | null,
  defaultEdgeType: EDGE_TYPE_DEFAULT,
  picker: null as { x: number; y: number } | null,
  ready: false,
  vaultPath: null as string | null,
  vaultNotice: null as string | null,
  undoStack: [] as string[],
  redoStack: [] as string[],
  snapEnabled: true,
  gridVisible: true,
  focusAll: false,
  theme: 'light' as 'light' | 'dark',
};

export const useAppStore = create<AppState>((set, get) => ({
  ...emptyEditor,

  onNodesChange: (changes) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    // 改名提交（editing:false 的 replace）→ 入历史；编辑中每键的 replace 不入
    const commit = changes.some(
      (c) =>
        c.type === 'replace' &&
        !!c.item &&
        (c.item.data as { editing?: boolean } | undefined)?.editing === false &&
        typeof (c.item.data as { label?: unknown }).label === 'string'
    );
    if (removed.length || commit) pushHistory();
    set((st) => {
      let nodes = applyNodeChanges(changes, st.nodes);
      let edges = st.edges;
      let assignments = st.assignments;
      let steps = st.steps;
      if (removed.length) {
        edges = edges.filter((e) => !removed.includes(e.source) && !removed.includes(e.target));
        assignments = Object.fromEntries(
          Object.entries(assignments).filter(([k]) => !removed.includes(k))
        );
        steps = steps.filter((x) => !removed.includes(x.nodeId));
      }
      return { nodes, edges, assignments, steps };
    });
  },

  onEdgesChange: (changes) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) pushHistory();
    set((st) => {
      let edges = applyEdgeChanges(changes, st.edges);
      let assignments = st.assignments;
      let steps = st.steps;
      if (removed.length) {
        assignments = Object.fromEntries(
          Object.entries(assignments).filter(([, eid]) => !removed.includes(eid))
        );
        steps = steps.filter((x) => !removed.includes(x.edgeId));
      }
      return { edges, assignments, steps };
    });
  },

  onConnect: (conn) => {
    pushHistory();
    set((st) => {
      if (!conn.source || !conn.target) return st;
      /* WP4 兜底：自由表达节点（便签/贴图/标注）是无端口装饰，绝不允许产生流程边
         （UI 层 isValidConnection 已拦，这里双保险防 bypass） */
      const srcNode = st.nodes.find((n) => n.id === conn.source);
      const tgtNode = st.nodes.find((n) => n.id === conn.target);
      if (!srcNode || !tgtNode || isExprNode(srcNode) || isExprNode(tgtNode)) return st;
      const dup = st.edges.some((e) => e.source === conn.source && e.target === conn.target);
      if (dup) return st;
      /* Bug：左右端点连不上。根因 —— 只存 source/target 会丢掉用户实际拉的端口
         （conn.sourceHandle/targetHandle），displayedEdges 便按射线求交自动选侧
         （两节点斜向时多半落到上/下），于是"从左拉到左"出来却挂在上下。
         手工拉线 = 用户明确指定端口 → 保存 handle 并钉住（与 onReconnect 同语义）。 */
      const edge: Edge = {
        id: edgeIdOf(conn.source, conn.target),
        source: conn.source,
        target: conn.target,
        type: st.defaultEdgeType,
        label: '',
        ...(conn.sourceHandle ? { sourceHandle: conn.sourceHandle } : {}),
        ...(conn.targetHandle ? { targetHandle: conn.targetHandle } : {}),
        data: { anchorPinned: true },
      };
      return { edges: addEdge(edge, st.edges) };
    });
  },

  /**
   * 拖动连线端点换节点 / 换边：
   * 只要用户手动拖过，就把这条边的端点「钉住」（data.anchorPinned）——
   * 否则画布每次渲染都按相对位置重算端点，用户刚摆好的位置一挪节点就跳回去。
   */
  onReconnect: (oldEdge, conn) => {
    pushHistory();
    set((st) => ({
      edges: st.edges.map((e) =>
        e.id === oldEdge.id
          ? {
              ...e,
              source: conn.source ?? e.source,
              target: conn.target ?? e.target,
              sourceHandle: conn.sourceHandle ?? e.sourceHandle ?? 'bottom',
              targetHandle: conn.targetHandle ?? e.targetHandle ?? 'top',
              data: { ...(e.data ?? {}), anchorPinned: true },
            }
          : e
      ),
    }));
  },

  setMode: (m) => set({ mode: m }),

  /**
   * 切换视图（结构层 ⇄ 话术层）—— 双视图独立坐标。
   * 旧实现只切标记、共用 position：结构层按 h≈46 布局，切话术后卡片高数倍 → 必然重叠。
   * 现在：离开旧视图时把坐标存进 posByView[旧]，进入新视图时取 posByView[新]。
   * Bug2（用户拍板方案 A）：首次进入某视图不再 dagre 全量重排（会把飞书导入的
   * 原排版整个打掉），改为**继承当前坐标** + resolveOverlaps 最小位移防重叠
   * （话术层卡片更高，挤压处推开一点点）；想要自动重排手动点「整理布局」。
   */
  setView: (v) =>
    set((st) => {
      if (st.view === v) return st;
      const prev = st.view;
      /** 1) 存档：当前坐标写回旧视图槽位 */
      const saved = st.nodes.map((n) => ({
        ...n,
        posByView: {
          ...(n.posByView ?? {}),
          [prev]: { x: n.position.x, y: n.position.y },
        },
      }));
      /** 2) 取档 + 防重叠校验：缺槽节点（首次进入 / 新增）继承当前坐标；
       *     已有槽位也重新校验 —— 结构层可能在上次离开后重新整理/拖动过，
       *     旧槽位会过期（G1 实测：先看话术层 → 结构层重排 → 再切回来，
       *     槽位还是按旧结构层坐标存的 → 残留重叠）。无重叠时零位移。
       *     只校验话术层：结构层是用户的原布局（含飞书导入 keep-shape 坐标，
       *     允许紧凑排布），切回结构层必须逐像素还原，不得被防重叠推挤。 */
      const srcOf = (n: (typeof saved)[number]) => n.posByView?.[v] ?? n.position;
      /* gap=48：estimateNodeSize 对话术卡真实渲染高有低估（textarea/边距抖动），
         12px 间隙不够吸收误差（G1 实测残留 3 对重叠）；48px 与 dagre ranksep
         的缓冲量级一致，只影响本来就要推开的卡，不动无重叠卡。 */
      const adjust =
        v === 'talk'
          ? resolveOverlaps(
              saved
                .filter((n) => !isExprNode(n))
                .map((n) => {
                  const { w, h } = estimateNodeSize(
                    { id: n.id, type: 'sop', position: n.position, data: n.data },
                    v
                  );
                  const src = srcOf(n);
                  return { id: n.id, x: src.x, y: src.y, w, h };
                }),
              48
            )
          : null;
      const nodes = saved.map((n) => {
        const target = adjust?.get(n.id) ?? srcOf(n);
        return {
          ...n,
          position: target,
          posByView: { ...(n.posByView ?? {}), [v]: target },
        };
      });
      return { view: v, nodes };
    }),

  calibrateViewOverlaps: () => {
    const st = get();
    const view = st.view;
    /* 只校准话术层（结构层是用户原布局，紧凑/重叠都应保留原样） */
    if (view !== 'talk') return;
    const boxes = st.nodes
      .filter((n) => !isExprNode(n))
      .map((n) => {
        const mw = n.measured?.width ?? 0;
        const mh = n.measured?.height ?? 0;
        const size =
          mw > 0 && mh > 0
            ? { w: mw, h: mh }
            : estimateNodeSize({ id: n.id, type: 'sop', position: n.position, data: n.data }, view);
        return { id: n.id, x: n.position.x, y: n.position.y, w: size.w, h: size.h };
      });
    const adjust = resolveOverlaps(boxes, 16);
    let changed = false;
    const nodes = st.nodes.map((n) => {
      const t = adjust.get(n.id);
      if (!t || (Math.abs(t.x - n.position.x) < 0.5 && Math.abs(t.y - n.position.y) < 0.5)) return n;
      changed = true;
      return { ...n, position: t, posByView: { ...(n.posByView ?? {}), [view]: t } };
    });
    if (changed) set({ nodes });
  },

  /**
   * 情景决策（M3）：真源是 steps 有序序列。
   * - 带 visit（pending 时第 visit 次经过，环上同一判断点第 N 次选择）→ 追加
   * - 不带 visit → 修改该节点最后一次决策，并**截断其后所有决策**
   *   （后续决策建立在旧路径上，改了前面就必须重走；语义同「浏览器改地址栏截断前进栈」）
   * - 再点同一条已选出口 = 取消该决策
   */
  assign: (nodeId, edgeId, visit) =>
    set((st) => {
      const occ = st.steps.filter((s) => s.nodeId === nodeId);
      let next: ScenarioStep[];
      if (visit !== undefined && visit >= occ.length) {
        next = [...st.steps, { nodeId, edgeId }];
      } else {
        let idx = -1;
        if (visit !== undefined) {
          let cnt = -1;
          for (let i = 0; i < st.steps.length; i += 1) {
            if (st.steps[i].nodeId === nodeId) {
              cnt += 1;
              if (cnt === visit) {
                idx = i;
                break;
              }
            }
          }
        } else {
          for (let i = st.steps.length - 1; i >= 0; i -= 1) {
            if (st.steps[i].nodeId === nodeId) {
              idx = i;
              break;
            }
          }
        }
        if (idx < 0) {
          next = [...st.steps, { nodeId, edgeId }];
        } else {
          const head = st.steps.slice(0, idx);
          next = st.steps[idx].edgeId === edgeId ? head : [...head, { nodeId, edgeId }];
        }
      }
      return { steps: next, redoSteps: [], assignments: assignmentsOf(next) };
    }),

  clearAssignments: () => set({ steps: [], redoSteps: [], assignments: {} }),

  /**
   * 一键示例：任意图可用（飞书粘贴、手工搭建都行）。
   * 旧实现拿示例模板的硬编码 id（d1/d2/d3）硬套——只要用户换一张图就一条都对不上，
   * 点了完全没反应（「失效」的根因）。现在改为按图推演：入口出发，每个判断点走「下游最深」
   * 的那条分支，回路最多绕两轮后停住交给用户。
   */
  presetAssignments: () => {
    const st = get();
    const coreNodes = st.nodes.map((n) => ({
      id: n.id,
      type: 'sop' as const,
      position: { x: 0, y: 0 },
      data: n.data,
    }));
    const coreEdges = st.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'step' as const,
      label: typeof e.label === 'string' ? e.label : '',
    }));
    const vars = resolveVariables(coreNodes, coreEdges, st.enabledVarNodeIds);
    const steps = suggestScenarioSteps(coreNodes, coreEdges, vars);
    set({ steps, redoSteps: [], assignments: assignmentsOf(steps) });
  },

  stepBack: () =>
    set((st) => {
      if (!st.steps.length) return st;
      const steps = st.steps.slice(0, -1);
      const redoSteps = [...st.redoSteps, st.steps[st.steps.length - 1]];
      return { steps, redoSteps, assignments: assignmentsOf(steps) };
    }),

  stepForward: () =>
    set((st) => {
      if (!st.redoSteps.length) return st;
      const last = st.redoSteps[st.redoSteps.length - 1];
      const steps = [...st.steps, last];
      return { steps, redoSteps: st.redoSteps.slice(0, -1), assignments: assignmentsOf(steps) };
    }),

  relayout: () =>
    set((st) => {
      /* WP4：只整理流程节点，表达节点原样保留 */
      const coreNodes = st.nodes
        .filter((n) => !isExprNode(n))
        .map((n) => ({
          id: n.id,
          type: 'sop' as const,
          position: { x: 0, y: 0 },
          data: n.data,
        }));
      const coreEdges = st.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep' as const,
        label: typeof e.label === 'string' ? e.label : '',
      }));
      const laid = layoutGraph(coreNodes, coreEdges, st.view);
      const posMap = new Map(laid.map((n) => [n.id, n.position]));
      const nodes = st.nodes.map((n) => ({
        ...n,
        position: posMap.get(n.id) ?? n.position,
      }));
      return { nodes };
    }),

  /** 局部整理：完整图布局 → 取选中节点位置 → 用原/新 bbox 中心差做平移补偿，保证选中节点
    看起来「原位整齐」而非跑到画布角。≥1 个选中才生效。 */
  localRelayout: () =>
    set((st) => {
      const sel = st.nodes.filter((n) => n.selected);
      if (sel.length < 1) return st;
      const ids = new Set(sel.map((n) => n.id));
      /* WP4：局部整理同样只重排流程节点（表达节点无连线，不参与 dagre） */
      const coreNodes = st.nodes
        .filter((n) => !isExprNode(n))
        .map((n) => ({
          id: n.id,
          type: 'sop' as const,
          position: { x: 0, y: 0 },
          data: n.data,
        }));
      const coreEdges = st.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep' as const,
        label: typeof e.label === 'string' ? e.label : '',
      }));
      const laid = layoutGraph(coreNodes, coreEdges, st.view);
      const posMap = new Map(laid.map((n) => [n.id, n.position]));
      const oldCx = sel.reduce((a, n) => a + n.position.x, 0) / sel.length;
      const oldCy = sel.reduce((a, n) => a + n.position.y, 0) / sel.length;
      const newSel = sel.map((n) => posMap.get(n.id) ?? n.position);
      const newCx = newSel.reduce((a, p) => a + p.x, 0) / newSel.length;
      const newCy = newSel.reduce((a, p) => a + p.y, 0) / newSel.length;
      const dx = oldCx - newCx;
      const dy = oldCy - newCy;
      pushHistory();
      return {
        nodes: st.nodes.map((n) =>
          ids.has(n.id) && posMap.has(n.id)
            ? { ...n, position: { x: posMap.get(n.id)!.x + dx, y: posMap.get(n.id)!.y + dy } }
            : n
        ),
      };
    }),

  openPicker: (x, y) => set({ picker: { x, y } }),
  closePicker: () => set({ picker: null }),

  addNodeAt: (kind, x, y) => {
    pushHistory();
    set((st) => {
      if (kind === 'io-start' || kind === 'io-end') {
        if (st.nodes.some((n) => n.data?.kind === kind)) return st;
      }
      const label = NODE_PLACEHOLDER[kind] ?? '新步骤';
      const node: SopFlowNode = {
        id: nextId('n'),
        type: 'sop',
        position: { x, y },
        data: {
          label: kind === 'step' ? `${label} ${st.nodes.length + 1}` : label,
          kind,
          talk: [],
          editing: true,
        },
      };
      return { nodes: [...st.nodes, node], picker: null };
    });
  },

  addExprNode: (type, x, y) => {
    pushHistory();
    set((st) => {
      const data: Record<string, unknown> =
        type === 'image' ? { editing: true } : { label: '', editing: true };
      /* 新建即进入编辑/上传态，落点在双击处；data 不入库字段在编辑完由组件清掉 */
      const node = {
        id: nextId('n'),
        type,
        position: { x, y },
        data,
        selected: false,
      } as unknown as SopFlowNode;
      return { nodes: [...st.nodes, node], picker: null };
    });
  },

  renameEdge: (edgeId, label) => {
    pushHistory();
    set((st) => ({
      edges: st.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)),
    }));
  },

  /** 0918 二修：连线描述拖动 —— 只记「沿线比例 t∈[0,1]」（chip 贴在线上滑动），
   *  不再记自由偏移。写进 edge.data.labelT（normalizeEdge 透传 data → 免费持久化）；
   *  拖动过程用组件本地态渲染，松手一次性提交。老字段 labelOffset 顺手清掉。 */
  moveEdgeLabel: (edgeId, t, opts) => {
    if (!opts?.silent) pushHistory();
    set((st) => ({
      edges: st.edges.map((e) => {
        if (e.id !== edgeId) return e;
        const d: Record<string, unknown> = { ...(e.data ?? {}) };
        delete d.labelOffset;
        d.labelT = t;
        return { ...e, data: d };
      }),
    }));
  },

  /* 0918：静默写回自动边的出入侧。刻意不走 pushHistory —— 它是渲染结果的镜像，
     不是用户操作，进历史会让「撤销」多出空步。 */
  syncEdgeSides: (pairs) => {
    if (!pairs.length) return;
    const byId = new Map(pairs.map((p) => [p.id, p]));
    set((st) => {
      let changed = false;
      const edges = st.edges.map((e) => {
        const p = byId.get(e.id);
        if (!p) return e;
        if (p.sourceHandle === e.sourceHandle && p.targetHandle === e.targetHandle) return e;
        changed = true;
        return { ...e, sourceHandle: p.sourceHandle, targetHandle: p.targetHandle };
      });
      return changed ? { edges } : {};
    });
  },

  afterDelete: (removedNodeIds, removedEdgeIds) =>
    set((st) => ({
      edges: st.edges.filter(
        (e) =>
          !removedNodeIds.includes(e.source) &&
          !removedNodeIds.includes(e.target) &&
          !removedEdgeIds.includes(e.id)
      ),
      assignments: Object.fromEntries(
        Object.entries(st.assignments).filter(
          ([nodeId, eid]) => !removedNodeIds.includes(nodeId) && !removedEdgeIds.includes(eid)
        )
      ),
      steps: st.steps.filter(
        (x) => !removedNodeIds.includes(x.nodeId) && !removedEdgeIds.includes(x.edgeId)
      ),
    })),

  /* ---------- E1 历史栈 / 运行时偏好 ---------- */
  mark: () => pushHistory(),
  undo: () => doUndo(),
  redo: () => doRedo(),
  setSnap: (b) => set({ snapEnabled: b }),
  setGridVisible: (b) => set({ gridVisible: b }),
  setFocusAll: (b) => set({ focusAll: b }),
  setTheme: (t) => set({ theme: t }),
  toggleTheme: () => set((st) => ({ theme: st.theme === 'dark' ? 'light' : 'dark' })),

  /* ---------- E4/E5 几何与配色 ---------- */
  alignSelected: (dir) => {
    const st = useAppStore.getState();
    if (st.readonly || st.mode !== 'edit') return;
    const sel = st.nodes.filter((n) => n.selected);
    if (sel.length < 2) return;
    /** Q3 修复：按当前视图计算节点宽高，避免按 flow 尺寸对齐 talk 卡片 */
    const wOf = (n: SopFlowNode) =>
      estimateNodeSize({ id: n.id, type: 'sop', position: n.position, data: n.data }, st.view).w;
    const hOf = (n: SopFlowNode) =>
      estimateNodeSize({ id: n.id, type: 'sop', position: n.position, data: n.data }, st.view).h;
    const xs = sel.map((n) => n.position.x);
    const rights = sel.map((n) => n.position.x + wOf(n));
    const ys = sel.map((n) => n.position.y);
    const bottoms = sel.map((n) => n.position.y + hOf(n));
    const minL = Math.min(...xs);
    const maxR = Math.max(...rights);
    const minT = Math.min(...ys);
    const maxB = Math.max(...bottoms);
    pushHistory();
    set((s2) => ({
      nodes: s2.nodes.map((n) => {
        if (!n.selected) return n;
        const w = wOf(n);
        const h = hOf(n);
        const p = { ...n.position };
        if (dir === 'left') p.x = minL;
        else if (dir === 'right') p.x = maxR - w;
        else if (dir === 'centerX') p.x = (minL + maxR) / 2 - w / 2;
        else if (dir === 'top') p.y = minT;
        else if (dir === 'bottom') p.y = maxB - h;
        else p.y = (minT + maxB) / 2 - h / 2;
        return { ...n, position: p };
      }),
    }));
  },

  distributeSelected: (axis) => {
    const st = useAppStore.getState();
    if (st.readonly || st.mode !== 'edit') return;
    const sel = st.nodes.filter((n) => n.selected);
    if (sel.length < 3) return;
    type Row = { id: string; lead: number; size: number };
    const rows: Row[] = sel.map((n) => {
      const sz = estimateNodeSize(
        { id: n.id, type: 'sop', position: n.position, data: n.data },
        st.view
      );
      return {
        id: n.id,
        lead: axis === 'h' ? n.position.x : n.position.y,
        size: axis === 'h' ? sz.w : sz.h,
      };
    });
    rows.sort((a, b) => a.lead - b.lead);
    const first = rows[0];
    const span =
      rows[rows.length - 1].lead +
      rows[rows.length - 1].size -
      first.lead;
    const inner = rows.reduce((m, r) => m + r.size, 0);
    const gap = Math.max(0, (span - inner) / (rows.length - 1));
    const target = new Map<string, number>();
    let cur = first.lead;
    rows.forEach((r, i) => {
      target.set(r.id, cur);
      if (i < rows.length - 1) cur += r.size + gap;
    });
    pushHistory();
    set((s2) => ({
      nodes: s2.nodes.map((n) => {
        const t = target.get(n.id);
        if (t === undefined) return n;
        return axis === 'h'
          ? { ...n, position: { ...n.position, x: t } }
          : { ...n, position: { ...n.position, y: t } };
      }),
    }));
  },

  paintNodes: (nodeIds, paint) =>
    set((st) => ({
      nodes: st.nodes.map((n) => {
        if (!nodeIds.includes(n.id)) return n;
        if (!paint) {
          const { color: _drop, ...rest } = n.data as SopFlowNode['data'] & { color?: unknown };
          return { ...n, data: rest as SopFlowNode['data'] };
        }
        // 按 scope merge：只覆盖传入键，保留其余
        const cur = ((n.data as { color?: NodePaint | null }).color ?? {}) as NodePaint;
        return { ...n, data: { ...n.data, color: { ...cur, ...paint } } };
      }),
    })),

  deleteSelected: () => {
    pushHistory();
    set((st) => {
      const ids = new Set(st.nodes.filter((n) => n.selected).map((n) => n.id));
      if (!ids.size) return st;
      return {
        nodes: st.nodes.filter((n) => !ids.has(n.id)),
        edges: st.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
        assignments: Object.fromEntries(
          Object.entries(st.assignments).filter(([k]) => !ids.has(k))
        ),
      };
    });
  },

  deleteNodes: (ids) => {
    if (!ids.length) return;
    const s = new Set(ids);
    pushHistory();
    set((st) => ({
      nodes: st.nodes.filter((n) => !s.has(n.id)),
      edges: st.edges.filter((e) => !s.has(e.source) && !s.has(e.target)),
      assignments: Object.fromEntries(Object.entries(st.assignments).filter(([k]) => !s.has(k))),
    }));
  },

  changeKind: (nodeId, kind) => {
    pushHistory();
    set((st) => {
      if (kind === 'io-start' || kind === 'io-end') {
        if (st.nodes.some((n) => n.id !== nodeId && n.data?.kind === kind)) return st;
      }
      return {
        nodes: st.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, kind } } : n
        ),
      };
    });
  },

  /** 点1 每行字数：null = 关闭规则（字段从 data 里删除）；数字 = 每行 N 字硬折。
   *  显示与尺寸估算都吃 data.wrapCols（nodeSize.ts / SopNode），这里只管落库。 */
  setWrapCols: (nodeId, cols) => {
    pushHistory();
    set((st) => ({
      nodes: st.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const data = { ...n.data } as Record<string, unknown>;
        if (cols === null) delete data.wrapCols;
        else data.wrapCols = cols;
        return { ...n, data: data as typeof n.data };
      }),
    }));
  },

  clearSelection: () =>
    set((st) => {
      const hasSel = st.nodes.some((n) => n.selected) || st.edges.some((e) => e.selected);
      if (!hasSel) return st;
      return {
        nodes: st.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
        edges: st.edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
      };
    }),

  nudgeSelected: (dx, dy) =>
    set((st) => ({
      nodes: st.nodes.map((n) =>
        n.selected ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n
      ),
    })),

  clearCanvas: () => {
    pushHistory();
    set({ nodes: [], edges: [], assignments: {}, picker: null, mode: 'edit' });
  },

  applyPaste: (pasteNodes, pasteEdges) => {
    pushHistory();
    set((st) => ({
      nodes: [...st.nodes, ...pasteNodes],
      edges: [...st.edges, ...pasteEdges],
    }));
  },

  /* ---------- 启动 ---------- */
  boot: async () => {
    /* ① 旧单图 localStorage → 库迁移（一次性） */
    await migrateLegacy();
    /* ② 桌面版文件镜像 ↔ IndexedDB 双向补齐：更新/重装/清 WebView 数据后自动把图找回来 */
    const restored = await restoreLibraryFromVault();
    if (restored.restored > 0) {
      set({
        vaultNotice: `已从本地备份恢复 ${restored.restored} 张流程图（检测到图库缺失）`,
      });
    }
    if (restored.path) set({ vaultPath: restored.path });
    /* ③ 恢复上次打开的图 */
    const active = await dbGet<{ key: string; value: string }>(KV_STORE, 'activeDocId');
    if (active?.value) {
      const doc = await dbGet<FlowDoc>(DOCS_STORE, active.value);
      if (doc) {
        /* 连线类型迁移（与 openDoc / sanitizeContent 一致）：旧 step 直角 → smoothstep 圆角肘线 */
        const edges = (doc.flow.edges ?? []).map((e) =>
          e.type === 'step' ? { ...e, type: 'smoothstep' as Edge['type'] } : e
        );
        const defaultEdgeType =
          doc.flow.defaultEdgeType === 'step' ? 'smoothstep' : doc.flow.defaultEdgeType;
        set({
          docId: doc.id,
          docName: doc.name,
          docGroup: doc.group,
          readonly: false,
          nodes: doc.flow.nodes,
          edges,
          assignments: doc.flow.assignments,
          steps: doc.flow.steps ?? stepsOfAssignments(doc.flow.assignments),
          redoSteps: [],
          view: doc.flow.view,
          mode: doc.flow.mode,
          enabledVarNodeIds: doc.flow.enabledVarNodeIds,
          defaultEdgeType,
          undoStack: [],
          redoStack: [],
          ready: true,
        });
        return;
      }
    }
    set({ ready: true });
  },

  /* ---------- 库操作 ---------- */
  openDoc: async (id, readonly = false) => {
    const doc = await dbGet<FlowDoc>(DOCS_STORE, id);
    if (!doc) return;
    /* 连线类型迁移：旧数据「肘线」为直角 step，读入即平滑为 smoothstep（圆角肘线）——
       与 sanitizeContent 的迁移保持一致，这里直信路径也要过一遍 */
    const edges = (doc.flow.edges ?? []).map((e) =>
      e.type === 'step' ? { ...e, type: 'smoothstep' as Edge['type'] } : e
    );
    const defaultEdgeType =
      doc.flow.defaultEdgeType === 'step' ? 'smoothstep' : doc.flow.defaultEdgeType;
    set({
      docId: doc.id,
      docName: doc.name,
      docGroup: doc.group,
      readonly,
      nodes: doc.flow.nodes,
      edges,
      assignments: doc.flow.assignments,
      steps: doc.flow.steps ?? stepsOfAssignments(doc.flow.assignments),
      redoSteps: [],
      view: doc.flow.view,
      /**
       * Bug1 修复：打开文档一律以「编辑」进入（非 readonly）。
       * 旧实现恢复 doc.flow.mode：若上次停在「情景导航」，打开即 scenario，
       * 话术层会退化成只读气泡，必须先手点「编辑画布」才能改话术——反直觉。
       * 情景导航是临时演练态（赋值本就不入库），mode 不应持久化。
       */
      mode: readonly ? 'view' : 'edit',
      enabledVarNodeIds: doc.flow.enabledVarNodeIds,
      defaultEdgeType,
      undoStack: [],
      redoStack: [],
      picker: null,
    });
    await dbPut(KV_STORE, { key: 'activeDocId', value: doc.id });
  },

  closeToLibrary: async () => {
    flushNow(get()); // 先落当前编辑内容
    await dbDelete(KV_STORE, 'activeDocId');
    const keepVault = get().vaultPath;
    set({ ...emptyEditor, ready: true, vaultPath: keepVault });
    await mirrorNow();
  },

  createDoc: async (name, group, content) => {
    const doc: FlowDoc = {
      id: docIdOf(),
      name: name || '未命名流程图',
      group: group || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      flow: content,
    };
    await dbPut(DOCS_STORE, doc);
    scheduleMirror();
    await useAppStore.getState().openDoc(doc.id);
  },

  createSampleDoc: async () => {
    const { nodes, edges } = buildGraph(SAMPLE_NODE_DEFS, SAMPLE_EDGE_DEFS);
    const laid = layoutGraph(nodes, edges, 'flow');
    // 示例模板：全部候选直接启用（语义完整，不弹识别引导）
    const allVars = deriveVariableCandidates(nodes, edges).map((v) => v.nodeId);
    const content: FlowContent = {
      nodes: laid as unknown as SopFlowNode[],
      edges: edges as unknown as Edge[],
      assignments: {},
      steps: [],
      view: 'flow',
      mode: 'edit',
      enabledVarNodeIds: allVars,
      defaultEdgeType: EDGE_TYPE_DEFAULT,
    };
    await useAppStore.getState().createDoc('司机接单客服 SOP', '模板', content);
  },

  duplicateDoc: async (id) => {
    const doc = await dbGet<FlowDoc>(DOCS_STORE, id);
    if (!doc) return;
    const copy: FlowDoc = {
      ...doc,
      id: docIdOf(),
      name: `${doc.name} 副本`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      flow: JSON.parse(JSON.stringify(doc.flow)) as FlowContent,
    };
    await dbPut(DOCS_STORE, copy);
    scheduleMirror();
  },

  renameDoc: async (id, name) => {
    const doc = await dbGet<FlowDoc>(DOCS_STORE, id);
    if (!doc) return;
    await dbPut(DOCS_STORE, { ...doc, name: name || doc.name });
    if (get().docId === id) set({ docName: name || doc.name });
    scheduleMirror();
  },

  setDocGroup: async (id, group) => {
    const doc = await dbGet<FlowDoc>(DOCS_STORE, id);
    if (!doc) return;
    await dbPut(DOCS_STORE, { ...doc, group: group || '' });
    if (get().docId === id) set({ docGroup: group || '' });
    scheduleMirror();
  },

  deleteDoc: async (id) => {
    await dbDelete(DOCS_STORE, id);
    if (get().docId === id) {
      await dbDelete(KV_STORE, 'activeDocId');
      const keepVault = get().vaultPath;
      set({ ...emptyEditor, ready: true, vaultPath: keepVault });
    }
    /* 删除必须立刻落镜像，否则回滚快照当天就没了 */
    await mirrorNow();
  },

  /* ---------- 编辑器级 ---------- */
  setDocName: (name) => {
    const s = get();
    const clean = name.trim();
    if (!s.docId || !clean) return;
    const docId = s.docId;
    dbGet<FlowDoc>(DOCS_STORE, docId)
      .then((doc) => (doc ? dbPut(DOCS_STORE, { ...doc, name: clean }) : undefined))
      .catch(() => undefined);
    scheduleMirror();
    set({ docName: clean });
  },

  setDefaultEdgeType: (t) => set({ defaultEdgeType: t }),
  setEdgeTypes: (edgeIds, t) =>
    set((st) => ({
      edges: st.edges.map((e) => (edgeIds.includes(e.id) ? { ...e, type: t } : e)),
    })),

  /** WP5 连线编辑：边 data.route（折点）/ data.sourceAnchor·targetAnchor（端点吸附）+ 端点钉住 */
  setEdgeRoute: (edgeId, patch, commit) => {
    if (commit) pushHistory();
    set((st) => ({
      edges: st.edges.map((e) => {
        if (e.id !== edgeId) return e;
        const d: Record<string, unknown> = {
          ...((e.data ?? {}) as Record<string, unknown>),
        };
        if (patch.anchorPinned) d.anchorPinned = true;
        else delete d.anchorPinned;
        if (patch.route) d.route = patch.route;
        else delete d.route;
        /* 端点锚点：只有显式传了才动（undefined = 保持原样，null = 清除） */
        if (patch.sourceAnchor !== undefined) {
          if (patch.sourceAnchor) d.sourceAnchor = patch.sourceAnchor;
          else delete d.sourceAnchor;
        }
        if (patch.targetAnchor !== undefined) {
          if (patch.targetAnchor) d.targetAnchor = patch.targetAnchor;
          else delete d.targetAnchor;
        }
        return {
          ...e,
          sourceHandle: patch.sourceHandle,
          targetHandle: patch.targetHandle,
          data: d,
        };
      }),
    }));
  },

  /** 端点交还自动：清掉钉住标记与手动路由，端点/中段重新跟着几何走 */
  resetEdgeAnchors: (edgeIds) => {
    pushHistory();
    set((st) => ({
      edges: st.edges.map((e) => {
        if (!edgeIds.includes(e.id)) return e;
        const next: Edge = { ...e };
        delete next.sourceHandle;
        delete next.targetHandle;
        const d = { ...((e.data ?? {}) as Record<string, unknown>) };
        delete d.anchorPinned;
        delete d.route;
        delete d.sourceAnchor;
        delete d.targetAnchor;
        if (Object.keys(d).length) next.data = d;
        else delete next.data;
        return next;
      }),
    }));
  },

  /** 全部连线复位：与 resetEdgeAnchors 同一套清理逻辑，只是作用于所有边 */
  resetAllEdgeRoutes: () => {
    pushHistory();
    set((st) => ({
      edges: st.edges.map((e) => {
        const next: Edge = { ...e };
        delete next.sourceHandle;
        delete next.targetHandle;
        const d = { ...((e.data ?? {}) as Record<string, unknown>) };
        delete d.anchorPinned;
        delete d.route;
        delete d.sourceAnchor;
        delete d.targetAnchor;
        if (Object.keys(d).length) next.data = d;
        else delete next.data;
        return next;
      }),
    }));
  },

  setEnabledVars: (nodeIds) => set({ enabledVarNodeIds: nodeIds }),
  toggleVarEnabled: (nodeId) =>
    set((st) => {
      const cur = new Set(st.enabledVarNodeIds ?? []);
      if (cur.has(nodeId)) cur.delete(nodeId);
      else cur.add(nodeId);
      return { enabledVarNodeIds: [...cur] };
    }),

  exportJSON: () => {
    const st = get();
    const flow: FlowContent = {
      nodes: st.nodes,
      edges: st.edges,
      assignments: st.assignments,
      steps: st.steps,
      view: st.view,
      mode: st.mode === 'scenario' ? 'scenario' : 'edit',
      enabledVarNodeIds: st.enabledVarNodeIds,
      defaultEdgeType: st.defaultEdgeType,
    };
    return JSON.stringify(
      {
        app: 'flow-app',
        kind: 'backup',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: st.docName,
        state: flow,
      },
      null,
      2
    );
  },

  flushSave: () => flushNow(get()),
}));

/* ============================================================
 * 自动保存：编辑器内容变化 → 500ms debounce 写入 docs[docId]
 * ============================================================ */
const isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

/* ============================================================
 * E1 撤销/重做：图形内容快照 JSON 栈（移动/改名/增删/连线/布局/配色/粘贴）
 * ============================================================ */
const HIST_LIMIT = 200;
let lastMarkTs = 0;
/** 记录一次「操作前」快照；只读 / 无图 / 距上次 <60ms（同批事件）跳过 */
function pushHistory(): void {
  const s = useAppStore.getState();
  if (!s.docId || s.readonly) return;
  const now = Date.now();
  if (now - lastMarkTs < 60) {
    lastMarkTs = now;
    return;
  }
  const snap = snapshotOf(s);
  if (!snap) return;
  const json = JSON.stringify(snap);
  lastMarkTs = now;
  const stack = s.undoStack;
  if (stack.length && stack[stack.length - 1] === json) return; // 无实际变化
  const next = [...stack, json];
  if (next.length > HIST_LIMIT) next.splice(0, next.length - HIST_LIMIT);
  useAppStore.setState({ undoStack: next, redoStack: [] });
}

function applyContentJson(json: string): Partial<AppState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  const c = sanitizeContent(parsed);
  if (!c) return {};
  return {
    nodes: c.nodes,
    edges: c.edges,
    assignments: c.assignments,
    enabledVarNodeIds: c.enabledVarNodeIds,
    defaultEdgeType: c.defaultEdgeType,
  };
}

function doUndo(): void {
  const s = useAppStore.getState();
  if (!s.docId || !s.undoStack.length) return;
  const prev = s.undoStack[s.undoStack.length - 1];
  const cur = snapshotOf(s);
  useAppStore.setState({
    undoStack: s.undoStack.slice(0, -1),
    redoStack: cur ? [...s.redoStack, JSON.stringify(cur)].slice(-HIST_LIMIT) : s.redoStack,
    ...applyContentJson(prev),
  });
}

function doRedo(): void {
  const s = useAppStore.getState();
  if (!s.docId || !s.redoStack.length) return;
  const next = s.redoStack[s.redoStack.length - 1];
  const cur = snapshotOf(s);
  useAppStore.setState({
    redoStack: s.redoStack.slice(0, -1),
    undoStack: cur ? [...s.undoStack, JSON.stringify(cur)].slice(-HIST_LIMIT) : s.undoStack,
    ...applyContentJson(next),
  });
}

function snapshotOf(s: AppState): FlowContent | null {
  if (!s.docId) return null;
  return sanitizeContent({
    nodes: s.nodes,
    edges: s.edges,
    assignments: s.assignments,
    steps: s.steps,
    view: s.view,
    mode: s.mode === 'scenario' ? 'scenario' : 'edit',
    enabledVarNodeIds: s.enabledVarNodeIds,
    defaultEdgeType: s.defaultEdgeType,
  });
}

/** 立即落库（beforeunload / visibilitychange / 返回库 / 导入后）
 *  只读查看态：演示赋值不入库（保持 doc 原样） */
export function flushNow(s: AppState): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  if (s.readonly) return;
  const content = snapshotOf(s);
  if (!content || !s.docId) return;
  dbGet<FlowDoc>(DOCS_STORE, s.docId)
    .then((doc) => {
      if (!doc) return;
      return dbPut(DOCS_STORE, { ...doc, updatedAt: Date.now(), flow: content });
    })
    .catch(() => undefined);
}

function scheduleSave(s: AppState) {
  if (!s.docId) return;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushNow(useAppStore.getState());
  }, 500);
}

if (isBrowser) {
  /* 开发期调试钩子：Playwright 探针靠它读取内部状态做断言（生产构建不会打进去）。
     web 的 tsconfig 没引 vite/client 类型，故这里手动收窄 import.meta。 */
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    (window as unknown as Record<string, unknown>).__flowStore = useAppStore;
  }
  /* 关闭/切后台：内容落库 + 立刻刷新文件镜像（退出不等 debounce） */
  window.addEventListener('beforeunload', () => {    flushNow(useAppStore.getState());
    void mirrorNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow(useAppStore.getState());
  });
  // 编辑器内容态变更 → 节流落库（docId/readonly/ready/picker 瞬态不入快照）
  useAppStore.subscribe((s) => {
    scheduleSave(s);
  });
}
