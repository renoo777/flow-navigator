/** 关于面板
 *  署名作者 + 版本/检查更新；打赏区默认折叠（主流软件惯例：二维码从不首屏平铺，IINA/Motrix 式）。
 *  风格统一复用 ModalShell：Esc 关闭、Tab 焦点圈禁、focus 归位；
 *  内容区是双码左右并排（窄屏退回上下） + 底部一句话诉求 + GitHub sponsor 入口。 */
import { useEffect, useState } from 'react';
import { ModalShell } from './VarModals';
import { appVersion, isTauriEnv, manualCheckUpdates } from './useUpdater';
import { copyText, openExternal } from './openExternal';
import { buildFeedbackFormUrl } from './feedbackForm';

/** 元数据集中，便于后续替换码图或文案的唯一出口 */
export const ABOUT_META = {
  author: 'ming.zhou',
  /** 收货人提示——付款时校验一致再付，避免错付陌生人 */
  weixinNickname: 'renoo',
  alipayNickname: '周先生的小铺(*明)',
  githubUser: 'renoo777', // GitHub 主页/Sponsors 账号（仓库 owner）
} as const;

type Platform = 'weixin' | 'alipay';

/** 单码面板：图片 + 「保存到相册」按钮（移动端长按即可，桌面端主要靠弹窗内右键保存）
 *  为避免触屏指纹识别问题，图片以 <a href=... download> 提供原始下载链接 */
function QrCard({
  platform,
  title,
  nickname,
  src,
  copied,
  onCopy,
}: {
  platform: Platform;
  title: string;
  nickname: string;
  src: string;
  copied: Platform | null;
  onCopy: (p: Platform, v: string) => void;
}) {
  return (
    <div className="ab-qr-card" data-platform={platform}>
      <div className="ab-qr-title">{title}</div>
      <div className="ab-qr-frame">
        <img
          className="ab-qr-img"
          src={src}
          alt={`${title}收款码（${nickname}）`}
          loading="lazy"
          draggable={false}
        />
      </div>
      <div className="ab-qr-foot">
        <span className="ab-qr-nick" title={nickname}>{nickname}</span>
        <button
          className="ab-iconbtn"
          type="button"
          aria-label={`复制 ${title} 收款人备注：${nickname}`}
          title={`复制 "${nickname}"，付款时核对避免错付`}
          onClick={() => onCopy(platform, nickname)}
        >
          {copied === platform ? '✓ 已复制' : '复制备注'}
        </button>
      </div>
      <a
        className="ab-qr-save"
        href={src}
        download={`${platform === 'weixin' ? 'weixin' : 'alipay'}-donate-${nickname}.jpg`}
        aria-label={`保存 ${title} 收款码到本地`}
        title="保存原图到本地，再用 App 扫码（App 内截图码失效）"
      >
        保存原图
      </a>
    </div>
  );
}

