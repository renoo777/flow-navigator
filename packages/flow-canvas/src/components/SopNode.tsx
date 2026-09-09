/** 自定义节点：SopNode（结构层 / 话术层双视图 + 双击原地改名 US-04 + 语义/自定义配色 E5 + 话术编辑表单） */
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Handle, Position, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import {
  TALK_W_MAX,
  TALK_W_MIN,
  TALK_W_DEFAULT,
  type TalkDir,
  type TalkRoles,
} from '@flow/core';
import { KIND_RAIL, KIND_TAG } from '../appearance';
import { NodeLabelEditor } from './NodeLabelEditor';
import { DEFAULT_AGENT, DEFAULT_CUST, TalkEditor } from './TalkEditor';

export type SopNodeStatus = 'active' | 'dim' | 'pending';
export type SopView = 'flow' | 'talk';

/** 自定义配色（底色/文字/边框任一可缺省；null=用 kind 语义默认色） */
export type NodePaint = { bg?: string; stroke?: string; text?: string };

/**
 * 节点 data。注意：RF 的 Node<NodeData> 约束要求 NodeData 满足 Record<string, unknown>，
 * 因此这里必须用「type 对象字面量」（不可用 interface 继承，否则缺 index signature 报错）。
 */
export type SopNodeData = {
  label: string;
  kind: 'io-start' | 'io-end' | 'decision' | 'step';
  talk: { side: 'agent' | 'cust'; text: string }[];
  status?: SopNodeStatus;
  view?: SopView;
  /** 受控编辑态（US-01 新建后自动进入 / US-04 双击进入） */
  editing?: boolean;
  /** 只读查看态：禁止双击改名（view 模式注入） */
  locked?: boolean;
  /** Q4 修复：mode==='edit' 时为 true，让 SopNode 在 talk view 渲染表单态 */
  talkEditable?: boolean;
  /** 自定义配色（E5）：覆盖 kind 语义默认色 */
  color?: NodePaint | null;
  /** 自定义说话方称呼（节点级，缺省 客服/客户） */
  roles?: TalkRoles;
  /** 话术卡片左右方向（节点级，缺省客服在左） */
  talkDir?: TalkDir;
  /** 话术卡片宽度 px（右缘把手拖拽写入） */
  talkW?: number;
  /** WP7-3d 导入锁尺寸：飞书解析出的卡片原始 w/h（flow view 渲染与布局估算优先读它，
   *  还原飞书卡形状；不设 = 文本自适应扁卡，手动节点/旧文档保持原样） */
  size?: { w: number; h: number };
  /** 上下游链路追踪结果（FlowCanvas 注入）：root=起点 / hit=命中 / miss=链路外 */
  chain?: 'root' | 'hit' | 'miss';
  /** Build M：情景路线已完全确定（沿途无待赋值变量）→ 最高强调级 */
  routeDone?: boolean;
  /** 循环可视化：本次路径中该节点被经过的次数（>=2 才注入，用于「第N轮」角标） */
  loopRound?: number;
  /** 可连线（编辑态 true；情景导航 / 只读为 false → 连接点不参与连线） */
  connectable?: boolean;
  /** 画布搜索（Build K-④）：searchDim=非命中淡出 / searchActive=当前项描边 */
  searchDim?: boolean;
  searchActive?: boolean;
  /** Q4 修复：render-only 历史快照回调（FlowCanvas 注入，TalkEditor 在 add/remove/blur 时调用） */
  _mark?: () => void;
};

/**
 * RF 节点类型。额外挂 posByView（Bug2 修复）：
 * 结构层卡片矮（h≈46）、话术层卡片高（h≈rows*40+80），共用 position 会导致切视图必然重叠，
 * 因此两层各自保存一份坐标，切换视图时存取各自的槽位。
 */
export type SopFlowNode = Node<SopNodeData, 'sop'> & {
  posByView?: Partial<Record<'flow' | 'talk', { x: number; y: number }>>;
};

