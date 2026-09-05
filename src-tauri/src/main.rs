// Release 构建下不再弹出额外的控制台窗口（Windows）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flow_navigator_lib::run()
}