export function AboutPanel({ onClose }: { onClose?: () => void }) {
  const [copied, setCopied] = useState<Platform | null>(null);
  const [donateOpen, setDonateOpen] = useState(false);
  const [ver, setVer] = useState('');
  const [busy, setBusy] = useState(false);
  /** 反馈开失败时的原地兜底提示（不额外开页面；成功时恒为空） */
  const [fbNote, setFbNote] = useState('');

  useEffect(() => {
    let alive = true;
    void appVersion().then((v) => alive && setVer(v));
    return () => {
      alive = false;
    };
  }, []);

  const copyRemark = (p: Platform, v: string) => {
    try {
      void navigator.clipboard?.writeText(v);
      setCopied(p);
      window.setTimeout(() => setCopied((cur) => (cur === p ? null : cur)), 1500);
    } catch {
      /* 浏览器无 clipboard 权限——降级成选中 */
      window.alert(`收款人备注：${v}\n长按可复制。`);
    }
  };

  /** 反馈：**一键直达**飞书收集表（免登录、可传图）—— 不再插一层中间弹窗。
   *  只有「没打开成功」时才在原地给一句兜底提示（复制链接），不额外开页面。 */
  const openFeedback = async () => {
    setFbNote('');
    try {
      const { url } = buildFeedbackFormUrl();
      const channel = await openExternal(url);
      if (channel === 'blocked' || channel === 'failed') {
        const ok = await copyText(url);
        setFbNote(ok ? '没能自动打开，链接已复制到剪贴板' : '没能自动打开，请手动复制该链接');
      }
    } catch (e) {
      setFbNote(e instanceof Error ? e.message : String(e));
    }
  };

  const onManualCheck = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await manualCheckUpdates();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="关于"
      subtitle="Flow Navigator · 变量导航器"
      onClose={onClose}
      testid="about-modal"
    >
      <div className="ab-body">
        {/* 顶部一行开发者署名——让"是谁在做"一目了然 */}
        <div className="ab-byline">
          <span className="ab-byline-label">作者</span>
          <span className="ab-byline-name">{ABOUT_META.author}</span>
          <span className="ab-byline-sep">·</span>
          <a
            className="ab-byline-link"
            href={`https://github.com/${ABOUT_META.githubUser}`}
            target="_blank"
            rel="noreferrer noopener"
            title="在 GitHub 上 star / fork 这个项目"
            onClick={(e) => {
              /* 桌面端 <a target="_blank"> 是死的（Tauri 2 不处理 new_window 请求），
                 统一改走 openExternal：Tauri 走系统浏览器，Web 走 window.open。 */
              e.preventDefault();
              void openExternal(`https://github.com/${ABOUT_META.githubUser}`);
            }}
          >
            GitHub
          </a>
        </div>

        {/* 支持作者：默认折叠，点击才展开双码（调研：IINA/Motrix/Obsidian 均收在关于页） */}
        {!donateOpen ? (
          <button
            type="button"
            className="ab-donate-toggle"
            data-testid="donate-toggle"
            onClick={() => setDonateOpen(true)}
          >
            如果这个工具帮到了你，欢迎支持作者 <span aria-hidden="true">▸</span>
          </button>
        ) : (
          <div className="ab-donate-open" data-testid="donate-open">
            <p className="ab-pitch">
              打赏金额随意，没有任何功能解锁。每一笔都会花在更多打磨这件小事的周末下午茶上 🍵
            </p>

            {/* 双码左右并排，窄屏退回上下 */}
            <div className="ab-qr-grid">
              <QrCard
                platform="weixin"
                title="微信赞赏"
                nickname={ABOUT_META.weixinNickname}
                src="./donate/weixin.jpg"
                copied={copied}
                onCopy={copyRemark}
              />
              <QrCard
                platform="alipay"
                title="支付宝"
                nickname={ABOUT_META.alipayNickname}
                src="./donate/alipay.jpg"
                copied={copied}
                onCopy={copyRemark}
              />
            </div>

            <div className="ab-foot-note">
              <span>· 关于手续费：</span>
              <span>微信赞赏码 0.38%（≤200 元）、支付宝个人收款码 0%（单笔 ≤1000 元 / 日 ≤5 万）</span>
            </div>

            <div className="ab-donate-sponsor">
              <a
                href={`https://github.com/sponsors/${ABOUT_META.githubUser}`}
                target="_blank"
                rel="noreferrer noopener"
                title="GitHub Sponsors 跨境打赏通道（需 Visa/MasterCard 信用卡）"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(`https://github.com/sponsors/${ABOUT_META.githubUser}`);
                }}
              >
                海外用户：GitHub Sponsor ↗
              </a>
            </div>
          </div>
        )}

        {/* 反馈：**一键直达**飞书收集表（免登录、可传图片）—— 不再经过中间弹窗。
            入口做成一行普通按钮而非悬浮球，与本面板其它操作同级。 */}
        <div className="ab-feedback-row" data-testid="ab-feedback">
          <span className="ab-fb-hint">遇到问题或有建议？</span>
          <button
            type="button"
            className="ab-update-btn"
            data-testid="feedback-btn"
            title="用系统浏览器打开飞书收集表（免登录、可传图片）"
            onClick={() => void openFeedback()}
          >
            意见反馈
          </button>
        </div>
        {fbNote && (
          <div className="fb-err" data-testid="fb-note" role="alert">
            {fbNote}
          </div>
        )}

        {/* 版本 + 检查更新：仅桌面版显示按钮；浏览器版只展示版本 */}
        <div className="ab-version-row" data-testid="ab-version">
          <span className="ab-ver-label">版本 v{ver || '…'}</span>
          {isTauriEnv ? (
            <button
              type="button"
              className="ab-update-btn"
              data-testid="check-update"
              disabled={busy}
              onClick={() => void onManualCheck()}
              title="检查 GitHub Releases 是否有新版本（应用启动时也会自动检查一次）"
            >
              {busy ? '检查中…' : '检查更新'}
            </button>
          ) : (
            <span className="ab-ver-browser-hint">（桌面版支持自动更新）</span>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
