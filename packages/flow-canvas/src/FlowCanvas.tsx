/** FlowCanvas：受控 React Flow 画布封装
 *  节点/边装饰 · 双击改名 · 情景高亮 · 只读 · 连线样式工具条
 *  E1-E7：框选三件套 / 网格吸附显隐 / 连线重连 / MiniMap / SelectionBar(对齐分布配色删除) */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeMouseHandler,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import type {
  ChainScope,
  FlowMode,
  FlowVariable,
  FlowView,
  NodeKind,
  ScenarioResult,
} from '@flow/core';
import {
  anchorPoint,
  computeSnap,
  deriveChapters,
  inferAnchorSides,
  isAnchorPinned,
  isEdgeAnchor,
  isEdgeRoute,
  bendRoutePath,
  isBendRoute,
  projectToBorder,
  searchNodes,
  traceChain,
  type AnchorBox,
  type EdgeAnchor,
  type EdgeBend,
  type EdgeRoute,
} from '@flow/core';
import { EDGE_TYPE_OPTIONS, KIND_OPTIONS, KIND_TAG } from './appearance';
/** 连线的哪一端：source = 起点，target = 终点 */
type EdgeEnd = 'source' | 'target';
import { ManualEdge } from './ManualEdge';
import { CanvasSearch } from './components/CanvasSearch';
import { CommandPalette, type CommandItem } from './components/CommandPalette';
import { SopNode, type NodePaint, type SopFlowNode } from './components/SopNode';
import type { SopNodeData } from './components/SopNode';
import { ImageNode, LabelNode, NoteNode, isExprNode } from './components/ExprNodes';
import type { LabelNodeData } from './components/ExprNodes';

export type { SopFlowNode, NodePaint } from './components/SopNode';

export interface FlowCanvasProps {
  nodes: SopFlowNode[];
  edges: Edge[];
  mode: FlowMode;
  view: FlowView;
  /** Bug2 渲染校准：切视图渲染稳定后由宿主用 RF 实测尺寸复检重叠 */
  onViewStabilized?: () => void;
  variables: FlowVariable[];
  scenario: ScenarioResult | null;
  /** 情景导航「全图」视角：true 时保留路线强调，但不压暗路线之外的节点与连线（M1-①） */
  focusAll?: boolean;
  onNodesChange: (changes: NodeChange<SopFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  onConnect: OnConnect;
  /** 拖线端点重连（E6） */
  onReconnect: (oldEdge: Edge, conn: Connection) => void;
  /** 双击连线 chip 改名（US-06） */
  onEdgeRename: (edgeId: string, label: string) => void;
  /** 双击空白（US-01 新建节点锚点）：上传视口 client 坐标 */
  onPaneDoubleClick: (clientX: number, clientY: number) => void;
  /** 单击空白 → 清空选中（E3） */
  onPaneClickClear: () => void;
  /** 连线样式：edgeIds=null → 设为本图默认（新连线用）；非空 → 批量改这些边 */
  onEdgeTypeApply: (edgeIds: string[] | null, type: string) => void;
  /** 把选中连线的端点交还给「自动选边」（之前被手动拖过端点钉住的线） */
  onEdgeAnchorReset: (edgeIds: string[]) => void;
  /** 批量复位走向（WP5b）：清空这些连线的折点与端点吸附，交还给自动路由 */
  onEdgeRouteReset?: (edgeIds: string[]) => void;
  /** 手动路由（WP3 拽线身改中段位置）：
      commit=true 表示这轮拖拽的第一次落笔（宿主应在此前推历史快照）；之后每次移动 commit=false。 */
  onEdgeRoute?: (
    edgeId: string,
    patch: EdgeRoutePatch,
    commit: boolean
  ) => void;
  defaultEdgeType: string;
  /** 可编辑（edit 且非只读） */
  editable: boolean;
  /** 拖动开始时记录历史快照（E1） */
  onNodeDragStart?: () => void;
  /* --- E5 SelectionBar 动作（配色 / 删除）--- */
  onPaintSel: (paint: NodePaint | null) => void;
  onDeleteSel: () => void;
  /* --- 右键菜单（B4：节点类型切换 + 删除）--- */
  onChangeKind: (nodeId: string, kind: NodeKind) => void;
  onDeleteNode: (nodeId: string) => void;
  /** 点1 每行字数换行规则：cols=null 表示关闭（恢复自动换行） */
  onChangeWrapCols: (nodeId: string, cols: number | null) => void;
  /** 点2(a) 连线描述拖动提交（偏移写入 edge.data.labelOffset） */
  onMoveLabel: (edgeId: string, off: { dx: number; dy: number }) => void;
  /**
   * 0918：把「当前自动推断出的出入侧」静默回写到数据层（不进撤销历史）。
   * 未钉住的边原本只在渲染时按节点实测尺寸推断，一导入/粘贴（首帧 measured 未就绪）
   * 就会退回默认的「下出上进」，用户看到的就是「连线全乱了」。
   * 固化之后：导出 JSON / 复制都带着侧边信息，任何一次还原都先按原侧渲染。
   */
  onSyncEdgeSides?: (pairs: { id: string; sourceHandle: string; targetHandle: string }[]) => void;
  /** Q4 话术编辑入历史快照：TalkEditor 每次「添加/删除/失焦提交」前调用 */
  onTalkEdit?: () => void;
  /** 画布搜索（Build K-④）：定位到某节点（App 实现：选中 + fitView 平移过去） */
  onFocusNode?: (id: string) => void;
  /** 命令面板（Build L）：App 组装的全局动作命令（节点跳转项由画布自动生成） */
  commands?: CommandItem[];
  /* --- 网格 --- */
  snapToGrid: boolean;
  gridVisible: boolean;
}

/** 手动路由落库补丁：路由/端点锚点 + 把两端钉到当前侧（保证挪节点后形状可复现） */
export interface EdgeRoutePatch {
  route: EdgeRoute | null;
  sourceHandle: string;
  targetHandle: string;
  anchorPinned: boolean;
  /** 端点自由吸附后的锚点（{side,t}；为 null 表示回到边中点） */
  sourceAnchor?: EdgeAnchor | null;
  targetAnchor?: EdgeAnchor | null;
}

/**
 * 可手动布线的连线类型。肘线 / 曲线 / 直线共用同一套折点模型，
 * 差别只在穿线方式（正交圆角 / 平滑曲线 / 尖角折线）—— 三者都能拖。
 */
const ROUTABLE_EDGE_TYPES = new Set(['smoothstep', 'default', 'straight']);

function isRoutableEdgeType(t: string | undefined): boolean {
  return ROUTABLE_EDGE_TYPES.has(t ?? 'smoothstep');
}

/**
 * 单条连线的折点上限。
 * 超过之后不再新增，而是复用离光标最近的那个点 —— 从根上杜绝「每次拖都攒一个点，
 * 攒到四五个后路径绕成麻花」。3 个点足够画出任何常见绕行。
 */
const MAX_WAYPOINTS = 3;

/** 节点某条边的中点（端点未被吸附到自定义位置时的默认落点） */
function sideCenter(b: AnchorBox, side: string): { x: number; y: number } {
  if (side === 'top') return { x: b.x + b.w / 2, y: b.y };
  if (side === 'bottom') return { x: b.x + b.w / 2, y: b.y + b.h };
  if (side === 'left') return { x: b.x, y: b.y + b.h / 2 };
  return { x: b.x + b.w, y: b.y + b.h / 2 };
}

/**
 * 求 flow 坐标 (x,y) 到某条边路径的最近点。
 * 直接用 SVG 的 getPointAtLength 采样 —— 比解析 path d 稳得多（圆角、斜段、多点全适用）。
 * 返回最近点 + 弧长比例 t（t 用来锁定「拖的是哪一段」）。
 */
function nearestOnEdgePath(
  edgeId: string,
  x: number,
  y: number
): { x: number; y: number; dist: number; s: number; t: number } | null {
  const el = document.querySelector<SVGPathElement>(
    `.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`
  );
  if (!el) return null;
  let total = 0;
  try {
    total = el.getTotalLength();
  } catch {
    return null;
  }
  if (!total || !Number.isFinite(total)) return null;
  /* 采样步长约 8px：长线多采，短线少采，兼顾精度与耗时 */
  const n = Math.max(40, Math.min(400, Math.round(total / 8)));
  let best = { x: 0, y: 0, dist: Infinity, s: 0, t: 0 };
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * total;
    const p = el.getPointAtLength(s);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best.dist) best = { x: p.x, y: p.y, dist: d, s, t: i / n };
  }
  return best.dist === Infinity ? null : best;
}

/** WP4：流程节点 + 三种自由表达节点（便签 / 贴图 / 标注） */
const nodeTypes = { sop: SopNode, note: NoteNode, image: ImageNode, label: LabelNode };

/** E5 内置调色板（FigJam 风：中性 + 语义 + 品牌蓝） */
const PAINT_SWATCHES = [
  '#ffffff', '#eef1f5', '#dbe2ea',
  '#fee2e2', '#ffedd5', '#fef9c3', '#dcfce7', '#dbeafe', '#e0e7ff', '#f3e8ff',
  '#1f2937', '#475569', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0ea5e9',
];

const SCOPE_LABEL: Record<string, string> = { bg: '底色', text: '文字', stroke: '边框' };
const SCOPE_KEY: Record<string, keyof NodePaint> = { bg: 'bg', text: 'text', stroke: 'stroke' };

/** 浮动工具条：选中 ≥1 节点时浮在选区上方（配色 / 删除）。
 *  v0.1.3 按用户反馈移除「对齐 6 向 / 横纵均分」——编辑重心转为白板拖拽，
 *  精细对齐交给自动布局与手动摆放。 */
