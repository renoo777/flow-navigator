/**
 * feedbackIssue.ts —— 把「反馈内容」拼成一条预填好的 GitHub Issue 新建链接。
 *
 * 为什么不用 BugDrop 的官方托管服务：它的 API 在 `bugdrop.neonwatty.workers.dev`，
 * 而 `*.workers.dev` 整域在国内被 DNS 污染 + 连接阻断（实测：连不存在的子域都能解析出 IP），
 * 请求根本发不出去 —— 装 GitHub App 也救不了。改走「打开 GitHub 预填页」这条路：
 * github.com 国内可达、零服务端、零 GitHub App 授权、不需要任何账号配置。
 *
 * 代价是丢掉 BugDrop 的截图/标注（那是在浏览器里画完再 POST 给 Worker 的），
 * 所以正文末尾会提示用户「直接把图片拖到 Issue 页」——GitHub 原生支持。
 *
 * 本文件是**纯函数**：零 DOM、零 Tauri、零副作用，可直接单测。
 */

/** 反馈目标仓库。专用私仓，避免与开发用 Issue 混在一起 */
export const FEEDBACK_REPO = 'renoo777/feedback'

/**
 * 整条 URL 的长度上限。
 *
 * 两个都必须按「编码后的长度」算的理由：
 * 1. **中文经 encodeURIComponent 后每个字膨胀到 9 个字符（3 字节 × 3）**
 *    —— 按用户看到的字数估预算必然低估。
 * 2. **GitHub 自己在 ~7KB 处会直接返回 500**（不是 414、也不是静默截断，是一个错误页）。
 *
 * ★ 6500 是**实测**出来的，不是拍的：
 *   - 2026-10-12 实机测（`renoo777/feedback`，匿名请求，各点重复 2–3 次复现稳定）：
 *     `6945 / 6954 → 302`（正常，跳登录），`6990 / 7044 → 500`，`9960 → 414`。
 *   - 临界点夹在 **6954（通）↔ 6990（500）** 之间，对应请求行 `GET <url> HTTP/1.1` 约 7KB。
 *   - **跨站对照**：同长度（8127 字符）打 `baidu.com` 依然 302 → 排除本机代理/沙箱的嫌疑，
 *     确认是 GitHub 侧的坎。
 *   - 留 ~7% 余量的理由：curl 与真实浏览器走的 HTTP 版本 / 头压缩方式不同
 *     （HTTP/2 走 header-list-size，且登录态还带 Cookie），不能贴着临界点取。
 *
 * ⚠️ 教训：单测/探针只能证明「URL 没超过我给的上限」，**证明不了 GitHub 接不接受** ——
 *    上限本身必须靠真实请求测出来。这里当初拍 7000，正好压在坎上（6990 就 500）。
 */
export const MAX_ISSUE_URL = 6500

/** 正文第一段的小标题（含其后空行），是固定开销 */
const HEAD = '### 问题描述\n\n'

/** 截断时追加的说明（也占预算，计算时要扣掉） */
export const TRUNCATED_NOTE =
  '\n\n（内容过长，此处已截断。完整描述请用弹窗里的「复制完整描述」粘贴到这里。）'

export interface IssuePlan {
  /** 可直接交给浏览器打开的 Issue 新建页 */
  url: string
  /** 预填的标题 */
  title: string
  /** 描述因装不进 URL 而被截断了 */
  truncated: boolean
  /** 实际写进 URL 的描述部分（未截断时 = 规范化后的原文） */
  bodyMessage: string
}

/**
 * 按 UTF-16 码元安全截断：不劈开代理对（中文 BMP 字符安全，emoji / 生僻字也安全）。
 * 直接 `slice` 有可能把 emoji 切成两半，渲染出「半个字符」。
 */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = s.slice(0, max)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return cut
}

