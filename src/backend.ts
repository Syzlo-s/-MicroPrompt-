import { invoke } from "@tauri-apps/api/core";
import type { AppData } from "./types";

/* ============================================================
 * 前端 → Rust 命令封装
 * （4.6.0 起新增「存储位置」与「文件管理台」用到的命令）
 * ============================================================ */

export const loadData = (): Promise<AppData> => invoke<AppData>("load_data");

export const saveData = (data: AppData): Promise<void> =>
  invoke("save_data", { data });

export const minimizeWindow = (): Promise<void> =>
  invoke("minimize_window");

export const toggleMaximize = (): Promise<void> => invoke("toggle_maximize");

export const closeWindow = (): Promise<void> => invoke("close_window");

export const getPinned = (): Promise<boolean> => invoke<boolean>("get_pinned");

export const setPinned = (pinned: boolean): Promise<boolean> =>
  invoke<boolean>("set_pinned", { pinned });

/** 当前生效的笔记目录 */
export const getDataDir = (): Promise<string> => invoke<string>("get_data_dir");

/** 默认笔记目录（安装目录\data） */
export const getDefaultDataDir = (): Promise<string> =>
  invoke<string>("get_default_data_dir");

/** 软件安装目录 */
export const getAppRoot = (): Promise<string> => invoke<string>("get_app_root");

/** 数据目录下的文件（notes.json / refblocks.json / 备份） */
export interface StorageFileInfo {
  name: string;
  size: number;
  /** Unix 毫秒；0 = 取不到 */
  modifiedMs: number;
}

export interface StorageInfo {
  dir: string;
  defaultDir: string;
  appRoot: string;
  isDefault: boolean;
  isCustom: boolean;
  writable: boolean;
  /** 旧版本的数据位置（%APPDATA%\...） */
  legacyDir: string;
  legacyHasData: boolean;
  files: StorageFileInfo[];
  totalBytes: number;
  noteCount: number;
}

export interface DirEntry {
  name: string;
  path: string;
  hasChild: boolean;
}

export interface SwitchReport {
  dir: string;
  previousDir: string;
  movedFiles: string[];
  movedBytes: number;
  targetHadData: boolean;
  moved: boolean;
}

export interface ExportFile {
  name: string;
  content: string;
}

export const getStorageInfo = (): Promise<StorageInfo> =>
  invoke<StorageInfo>("get_storage_info");

/** 在资源管理器中打开文件夹（传文件则定位到该文件） */
export const openFolder = (path: string): Promise<void> =>
  invoke("open_folder", { path });

/** 列出某目录下的子文件夹（自绘文件夹选择器） */
export const listDirs = (path: string): Promise<DirEntry[]> =>
  invoke<DirEntry[]>("list_dirs", { path });

/** 盘符列表 */
export const listDrives = (): Promise<DirEntry[]> =>
  invoke<DirEntry[]>("list_drives");

/** 常用位置（桌面 / 文档 / 下载 / 安装目录 / 当前笔记目录…） */
export const getQuickPlaces = (): Promise<DirEntry[]> =>
  invoke<DirEntry[]>("get_quick_places");

export const createFolder = (path: string): Promise<string> =>
  invoke<string>("create_folder", { path });

/** 切换笔记保存位置；moveData = 是否把现有笔记一起搬过去 */
export const switchDataDir = (
  target: string,
  moveData: boolean,
): Promise<SwitchReport> =>
  invoke<SwitchReport>("switch_data_dir", { target, moveData });

/** 恢复默认位置（安装目录\data） */
export const resetDataDir = (moveData: boolean): Promise<SwitchReport> =>
  invoke<SwitchReport>("reset_data_dir", { moveData });

/** 批量导出笔记到指定文件夹，返回写出的文件数 */
export const exportNotes = (
  dir: string,
  files: ExportFile[],
): Promise<number> => invoke<number>("export_notes", { dir, files });
