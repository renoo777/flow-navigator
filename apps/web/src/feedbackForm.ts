/**
 * feedbackForm.ts —— 反馈收集表（飞书）的链接构造与校验。
 *
 * 为什么是「打开表单」而不是「应用内提交」：
 *   硬要求 = 「终端用户不登录任何账号」+「要能上传图片」。
 *   这两条一起 ⟹ **必须有服务端托管收集**；飞书收集表把这个服务端外包掉了 ——
 *   免登录（关闭「填写需登录验证」）、可传附件、数据落多维表格（自带仪表盘 / 导出 Excel）。
 *
 * ✗ 已被否决的两条旧路（别再走回去）：
 *   1. GitHub Issue 预填页 —— 需要用户有 GitHub 账号并登录，违反「不登录」。
 *   2. 多维表格「自动化 webhook」直提 —— 请求体是 JSON ≤ 4MB，**装不下图片附件**。
 *
 * 本文件是**纯函数**：零 DOM、零 Tauri、零副作用，可直接单测。
 */

/** 收集表分享链接（2026-10-12 由产品侧在飞书创建）。 */
export const FEEDBACK_FORM_URL =
  'https://qiangqiangkeji.feishu.cn/share/base/webpage/shrcnIr0Y3Z1nqkYKqNBw42tjxc';

/** 期望的表单 host —— 配置被改错（换成别的租户/别的网站）时要早失败，别静默打开一个奇怪的地方。 */
export const FEEDBACK_FORM_HOST = 'qiangqiangkeji.feishu.cn';

/**
 * 飞书表单分享链接的长度上限。官方：**16,000 字符**，超出则预填/链接失效。
 * 我们现在不带任何参数，离上限极远；留着是给「以后要 prefill 环境信息」当护栏。
 */
export const MAX_FORM_URL = 16000;

export interface FormPlan {
  /** 直接用系统浏览器打开的地址 */
  url: string;
  /** 供日志 / 断言用 */
  host: string;
}

/** 这个链接是不是我们期望的那条（https + 指定租户）。 */
export function isExpectedFormUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === FEEDBACK_FORM_HOST;
  } catch {
    return false;
  }
}

/**
 * 生成要打开的反馈表单地址。
 *
 * 目前**不附加任何参数**：表单自带「意见类型 / 意见内容 / 附件」三题，
 * 用户在表单里一次性填完。应用侧不再问一遍 —— 否则同一份内容要写两次。
 */
export function buildFeedbackFormUrl(formUrl: string = FEEDBACK_FORM_URL): FormPlan {
  if (!isExpectedFormUrl(formUrl)) {
    throw new Error(`反馈表单链接不合法（期望 https://${FEEDBACK_FORM_HOST}/…）：${formUrl}`);
  }
  if (formUrl.length > MAX_FORM_URL) {
    throw new Error(`反馈表单链接超长：${formUrl.length} > ${MAX_FORM_URL}`);
  }
  return { url: formUrl, host: FEEDBACK_FORM_HOST };
}

/**
 * 往表单链接上拼飞书预填参数：`?prefill_[问题名]=[值]`。
 *
 * ⚠️ 飞书要求**问题名与表单里的题目名完全一致**，改名即失效（官方文档原文）。
 * 目前 UI 还没有用到它（表单自带那三题就够），先备好 —— 一旦要「自动带版本/系统信息」，
 * 只需在表单里加三个隐藏问答题，再在这里传 `{ 应用版本: … }` 即可。
 */
export function withPrefill(base: string, fields: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!k || v === undefined || v === null || v === '') continue;
    parts.push(`prefill_${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  if (!parts.length) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${parts.join('&')}`;
}
