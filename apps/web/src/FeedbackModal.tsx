/**
 * FeedbackModal —— 中文反馈弹窗。
 *
 * 链路：写描述 → 拼一条预填好的 GitHub Issue 新建链接 → 用系统浏览器打开 →
 * 用户在 GitHub 页点一次 Submit 才真正落成 Issue。
 *
 * 三个必须写在明面上的取舍（都是 BugDrop 托管方案下没有的）：
 * 1. **需要用户有 GitHub 账号并已登录** —— 提交 Issue 是「以某个人身份」创建的，
 *    不像 BugDrop 那样由 Worker 用 App 凭据代发，所以做不到真正匿名。
 * 2. **没有截图/标注** —— 所以正文里提示「把图片直接拖到 Issue 页」，GitHub 原生支持。
 * 3. **不在应用内假装提交成功** —— 打开失败时必须能「复制链接」兜底，
 *    否则用户以为提交了，实际什么都没发生。
 *
 * 浮层复用 ModalShell（Esc 关闭 / Tab 焦点圈禁 / 焦点归位），与「关于」面板同源。
 */
import { useState } from 'react';
import { ModalShell } from './VarModals';
import { FEEDBACK_REPO, buildIssuePlan, composeFullText } from './feedbackIssue';
import { copyText, openExternal, type OpenResult } from './openExternal';
import { appVersion } from './useUpdater';

const MAX_CHARS = 2000;
const MIN_CHARS = 2;

type Phase =
  | { kind: 'edit' }
  | { kind: 'done'; channel: OpenResult; truncated: boolean; copied: boolean }
  | { kind: 'blocked'; truncated: boolean; copied: boolean };

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [linkCopied, setLinkCopied] = useState(false);

  const ready = message.trim().length >= MIN_CHARS;

  const submit = async () => {
    if (!ready) {
      setErr(`请至少写 ${MIN_CHARS} 个字，描述越具体越容易定位。`);
      return;
    }
    setErr('');
    setBusy(true);
    try {
      /* 版本号现取：弹窗可能在 appVersion 还没 resolve 时就被打开 */
      const label = `flow-navigator@${(await appVersion()) || '0.0.0'}`;
      const plan = buildIssuePlan({ message, appVersion: label });
      /* 描述被截断时，先把完整版放进剪贴板 —— 否则用户永远拿不回被丢掉的那半截 */
      const copied = plan.truncated ? await copyText(composeFullText(message, label)) : false;
      const channel = await openExternal(plan.url);
      setPhase(
        channel === 'tauri' || channel === 'window'
          ? { kind: 'done', channel, truncated: plan.truncated, copied }
          : { kind: 'blocked', truncated: plan.truncated, copied }
      );
    } finally {
      setBusy(false);
    }
  };

  const copyLinkOnly = async () => {
    const label = `flow-navigator@${(await appVersion()) || '0.0.0'}`;
    const plan = buildIssuePlan({ message, appVersion: label });
    const ok = await copyText(plan.url);
    setLinkCopied(ok);
    if (!ok) setErr('复制失败，请手动选中内容复制。');
  };

  const foot =
    phase.kind === 'edit' ? (
      <>
        <span className="fb-count" data-testid="fb-count">
          {message.length} / {MAX_CHARS}
        </span>
        <span className="fb-cta">
          <button className="btn-ghost" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="btn-primary"
            type="button"
            data-testid="fb-submit"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? '打开中…' : '提交并打开 GitHub'}
          </button>
        </span>
      </>
    ) : (
      <>
        <span className="fb-count" />
        <span className="fb-cta">
          <button className="btn-ghost" type="button" onClick={() => void copyLinkOnly()}>
            {linkCopied ? '✓ 链接已复制' : '复制链接'}
          </button>
          {phase.kind === 'done' && (
            <button
              className="btn-ghost"
              type="button"
              data-testid="fb-reopen"
              onClick={() => void submit()}
            >
              再打开一次
            </button>
          )}
          <button className="btn-primary" type="button" onClick={onClose}>
            关闭
          </button>
        </span>
      </>
    );

  return (
    <ModalShell
      title="提交反馈"
      subtitle="会打开 GitHub 的 Issue 新建页，在那里点一次 Submit 才算提交完成"
      onClose={onClose}
      footer={foot}
      testid="feedback-modal"
    >
      {phase.kind === 'edit' ? (
        <>
          <div className="pi-field">
            <div className="pi-field-label">问题描述</div>
            <textarea
              className="fb-textarea"
              data-testid="fb-message"
              aria-label="问题描述"
              placeholder="遇到了什么问题？或者希望增加什么？描述越具体越容易定位。"
              value={message}
              maxLength={MAX_CHARS}
              onChange={(e) => {
                setMessage(e.target.value);
                if (err) setErr('');
              }}
            />
          </div>
          {err && (
            <div className="fb-err" data-testid="fb-err" role="alert">
              {err}
            </div>
          )}
          <div className="pi-note" style={{ marginTop: 10 }}>
            提交会打开 <code>{FEEDBACK_REPO}</code> 的 Issue 页：
            需要你有一个 GitHub 账号并已登录，且<b>点一次 Submit</b> 才会真正创建 Issue。
            有截图的话，直接拖到那个页面里即可上传。
          </div>
        </>
      ) : (
        <div className="fb-done" data-testid="fb-done">
          {phase.kind === 'done' ? (
            <>
              <b>已在浏览器打开 GitHub 页面。</b>
              <p>
                请在打开的页面里核对内容并点一次 <b>Submit new issue</b> —— 只打开页面不算提交。
                如果浏览器没弹出来，用下方的「复制链接」手动打开。
              </p>
            </>
          ) : (
            <>
              <b>没能自动打开浏览器。</b>
              <p>请用下方的「复制链接」，粘贴到浏览器地址栏打开后提交。</p>
            </>
          )}
          {phase.truncated && (
            <p className="fb-warn" data-testid="fb-truncated">
              描述较长，链接里放不下，已在正文中截断。
              {phase.copied
                ? '完整描述已复制到剪贴板，粘贴到页面里即可补全。'
                : '（未能自动复制，请先自行保留完整内容。）'}
            </p>
          )}
        </div>
      )}
    </ModalShell>
  );
}
