import React from "react";
import { useStore } from "../store";
import { showToast } from "../utils/toast";
import * as backend from "../backend";
import type { Note } from "../types";
import {
  notePlainText,
  noteSummary,
  noteCharCount,
  noteExportText,
  refIdsOf,
  humanSize,
} from "../utils/noteText";
import { ConfirmDialog, InputDialog } from "./dialogs";
import FolderPicker from "./FolderPicker";
import StorageControls from "./StoragePanel";

/* ============================================================
 * 文件管理台（4.6.0 · FileManager）
 * ------------------------------------------------------------
 * 为什么要它：原来「展开笔记列表」里是一堆气泡卡片，笔记一多就
 * 既看不全也点不准。这里给一个接近整屏的管理面板，效率优先：
 *   · 左：智能分类（全部 / 置顶 / 时间 / 颜色），带实时数量
 *   · 中：紧凑列表（一行一条），搜索走标题 + 正文全文
 *   · 右：详情预览（时间 / 字数 / 纯文本正文）+ 一键进编辑器
 *   · 底：批量操作条 + 当前保存位置（打开 / 更改位置）
 * 交互：单击选中、Ctrl 多选、Shift 连选、双击进编辑器，
 *       ↑↓ 走位、回车打开、Delete 删除、Esc 关闭。
 * 原来的气泡卡片列表**保持不变**，仍在右下角按钮里展开。
 * ============================================================ */

type FilterKey =
  | "all"
  | "pinned"
  | "today"
  | "week"
  | "older"
  | "c0"
  | "c1"
  | "c2";

type SortKey = "modified" | "created" | "title" | "size";

const COLOR_NAMES = ["黑", "红", "蓝"];
const COLOR_DOTS = ["#2b2b2b", "#C0392B", "#4A90D9"];

const SORTS: { key: SortKey; name: string }[] = [
  { key: "modified", name: "最近修改" },
  { key: "created", name: "建立时间" },
  { key: "title", name: "标题" },
  { key: "size", name: "字数" },
];

