/**
 * feedbackIssue.ts 的回归。
 *
 * 锁的是「放弃 BugDrop 托管服务、改走 GitHub 预填页」这条新链路里最容易悄悄坏掉的东西：
 *
 * 1. **URL 装不下时的截断**。中文经 encodeURIComponent 后每个字膨胀到 9 个字符，
 *    按「字数」估预算必然低估 → 交出一条超长 URL，GitHub 侧直接 414/截断，
 *    而本地看不出任何异常。这里断言「无论多长，URL 都不超上限」。
 * 2. **标题/正文必须能原样解码回来**。拼错分隔符或漏 encode 的表现是
 *    「标题里多了一段正文」或「换行全丢了」，都属于一眼看不出、用户先看出来的问题。
 * 3. **正文里不能带页面 URL**（隐私）。BugDrop 默认就 redact URL，换实现别把这个丢了。
 *
 * 纯函数，不打桩 DOM。
 */
import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_REPO,
  MAX_ISSUE_URL,
  TRUNCATED_NOTE,
  buildIssuePlan,
  collectEnvContext,
  composeFullText,
  deriveTitle,
  normalizeMessage,
  safeSlice,
} from './feedbackIssue';

/** 从生成的链接里取回 title 参数（encodeURIComponent 会把 & 编成 %26，故可安全按 & 切） */
function decodeTitle(url: string): string {
  const m = /[?&]title=([^&]*)/.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

/** 从生成的链接里取回 body 参数 */
function decodeBody(url: string): string {
  const i = url.indexOf('&body=');
  return decodeURIComponent(url.slice(i + '&body='.length));
}

const ENV: Array<[string, string]> = [['窗口', '1440×900']];

describe('buildIssuePlan · 基本形状', () => {
  it('指向反馈仓库的 issues/new', () => {
    const p = buildIssuePlan({ message: '导出 GIF 时进度条卡住', env: ENV });
    expect(p.url.startsWith(`https://github.com/${FEEDBACK_REPO}/issues/new?title=`)).toBe(true);
  });

  it('title / body 能原样解码回来', () => {
    const msg = '第一步：打开画布\n第二步：点导出\n第三步：卡住不动';
    const p = buildIssuePlan({ message: msg, appVersion: 'flow-navigator@0.1.10', env: ENV });

    expect(decodeTitle(p.url)).toBe('第一步：打开画布');
    expect(decodeBody(p.url)).toContain(msg);
    expect(p.truncated).toBe(false);
    expect(p.bodyMessage).toBe(msg);
  });

  it('正文带上版本与来源，便于回溯是哪个版本报的', () => {
    const p = buildIssuePlan({ message: 'x', appVersion: 'flow-navigator@0.1.10', env: ENV });
    const body = decodeBody(p.url);
    expect(body).toContain('flow-navigator@0.1.10');
    expect(body).toContain('窗口：1440×900');
    expect(body).toContain('### 问题描述');
    expect(body).toContain('### 环境');
  });

  it('提示用户可以把截图直接拖进 Issue 页', () => {
    const p = buildIssuePlan({ message: 'x', env: ENV });
    expect(decodeBody(p.url)).toContain('拖到本页下方');
  });

  it('正文结构在「截断」与「不截断」两种路径下完全一致', () => {
    const short = buildIssuePlan({ message: '短', appVersion: 'v1', env: ENV });
    const long = buildIssuePlan({
      message: '中'.repeat(3000),
      appVersion: 'v1',
      env: ENV,
    });
    expect(long.truncated).toBe(true);
    /* 两条路径都必须以小标题开头、以截图提示结尾 */
    for (const plan of [short, long]) {
      const body = decodeBody(plan.url);
      expect(body.startsWith('### 问题描述\n\n')).toBe(true);
      expect(body.trimEnd().endsWith('（GitHub 支持拖拽 / 粘贴图片）。')).toBe(true);
    }
  });
});

describe('deriveTitle · 标题推导', () => {
  it('取首个非空行并剥掉 markdown 前缀', () => {
    expect(deriveTitle('\n\n## 表头歪了\n后面还有正文')).toBe('表头歪了');
    expect(deriveTitle('- 连线断了')).toBe('连线断了');
  });

  it('全空/纯空白回退固定文案，绝不产出空标题', () => {
    expect(deriveTitle('')).toBe('用户反馈');
    expect(deriveTitle('   \n  \n')).toBe('用户反馈');
    expect(deriveTitle('###')).toBe('用户反馈');
  });

  it('超长标题截断并加省略号，长度不超上限', () => {
    const t = deriveTitle('标'.repeat(200), 72);
    expect(t.length).toBeLessThanOrEqual(73); // 72 + '…'
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('长度与截断 · 中文膨胀是这里最大的坑', () => {
  it('一个中文字编码后是 9 个字符（预算必须按编码后算的根据）', () => {
    expect(encodeURIComponent('中').length).toBe(9);
  });

  it('★ 上限必须留在实测安全区 —— GitHub 在 ~7KB 处是直接 500 的', () => {
    /*
     * 2026-10-12 实机测（renoo777/feedback，匿名，重复复现稳定）：
     *   6945 / 6954 → 302（正常跳登录）   ← 可用
     *   6990 / 7044 → 500                 ← 挂了
     *   9960        → 414
     * 跨站对照：同长度打 baidu.com 仍 302 → 是 GitHub 侧的坎，不是本机代理。
     * 所以上限必须明显低于 6990；贴边取会在真实浏览器（HTTP/2 + 登录 Cookie）上翻车。
     */
    expect(MAX_ISSUE_URL).toBeLessThanOrEqual(6800);
    expect(MAX_ISSUE_URL).toBeGreaterThanOrEqual(4000);
  });

  it('超长中文描述会被截断，且整条 URL 不超上限', () => {
    const p = buildIssuePlan({ message: '刷'.repeat(3000), env: ENV });
    expect(p.truncated).toBe(true);
    expect(p.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
    /* 截断后的正文必须仍是原文的前缀（不能截出乱码） */
    expect('刷'.repeat(3000).startsWith(p.bodyMessage)).toBe(true);
    expect(p.bodyMessage.length).toBeGreaterThan(0);
  });

  it('截断时给出说明，并提示用「复制完整描述」补全文', () => {
    const p = buildIssuePlan({ message: '刷'.repeat(3000), env: ENV });
    const body = decodeBody(p.url);
    expect(body).toContain('已截断');
    expect(body).toContain('复制完整描述');
    expect(body).toContain(TRUNCATED_NOTE.trim().slice(0, 6));
  });

  it('短描述绝不截断（避免把正常反馈截掉）', () => {
    const p = buildIssuePlan({ message: '按钮点不动', env: ENV });
    expect(p.truncated).toBe(false);
    expect(p.bodyMessage).toBe('按钮点不动');
  });

  it('英文长描述同样受上限约束（ASCII 也不放行）', () => {
    const p = buildIssuePlan({ message: 'a'.repeat(20000), env: ENV });
    expect(p.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
  });
});

describe('安全与规范化', () => {
  it('safeSlice 不劈开代理对（emoji 不会变成半个字符）', () => {
    expect(safeSlice('😀😀', 3)).toBe('😀');
    expect(safeSlice('ab', 5)).toBe('ab');
    /* 劈开的话会留下孤立的 high surrogate */
    expect(/[\uD800-\uDBFF]$/.test(safeSlice('😀😀', 3))).toBe(false);
  });

  it('normalizeMessage 统一换行并把 3 行以上空行压成 1 行', () => {
    expect(normalizeMessage('a\r\nb')).toBe('a\nb');
    expect(normalizeMessage('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeMessage('  \n a \n ')).toBe('a');
  });

  it('composeFullText 永远是全文（截断路径也能拿到完整描述）', () => {
    const msg = '刷'.repeat(3000);
    const full = composeFullText(msg, 'v1', ENV);
    expect(full).toContain(msg);
    expect(full).not.toContain('已截断');
  });

  it('正文不含页面 URL（延续 BugDrop 的 redact URL 默认行为）', () => {
    const body = decodeBody(buildIssuePlan({ message: 'x', env: ENV }).url);
    expect(body).not.toMatch(/https?:\/\/(?!github\.com\/renoo777\/feedback)/);
    expect(body).not.toContain('location');
  });

  it('空描述也不抛错，仍产出可用的链接', () => {
    const p = buildIssuePlan({ message: '   ', env: ENV });
    expect(p.url).toContain('/issues/new?title=');
    expect(p.title).toBe('用户反馈');
  });
});

describe('collectEnvContext · 采集的边界', () => {
  it('无 window / navigator 的环境下（node）不抛错', () => {
    expect(() => collectEnvContext()).not.toThrow();
    expect(Array.isArray(collectEnvContext())).toBe(true);
  });
});
