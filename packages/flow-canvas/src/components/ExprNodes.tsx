/**
 * WP4 自由表达层节点：便签 note / 贴图 image / 标注 label（带可拖指示箭头）
 * ─────────────────────────────────────────────────────────────────────
 * 产品语义（C 路径拍板 ①「表达层 = 便签 / 贴图 / 标注」，不做自由画笔）：
 *  - 纯装饰元素：无连线端口、不参与 dagre 布局 / 情景演算 / 话术层（talk 视图不渲染）
 *  - 表达节点只活在自己的 type 上：store 数组里 type 字段区分，正常随文档持久化、
 *    undo/redo、删除、框选、PNG 导出（DOM 截图），但不进分享卡与核心算法。
 *  - locked（mode !== 'edit'）时禁双击编辑与拖指示线；情景/只读下作为批注原样停驻。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import type { NodePaint } from './SopNode';

export type ExprType = 'note' | 'image' | 'label';

/** 便签：圆角贴纸（默认暖黄），多行文字 */
export type NoteNodeData = {
  label: string;
  color?: NodePaint | null;
  editing?: boolean;
  locked?: boolean;
};
/** 贴图：图片卡（本地 base64 ≤2MB / 网络 URL）；label 可选（供搜索与 alt） */
export type ImageNodeData = {
  src?: string;
  label?: string;
  editing?: boolean;
  locked?: boolean;
};
/** 标注：短句文字卡 + 可拖指示箭头（arrow 存世界坐标终点，纯视觉不进连线系统） */
export type LabelNodeData = {
  label: string;
  color?: NodePaint | null;
  editing?: boolean;
  locked?: boolean;
  /** 指示线终点（画布世界坐标）。null=无指示线 */
  arrow?: { x: number; y: number } | null;
};

/** 内部装饰回调（displayedNodes 注入，与 sop 的 _mark 同机制）—— 不入库 */
type ExprInternal = { _mark?: () => void };

export type ExprFlowNode = Node<
  (NoteNodeData | ImageNodeData | LabelNodeData) & ExprInternal,
  ExprType
>;

/** 是否为自由表达节点（type 判别；sop 及旧数据无 type 一律按流程节点走） */
export const isExprNode = (n: { type?: unknown }): boolean =>
  n.type === 'note' || n.type === 'image' || n.type === 'label';

/** 图片体积上限：2MB（桌面自用，base64 随文档存 IndexedDB / 本地镜像） */
export const IMG_MAX_BYTES = 2 * 1024 * 1024;

/** 统一 paint → CSS 变量覆盖（与 SopNode 一致：--n-bg / --n-st / --n-fg） */
function paintStyle(color?: NodePaint | null): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    '--n-bg': color.bg,
    '--n-st': color.stroke,
    '--n-fg': color.text,
  } as CSSProperties;
}

/* ============================ 便签 note ============================ */
/** 便签编辑：多行 textarea。Ctrl/Cmd+Enter 或失焦提交；Esc 取消；Enter 换行 */
function NoteEditor({ nodeId, initial, mark }: { nodeId: string; initial: string; mark?: () => void }) {
  const { updateNodeData } = useReactFlow();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    /* RF 容器内 autoFocus 会被节点挂载时序吞掉 → 延迟一帧兜底聚焦，光标挪到文末 */
    const el = ref.current;
    const t = window.setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }, 30);
    return () => window.clearTimeout(t);
  }, []);
  const commit = useCallback(
    (cancel = false) => {
      mark?.();
      const v = text.trim();
      updateNodeData(nodeId, {
        label: v,
        editing: false,
      } as Record<string, unknown>);
      void cancel;
    },
    [text, nodeId, updateNodeData, mark]
  );
  return (
    <textarea
      ref={ref}
      autoFocus
      className="expr-note-edit nodrag nopan"
      value={text}
      aria-label="便签内容"
      placeholder="写点什么…"
      rows={1}
      style={{ minHeight: 34 }}
      onChange={(e) => {
        setText(e.target.value);
        const el = e.target;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          commit(true);
        }
      }}
      onBlur={() => commit()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

export function NoteNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const d = (data ?? {}) as NoteNodeData & ExprInternal;
  const locked = !!d.locked;
  const startEdit = useCallback(() => {
    if (locked) return;
    updateNodeData(id, { editing: true } as Record<string, unknown>);
  }, [locked, id, updateNodeData]);
  const paint = d.color ?? null;
  return (
    <div
      className={['expr-card', 'expr-note', selected ? 'is-selected' : ''].join(' ')}
      data-testid="expr-note"
      style={paintStyle(paint)}
      onDoubleClick={locked ? undefined : startEdit}
    >
      {d.editing && !locked ? (
        <NoteEditor nodeId={id} initial={d.label} mark={d._mark} />
      ) : (
        <span className="expr-note-text">{d.label || '便签'}</span>
      )}
    </div>
  );
}

