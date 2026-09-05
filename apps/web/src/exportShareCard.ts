/** 1200×630 社交分享卡（Build K-③）—— 纯 Canvas 2D 绘制，零新依赖。
 *  为什么不用 html-to-image：分享卡是「重新设计」而不是「截图」，
 *  Canvas 直接画可控性最好（深色品牌底 + 流程缩略 + 统计），也不会踩
 *  网页字体/跨域资源像素化导出的坑。 */

export interface ShareCardNode {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShareCardEdge {
  source: string;
  target: string;
}

export interface ShareCardOpts {
  title: string;
  nodes: ShareCardNode[];
  edges: ShareCardEdge[];
  varCount: number;
}

const W = 1200;
const H = 630;

const KIND_FILL: Record<string, string> = {
  'io-start': '#34d399',
  decision: '#fbbf24',
  step: 'rgba(148, 163, 184, 0.9)',
  'io-end': '#64748b',
};

/** 圆角矩形路径 */
function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 标题截断：最多两行，每行 maxChars 字，超出加 … */
export function wrapTitle(title: string, maxChars = 17, maxLines = 2): string[] {
  const t = title.trim();
  if (t.length <= maxChars) return [t];
  const lines: string[] = [];
  let rest = t;
  while (rest.length > 0 && lines.length < maxLines) {
    if (lines.length === maxLines - 1 && rest.length > maxChars) {
      lines.push(rest.slice(0, maxChars - 1) + '…');
      rest = '';
    } else {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
  }
  return lines;
}

export function drawShareCard(canvas: HTMLCanvasElement, opts: ShareCardOpts): void {
  const c = canvas.getContext('2d');
  if (!c) return;
  canvas.width = W;
  canvas.height = H;

  /* —— 底：深色品牌渐变 + 三处柔光斑（与站内 body::before 同一视觉语言） —— */
  const bg = c.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b0d12');
  bg.addColorStop(0.55, '#10141d');
  bg.addColorStop(1, '#0d1220');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  const glow = (x: number, y: number, r: number, color: string) => {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  };
  glow(140, -40, 560, 'rgba(90,140,255,0.20)');
  glow(1160, 60, 480, 'rgba(255,120,190,0.12)');
  glow(700, 700, 520, 'rgba(80,220,200,0.10)');

  const FONT = "'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif";

  /* —— 左栏：badge / 标题 / 统计 / 品牌脚注 —— */
  c.textBaseline = 'alphabetic';
  c.fillStyle = 'rgba(96,165,250,0.14)';
  rr(c, 72, 74, 168, 30, 15);
  c.fill();
  c.strokeStyle = 'rgba(96,165,250,0.45)';
  c.lineWidth = 1;
  rr(c, 72.5, 74.5, 167, 29, 15);
  c.stroke();
  c.fillStyle = '#93c5fd';
  c.font = `600 13px ${FONT}`;
  c.fillText('变量导航器 · 流程 SOP', 90, 94);

  c.fillStyle = '#f4f7fb';
  const lines = wrapTitle(opts.title || '未命名流程图');
  c.font = `700 ${lines.length > 1 ? 44 : 52}px ${FONT}`;
  lines.forEach((ln, i) => c.fillText(ln, 72, 196 + i * (lines.length > 1 ? 56 : 0)));

  /* 统计行 */
  const stat = `${opts.nodes.length} 个节点 · ${opts.edges.length} 条连线 · ${opts.varCount} 个变量`;
  c.fillStyle = 'rgba(226, 232, 240, 0.78)';
  c.font = `400 19px ${FONT}`;
  c.fillText(stat, 72, 306);

  /* 分隔细线 */
  c.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  c.beginPath();
  c.moveTo(72, 340);
  c.lineTo(430, 340);
  c.stroke();

  /* 脚注：日期 + 品牌 */
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  c.fillStyle = 'rgba(148, 163, 184, 0.85)';
  c.font = `400 15px ${FONT}`;
  c.fillText(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, 72, H - 66);
  c.fillStyle = 'rgba(148, 163, 184, 0.55)';
  c.fillText('变量导航器 · 复杂流程的变量拆解工具', 72, H - 40);

  /* —— 右栏：流程缩略卡片 —— */
  const gx = 560;
  const gy = 70;
  const gw = 560;
  const gh = 490;
  c.fillStyle = 'rgba(255,255,255,0.045)';
  rr(c, gx, gy, gw, gh, 24);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.10)';
  rr(c, gx + 0.5, gy + 0.5, gw - 1, gh - 1, 24);
  c.stroke();

  if (opts.nodes.length) {
    /* bounds 归一化（留 padding 36） */
    const minX = Math.min(...opts.nodes.map((n) => n.x));
    const minY = Math.min(...opts.nodes.map((n) => n.y));
    const maxX = Math.max(...opts.nodes.map((n) => n.x + n.w));
    const maxY = Math.max(...opts.nodes.map((n) => n.y + n.h));
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const P = 40;
    const scale = Math.min((gw - P * 2) / bw, (gh - P * 2) / bh, 1.6);
    const ox = gx + (gw - bw * scale) / 2;
    const oy = gy + (gh - bh * scale) / 2;
    const px = (x: number) => ox + (x - minX) * scale;
    const py = (y: number) => oy + (y - minY) * scale;
    const byId = new Map(opts.nodes.map((n) => [n.id, n]));

    /* 连线（先画，压在节点下面） */
    c.strokeStyle = 'rgba(148, 163, 184, 0.4)';
    c.lineWidth = 1.4;
    for (const e of opts.edges) {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (!s || !t) continue;
      const x1 = px(s.x + s.w);
      const y1 = py(s.y + s.h / 2);
      const x2 = px(t.x);
      const y2 = py(t.y + t.h / 2);
      const dx = Math.max(24, (x2 - x1) / 2);
      c.beginPath();
      c.moveTo(x1, y1);
      c.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
      c.stroke();
    }
    /* 节点缩略：色块 + 截断标签 */
    for (const n of opts.nodes) {
      const x = px(n.x);
      const y = py(n.y);
      const w = Math.max(52, n.w * scale);
      const h = Math.max(24, n.h * scale);
      c.fillStyle = 'rgba(13, 18, 29, 0.92)';
      rr(c, x, y, w, h, Math.min(8, h / 2));
      c.fill();
      c.strokeStyle = KIND_FILL[n.kind] ?? KIND_FILL.step;
      c.lineWidth = 1.5;
      rr(c, x + 0.75, y + 0.75, w - 1.5, h - 1.5, Math.min(8, h / 2));
      c.stroke();
      /* 左缘色条 */
      c.fillStyle = KIND_FILL[n.kind] ?? KIND_FILL.step;
      rr(c, x + 3, y + 4, 3, Math.max(4, h - 8), 1.5);
      c.fill();
      if (h >= 22 && w >= 60) {
        const fs = Math.min(12, Math.max(9, h * 0.42));
        c.fillStyle = 'rgba(226, 232, 240, 0.92)';
        c.font = `500 ${fs}px ${FONT}`;
        const label = n.label.length > Math.floor(w / fs) - 1 ? n.label.slice(0, Math.floor(w / fs) - 2) + '…' : n.label;
        c.fillText(label, x + 12, y + h / 2 + fs * 0.36);
      }
    }
  }
}

/** 生成并下载分享卡 PNG */
export async function exportShareCard(opts: ShareCardOpts, fileName: string): Promise<void> {
  const canvas = document.createElement('canvas');
  drawShareCard(canvas, opts);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('画布导出失败');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
