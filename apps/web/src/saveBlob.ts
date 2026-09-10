/** 导出文件的落地：桌面 = 保存对话框 + 写字节；纯 Web = <a download>。
 *  GIF / PNG 两条导出链路共用同一套逻辑。 */
import { isDesktop } from './vault';

export async function saveBlobFile(
  blob: Blob,
  defaultName: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<void> {
  if (isDesktop) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const p = await save({ defaultPath: defaultName, filters });
    if (!p) return; /* 用户取消：静默返回 */
    const b64 = await blobToBase64(blob);
    await invoke('export_save_bytes', { path: p, b64 });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = defaultName;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const r = fr.result as string;
      resolve(r.slice(r.indexOf(',') + 1));
    };
    fr.onerror = () => reject(fr.error ?? new Error('读 Blob 失败'));
    fr.readAsDataURL(blob);
  });
}