/* ============================ 贴图 image ============================ */
/** 读本地文件 → dataURL（>IMG_MAX_BYTES 拒绝） */
function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('请选择图片文件'));
      return;
    }
    if (file.size > IMG_MAX_BYTES) {
      reject(new Error(`图片超过 ${Math.round(IMG_MAX_BYTES / 1024 / 1024)}MB 限制`));
      return;
    }
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** 图片设置态（editing）：预览 + 本地上传 / URL 双通道 + 移除 + 完成 */
function ImagePanel({ nodeId, current }: { nodeId: string; current?: string }) {
  const { updateNodeData } = useReactFlow();
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      setBusy(true);
      setErr(null);
      try {
        const src = await readImageFile(f);
        updateNodeData(nodeId, { src, editing: false } as Record<string, unknown>);
      } catch (x) {
        setErr((x as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [nodeId, updateNodeData]
  );

  const applyUrl = useCallback(() => {
    const v = url.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) {
      setErr('链接需以 http:// 或 https:// 开头');
      return;
    }
    updateNodeData(nodeId, { src: v, editing: false } as Record<string, unknown>);
  }, [url, nodeId, updateNodeData]);

  return (
    <div className="expr-img-panel" data-testid="img-panel" onDoubleClick={(e) => e.stopPropagation()}>
      {current ? (
        <img className="expr-img-prev" src={current} alt="" draggable={false} />
      ) : (
        <div className="expr-img-ph" aria-hidden="true" />
      )}
      <div className="eip-row">
        <button className="eip-btn primary" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? '读取中…' : current ? '更换本地图片' : '上传本地图片'}
        </button>
      </div>
      <div className="eip-row">
        <input
          className="eip-url"
          value={url}
          placeholder="或粘贴图片链接 http(s)://…"
          aria-label="图片链接"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              applyUrl();
            }
          }}
        />
        <button className="eip-btn" onClick={applyUrl}>
          使用
        </button>
      </div>
      {err && <div className="eip-err">{err}</div>}
      <div className="eip-row end">
        {current && (
          <button
            className="eip-btn ghost danger"
            onClick={() => {
              updateNodeData(nodeId, { src: undefined, label: undefined } as Record<string, unknown>);
            }}
          >
            移除图片
          </button>
        )}
        <button
          className="eip-btn ghost"
          onClick={() => {
            updateNodeData(nodeId, { editing: false } as Record<string, unknown>);
          }}
        >
          完成
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e)} />
    </div>
  );
}

export function ImageNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const d = (data ?? {}) as ImageNodeData & ExprInternal;
  const locked = !!d.locked;
  const src = d.src?.trim() || '';
  if (d.editing && !locked) {
    return (
      <div className="expr-image" data-testid="expr-image">
        <ImagePanel nodeId={id} current={src} />
      </div>
    );
  }
  return (
    <div
      className={['expr-card', 'expr-image', selected ? 'is-selected' : ''].join(' ')}
      data-testid="expr-image"
      title={locked ? undefined : '双击更换图片'}
      onDoubleClick={
        locked
          ? undefined
          : (e) => {
              e.stopPropagation();
              updateNodeData(id, { editing: true } as Record<string, unknown>);
            }
      }
    >
      {src ? (
        <img className="expr-img" src={src} alt={d.label ?? ''} draggable={false} loading="lazy" />
      ) : (
        <button
          className="expr-img-empty nodrag nopan"
          data-testid="img-empty"
          onClick={(e) => {
            e.stopPropagation();
            if (!locked) updateNodeData(id, { editing: true } as Record<string, unknown>);
          }}
        >
          <span className="eie-plus">＋</span>
          <span className="eie-text">{locked ? '图片' : '点击添加图片'}</span>
        </button>
      )}
    </div>
  );
}

