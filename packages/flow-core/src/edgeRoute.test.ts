import { describe, expect, it } from 'vitest';
import {
  anchorPoint,
  clampRoutePos,
  defaultRoutePos,
  isEdgeRoute,
  isLegacyRoute,
  isWaypointRoute,
  orthoRoutePath,
  projectToBorder,
  roundedOrthoD,
  routeBounds,
  routePathByType,
  straightRoutePath,
  waypointRoutePath,
  curveRoutePath,
  bendRoutePath,
  isBendRoute,
} from './edgeRoute';

describe('routeBounds', () => {
  it('两端都是上下 → axis=y；top 为上界、bottom 为下界', () => {
    // A.bottom=186（源出向下 → 中段须 ≥ 212）；B.top=300（目标入向下 → 中段须 ≤ 274）
    const b = routeBounds(220, 186, 'bottom', 560, 300, 'top');
    expect(b).toEqual({ axis: 'y', lo: 212, hi: 274 });
  });
  it('两端都是左右 → axis=x；left 为上界、right 为下界', () => {
    const b = routeBounds(186, 220, 'right', 300, 560, 'left');
    expect(b).toEqual({ axis: 'x', lo: 212, hi: 274 });
  });
  it('混合侧（上下 × 左右）→ null（不支持手动路由）', () => {
    expect(routeBounds(0, 0, 'bottom', 0, 0, 'right')).toBeNull();
  });
  it('同侧（bottom×bottom）只有下界，无上界', () => {
    const b = routeBounds(220, 186, 'bottom', 560, 200, 'bottom');
    expect(b?.axis).toBe('y');
    expect(b?.lo).toBe(226); // max(212, 226)
    expect(b?.hi).toBe(Infinity);
  });
  it('节点间距不足以容纳 stub → null', () => {
    expect(routeBounds(0, 100, 'bottom', 0, 130, 'top')).toBeNull(); // lo=126 > hi=104
  });
});

describe('clamp/default', () => {
  it('clamp 夹到区间内', () => {
    expect(clampRoutePos(100, 212, 274)).toBe(212);
    expect(clampRoutePos(300, 212, 274)).toBe(274);
    expect(clampRoutePos(250, 212, 274)).toBe(250);
  });
  it('默认取中点；单侧无界取 +96 / -96', () => {
    expect(defaultRoutePos(212, 274)).toBe(243);
    expect(defaultRoutePos(226, Infinity)).toBe(322);
    expect(defaultRoutePos(-Infinity, 180)).toBe(84);
  });
});

describe('orthoRoutePath', () => {
  it('V 家族：路径含两段竖直 stub + 一条横向中段，标签在中段中点', () => {
    const r = orthoRoutePath({
      ax: 220, ay: 186, aSide: 'bottom',
      bx: 560, by: 300, bSide: 'top',
    });
    expect(r).not.toBeNull();
    expect(r!.pos).toBe(243);
    expect(r!.lx).toBe(390); // (220+560)/2
    expect(r!.ly).toBe(243);
    expect(r!.d.startsWith('M220,186')).toBe(true);
    expect(r!.d).toContain('Q');
  });
  it('override 越界被夹取；axis 不符家族返回 null', () => {
    const r = orthoRoutePath({
      ax: 220, ay: 186, aSide: 'bottom',
      bx: 560, by: 300, bSide: 'top',
      route: { axis: 'y', pos: 9999 },
    });
    expect(r!.pos).toBe(274);
    expect(
      orthoRoutePath({
        ax: 220, ay: 186, aSide: 'bottom',
        bx: 560, by: 300, bSide: 'top',
        route: { axis: 'x', pos: 300 },
      })
    ).toBeNull();
  });
  it('H 家族：路径含两条横向 stub + 一条纵向中段', () => {
    const r = orthoRoutePath({
      ax: 186, ay: 220, aSide: 'right',
      bx: 300, by: 560, bSide: 'left',
      route: { axis: 'x', pos: 250 },
    });
    expect(r!.d.startsWith('M186,220')).toBe(true);
    expect(r!.d).toContain('Q250,220');
  });
  it('非家族（混合侧）→ null', () => {
    expect(
      orthoRoutePath({ ax: 0, ay: 0, aSide: 'bottom', bx: 10, by: 10, bSide: 'right', route: { axis: 'y', pos: 50 } })
    ).toBeNull();
  });
});

