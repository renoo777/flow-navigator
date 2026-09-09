/** 粘贴外部画板内容（飞书）后的确认弹窗：先看清楚再落地，避免误粘一整张图 */
import { useState } from 'react';
import type { ImportedGraph } from '@flow/core';
import { ModalShell } from './VarModals';

export type ImportLayout = 'reflow' | 'keep';

/** 连线样式四选（肉眼可挑，不必先记住名词）。
 *  `original` 为 0918 新增：飞书原图常混用直线/曲线/肘线，统一改成一种会丢原意，
 *  故提供「每条线各用飞书自己的线型」，并在剪贴板带线型信息时作为默认置顶。 */
interface EdgeStyleOption {
  id: string;
  label: string;
  desc: string;
  /** 示意路径（可多条，用于表达混用） */
  paths: string[];
}
const EDGE_STYLE_OPTIONS: EdgeStyleOption[] = [
  {
    id: 'original',
    label: '按飞书原样',
    desc: '每条线各用各的线型（推荐）',
    paths: ['M4 12 L32 12', 'M4 24 C12 16 24 32 32 24', 'M4 36 V32 Q4 29 7 29 H32'],
  },
  {
    id: 'smoothstep',
    label: '肘线',
    desc: '全部改成圆角折线',
    paths: ['M6 30 V15 Q6 10 11 10 H30'],
  },
  {
    id: 'default',
    label: '曲线',
    desc: '全部改成贝塞尔曲线',
    paths: ['M6 30 C6 12 14 10 30 10'],
  },
  {
    id: 'straight',
    label: '直线',
    desc: '全部改成两点直连',
    paths: ['M6 30 L30 10'],
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
  const { nodes, edges, decisions, labeled, parallel, weak, shaped, shapes } = graph.stats;
  /** 剪贴板带线型信息 → 默认「按飞书原样」（混用线型的图不再被统一改掉）；
   *  老剪贴板无 shape 字段 → 退回肘线，第四项置灰并说明。 */
  const hasShape = shaped > 0;
  const shapeKinds = [shapes.straight, shapes.elbow, shapes.curve].filter((n) => n > 0).length;
  const [edgeType, setEdgeType] = useState(hasShape ? 'original' : 'smoothstep');

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
            保留飞书原坐标（逐像素）
            <em>1:1 照搬飞书位置与连线方向；卡片更宽可能轻微挤压，连线不重排</em>
          </span>
        </label>
      </div>

      <div className="pi-field">
        <div className="pi-field-label">连线样式</div>
        <div className="pi-edge-opts" data-testid="pi-edge-styles">
          {EDGE_STYLE_OPTIONS.map((o) => {
            const off = o.id === 'original' && !hasShape;
            return (
              <label
                key={o.id}
                className={`pi-edge ${edgeType === o.id ? 'on' : ''}${off ? ' off' : ''}`}
                title={off ? '这段剪贴板里没有线型信息，无法按原样还原' : undefined}
              >
                <input
                  type="radio"
                  name="pi-edge"
                  checked={edgeType === o.id}
                  disabled={off}
                  onChange={() => setEdgeType(o.id)}
                />
                <svg className="pie-svg" viewBox="0 0 36 40" aria-hidden="true" focusable="false">
                  {o.paths.map((d, i) => (
                    <path
                      key={i}
                      d={d}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  ))}
                  {o.paths.length === 1 && (
                    <>
                      <circle cx="6" cy="30" r="2.4" fill="currentColor" />
                      <circle cx="30" cy="10" r="2.4" fill="currentColor" />
                    </>
                  )}
                </svg>
                <span className="pie-text">
                  {o.label}
                  <em>
                    {o.id === 'original' && hasShape
                      ? `检测到 ${shapeKinds} 种线型，逐条还原`
                      : o.desc}
                  </em>
                </span>
              </label>
            );
          })}
        </div>
        {!hasShape && (
          <div className="pi-note" style={{ marginTop: 10 }}>
            · 这份剪贴板不含线型信息（旧版飞书负载），「按飞书原样」不可用，已默认肘线
          </div>
        )}
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
