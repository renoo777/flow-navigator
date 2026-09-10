/** 话术行编辑器（内嵌于 SopNode 卡片）
 *  - 每行：说话方切换（双击可改名） + 自适应增高输入框（双击放大编辑） + 删除
 *  - 卡片头工具：⇄ 翻转左右方向 / ↧ 应用到全部节点
 *  - 入历史：通过 _mark 回调（FlowCanvas 注入）触发 mark()，保证 Ctrl+Z 可回退
 *
 *  交互参照飞书画板文本块：文本超宽自动换行、Enter 换行、输入框随内容自动增高（无滚动条），
 *  双击进入放大编辑（Esc / 点遮罩 /「完成」退出并保存）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow } from '@xyflow/react';
import type { TalkLine, TalkRoles } from '@flow/core';
import type { SopFlowNode, SopNodeData } from './SopNode';

export const DEFAULT_AGENT = '客服';
export const DEFAULT_CUST = '客户';

/** 让 textarea 高度跟随内容（先归零再取 scrollHeight，避免出现滚动条）
 *  注意：box-sizing:border-box 下 scrollHeight 不含边框，直接赋值会让 clientHeight 少 2px
 *  → 末尾一行被裁掉一截并冒出滚动条。必须把上下边框补回去。 */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const cs = getComputedStyle(el);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + border}px`;
}

export function TalkEditor({ nodeId, data }: { nodeId: string; data: SopNodeData }) {
  const { updateNodeData, getNodes } = useReactFlow<SopFlowNode>();
  const lines: TalkLine[] = Array.isArray(data.talk) ? data.talk : [];
  /** 每次渲染同步 _mark（旧实现只在挂载时取一次，可能拿到过期回调） */
  const markRef = useRef<(() => void) | undefined>(data._mark);
  markRef.current = data._mark;

  const roles: TalkRoles = data.roles ?? {};
  const agentName = roles.agent?.trim() || DEFAULT_AGENT;
  const custName = roles.cust?.trim() || DEFAULT_CUST;
  const dir = data.talkDir === 'agentRight' ? 'agentRight' : 'agentLeft';

  const [zoomIdx, setZoomIdx] = useState<number | null>(null);

  const write = useCallback(
    (patch: Partial<SopNodeData>, history?: boolean) => {
      if (history) markRef.current?.();
      updateNodeData(nodeId, patch);
    },
    [nodeId, updateNodeData]
  );

  const commit = useCallback(() => markRef.current?.(), []);

  const addLine = useCallback(() => {
    write({ talk: [...lines, { side: 'agent' as const, text: '' }] }, true);
  }, [lines, write]);

  const removeLine = useCallback(
    (idx: number) => {
      write({ talk: lines.filter((_, i) => i !== idx) }, true);
    },
    [lines, write]
  );

  const updateSide = useCallback(
    (idx: number, side: 'agent' | 'cust') => {
      write({ talk: lines.map((l, i) => (i === idx ? { ...l, side } : l)) });
    },
    [lines, write]
  );

  const updateText = useCallback(
    (idx: number, text: string) => {
      write({ talk: lines.map((l, i) => (i === idx ? { ...l, text } : l)) });
    },
    [lines, write]
  );

  const renameRole = useCallback(
    (who: 'agent' | 'cust', name: string) => {
      const clean = name.trim().slice(0, 8);
      const next: TalkRoles = { ...roles };
      if (clean) next[who] = clean;
      else delete next[who];
      write({ roles: next }, true);
    },
    [roles, write]
  );

  const flip = useCallback(() => {
    write({ talkDir: dir === 'agentLeft' ? 'agentRight' : 'agentLeft' }, true);
  }, [dir, write]);

  /** 把当前节点的左右方向刷到全部节点（一次 mark，可整体撤销） */
  const flipAll = useCallback(() => {
    markRef.current?.();
    const next = dir === 'agentLeft' ? 'agentRight' : 'agentLeft';
    getNodes().forEach((n) => updateNodeData(n.id, { talkDir: next }));
  }, [dir, getNodes, updateNodeData]);

  return (
    <div className="talk-editor" data-testid="talk-editor">
      <div className="te-tools">
        <button
          type="button"
          className="te-tool"
          onClick={flip}
          title="翻转客服/客户的左右位置"
          aria-label="翻转左右方向"
        >
          ⇄ 翻转
        </button>
        <button
          type="button"
          className="te-tool"
          onClick={flipAll}
          title="把当前方向应用到所有节点"
          aria-label="方向应用到全部节点"
        >
          ↧ 全部
        </button>
      </div>

      {lines.length === 0 ? (
        <div className="te-empty">（本节点暂无话术）</div>
      ) : (
        <ul className="te-list">
          {lines.map((ln, i) => (
            <TalkRow
              key={i}
              index={i}
              line={ln}
              dir={dir}
              agentName={agentName}
              custName={custName}
              onSide={(s) => updateSide(i, s)}
              onText={(t) => updateText(i, t)}
              onRemove={() => removeLine(i)}
              onRename={renameRole}
              onZoom={() => setZoomIdx(i)}
              onCommit={commit}
            />
          ))}
        </ul>
      )}

      <button type="button" className="te-add" onClick={addLine} aria-label="添加话术">
        ＋ 添加话术
      </button>

      {zoomIdx !== null && lines[zoomIdx] && (
        <TalkZoom
          index={zoomIdx}
          text={lines[zoomIdx].text}
          who={lines[zoomIdx].side === 'cust' ? custName : agentName}
          onChange={(t) => updateText(zoomIdx, t)}
          onClose={() => {
            setZoomIdx(null);
            commit();
          }}
        />
      )}
    </div>
  );
}

/** 单行：说话方（双击改名） + 自适应增高输入框（双击放大） + 删除 */
function TalkRow({
  index,
  line,
  dir,
  agentName,
  custName,
  onSide,
  onText,
  onRemove,
  onRename,
  onZoom,
  onCommit,
}: {
  index: number;
  line: TalkLine;
  dir: 'agentLeft' | 'agentRight';
  agentName: string;
  custName: string;
  onSide: (s: 'agent' | 'cust') => void;
  onText: (t: string) => void;
  onRemove: () => void;
  onRename: (who: 'agent' | 'cust', name: string) => void;
  onZoom: () => void;
  onCommit: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [renaming, setRenaming] = useState<'agent' | 'cust' | null>(null);

  /** 输入框随内容增高：文本变化 / 卡片宽度变化都要重算 */
  useLayoutEffect(() => autoGrow(taRef.current), [line.text, dir, agentName, custName]);

  return (
    <li className="te-row" data-side={line.side} style={{ '--te-side': line.side } as CSSProperties}>
      <div className="te-side" role="tablist" aria-label="说话方">
        {(['agent', 'cust'] as const).map((who) => {
          const name = who === 'agent' ? agentName : custName;
          const on = line.side === who;
          if (renaming === who) {
            return (
              <input
                key={who}
                className="te-rename nodrag nopan"
                defaultValue={name}
                autoFocus
                maxLength={8}
                aria-label={`重命名${who === 'agent' ? '客服' : '客户'}`}
                onBlur={(e) => {
                  onRename(who, e.target.value);
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onRename(who, (e.target as HTMLInputElement).value);
                    setRenaming(null);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
              />
            );
          }
          return (
            <button
              key={who}
              type="button"
              className={`te-side-btn ${on ? 'on' : ''}`}
              onClick={() => onSide(who)}
              onDoubleClick={(e) => {
                e.preventDefault();
                setRenaming(who);
              }}
              aria-pressed={on}
              title={`${name}（双击可改名）`}
            >
              {name}
            </button>
          );
        })}
      </div>

      <textarea
        ref={taRef}
        className="te-input nodrag nopan"
        value={line.text}
        placeholder="说话内容…"
        onChange={(e) => onText(e.target.value)}
        onBlur={onCommit}
        onDoubleClick={onZoom}
        aria-label={`第 ${index + 1} 句内容（双击放大编辑）`}
      />

      <button
        type="button"
        className="te-remove"
        onClick={onRemove}
        aria-label={`删除第 ${index + 1} 句`}
        title="删除该句"
      >
        ×
      </button>
    </li>
  );
}

/** 放大编辑浮层：portal 到 body（RF 节点带 transform，fixed 会被裁剪进节点坐标系） */
function TalkZoom({
  index,
  text,
  who,
  onChange,
  onClose,
}: {
  index: number;
  text: string;
  who: string;
  onChange: (t: string) => void;
  onClose: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => autoGrow(taRef.current), [text]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div
      className="talk-zoom"
      data-testid="talk-zoom"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tz-card" role="dialog" aria-modal="true" aria-label="放大编辑话术">
        <div className="tz-head">
          <span className="tz-idx">第 {index + 1} 句</span>
          <span className="tz-who">{who}</span>
        </div>
        <textarea
          ref={taRef}
          className="tz-input"
          data-testid="tz-input"
          value={text}
          placeholder="说话内容…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="话术内容（Enter 换行，Esc 完成）"
        />
        <div className="tz-foot">
          <span className="tz-tip">Enter 换行 · Esc 完成</span>
          <button type="button" className="tz-done" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