describe('roundedOrthoD', () => {
  it('直线无拐弯 → 只有 M/L', () => {
    expect(roundedOrthoD([[0, 0], [0, 100]])).toBe('M0,0 L0,100');
  });
  it('单个直角拐弯 → L + Q 圆角', () => {
    const d = roundedOrthoD([[0, 0], [0, 50], [100, 50]]);
    expect(d).toContain('Q0,50');
    expect(d).toContain('L0,40');
    expect(d).toContain('10,50');
  });
  it('重复点被剔除', () => {
    expect(roundedOrthoD([[0, 0], [0, 0], [0, 100]])).toBe('M0,0 L0,100');
  });
});

describe('isEdgeRoute', () => {
  it('校验形状', () => {
    expect(isEdgeRoute({ axis: 'y', pos: 100 })).toBe(true);
    expect(isEdgeRoute({ axis: 'z', pos: 100 })).toBe(false);
    expect(isEdgeRoute({ axis: 'y', pos: NaN })).toBe(false);
    expect(isEdgeRoute(null)).toBe(false);
  });
  it('v2 折点路由同样被认作合法路由', () => {
    expect(isEdgeRoute({ points: [{ x: 1, y: 2 }] })).toBe(true);
    expect(isEdgeRoute({ points: [] })).toBe(false);
    expect(isEdgeRoute({ points: [{ x: NaN, y: 2 }] })).toBe(false);
    expect(isWaypointRoute({ points: [{ x: 1, y: 2 }] })).toBe(true);
    expect(isLegacyRoute({ axis: 'y', pos: 1 })).toBe(true);
  });
});

describe('waypointRoutePath', () => {
  /* A 在左上、B 在右下，默认 bottom → top（V 家族） */
  const A = { ax: 100, ay: 100, aSide: 'bottom' as const };
  const B = { bx: 300, by: 300, bSide: 'top' as const };
  const has = (verts: Array<[number, number]>, x: number, y: number) =>
    verts.some(([vx, vy]) => vx === x && vy === y);

  it('空折点 → 退化为中点拐弯的标准正交线（端点锚点单独生效时用）', () => {
    const r = waypointRoutePath({ ...A, ...B, points: [] });
    expect(r).not.toBeNull();
    /* 横向运行应落在 A、B 纵向中点附近，而不是紧贴 A 的下边缘 */
    const runs = r!.verts.filter(([, y]) => y === 200);
    expect(runs.length).toBeGreaterThan(0);
    expect(r!.verts[r!.verts.length - 2][0]).toBe(300); // 竖直进入 B
  });

  it('坐标非法 → null', () => {
    expect(waypointRoutePath({ ...A, ...B, ax: NaN, points: [{ x: 1, y: 1 }] })).toBeNull();
  });

  it('单折点向下拖：横向中段跟着下移（等效 v1 行为）', () => {
    const r = waypointRoutePath({ ...A, ...B, points: [{ x: 200, y: 260 }] });
    expect(r).not.toBeNull();
    expect(has(r!.verts, 200, 260)).toBe(true);
    /* 中段横线整体落到 y=260 —— 说明折点的 y 生效 */
    expect(r!.verts.some(([vx, vy]) => vy === 260 && vx !== 200)).toBe(true);
  });

  it('单折点向右拖：产生向右绕行（v1 做不到的横向自由度）', () => {
    const r = waypointRoutePath({ ...A, ...B, points: [{ x: 460, y: 200 }] });
    expect(r).not.toBeNull();
    /* 路径必须真的走到 x=460 —— 这是「能左右拉」的核心断言 */
    const maxX = Math.max(...r!.verts.map(([x]) => x));
    expect(maxX).toBe(460);
  });

  it('多折点串联：按序经过每一个', () => {
    const r = waypointRoutePath({
      ...A,
      ...B,
      points: [
        { x: 100, y: 200 },
        { x: 480, y: 200 },
        { x: 480, y: 380 },
      ],
    });
    expect(r).not.toBeNull();
    expect(has(r!.verts, 100, 200)).toBe(true);
    expect(has(r!.verts, 480, 200)).toBe(true);
    expect(has(r!.verts, 480, 380)).toBe(true);
  });

  it('防回折：折点落在引出侧后方时不产生反向重叠段', () => {
    const r = waypointRoutePath({ ...A, ...B, points: [{ x: 420, y: 200 }] });
    expect(r).not.toBeNull();
    for (let i = 0; i < r!.verts.length - 1; i++) {
      const [x1, y1] = r!.verts[i];
      const [x2, y2] = r!.verts[i + 1];
      expect(x1 === x2 || y1 === y2).toBe(true); // 每段都正交
    }
    /* 相邻同轴向段不得首尾相接成「去了又回来」 */
    expect(r!.verts.length).toBeLessThanOrEqual(8);
  });

  it('最后一段沿 bSide 轴向进入（top → 竖直进）', () => {
    const r = waypointRoutePath({ ...A, ...B, points: [{ x: 460, y: 200 }] });
    const n = r!.verts.length;
    expect(r!.verts[n - 1][0]).toBe(300);
    expect(r!.verts[n - 1][1]).toBe(300);
    expect(r!.verts[n - 2][0]).toBe(300); // 倒数第二段与 B 同 x → 竖直进入
  });

  it('左右家族：最后一段水平进入 left 侧', () => {
    const r = waypointRoutePath({
      ax: 400,
      ay: 100,
      aSide: 'right',
      bx: 100,
      by: 300,
      bSide: 'left',
      points: [{ x: 250, y: 200 }],
    });
    expect(r).not.toBeNull();
    const n = r!.verts.length;
    expect(r!.verts[n - 2][1]).toBe(300); // 与 B 同 y → 水平进入
  });
});

