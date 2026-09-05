/** 变量管理面板 + 首次识别引导弹窗（共用候选勾选 UI）
 *  语义：候选 = 全部 ≥2 分支节点；启用集合决定导航时哪些停驻。 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { FlowVariable } from '@flow/core';

function CandidateRows({
  candidates,
  checked,
  onToggle,
}: {
  candidates: FlowVariable[];
  checked: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="vm-list">
      {candidates.map((c) => {
        const on = checked.has(c.nodeId);
        return (
          <label key={c.nodeId} className={`vm-row ${on ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onToggle(c.nodeId)}
            />
            <span className="vm-name">{c.name}</span>
            <span className="vm-branches">
              {c.options.map((o) => (
                <span key={o.edgeId} className="vm-br">
                  {o.label}
                </span>
              ))}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
  testid,
}: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testid?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /* 打开：记录触发元素并聚焦容器（无阻塞 focus）；关闭：焦点归还（可访问性） */
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    (first ?? el)?.focus?.();
    return () => prev?.focus?.();
  }, []);

  /* Esc 关闭（与全局快捷键互不冲突：后者仅 preventDefault 不拦截传播） */
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  /* Tab 焦点圈禁：锁在弹窗内循环 */
  const trapTab = useCallback((e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const focusables = ref.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = ref.current.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={ref}
        className="modal"
        data-testid={testid}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={trapTab}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 className="modal-title">{title}</h2>
            {subtitle && <div className="modal-sub">{subtitle}</div>}
          </div>
          {onClose && (
            <button className="modal-x" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** 管理面板：enabled null=全部候选已启用；[]=全部停用 */
export function VariableManageModal({
  candidates,
  enabled,
  onSave,
  onClose,
}: {
  candidates: FlowVariable[];
  enabled: string[] | null;
  onSave: (nodeIds: string[]) => void;
  onClose: () => void;
}) {
  const initial = useMemo(() => {
    if (!enabled) return new Set(candidates.map((c) => c.nodeId));
    return new Set(enabled);
  }, [enabled, candidates]);
  const [checked, setChecked] = useState<Set<string>>(initial);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allIds = candidates.map((c) => c.nodeId);
  const allOn = checked.size === allIds.length && allIds.length > 0;

  return (
    <ModalShell
      title="管理变量"
      subtitle={`${candidates.length} 个 ≥2 分支节点可设为变量；停用后导航遍历不再在该节点停顿`}
      onClose={onClose}
      testid="var-manage-modal"
      footer={
        <>
          <div className="vm-bulk">
            <button
              className="ghost"
              onClick={() => setChecked(allOn ? new Set() : new Set(allIds))}
            >
              {allOn ? '全不选' : '全选'}
            </button>
            <span className="vm-count">已选 {checked.size} / {candidates.length}</span>
          </div>
          <div className="vm-cta">
            <button className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn-primary" onClick={() => onSave([...checked])}>
              应用
            </button>
          </div>
        </>
      }
    >
      <CandidateRows candidates={candidates} checked={checked} onToggle={toggle} />
    </ModalShell>
  );
}

/** 首次识别引导（导入 / 从空白新增后首个候选出现时）：
 *  默认全选 = 全部设为变量；也可勾选子集；跳过 = 全部停用（不再自动弹） */
export function VariableGuideModal({
  candidates,
  onDecide,
}: {
  candidates: FlowVariable[];
  /** null = 跳过（不启用任何变量）；ids = 勾选启用的子集 */
  onDecide: (ids: string[] | null) => void;
}) {
  const allIds = useMemo(() => candidates.map((c) => c.nodeId), [candidates]);
  const [checked, setChecked] = useState<Set<string>>(new Set(allIds));

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ModalShell
      title={`识别到 ${candidates.length} 个可设变量的分支节点`}
      subtitle="这些节点连出了 ≥2 条分支。设为变量后，情景导航会在它们处停下等你选择；可随时在 Dock 重新调整。"
      testid="var-guide-modal"
      footer={
        <>
          <div className="vm-count">已选 {checked.size} / {candidates.length}</div>
          <div className="vm-cta">
            <button className="btn-ghost" onClick={() => onDecide(null)} title="本轮不设为变量，之后可在「管理变量」中启用">
              跳过
            </button>
            <button className="btn-ghost" onClick={() => onDecide(allIds)}>
              全部设为变量
            </button>
            <button
              className="btn-primary"
              onClick={() => onDecide([...checked])}
              disabled={checked.size === 0}
            >
              按勾选应用
            </button>
          </div>
        </>
      }
    >
      <CandidateRows candidates={candidates} checked={checked} onToggle={toggle} />
    </ModalShell>
  );
}
