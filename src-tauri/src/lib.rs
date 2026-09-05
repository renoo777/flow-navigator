/// Flow Navigator 桌面端入口。
///
/// 刻意保持最简：不注册任何 command、不挂载插件。
/// 应用是纯前端 SPA（数据存 localStorage），Rust 侧只负责窗口与 WebView 容器。
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动 Flow Navigator 失败");
}