/** 规范化输入：统一换行、压掉 3 行以上连续空行、去首尾空白 */
export function normalizeMessage(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 标题取首个非空行（顺手剥掉 markdown 前缀），过长截断；全空则回退固定文案 */
export function deriveTitle(message: string, max = 72): string {
  const first = (message.split('\n').find((l) => l.trim()) ?? '').trim()
  if (!first) return '用户反馈'
  const stripped = first.replace(/^[#>\-*\s]+/, '')
  if (!stripped) return '用户反馈'
  return stripped.length > max ? safeSlice(stripped, max) + '…' : stripped
}

/** 采集一段可复现的环境信息。**不含页面 URL 与任何用户可识别信息** */
export function collectEnvContext(): Array<[string, string]> {
  const rows: Array<[string, string]> = []
  if (typeof window !== 'undefined') {
    rows.push(['窗口', `${window.innerWidth}×${window.innerHeight}`])
  }
  if (typeof navigator !== 'undefined') {
    rows.push(['浏览器', navigator.userAgent])
    if (navigator.language) rows.push(['语言', navigator.language])
  }
  try {
    rows.push(['时区', Intl.DateTimeFormat().resolvedOptions().timeZone])
  } catch {
    /* 老环境没有 Intl —— 少一行不影响 */
  }
  return rows
}

/** 环境段（问题描述之后的所有固定内容） */
function composeTail(appVersion: string | undefined, env: Array<[string, string]>): string {
  const lines: string[] = ['### 环境']
  if (appVersion) lines.push(`- 版本：${appVersion}`)
  for (const [k, v] of env) lines.push(`- ${k}：${v}`)
  lines.push('- 来源：Flow Navigator「关于」面板 → 提交反馈')
  lines.push('')
  lines.push('> 有截图的话，直接拖到本页下方即可上传（GitHub 支持拖拽 / 粘贴图片）。')
  return lines.join('\n') + '\n'
}

/** 正文组装：截断路径与完整路径共用，保证两边结构逐字一致 */
function composeBody(
  message: string,
  appVersion: string | undefined,
  env: Array<[string, string]>,
  note = ''
): string {
  return HEAD + message + note + '\n' + composeTail(appVersion, env)
}

export interface BuildIssueOptions {
  message: string
  repo?: string
  /** 形如 `flow-navigator@0.1.10`；用于判断反馈来自哪个版本 */
  appVersion?: string
  /** 覆盖默认环境行（测试用） */
  env?: Array<[string, string]>
}

/**
 * 生成 Issue 新建链接。**装不下时按「编码后长度」二分截断**，并回报 `truncated`。
 */
export function buildIssuePlan(opts: BuildIssueOptions): IssuePlan {
  const repo = opts.repo ?? FEEDBACK_REPO
  const full = normalizeMessage(opts.message)
  const title = deriveTitle(full)
  const env = opts.env ?? collectEnvContext()

  const prevTail = '\n' + composeTail(opts.appVersion, env)
  const prefix = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=`
  /* 固定开销：URL 前缀 + 小标题 + 结尾换行与环境段 */
  let budget =
    MAX_ISSUE_URL -
    prefix.length -
    encodeURIComponent(HEAD).length -
    encodeURIComponent(prevTail).length

  let bodyMessage = full
  let truncated = false

  if (encodeURIComponent(full).length > budget) {
    truncated = true
    budget -= encodeURIComponent(TRUNCATED_NOTE).length
    if (budget < 0) budget = 0
    /* 二分「编码后仍不超预算」的最长前缀（≈11 次 encode，比逐字拼接快且无 O(n²)） */
    let lo = 0
    let hi = full.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (encodeURIComponent(safeSlice(full, mid)).length <= budget) lo = mid
      else hi = mid - 1
    }
    bodyMessage = safeSlice(full, lo)
  }

  const body = composeBody(
    bodyMessage,
    opts.appVersion,
    env,
    truncated ? TRUNCATED_NOTE : ''
  )
  return {
    url: `${prefix}${encodeURIComponent(body)}`,
    title,
    truncated,
    bodyMessage,
  }
}

/** 未截断的完整正文（「复制完整描述」按钮用）—— 保证用户永远拿得到自己写的全文 */
export function composeFullText(
  message: string,
  appVersion?: string,
  env?: Array<[string, string]>
): string {
  return composeBody(normalizeMessage(message), appVersion, env ?? collectEnvContext())
}
