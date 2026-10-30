import type { Note } from "../types";

/* ============================================================
 * 笔记排序 / 最近打开记录（4.8.6 调整）
 * ------------------------------------------------------------
 * 4.8.5 以前列表按「最近打开」排序：store.select() 一写打开时间，
 * 被点中的卡片就会在眼前挪到最前面（编辑正文改 modified 也会）。
 *
 * 4.8.6 起拆成两套规则：
 *   1. 列表排序：置顶 → 最近修改倒序 → id 字典序，
 *      打开 / 编辑都不会改变已在列表里的相对位置；
 *      侧栏另外在展开瞬间快照 id 顺序，保证一次展开期间完全稳定。
 *   2. 打开记录（microprompt.notesLastOpened）只服务「最近打开」
 *      分类，以及 4.8.5 的自动归档（灰度提示词）活跃度判定。
 * ============================================================ */

const LAST_OPENED_KEY = "microprompt.notesLastOpened";

/** 「最近打开」分类最多保留的条数 */
export const RECENT_LIMIT = 30;

export function isoMs(iso: string): number {
  const t = Date.parse((iso ?? "").replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}

export function loadLastOpened(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_OPENED_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v)) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLastOpened(map: Record<string, number>): void {
  try {
    localStorage.setItem(LAST_OPENED_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式等写不进去时忽略 */
  }
}

/**
 * 4.8.5：把某条笔记标记为「刚刚打开过」。
 * 自动归档（灰度提示词）按这份记录判活跃度，必须在 select 时就写入，
 * 否则刚打开的灰度笔记要等下一轮刷新才会被移回未分类。
 */
export function markNoteOpened(id: string): void {
  const map = loadLastOpened();
  map[id] = Date.now();
  saveLastOpened(map);
}

/**
 * 4.8.6：列表顺序 = 置顶 → 最近修改倒序 → id 字典序。
 * 第二个参数只为兼容旧调用保留（文件管理台仍会把 openedAt 传进来），
 * 排序本身不再读打开时间 —— 那是「最近打开」分类的事。
 */
export function sortNotes(
  notes: Note[],
  _openedAt?: Record<string, number>,
): Note[] {
  return [...notes].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return isoMs(b.modified) - isoMs(a.modified) || a.id.localeCompare(b.id);
  });
}

/**
 * 4.8.6：最近打开过的笔记 id（按最后打开时间倒序，最多 limit 条）。
 * 只认「还存在的笔记 + 有打开记录」：删掉的、从没打开过的一律不算。
 */
export function recentNoteIds(
  notes: Note[],
  openedAt: Record<string, number>,
  limit: number = RECENT_LIMIT,
): string[] {
  const alive = new Set(notes.map((n) => n.id));
  return Object.entries(openedAt)
    .filter(([id]) => alive.has(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
}
