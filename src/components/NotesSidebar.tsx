import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "../store";
import type { Note } from "../types";
import {
  isoMs,
  loadLastOpened,
  markNoteOpened,
  sortNotes,
} from "../utils/noteOrder";
import { notePlainText } from "../utils/noteText";
import { GRAY_CATEGORY, normalizeCategoryName } from "../utils/noteCategories";
import { ConfirmDialog, InputDialog } from "./dialogs";
import { ContextMenu } from "./context-menu";
import UpdateButton from "./UpdateButton";
import {
  CollapseIco,
  COLOR_DOTS,
  FolderIco,
  NoteCard,
  NoteIco,
  PlusIco,
  SearchIco,
  Svg,
  noteMenuItems,
} from "./NoteCard";

/* ============================================================
 * 右侧笔记侧栏（4.8.6 · NotesSidebar；4.8.7 过滤灰度提示词）
 * ------------------------------------------------------------
 * 展开后自上而下（4.8.6 精简：不再有分类导航；4.8.7 起也不显示
 * 「灰度提示词」里的笔记 —— 那些只在文件管理台里可见）：
 *
 *   ns-head          「笔记」标题 + 条数 + 搜索框
 *   ns-recent-slot   「最近打开」快捷卡片（固定在列表上方，滚列表也看得见；
 *                     只显示最近打开的 2 篇，点它打开，原卡片位置不动）
 *   ns-grid          笔记卡片墙（唯一的主滚动区，固定 2 列）
 *   ns-toolbar       底部悬浮工具栏（外观与编辑区工具栏完全一致）
 *
 * 顺序稳定（4.8.6 修 bug）：
 *   · 列表基础排序 = 置顶 → 最近修改倒序 → id，打开笔记不再重排；
 *   · 每次展开侧栏再快照一次 id 顺序，本次展开期间点的、编辑的笔记
 *     都不会离开原位置；新笔记插到最前。
 *
 * 交互：单击打开 · 悬停「置顶 / 更多」 · 右键同一套菜单（含移动合集）
 *       搜索（标题 + 正文）· ↑↓←→ 走位 · 回车打开
 *       删除键删除 · Esc 收起 · Ctrl+Shift+B 开合 · / 聚焦搜索
 *       新建笔记 → 先弹「命名笔记」输入框，确认后才落库
 * ============================================================ */

const NARROW_MQ = "(max-width: 860px)";
/** 卡片墙固定两列 —— 键盘走位也按这个列数跳（管理台按实际列数） */
const COLUMNS = 2;

