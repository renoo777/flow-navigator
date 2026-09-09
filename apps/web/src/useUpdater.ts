/** 自动更新（Tauri updater 插件）
 *  - 启动自动检查一次（静默，仅在发现新版时询问）
 *  - About 面板「检查更新」手动触发（无新版/失败均有原生提示）
 *  - 浏览器（vite dev / Pages / 未打包）环境无 Tauri API —— 全部安全降级为 no-op
 *
 * 更新链路：应用启动 → 请求 GitHub Release 上的 latest.json → 版本比对
 *  → 有新版 → ask 确认 → downloadAndInstall → relaunch 重启生效。 */
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { getVersion } from '@tauri-apps/api/app';

/** 是否运行在 Tauri WebView 内（非浏览器）。Tauri 2 注入 __TAURI_INTERNALS__ */
export const isTauriEnv =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let cachedVersion: string | null = null;

/** 发布页与镜像前缀（GitHub 直连在国内常被 reset，失败提示里给用户可手动下载的路） */
const RELEASES_URL = 'https://github.com/renoo777/flow-navigator/releases/latest';
const MIRROR = (u: string) => `https://gh-proxy.com/${u}`;

/** 当前应用版本号（桌面端读 tauri.conf.json 的 version；浏览器回退到构建常量） */
export async function appVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = isTauriEnv ? await getVersion() : '0.1.8';
  } catch {
    cachedVersion = '0.1.8';
  }
  return cachedVersion;
}

/** 下载并安装新版本（含重启）；任何一步失败都抛错交由调用方提示 */
async function downloadAndRelaunch(update: { version: string; downloadAndInstall(): Promise<void> }) {
  const downloading = await ask(
    `发现新版本 v${update.version}，是否现在下载并安装？\n\n安装完成后应用会自动重启，你的流程图数据保存在本机，不会丢失。`,
    {
      title: '发现新版本',
      kind: 'info',
      okLabel: '立即更新',
      cancelLabel: '稍后',
    }
  );
  if (!downloading) return false;
  await update.downloadAndInstall();
  await message('更新已安装，正在重启应用…', {
    title: '更新完成',
    kind: 'info',
    okLabel: '好的',
  });
  await relaunch();
  return true;
}

/** 启动自动检查（静默；仅桌面端调用一次）。失败不打扰用户。 */
let autoChecked = false;
export async function autoCheckUpdates(): Promise<void> {
  if (!isTauriEnv || autoChecked) return;
  autoChecked = true;
  try {
    const update = await check();
    if (!update) return; // 已是最新 —— 静默
    await downloadAndRelaunch(update);
  } catch {
    /* 网络异常 / endpoint 未配置 —— 静默忽略，不打扰用户 */
  }
}

/** About 面板「检查更新」：手动触发，带明确反馈 */
export async function manualCheckUpdates(): Promise<void> {
  if (!isTauriEnv) {
    await message('检查更新仅在桌面版可用。', {
      title: 'Flow Navigator',
      kind: 'info',
      okLabel: '知道了',
    });
    return;
  }
  try {
    const update = await check();
    if (!update) {
      await message('当前已是最新版本。', {
        title: '检查更新',
        kind: 'info',
        okLabel: '好的',
      });
      return;
    }
    await downloadAndRelaunch(update);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    /* 0918：国内访问 GitHub 常被 reset（不是配置问题）。与其只说「请确认网络」，
       不如直接给出能用的下载入口 —— 官方发布页 + gh-proxy 镜像，复制即可下载。 */
    await message(
      `自动更新服务连不上（国内网络访问 GitHub 常常超时/被重置）。\n\n` +
        `可以手动下载最新版安装包：\n` +
        `1）官方发布页：\n${RELEASES_URL}\n` +
        `2）打不开就用国内镜像：\n${MIRROR(RELEASES_URL)}\n\n` +
        `错误详情：${detail}`,
      { title: '检查更新失败', kind: 'error', okLabel: '关闭' }
    );
  }
}
