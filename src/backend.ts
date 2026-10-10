import { invoke } from "@tauri-apps/api/core";
import type { AppData } from "./types";

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

export const getDataDir = (): Promise<string> => invoke<string>("get_data_dir");
