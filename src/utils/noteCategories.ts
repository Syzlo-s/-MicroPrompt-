import type { Note } from "../types";
import { isoMs, loadLastOpened } from "./noteOrder";

/* ============================================================
 * 笔记分类 / 自动归档（4.8.5）
 * ------------------------------------------------------------
 * 两套并行的分类规则：
 *   1. 用户自选分类：note.category 存分类名，列表持久化在
 *      localStorage「microprompt.noteCategories」；用户可以随时把
 *      笔记移到任意分类，也可以删除分类（笔记退回未分类）。
 *   2. 自动分类（灰度提示词）：软件按「活跃度」自动分。最近一次打开 /
 *      编辑 / 创建距今超过 15 天 → 自动移入「灰度提示词」；重新打开 /
 *      编辑或置顶后自动移回未分类。置顶笔记永不自动归档。
 *
 * 判定只看「最近活跃时间」，不做任何正文 / 标题分析，保证零误判、
 * 零额外 IO：打开时间复用侧栏那套 notesLastOpened 记录。
 * ============================================================ */

/** 自动归档分类名（系统保留，用户不能新建同名分类） */
export const GRAY_CATEGORY = "灰度提示词";
/** 判定为「灰度」的空闲天数 */
export const STALE_DAYS = 15;
export const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/** 用户分类列表的持久化键 */
const CATEGORIES_KEY = "microprompt.noteCategories";

/** 分类名规整：折叠空白 + 去首尾空格，最长 20 字 */
export function normalizeCategoryName(name: string): string {
  return (name ?? "").replace(/\s+/g, " ").trim().slice(0, 20);
}

/** 读取用户分类列表（过滤空名 / 系统保留名 / 重复项） */
export function loadCategories(): string[] {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const v of arr) {
      const name = typeof v === "string" ? normalizeCategoryName(v) : "";
      if (name && name !== GRAY_CATEGORY && !out.includes(name)) out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

/** 写回用户分类列表（隐私模式等写不进去时忽略） */
export function saveCategories(list: string[]): void {
  try {
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** 笔记的最近活跃时间：打开过 → 打开时间；否则取最近修改 / 创建时间 */
export function noteLastActive(
  note: Note,
  openedAt: Record<string, number>,
): number {
  return Math.max(
    openedAt[note.id] ?? 0,
    isoMs(note.modified),
    isoMs(note.created),
  );
}

/** 是否已经「灰掉」：置顶笔记永不自动归档 */
export function isStaleNote(
  note: Note,
  openedAt: Record<string, number>,
  now = Date.now(),
): boolean {
  if (note.pinned) return false;
  return now - noteLastActive(note, openedAt) > STALE_MS;
}

/** 当前在用的打开时间表（每次现读，避免模块级缓存过期） */
export function loadOpenedAt(): Record<string, number> {
  return loadLastOpened();
}
