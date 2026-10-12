/**
 * openExternal.ts —— 用系统默认浏览器打开外部链接。
 *
 * ⚠️ 桌面端**不能**靠 `<a target="_blank">` 或 `window.open`：
 * Tauri 2 默认不处理 new_window 请求（`WebviewBuilder::new_window_handler` 初值 `None`，
 * 只有显式调 `on_new_window` 才安装），而 wry 在无处理器时的分支是
 * `args.SetHandled(true)` —— 语义是「已处理，且什么都不做」。
 * 于是桌面端点 `target="_blank"` 的链接**毫无反应，且控制台不报错**，极难自查。
 *
 * 所以桌面端统一走 Rust 的 `open_external`（opener crate → 系统 ShellExecute）：
 * 既绕开上面这个坑，也不受命令行长度 / `&` 转义影响 —— Issue 链接带 `?title=&body=`
 * 且中文编码后会很长，正好踩这两点。
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './useUpdater';

/** 实际生效的通道：tauri = 系统浏览器；window = 浏览器新标签；blocked/failed = 都没成 */
export type OpenResult = 'tauri' | 'window' | 'blocked' | 'failed';

/**
 * 打开外部链接。
 * 返回**实际走的通道**，让调用方决定要不要提示用户「手动复制链接」。
 */
export async function openExternal(url: string): Promise<OpenResult> {
  if (isTauriEnv) {
    try {
      await invoke('open_external', { url });
      return 'tauri';
    } catch (e) {
      /* 命令缺失 / 被拒 / 系统无关联程序 —— 都退到 window.open 再试一次 */
      console.warn('[feedback] 系统浏览器打开失败，回退 window.open', e);
    }
  }
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    return w ? 'window' : 'blocked';
  } catch {
    return 'failed';
  }
}

/** 复制文本到剪贴板；不可用时回退到「选中 + execCommand」，最后才放弃 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
