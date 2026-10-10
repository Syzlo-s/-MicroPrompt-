// ============================================================
// 轻提词 (MicroPrompt) V4.0 — Rust 后端
//   · 数据持久化（原子 JSON 写入，与 C++ 版 notes.json / refblocks.json
//     数据结构完全兼容）
//   · 窗口管理（置顶 / 最大最小化 / 关闭，重绘无边框窗口）
// ============================================================

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 单条笔记 —— 字段语义与 C++ 版 NoteManager::Note 完全一致
/// （含 color 字段：0=黑 1=红 2=蓝，已持久化，以代码为准）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    #[serde(default)] // 旧数据可能缺失（C++ 侧 QJsonObject::value("background").toInt(0) 默认 0）
    pub background: i32, // 0=纯白 1=纸张黄
    #[serde(default)] // 老版本 notes.json 未持久化 color（同样默认 0），缺失时不得导致整条解析失败
    pub color: i32,      // 0=黑(默认) 1=红 2=蓝
    pub created: String, // ISO8601 本地时间 "yyyy-MM-ddTHH:mm:ss"
    pub modified: String,
}

/// 应用数据全集：notes.json（数组）+ refblocks.json（对象，键=引用块 uuid）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppData {
    pub notes: Vec<Note>,
    #[serde(default)]
    pub refblocks: BTreeMap<String, String>,
}

/// 三版本管理体系（与 C++ 版一致，互不干扰）：
///   dev    → %APPDATA%\DesktopNotesDev\DesktopNotes （默认，V4.0 开发分支）
///   test   → %APPDATA%\DesktopNotesTest\DesktopNotes
///   stable → %APPDATA%\MicroPrompt\MicroPrompt
/// 可用环境变量 MICROPROMPT_PROFILE=dev|test|stable 切换，
/// 或 MICROPROMPT_DATA_DIR 直接指定数据目录（迁移/测试用）。
fn data_dir() -> PathBuf {
    // 1) 环境变量显式指定（最高优先级）：MICROPROMPT_DATA_DIR 绝对路径
    if let Ok(p) = std::env::var("MICROPROMPT_DATA_DIR") {
        if !p.trim().is_empty() {
            return PathBuf::from(p.trim());
        }
    }
    // 2) exe 同目录 data 文件夹（若含 notes.json 则直接用作数据目录）。
    //    支持"直接双击 exe"即可用独立数据（稳定版V4.0\data 等），无需环境变量。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let local = dir.join("data");
            if local.join("notes.json").exists() {
                return local;
            }
        }
    }
    // 3) profile 环境变量 / 默认 dev
    let profile = std::env::var("MICROPROMPT_PROFILE").unwrap_or_else(|_| "dev".into());
    let (org, app): (&str, &str) = match profile.as_str() {
        "stable" => ("MicroPrompt", "MicroPrompt"),
        "test" => ("DesktopNotesTest", "DesktopNotes"),
        _ => ("DesktopNotesDev", "DesktopNotes"),
    };
    let base = std::env::var("APPDATA").unwrap_or_else(|_| String::from("."));
    PathBuf::from(base).join(org).join(app)
}

/// 生成同目录兄弟文件路径：notes.json → notes.json.tmp / notes.json.bak
/// （与 C++ 版备份命名一致）
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// 原子写入（对齐 C++ 版保存链路）：
///   写 .tmp → 读回校验内容一致 → 备份旧文件 .bak → rename 替换
///   连续失败 2 次后回退为“直接覆盖写（保留 .bak）”，保证零丢失。
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = sibling(path, ".tmp");
    let bak = sibling(path, ".bak");
    let mut last_err: Option<std::io::Error> = None;
    for _ in 0..2 {
        match try_atomic(path, &tmp, &bak, bytes) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    let _ = fs::copy(path, &bak); // 回退：仍保留 .bak 副本
    fs::write(path, bytes).map_err(|e| {
        last_err
            .as_ref()
            .map(|l| std::io::Error::new(e.kind(), format!("{l}; fallback also failed: {e}")))
            .unwrap_or(e)
    })
}

fn try_atomic(path: &Path, tmp: &Path, bak: &Path, bytes: &[u8]) -> std::io::Result<()> {
    fs::write(tmp, bytes)?;
    let readback = fs::read(tmp)?;
    if readback != bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "readback mismatch",
        ));
    }
    if path.exists() {
        fs::copy(path, bak)?;
    }
    fs::rename(tmp, path)
}

/// 加载数据：notes.json / refblocks.json 缺失时返回空数据（首次启动）
#[tauri::command]
fn load_data() -> AppData {
    let dir = data_dir();
    let mut data = AppData::default();

    if let Ok(text) = fs::read_to_string(dir.join("notes.json")) {
        if let Ok(notes) = serde_json::from_str::<Vec<Note>>(&text) {
            data.notes = notes;
        }
    }
    if let Ok(text) = fs::read_to_string(dir.join("refblocks.json")) {
        if let Ok(map) = serde_json::from_str::<BTreeMap<String, String>>(&text) {
            data.refblocks = map;
        }
    }
    data
}

/// 保存数据：紧凑 JSON 输出（与 C++ 版 Compact 输出一致），原子写入
#[tauri::command]
fn save_data(data: AppData) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let notes_json = serde_json::to_string(&data.notes).map_err(|e| e.to_string())?;
    let rb_json = serde_json::to_string(&data.refblocks).map_err(|e| e.to_string())?;

    atomic_write(&dir.join("notes.json"), notes_json.as_bytes()).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("refblocks.json"), rb_json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

// ============ 窗口控制（前端通过 invoke 调用） ============

#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn toggle_maximize(window: tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn close_window(window: tauri::WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
fn get_pinned(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_always_on_top().ok())
        .unwrap_or(false)
}

/// 置顶切换（对应 C++ 版 SetWindowPos TOPMOST/NOTOPMOST；不持久化）
#[tauri::command]
fn set_pinned(app: AppHandle, pinned: bool) -> bool {
    if let Some(w) = app.get_webview_window("main") {
        if w.set_always_on_top(pinned).is_ok() {
            return w.is_always_on_top().unwrap_or(pinned);
        }
    }
    pinned
}

/// WebView2 用户数据目录标识：按可执行文件路径生成稳定的短哈希。
/// 开发版 / 稳定版 / 测试版即使由同一份源码构建、共用同一 identifier，
/// 也会各自使用独立的 WebView2 user data folder，从而可以同时打开；
/// 否则第二个实例会因共用同一目录报 ERROR_INVALID_STATE 而无法启动。
fn webview_profile_key() -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let s = exe.to_string_lossy().to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a 64bit offset basis
    for b in s.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 返回笔记数据目录（用于首次欢迎页展示 notes.json 路径）
#[tauri::command]
fn get_data_dir() -> String {
    data_dir().to_string_lossy().into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    // 为每个构建产物指定独立且绝对的 WebView2 数据目录，避免不同版本互相影响
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| String::from("."));
    let webview_dir = PathBuf::from(local).join(format!("webview-{}", webview_profile_key()));
    for w in context.config_mut().app.windows.iter_mut() {
        if w.data_directory.is_none() {
            w.data_directory = Some(webview_dir.clone());
        }
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            minimize_window,
            toggle_maximize,
            close_window,
            get_pinned,
            set_pinned,
            get_data_dir
        ])
        .run(context)
        .expect("error while running tauri application");
}
