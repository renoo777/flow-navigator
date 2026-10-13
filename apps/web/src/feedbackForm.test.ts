/**
 * feedbackForm.ts 的回归。
 *
 * 链路已从「GitHub Issue 预填页」换成「飞书收集表」，本测试钉住新契约：
 * 打开的必须是**我们那条**收集表（https + 指定租户），配置被改错要**早失败**，
 * 不能静默打开一个别的地方（上一版正是栽在「以为能提、其实用户要登录」）。
 */
import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_FORM_URL,
  FEEDBACK_FORM_HOST,
  MAX_FORM_URL,
  isExpectedFormUrl,
  buildFeedbackFormUrl,
  withPrefill,
} from './feedbackForm';

describe('buildFeedbackFormUrl · 基本形状', () => {
  it('返回配置的收集表链接', () => {
    const p = buildFeedbackFormUrl();
    expect(p.url).toBe(FEEDBACK_FORM_URL);
    expect(p.host).toBe(FEEDBACK_FORM_HOST);
  });

  it('是 https 且指向指定租户', () => {
    expect(buildFeedbackFormUrl().url.startsWith(`https://${FEEDBACK_FORM_HOST}/`)).toBe(true);
  });

  it('默认链接本身合法', () => {
    expect(isExpectedFormUrl(FEEDBACK_FORM_URL)).toBe(true);
  });

  it('链接不是 GitHub（旧链路必须彻底断掉）', () => {
    expect(FEEDBACK_FORM_URL.includes('github.com')).toBe(false);
  });
});

describe('配置写错时早失败（不静默打开一个奇怪的地方）', () => {
  it('http 明文被拒', () => {
    expect(() => buildFeedbackFormUrl(`http://${FEEDBACK_FORM_HOST}/x`)).toThrow();
  });

  it('别的 host 被拒', () => {
    expect(() => buildFeedbackFormUrl('https://evil.example.com/x')).toThrow();
    expect(() => buildFeedbackFormUrl('https://github.com/renoo777/feedback')).toThrow();
  });

  it('不是 URL 的字符串被拒', () => {
    expect(() => buildFeedbackFormUrl('not a url')).toThrow();
    expect(isExpectedFormUrl('not a url')).toBe(false);
    expect(isExpectedFormUrl('')).toBe(false);
  });

  it('超长链接被拒（守住 16000 上限）', () => {
    const long = `https://${FEEDBACK_FORM_HOST}/` + 'a'.repeat(MAX_FORM_URL);
    expect(long.length).toBeGreaterThan(MAX_FORM_URL);
    expect(() => buildFeedbackFormUrl(long)).toThrow(/超长/);
  });
});

describe('withPrefill · 预填参数（当前 UI 未用，备将来带环境信息）', () => {
  it('拼出 prefill_ 参数并做 URL 编码', () => {
    const out = withPrefill(FEEDBACK_FORM_URL, { 应用版本: '0.1.10', 操作系统: 'Windows 11' });
    expect(out.startsWith(FEEDBACK_FORM_URL + '?')).toBe(true);
    expect(out.includes('prefill_%E5%BA%94%E7%94%A8%E7%89%88%E6%9C%AC=0.1.10')).toBe(true);
    expect(out.includes('Windows%2011')).toBe(true);
    expect(out.includes('&')).toBe(true);
  });

  it('空字段被跳过；全空则原样返回', () => {
    expect(withPrefill(FEEDBACK_FORM_URL, { a: '' })).toBe(FEEDBACK_FORM_URL);
    expect(withPrefill(FEEDBACK_FORM_URL, {})).toBe(FEEDBACK_FORM_URL);
  });

  it('链接已有查询串时用 & 连接', () => {
    expect(withPrefill('https://x.feishu.cn/f?from=app', { a: '1' })).toBe(
      'https://x.feishu.cn/f?from=app&prefill_a=1'
    );
  });
});
