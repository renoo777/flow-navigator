/// Flow Navigator 桌面端入口。
///
/// 保持最简：应用是纯前端 SPA（数据存 localStorage / IndexedDB），Rust 侧只负责
/// 窗口与 WebView 容器，外加自动更新（updater）与重启（process）两个插件。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("启动 Flow Navigator 失败");
}
