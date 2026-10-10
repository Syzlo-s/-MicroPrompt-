// GNU MinGW 工具链的 windres 无法读取含中文的源码路径：
// tauri-winres 会用 dunce::canonicalize 把图标路径还原成中文真实路径
// 再交给 windres，导致 "can't open icon file ... Invalid argument"。
// 这里把 icon.ico 复制到 OUT_DIR（英文路径）并显式指定为窗口图标，绕开该缺陷。
fn main() {
    let original_icon = "icons/icon.ico";
    let out_dir =
        std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is not set"));
    let icon = out_dir.join("icon.ico");

    let icon_path = match std::fs::copy(original_icon, &icon) {
        Ok(_) => icon,
        Err(e) => {
            eprintln!("warning: copy {original_icon} to OUT_DIR failed: {e}");
            std::path::PathBuf::from(original_icon)
        }
    };

    let windows = tauri_build::WindowsAttributes::new().window_icon_path(&icon_path);
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);

    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