/* ============================ 标注 label（带指示箭头） ============================ */
export function LabelNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow();
  const d = (data ?? {}) as LabelNodeData & ExprInternal;
  const locked = !!d.locked;
  const editing = !!d.editing && !locked;

  const startEdit = useCallback(() => {
    if (locked) return;
    updateNodeData(id, { editing: true } as Record<string, unknown>);
  }, [locked, id, updateNodeData]);

  /** 屏幕坐标 → 世界坐标（RF 内部自减容器偏移，须传原始 clientX/Y，勿自行减 rect） */
  const rf = useReactFlow();
  const followRef = useRef<((ev: globalThis.PointerEvent) => void) | null>(null);
  followRef.current = (ev: globalThis.PointerEvent) => {
    const p = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    updateNodeData(id, {
      arrow: { x: Math.round(p.x), y: Math.round(p.y) },
    } as Record<string, unknown>);
  };

  /** 拖指示箭头：按下（无箭头先给近点让线可见）→ mark 入历史 → 跟手 → 松手收工 */
  const onAnchorDown = useCallback(
    (e: ReactPointerEvent) => {
      if (locked) return;
      e.preventDefault();
      e.stopPropagation();
      d._mark?.();
      if (!d.arrow) {
        updateNodeData(id, { arrow: { x: 0, y: 0 } } as Record<string, unknown>);
      }
      const move = (ev: globalThis.PointerEvent) => followRef.current?.(ev);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [locked, d, id, updateNodeData]
  );

  const clearArrow = useCallback(() => {
    if (locked) return;
    d._mark?.();
    updateNodeData(id, { arrow: null } as Record<string, unknown>);
  }, [locked, d, id, updateNodeData]);

  const paint = d.color ?? null;
  if (editing) {
    return (
      <div
        className={['expr-card', 'expr-label', selected ? 'is-selected' : ''].join(' ')}
        style={paintStyle(paint)}
      >
        <SingleLineEditor nodeId={id} initial={d.label} mark={d._mark} />
      </div>
    );
  }
  return (
    <div
      className={['expr-card', 'expr-label', selected ? 'is-selected' : ''].join(' ')}
      data-testid="expr-label"
      data-has-arrow={d.arrow ? '1' : '0'}
      style={paintStyle(paint)}
      onDoubleClick={locked ? undefined : startEdit}
    >
      <span className="expr-label-text">{d.label || '标注'}</span>
      {selected && !locked && (
        <>
          <span
            className="expr-arrow-anchor nodrag nopan"
            data-testid="arrow-anchor"
            title={d.arrow ? '拖拽调整指示箭头（双击清空）' : '拖出指示箭头'}
            onPointerDown={onAnchorDown}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clearArrow();
            }}
          />
          {d.arrow && (
            <button
              className="expr-arrow-clear nodrag nopan"
              data-testid="arrow-clear"
              title="删除指示线"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={clearArrow}
            >
              ✕
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** 单行标注编辑：Enter 提交 · Esc 取消 · 失焦提交（空串也允许，显示占位） */
function SingleLineEditor({
  nodeId,
  initial,
  mark,
}: {
  nodeId: string;
  initial: string;
  mark?: () => void;
}) {
  const { updateNodeData } = useReactFlow();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    /* RF 容器内 autoFocus 会被吞 → 延迟一帧聚焦并全选，便于直接覆写 */
    const el = ref.current;
    const t = window.setTimeout(() => {
      el?.focus();
      el?.select();
    }, 30);
    return () => window.clearTimeout(t);
  }, []);
  const commit = useCallback(
    (cancel = false) => {
      mark?.();
      updateNodeData(nodeId, {
        label: cancel ? initial : text.trim(),
        editing: false,
      } as Record<string, unknown>);
    },
    [text, initial, nodeId, updateNodeData, mark]
  );
  return (
    <input
      ref={ref}
      autoFocus
      className="expr-label-edit nodrag nopan"
      value={text}
      placeholder="标注文字…"
      aria-label="标注文字"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          commit(true);
        }
      }}
      onBlur={() => commit()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