/* ---------------- 窄窗判断 ---------------- */

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(NARROW_MQ).matches;
  });
  useEffect(() => {
    const mq = window.matchMedia(NARROW_MQ);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/** 「最近打开」用的时钟图标 */
function ClockIco({ size = 12 }: { size?: number }) {
  return (
    <Svg size={size} strokeWidth={1.8}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.2 1.9" />
    </Svg>
  );
}

/* ============================================================
 * 侧栏主体
 * ============================================================ */

export default function NotesSidebar({ open }: { open: boolean }) {
  const notes = useStore((s) => s.notes);
  const refblocks = useStore((s) => s.refblocks);
  const currentId = useStore((s) => s.currentId);
  const showTime = useStore((s) => s.showNoteTime);
  const eyeCare = useStore((s) => s.eyeCareMode);
  const select = useStore((s) => s.select);
  const createNote = useStore((s) => s.createNote);
  const rename = useStore((s) => s.rename);
  const setColor = useStore((s) => s.setColor);
  const setNotePinned = useStore((s) => s.setNotePinned);
  const removeNote = useStore((s) => s.removeNote);
  const noteCategories = useStore((s) => s.noteCategories);
  const setNoteCategory = useStore((s) => s.setNoteCategory);
  const openNotesManager = useStore((s) => s.openNotesManager);
  const closeSidebar = useStore((s) => s.closeNotesSidebar);
  const notesManagerOpen = useStore((s) => s.notesManagerOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const memberOpen = useStore((s) => s.memberOpen);

  const narrow = useNarrow();

  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [openedAt, setOpenedAt] = useState<Record<string, number>>(loadLastOpened);
  /** 展开瞬间快照的 id 顺序：一次展开期间卡片绝不跳位 */
  const [orderIds, setOrderIds] = useState<string[]>(() =>
    sortNotes(useStore.getState().notes).map((n) => n.id),
  );
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  /** 新建笔记：先弹命名输入框，确认后再真正创建 */
  const [creating, setCreating] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  /** 只有「刚展开」那一小段时间播放卡片入场动画，避免点击打开后回弹时又重播一次 */
  const [entering, setEntering] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const launchTimer = useRef<number | null>(null);

  /* ---------------- 展开 / 收起 ---------------- */

  useEffect(() => {
    if (!open) {
      setEntering(false);
      return;
    }
    setEntering(true);
    const id = window.setTimeout(() => setEntering(false), 620);
    // 每次展开重新快照一次顺序 + 刷新打开记录（关着的时候可能刚打开过别的笔记）
    const st = useStore.getState();
    setOrderIds(sortNotes(st.notes).map((n) => n.id));
    setOpenedAt(loadLastOpened());
    return () => window.clearTimeout(id);
  }, [open]);

  /* 打开记录：store.select() 已经写了一条，这里补写「当前笔记」（点的是当前笔记时
     select() 会提前返回），并让列表顶部那张「最近打开」快捷卡片立刻换成它。
     注意必须「读-改-写」最新记录，不能用挂载时的旧快照覆盖。 */
  useEffect(() => {
    if (!currentId) return;
    markNoteOpened(currentId);
    setOpenedAt(loadLastOpened());
  }, [currentId]);

  /* store 的笔记是异步加载的：首次挂载时可能还是空数组，等数据到了再补一次快照 */
  useEffect(() => {
    if (!open || orderIds.length > 0 || notes.length === 0) return;
    setOrderIds(sortNotes(notes).map((n) => n.id));
  }, [open, notes, orderIds.length]);

  /* 搜索防抖：打字时不卡，停一下再全量扫正文 */
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setApplied("");
      return;
    }
    const t = window.setTimeout(() => setApplied(q), 130);
    return () => window.clearTimeout(t);
  }, [query]);

  /* 搜索时才建全文索引（平时一次都不做） */
  const searchText = useMemo(() => {
    if (!applied) return null;
    const map = new Map<string, string>();
    for (const n of notes) map.set(n.id, notePlainText(n, refblocks));
    return map;
  }, [applied, notes, refblocks]);

  /* ---------------- 「最近打开」 ---------------- */

  /** 列表上方固定显示「最近打开」的最近 **2 篇**（按最后打开时间倒序）。
   *  它不是分类 —— 点开过的笔记在下面原位不动，这里只是快捷入口。 */
  const RECENT_SHORTCUT_COUNT = 2;
  /** 最近打开：跳过「灰度提示词」里的笔记 —— 它们不在侧栏列表里，
   *  这里若还能点开就成了侧栏的隐藏入口，与「灰度只在文件管理台可见」冲突。 */
  const recentShortcuts = useMemo<Note[]>(() => {
    const entries = Object.entries(openedAt).filter(([, t]) => t > 0);
    if (entries.length === 0) return [];
    entries.sort((a, b) => b[1] - a[1]);
    const byId = new Map(notes.map((n) => [n.id, n]));
    const out: Note[] = [];
    for (const [id] of entries) {
      const n = byId.get(id);
      if (!n || out.some((x) => x.id === n.id)) continue;
      if (normalizeCategoryName(n.category ?? "") === GRAY_CATEGORY) continue;
      out.push(n);
      if (out.length >= RECENT_SHORTCUT_COUNT) break;
    }
    return out;
  }, [notes, openedAt]);

  /* ---------------- 顺序 ---------------- */

  /** 侧栏列表 = 全部笔记 **去掉「灰度提示词」**（4.8.7 按用户要求）：
   *  灰度笔记是系统自动归档的旧笔记，只在文件管理台里查看 / 管理，
   *  不占用侧栏卡片墙，也不进「最近打开」和搜索。 */
  const filteredNotes = useMemo(
    () =>
      notes.filter(
        (n) => normalizeCategoryName(n.category ?? "") !== GRAY_CATEGORY,
      ),
    [notes],
  );

  /** 只有灰度笔记、没有普通笔记时的空态文案 */
  const onlyGray = notes.length > 0 && filteredNotes.length === 0;

  /** 命中搜索词的笔记，再按快照顺序排好 */
  const visibleNotes = useMemo<Note[]>(() => {
    const base = searchText
      ? filteredNotes.filter(
          (n) =>
            n.title.toLowerCase().includes(applied) ||
            (searchText.get(n.id) ?? "").toLowerCase().includes(applied),
        )
      : filteredNotes;
    // 一次展开期间用顺序快照：打开 / 点开笔记都不重排，卡片不跳位
    const pos = new Map<string, number>();
    orderIds.forEach((id, i) => pos.set(id, i));
    return [...base].sort((a, b) => {
      const pa = pos.get(a.id);
      const pb = pos.get(b.id);
      // 快照之后新建的笔记没有位置：排在最前，多条之间按修改时间倒序
      if (pa === undefined && pb === undefined) {
        return isoMs(b.modified) - isoMs(a.modified) || a.id.localeCompare(b.id);
      }
      if (pa === undefined) return -1;
      if (pb === undefined) return 1;
      return pa - pb;
    });
  }, [filteredNotes, searchText, applied, orderIds]);

  /* ---------------- 打开 / 关闭时的收尾 ---------------- */

  useEffect(() => {
    if (open) {
      const id = useStore.getState().currentId;
      if (id) setCursorId(id);
      return;
    }
    // 浮层一关，弹出的菜单 / 对话框立即消失，不留在屏幕上“悬空”340ms
    setMenu(null);
    setRenaming(null);
    setDeleting(null);
    setCreating(false);
    const t = window.setTimeout(() => {
      setQuery("");
      setApplied("");
      setCursorId(null);
    }, 340);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (open && currentId) setCursorId(currentId);
  }, [open, currentId]);

  /* 搜索后键盘光标要落在结果里；没搜索时回到当前笔记 */
  useEffect(() => {
    if (!open) return;
    if (!applied) {
      if (cursorId && visibleNotes.some((n) => n.id === cursorId)) return;
      const target =
        visibleNotes.find((n) => n.id === currentId) ?? visibleNotes[0];
      setCursorId(target ? target.id : null);
      return;
    }
    if (visibleNotes.length === 0) {
      setCursorId(null);
      return;
    }
    if (cursorId && visibleNotes.some((n) => n.id === cursorId)) return;
    setCursorId(visibleNotes[0].id);
  }, [open, applied, currentId, visibleNotes, cursorId]);

  /* 打开侧栏时回到卡片墙顶部 */
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = 0;
  }, [open]);

  /* 打开侧栏 / 切换笔记时，把当前那张卡片滚进视野 */
  useEffect(() => {
    if (!open || !currentId) return;
    const t = window.setTimeout(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-note-id="${currentId}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, 360);
    return () => window.clearTimeout(t);
  }, [open, currentId]);

  useEffect(
    () => () => {
      if (launchTimer.current !== null) window.clearTimeout(launchTimer.current);
    },
    [],
  );

  /* ---------------- 操作 ---------------- */

  const openNote = useCallback(
    (id: string) => {
      // 从搜索框点结果时把焦点交回卡片墙，随后方向键能继续走位
      if (document.activeElement === searchRef.current) {
        searchRef.current?.blur();
      }
      setCursorId(id);
      setLaunchingId(id);
      if (launchTimer.current !== null) window.clearTimeout(launchTimer.current);
      launchTimer.current = window.setTimeout(() => setLaunchingId(null), 260);
      // 点击即记「最近打开」：列表顶部那张快捷卡片立刻换成它；
      // 下面原卡片仍停原位置（顺序走展开快照，不重排）。
      markNoteOpened(id);
      setOpenedAt(loadLastOpened());
      void select(id);
      if (narrow) closeSidebar();
    },
    [select, narrow, closeSidebar],
  );

  const moveCursor = useCallback(
    (delta: number) => {
      if (visibleNotes.length === 0) return;
      const cur = visibleNotes.findIndex((n) => n.id === cursorId);
      const next =
        cur < 0
          ? delta > 0
            ? 0
            : visibleNotes.length - 1
          : Math.max(0, Math.min(visibleNotes.length - 1, cur + delta));
      const n = visibleNotes[next];
      if (!n) return;
      setCursorId(n.id);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-note-id="${n.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [visibleNotes, cursorId],
  );

  const openMenu = useCallback((e: React.MouseEvent, note: Note) => {
    e.preventDefault();
    e.stopPropagation();
    setCursorId(note.id);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // 右键用鼠标坐标；「更多」按钮用按钮右下角，菜单仍会自动翻转
    const fromButton = (e.currentTarget as HTMLElement).closest(".ns-act");
    setMenu({
      x: fromButton ? r.right : e.clientX,
      y: fromButton ? r.bottom + 4 : e.clientY,
      id: note.id,
    });
  }, []);

  /** 点「新建笔记」：先弹命名框，标题确认后才创建 */
  const newNote = useCallback(() => {
    setQuery("");
    setApplied("");
    setCreating(true);
  }, []);

  const confirmCreate = useCallback(
    (title: string) => {
      setCreating(false);
      void createNote(title).then(() => {
        if (narrow) closeSidebar();
      });
    },
    [createNote, narrow, closeSidebar],
  );

  const clearSearch = useCallback(() => {
    setQuery("");
    setApplied("");
    searchRef.current?.focus();
  }, []);

  /* ---------------- 键盘 ---------------- */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // 文件管理台 / 设置 / 会员弹窗在上层时，Esc 等按键归它们，不要穿透到侧栏
      if (notesManagerOpen || settingsOpen || memberOpen) return;
      const t = e.target as HTMLElement | null;
      const inField = !!t?.closest?.(
        "input, textarea, select, [contenteditable='true']",
      );

      if (e.key === "Escape") {
        if (menu) {
          setMenu(null);
          return;
        }
        // 交给二级弹窗
        if (renaming || deleting || creating) return;
        if (t === searchRef.current) {
          if (query) {
            setQuery("");
            setApplied("");
            return;
          }
          searchRef.current?.blur();
          return;
        }
        if (inField) return; // 编辑器 / 其它输入框里的 Esc 不动侧栏
        closeSidebar();
        return;
      }

      if (renaming || deleting || creating || menu) return;
      if (inField) return;

      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // 菜单键 / Shift+F10：用键盘打开光标卡片的同一套菜单（置顶 / 重命名 / 改色 / 删除）
      if (
        cursorId &&
        (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
      ) {
        e.preventDefault();
        const row = listRef.current?.querySelector<HTMLElement>(
          `[data-note-id="${cursorId}"]`,
        );
        const r = row?.getBoundingClientRect();
        setMenu({
          x: r ? r.right - 8 : 240,
          y: r ? r.bottom - 6 : 220,
          id: cursorId,
        });
        return;
      }
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight"
      ) {
        e.preventDefault();
        const delta =
          e.key === "ArrowDown"
            ? COLUMNS
            : e.key === "ArrowUp"
              ? -COLUMNS
              : e.key === "ArrowRight"
                ? 1
                : -1;
        moveCursor(delta);
        return;
      }
      if (e.key === "Enter" && cursorId) {
        e.preventDefault();
        openNote(cursorId);
        return;
      }
      if (e.key === "Delete" && cursorId) {
        const n = notes.find((x) => x.id === cursorId);
        if (n) setDeleting(n);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    open,
    menu,
    renaming,
    deleting,
    creating,
    query,
    cursorId,
    notes,
    notesManagerOpen,
    settingsOpen,
    memberOpen,
    moveCursor,
    openNote,
    closeSidebar,
  ]);

  /* ---------------- 右键菜单 ---------------- */
  const menuNote = menu ? notes.find((n) => n.id === menu.id) : null;

  const pinOne = useCallback(
    (note: Note) => setNotePinned(note.id, !note.pinned),
    [setNotePinned],
  );

  const menuItems = menuNote
    ? noteMenuItems(menuNote, {
        onOpen: (n) => openNote(n.id),
        onRename: (n) => setRenaming(n),
        onPin: pinOne,
        onColor: (id, color) => setColor(id, color),
        onDelete: (n) => setDeleting(n),
        // 4.8.6：右键也能把笔记移动到「我的合集」里的任意分类
        categories: noteCategories,
        onCategory: (id, category) => setNoteCategory(id, category),
      })
    : [];

  const doDelete = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    await removeNote(id);
  };

  const countText = applied
    ? `${visibleNotes.length}/${filteredNotes.length}`
    : String(filteredNotes.length);

  return (
    <div
      className={
        "sb-slot notes-sidebar" +
        (open ? " open" : "") +
        (showTime ? "" : " ns-no-time") +
        (eyeCare ? " ns-paper" : "")
      }
      aria-hidden={!open}
      inert={!open}
    >
      <aside className="ns-panel" aria-label="笔记列表">
        {/* ===== 头部：标题 + 条数 + 搜索 ===== */}
        <div className="ns-head">
          <span className="ns-head-name">笔记</span>
          <span
            className="ns-count"
            title={`笔记列表 · 共 ${filteredNotes.length} 条（「灰度提示词」只在文件管理台显示）`}
          >
            {countText}
          </span>
          <div
            className="ns-search"
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              e.preventDefault();
              searchRef.current?.focus();
            }}
          >
            <span className="ns-search-ico">
              <SearchIco size={13} />
            </span>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索笔记…"
              aria-label="搜索笔记"
              spellCheck={false}
            />
            {query ? (
              <button
                className="ns-search-clear"
                title="清空搜索"
                onClick={clearSearch}
              >
                <Svg size={11} strokeWidth={2.2}>
                  <path d="M6 6l12 12M18 6L6 18" />
                </Svg>
              </button>
            ) : (
              <span className="ns-search-key">/</span>
            )}
          </div>
        </div>

        {/* 「最近打开」快捷入口：固定显示最近打开的 **2 篇**，在卡片墙上方、滚动区外，
            滚列表也一直看得见。它不是分类 —— 点开过的笔记在下面原位不动；
            搜索时隐藏，避免和搜索结果混在一起。 */}
        {!applied && recentShortcuts.length > 0 && (
          <div
            className="ns-recent-list"
            data-recent-count={recentShortcuts.length}
            role="group"
            aria-label="最近打开"
          >
            <div className="ns-recent-head">
              <ClockIco size={11} />
              <span>最近打开</span>
            </div>
            {recentShortcuts.map((n, i) => (
              <button
                key={n.id}
                type="button"
                className={
                  "ns-recent-slot" +
                  (n.id === currentId ? " is-current" : "") +
                  (n.id === launchingId ? " is-launching" : "")
                }
                data-recent-note={n.id}
                data-recent-index={i}
                title={`最近打开（第 ${i + 1} 篇）：${n.title}（点它打开；下面原卡片仍在原位置）`}
                onClick={() => openNote(n.id)}
              >
                <span
                  className="ns-recent-slot-dot"
                  style={{ background: COLOR_DOTS[n.color] ?? COLOR_DOTS[0] }}
                  aria-hidden="true"
                />
                <span className="ns-recent-slot-title">{n.title}</span>
                <span className="ns-recent-slot-index" aria-hidden="true">
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ===== 卡片墙：一行 2 个，向下延伸 ===== */}
        <div
          className={"ns-grid" + (entering ? " ns-entering" : "")}
          ref={listRef}
          tabIndex={-1}
          role={visibleNotes.length ? "list" : undefined}
          aria-label="全部笔记 · 笔记卡片"
        >
          {visibleNotes.map((n, i) => (
            <NoteCard
              key={n.id}
              note={n}
              selected={n.id === currentId}
              cursor={n.id === cursorId}
              query={applied}
              showTime={showTime}
              index={i}
              launching={n.id === launchingId}
              onOpen={openNote}
              onMenu={openMenu}
              onPin={pinOne}
            />
          ))}

          {visibleNotes.length === 0 && (
            <div className="ns-empty">
              {applied ? (
                <>
                  <div className="ns-empty-art is-search">
                    <SearchIco size={22} />
                  </div>
                  <div className="ns-empty-title">没有找到相关笔记</div>
                  <div className="ns-empty-sub">
                    换个关键词试试，标题和正文都能搜
                  </div>
                  <button className="ns-empty-btn ghost" onClick={clearSearch}>
                    清空搜索
                  </button>
                </>
              ) : onlyGray ? (
                <>
                  <div className="ns-empty-art">
                    <FolderIco size={26} />
                  </div>
                  <div className="ns-empty-title">笔记都在「灰度提示词」里</div>
                  <div className="ns-empty-sub">
                    超过 15 天没有打开的笔记会自动归档，只在这里看到；到文件管理台的「合集 › 灰度提示词」里查看
                  </div>
                  <button className="ns-empty-btn" onClick={openNotesManager}>
                    <FolderIco size={13} /> 打开文件管理台
                  </button>
                </>
              ) : (
                <>
                  <div className="ns-empty-art">
                    <NoteIco size={26} />
                  </div>
                  <div className="ns-empty-title">还没有笔记</div>
                  <div className="ns-empty-sub">写下第一条，它会出现在这里</div>
                  <button className="ns-empty-btn" onClick={newNote}>
                    <PlusIco size={13} /> 新建笔记
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* ===== 底部悬浮工具栏：外观与编辑界面工具栏完全一致 ===== */}
        <div className="ns-toolbar" role="toolbar" aria-label="笔记操作">
          <UpdateButton />
          <button
            type="button"
            className="tool-btn"
            title="新建笔记"
            aria-label="新建笔记"
            onClick={newNote}
          >
            <PlusIco size={18} />
          </button>
          <div className="tool-vline" />
          <button
            type="button"
            className="tool-btn"
            title="文件管理台（Ctrl+K）：分类、搜索、整屏卡片墙"
            aria-label="管理"
            onClick={openNotesManager}
          >
            <FolderIco size={18} />
          </button>
          <div className="tool-vline" />
          <button
            type="button"
            className="tool-btn"
            title="收起笔记侧栏（Ctrl+Shift+B）"
            aria-label="收起笔记侧栏"
            onClick={closeSidebar}
          >
            <CollapseIco size={18} />
          </button>
        </div>
      </aside>

      {/* ===== 二级弹窗 / 菜单 ===== */}
      {menu && menuNote && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
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
      {creating && (
        <InputDialog
          title="新建笔记"
          initial="新建笔记"
          placeholder="给笔记起个名字"
          onConfirm={confirmCreate}
          onCancel={() => setCreating(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除笔记"
          message={`确定要删除笔记「${deleting.title || "未命名笔记"}」吗？该操作不可恢复。`}
          confirmText="删除"
          danger
          onConfirm={() => void doDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
