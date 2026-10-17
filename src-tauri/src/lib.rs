// ============================================================
// 轻提词 (MicroPrompt) V4.0 — Rust 后端
//   · 数据持久化（原子 JSON 写入，与 C++ 版 notes.json / refblocks.json
//     数据结构完全兼容）
//   · 数据目录（4.6.0 起）：默认落在 exe 同目录 data\（安装版即安装目录），
//     用户可在设置里自选位置，支持打开文件夹 / 一键搬移 / 恢复默认
//   · 文件管理台支持：目录列举、盘符、新建文件夹、导出笔记
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
    /// 4.6.0：置顶（收藏）。旧数据缺失 → false，写入后与 C++/旧版仍互相兼容。
    #[serde(default)]
    pub pinned: bool,
}

/// 应用数据全集：notes.json（数组）+ refblocks.json（对象，键=引用块 uuid）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppData {
    pub notes: Vec<Note>,
    #[serde(default)]
    pub refblocks: BTreeMap<String, String>,
}

/* ============================================================
 * 数据目录解析（4.6.0 重做）
 * ------------------------------------------------------------
 * 优先级：
 *   1) 环境变量 MICROPROMPT_DATA_DIR（测试 / 迁移用，最高优先级）
 *   2) 用户在设置里自选的位置（存 config.json 的 dataDir）
 *   3) 默认：exe 同目录 data\ —— 安装版即「安装目录\data」
 *      （不可写时退回 4)）
 *   4) profile 目录 %APPDATA%\{org}\{app}（旧版本的位置，也是迁移来源）
 *
 * 旧数据自动迁移：新默认目录里没有 notes.json，而旧位置有 → 复制过来
 * （只复制、不删除，旧文件留作备份）。
 * ============================================================ */

/// 用户配置：dataDir = 自选数据目录（空 / 缺失 = 用默认位置）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AppConfig {
    #[serde(default, rename = "dataDir")]
    data_dir: Option<String>,
}

/// profile 目录（旧版本的数据位置；也是 config.json 的存放处）
///   dev    → %APPDATA%\DesktopNotesDev\DesktopNotes
///   test   → %APPDATA%\DesktopNotesTest\DesktopNotes
///   stable → %APPDATA%\MicroPrompt\MicroPrompt
fn profile_dir() -> PathBuf {
    let profile = std::env::var("MICROPROMPT_PROFILE").unwrap_or_else(|_| "dev".into());
    let (org, app): (&str, &str) = match profile.as_str() {
        "stable" => ("MicroPrompt", "MicroPrompt"),
        "test" => ("DesktopNotesTest", "DesktopNotes"),
        _ => ("DesktopNotesDev", "DesktopNotes"),
    };
    let base = std::env::var("APPDATA").unwrap_or_else(|_| String::from("."));
    PathBuf::from(base).join(org).join(app)
}

/// exe 所在目录（安装版 = 安装目录；免安装版 = exe 旁边）
fn exe_root() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
}

/// 默认数据目录：<安装目录>\data
fn default_data_dir() -> PathBuf {
    match exe_root() {
        Some(root) => root.join("data"),
        None => profile_dir(),
    }
}

fn config_path() -> PathBuf {
    profile_dir().join("config.json")
}

fn read_config() -> AppConfig {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str::<AppConfig>(&t).ok())
        .unwrap_or_default()
}

fn write_config(cfg: &AppConfig) -> std::io::Result<()> {
    let p = config_path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string(cfg).unwrap_or_else(|_| "{}".into());
    fs::write(p, text)
}

/// 目录是否可写：试着建目录并写一个探针文件（安装到只读位置时用来降级）
fn dir_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".mp-write-test");
    match fs::write(&probe, b"1") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 自选目录是否有效且可写
fn usable_data_dir(p: &Path) -> bool {
    !p.as_os_str().is_empty() && dir_writable(p)
}

/// 解析出的数据目录 + 是否来自用户自选
fn resolve_data_dir() -> (PathBuf, bool) {
    if let Ok(p) = std::env::var("MICROPROMPT_DATA_DIR") {
        let t = p.trim();
        if !t.is_empty() {
            return (PathBuf::from(t), false);
        }
    }
    let cfg = read_config();
    if let Some(custom) = cfg.data_dir.as_ref() {
        let t = custom.trim();
        if !t.is_empty() {
            let p = PathBuf::from(t);
            if usable_data_dir(&p) {
                return (p, true);
            }
        }
    }
    let def = default_data_dir();
    if usable_data_dir(&def) {
        return (def, false);
    }
    // 兜底：exe 目录不可写（例如装进了只读位置）→ 回到旧版 APPDATA 位置
    (profile_dir(), false)
}

