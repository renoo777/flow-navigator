/// Flow Navigator 桌面端入口。
///
/// 保持最简：应用是纯前端 SPA（数据存 IndexedDB），Rust 侧只负责窗口与 WebView 容器，
/// 外加自动更新（updater）、重启（process）、对话框（dialog）三个插件。
///
/// 唯一例外是**图库文件镜像**（vault_* 三个命令）：IndexedDB 存在 WebView 的数据目录里
/// （Windows: %LOCALAPPDATA%\<identifier>\EBWebView），它跟着 WebView 的 origin 走，
/// 升级到新版本、清理 WebView 数据、重装时都可能连带消失。
/// 因此桌面版额外把整份图库镜像写到**用户数据目录**（%APPDATA%\<identifier>\flow-library.json），
/// 该目录不被安装包/更新器触碰 → 数据跨版本不丢；启动时前端对比两侧做并集恢复。
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// 0918 · GIF 导出落盘（save dialog 选定路径后写盘）。
/// 二进制经 IPC 的命名参数会被 JSON 序列化失真，故前端传 base64 文本，
/// 这里解码后直接写用户所选路径（可能在任何盘符，不走 app_data_dir）。
#[tauri::command]
fn export_save_bytes(path: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

const LIB_FILE: &str = "flow-library.json";
const BACKUP_DIR: &str = "library-backups";
const KEEP_BACKUPS: usize = 7;

/// 图库镜像所在目录（Windows: %APPDATA%\com.flownavigator.app）
fn lib_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 备份用「天」标记（自 epoch 起的整数天），按天去重即可做到「每天一份快照」
fn day_key() -> u64 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs / 86_400
}

fn prune_backups(dir: &PathBuf) -> Result<(), String> {
    let mut list: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|r| r.path())
        .filter(|p| p.is_file())
        .collect();
    if list.len() <= KEEP_BACKUPS {
        return Ok(());
    }
    /* 文件名含天号，字典序即时间序：只保留最新的 KEEP_BACKUPS 份 */
    list.sort();
    let drop = list.len() - KEEP_BACKUPS;
    for p in list.into_iter().take(drop) {
        let _ = fs::remove_file(p);
    }
    Ok(())
}

/// 镜像文件路径（供 UI 展示「备份在哪」）
#[tauri::command]
fn vault_path(app: AppHandle) -> Result<String, String> {
    Ok(lib_dir(&app)?.join(LIB_FILE).to_string_lossy().to_string())
}

/// 读回镜像：优先主文件；主文件缺失（误删/写坏/迁移遗漏）时退回最近一份快照
#[tauri::command]
fn vault_load(app: AppHandle) -> Result<Option<String>, String> {
    let dir = lib_dir(&app)?;
    let main = dir.join(LIB_FILE);
    if main.is_file() {
        return match fs::read_to_string(&main) {
            Ok(s) if s.trim().starts_with('{') => Ok(Some(s)),
            Ok(_) => Ok(None), // 内容不是 JSON → 视为损坏，继续找快照
            Err(e) => Err(e.to_string()),
        };
    }
    let baks = dir.join(BACKUP_DIR);
    let mut list: Vec<PathBuf> = match fs::read_dir(&baks) {
        Ok(rd) => rd
            .filter_map(|r| r.ok())
            .map(|r| r.path())
            .filter(|p| p.is_file())
            .collect(),
        Err(_) => return Ok(None),
    };
    if list.is_empty() {
        return Ok(None);
    }
    list.sort();
    let newest = list.pop().unwrap();
    match fs::read_to_string(&newest) {
        Ok(s) if s.trim().starts_with('{') => Ok(Some(s)),
        _ => Ok(None),
    }
}

/// 写镜像：先「今日快照留旧」，再原子写主文件，最后裁剪旧快照。
/// 原子写（tmp → rename）保证写一半被打断时主文件不会变成半个 JSON。
#[tauri::command]
fn vault_save(app: AppHandle, content: String) -> Result<(), String> {
    let dir = lib_dir(&app)?;
    let main = dir.join(LIB_FILE);
    let baks = dir.join(BACKUP_DIR);
    fs::create_dir_all(&baks).map_err(|e| e.to_string())?;

    /* 每天留一份「写之前」的旧状态（误删/误改当天可回滚） */
    let today_bak = baks.join(format!("flow-library-{}.json", day_key()));
    if main.is_file() && !today_bak.exists() {
        let _ = fs::copy(&main, &today_bak);
    }

    let tmp = dir.join(format!("{}.tmp", LIB_FILE));
    fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    if main.exists() {
        let _ = fs::remove_file(&main); // Windows 的 rename 不能覆盖同名文件
    }
    fs::rename(&tmp, &main).map_err(|e| e.to_string())?;
    prune_backups(&baks)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![vault_path, vault_load, vault_save, export_save_bytes])
        .run(tauri::generate_context!())
        .expect("启动 Flow Navigator 失败");
}