describe('端点锚点', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };

  it('anchorPoint 按比例换算到各边', () => {
    expect(anchorPoint(box, { side: 'top', t: 0.25 })).toEqual({ x: 50, y: 0 });
    expect(anchorPoint(box, { side: 'bottom', t: 0.5 })).toEqual({ x: 100, y: 100 });
    expect(anchorPoint(box, { side: 'left', t: 0.5 })).toEqual({ x: 0, y: 50 });
    expect(anchorPoint(box, { side: 'right', t: 1 })).toEqual({ x: 200, y: 100 });
  });

  it('projectToBorder：中点磁吸（靠近 0.5 吸到正中，远离则保持自由）', () => {
    /* 飞书 / FigJam 的端点吸附到边时默认落在中点，用户拖到附近必须停得住。
       没有磁吸时 t 是连续值，能停在 0.47/0.53 却停不到 0.5。 */
    expect(projectToBorder(box, 260, 52).t).toBe(0.5);
    expect(projectToBorder(box, 260, 48).t).toBe(0.5);
    expect(projectToBorder(box, 105, 5).t).toBe(0.5);
    expect(projectToBorder(box, 260, 70).t).toBeCloseTo(0.7, 5);
    expect(projectToBorder(box, 50, -40).t).toBeCloseTo(0.25, 5);
  });

  it('projectToBorder：框外吸附到最近边', () => {
    expect(projectToBorder(box, 260, 50)).toEqual({ side: 'right', t: 0.5 });
    expect(projectToBorder(box, 50, -40)).toEqual({ side: 'top', t: 0.25 });
    expect(projectToBorder(box, -10, 80)).toEqual({ side: 'left', t: 0.8 });
  });

  it('projectToBorder：框内推到最近边', () => {
    expect(projectToBorder(box, 100, 5)).toEqual({ side: 'top', t: 0.5 });
    expect(projectToBorder(box, 195, 50)).toEqual({ side: 'right', t: 0.5 });
  });

  it('projectToBorder 结果可还原回边框坐标（往返一致）', () => {
    const a = projectToBorder(box, 123, 456);
    const p = anchorPoint(box, a);
    if (a.side === 'top' || a.side === 'bottom') expect(p.y === 0 || p.y === 100).toBe(true);
    else expect(p.x === 0 || p.x === 200).toBe(true);
  });
});