/// 旧版数据位置（%APPDATA%\...），迁移提示用
fn legacy_dir() -> PathBuf {
    profile_dir()
}

fn legacy_has_data() -> bool {
    legacy_dir().join("notes.json").exists()
}

/// 首次使用新默认目录时，把旧位置的数据复制过来（只复制，不删除）
fn migrate_legacy_if_needed(dir: &Path) -> bool {
    let legacy = legacy_dir();
    if legacy == dir || dir.join("notes.json").exists() || !legacy.join("notes.json").exists() {
        return false;
    }
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let mut moved = false;
    for name in ["notes.json", "refblocks.json"] {
        let src = legacy.join(name);
        let dst = dir.join(name);
        if src.exists() && !dst.exists() && fs::copy(&src, &dst).is_ok() {
            moved = true;
        }
    }
    moved
}

/// 当前生效的数据目录（含一次性旧数据迁移）
fn data_dir() -> PathBuf {
    let (dir, custom) = resolve_data_dir();
    if !custom {
        let _ = migrate_legacy_if_needed(&dir);
    }
    dir
}

/* ============================================================
 * 存储信息 / 目录浏览（设置页「存储」与文件管理台用）
 * ============================================================ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub name: String,
    pub size: u64,
    /// 修改时间（Unix 毫秒；取不到给 0），前端负责按本地时区格式化
    pub modified_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    /// 当前生效的笔记目录（绝对路径）
    pub dir: String,
    /// 默认目录（安装目录\data）
    pub default_dir: String,
    /// exe 所在目录（安装目录）
    pub app_root: String,
    /// 当前用的是不是默认目录
    pub is_default: bool,
    /// 是否用户自选（自选 = 与默认不同）
    pub is_custom: bool,
    pub writable: bool,
    /// 旧版本的数据位置（%APPDATA%\...），用于提示
    pub legacy_dir: String,
    pub legacy_has_data: bool,
    /// 目录下的数据文件（notes.json / refblocks.json / 备份）
    pub files: Vec<FileInfo>,
    pub total_bytes: u64,
    /// 笔记条数
    pub note_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    /// 是否还能再往下展开（用于选择器画箭头）
    pub has_child: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchReport {
    pub dir: String,
    pub previous_dir: String,
    pub moved_files: Vec<String>,
    pub moved_bytes: u64,
    /// 目标目录里本来就有笔记（切换后显示的是这份数据）
    pub target_had_data: bool,
    /// 本次是否把旧笔记搬了过去
    pub moved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub name: String,
    pub content: String,
}

/// Unix 毫秒时间戳（取不到给 0）
fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn count_notes(dir: &Path) -> usize {
    fs::read_to_string(dir.join("notes.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Note>>(&t).ok())
        .map(|v| v.len())
        .unwrap_or(0)
}

fn storage_info_of(dir: &Path) -> StorageInfo {
    let mut files: Vec<FileInfo> = Vec::new();
    let mut total: u64 = 0;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_data = name.ends_with(".json") || name.ends_with(".json.bak");
            if !is_data {
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            total += size;
            files.push(FileInfo {
                size,
                modified_ms: mtime_ms(&e.path()),
                name,
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let def = default_data_dir();
    StorageInfo {
        dir: dir.to_string_lossy().into_owned(),
        default_dir: def.to_string_lossy().into_owned(),
        app_root: exe_root()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        is_default: dir == def.as_path(),
        is_custom: read_config()
            .data_dir
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        writable: dir_writable(dir),
        legacy_dir: legacy_dir().to_string_lossy().into_owned(),
        legacy_has_data: legacy_has_data(),
        files,
        total_bytes: total,
        note_count: count_notes(dir),
    }
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

// ============ 存储位置（设置页「存储」） ============

/// 返回笔记数据目录（用于设置 / 欢迎页展示 notes.json 路径）
#[tauri::command]
fn get_data_dir() -> String {
    data_dir().to_string_lossy().into_owned()
}

/// 默认数据目录（安装目录\data）
#[tauri::command]
fn get_default_data_dir() -> String {
    default_data_dir().to_string_lossy().into_owned()
}

/// 软件安装目录（exe 所在目录）
#[tauri::command]
fn get_app_root() -> String {
    exe_root()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 存储信息：路径、是否默认、文件清单、笔记条数
#[tauri::command]
fn get_storage_info() -> StorageInfo {
    storage_info_of(&data_dir())
}

/// 在资源管理器中打开文件夹（文件则定位到该文件）
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    let mut cmd = std::process::Command::new("explorer");
    if p.is_file() {
        cmd.arg(format!("/select,{}", p.to_string_lossy()));
    } else {
        if !p.exists() {
            return Err(format!("文件夹不存在：{}", p.to_string_lossy()));
        }
        cmd.arg(p.as_os_str());
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 列出目录下的子文件夹（自绘文件夹选择器用）
#[tauri::command]
fn list_dirs(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = PathBuf::from(path.trim());
    if !dir.exists() {
        return Err("文件夹不存在".into());
    }
    let rd = fs::read_dir(&dir).map_err(|e| format!("无法读取该文件夹：{e}"))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for e in rd.flatten() {
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        // 跳过隐藏目录（.git / .vscode 之类）与系统目录
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let p = e.path();
        let has_child = fs::read_dir(&p)
            .map(|mut it| it.any(|x| x.map(|y| y.path().is_dir()).unwrap_or(false)))
            .unwrap_or(false);
        out.push(DirEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            has_child,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// 本机盘符列表
#[tauri::command]
fn list_drives() -> Vec<DirEntry> {
    let mut out = Vec::new();
    for c in b'C'..=b'Z' {
        let p = format!("{}:\\", c as char);
        let pb = PathBuf::from(&p);
        if pb.exists() {
            out.push(DirEntry {
                name: p.clone(),
                path: p,
                has_child: true,
            });
        }
    }
    out
}

/// 常用位置（桌面 / 文档 / 下载 / 图片 / 安装目录 / 当前笔记目录）
#[tauri::command]
fn get_quick_places() -> Vec<DirEntry> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let mut cands: Vec<(String, PathBuf)> = Vec::new();
    if !home.is_empty() {
        let h = PathBuf::from(&home);
        cands.push(("桌面".into(), h.join("Desktop")));
        cands.push(("文档".into(), h.join("Documents")));
        cands.push(("下载".into(), h.join("Downloads")));
        cands.push(("图片".into(), h.join("Pictures")));
    }
    if let Some(root) = exe_root() {
        cands.push(("安装目录".into(), root));
    }
    cands.push(("当前笔记目录".into(), data_dir()));
    cands.push(("旧版本位置".into(), legacy_dir()));

    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (name, p) in cands {
        if !p.is_dir() {
            continue;
        }
        let path = p.to_string_lossy().into_owned();
        if seen.contains(&path) {
            continue;
        }
        seen.push(path.clone());
        out.push(DirEntry {
            name,
            path,
            has_child: true,
        });
    }
    out
}

/// 新建文件夹（选择器里直接建一个）
#[tauri::command]
fn create_folder(path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    fs::create_dir_all(&p).map_err(|e| format!("新建失败：{e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

/// 把当前笔记数据搬到目标目录 / 切换到目标目录
///   move_data = true  → 复制 notes.json / refblocks.json 过去（旧文件保留作备份）
///   move_data = false → 只切换（用目标目录里已有的数据）
#[tauri::command]
fn switch_data_dir(target: String, move_data: bool) -> Result<SwitchReport, String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("请选择文件夹".into());
    }
    let dest = PathBuf::from(t);
    if !dest.is_absolute() {
        return Err("请选择完整路径的文件夹".into());
    }
    if fs::create_dir_all(&dest).is_err() {
        return Err("无法创建该文件夹（权限不足？）".into());
    }
    if !dir_writable(&dest) {
        return Err("该文件夹不可写，请换一个位置".into());
    }

    let prev = data_dir();
    let target_had_data = dest.join("notes.json").exists();
    let mut moved_files: Vec<String> = Vec::new();
    let mut moved_bytes: u64 = 0;

    if move_data && prev != dest && prev.join("notes.json").exists() {
        if target_had_data {
            // 覆盖前先给目标目录里的旧数据留个档
            let stamp = mtime_ms(&dest.join("notes.json"));
            let bak_name = if stamp > 0 {
                format!("notes.json.{stamp}.bak")
            } else {
                "notes.json.before-move.bak".to_string()
            };
            let _ = fs::copy(dest.join("notes.json"), dest.join(&bak_name));
        }
        for name in ["notes.json", "refblocks.json"] {
            let src = prev.join(name);
            if !src.exists() {
                continue;
            }
            let dst = dest.join(name);
            fs::copy(&src, &dst).map_err(|e| format!("复制 {name} 失败：{e}"))?;
            moved_bytes += fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
            moved_files.push(name.to_string());
        }
        // 读回校验：notes.json 必须是合法 JSON，否则判定本次搬移失败
        if moved_files.iter().any(|n| n == "notes.json") {
            let text = fs::read_to_string(dest.join("notes.json"))
                .map_err(|e| format!("校验失败：{e}"))?;
            serde_json::from_str::<Vec<Note>>(&text)
                .map_err(|e| format!("校验失败：目标目录里的 notes.json 不是合法笔记数据（{e}）"))?;
        }
    }

    // 与默认目录一致时不写自选项（等价于「恢复默认」）
    let cfg = if dest == default_data_dir() {
        AppConfig { data_dir: None }
    } else {
        AppConfig {
            data_dir: Some(dest.to_string_lossy().into_owned()),
        }
    };
    write_config(&cfg).map_err(|e| format!("保存设置失败：{e}"))?;

    Ok(SwitchReport {
        dir: dest.to_string_lossy().into_owned(),
        previous_dir: prev.to_string_lossy().into_owned(),
        moved: !moved_files.is_empty(),
        moved_files,
        moved_bytes,
        target_had_data,
    })
}

/// 恢复默认位置（安装目录\data）
#[tauri::command]
fn reset_data_dir(move_data: bool) -> Result<SwitchReport, String> {
    let def = default_data_dir();
    switch_data_dir(def.to_string_lossy().into_owned(), move_data)
}

/// 导出笔记：把若干文本文件写进指定文件夹（文件管理台的批量导出）
#[tauri::command]
fn export_notes(dir: String, files: Vec<ExportFile>) -> Result<usize, String> {
    let dest = PathBuf::from(dir.trim());
    if dest.as_os_str().is_empty() {
        return Err("请选择导出文件夹".into());
    }
    fs::create_dir_all(&dest).map_err(|e| format!("无法创建导出文件夹：{e}"))?;
    let mut used: Vec<String> = Vec::new();
    let mut count = 0usize;
    for f in files {
        // 文件名清洗：去掉路径分隔符与 Windows 非法字符
        let mut base: String = f
            .name
            .chars()
            .map(|c| match c {
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                c if (c as u32) < 0x20 => '_',
                c => c,
            })
            .collect();
        base = base.trim().trim_end_matches('.').to_string();
        if base.is_empty() {
            base = "未命名笔记".into();
        }
        if !base.to_lowercase().ends_with(".txt") {
            base.push_str(".txt");
        }
        // 重名自动加序号
        let mut name = base.clone();
        let mut i = 2;
        while used.contains(&name.to_lowercase()) || dest.join(&name).exists() {
            let stem = base.trim_end_matches(".txt").to_string();
            name = format!("{stem}({i}).txt");
            i += 1;
        }
        used.push(name.to_lowercase());
        fs::write(dest.join(&name), f.content.as_bytes())
            .map_err(|e| format!("写入 {name} 失败：{e}"))?;
        count += 1;
    }
    Ok(count)
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

// WebView2 用户数据目录：**所有副本共用一个**，由 tauri.conf.json 的 identifier 决定 ——
//   %LOCALAPPDATA%\com.microprompt.v4\EBWebView
// 这里曾经想按 exe 路径生成 `webview-<hash>` 目录做隔离（好让便携版与安装版同时打开），
// 但实测**不生效**：2026-10-17 全盘搜索 `%LOCALAPPDATA%` 下从未出现过 `webview-*` 目录，
// 而注入 localStorage 的登录态在 便携版 / release / 安装版 之间是共享的（都落在那一个目录里）。
// 于是删掉那段死代码，改为把事实写进 README 与设计规范：
//   · 登录态、界面偏好是各副本共享的；
//   · 不要同时开两个副本（共用同一用户数据目录，第二个会报 ERROR_INVALID_STATE 起不来）。
// 以后真要做隔离，先查清 Tauri 2 运行期改 WindowConfig::data_directory 为什么被忽略。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            minimize_window,
            toggle_maximize,
            close_window,
            get_pinned,
            set_pinned,
            get_data_dir,
            get_default_data_dir,
            get_app_root,
            get_storage_info,
            open_folder,
            list_dirs,
            list_drives,
            get_quick_places,
            create_folder,
            switch_data_dir,
            reset_data_dir,
            export_notes
        ])
        .run(context)
        .expect("error while running tauri application");
}