function SelectionBar({
  nodes,
  editable,
  onPaintSel,
  onDeleteSel,
}: {
  nodes: SopFlowNode[];
  editable: boolean;
  onPaintSel: FlowCanvasProps['onPaintSel'];
  onDeleteSel: () => void;
}) {
  const rf = useReactFlow<SopFlowNode, Edge>();
  const [scope, setScope] = useState<keyof NodePaint>('bg');
  const [colorOpen, setColorOpen] = useState(false);
  const sel = useMemo(() => nodes.filter((n) => n.selected), [nodes]);

  if (!editable || sel.length === 0) return null;

  const wOf = (n: SopFlowNode) => {
    /* WP4：表达节点按自身宽度估算（贴图 240 固定；便签/标注更贴近方形），
       否则浮层锚点会按流程卡宽度估偏 */
    if (isExprNode(n)) {
      if ((n as { type?: string }).type === 'image') return 244;
      const label = ((n.data as { label?: string } | undefined)?.label ?? '').trim();
      const len = Math.max(label.length, 2);
      return Math.max(120, Math.min(280, len * 15 + 52));
    }
    const label = n.data?.label ?? '';
    return Math.max(148, Math.min(300, label.length * 15 + 56));
  };
  const xs = sel.map((n) => n.position.x);
  const ys = sel.map((n) => n.position.y);
  const maxX = Math.max(...sel.map((n) => n.position.x + wOf(n)));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  /* flowToScreenPosition 返回的是「浏览器视口」坐标；本浮层挂在画布容器内
     （absolute 相对 .canvas），直接用会偏右一个 Dock 宽度（292px）——
     必须减去画布容器的视口偏移才是容器内坐标。 */
  const wrap = document.querySelector('.canvas-wrap')?.getBoundingClientRect();
  const sp = rf.flowToScreenPosition({ x: (minX + maxX) / 2, y: minY });
  const anchor = { x: sp.x - (wrap?.left ?? 0), y: sp.y - (wrap?.top ?? 0) };

  return (
    <div className="selbar" data-testid="selbar" style={{ left: anchor.x, top: anchor.y }}>
      <div className="sb-groups">
        <div className="sb-group">
          <button
            className={`sb-btn color ${colorOpen ? 'on' : ''}`}
            title="节点配色（底色/文字/边框）"
            onClick={() => setColorOpen((v) => !v)}
          >
            <span className="sb-swatch-dot" style={{ background: (sel[0]?.data?.color as NodePaint | undefined)?.bg ?? '#fff' }} />
            颜色
          </button>
          <button className="sb-btn danger" title="删除选中（Delete）" onClick={onDeleteSel}>
            删除
          </button>
        </div>
      </div>
      {colorOpen && (
        <div className="color-pop" data-testid="color-pop">
          <div className="cp-scopes">
            {(['bg', 'text', 'stroke'] as const).map((k) => (
              <button
                key={k}
                className={`cp-scope ${scope === k ? 'on' : ''}`}
                onClick={() => setScope(k)}
              >
                {SCOPE_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="cp-swatches">
            {PAINT_SWATCHES.map((c) => (
              <button
                key={c}
                className="cp-swatch"
                style={{ background: c, ...(c === '#ffffff' || c === '#fef9c3' ? { border: '1px solid #d5dae2' } : {}) }}
                aria-label={`${SCOPE_LABEL[scope]} ${c}`}
                aria-pressed={sel[0]?.data?.color?.[SCOPE_KEY[scope]] === c}
                title={c}
                onClick={() => onPaintSel({ [SCOPE_KEY[scope]]: c } as NodePaint)}
              />
            ))}
          </div>
          <div className="cp-foot">
            <button className="cp-reset" onClick={() => onPaintSel(null)}>
              恢复 kind 默认色
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 指引浮层：常驻快捷键说明是噪音，收进「?」里按需查看。
 *  分组错落入场（CSS 处理），Esc / 点击外部 / 再点 ? 关闭。 */
const GUIDE_SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: '画布',
    rows: [
      ['双击空白', '新建节点'],
      ['双击节点', '原地改名'],
      ['右键节点', '改类型 / 删除'],
      ['拖圆点', '拉出连线'],
    ],
  },
  {
    title: '选择与移动',
    rows: [
      ['拖空白', '框选多个'],
      ['Shift / Ctrl+单击', '加选 / 减选'],
      ['空格 / 右键 + 拖', '平移画布'],
      ['滚轮 / 双指滑动', '上下左右滚动'],
      ['Ctrl+滚轮 / 双指捏合', '放大缩小'],
      ['双击连线', '给出口改名'],
    ],
  },
  {
    title: '链路（情景导航）',
    rows: [
      ['单击节点', '高亮上下游'],
      ['再点一次', '全链路 ⇄ 相邻'],
      ['Esc', '退出高亮'],
    ],
  },
  {
    title: '快捷键',
    rows: [
      ['Ctrl+Z', '撤销'],
      ['Ctrl+Shift+Z', '重做'],
      ['Ctrl+A', '全选'],
      ['Ctrl+C / V', '复制 / 粘贴（可粘飞书画板）'],
      ['Delete', '删除选中'],
      ['F2', '改名'],
      ['方向键', '微调 1px（Shift 10px）'],
    ],
  },
];

function GuidePanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="guide-pop" data-testid="guide-pop" role="dialog" aria-label="操作指引">
      <div className="gp-head">
        <span className="gp-title">操作指引</span>
        <span className="gp-sub">想看才看，不常驻</span>
        <button className="gp-x" onClick={onClose} aria-label="关闭指引" title="关闭（Esc）">
          ✕
        </button>
      </div>
      {GUIDE_SECTIONS.map((sec) => (
        <div className="gp-sec" key={sec.title}>
          <div className="gp-sec-t">{sec.title}</div>
          {sec.rows.map(([k, d]) => (
            <div className="gp-row" key={k}>
              <span className="k">{k}</span>
              <span className="d">{d}</span>
            </div>
          ))}
        </div>
      ))}
      <div className="gp-foot">点画布空白处或按 Esc 关闭</div>
    </div>
  );
}

export function FlowCanvas({
  nodes,
  edges,
  mode,
  view,
  onViewStabilized,
  variables,
  scenario,
  focusAll = false,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onReconnect,
  onEdgeRename,
  onPaneDoubleClick,
  onPaneClickClear,
  onEdgeTypeApply,
  defaultEdgeType,
  editable,
  onNodeDragStart,
  onPaintSel,
  onDeleteSel,
  onChangeKind,
  onDeleteNode,
  onChangeWrapCols,
  onMoveLabel,
  onSyncEdgeSides,
  onTalkEdit,
  onFocusNode,
  commands,
  snapToGrid,
  gridVisible,
  onEdgeAnchorReset,
  onEdgeRoute,
  onEdgeRouteReset,
}: FlowCanvasProps) {
  const [editingEdge, setEditingEdge] = useState<{
    edgeId: string;
    x: number;
    y: number;
    initial: string;
  } | null>(null);
  /** 鼠标悬停在哪条连线上 —— 用来决定是否浮出蓝色段标识（不常驻） */
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  const [edgeEditText, setEdgeEditText] = useState('');
  /** Bug3c：MiniMap（缩略导航图）默认收起，按需展开——常驻会挡住画布右下角内容 */
  const [miniOpen, setMiniOpen] = useState(false);
  /* —— Build J · 上下游链路追踪 —— 单击节点看「来龙去脉」，再点一次切范围，Esc/空白退出 */
  const [chain, setChain] = useState<{ id: string; scope: ChainScope } | null>(null);
  /* —— Build J · 「?」按需指引浮层 —— */
  const [guideOpen, setGuideOpen] = useState(false);
  /* —— Build K-④ · 画布搜索 —— */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  /* —— Build K-⑤ · 引导章节条 —— 按拓扑层级推导，搜索打开时让位隐藏 */
  const [chapOpen, setChapOpen] = useState(true);
  /* —— Build L · 命令面板 —— */
  const [cmdOpen, setCmdOpen] = useState(false);
  /* —— Build L · 拖拽对齐参考线（smart guides）——
     v/h 是画布容器内坐标；吸附在拖动中直接提交 position 修正（整组平移） */
  const [guides, setGuides] = useState<{ v: number[]; h: number[] } | null>(null);
  const chapters = useMemo(
    () =>
      deriveChapters(
        nodes.map((n) => ({
          id: n.id,
          label: n.data?.label ?? '',
          kind: n.data?.kind ?? 'step',
          talk: n.data?.talk ?? [],
        })),
        edges.map((e) => ({ source: e.source, target: e.target }))
      ),
    [nodes, edges]
  );
  /** 光标柔光（rAF 节流，不动 React 状态，避免每帧重渲染） */
  const spotRef = useRef<HTMLDivElement | null>(null);
  const ptRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef(0);
  /** 右键菜单（B4）：编辑态 + 结构层时右击节点弹出。
   *  kind 有值 = 流程节点（类型切换）；expr=true = 表达节点（仅删除 / 清指示线） */
  const [ctxMenu, setCtxMenu] = useState<{
    nodeId: string;
    kind?: NodeKind;
    expr?: boolean;
    hasArrow?: boolean;
    x: number;
    y: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow<SopFlowNode, Edge>();
  /** Bug2 渲染校准：切视图后 RF 实测尺寸（measured）已就绪，交给宿主复检重叠 ——
   *  estimateNodeSize 对话术卡真实渲染高有低估（fitView 缩放下实测差 ~50px），
   *  setView 里的纯估算防重叠会残留；无重叠时宿主侧零位移。 */
  useEffect(() => {
    if (!onViewStabilized) return;
    const t = setTimeout(onViewStabilized, 450);
    return () => clearTimeout(t);
  }, [view, onViewStabilized]);
  /** WP4 标注指示线 overlay：订阅 RF 视口（zoom/pan 时重画），transform=[x,y,zoom] */
  const viewport = useStore((s) => s.transform);

  /* 视口坐标 → 画布容器内坐标（浮层/SVG 都挂在容器里，必须减容器偏移） */
  const toWrapper = useCallback((p: { x: number; y: number }) => {
    const r = wrapperRef.current?.getBoundingClientRect();
    return { x: p.x - (r?.left ?? 0), y: p.y - (r?.top ?? 0) };
  }, []);

  /** 拖动中的对齐参考线（Build L）：只负责画线；
   *  吸附在松手时落位（onNodeDragStop）—— 受控模式下 RF 拖拽引擎每次 move
   *  都用「起点+累计位移」重算位置，拖动中途改 store 会被下一次 change 覆盖
   *  造成漂移；松手后提交的 position change（dragging:false）才是最终值。 */
  const handleNodeDrag = useCallback(
    (_e: unknown, _node: SopFlowNode, dragged: SopFlowNode[]) => {
      if (!dragged.length) return;
      const dragIds = new Set(dragged.map((n) => n.id));
      const first = dragged[0];
      const fw = first.measured?.width ?? 148;
      const fh = first.measured?.height ?? 46;
      const vLines = new Set<number>();
      const hLines = new Set<number>();
      const TOL = 5;
      const fx = [first.position.x, first.position.x + fw / 2, first.position.x + fw];
      const fy = [first.position.y, first.position.y + fh / 2, first.position.y + fh];
      for (const o of nodes) {
        if (dragIds.has(o.id)) continue;
        const ow = o.measured?.width ?? 148;
        const oh = o.measured?.height ?? 46;
        for (const t of [o.position.x, o.position.x + ow / 2, o.position.x + ow]) {
          for (const f of fx) if (Math.abs(t - f) < TOL) vLines.add(t);
        }
        for (const t of [o.position.y, o.position.y + oh / 2, o.position.y + oh]) {
          for (const f of fy) if (Math.abs(t - f) < TOL) hLines.add(t);
        }
      }
      setGuides(vLines.size || hLines.size ? { v: [...vLines], h: [...hLines] } : null);
    },
    [nodes]
  );
  /** 松手吸附（Build L）：拖动组用首节点做锚，命中阈值内就把整组平移到对齐位。
   *  尺寸用 node.measured（RF 实测宽高），不用估算——估算与真实可差 30px。 */
  const handleNodeDragStop = useCallback(
    (_e: unknown, _node: SopFlowNode, dragged: SopFlowNode[]) => {
      setGuides(null);
      /* WP1.2 清拖动锁：setGuides 的 state 更新会触发重渲染，displayedEdges 重算时
         锁已空 → 未钉边按新位置自动归位（换到最合适侧，只发生一次） */
      dragIdsRef.current.clear();
      dragSideRef.current.clear();
      if (!dragged.length) return;
      const dragIds = new Set(dragged.map((n) => n.id));
      const first = dragged[0];
      const fw = first.measured?.width ?? 148;
      const fh = first.measured?.height ?? 46;
      const snapRes = computeSnap(
        [{ id: first.id, x: first.position.x, y: first.position.y, w: fw, h: fh }],
        nodes
          .filter((n) => !dragIds.has(n.id))
          .map((n) => ({
            id: n.id,
            x: n.position.x,
            y: n.position.y,
            w: n.measured?.width ?? 148,
            h: n.measured?.height ?? 46,
          }))
      );
      if (snapRes.dx || snapRes.dy) {
        onNodesChange(
          dragged.map((n) => ({
            id: n.id,
            type: 'position' as const,
            position: { x: n.position.x + snapRes.dx, y: n.position.y + snapRes.dy },
          }))
        );
      }
    },
    [nodes, onNodesChange]
  );

  /* 右键菜单：document 命中 .ctx-menu 外/滚动/缩放/Esc 均关闭 */
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('.ctx-menu')) return;
      setCtxMenu(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setCtxMenu(null);
      }
    };
    const onScroll = () => setCtxMenu(null);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [ctxMenu]);

  /** 受控边选择：RF 通过 onEdgesChange select change 同步到 store，这里从 props 读取 */
  const selectedEdgeIds = useMemo(
    () => edges.filter((e) => e.selected).map((e) => e.id).sort(),
    [edges]
  );

  /* Ctrl/Cmd+K 命令面板（含在输入框里按的情况，抢占浏览器搜索栏） */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        if (document.querySelector('.modal-overlay')) return;
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* 命令面板点击外部关闭（画布上的 mousedown 一律收起，避免 toggle 状态错乱） */
  useEffect(() => {
    if (!cmdOpen) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('.cmd-palette')) return;
      setCmdOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [cmdOpen]);

  /* 全量命令 = App 动作 + 节点跳转（画布自动生成） */
  const allCommands = useMemo<CommandItem[]>(() => {
    const nodeItems: CommandItem[] = nodes.map((n) => ({
      id: `node-${n.id}`,
      title: n.data?.label || '（未命名节点）',
      group: '跳转节点',
      keywords: `${n.data?.kind ?? ''}`,
      run: () => {
        setChain(null);
        onFocusNode?.(n.id);
      },
    }));
    return [...(commands ?? []), ...nodeItems];
  }, [commands, nodes, onFocusNode]);

  /* —— 上下游链路追踪（Build J）—— */
  const chainRes = useMemo(
    () => traceChain(chain?.id ?? null, edges, chain?.scope ?? 'full'),
    [chain, edges]
  );

  /* —— 画布搜索（Build K-④）—— 与链路高亮互斥：搜索激活时清掉链路追踪 */
  const searchHits = useMemo(
    () =>
      searchOpen
        ? searchNodes(
            nodes.map((n) => ({
              id: n.id,
              label: n.data?.label ?? '',
              kind: n.data?.kind ?? 'step',
              talk: n.data?.talk ?? [],
            })),
            searchQ,
            (k) => KIND_TAG[k as NodeKind] ?? k
          )
        : [],
    [searchOpen, nodes, searchQ]
  );
  const searchActiveId = searchHits.length
    ? searchHits[Math.min(searchIdx, searchHits.length - 1)].id
    : null;
  const searchHitIds = useMemo(() => new Set(searchHits.map((h) => h.id)), [searchHits]);

  const focusHit = useCallback(
    (id: string) => {
      setChain(null);
      onFocusNode?.(id);
    },
    [onFocusNode]
  );

  /* 输入防抖 250ms 后自动飞向当前项（边输入边定位，Figma 手感） */
  useEffect(() => {
    if (!searchOpen || !searchQ.trim()) return;
    const t = window.setTimeout(() => {
      if (searchHits.length && searchActiveId) focusHit(searchActiveId);
    }, 250);
    return () => window.clearTimeout(t);
    // searchActiveId/searchHits 随 searchQ 变化，无需单列依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ, searchOpen]);

  const searchNext = useCallback(() => {
    if (!searchHits.length) return;
    setSearchIdx((i) => {
      const n = (i + 1) % searchHits.length;
      focusHit(searchHits[n].id);
      return n;
    });
  }, [searchHits, focusHit]);
  const searchPrev = useCallback(() => {
    if (!searchHits.length) return;
    setSearchIdx((i) => {
      const n = (i - 1 + searchHits.length) % searchHits.length;
      focusHit(searchHits[n].id);
      return n;
    });
  }, [searchHits, focusHit]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQ('');
    setSearchIdx(0);
  }, []);

  /* Ctrl/Cmd+F 呼出（含在输入框里按的情况，抢占浏览器页内查找） */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        if (document.querySelector('.modal-overlay')) return; /* 弹窗打开时不抢 */
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Esc：先关搜索，再关指引，再退链路高亮；在输入框里按 Esc 不抢（交给输入框自己处理） */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || !!t?.isContentEditable;
      if (typing && !t?.closest('.cs-input')) return; /* 搜索框里的 Esc 也要能关搜索 */
      if (searchOpen) {
        closeSearch();
        return;
      }
      if (typing) return;
      if (guideOpen) {
        setGuideOpen(false);
        return;
      }
      if (chain) setChain(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [guideOpen, chain, searchOpen, closeSearch]);

  /* 指引浮层：点击外部关闭（? 按钮与面板内部除外） */
  useEffect(() => {
    if (!guideOpen) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('.guide-pop, .help-fab')) return;
      setGuideOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [guideOpen]);

  /* 光标柔光：rAF 节流，直写 CSS 变量，不进 React 状态 */
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);
  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    ptRef.current = { x: e.clientX, y: e.clientY };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = spotRef.current;
      const wrap = wrapperRef.current;
      if (!el || !wrap) return;
      const r = wrap.getBoundingClientRect();
      el.style.setProperty('--mx', `${ptRef.current.x - r.left}px`);
      el.style.setProperty('--my', `${ptRef.current.y - r.top}px`);
    });
  }, []);

  /* 单击节点：
   *  - 情景导航 / 只读浏览：点亮整条上下游链（Build K 追踪——阅读辅助）
   *  - 编辑态：仅 React Flow 原生选中该节点自己（Build N —— 不再误触全链高亮；
   *    进入编辑用双击：改名/属性/话术都在节点本体与右键菜单） */
  const handleNodeClick = useCallback((_e: unknown, node: SopFlowNode) => {
    setChain((cur) =>
      cur && cur.id === node.id
        ? { id: node.id, scope: cur.scope === 'full' ? 'adjacent' : 'full' }
        : { id: node.id, scope: 'full' }
    );
  }, []);

  /**
   * 路线已「完全确定」：情景中存在可达节点、且沿途再无待赋值变量。
   * 这是 Build M 的新语义 —— 只有走到这一步，路线才升级为最高强调级。
   */
  const routeDone =
    !!scenario && scenario.pendingVars.size === 0 && scenario.activeNodes.size > 0;

  /* —— 节点装饰：status / view / locked / talkEditable / _mark / chain ——
   *  WP4：自由表达节点（note/image/label）与 sop 分道——
   *  表达节点只活结构层（talk 视图不渲染），不做情景压暗/高亮（批注永驻），
   *  locked = 非编辑态（scenario/view）一律禁编辑；sop 的 locked 维持只读 view 语义。 */
  const displayedNodes = useMemo<SopFlowNode[]>(() => {
    const locked = mode === 'view';
    const talkEditable = mode === 'edit';
    return nodes.flatMap((n) => {
      if (isExprNode(n)) {
        if (view !== 'flow') return [];
        return [
          {
            ...n,
            data: {
              ...(n.data as object),
              locked: !editable,
              _mark: onTalkEdit,
            },
          } as SopFlowNode,
        ];
      }
      let status: 'active' | 'dim' | 'pending' = 'active';
      const onRoute = scenario ? scenario.activeNodes.has(n.id) : false;
      if (scenario) {
        /* focusAll（全图视角）：路线之外的节点恢复常亮，只保留 pending 提示与路线强调 */
        if (!scenario.activeNodes.has(n.id)) status = focusAll ? 'active' : 'dim';
        if (scenario.pendingVars.has(n.id)) status = 'pending';
      }
      const chainState: 'root' | 'hit' | 'miss' | undefined = !chain
        ? undefined
        : n.id === chain.id
          ? 'root'
          : chainRes.nodes.has(n.id)
            ? 'hit'
            : 'miss';
      const searching = searchOpen && !!searchQ.trim();
      const isHit = searching && searchHitIds.has(n.id);
      return {
        ...n,
        /* 结构层：路线节点整体抬到上层，保证发光/描边压在置灰节点之上不被遮挡 */
        ...(scenario ? { zIndex: onRoute ? 10 : 1 } : {}),
        data: {
          ...n.data,
          status,
          view,
          talk: n.data?.talk ?? [],
          locked,
          talkEditable,
          /* 连接点是否可用：只读态关掉，情景导航里不再露出四个圆点 */
          connectable: editable,
          ...(chainState ? { chain: chainState } : { chain: undefined }),
          /* 搜索：未命中淡出；命中项保持清晰（当前项由 search-active 描边强调） */
          ...(searching ? { searchDim: !isHit, searchActive: n.id === searchActiveId } : {}),
          /* Build M：路线已完全确定 → 最高强调级（双环 + 外发光 + 一次性流光） */
          ...(routeDone && onRoute ? { routeDone: true } : { routeDone: undefined }),
          /* 循环可视化：同一节点在本次路径里被经过 >=2 次 → 显示「第N轮」角标 */
          loopRound:
            scenario && (scenario.visitCounts?.[n.id] ?? 0) >= 2 ? scenario.visitCounts[n.id] : undefined,
          _mark: onTalkEdit,
        },
      };
    });
  }, [nodes, scenario, focusAll, routeDone, view, mode, editable, onTalkEdit, chain, chainRes, searchOpen, searchQ, searchActiveId, searchHitIds]);

  /* —— 边装饰：颜色 / 标签 chip（含变量出口默认名「出口 n」）—— */
  const edgeLabelOf = useCallback(
    (e: Edge) => {
      if (typeof e.label === 'string' && e.label.trim()) return e.label;
      const v = variables.find((x) => x.nodeId === e.source);
      if (v) {
        const idx = v.options.findIndex((o) => o.edgeId === e.id);
        if (idx >= 0) return `出口 ${idx + 1}`;
      }
      return '';
    },
    [variables]
  );

  /**
   * 节点实测盒子（用于连线端点自动选边）。
   * 用 measured（RF 实测）优先，未测量时退回估算宽高 —— 首帧未布局也能算出合理方向。
   * 依赖 nodes：拖动节点时 positions 变化 → 锚点实时跟着换边（「箭头不再随位置乱变」的关键）。
   */
  const anchorBoxes = useMemo(() => {
    const m = new Map<string, AnchorBox>();
    nodes.forEach((n) => {
      const w = n.measured?.width ?? 0;
      const h = n.measured?.height ?? 0;
      m.set(n.id, {
        x: n.position.x,
        y: n.position.y,
        w: w > 0 ? w : 180,
        h: h > 0 ? h : 46,
        /* 0918：measured 是否已就绪。未就绪时（刚导入 / 刚粘贴的第一帧）
           推断出来的侧边不可信（用的是 180×46 兜底尺寸），必须让位给持久化的侧边。 */
        measured: w > 0 && h > 0,
      });
    });
    return m;
  }, [nodes]);

  /** 自动锚点：未钉住的边，端点跟着两节点相对位置走（射线求交，等价最短连线）。
   *  ok=false 表示两端至少有一个还没实测尺寸 —— 此时调用方应用持久化的侧边兜底。 */
  const anchorOf = useCallback(
    (source: string, target: string): { source: string; target: string; ok: boolean } => {
      const a = anchorBoxes.get(source);
      const b = anchorBoxes.get(target);
      if (!a || !b) return { source: 'bottom', target: 'top', ok: false };
      const ok = !!a.measured && !!b.measured;
      return { ...inferAnchorSides(a, b), ok };
    },
    [anchorBoxes]
  );

  /**
   * 0918：把当前推断出的侧边静默回写数据层（不进撤销历史）。
   * 只在实测尺寸就绪时写，否则会把 180×46 兜底算出来的错值固化进文档。
   */
  useEffect(() => {
    if (!onSyncEdgeSides) return;
    const patch: { id: string; sourceHandle: string; targetHandle: string }[] = [];
    edges.forEach((e) => {
      if (isAnchorPinned(e.data)) return; // 用户钉住的边本来就有持久值
      const s = anchorOf(e.source, e.target);
      if (!s.ok) return;
      if (s.source === e.sourceHandle && s.target === e.targetHandle) return;
      patch.push({ id: e.id, sourceHandle: s.source, targetHandle: s.target });
    });
    if (patch.length) onSyncEdgeSides(patch);
  }, [edges, anchorOf, onSyncEdgeSides]);

  /* WP2 拉线合法性（磁吸高亮的"可接/不可接"判定，RF 会据此给目标 handle 挂 valid class）：
     ① 自环 source===target：流程演算会死循环，禁止；
     ② 同 pair 重复边：与 store.onConnect 的 dup 拦截同口径，提前给视觉负反馈；
     ③ 端点重连（参数带 edge id）：放行——换 target 后是否重复交由 onReconnect 语义；
     ④ WP4：任一端是自由表达节点（note/image/label）一律禁止连线——
        表达层是纯装饰，不给它制造流程边。 */
  const isValidEdgeConnection = useCallback(
    (params: Edge | Connection): boolean => {
      if (!params.source || !params.target) return false;
      if (params.source === params.target) return false;
      if ('id' in params) return true; // 重连 oldEdge
      const nodeTypeOf = (id: string) => nodes.find((n) => n.id === id)?.type;
      if (nodeTypeOf(params.source) !== 'sop' || nodeTypeOf(params.target) !== 'sop') return false;
      return !edges.some((e) => e.source === params.source && e.target === params.target);
    },
    [edges, nodes]
  );

  /* WP1.2 拖动锚点锁定：拖动期间保持相关边端点侧稳定（防临界角反复横跳），
     松手后 handleNodeDragStop 清锁 + setGuides 触发重渲染 → anchorOf 自动归位。 */
  const dragIdsRef = useRef<Set<string>>(new Set());
  const dragSideRef = useRef<Map<string, { source: string; target: string }>>(new Map());

  /** 拖动开始：先让宿主记录历史快照，再把与拖动节点相连的未钉边当前侧写入锁定 */
  const handleNodeDragStart = useCallback(
    (_e: unknown, _node: SopFlowNode, dragged: SopFlowNode[]) => {
      onNodeDragStart?.();
      const ids = new Set(dragged.map((n) => n.id));
      dragIdsRef.current = ids;
      dragSideRef.current.clear();
      if (ids.size) {
        edges.forEach((ed) => {
          if (!ids.has(ed.source) && !ids.has(ed.target)) return;
          if (isAnchorPinned(ed.data)) return;
          const a = anchorBoxes.get(ed.source);
          const b = anchorBoxes.get(ed.target);
          if (a && b) dragSideRef.current.set(ed.id, inferAnchorSides(a, b));
        });
      }
    },
    [onNodeDragStart, edges, anchorBoxes]
  );

  /* ══ WP5c 连线编辑：段平移 + 端点自由吸附 ═══════════════════════════════════
     交互对齐飞书画板 / draw.io / Figma：
       · 按住线身任意位置拖 → 选中那一整段，把它整体推开（不是插一个必经点）
       · 只有被拖的这一段动；端点出线方向锁死，永远垂直于节点边
       · 悬停 / 拖动时浮出蓝色标识，平时画面干净
       · 端点手柄 → 拖到节点边框任意位置吸附（存 {side, t}，随节点缩放）

     为什么不用「必经点」：点一动整条线就要重算，Catmull-Rom 的控制点会向相邻段
     传播（曲线两端被带弯），正交路由的拐向会被重新判断（拓扑重排）。实测拖中点
     170px，贴节点的 5% 处被动位移 8–17px —— 就是「拉一处、另一处变形」。
     bend = { t: 基础路径上的弧长比例, dx, dy }，渲染时先算基础路径再推开那一段。 */
  interface EdgeDragState {
    kind: 'bend' | 'endpoint';
    edgeId: string;
    /** bend：bends 数组下标 */
    index: number;
    end?: EdgeEnd;
    nodeId?: string;
    startFlow: { x: number; y: number };
    /** bend：拖拽开始时的偏移量 */
    base: { dx: number; dy: number };
    bends: EdgeBend[];
    sides: { source: string; target: string };
    moved: boolean;
  }

  const edgeDragRef = useRef<EdgeDragState | null>(null);
  const edgeDragCleanupRef = useRef<(() => void) | null>(null);

  /** 当前端点侧：钉住过就照旧，否则按两节点相对位置自动推断 */
  const sidesOf = useCallback(
    (ed: Edge) =>
      isAnchorPinned(ed.data)
        ? { source: ed.sourceHandle ?? 'bottom', target: ed.targetHandle ?? 'top' }
        : anchorOf(ed.source, ed.target),
    [anchorOf]
  );

  const runEdgeDrag = useCallback(
    (init: EdgeDragState, clientX: number, clientY: number) => {
      edgeDragCleanupRef.current?.();
      init.startFlow = rf.screenToFlowPosition({ x: clientX, y: clientY });
      edgeDragRef.current = init;

      const onMove = (e: PointerEvent) => {
        const dr = edgeDragRef.current;
        if (!dr) return;
        const f = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const dx = f.x - dr.startFlow.x;
        const dy = f.y - dr.startFlow.y;
        /* 3px 阈值：区分「点一下选中」和「真的要拖」，避免误建折点 */
        if (!dr.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        const first = !dr.moved;
        dr.moved = true;
        if (first) e.preventDefault();

        if (dr.kind === 'bend') {
          /* v5 段平移（飞书画板同款）：拖哪个 bend，只改那一个 bend 的偏移量，
             其余 bends 不动 —— 每个 bend 把自己命中的那段整体沿法向推开
             （applyBendOrtho 里投影到法向，斜拖也只取正交分量）。
             v4「所有 bends 共享 dx/dy 整线联动」已被用户否决（端点脱锚 + 斜拖拉出斜线）。 */
          const bs = dr.bends.map((b, i) =>
            i === dr.index
              ? { t: b.t, dx: Math.round(dr.base.dx + dx), dy: Math.round(dr.base.dy + dy) }
              : b
          );
          onEdgeRoute?.(
            dr.edgeId,
            {
              route: { bends: bs },
              sourceHandle: dr.sides.source,
              targetHandle: dr.sides.target,
              anchorPinned: true,
            },
            first
          );
          return;
        }
        /* 端点：投影到节点边框，吸到最近的那条边 */
        const box = dr.nodeId ? anchorBoxes.get(dr.nodeId) : undefined;
        if (!box) return;
        const a = projectToBorder(box, f.x, f.y);
        onEdgeRoute?.(
          dr.edgeId,
          {
            route: dr.bends.length ? { bends: dr.bends } : null,
            sourceHandle: dr.end === 'source' ? a.side : dr.sides.source,
            targetHandle: dr.end === 'target' ? a.side : dr.sides.target,
            anchorPinned: true,
            ...(dr.end === 'source' ? { sourceAnchor: a } : { targetAnchor: a }),
          },
          first
        );
      };
      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        edgeDragCleanupRef.current = null;
        edgeDragRef.current = null;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      edgeDragCleanupRef.current = finish;
    },
    [rf, anchorBoxes, onEdgeRoute]
  );

  /**
   * 段平移拖拽入口：index<0 = 在线上最近处新建一弯；index>=0 = 移动已有弯。
   * bend.t 记的是「拖的是基础路径上的哪一段」，之后拖动只改 (dx,dy)，
   * 因此端点方向、其余段都不受影响 —— 这是「拉一处不变另一处」的关键。
   */
  const startBendDrag = useCallback(
    (p: {
      edgeId: string;
      index: number;
      at?: { x: number; y: number };
      clientX: number;
      clientY: number;
    }) => {
      if (!editable || !onEdgeRoute) return;
      const ed = edges.find((x) => x.id === p.edgeId);
      if (!ed) return;
      const r = (ed.data as { route?: unknown } | undefined)?.route;
      const cur: EdgeBend[] = isBendRoute(r) ? r.bends.map((b) => ({ ...b })) : [];
      let index = p.index;
      let base = { dx: 0, dy: 0 };
      if (index < 0) {
        const flow = rf.screenToFlowPosition({ x: p.clientX, y: p.clientY });
        const near = nearestOnEdgePath(p.edgeId, flow.x, flow.y);
        /* 容差按缩放换算：屏幕上约 20px，缩得再小也抓得住 */
        const zoom = Math.max(0.2, rf.getZoom() || 1);
        const tol = 20 / zoom;
        if (!near || near.dist > tol) return;

        /**
         * 优先复用，绝不无脑新增 ——
         *   ① 按下的位置离已有弯很近（t 差 < 0.16，约等于同一段）→ 移动它；
         *   ② 弯数已达上限（3 个）→ 复用 t 最近的那个；
         * 只有「附近没弯且还没到上限」才真的新建。
         */
        let best = -1;
        let bestD = Infinity;
        cur.forEach((b, i) => {
          const dd = Math.abs(b.t - near.t);
          if (dd < bestD) {
            bestD = dd;
            best = i;
          }
        });
        if (best >= 0 && (bestD < 0.16 || cur.length >= MAX_WAYPOINTS)) {
          index = best;
          base = { dx: cur[best].dx, dy: cur[best].dy };
        } else {
          index = cur.length;
          cur.push({ t: near.t, dx: 0, dy: 0 });
          base = { dx: 0, dy: 0 };
        }
      } else {
        base = { dx: cur[index]?.dx ?? 0, dy: cur[index]?.dy ?? 0 };
      }
      runEdgeDrag(
        {
          kind: 'bend',
          edgeId: p.edgeId,
          index,
          bends: cur,
          base,
          sides: sidesOf(ed),
          startFlow: { x: 0, y: 0 },
          moved: false,
        },
        p.clientX,
        p.clientY
      );
    },
    [editable, onEdgeRoute, edges, rf, runEdgeDrag, sidesOf]
  );

  const startEndpointDrag = useCallback(
    (p: { edgeId: string; end: EdgeEnd; clientX: number; clientY: number }) => {
      if (!editable || !onEdgeRoute) return;
      const ed = edges.find((x) => x.id === p.edgeId);
      if (!ed) return;
      const nodeId = p.end === 'source' ? ed.source : ed.target;
      if (!anchorBoxes.get(nodeId)) return;
      const r = (ed.data as { route?: unknown } | undefined)?.route;
      const cur: EdgeBend[] = isBendRoute(r) ? r.bends.map((b) => ({ ...b })) : [];
      runEdgeDrag(
        {
          kind: 'endpoint',
          edgeId: p.edgeId,
          index: -1,
          end: p.end,
          nodeId,
          bends: cur,
          base: { dx: 0, dy: 0 },
          sides: sidesOf(ed),
          startFlow: { x: 0, y: 0 },
          moved: false,
        },
        p.clientX,
        p.clientY
      );
    },
    [editable, onEdgeRoute, edges, anchorBoxes, runEdgeDrag, sidesOf]
  );

  /** 右键连线 → 清空折点 + 解除端点吸附（draw.io 的 Reset line / Lucidchart 的 Reset line） */
  const resetEdgeRoute = useCallback(
    (edgeId: string) => {
      if (!onEdgeRoute) return;
      const ed = edges.find((x) => x.id === edgeId);
      if (!ed) return;
      const r = (ed.data as { route?: unknown } | undefined)?.route;
      if (!isEdgeRoute(r) && !isAnchorPinned(ed.data)) return;
      const sides = sidesOf(ed);
      onEdgeRoute(
        edgeId,
        {
          route: null,
          sourceHandle: sides.source,
          targetHandle: sides.target,
          anchorPinned: false,
          sourceAnchor: null,
          targetAnchor: null,
        },
        true
      );
    },
    [onEdgeRoute, edges, sidesOf]
  );

  const handleEdgeContextMenu: EdgeMouseHandler = useCallback(
    (evt, edge) => {
      if (!editable) return;
      evt.preventDefault();
      resetEdgeRoute(edge.id);
    },
    [editable, resetEdgeRoute]
  );

  /**
   * 批量复位走向：把选中连线的折点 + 端点吸附一起清空，交还给自动路由。
   * WP5b：折点不再有可视手柄，「删掉某一个点」对用户不可见，
   * 于是逃生口统一成「这条线重来」，并且和「端点自动」并列放在样式条上，看得见。
   */
  const resetSelectedEdges = useCallback(() => {
    if (!editable || selectedEdgeIds.length === 0) return;
    /* onEdgeRouteReset 会连折点一起清；老宿主只接了 onEdgeAnchorReset 时退化成只解端点 */
    if (onEdgeRouteReset) onEdgeRouteReset(selectedEdgeIds);
    else onEdgeAnchorReset(selectedEdgeIds);
  }, [editable, selectedEdgeIds, onEdgeRouteReset, onEdgeAnchorReset]);

  /** 画布委托：按住线身拖动 = 新建折点。端点热区与手柄各自处理，这里放行。 */
  const handleEdgePointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (!editable) return;
      if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
      const t = ev.target as Element;
      if (t.closest('.react-flow__edgeupdater')) return; // 端点热区 → RF 重连
      if (t.closest('.fn-ep')) return; // 端点手柄自己处理（段标识是纯视觉，不挡事件）
      const g = t.closest('.react-flow__edge');
      if (!g) return;
      const id = g.getAttribute('data-id') ?? '';
      const ed = edges.find((x) => x.id === id);
      /* WP5b：肘线 / 曲线 / 直线都能拖，不再只有肘线能编辑 */
      if (!ed || !isRoutableEdgeType(ed.type)) return;
      startBendDrag({ edgeId: id, index: -1, clientX: ev.clientX, clientY: ev.clientY });
    },
    [editable, edges, startBendDrag]
  );

  /* 卸载兜底：拖拽中途切文档/关面板时清掉监听，防泄漏 */
  useEffect(
    () => () => {
      edgeDragCleanupRef.current?.();
    },
    []
  );

  const displayedEdges = useMemo<Edge[]>(() => {
      const act = scenario ? scenario.activeEdges : null;
      return edges.map((e) => {
      const active = act ? act.has(e.id) : true;
      /** focusAll：不压暗非路线连线（仍用 idle 色，路线边保持加粗强调） */
      const dim = act && !active && !focusAll;
      /**
       * Build M：激活边显著加粗并加深蓝，非激活边压到近乎隐形 ——
       * 复杂图里要靠「粗细差 + 明度差」而非纯色差来区隔。
       * 颜色全部走 CSS 变量（--edge-* / --route-label-*）：
       * 边的 stroke 与箭头 marker 都由这里驱动，硬编码会让暗色主题下深蓝线条糊在深底上。
       */
      /* 回边（返工）：紫色，与蓝色主干明显区分 —— 一眼看出这是「转回去」的那条线 */
      const isLoop = !!scenario?.loopEdges?.has(e.id);
      const color = isLoop
        ? '#8b5cf6'
        : dim
          ? 'var(--edge-off)'
          : active && act
            ? 'var(--edge-route)'
            : 'var(--edge-idle)';
      const label = edgeLabelOf(e);
      const labelStyle =
        active && act
          ? { fill: 'var(--route-label-fg)', fontWeight: 600 as const, fontSize: 11 }
          : { fill: 'var(--ink-3)', fontSize: 11 };
      const labelBgStyle =
        active && act ? { fill: 'var(--route-label-bg)' } : { fill: 'var(--surface-2)' };
      const chainCls = !chain ? '' : chainRes.edges.has(e.id) ? 'chain-hit' : 'chain-miss';
      /* 循环可视化：路径上的回边（返工）单独标记 */
      const loopCls = isLoop ? 'loop-back' : '';
      /* route-on = 路线主干；route-done = 整条路线已确定（实线+发光，区别于"还在走"的流动虚线） */
      const routeCls = act
        ? active
          ? routeDone
            ? 'route-on route-done'
            : 'route-on'
          : 'route-off'
        : '';
      const cls = [chainCls, routeCls, loopCls].filter(Boolean).join(' ');
      /* 端点选边：钉住过（用户拖过端点 / 导入时自带）就照旧，否则按相对位置自动。
         拖动中相关边先读锁定（dragSideRef），命中则不动 —— 杜绝临界角反复横跳。 */
      const pinned = isAnchorPinned(e.data);
      const inferred = anchorOf(e.source, e.target);
      const locked = dragSideRef.current.get(e.id);
      const auto = locked
        ? { source: locked.source, target: locked.target, ok: inferred.ok }
        : inferred;
      /**
       * 0918：measured 未就绪（刚导入 / 刚粘贴的第一帧）时，自动边改读持久化的侧边
       * （由 onSyncEdgeSides 在实测就绪后写回），这样还原出来的走向与原图一致，
       * 而不是按 180×46 兜底尺寸重新推断一次。
       */
      const sides = pinned
        ? { source: e.sourceHandle ?? 'bottom', target: e.targetHandle ?? 'top' }
        : auto.ok
          ? { source: auto.source, target: auto.target }
          : { source: e.sourceHandle ?? auto.source, target: e.targetHandle ?? auto.target };
      /* 端点自由吸附：{side, t} → 画布坐标（随节点位置 / 尺寸实时换算） */
      const ed0 = (e.data ?? {}) as { sourceAnchor?: unknown; targetAnchor?: unknown };
      const sa = isEdgeAnchor(ed0.sourceAnchor) ? ed0.sourceAnchor : null;
      const ta = isEdgeAnchor(ed0.targetAnchor) ? ed0.targetAnchor : null;
      const sBox = anchorBoxes.get(e.source);
      const tBox = anchorBoxes.get(e.target);
      const ap = sa && sBox ? anchorPoint(sBox, sa) : null;
      const bp = ta && tBox ? anchorPoint(tBox, ta) : null;
      /* WP5：有折点 / 旧版单轴路由 / 端点被吸到自定义位置 → 都交给 ManualEdge 自绘。
         WP5b：肘线 / 曲线 / 直线一视同仁，三者共用同一份折点数据，只是穿线方式不同。
         P2：只要是三种可路由线型就一律自绘 —— 否则没有折点的普通连线会走 React Flow
         内置组件，其 EdgeText 是单行 SVG <text>（源码连 tspan 都没有），长说明会被拉成
         一条横穿画布的线，HTML chip（限宽换行）根本没机会出现。第 4 档回落的
         getBezierPath / getStraightPath / getSmoothStepPath 与内置算法完全一致。 */
      const manual = isRoutableEdgeType(e.type);
      const manualCls = manual ? (cls ? `${cls} fn-manual-route` : 'fn-manual-route') : cls;
      return {
        ...e,
        ...(manual ? { type: 'fn-manual' as const } : {}),
        ...(manualCls ? { className: manualCls } : {}),
        sourceHandle: sides.source,
        targetHandle: sides.target,
        data: {
          ...e.data,
          /* 连线类型透传给 ManualEdge：决定折点之间是正交 / 平滑曲线 / 尖角折线 */
          _et: e.type ?? 'smoothstep',
          ...(ap && sa ? { _ap: ap, _aSide: sa.side } : {}),
          ...(bp && ta ? { _bp: bp, _bSide: ta.side } : {}),
          /* 点2(b) chip 自动亮暗：EdgeLabelRenderer 独立于边子树，chain/边透明度
             够不到 chip，必须显式传状态（is-active 情景主干 / is-dim 路线外 / is-hit·is-miss 链路） */
          _lblActive: act ? active : false,
          _lblDim: !!dim,
          _chain: chainCls === 'chain-hit' ? ('hit' as const) : chainCls === 'chain-miss' ? ('miss' as const) : undefined,
          /* 点2(a) 拖动偏移：持久化在 edge.data.labelOffset（normalizeEdge 透传 data） */
          ...((e.data as { labelOffset?: { dx: number; dy: number } } | null)?.labelOffset
            ? { _lblOff: (e.data as { labelOffset: { dx: number; dy: number } }).labelOffset }
            : {}),
          _onMoveLabel: onMoveLabel,
        },
        /* 加宽命中带：2px 的线不该只有 2px 的可抓范围（RF 会从 edge 上读这个字段） */
        interactionWidth: 26,
        /* 圆角半径 5→10：默认 5px 在短线上几乎看不见（用户反馈"没感知到变化"），
           加大后斜向连线的拐弯一眼可辨。smoothstep 专用，bezier/straight 忽略。 */
        pathOptions: { borderRadius: 10 },
        label,
        style: {
          stroke: color,
          strokeWidth: dim ? 1 : active && act ? 2.8 : 1.7,
          strokeDasharray: dim ? '4 5' : undefined,
          opacity: dim ? 0.2 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: active && act ? 19 : 16,
          height: active && act ? 19 : 16,
          color,
        },
        labelStyle,
        labelBgStyle,
        labelBgPadding: [5, 2] as [number, number],
        labelBgBorderRadius: 4,
      };
    });
  }, [
    edges,
    scenario,
    focusAll,
    routeDone,
    edgeLabelOf,
    chain,
    chainRes,
    anchorOf,
    onMoveLabel,
    anchorBoxes,
    onEdgeRename,
  ]);

  /* WP5 手柄数据：选中连线后要在画布上画出的端点（方）。
     刻意放在 FlowCanvas 而不是 ManualEdge —— 没有折点的边走的是 RF 内置渲染器
     （且 .react-flow__nodes 层在 edgelabel-renderer 之上），手柄若挂在自定义边组件里，
     这些边就永远拿不到端点手柄：用户得先拖出折点才能调端点，不合理。

     WP5b：折点不再有可视手柄；WP5c 起改为「悬停 / 选中时才浮出蓝色段标识」，
     数量 = 这条线有几个弯，不会越拖越多。 */
  const edgeHandles = useMemo(() => {
    if (!editable) return [];
    if (!selectedEdgeIds.length && !hoverEdgeId) return [];
    const out: {
      edgeId: string;
      src: { x: number; y: number };
      tgt: { x: number; y: number };
      /** 段标识（蓝点）：只有真正有弯时才会有 */
      bends: { x: number; y: number }[];
      /** 这条线是不是被选中（选中才额外出端点方柄，仅悬停时画面更干净） */
      selected: boolean;
    }[] = [];
    /* 选中 或 悬停 —— 平时不显示，画面保持干净 */
    const ids = Array.from(new Set([...selectedEdgeIds, ...(hoverEdgeId ? [hoverEdgeId] : [])]));
    for (const id of ids) {
      const e = edges.find((x) => x.id === id);
      if (!e || !isRoutableEdgeType(e.type)) continue;
      const sBox = anchorBoxes.get(e.source);
      const tBox = anchorBoxes.get(e.target);
      if (!sBox || !tBox) continue;
      const sides = isAnchorPinned(e.data)
        ? { source: e.sourceHandle ?? 'bottom', target: e.targetHandle ?? 'top' }
        : inferAnchorSides(sBox, tBox);
      const d = (e.data ?? {}) as {
        sourceAnchor?: unknown;
        targetAnchor?: unknown;
        route?: unknown;
      };
      const sa = isEdgeAnchor(d.sourceAnchor) ? d.sourceAnchor : null;
      const ta = isEdgeAnchor(d.targetAnchor) ? d.targetAnchor : null;
      const src = sa ? anchorPoint(sBox, sa) : sideCenter(sBox, sides.source);
      const tgt = ta ? anchorPoint(tBox, ta) : sideCenter(tBox, sides.target);
      /* 弯的抓手位置：拿同一套参数再算一次路由即可（纯函数，与渲染结果一致） */
      let bends: { x: number; y: number }[] = [];
      if (isBendRoute(d.route)) {
        const r = bendRoutePath(e.type ?? 'smoothstep', {
          ax: src.x,
          ay: src.y,
          aSide: sa ? sa.side : (sides.source as 'top'),
          bx: tgt.x,
          by: tgt.y,
          bSide: ta ? ta.side : (sides.target as 'top'),
          bends: d.route.bends,
        });
        bends = r?.handles ?? [];
      }
      out.push({ edgeId: id, src, tgt, bends, selected: selectedEdgeIds.includes(id) });
    }
    return out;
  }, [editable, selectedEdgeIds, hoverEdgeId, edges, anchorBoxes]);

  /* —— 双击连线 chip → 浮层改名 —— */
  const onEdgeDoubleClick: EdgeMouseHandler = useCallback((e, edge) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const x = e.clientX - (rect?.left ?? 0);
    const y = e.clientY - (rect?.top ?? 0);
    setEditingEdge({ edgeId: edge.id, x, y, initial: typeof edge.label === 'string' ? edge.label : '' });
    setEdgeEditText(typeof edge.label === 'string' ? edge.label : '');
  }, []);

  const commitEdgeRename = useCallback(() => {
    if (editingEdge) {
      onEdgeRename(editingEdge.edgeId, edgeEditText.trim());
      setEditingEdge(null);
    }
  }, [editingEdge, edgeEditText, onEdgeRename]);

  /** 单击空白 → 清空选中 + 退出链路高亮。
   *  注意：新建菜单（US-01 双击空白）改由 wrapper 层 dblclick 触发——
   *  React Flow 的 onPaneClick 收到的是 detail=0 的合成事件，无法用 detail===2 区分双击。 */
  const handlePaneClick = useCallback(() => {
    onPaneClickClear();
    setChain(null);
  }, [onPaneClickClear]);

  /** 双击空白新建（US-01 / WP4 表达入口）：仅在落点是 pane 空白时触发，
   *  节点/边/浮层上的双击各自有 handler 且已 stopPropagation（这里是兜底排除）。 */
  const handleWrapDoubleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (
        t.closest(
          '.react-flow__node, .react-flow__edge, .selbar, .edge-style-bar, .ctx-menu, ' +
            '.type-picker, .color-pop, .edge-rename-pop, .help-fab, .mini-toggle, .chap-bar, .chain-bar, .canvas-empty'
        )
      ) {
        return;
      }
      onPaneDoubleClick(e.clientX, e.clientY);
    },
    [onPaneDoubleClick]
  );

  /** 连线样式点击：有选中边 → 改选中；无 → 设默认 */
  const applyEdgeType = useCallback(
    (type: string) => {
      onEdgeTypeApply(selectedEdgeIds.length ? selectedEdgeIds : null, type);
    },
    [selectedEdgeIds, onEdgeTypeApply]
  );

  const selectedTypes = new Set(
    displayedEdges.filter((e) => selectedEdgeIds.includes(e.id)).map((e) => e.type)
  );
  const curType = selectedEdgeIds.length
    ? selectedTypes.size === 1
      ? [...selectedTypes][0]
      : null
    : defaultEdgeType;

  /** 选中连线里有多少条被手动钉住过端点 / 被拽过线身 → 给出「交还自动」的出口 */
  const pinnedSelCount = useMemo(
    () =>
      edges.filter(
        (e) =>
          selectedEdgeIds.includes(e.id) &&
          (isAnchorPinned(e.data) || isEdgeRoute((e.data as { route?: unknown } | undefined)?.route))
      ).length,
    [edges, selectedEdgeIds]
  );

  const showStyleBar = editable && edges.length > 0;

  /* WP4：标注指示线 overlay（世界坐标线 → 容器屏幕坐标）。
     依赖 viewport（useStore 订阅）：缩放/平移/拖节点时 RF transform 变化 → 重画跟手。 */
  const exprArrowSegs = useMemo(() => {
    if (view !== 'flow') return [];
    const segs: { id: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const n of displayedNodes) {
      if ((n as { type?: string }).type !== 'label') continue;
      const ld = n.data as Partial<LabelNodeData>;
      const a = ld.arrow;
      if (!a) continue;
      const h = n.measured?.height ?? 40;
      const s = toWrapper(rf.flowToScreenPosition({ x: n.position.x + 6, y: n.position.y + h - 5 }));
      const e = toWrapper(rf.flowToScreenPosition({ x: a.x, y: a.y }));
      segs.push({ id: n.id, x1: s.x, y1: s.y, x2: e.x, y2: e.y });
    }
    return segs;
  }, [displayedNodes, view, viewport, rf, toWrapper]);

  const chainRootLabel = chain
    ? (nodes.find((n) => n.id === chain.id)?.data?.label ?? '该节点')
    : '';

  const edgeTypes = useMemo(() => ({ 'fn-manual': ManualEdge }), []);

  return (
    <>
      <div
        className="canvas-wrap"
        data-editable={editable ? '1' : '0'}
        ref={wrapperRef}
        onPointerMove={handlePointerMove}
        onPointerDown={handleEdgePointerDown}
        onDoubleClick={handleWrapDoubleClick}
      >
      {/* WP2 拉线预览方向箭头：隐藏 defs 全局单实例。fill=currentColor → 跟随
          预览线的 color（CSS 按 valid/invalid 切换），实现"可接=蓝、不可接=灰"。 */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
        <defs>
          <marker
            id="fn-conn-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0 1 L9 5 L0 9 Z" fill="currentColor" />
          </marker>
          {/* WP4 标注指示线端点箭头（中性灰，亮暗主题通吃） */}
          <marker
            id="fn-expr-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0 1 L9 5 L0 9 Z" fill="#8a94a6" />
          </marker>
        </defs>
      </svg>
      <ReactFlow<SopFlowNode, Edge>
        /* Build M：只有情景态才挂 has-scenario —— 编辑态所有节点都是 st-active，
           若不做这层区分，路线高亮会误伤编辑态的普通节点。
           no-connect：只读（情景导航/查看）时把四向连接点整体隐形 ——
           连接点保留在 DOM 里（RF 要靠它算端点坐标），只是不显示、不可点。 */
        className={[scenario ? 'has-scenario' : '', editable ? '' : 'no-connect']
          .filter(Boolean)
          .join(' ')}
        nodes={displayedNodes}
        edges={displayedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        /* 四向连线：任意一侧的连接点都能发起/接收连线（React Flow loose 模式） */
        connectionMode={ConnectionMode.Loose}
        /* WP2 拉线预览 = 圆角肘线（与成品线一致，所见即所得）+ 磁吸合法性判定 */
        connectionLineType={ConnectionLineType.SmoothStep}
        isValidConnection={isValidEdgeConnection}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={mode === 'edit' ? undefined : handleNodeClick}
        onConnect={editable ? onConnect : undefined}
        onReconnect={editable ? onReconnect : undefined}
        edgesReconnectable={editable}
        /* 端点拖拽：松手靠近哪一侧的连接点就吸附到哪侧（reconnectRadius 放大到 22，
           原来默认 10 太小，端点基本抓不住 → 用户感觉「线是死的拉不动」） */
        reconnectRadius={22}
        /* 连线落点吸附半径：整条边都能作为落点，不必精确命中 8px 小圆点 */
        connectionRadius={34}
        onEdgeDoubleClick={editable ? onEdgeDoubleClick : undefined}
        /* 右键连线 → 清空折点 + 解除端点吸附（等价于 draw.io / Lucidchart 的 Reset line） */
        onEdgeContextMenu={editable ? handleEdgeContextMenu : undefined}
        onEdgeMouseEnter={editable ? (_, e) => setHoverEdgeId(e.id) : undefined}
        onEdgeMouseLeave={editable ? () => setHoverEdgeId(null) : undefined}
        onPaneClick={handlePaneClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onNodeContextMenu={
          editable
            ? (evt, node) => {
                evt.preventDefault();
                /* WP4：表达节点右键 → 仅删除 / 清指示线，不做 kind 类型切换 */
                if (isExprNode(node)) {
                  const ld = node.data as Partial<LabelNodeData> | undefined;
                  setCtxMenu({
                    nodeId: node.id,
                    expr: true,
                    hasArrow: !!ld?.arrow,
                    x: evt.clientX,
                    y: evt.clientY,
                  });
                  return;
                }
                const kind = ((node.data as Partial<SopNodeData> | undefined)?.kind ??
                  'step') as NodeKind;
                setCtxMenu({ nodeId: node.id, kind, x: evt.clientX, y: evt.clientY });
              }
            : undefined
        }
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        /* 交互模型（v0.1.3 · 回归主流画板，调研结论：飞书/Figma/Miro 均左键拖=框选）
         *  - 空白处按住左键拖动 = 框选多个节点（selectionOnDrag；只读浏览态退回左键拖=平移）
         *  - 平移画布 = 空格+左键拖 / 鼠标中键拖 / 鼠标右键拖（panOnDrag 数组 [1,2]：右键+中键；空格临时平移由 RF 内建）
         *  - 滚轮/触控板双指滑动 = 上下左右滚动画布（panOnScroll）
         *  - Ctrl+滚轮 / 触控板双指捏合 = 缩放（zoomOnPinch 拦截 ctrl+wheel 转 zoom）
         *  - 节点：单击只选中它自己（编辑态不再点亮上下游链），双击进入原地改名 */
        selectionOnDrag={editable}
        panOnDrag={editable ? [1, 2] : true}
        panOnScroll
        panOnScrollSpeed={1}
        zoomOnScroll={false}
        zoomOnPinch
        /* 双击缩放只在浏览态开放（scenario/view）；编辑态双击空白=新建菜单（US-01/WP4），
           若开着 RF 会在 pane dblclick 上 zoom 并 stopPropagation，事件到不了 wrapper 层 */
        zoomOnDoubleClick={!editable}
        zoomActivationKeyCode="Control"
        multiSelectionKeyCode={['Shift', 'Control']}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        snapToGrid={editable && snapToGrid}
        snapGrid={[16, 16]}
        minZoom={0.25}
        fitView
        fitViewOptions={{ padding: 0.14 }}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: defaultEdgeType }}
      >
        {gridVisible && <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="#d7dde6" />}
        <Controls showInteractive={false} />
        {/* Bug3c：缩略导航图默认收起（常驻会挡住右下角内容），点「导航图」按需展开。
            按钮绝对定位右下角；MiniMap 展开时由 CSS 上移（bottom:50px）给它让位。 */}
        {view === 'flow' && miniOpen && <MiniMap pannable zoomable position="bottom-right" />}
        {view === 'flow' && (
          <button
            className={`mini-toggle ${miniOpen ? 'on' : ''}`}
            onClick={() => setMiniOpen((v: boolean) => !v)}
            aria-expanded={miniOpen}
            aria-label={miniOpen ? '收起缩略导航图' : '展开缩略导航图'}
            title={miniOpen ? '收起导航图' : '展开导航图'}
          >
            {miniOpen ? '收起导航' : '导航图'}
          </button>
        )}
      </ReactFlow>

      {/* Build J · 光标柔光：跟随指针的一小片光晕，给玻璃浮层一点"可透的内容" */}
      <div className="canvas-spot" ref={spotRef} aria-hidden="true" />

      {/* Build L · 拖拽对齐参考线（容器内坐标，虚线 + 快速淡入） */}
      {guides && (guides.v.length > 0 || guides.h.length > 0) && (
        <svg className="align-guides" data-testid="align-guides" aria-hidden="true">
          {guides.v.map((ax, i) => {
            const p = toWrapper(rf.flowToScreenPosition({ x: ax, y: 0 }));
            return <line key={`v${i}`} x1={p.x} y1={0} x2={p.x} y2="100%" />;
          })}
          {guides.h.map((ay, i) => {
            const p = toWrapper(rf.flowToScreenPosition({ x: 0, y: ay }));
            return <line key={`h${i}`} x1={0} y1={p.y} x2="100%" y2={p.y} />;
          })}
        </svg>
      )}

      {/* WP5 · 连线端点手柄覆盖层：选中连线后只在两端浮出方柄（可拖到边框任意位置）。
          WP5b：折点不再有任何可视手柄 —— 改线直接拖线身即可，避免「固定圆点」堆满画面。
          画在 ReactFlow 之外的画布层，才不会被 .react-flow__nodes 盖住。
          位置每次渲染时按当前视口换算（FlowCanvas 已订阅 transform，平移缩放会重渲染）。 */}
      {edgeHandles.length > 0 && (
        <div className="fn-handles" data-testid="fn-handles">
          {edgeHandles.map((h) => {
            const sp = toWrapper(rf.flowToScreenPosition(h.src));
            const tp = toWrapper(rf.flowToScreenPosition(h.tgt));
            return (
              <Fragment key={h.edgeId}>
                {/* 段标识（蓝色小点）：一个弯一个，拖它 = 把那一段推开 */}
                {h.bends.map((b, i) => {
                  const bp = toWrapper(rf.flowToScreenPosition(b));
                  return (
                    <div
                      key={`bd-${i}`}
                      className="fn-bend"
                      data-testid="fn-bend"
                      data-index={i}
                      /* 纯视觉提示：不抢事件（pointer-events 继承父层的 none）。
                         拖它 = 直接拖线身，startBendDrag 会就近复用这个弯；
                         若让它可点，右键 / 拖线身落在标识上就会被吞掉。 */
                      style={{ left: bp.x, top: bp.y }}
                      title="在这里按住拖动，即可把这一段推开"
                    />
                  );
                })}
                {h.selected && (
                <Fragment>
                <div
                  className="fn-ep fn-ep-source"
                  data-testid="fn-ep-source"
                  style={{ left: sp.x, top: sp.y, pointerEvents: 'all' }}
                  title="拖到节点边框任意位置"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    startEndpointDrag({
                      edgeId: h.edgeId,
                      end: 'source',
                      clientX: e.clientX,
                      clientY: e.clientY,
                    });
                  }}
                />
                <div
                  className="fn-ep fn-ep-target"
                  data-testid="fn-ep-target"
                  style={{ left: tp.x, top: tp.y, pointerEvents: 'all' }}
                  title="拖到节点边框任意位置"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    startEndpointDrag({
                      edgeId: h.edgeId,
                      end: 'target',
                      clientX: e.clientX,
                      clientY: e.clientY,
                    });
                  }}
                />
                </Fragment>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {/* WP4 · 标注指示线（画布级 overlay：起点=卡片左下角，终点=data.arrow 世界坐标） */}
      {exprArrowSegs.length > 0 && (
        <svg className="expr-arrow-layer" data-testid="expr-arrow-layer" aria-hidden="true">
          {exprArrowSegs.map((l) => (
            <line
              key={l.id}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              markerEnd="url(#fn-expr-arrow)"
            />
          ))}
        </svg>
      )}

      {/* Build K-⑤ · 引导章节条（底部居中；搜索打开或链路追踪激活时让位） */}
      {!searchOpen && !chain && chapters.length >= 2 && (
        <div className="chap-bar" data-testid="chap-bar">
          <button
            className={`ch-caret ${chapOpen ? '' : 'off'}`}
            onClick={() => setChapOpen((v) => !v)}
            aria-expanded={chapOpen}
            aria-label={chapOpen ? '收起章节条' : '展开章节条'}
            title={chapOpen ? '收起章节' : '展开章节'}
          >
            ▾
          </button>
          {chapOpen && (
            <div className="ch-items">
              {chapters.map((ch, i) => (
                <button
                  key={i}
                  className="ch-item"
                  data-testid={`chap-${i}`}
                  title={`第 ${i + 1} 段：${ch.nodeIds.length} 个节点，点击定位`}
                  onClick={() => {
                    setChain(null);
                    onFocusNode?.(ch.nodeIds[0]);
                  }}
                >
                  <span className="ch-idx">{i + 1}</span>
                  <span className="ch-label">{ch.label}</span>
                  {i < chapters.length - 1 && <span className="ch-arrow">→</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Build L · 命令面板（Ctrl/Cmd+K） */}
      {cmdOpen && (
        <CommandPalette items={allCommands} onClose={() => setCmdOpen(false)} />
      )}

      {/* Build K-④ · 画布搜索（Ctrl/Cmd+F） */}
      {searchOpen && (
        <CanvasSearch
          query={searchQ}
          hits={searchHits}
          activeId={searchActiveId}
          onQuery={(q) => {
            setSearchQ(q);
            setSearchIdx(0);
          }}
          onNext={searchNext}
          onPrev={searchPrev}
          onPick={(id, idx) => {
            setSearchIdx(idx);
            focusHit(id);
          }}
          onClose={closeSearch}
        />
      )}

      {/* Build J · 「?」按需指引（右下角，导航图上方） */}
      <button
        className={`help-fab ${guideOpen ? 'on' : ''}`}
        data-testid="help-fab"
        onClick={() => setGuideOpen((v) => !v)}
        aria-expanded={guideOpen}
        aria-label={guideOpen ? '关闭操作指引' : '打开操作指引'}
        title="操作指引（快捷键 / 鼠标操作）"
      >
        ?
      </button>
      {guideOpen && <GuidePanel onClose={() => setGuideOpen(false)} />}

      {/* Build J · 链路状态条：显示当前追踪范围，可切「仅相邻」或退出 */}
      {chain && (
        <div className="chain-bar" data-testid="chain-bar">
          <span className="cb-text">
            高亮 <b>{chainRootLabel}</b> 的{chain.scope === 'full' ? '整条链路' : '直接上下游'} ·{' '}
            <b>{chainRes.nodes.size}</b> 个节点
          </span>
          <button
            className="cb-btn"
            data-testid="chain-scope"
            onClick={() =>
              setChain((c) =>
                c ? { id: c.id, scope: c.scope === 'full' ? 'adjacent' : 'full' } : c
              )
            }
          >
            {chain.scope === 'full' ? '仅相邻' : '全链路'}
          </button>
          <button
            className="cb-btn close"
            data-testid="chain-close"
            onClick={() => setChain(null)}
            title="退出高亮（Esc）"
          >
            关闭
          </button>
        </div>
      )}

      {/* E4 多选浮动工具条（配色 / 删除） */}
      <SelectionBar
        nodes={displayedNodes}
        editable={editable}
        onPaintSel={onPaintSel}
        onDeleteSel={onDeleteSel}
      />

      {/* 连线样式工具条：无选中 → 设默认（新连线）；有选中 → 批量改选中边 */}
      {showStyleBar && (
        <div className="edge-style-bar" data-testid="edge-style-bar">
          <span className="esb-hint">
            {selectedEdgeIds.length ? `已选 ${selectedEdgeIds.length} 条连线` : '新连线样式'}
          </span>
          <div className="esb-opts">
            {EDGE_TYPE_OPTIONS.map((o) => (
              <button
                key={o.id}
                className={`esb-opt ${curType === o.id ? 'on' : ''}`}
                title={o.hint}
                onClick={() => applyEdgeType(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {pinnedSelCount > 0 && (
            <button
              className="esb-auto"
              data-testid="edge-route-reset"
              title="这些连线被手动拖过（折点 / 端点位置已固定）。点这里整条交还给自动：折点清空、端点重新跟着节点位置走"
              onClick={resetSelectedEdges}
            >
              ⟲ 复位走向（{pinnedSelCount}）
            </button>
          )}
        </div>
      )}

      {/* 节点右键菜单（B4）：类型切换 + 删除。表达节点只给删除（WP4） */}
      {ctxMenu && (
        <div
          className="ctx-menu"
          data-testid="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="ctx-head">
            {ctxMenu.expr ? '自由表达元素' : `${KIND_TAG[ctxMenu.kind ?? 'step'] || '步骤'} →`}
          </div>
          {!ctxMenu.expr &&
            KIND_OPTIONS.filter((o) => {
              if (o.kind === ctxMenu.kind) return false;
              if (o.kind === 'io-start' || o.kind === 'io-end') {
                return !nodes.some((n) => n.id !== ctxMenu.nodeId && n.data.kind === o.kind);
              }
              return true;
            }).map((o) => (
              <button
                key={o.kind}
                className="ctx-item"
                onClick={() => {
                  if (!ctxMenu.kind) return;
                  onChangeKind(ctxMenu.nodeId, o.kind);
                  setCtxMenu(null);
                }}
              >
                转为{o.label}
              </button>
            ))}
          {/* 点1 自定义换行：每行字数规则（null = 关闭，恢复到宽度自动折行） */}
          {!ctxMenu.expr && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-head">每行字数</div>
              {[null, 4, 6, 8, 12].map((c) => (
                <button
                  key={String(c)}
                  className="ctx-item"
                  data-testid={`wrap-cols-${c ?? 'off'}`}
                  onClick={() => {
                    onChangeWrapCols(ctxMenu.nodeId, c);
                    setCtxMenu(null);
                  }}
                >
                  {c === null ? '自动换行（不按字数）' : `每行 ${c} 字`}
                </button>
              ))}
            </>
          )}
          {!ctxMenu.expr && <div className="ctx-sep" />}
          <button
            className="ctx-item danger"
            onClick={() => {
              onDeleteNode(ctxMenu.nodeId);
              setCtxMenu(null);
            }}
          >
            删除节点
          </button>
        </div>
      )}

      {/* 连线标签改名浮层（双击 chip 弹出） */}
      {editingEdge && (
        <div className="edge-rename-pop" style={{ left: editingEdge.x, top: editingEdge.y - 30 }}>
          <textarea
            autoFocus
            className="edge-rename-input"
            value={edgeEditText}
            aria-label="连线名称"
            placeholder="连线说明…（Enter 保存，Shift+Enter 换行，留空清除）"
            onChange={(e) => setEdgeEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitEdgeRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditingEdge(null);
              }
            }}
            onBlur={commitEdgeRename}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
      </div>
    </>
  );
}
