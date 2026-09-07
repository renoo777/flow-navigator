/** 桌面端「图库文件镜像」通道。
 *
 * IndexedDB（WebView 数据目录）是主存储，但它会被「升级 / 换安装方式 / 清理 WebView 数据」
 * 连带抹掉。桌面版因此把整份图库再写一份到用户数据目录的 JSON 文件
 * （Windows: %APPDATA%\com.flownavigator.app\flow-library.json）。
 * 纯 Web 环境无 Rust 侧（isDesktop=false）→ 全部调用安全返回 null。
 */
import { invoke } from '@tauri-apps/api/core';

/** 是否在 Tauri 桌面壳里运行（Web 预览/测试环境为 false） */
export const isDesktop =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 镜像文件路径（UI 提示用），Web 环境返回 null */
export async function vaultPath(): Promise<string | null> {
  if (!isDesktop) return null;
  try {
    const p = await invoke<string>('vault_path');
    return typeof p === 'string' && p ? p : null;
  } catch {
    return null;
  }
}

/** 读回镜像文本；没有或损坏 → null */
export async function vaultLoad(): Promise<string | null> {
  if (!isDesktop) return null;
  try {
    const s = await invoke<string | null>('vault_load');
    return typeof s === 'string' && s.trim().startsWith('{') ? s : null;
  } catch {
    return null;
  }
}

export async function vaultSave(text: string): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    await invoke<void>('vault_save', { content: text });
    return true;
  } catch {
    return false;
  }
}
