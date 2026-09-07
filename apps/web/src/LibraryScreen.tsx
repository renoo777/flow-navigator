/** 流程图库首页：按组分类的文档列表 + 新建/导入/复制/改名/改组/删除/导出 + 编辑/查看打开 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveVariables } from '@flow/core';
import { DOCS_STORE, dbGetAll } from './idb';
import { blankContent, sanitizeContent, useAppStore, type FlowDoc } from './store';
import { AboutPanel } from './AboutPanel';
import { autoCheckUpdates } from './useUpdater';

const UNGROUPED = '未分组';

function fmtTime(t: number): string {
  const d = new Date(t);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

function downloadJson(text: string, name: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 库文档 → 备份 JSON 文本（与编辑器 exportJSON 同构，version 2） */
export function docBackupText(doc: FlowDoc): string {
  return JSON.stringify(
    {
      app: 'flow-app',
      kind: 'backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: doc.name,
      state: doc.flow,
    },
    null,
    2
  );
}

export function LibraryScreen() {
  const [docs, setDocs] = useState<FlowDoc[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** 内联改名中的 docId */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** 分组选择浮层：{docId, x, y} */
  const [groupPop, setGroupPop] = useState<{ docId: string; x: number; y: number } | null>(null);
  const [renameText, setRenameText] = useState('');
  /** 文档搜索（B6）：按 name 不区分大小写匹配 */
  const [query, setQuery] = useState('');
  /** 关于/支持作者面板（打赏双码 + 署名）——入口在主页标题旁 */
  const [aboutOpen, setAboutOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const openDoc = useAppStore((s) => s.openDoc);
  const createDoc = useAppStore((s) => s.createDoc);
  const createSampleDoc = useAppStore((s) => s.createSampleDoc);
  const duplicateDoc = useAppStore((s) => s.duplicateDoc);
  const renameDoc = useAppStore((s) => s.renameDoc);
  const setDocGroup = useAppStore((s) => s.setDocGroup);
  const deleteDoc = useAppStore((s) => s.deleteDoc);
  /* 桌面版图库文件镜像：路径 + 启动自动恢复的提示（Web 版恒为 null） */
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultNotice = useAppStore((s) => s.vaultNotice);
  const [vaultNoticeOpen, setVaultNoticeOpen] = useState(true);

  const load = useCallback(async () => {
    const all = await dbGetAll<FlowDoc>(DOCS_STORE);
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    setDocs(all);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  /** 桌面版：启动进入主页时自动检查一次更新（浏览器环境 no-op，静默失败） */
  useEffect(() => {
    void autoCheckUpdates();
  }, []);

  /** pop-menu click-away：点击浮层/「⋯」按钮之外、Esc、滚动或缩放窗口即关闭 */
  useEffect(() => {
    if (!groupPop) return;
    const close = () => setGroupPop(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 防御：dispatchEvent 合成的 target 可能为 Document/Window（非 Element，无 closest）
      if (t && typeof t.closest === 'function' && (t.closest('.pop-menu') || t.closest('.op-more'))) return;
      setGroupPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGroupPop(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [groupPop]);

  /** 统计每个 doc 的启用变量数 */
  const docVars = useMemo(() => {
    const m = new Map<string, number>();
    (docs ?? []).forEach((d) => {
      const flowEdges = d.flow.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'step' as const,
        label: typeof e.label === 'string' ? e.label : '',
      }));
      m.set(
        d.id,
        resolveVariables(d.flow.nodes, flowEdges, d.flow.enabledVarNodeIds).length
      );
    });
    return m;
  }, [docs]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const g = new Map<string, FlowDoc[]>();
    (docs ?? [])
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .forEach((d) => {
        const key = d.group || UNGROUPED;
        if (!g.has(key)) g.set(key, []);
        g.get(key)!.push(d);
      });
    return [...g.entries()].sort((a, b) => {
      if (a[0] === UNGROUPED) return 1;
      if (b[0] === UNGROUPED) return -1;
      return a[0].localeCompare(b[0], 'zh');
    });
  }, [docs, query]);

  /* ---------- 动作 ---------- */
  const handleNewBlank = useCallback(async () => {
    await createDoc('未命名流程图', '', blankContent());
  }, [createDoc]);

  const handleImportFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        window.alert('导入失败：不是有效的 JSON');
        return;
      }
      // 兼容「备份包裹 { state }」与「裸内容态」两种格式
      const rawState = (parsed as { state?: unknown }).state ?? parsed;
      const flow = sanitizeContent(rawState);
      if (!flow) {
        window.alert('导入失败：缺少 nodes / edges 数组');
        return;
      }
      const title =
        typeof (parsed as { title?: unknown }).title === 'string'
          ? ((parsed as { title?: unknown }).title as string)
          : file.name.replace(/\.json$/i, '') || '导入的流程图';
      await createDoc(title, '', flow);
      if (fileRef.current) fileRef.current.value = '';
    },
    [createDoc]
  );

  const handleRenameStart = useCallback((doc: FlowDoc) => {
    setRenaming(doc.id);
    setRenameText(doc.name);
  }, []);

  const handleRenameCommit = useCallback(
    async (docId: string) => {
      setRenaming(null);
      if (renameText.trim() && renameText.trim() !== docs?.find((d) => d.id === docId)?.name) {
        await renameDoc(docId, renameText.trim());
        await load();
      }
    },
    [renameText, docs, renameDoc, load]
  );

  const handleDelete = useCallback(
    async (doc: FlowDoc) => {
      if (window.confirm(`删除流程图「${doc.name}」？此操作不可撤销，建议先导出备份。`)) {
        await deleteDoc(doc.id);
        await load();
      }
    },
    [deleteDoc, load]
  );

  const groupNames = useMemo(() => groups.map(([k]) => k), [groups]);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!docs) {
    return <div className="lib-loading">加载流程图库…</div>;
  }

  return (
    <div className="lib">
      <header className="lib-head">
        <div className="lib-brand">
          <div className="lib-title-row">
            <h1 className="lib-title">变量导航器</h1>
            <button
              className="lib-about-btn"
              onClick={() => setAboutOpen(true)}
              data-testid="open-about"
              title="关于本软件"
              aria-label="打开关于面板"
            >
              ⓘ
            </button>
          </div>
          <div className="lib-sub">复杂流程图按变量拆解成可演示情景 · 数据仅存本机浏览器</div>
        </div>
        <div className="lib-search">
          <input
            className="lib-search-input"
            type="search"
            placeholder="搜索流程图…"
            aria-label="搜索流程图"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="lib-search-clear" onClick={() => setQuery('')} aria-label="清空搜索">
              ✕
            </button>
          )}
        </div>
        <div className="lib-actions">
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
            ⇪ 导入 JSON
          </button>
          <button className="btn-primary" onClick={handleNewBlank}>
            ＋ 新建流程图
          </button>
          <button className="btn-ghost accent" onClick={createSampleDoc}>
            从示例模板开始
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => handleImportFile(e.target.files?.[0])}
        />
      </header>

      {/* 关于 / 支持作者（含打赏双码），主页专属入口 */}
      {aboutOpen && <AboutPanel onClose={() => setAboutOpen(false)} />}

      {docs.length === 0 ? (
        <div className="lib-empty" data-testid="lib-empty">
          <div className="le-title">还没有流程图</div>
          <div className="le-sub">
            新建一张空白图，或从「司机接单客服 SOP」示例模板开始体验变量导航
          </div>
          <div className="le-actions">
            <button className="btn-primary" onClick={handleNewBlank}>
              ＋ 新建空白流程图
            </button>
            <button className="btn-ghost accent" onClick={createSampleDoc}>
              载入示例模板
            </button>
          </div>
        </div>
      ) : (
        <div className="lib-body">
          {groups.map(([group, list]) => {
            const isCollapsed = collapsed.has(group);
            return (
              <section key={group} className="lib-group">
                <button className="lg-head" onClick={() => toggleGroup(group)}>
                  <span className={`lg-caret ${isCollapsed ? 'off' : ''}`}>▾</span>
                  <span className="lg-name">{group}</span>
                  <span className="lg-count">{list.length} 张</span>
                </button>
                {!isCollapsed && (
                  <div className="lg-list">
                    {list.map((doc) => (
                      <div key={doc.id} className="lib-row" data-doc={doc.id}>
                        <div className="lr-main">
                          {renaming === doc.id ? (
                            <input
                              autoFocus
                              className="lr-rename"
                              aria-label="文档名称"
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRenameCommit(doc.id);
                                else if (e.key === 'Escape') setRenaming(null);
                              }}
                              onBlur={() => handleRenameCommit(doc.id)}
                            />
                          ) : (
                            <div
                              className="lr-name"
                              title={`${doc.name}（双击重命名）`}
                              role="button"
                              tabIndex={0}
                              onDoubleClick={() => handleRenameStart(doc)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handleRenameStart(doc);
                                }
                              }}
                            >
                              {doc.name}
                            </div>
                          )}
                          <div className="lr-meta">
                            {doc.flow.nodes.length} 节点 · {docVars.get(doc.id) ?? 0} 变量 · 更新于 {fmtTime(doc.updatedAt)}
                          </div>
                        </div>
                        <div className="lr-ops">
                          <button className="op-primary" onClick={() => openDoc(doc.id, false)} title="打开编辑（改动自动保存）">
                            编辑
                          </button>
                          <button className="op-view" onClick={() => openDoc(doc.id, true)} title="只读查看：可演示情景与话术层，改动不保存">
                            查看
                          </button>
                          <button
                            className="op-more"
                            title="更多操作"
                            aria-label={`更多操作：${doc.name}`}
                            onClick={(e) =>
                              setGroupPop({ docId: doc.id, x: e.clientX, y: e.clientY })
                            }
                          >
                            ⋯
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* 桌面版：图库文件镜像提示（更新/重装后自动恢复的入口说明） */}
      {vaultNotice && vaultNoticeOpen && (
        <div className="lib-vault-notice" data-testid="vault-notice">
          <span>{vaultNotice}</span>
          <button onClick={() => setVaultNoticeOpen(false)} aria-label="知道了">
            ✕
          </button>
        </div>
      )}
      {vaultPath && (
        <footer
          className="lib-vault"
          data-testid="vault-hint"
          title={`图库每次改动都会镜像到此文件；每天保留一份快照，最多 7 天：\n${vaultPath}`}
        >
          <span className="lv-dot" aria-hidden="true" />
          图库已同步备份到本机文件（升级 / 重装不会丢）：{vaultPath}
        </footer>
      )}

      {/* 更多操作浮层 */}
      {groupPop && (() => {
        const doc = (docs ?? []).find((d) => d.id === groupPop.docId);
        if (!doc) return null;
        return (
          <div
            className="pop-menu"
            style={{ left: Math.min(groupPop.x, window.innerWidth - 190), top: Math.min(groupPop.y, window.innerHeight - 240) }}
            data-testid="doc-menu"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pm-title">{doc.name}</div>
            <button
              className="pm-item"
              onClick={() => {
                setGroupPop(null);
                handleRenameStart(doc);
              }}
            >
              重命名
            </button>
            <button
              className="pm-item"
              onClick={async () => {
                setGroupPop(null);
                await duplicateDoc(doc.id);
                await load();
              }}
            >
              复制一张
            </button>
            <button
              className="pm-item"
              onClick={() => {
                downloadJson(docBackupText(doc), `${doc.name}.json`.replace(/[\\/:*?"<>|]/g, '_'));
                setGroupPop(null);
              }}
            >
              导出 JSON
            </button>
            <div className="pm-divider" />
            <div className="pm-label">移动到分组</div>
            {groupNames.map((g) => (
              <button
                key={g}
                className="pm-item sub"
                onClick={async () => {
                  const next = g === UNGROUPED ? '' : g;
                  setGroupPop(null);
                  await setDocGroup(doc.id, next);
                  await load();
                }}
              >
                {g === doc.group || (doc.group === '' && g === UNGROUPED) ? '✓ ' : ''}
                {g}
              </button>
            ))}
            <button
              className="pm-item sub"
              onClick={async () => {
                const name = window.prompt('新分组名称', '');
                setGroupPop(null);
                if (name && name.trim()) {
                  await setDocGroup(doc.id, name.trim());
                  await load();
                }
              }}
            >
              ＋ 新建分组…
            </button>
            <div className="pm-divider" />
            <button className="pm-item danger" onClick={() => handleDelete(doc)}>
              删除…
            </button>
          </div>
        );
      })()}
    </div>
  );
}