/** RF NodeTypes 是宽类型，组件签名须用无泛型 NodeProps，内部收窄（v12 标准做法） */
export function SopNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow<SopFlowNode>();
  const d = (data ?? {}) as SopNodeData;
  const {
    label,
    kind,
    status = 'active',
    view = 'flow',
    editing,
    locked,
    talkEditable,
    connectable = true,
  } = d;
  const rail = KIND_RAIL[kind] ?? 'transparent';
  /** WP7-3d：锁尺寸卡 = 飞书原形状还原。渲染按 data.size 定宽高（CSS .keep-shape
   *  收起 rail/kind 小标让文本居中满布，贴近飞书纯色卡片；文本超界裁切，双击看全文）。 */
  const keepShape = view === 'flow' && !!d.size && d.size.w > 0 && d.size.h > 0;
  const cls = [
    'sop-node',
    `st-${status}`,
    selected ? 'is-selected' : '',
    keepShape ? 'keep-shape' : '',
    d.chain ? `chain-${d.chain}` : '',
    d.searchDim ? 'search-dim' : '',
    d.searchActive ? 'search-active' : '',
    d.routeDone ? 'route-done' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const talks = (d.talk ?? []).filter((t) => t && t.text.trim());
  /** 话术卡片：自定义称呼 / 左右方向 / 宽度（三者都是节点级，缺省有兜底） */
  const agentName = d.roles?.agent?.trim() || DEFAULT_AGENT;
  const custName = d.roles?.cust?.trim() || DEFAULT_CUST;
  const talkDir: TalkDir = d.talkDir === 'agentRight' ? 'agentRight' : 'agentLeft';
  const talkW = Math.min(TALK_W_MAX, Math.max(TALK_W_MIN, d.talkW ?? TALK_W_DEFAULT));
  const markRef = useRef<(() => void) | undefined>(d._mark);
  markRef.current = d._mark;

  /** 右缘把手拖拽调宽：按画布缩放换算实际像素；nodrag/nopan 由 class 交给 RF 处理 */
  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      markRef.current?.(); // 拖前入历史 → 松手后一次 Ctrl+Z 整体撤销
      const startX = e.clientX;
      const startW = talkW;
      const onMove = (ev: globalThis.MouseEvent) => {
        const next = Math.round(startW + (ev.clientX - startX));
        updateNodeData(id, {
          talkW: Math.max(TALK_W_MIN, Math.min(TALK_W_MAX, next)),
        });
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [id, talkW, updateNodeData]
  );

  /** 双击把手恢复默认宽度 */
  const resetWidth = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      markRef.current?.();
      updateNodeData(id, { talkW: undefined });
    },
    [id, updateNodeData]
  );
  /** E5：自定义配色 → CSS 变量覆盖 kind 语义默认色 */
  const paint = d.color ?? null;
  const paintStyle = paint
    ? ({
        '--n-bg': paint.bg,
        '--n-st': paint.stroke,
        '--n-fg': paint.text,
      } as CSSProperties)
    : undefined;
  /** WP7-3d：锁尺寸卡 → 宽高随 data.size（paint 变量与 width/height 合并进同一 style） */
  const nodeStyle: CSSProperties | undefined = keepShape
    ? {
        ...(paintStyle ?? {}),
        width: d.size!.w,
        height: d.size!.h,
      }
    : paintStyle;

  /** 双击进入编辑态（受控 data.editing=true；只读 view 模式锁定）。
   *  记录双击的屏幕坐标，交给编辑器把光标放到点击处 —— 不清空、不全选。 */
  const [caret, setCaret] = useState<{ x: number; y: number } | null>(null);
  const startEdit = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      if (locked || editing) return;
      setCaret({ x: e.clientX, y: e.clientY });
      updateNodeData(id, { editing: true });
    },
    [locked, editing, id, updateNodeData]
  );

  /** 编辑完成（保存/取消）：清编辑态；保存由 NodeLabelEditor 内 updateNodeData 完成 */
  const endEdit = useCallback(() => {
    updateNodeData(id, { editing: false });
  }, [id, updateNodeData]);

  return (
    <div
      className={cls}
      data-status={status}
      data-kind={kind}
      data-view={view}
      style={nodeStyle}
    >
      {/* 四向连接点：上下左右都可发起 / 接收连线（配合 ConnectionMode.Loose）。
          只读态（情景导航 / 查看）由画布的 no-connect 类整体隐形，DOM 里保留 ——
          React Flow 要靠这些点算连线端点坐标，真删掉线就没地方落脚了。 */}
      <Handle
        type="source"
        id="top"
        position={Position.Top}
        isConnectable={connectable}
        className="h-target h-top"
      />
      <Handle
        type="source"
        id="left"
        position={Position.Left}
        isConnectable={connectable}
        className="h-side h-left"
      />
      <Handle
        type="source"
        id="right"
        position={Position.Right}
        isConnectable={connectable}
        className="h-side h-right"
      />
      <span className="rail" style={{ background: rail }} />
      {view === 'talk' ? (
        talkEditable && !locked ? (
          /* Q4：编辑态 → 表单式（TalkEditor 提供 add/remove/side/text/rename/flip） */
          <div
            className="sop-talk"
            data-testid="talk-card"
            data-dir={talkDir}
            style={{ width: talkW }}
          >
            <div className="sop-talk-head">
              <span className="tk-kind">{KIND_TAG[kind] || '步骤'}</span>
              <span className="tk-label">{label}</span>
              <span className="tk-edit-hint" title="在表单里添加 / 修改 / 删除话术；双击输入框可放大编辑">
                · 可编辑
              </span>
            </div>
            <TalkEditor nodeId={id} data={d} />
            <span
              className="tk-resize nodrag nopan"
              data-testid="talk-resize"
              title="拖拽调整卡片宽度（双击恢复默认）"
              onMouseDown={startResize}
              onDoubleClick={resetWidth}
            />
          </div>
        ) : (
          /* 锁定态（情景导航 / 只读） → 保留对话气泡展示（同样遵循方向/称呼/宽度） */
          <div
            className="sop-talk"
            data-testid="talk-card"
            data-dir={talkDir}
            style={{ width: talkW }}
          >
            <div className="sop-talk-head">
              <span className="tk-kind">{KIND_TAG[kind] || '步骤'}</span>
              <span className="tk-label">{label}</span>
            </div>
            <div className="sop-talk-body">
              {talks.length ? (
                talks.map((t, i) => (
                  <div key={i} className={`tk-row ${t.side === 'cust' ? 'cust' : 'agent'}`}>
                    <div className="tk-bubble">{t.text}</div>
                    <div className="tk-who">{t.side === 'cust' ? custName : agentName}</div>
                  </div>
                ))
              ) : (
                <div className="tk-empty">（本节点无语术）</div>
              )}
            </div>
          </div>
        )
      ) : (
        <div
          className="sop-flow"
          /* nodrag 让 React Flow 不把 mousedown 识别为节点拖拽起点（否则双击会被
             RF 的拖动系统拦截，浏览器收不到 dblclick）。
             nopan 同理，避免画布平移抢焦点。 */
          onDoubleClick={startEdit}
          onMouseDown={(e) => {
            /* 仅「非编辑态」才阻止 RF 拖动。编辑态里 mouseDown 落在 contenteditable 上
               由浏览器自己处理，RF 还是会拦截，所以这里还要 stopPropagation。
               P0：仅在结构层生效，话术层是表单，节点拖动由 RF 自己管。 */
            if (!editing) e.stopPropagation();
          }}
        >
          {status === 'pending' && <span className="pending-dot" title="待赋值：沿此分支继续导航" />}
          {editing ? (
            <NodeLabelEditor nodeId={id} initial={label} onDone={endEdit} caret={caret} />
          ) : (
            <span className="sop-label">{label}</span>
          )}
          <span className="sop-sub">{KIND_TAG[kind] || ''}</span>
        </div>
      )}
      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        isConnectable={connectable}
        className="h-source h-bottom"
      />
      {typeof d.loopRound === 'number' && d.loopRound >= 2 && (
        <span className="loop-badge" title={`本次路线经过这里 ${d.loopRound} 次`}>
          ↻ {d.loopRound}
        </span>
      )}
    </div>
  );
}