describe('WP5b 曲线 / 直线的折点路径', () => {
  const base = {
    ax: 100,
    ay: 0,
    aSide: 'bottom' as const,
    bx: 100,
    by: 300,
    bSide: 'top' as const,
  };

  it('曲线：无折点时也能出合法路径（不再是 null，曲线可拖了）', () => {
    const r = curveRoutePath({ ...base, points: [] });
    expect(r).not.toBeNull();
    expect(r!.d.startsWith('M ')).toBe(true);
    expect(r!.d).toContain('C '); // 三次贝塞尔
  });

  it('曲线：路径严格穿过每个折点', () => {
    const pts = [
      { x: 260, y: 120 },
      { x: 40, y: 200 },
    ];
    const r = curveRoutePath({ ...base, points: pts });
    expect(r).not.toBeNull();
    for (const p of pts) expect(r!.verts.some(([x, y]) => x === p.x && y === p.y)).toBe(true);
  });

  it('直线：折线路径包含折点且是尖角（只有 L）', () => {
    const r = straightRoutePath({ ...base, points: [{ x: 260, y: 150 }] });
    expect(r).not.toBeNull();
    expect(r!.d).toContain('L 260 150');
    expect(r!.d).not.toContain('C ');
  });

  it('routePathByType：按类型分派（default→曲线 / straight→直线 / 其它→正交）', () => {
    const src = { ...base, points: [{ x: 260, y: 150 }] };
    expect(routePathByType('default', src)!.d).toContain('C ');
    expect(routePathByType('straight', src)!.d).toContain('L 260 150');
    expect(routePathByType('smoothstep', src)!.d).not.toContain('C ');
    expect(routePathByType(undefined, src)!.d).not.toContain('C ');
  });

  it('三种类型都给出可用的标签锚点', () => {
    const src = { ...base, points: [] };
    for (const t of ['smoothstep', 'default', 'straight']) {
      const r = routePathByType(t, src);
      expect(Number.isFinite(r!.lx)).toBe(true);
      expect(Number.isFinite(r!.ly)).toBe(true);
    }
  });

  it('曲线 / 直线：坐标非法同样返回 null', () => {
    const bad = { ...base, bx: Number.NaN, points: [] };
    expect(curveRoutePath(bad)).toBeNull();
    expect(straightRoutePath(bad)).toBeNull();
  });
});

