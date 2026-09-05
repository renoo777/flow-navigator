/** FlowCanvas：受控 React Flow 画布封装
 *  节点/边装饰 · 双击改名 · 情景高亮 · 只读 · 连线样式工具条
 *  E1-E7：框选三件套 / 网格吸附显隐 / 连线重连 / MiniMap / SelectionBar(对齐分布配色删除) */
import {
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
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useReactFlow,
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
import { computeSnap, deriveChapters, searchNodes, traceChain } from '@flow/core';
import { EDGE_TYPE_OPTIONS, KIND_OPTIONS, KIND_TAG } from './appearance';
import { CanvasSearch } from './components/CanvasSearch';
import { CommandPalette, type CommandItem } from './components/CommandPalette';
import { SopNode, type NodePaint, type SopFlowNode } from './components/SopNode';
import type { SopNodeData } from './components/SopNode';

export type { SopFlowNode, NodePaint } from './components/SopNode';

export interface FlowCanvasProps {
  nodes: SopFlowNode[];
  edges: Edge[];
  mode: FlowMode;
  view: FlowView;
  variables: FlowVariable[];
  scenario: ScenarioResult | null;
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
  defaultEdgeType: string;
  /** 可编辑（edit 且非只读） */
  editable: boolean;
  /** 拖动开始时记录历史快照（E1） */
  onNodeDragStart?: () => void;
  /* --- E4/E5 SelectionBar 动作 --- */
  onAlignDir: (dir: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom') => void;
  onDistribute: (axis: 'h' | 'v') => void;
  onPaintSel: (paint: NodePaint | null) => void;
  onDeleteSel: () => void;
  /* --- 右键菜单（B4：节点类型切换 + 删除）--- */
  onChangeKind: (nodeId: string, kind: NodeKind) => void;
  onDeleteNode: (nodeId: string) => void;
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

const nodeTypes = { sop: SopNode };

/** E5 内置调色板（FigJam 风：中性 + 语义 + 品牌蓝） */
const PAINT_SWATCHES = [
  '#ffffff', '#eef1f5', '#dbe2ea',
  '#fee2e2', '#ffedd5', '#fef9c3', '#dcfce7', '#dbeafe', '#e0e7ff', '#f3e8ff',
  '#1f2937', '#475569', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0ea5e9',
];

const SCOPE_LABEL: Record<string, string> = { bg: '底色', text: '文字', stroke: '边框' };
const SCOPE_KEY: Record<string, keyof NodePaint> = { bg: 'bg', text: 'text', stroke: 'stroke' };

/** 浮动工具条：选中 ≥1 节点时浮在选区上方（对齐 6 向 / 分布 / 配色 / 删除） */
function SelectionBar({
  nodes,
  editable,
  onAlignDir,
  onDistribute,
  onPaintSel,
  onDeleteSel,
}: {
  nodes: SopFlowNode[];
  editable: boolean;
  onAlignDir: FlowCanvasProps['onAlignDir'];
  onDistribute: FlowCanvasProps['onDistribute'];
  onPaintSel: FlowCanvasProps['onPaintSel'];
  onDeleteSel: () => void;
}) {
  const rf = useReactFlow<SopFlowNode, Edge>();
  const [scope, setScope] = useState<keyof NodePaint>('bg');
  const [colorOpen, setColorOpen] = useState(false);
  const sel = useMemo(() => nodes.filter((n) => n.selected), [nodes]);

  /** 浮动工具条：选中 ≥1 节点时浮在选区上方（对齐 6 向 / 分布 / 配色 / 删除）
   * Q1 修复：disabled 灰按钮改为按选中数条件渲染——单选只显「颜色/删除」；2 选再显对齐；≥3 选再显均分。
   * 同时取消 view==='flow' 限制，话术层亦可定位与重排。 */
  const showAlign = sel.length >= 2;
  const showDistribute = sel.length >= 3;
  const showColorDel = sel.length >= 1;
  if (!editable || !showColorDel) return null;

  const wOf = (n: SopFlowNode) => {
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
        {showAlign && (
          <>
            <div className="sb-group">
              {(
                [
                  ['left', '左', '左对齐'],
                  ['centerX', '中', '水平居中'],
                  ['right', '右', '右对齐'],
                  ['top', '上', '顶对齐'],
                  ['centerY', '中', '垂直居中'],
                  ['bottom', '下', '底对齐'],
                ] as const
              ).map(([dir, txt, hint]) => (
                <button
                  key={dir}
                  className="sb-btn"
                  title={hint}
                  onClick={() => onAlignDir(dir)}
                >
                  {txt}
                </button>
              ))}
            </div>
            {(showDistribute || showColorDel) && <div className="sb-sep" />}
          </>
        )}
        {showDistribute && (
          <>
            <div className="sb-group">
              <button className="sb-btn wide" title="水平等距分布" onClick={() => onDistribute('h')}>
                横均分
              </button>
              <button className="sb-btn wide" title="垂直等距分布" onClick={() => onDistribute('v')}>
                纵均分
              </button>
            </div>
            {showColorDel && <div className="sb-sep" />}
          </>
        )}
        {showColorDel && (
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
        )}
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
    title: '选择',
    rows: [
      ['左键拖', '框选多个'],
      ['中键拖', '平移画布'],
      ['滚轮', '缩放'],
      ['双击连线', '给出口改名'],
    ],
  },
  {
    title: '链路',
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
  variables,
  scenario,
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
  onAlignDir,
  onDistribute,
  onPaintSel,
  onDeleteSel,
  onChangeKind,
  onDeleteNode,
  onTalkEdit,
  onFocusNode,
  commands,
  snapToGrid,
  gridVisible,
}: FlowCanvasProps) {
  const [editingEdge, setEditingEdge] = useState<{
    edgeId: string;
    x: number;
    y: number;
    initial: string;
  } | null>(null);
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
  /** 右键菜单（B4）：编辑态 + 结构层时右击节点弹出 */
  const [ctxMenu, setCtxMenu] = useState<{
    nodeId: string;
    kind: NodeKind;
    x: number;
    y: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow<SopFlowNode, Edge>();

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

  /* 单击节点：首次高亮全链路；再点同一节点 → 全链路 ⇄ 相邻；点别处 → 换起点 */
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

  /* —— 节点装饰：status / view / locked / talkEditable / _mark / chain —— */
  const displayedNodes = useMemo<SopFlowNode[]>(() => {
    const locked = mode === 'view';
    const talkEditable = mode === 'edit';
    return nodes.map((n) => {
      let status: 'active' | 'dim' | 'pending' = 'active';
      const onRoute = scenario ? scenario.activeNodes.has(n.id) : false;
      if (scenario) {
        if (!scenario.activeNodes.has(n.id)) status = 'dim';
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
          ...(chainState ? { chain: chainState } : { chain: undefined }),
          /* 搜索：未命中淡出；命中项保持清晰（当前项由 search-active 描边强调） */
          ...(searching ? { searchDim: !isHit, searchActive: n.id === searchActiveId } : {}),
          /* Build M：路线已完全确定 → 最高强调级（双环 + 外发光 + 一次性流光） */
          ...(routeDone && onRoute ? { routeDone: true } : { routeDone: undefined }),
          _mark: onTalkEdit,
        },
      };
    });
  }, [nodes, scenario, routeDone, view, mode, onTalkEdit, chain, chainRes, searchOpen, searchQ, searchActiveId, searchHitIds]);

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

  const displayedEdges = useMemo<Edge[]>(() => {
      const act = scenario ? scenario.activeEdges : null;
      return edges.map((e) => {
      const active = act ? act.has(e.id) : true;
      const dim = act && !active;
      /**
       * Build M：激活边显著加粗并加深蓝，非激活边压到近乎隐形 ——
       * 复杂图里要靠「粗细差 + 明度差」而非纯色差来区隔。
       * 颜色全部走 CSS 变量（--edge-* / --route-label-*）：
       * 边的 stroke 与箭头 marker 都由这里驱动，硬编码会让暗色主题下深蓝线条糊在深底上。
       */
      const color = dim ? 'var(--edge-off)' : active && act ? 'var(--edge-route)' : 'var(--edge-idle)';
      const label = edgeLabelOf(e);
      const labelStyle =
        active && act
          ? { fill: 'var(--route-label-fg)', fontWeight: 600 as const, fontSize: 11 }
          : { fill: 'var(--ink-3)', fontSize: 11 };
      const labelBgStyle =
        active && act ? { fill: 'var(--route-label-bg)' } : { fill: 'var(--surface-2)' };
      const chainCls = !chain ? '' : chainRes.edges.has(e.id) ? 'chain-hit' : 'chain-miss';
      /* route-on = 路线主干；route-done = 整条路线已确定（实线+发光，区别于"还在走"的流动虚线） */
      const routeCls = act
        ? active
          ? routeDone
            ? 'route-on route-done'
            : 'route-on'
          : 'route-off'
        : '';
      const cls = [chainCls, routeCls].filter(Boolean).join(' ');
      return {
        ...e,
        ...(cls ? { className: cls } : {}),
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
  }, [edges, scenario, routeDone, edgeLabelOf, chain, chainRes]);

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

  /** 单击=清空选中 + 退出链路高亮；双击（detail===2）= 新建菜单（US-01） */
  const handlePaneClick = useCallback(
    (e: MouseEvent<Element>) => {
      if (e.detail === 2) {
        onPaneDoubleClick(e.clientX, e.clientY);
        return;
      }
      onPaneClickClear();
      setChain(null);
    },
    [onPaneDoubleClick, onPaneClickClear]
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

  const showStyleBar = editable && edges.length > 0;

  const chainRootLabel = chain
    ? (nodes.find((n) => n.id === chain.id)?.data?.label ?? '该节点')
    : '';

  return (
    <div className="canvas-wrap" ref={wrapperRef} onPointerMove={handlePointerMove}>
      <ReactFlow<SopFlowNode, Edge>
        /* Build M：只有情景态才挂 has-scenario —— 编辑态所有节点都是 st-active，
           若不做这层区分，路线高亮会误伤编辑态的普通节点 */
        className={scenario ? 'has-scenario' : ''}
        nodes={displayedNodes}
        edges={displayedEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onConnect={editable ? onConnect : undefined}
        onReconnect={editable ? onReconnect : undefined}
        edgesReconnectable={editable}
        onEdgeDoubleClick={editable ? onEdgeDoubleClick : undefined}
        onPaneClick={handlePaneClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onNodeContextMenu={
          editable
            ? (evt, node) => {
                evt.preventDefault();
                const kind = ((node.data as Partial<SopNodeData> | undefined)?.kind ??
                  'step') as NodeKind;
                setCtxMenu({ nodeId: node.id, kind, x: evt.clientX, y: evt.clientY });
              }
            : undefined
        }
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        selectionOnDrag={editable}
        selectionMode={SelectionMode.Partial}
        panOnDrag={editable ? [1, 2] : true}
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

      {/* E4 多选浮动工具条 */}
      <SelectionBar
        nodes={displayedNodes}
        editable={editable}
        onAlignDir={onAlignDir}
        onDistribute={onDistribute}
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
        </div>
      )}

      {/* 节点右键菜单（B4）：类型切换 + 删除 */}
      {ctxMenu && (
        <div
          className="ctx-menu"
          data-testid="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="ctx-head">{KIND_TAG[ctxMenu.kind] || '步骤'} →</div>
          {KIND_OPTIONS.filter((o) => {
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
                onChangeKind(ctxMenu.nodeId, o.kind);
                setCtxMenu(null);
              }}
            >
              转为{o.label}
            </button>
          ))}
          <div className="ctx-sep" />
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
          <input
            autoFocus
            className="edge-rename-input"
            value={edgeEditText}
            aria-label="连线名称"
            placeholder="出口名…（留空 = 出口 n）"
            onChange={(e) => setEdgeEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
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
  );
}