/** 今天 0 点的时间戳 */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** ISO8601 本地字符串 → 毫秒（解析失败给 0） */
function isoMs(iso: string): number {
  const t = Date.parse(iso.replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}

export default function FileManager({ onClose }: { onClose: () => void }) {
  const notes = useStore((s) => s.notes);
  const refblocks = useStore((s) => s.refblocks);
  const currentId = useStore((s) => s.currentId);
  const select = useStore((s) => s.select);
  const createNote = useStore((s) => s.createNote);
  const rename = useStore((s) => s.rename);
  const setNotePinned = useStore((s) => s.setNotePinned);
  const setNotesPinned = useStore((s) => s.setNotesPinned);
  const setNotesColor = useStore((s) => s.setNotesColor);
  const removeNotes = useStore((s) => s.removeNotes);
  const storage = useStore((s) => s.storage);

  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [sort, setSort] = React.useState<SortKey>("modified");
  const [sel, setSel] = React.useState<string[]>([]);
  const [anchor, setAnchor] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<Note | null>(null);
  const [deleting, setDeleting] = React.useState<string[] | null>(null);
  const [exportOpen, setExportOpen] = React.useState(false);

  const searchRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  // 打开即聚焦搜索框：进来就能打字
  React.useEffect(() => {
    const id = window.setTimeout(() => searchRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, []);

  /* ---------------- 统计与筛选 ---------------- */
  const stats = React.useMemo(() => {
    const today = startOfToday();
    const s = { all: notes.length, pinned: 0, today: 0, week: 0, older: 0, c0: 0, c1: 0, c2: 0 };
    for (const n of notes) {
      if (n.pinned) s.pinned += 1;
      const m = isoMs(n.modified);
      if (m >= today) s.today += 1;
      else if (m >= today - 6 * 86400000) s.week += 1;
      else s.older += 1;
      const c = n.color === 1 ? "c1" : n.color === 2 ? "c2" : "c0";
      s[c as "c0" | "c1" | "c2"] += 1;
    }
    return s;
  }, [notes]);

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const today = startOfToday();
    let list = notes.filter((n) => {
      switch (filter) {
        case "pinned":
          if (!n.pinned) return false;
          break;
        case "today":
          if (isoMs(n.modified) < today) return false;
          break;
        case "week": {
          const m = isoMs(n.modified);
          if (m < today - 6 * 86400000 || m >= today) return false;
          break;
        }
        case "older":
          if (isoMs(n.modified) >= today - 6 * 86400000) return false;
          break;
        case "c0":
          if (n.color !== 0) return false;
          break;
        case "c1":
          if (n.color !== 1) return false;
          break;
        case "c2":
          if (n.color !== 2) return false;
          break;
        default:
          break;
      }
      if (!q) return true;
      if (n.title.toLowerCase().includes(q)) return true;
      return notePlainText(n, refblocks).toLowerCase().includes(q);
    });

    const cmp: Record<SortKey, (a: Note, b: Note) => number> = {
      modified: (a, b) => isoMs(b.modified) - isoMs(a.modified),
      created: (a, b) => isoMs(b.created) - isoMs(a.created),
      title: (a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"),
      size: (a, b) =>
        noteCharCount(b, refblocks) - noteCharCount(a, refblocks),
    };
    list = [...list].sort((a, b) => {
      // 置顶永远排最前，其余按所选排序
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return cmp[sort](a, b);
    });
    return list;
  }, [notes, refblocks, filter, query, sort]);

  // 选中项被过滤掉 / 删掉后自动收敛，避免出现"看不见的选中"
  React.useEffect(() => {
    const ids = new Set(rows.map((r) => r.id));
    setSel((prev) => {
      const next = prev.filter((id) => ids.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [rows]);

  const detail: Note | null = React.useMemo(() => {
    const id = sel.length > 0 ? sel[sel.length - 1] : anchor;
    if (!id) return rows[0] ?? null;
    return rows.find((r) => r.id === id) ?? rows[0] ?? null;
  }, [sel, anchor, rows]);

  /* ---------------- 交互 ---------------- */
  const clickRow = (e: React.MouseEvent, note: Note, index: number) => {
    if (e.shiftKey && anchor) {
      const ai = rows.findIndex((r) => r.id === anchor);
      if (ai >= 0) {
        const [lo, hi] = ai < index ? [ai, index] : [index, ai];
        setSel(rows.slice(lo, hi + 1).map((r) => r.id));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setAnchor(note.id);
      setSel((prev) =>
        prev.includes(note.id)
          ? prev.filter((id) => id !== note.id)
          : [...prev, note.id],
      );
      return;
    }
    setAnchor(note.id);
    setSel([note.id]);
  };

  const openInEditor = async (id: string) => {
    await select(id);
    onClose();
  };

  const moveCursor = (delta: number) => {
    if (rows.length === 0) return;
    const cur = detail ? rows.findIndex((r) => r.id === detail.id) : -1;
    const next = Math.max(0, Math.min(rows.length - 1, cur + delta));
    const n = rows[next];
    if (!n) return;
    setAnchor(n.id);
    setSel([n.id]);
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-note-id="${n.id}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  };

  const doDelete = async (ids: string[]) => {
    setDeleting(null);
    await removeNotes(ids);
    setSel((prev) => prev.filter((id) => !ids.includes(id)));
    showToast({
      text: ids.length > 1 ? `已删除 ${ids.length} 条笔记` : "已删除笔记",
      tone: "success",
    });
  };

  const doExport = async (dir: string) => {
    setExportOpen(false);
    const targets =
      sel.length > 0 ? rows.filter((r) => sel.includes(r.id)) : rows;
    if (targets.length === 0) {
      showToast({ text: "没有可导出的笔记", tone: "warn" });
      return;
    }
    try {
      const n = await backend.exportNotes(
        dir,
        targets.map((t) => ({
          name: (t.title || "未命名笔记").slice(0, 60),
          content: noteExportText(t, refblocks),
        })),
      );
      showToast({
        text: `已导出 ${n} 条笔记到 ${dir}`,
        tone: "success",
        duration: 3600,
      });
    } catch (e) {
      showToast({
        text: "导出失败：" + (e instanceof Error ? e.message : String(e)),
        tone: "error",
        duration: 4200,
      });
    }
  };

  /* ---------------- 键盘 ---------------- */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renaming || deleting || exportOpen) return; // 交给二级弹窗
      if (e.key === "Escape") {
        if (query) {
          setQuery("");
          return;
        }
        onClose();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Delete" && sel.length > 0) {
        setDeleting([...sel]);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (inInput) return;
        e.preventDefault();
        setSel(rows.map((r) => r.id));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setExportOpen(true);
        return;
      }
      if (e.key === "Enter" && detail && !e.shiftKey) {
        if (inInput && target !== searchRef.current) return;
        e.preventDefault();
        void openInEditor(detail.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    query,
    sel,
    rows,
    detail,
    renaming,
    deleting,
    exportOpen,
    onClose,
  ]);

  const RAIL: {
    group: string;
    items: { key: FilterKey; name: string; count: number; dot?: string }[];
  }[] = [
    {
      group: "全部笔记",
      items: [
        { key: "all", name: "全部", count: stats.all },
        { key: "pinned", name: "置顶", count: stats.pinned },
      ],
    },
    {
      group: "按时间",
      items: [
        { key: "today", name: "今天", count: stats.today },
        { key: "week", name: "最近 7 天", count: stats.week },
        { key: "older", name: "更早", count: stats.older },
      ],
    },
    {
      group: "按颜色",
      items: [
        { key: "c0", name: "黑色", count: stats.c0, dot: COLOR_DOTS[0] },
        { key: "c1", name: "红色", count: stats.c1, dot: COLOR_DOTS[1] },
        { key: "c2", name: "蓝色", count: stats.c2, dot: COLOR_DOTS[2] },
      ],
    },
  ];

  const detailText = detail ? notePlainText(detail, refblocks) : "";
  const detailChars = detail ? noteCharCount(detail, refblocks) : 0;
  const detailRefs = detail ? refIdsOf(detail.content).length : 0;

  const togglePinned = (ids: string[]) => {
    const target = notes.filter((n) => ids.includes(n.id));
    const allPinned = target.length > 0 && target.every((n) => n.pinned);
    setNotesPinned(ids, !allPinned);
  };

  return (
    <div
      className="dialog-overlay fm-overlay"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fm-panel">
        {/* ===== 顶栏 ===== */}
        <div className="fm-head">
          <span className="fm-head-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
              <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
            </svg>
          </span>
          <div className="fm-head-text">
            <div className="fm-title">文件管理</div>
            <div className="fm-sub">
              共 {stats.all} 条 · 置顶 {stats.pinned} 条 ·{" "}
              {storage ? `保存于 ${storage.isDefault ? "安装目录" : "自定义位置"}` : "读取位置…"}
            </div>
          </div>

          <div className="fm-search">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4.5 4.5" />
            </svg>
            <input
              ref={searchRef}
              value={query}
              placeholder="搜索标题和正文…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="fm-search-clear"
                title="清空"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>

          <div className="fm-sort">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              title="排序方式"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <button
            className="btn btn-sm btn-primary"
            onClick={() => void createNote()}
            title="新建一条笔记"
          >
            新建
          </button>
          <button className="fm-close" title="关闭（Esc）" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* ===== 主体：分类 | 列表 | 详情 ===== */}
        <div className="fm-body">
          <div className="fm-rail">
            {RAIL.map((g) => (
              <div className="fm-rail-group" key={g.group}>
                <div className="fm-rail-label">{g.group}</div>
                {g.items.map((it) => (
                  <button
                    key={it.key}
                    className={"fm-rail-item" + (filter === it.key ? " on" : "")}
                    onClick={() => setFilter(it.key)}
                  >
                    {it.dot ? (
                      <span
                        className="fm-rail-dot"
                        style={{ background: it.dot }}
                      />
                    ) : (
                      <span className="fm-rail-ico" aria-hidden="true">
                        {it.key === "pinned" ? "★" : "▤"}
                      </span>
                    )}
                    <span className="fm-rail-name">{it.name}</span>
                    <span className="fm-rail-count">{it.count}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="fm-list" ref={listRef} onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSel([]);
          }}>
            {rows.length === 0 && (
              <div className="fm-empty">
                {query ? "没有匹配的笔记" : "这里还没有笔记"}
              </div>
            )}
            {rows.map((n, i) => {
              const on = sel.includes(n.id);
              const isDetail = detail?.id === n.id;
              const chars = noteCharCount(n, refblocks);
              return (
                <div
                  key={n.id}
                  data-note-id={n.id}
                  className={
                    "fm-row" +
                    (on ? " on" : "") +
                    (isDetail ? " cur" : "") +
                    (n.id === currentId ? " editing" : "")
                  }
                  onClick={(e) => clickRow(e, n, i)}
                  onDoubleClick={() => void openInEditor(n.id)}
                  title="单击选中 · Ctrl 多选 · Shift 连选 · 双击在编辑器中打开"
                >
                  <span
                    className="fm-row-dot"
                    style={{ background: COLOR_DOTS[n.color] ?? COLOR_DOTS[0] }}
                  />
                  <span className="fm-row-main">
                    <span className="fm-row-title">
                      {n.pinned && <span className="fm-row-pin">★</span>}
                      {n.title || "未命名笔记"}
                    </span>
                    <span className="fm-row-sum">
                      {noteSummary(n, refblocks, 64) || "（空笔记）"}
                    </span>
                  </span>
                  <span className="fm-row-meta">
                    <span className="fm-row-time">
                      {n.modified.slice(5, 16).replace("T", " ")}
                    </span>
                    <span className="fm-row-chars">{chars} 字</span>
                  </span>
                  <span className="fm-row-acts">
                    <button
                      className="fm-act"
                      title={n.pinned ? "取消置顶" : "置顶"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setNotePinned(n.id, !n.pinned);
                      }}
                    >
                      {n.pinned ? "★" : "☆"}
                    </button>
                    <button
                      className="fm-act fm-act-danger"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleting([n.id]);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12" />
                      </svg>
                    </button>
                  </span>
                </div>
              );
            })}
          </div>

          <div className="fm-detail">
            {detail ? (
              <>
                <div className="fm-detail-title" title={detail.title}>
                  {detail.title || "未命名笔记"}
                </div>
                <div className="fm-detail-tags">
                  <span
                    className="fm-tag"
                    style={{ color: COLOR_DOTS[detail.color] ?? COLOR_DOTS[0] }}
                  >
                    ● {COLOR_NAMES[detail.color] ?? "黑"}
                  </span>
                  <span className="fm-tag">
                    {detail.background === 1 ? "纸张黄" : "纯白"}
                  </span>
                  {detail.pinned && <span className="fm-tag fm-tag-pin">★ 置顶</span>}
                  {detail.id === currentId && (
                    <span className="fm-tag fm-tag-cur">正在编辑</span>
                  )}
                </div>
                <div className="fm-detail-meta">
                  <div>
                    <span>建立</span>
                    {detail.created.slice(0, 16).replace("T", " ")}
                  </div>
                  <div>
                    <span>修改</span>
                    {detail.modified.slice(0, 16).replace("T", " ")}
                  </div>
                  <div>
                    <span>字数</span>
                    {detailChars} 字
                  </div>
                  <div>
                    <span>代码块</span>
                    {detailRefs} 个
                  </div>
                </div>
                <div className="fm-detail-preview">
                  {detailText ? detailText.slice(0, 4000) : "（空笔记）"}
                </div>
                <div className="fm-detail-acts">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void openInEditor(detail.id)}
                  >
                    在编辑器中打开
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setRenaming(detail)}
                  >
                    重命名
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => togglePinned([detail.id])}
                  >
                    {detail.pinned ? "取消置顶" : "置顶"}
                  </button>
                </div>
              </>
            ) : (
              <div className="fm-empty">选中一条笔记查看详情</div>
            )}
          </div>
        </div>

        {/* ===== 底部：批量操作 + 保存位置 ===== */}
        <div className="fm-foot">
          <div className="fm-batch">
            {sel.length > 0 ? (
              <>
                <span className="fm-batch-count">已选 {sel.length} 项</span>
                <button
                  className="btn btn-sm"
                  onClick={() => togglePinned(sel)}
                >
                  置顶 / 取消置顶
                </button>
                <span className="fm-batch-colors" title="批量改颜色">
                  {COLOR_DOTS.map((c, i) => (
                    <button
                      key={c}
                      className="fm-color-dot"
                      style={{ background: c }}
                      title={COLOR_NAMES[i]}
                      onClick={() => setNotesColor(sel, i)}
                    />
                  ))}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => setExportOpen(true)}
                  title="导出为 txt（Ctrl+E）"
                >
                  导出
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => setDeleting([...sel])}
                >
                  删除
                </button>
                <button className="btn btn-sm" onClick={() => setSel([])}>
                  取消选择
                </button>
              </>
            ) : (
              <span className="fm-batch-hint">
                {rows.length > 0
                  ? "↑↓ 走位 · 回车打开 · Ctrl 多选 · Ctrl+A 全选 · Ctrl+E 导出"
                  : "点右上角「新建」建一条笔记"}
              </span>
            )}
          </div>
          <div className="fm-foot-right">
            <span className="fm-foot-size">
              {storage ? humanSize(storage.totalBytes) : ""}
            </span>
            <StorageControls variant="bar" />
          </div>
        </div>
      </div>

      {/* ===== 二级弹窗 ===== */}
      {renaming && (
        <InputDialog
          title="重命名笔记"
          initial={renaming.title}
          onConfirm={(v) => {
            rename(renaming.id, v);
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={deleting.length > 1 ? `删除 ${deleting.length} 条笔记` : "删除笔记"}
          message={
            deleting.length > 1
              ? `确定要删除选中的 ${deleting.length} 条笔记吗？该操作不可恢复。`
              : `确定要删除笔记「${
                  notes.find((n) => n.id === deleting[0])?.title ?? ""
                }」吗？该操作不可恢复。`
          }
          confirmText="删除"
          danger
          onConfirm={() => void doDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
      {exportOpen && (
        <FolderPicker
          title="导出到哪个文件夹"
          startPath={storage?.dir}
          confirmText="导出到这里"
          hint={
            sel.length > 0
              ? `将导出选中的 ${sel.length} 条笔记（txt）`
              : `将导出当前列表里的 ${rows.length} 条笔记（txt）`
          }
          onCancel={() => setExportOpen(false)}
          onConfirm={(dir) => void doExport(dir)}
        />
      )}
    </div>
  );
}
