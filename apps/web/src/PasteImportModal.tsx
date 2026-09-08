/** 粘贴外部画板内容（飞书）后的确认弹窗：先看清楚再落地，避免误粘一整张图 */
import { useState } from 'react';
import type { ImportedGraph } from '@flow/core';
import { ModalShell } from './VarModals';

export type ImportLayout = 'reflow' | 'keep';

/** 连线样式三选（肉眼可挑，不必先记住名词） */
const EDGE_STYLE_OPTIONS: { id: string; label: string; desc: string; path: string }[] = [
  {
    id: 'smoothstep',
    label: '肘线',
    desc: '圆角折线，流程走向最清晰（推荐）',
    path: 'M6 30 V15 Q6 10 11 10 H30',
  },
  {
    id: 'default',
    label: '曲线',
    desc: '贝塞尔曲线，视觉更柔和',
    path: 'M6 30 C6 12 14 10 30 10',
  },
  {
    id: 'straight',
    label: '直线',
    desc: '两点直连，最省空间',
    path: 'M6 30 L30 10',
  },
];

export function PasteImportModal({
  graph,
  hasContent,
  onCancel,
  onApply,
}: {
  graph: ImportedGraph;
  /** 当前画布已有内容 → 给出「追加 / 替换」两种落法 */
  hasContent: boolean;
  onCancel: () => void;
  onApply: (layout: ImportLayout, replace: boolean, edgeType: string) => void;
}) {
  const [layout, setLayout] = useState<ImportLayout>('reflow');
  const [edgeType, setEdgeType] = useState('smoothstep');
  const { nodes, edges, decisions, labeled, parallel, weak } = graph.stats;

  return (
    <ModalShell
      title="识别到飞书画板流程图"
      subtitle="已把形状转成步骤/判断节点，连线上的分支文字会变成变量选项"
      onClose={onCancel}
      testid="paste-import-modal"
      footer={
        <>
          <div className="pi-count">{hasContent ? '将插入到当前画布' : '将写入当前空白画布'}</div>
          <div className="pi-cta">
            <button className="btn-ghost" onClick={onCancel}>
              取消
            </button>
            {hasContent && (
              <button
                className="btn-ghost"
                onClick={() => onApply(layout, true, edgeType)}
                title="清空当前画布后再写入（仍可 Ctrl+Z 撤销）"
              >
                替换当前内容
              </button>
            )}
            <button className="btn-primary" onClick={() => onApply(layout, false, edgeType)}>
              导入
            </button>
          </div>
        </>
      }
    >
      <div className="pi-stats">
        <div className="pi-stat">
          <b>{nodes}</b>
          <span>节点</span>
        </div>
        <div className="pi-stat">
          <b>{decisions}</b>
          <span>判断</span>
        </div>
        <div className="pi-stat">
          <b>{edges}</b>
          <span>连线</span>
        </div>
        <div className="pi-stat">
          <b>{labeled}</b>
          <span>分支文字</span>
        </div>
      </div>

      <div className="pi-field">
        <div className="pi-field-label">导入后的布局</div>
        <label className="pi-opt">
          <input
            type="radio"
            name="pi-layout"
            checked={layout === 'reflow'}
            onChange={() => setLayout('reflow')}
          />
          <span>
            智能重排（推荐）
            <em>按连线关系分层，左右分支顺序跟飞书一致，自动拉开间距不重叠</em>
          </span>
        </label>
        <label className="pi-opt">
          <input
            type="radio"
            name="pi-layout"
            checked={layout === 'keep'}
            onChange={() => setLayout('keep')}
          />
          <span>
            保留飞书原坐标
            <em>位置与飞书完全一致，但卡片较大可能互相压住</em>
          </span>
        </label>
      </div>

      <div className="pi-field">
        <div className="pi-field-label">连线样式</div>
        <div className="pi-edge-opts" data-testid="pi-edge-styles">
          {EDGE_STYLE_OPTIONS.map((o) => (
            <label key={o.id} className={`pi-edge ${edgeType === o.id ? 'on' : ''}`}>
              <input
                type="radio"
                name="pi-edge"
                checked={edgeType === o.id}
                onChange={() => setEdgeType(o.id)}
              />
              <svg className="pie-svg" viewBox="0 0 36 40" aria-hidden="true" focusable="false">
                <path d={o.path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <circle cx="6" cy="30" r="2.4" fill="currentColor" />
                <circle cx="30" cy="10" r="2.4" fill="currentColor" />
              </svg>
              <span className="pie-text">
                {o.label}
                <em>{o.desc}</em>
              </span>
            </label>
          ))}
        </div>
      </div>

      {(parallel > 0 || weak > 0) && (
        <div className="pi-note">
          {parallel > 0 && <div>· 含 {parallel} 条平行分支（同一对节点间多条连线），已全部保留</div>}
          {weak > 0 && (
            <div>· {weak} 个判断节点不足 2 条出边，暂时不会成为变量（补一条分支即可）</div>
          )}
        </div>
      )}
    </ModalShell>
  );
}