describe('WP5c 段平移路由（bend）：局部性 + 端点锁定', () => {
  const base = {
    ax: 100,
    ay: 0,
    aSide: 'bottom' as const,
    bx: 100,
    by: 300,
    bSide: 'top' as const,
  };
  const bend = (t: number, dx: number, dy: number) => ({ t, dx, dy });

  it('isBendRoute 识别 v3 路由，且 bends 为空不算', () => {
    expect(isBendRoute({ bends: [bend(0.5, 10, 0)] })).toBe(true);
    expect(isBendRoute({ bends: [] })).toBe(false);
    expect(isBendRoute({ points: [{ x: 1, y: 2 }] })).toBe(false);
    expect(isEdgeRoute({ bends: [bend(0.5, 10, 0)] })).toBe(true);
  });

  it('肘线：推开中段后，出 A 的那一段仍严格垂直（端点不变形）', () => {
    const r = bendRoutePath('smoothstep', { ...base, bends: [bend(0.5, 200, 0)] });
    expect(r).not.toBeNull();
    const v = r!.verts;
    expect(v[0][0]).toBe(100);
    expect(v[1][0]).toBe(100); // stub 段 x 不变 → 依旧垂直出线
    expect(v[1][1]).toBeGreaterThan(v[0][1]);
  });

  it('肘线：进 B 的那一段仍严格垂直', () => {
    const r = bendRoutePath('smoothstep', { ...base, bends: [bend(0.5, 200, 0)] });
    const v = r!.verts;
    const n = v.length;
    /* v4 bend-vertex：bend 改的是 verts 中间 vertex（v[n-2]），
       但 a/b 两端与 a-stub 段锁死 —— 出 A 的 stub 段必须保持垂直（dx=0）。
       进 B 的方向由 bSide='top' 锁死 → verts[n-1] = b 节点位置 (100, 300)。
       这里不要求 verts[n-2]→verts[n-1] 严格垂直（bend 一动中间 vertex 可以斜着进），
       但 a/b 端点位置永不参与偏移。 */
    expect(v[n - 1][0]).toBe(100);
    expect(v[n - 1][1]).toBe(300);
    expect(v[0][0]).toBe(100);
    expect(v[0][1]).toBe(0);
    /* 出 A 的 stub 段保持垂直（applyBendOrtho 跳过首尾 stub） */
    expect(v[1][0]).toBe(100);
  });

  it('肘线：真的被推开了（路径向右凸出），顶点数量不变（v4 vertex 偏移）', () => {
    const b0 = waypointRoutePath({ ...base, points: [] })!;
    const r = bendRoutePath('smoothstep', { ...base, bends: [bend(0.5, 200, 0)] })!;
    /* v4 不再插入新 vertex：bend 直接替换中间 vertex → verts 长度 = 基础路径长度 */
    expect(r.verts.length).toBe(b0.verts.length);
    /* 中间 vertex 偏移到 (300, 150) —— 「向右凸出」是真的发生了 */
    const maxX = Math.max(...r.verts.map((p) => p[0]));
    expect(maxX).toBeGreaterThan(200);
    expect(r.verts[2][0]).toBe(300);
  });

  it('肘线：推出的是「按下处的一小段」，不是整段（拐点不贴节点）', () => {
    const r = bendRoutePath('smoothstep', { ...base, bends: [bend(0.5, 200, 0)] })!;
    /* 起点 y=0、stub 到 y=26；凸起的两个顶点之间应保留一段原路（y 明显大于 26） */
    const ys = r.verts.map((p) => p[1]);
    const firstBendY = Math.min(...r.verts.filter((p) => p[0] > 200).map((p) => p[1]));
    expect(firstBendY).toBeGreaterThan(26);
    expect(ys[1]).toBeLessThanOrEqual(26 + 0.001);
  });

  it('肘线：沿段自身方向的位移被忽略（只取法向分量，保持正交）', () => {
    const r = bendRoutePath('smoothstep', { ...base, bends: [bend(0.5, 0, 120)] });
    expect(r).not.toBeNull();
    /* 竖直段的中段是横向的，其法向是竖直 → dy=120 实际是沿段方向，应被吃掉 */
    for (let i = 0; i < r!.verts.length - 1; i++) {
      const a = r!.verts[i];
      const b = r!.verts[i + 1];
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
    }
  });

  it('曲线：首末控制点方向锁定为节点法向（拖中间不改两端切线）', () => {
    const r = bendRoutePath('default', { ...base, bends: [bend(0.5, 200, 0)] })!;
    const nums = r.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    /* d = M ax ay C c1x c1y, c2x c2y, x y ... */
    const c1x = nums[2];
    const last = nums.length;
    const c2x = nums[last - 4];
    expect(c1x).toBeCloseTo(100, 0); // 起点切线沿垂直方向
    expect(c2x).toBeCloseTo(100, 0); // 终点切线沿垂直方向
  });

  it('曲线 / 直线：折点随偏移移动，且返回抓手位置', () => {
    for (const t of ['default', 'straight']) {
      const r = bendRoutePath(t, { ...base, bends: [bend(0.5, 150, 40)] })!;
      expect(r.handles.length).toBe(1);
      expect(r.handles[0].x).toBeCloseTo(250, 0);
      expect(r.handles[0].y).toBeCloseTo(190, 0);
    }
  });

  it('多个弯按顺序生效（t 升序）', () => {
    const r = bendRoutePath('smoothstep', {
      ...base,
      bends: [bend(0.7, 60, 0), bend(0.3, -80, 0)],
    })!;
    expect(r.handles.length).toBe(2);
    expect(r.handles[0].x).toBeLessThan(r.handles[1].x);
  });

  it('bends 为空 / 坐标非法 → null（调用方回落内置渲染）', () => {
    expect(bendRoutePath('smoothstep', { ...base, bends: [] })).toBeNull();
    expect(bendRoutePath('default', { ...base, bx: Number.NaN, bends: [bend(0.5, 1, 1)] })).toBeNull();
  });
});
