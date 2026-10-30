import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { Note } from "../types";
import { notePlainText } from "../utils/noteText";
import {
  isoMs,
  loadLastOpened,
  sortNotes,
} from "../utils/noteOrder";
import { GRAY_CATEGORY, normalizeCategoryName } from "../utils/noteCategories";
import { ConfirmDialog, InputDialog } from "./dialogs";
import { ContextMenu } from "./context-menu";
import {
  CloseIco,
  CollapseIco,
  COLOR_DOTS,
  FolderIco,
  NoteCard,
  PlusIco,
  SearchIco,
  Svg,
  noteMenuItems,
} from "./NoteCard";

/* ============================================================
 * 文件管理台（4.8.3 · FileManager；4.8.5 增加「合集」与我的分类；
 * 4.8.7 左栏按用户要求重排）
 * ------------------------------------------------------------
 * 从侧栏底部「管理」或 Ctrl/Cmd + K 打开：与侧栏卡片做「同一张卡连续滑动」——
 * 打开瞬间记录侧栏里可见卡片的位置，把管理台的同一批卡片先摆回侧栏位置，
 * 再用 480ms 曲线滑到各自的新格子（FLIP），所以看起来是侧栏那几张卡
 * 「铺开」成整屏，而不是淡出再淡入。收起时面板缩回侧栏宽度（300ms）。
 *
 * 结构是一整页（避开 42px 顶栏里的头像与窗口按钮，其余完全铺满）：
 *   · 左：4.8.7 起固定三组 ——
 *       【全部笔记】 全部 / 置顶 / 今天
 *       【按颜色】   黑色 / 蓝色 / 红色
 *       【我的合集】 未分类合集 / 每个用户合集 / ＋新建分类合集
 *     「灰度提示词」不再占左栏入口：它是系统自动归档区，
 *     侧栏列表里完全不显示，只在管理台的「合集」抽屉里有一个文件夹；
 *   · 右：与笔记侧栏同一套「卡片墙」，只是铺满全屏后每行卡片更多。
 *
 * 4.8.5 新增两件事：
 *   1) 我的分类：用户自选分类 + 系统自动分类「灰度提示词」（超过 15 天
 *      没有打开的笔记自动移入，重新活跃 / 置顶后自动移回未分类）；
 *   2) 合集：手机应用抽屉式的文件管理总览 —— 一面文件夹网格，点开某个
 *      文件夹就进入按该分类过滤的卡片墙，头部用「‹ 合集」返回。
 *
 * 交互：单击卡片 = 打开笔记（管理台收回侧栏尺寸，交给编辑器）
 *       悬停 / 右键 = 置顶 / 更多（重命名 / 改色 / 移动分类 / 删除）
 *       搜索（标题 + 正文）· ↑↓←→ 走位 · 回车打开 · Delete 删除
 *       Esc 退出 · Ctrl/Cmd + K 退出 · / 聚焦搜索
 * ============================================================ */

type FilterKey =
  | "all"
  | "pinned"
  | "today"
  | "c0"
  | "c1"
  | "c2"
  | "uncategorized"
  | "gray"
  | `cat:${string}`;

type CategoryFilterKey = `cat:${string}`;

type RailItem = {
  key: FilterKey;
  name: string;
  count: number;
  dot?: string;
  /** 系统自动分类（灰度提示词）：显示「自动」小标记 */
  auto?: boolean;
  title?: string;
};

type RailGroup = {
  group: string;
  items: RailItem[];
};

/** 合集总览里的一张文件夹卡片：data-category = all / pinned / uncategorized / gray / 分类名 */
type FolderItem = {
  category: string;
  name: string;
  count: number;
  auto?: boolean;
  title?: string;
};

type ViewMode = "wall" | "collections";

/** 今天 0 点的时间戳 */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 分类名 → FilterKey；默认分类用固定键，用户分类用 cat: 前缀 */
function categoryFilter(name: string): CategoryFilterKey {
  return `cat:${name}`;
}

/** 合集里的 data-category → 过滤键 */
function folderToFilter(category: string): FilterKey {
  switch (category) {
    case "all":
    case "pinned":
    case "uncategorized":
    case "gray":
      return category;
    default:
      return categoryFilter(category);
  }
}

/**
 * 收起动画时长：CSS 里「面板收回右边缘 0.34s」+「内容淡出 0.22s（delay 0.02s）」，
 * 0.34s 时可见宽度已经为 0；卸载再晚 40ms，保证最后一帧屏幕上没有管理台。
 */
const CLOSE_MS = 380;

/* ---------------- 4.8.5 新增细图标（内联 SVG，stroke 风格，跟 currentColor） ---------------- */

/** 合集：四宫格（手机应用抽屉） */
const DrawerIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 13} strokeWidth={1.7}>
    <rect x="4" y="4" width="6.6" height="6.6" rx="1.9" />
    <rect x="13.4" y="4" width="6.6" height="6.6" rx="1.9" />
    <rect x="4" y="13.4" width="6.6" height="6.6" rx="1.9" />
    <rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.9" />
  </Svg>
);

/** 返回合集 */
const BackIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 13} strokeWidth={2}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Svg>
);

export default function FileManager({ onClose }: { onClose: () => void }) {
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
  const addNoteCategory = useStore((s) => s.addNoteCategory);
  const setNoteCategory = useStore((s) => s.setNoteCategory);

  /* 视图：卡片墙 / 合集总览（手机应用抽屉） */
  const [view, setView] = useState<ViewMode>("wall");
  /** 是否从合集文件夹进入卡片墙：决定头部是否出现「‹ 合集」返回按钮 */
  const [fromCollections, setFromCollections] = useState(false);
  /** 回到合集时用反向动画（与进入分类的淡入上浮成对） */
  const [drawerBack, setDrawerBack] = useState(false);

  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [cursorId, setCursorId] = useState<string | null>(currentId);
  const [openedAt] = useState<Record<string, number>>(loadLastOpened);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const [creating, setCreating] = useState(false);
  /** 4.8.5：新建分类弹窗；记录入口，rail 建完直接进分类，合集建完留在抽屉 */
  const [newCategoryFrom, setNewCategoryFrom] = useState<
    null | "drawer" | "rail"
  >(null);
  /** 刚建好的分类：合集里短暂高亮，方便用户看到它 */
  const [freshCategory, setFreshCategory] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const launchTimer = useRef<number | null>(null);
  const freshTimer = useRef<number | null>(null);

  // 打开即聚焦搜索框：进来就能打字
  useEffect(() => {
    const id = window.setTimeout(() => searchRef.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, []);

  // 搜索防抖 130ms（与侧栏一致），避免每敲一个字都全文扫一遍
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(rawQuery), 130);
    return () => window.clearTimeout(id);
  }, [rawQuery]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (launchTimer.current !== null) window.clearTimeout(launchTimer.current);
      if (freshTimer.current !== null) window.clearTimeout(freshTimer.current);
    },
    [],
  );

  /* ---------------- 统计与筛选 ---------------- */
  const stats = useMemo(() => {
    const today = startOfToday();
    const s = {
      all: notes.length,
      pinned: 0,
      today: 0,
      c0: 0,
      c1: 0,
      c2: 0,
    };
    for (const n of notes) {
      if (n.pinned) s.pinned += 1;
      if (isoMs(n.modified) >= today) s.today += 1;
      const c = n.color === 1 ? "c1" : n.color === 2 ? "c2" : "c0";
      s[c as "c0" | "c1" | "c2"] += 1;
    }
    return s;
  }, [notes]);

  /** 4.8.5：按分类统计（未分类单列；灰度提示词走同一张表） */
  const categoryStats = useMemo(() => {
    const counts = new Map<string, number>();
    let uncategorized = 0;
    for (const n of notes) {
      const name = normalizeCategoryName(n.category ?? "");
      if (!name) {
        uncategorized += 1;
        continue;
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return { counts, uncategorized };
  }, [notes]);

  /** 用户分类：以 store 列表为准，再补上笔记里出现但还没登记的名字 */
  const categoryNames = useMemo(() => {
    const out = [...noteCategories];
    for (const name of categoryStats.counts.keys()) {
      if (name !== GRAY_CATEGORY && !out.includes(name)) out.push(name);
    }
    return out;
  }, [noteCategories, categoryStats]);

  const grayCount = categoryStats.counts.get(GRAY_CATEGORY) ?? 0;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const today = startOfToday();
    let list = notes.filter((n) => {
      const cat = normalizeCategoryName(n.category ?? "");
      switch (filter) {
        case "pinned":
          if (!n.pinned) return false;
          break;
        case "today":
          if (isoMs(n.modified) < today) return false;
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
        case "gray":
          if (cat !== GRAY_CATEGORY) return false;
          break;
        case "uncategorized":
          if (cat) return false;
          break;
        default:
          // 用户分类：cat:分类名
          if (filter.startsWith("cat:") && cat !== filter.slice(4)) return false;
          break;
      }
      if (!q) return true;
      if (n.title.toLowerCase().includes(q)) return true;
      return notePlainText(n, refblocks).toLowerCase().includes(q);
    });
    list = sortNotes(list, openedAt);
    return list;
  }, [notes, refblocks, filter, query, openedAt]);

  /* 4.8.7：左栏固定三组（用户指定）——
     【全部笔记】全部 / 置顶 / 今天　【按颜色】黑色 / 蓝色 / 红色。
     【我的合集】由下面的独立段落渲染（未分类合集 + 用户合集 + 新建）。
     「灰度提示词」不在这里：它只在「合集」抽屉里有一个文件夹。 */
  const RAIL: RailGroup[] = [
    {
      group: "全部笔记",
      items: [
        { key: "all", name: "全部", count: stats.all },
        { key: "pinned", name: "置顶", count: stats.pinned },
        { key: "today", name: "今天", count: stats.today },
      ],
    },
    {
      group: "按颜色",
      items: [
        { key: "c0", name: "黑色", count: stats.c0, dot: COLOR_DOTS[0] },
        // 按用户要求的顺序：黑色 → 蓝色 → 红色（color 2 是蓝、1 是红）
        { key: "c2", name: "蓝色", count: stats.c2, dot: COLOR_DOTS[2] },
        { key: "c1", name: "红色", count: stats.c1, dot: COLOR_DOTS[1] },
      ],
    },
  ];

  const filterName = (() => {
    if (filter === "uncategorized") return "未分类合集";
    if (filter === "gray") return GRAY_CATEGORY;
    if (filter.startsWith("cat:")) return filter.slice(4);
    return (
      RAIL.flatMap((g) => g.items).find((i) => i.key === filter)?.name ?? "全部"
    );
  })();

  /** 合集总览的文件夹：全部笔记 / 置顶 / 未分类 / 灰度提示词 / 每个用户分类 */
  const folders: FolderItem[] = [
    {
      category: "all",
      name: "全部笔记",
      count: stats.all,
      title: `全部笔记 · ${stats.all} 条`,
    },
    {
      category: "pinned",
      name: "置顶",
      count: stats.pinned,
      title: `置顶 · ${stats.pinned} 条`,
    },
    {
      category: "uncategorized",
      name: "未分类",
      count: categoryStats.uncategorized,
      title: `未分类 · ${categoryStats.uncategorized} 条`,
    },
    {
      category: "gray",
      name: GRAY_CATEGORY,
      count: grayCount,
      auto: true,
      title: `${GRAY_CATEGORY}：超过 15 天没有打开的笔记会自动移入这里`,
    },
    ...categoryNames.map((name) => {
      const count = categoryStats.counts.get(name) ?? 0;
      return {
        category: name,
        name,
        count,
        title: `分类「${name}」· ${count} 条`,
      };
    }),
  ];

  /** 当前过滤命中的文件夹（回到合集时高亮） */
  const activeFolder =
    filter === "all" ||
    filter === "pinned" ||
    filter === "uncategorized" ||
    filter === "gray"
      ? filter
      : filter.startsWith("cat:")
        ? filter.slice(4)
        : "";

  // 光标落在被过滤掉的笔记上时自动收敛到第一张
  useEffect(() => {
    if (rows.length === 0) {
      if (cursorId !== null) setCursorId(null);
      return;
    }
    if (!cursorId || !rows.some((n) => n.id === cursorId)) {
      const cur = rows.find((n) => n.id === currentId);
      setCursorId(cur ? cur.id : rows[0].id);
    }
  }, [rows, cursorId, currentId]);

  /* ---------------- 视图切换（合集 ⇄ 卡片墙） ---------------- */

  const openCollections = useCallback(() => {
    setDrawerBack(false);
    setFromCollections(false);
    setView("collections");
  }, []);

  /** 「‹ 合集」：回到合集总览，用与进入分类相反方向的淡入动画 */
  const backToCollections = useCallback(() => {
    setDrawerBack(true);
    setView("collections");
  }, []);

  const enterFromRail = useCallback(
    (key: FilterKey) => {
      // 从合集里点分类也允许一键退回合集；从普通卡片墙点则不带返回按钮
      setFromCollections(view === "collections");
      setFilter(key);
      setView("wall");
    },
    [view],
  );

  /** 点开合集里的文件夹：进入按该分类过滤的卡片墙 */
  const enterFolder = useCallback((category: string) => {
    setRawQuery("");
    setQuery("");
    setDrawerBack(false);
    setFromCollections(true);
    setFilter(folderToFilter(category));
    setView("wall");
  }, []);

  const confirmNewCategory = useCallback(
    (raw: string) => {
      const from = newCategoryFrom;
      setNewCategoryFrom(null);
      const name = normalizeCategoryName(raw);
      if (!name || name === GRAY_CATEGORY) return;
      addNoteCategory(name);
      // 刚建好的分类：短暂高亮，用户一眼能看到新文件夹
      setFreshCategory(name);
      if (freshTimer.current !== null) window.clearTimeout(freshTimer.current);
      freshTimer.current = window.setTimeout(() => {
        freshTimer.current = null;
        setFreshCategory(null);
      }, 1700);
      if (from === "rail") {
        // 左侧入口：建完直接进这个分类
        setFromCollections(false);
        setFilter(categoryFilter(name));
        setView("wall");
      } else {
        // 合集里新建：留在抽屉总览，新文件夹立刻出现，点它再进卡片墙
        setDrawerBack(false);
        setView("collections");
      }
    },
    [addNoteCategory, newCategoryFrom],
  );

  /* ---------------- 打开 / 收起 ---------------- */

  /**
   * 4.8.6 第四轮 · 统一转场（按用户要求）：两个方向用同一套最简单的
   * 「展开 / 收起 + 内容淡入淡出」——
   *   打开：面板从右边缘零宽展开到全宽（clip-path），内容跟着淡入；
   *   收起：内容先淡出，面板再收回右边缘零宽，收完才卸载。
   * 不再有逐张卡片的 FLIP（管理台 40 张卡里只有十来张能和侧栏里的卡片对上，
   * 逐张飞必然「满屏乱飞」），也不做任何 rect 坐标换算，天然不受 UI 缩放影响。
   * 首帧 / 末帧的可见宽度都是 0，所以 0ms 与卸载瞬间都不会硬切内容。
   */

  /**
   * 收起：内容先淡出，面板再收回右边缘（CSS 里 `fm486-collapse`），
   * 收完（可见宽度为 0）才卸载 —— 卸载瞬间屏幕上本来就没有管理台，不会闪。
   */
  const requestClose = useCallback(() => {
    if (closing) return;
    setMenu(null);
    setRenaming(null);
    setDeleting(null);
    setCreating(false);
    setNewCategoryFrom(null);

    // 减少动态效果：直接关，不做过渡
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }

    setClosing(true);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onClose();
    }, CLOSE_MS);
  }, [closing, onClose]);

  const openNote = useCallback(
    (id: string) => {
      setCursorId(id);
      setLaunchingId(id);
      if (launchTimer.current !== null) window.clearTimeout(launchTimer.current);
      launchTimer.current = window.setTimeout(() => setLaunchingId(null), 260);
      void select(id);
      // 打开笔记 = 管理台收起：面板缩回右侧侧栏，编辑区淡入
      requestClose();
    },
    [select, requestClose],
  );

  /** 点「新建」：先弹命名框，确认后才创建并回到编辑器 */
  const newNote = useCallback(() => {
    setRawQuery("");
    setQuery("");
    setCreating(true);
  }, []);

  const confirmCreate = useCallback(
    (title: string) => {
      setCreating(false);
      void createNote(title).then(() => requestClose());
    },
    [createNote, requestClose],
  );

  const openMenu = useCallback((e: React.MouseEvent, note: Note) => {
    e.preventDefault();
    e.stopPropagation();
    setCursorId(note.id);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fromButton = (e.currentTarget as HTMLElement).closest(".ns-act");
    setMenu({
      x: fromButton ? r.right : e.clientX,
      y: fromButton ? r.bottom + 4 : e.clientY,
      id: note.id,
    });
  }, []);

  const pinOne = useCallback(
    (note: Note) => setNotePinned(note.id, !note.pinned),
    [setNotePinned],
  );

  const doDelete = useCallback(async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    await removeNote(id);
  }, [deleting, removeNote]);

  /* ---------------- 键盘 ---------------- */

  /** 当前卡片墙的真实列数：随窗口宽度变化（铺满全屏后一行更多张） */
  const columnCount = useCallback((): number => {
    const el = gridRef.current;
    if (!el) return 3;
    const tpl = getComputedStyle(el).gridTemplateColumns;
    const n = tpl.split(" ").filter(Boolean).length;
    return n > 0 ? n : 3;
  }, []);

  const moveCursor = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const cur = rows.findIndex((n) => n.id === cursorId);
      const next =
        cur < 0
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, cur + delta));
      const n = rows[next];
      if (!n) return;
      setCursorId(n.id);
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-note-id="${n.id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [rows, cursorId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renaming || deleting || creating || newCategoryFrom) return; // 交给二级弹窗
      if (menu) {
        if (e.key === "Escape") setMenu(null);
        return;
      }
      if (e.key === "Escape") {
        // 合集总览没有搜索框：Esc 直接退出管理台
        if (view === "collections") {
          requestClose();
          return;
        }
        if (rawQuery) {
          setRawQuery("");
          setQuery("");
          return;
        }
        requestClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        requestClose();
        return;
      }
      // 合集总览是文件夹网格：方向键 / 回车 / 删除都不作用于隐藏的卡片墙
      if (view === "collections") return;
      const target = e.target as HTMLElement | null;
      const inField = !!target?.closest?.(
        "input, textarea, select, [contenteditable='true']",
      );
      if (!inField && e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // 搜索框里也能直接走位：↑↓ 选卡片、回车打开（Delete / ←→ 仍归输入框编辑）
      if (target === searchRef.current) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const step = columnCount();
          moveCursor(e.key === "ArrowDown" ? step : -step);
          return;
        }
        if (e.key === "Enter" && cursorId) {
          e.preventDefault();
          openNote(cursorId);
          return;
        }
        return;
      }
      if (inField) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = columnCount();
        moveCursor(e.key === "ArrowDown" ? step : -step);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        moveCursor(e.key === "ArrowRight" ? 1 : -1);
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
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        if (!cursorId) return;
        e.preventDefault();
        const row = gridRef.current?.querySelector<HTMLElement>(
          `[data-note-id="${cursorId}"]`,
        );
        const r = row?.getBoundingClientRect();
        setMenu({
          x: r ? r.right - 8 : 240,
          y: r ? r.bottom - 6 : 220,
          id: cursorId,
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    renaming,
    deleting,
    creating,
    newCategoryFrom,
    menu,
    rawQuery,
    cursorId,
    notes,
    view,
    requestClose,
    openNote,
    columnCount,
    moveCursor,
  ]);

  /* ---------------- 右键菜单 ---------------- */
  const menuNote = menu ? notes.find((n) => n.id === menu.id) : null;
  const menuItems = menuNote
    ? noteMenuItems(menuNote, {
        onOpen: (n) => openNote(n.id),
        onRename: (n) => setRenaming(n),
        onPin: pinOne,
        onColor: (id, color) => setColor(id, color),
        onDelete: (n) => setDeleting(n),
        // 4.8.5：把笔记移动到任意用户分类 / 未分类
        categories: noteCategories,
        onCategory: (id, category) => setNoteCategory(id, category),
      })
    : [];

  const countText = query
    ? `${rows.length}/${notes.length}`
    : String(rows.length);
  return (
    <div
      className={
        "fm-layer" +
        (closing ? " is-closing" : "") +
        (showTime ? "" : " ns-no-time") +
        (eyeCare ? " ns-paper" : "")
      }
      aria-label="文件管理台"
      role="dialog"
      aria-modal="true"
    >
      <div className="fm-shell">
        <div className="fm-body">
          {/* ===== 左：合集入口 + 分类（保持原管理台的分类导航设计） ===== */}
          <nav className="fm-rail" aria-label="笔记分类">
            <button
              type="button"
              className={
                "fm-rail-item fm-rail-collections" +
                (view === "collections" ? " on" : "")
              }
              aria-pressed={view === "collections"}
              title="合集：像手机文件夹一样整理笔记"
              onClick={openCollections}
            >
              <span className="fm-rail-ico" aria-hidden="true">
                <DrawerIco size={13} />
              </span>
              <span className="fm-rail-name">合集</span>
              <span className="fm-rail-arrow" aria-hidden="true">
                ›
              </span>
            </button>

            {RAIL.map((g) => (
              <div className="fm-rail-group" key={g.group}>
                <div className="fm-rail-label">{g.group}</div>
                {g.items.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className={"fm-rail-item" + (filter === it.key ? " on" : "")}
                    aria-pressed={filter === it.key}
                    data-filter={it.key}
                    onClick={() => enterFromRail(it.key)}
                  >
                    {it.dot ? (
                      <span className="fm-rail-dot" style={{ background: it.dot }} />
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

            {/* 4.8.7：我的合集（未分类合集 / 每个用户合集 / ＋新建分类合集）。
                「灰度提示词」不在左栏：它只在「合集」抽屉里作为一个文件夹出现，
                与「侧栏列表不显示灰度笔记」保持一致。 */}
            <div className="fm-rail-group" data-group="我的合集">
              <div className="fm-rail-label">我的合集</div>
              <button
                type="button"
                className={
                  "fm-rail-item" + (filter === "uncategorized" ? " on" : "")
                }
                aria-pressed={filter === "uncategorized"}
                data-filter="uncategorized"
                title={`未分类合集 · ${categoryStats.uncategorized} 条`}
                onClick={() => enterFromRail("uncategorized")}
              >
                <span className="fm-rail-ico" aria-hidden="true">
                  <FolderIco size={12} />
                </span>
                <span className="fm-rail-name">未分类合集</span>
                <span className="fm-rail-count">
                  {categoryStats.uncategorized}
                </span>
              </button>
              {categoryNames.map((name) => {
                const key = categoryFilter(name);
                const on = filter === key;
                const count = categoryStats.counts.get(name) ?? 0;
                return (
                  <button
                    key={name}
                    type="button"
                    className={"fm-rail-item" + (on ? " on" : "")}
                    aria-pressed={on}
                    data-filter={key}
                    title={`合集「${name}」· ${count} 条`}
                    onClick={() => enterFromRail(key)}
                  >
                    <span className="fm-rail-ico" aria-hidden="true">
                      <FolderIco size={12} />
                    </span>
                    <span className="fm-rail-name">{name}</span>
                    <span className="fm-rail-count">{count}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="fm-rail-item fm-rail-new"
                title="新建一个分类合集"
                onClick={() => setNewCategoryFrom("rail")}
              >
                <span className="fm-rail-ico" aria-hidden="true">
                  <PlusIco size={12} />
                </span>
                <span className="fm-rail-name">新建分类合集</span>
              </button>
            </div>
          </nav>

          {/* ===== 右：合集总览 / 与侧栏同款卡片墙 ===== */}
          <div className="fm-main">
            {view === "collections" ? (
              /* -------- 4.8.5 合集：手机应用抽屉式的文件夹网格 -------- */
              <div
                className={"fm-collections" + (drawerBack ? " is-back" : "")}
                data-view="collections"
              >
                <div className="ns-head fm-manager-head fm-collections-head">
                  <span className="ns-head-name">合集</span>
                  <span
                    className="ns-count"
                    title={`共 ${folders.length} 个分类`}
                  >
                    {folders.length}
                  </span>
                  <span className="fm-collections-sub">
                    点开文件夹，就是一面卡片墙
                  </span>
                  <button
                    type="button"
                    className="fm-close fm-manager-close"
                    title="退出管理台（Esc）"
                    aria-label="退出管理台"
                    onClick={requestClose}
                  >
                    <CloseIco size={15} />
                  </button>
                </div>
                <div className="fm-folders" aria-label="笔记合集">
                  {folders.map((f, i) => (
                    <button
                      key={f.category}
                      type="button"
                      className={
                        "fm-folder" +
                        (f.auto ? " is-auto" : "") +
                        (f.category === activeFolder ? " on" : "") +
                        (f.category === freshCategory ? " is-fresh" : "")
                      }
                      data-category={f.category}
                      title={f.title}
                      style={{ "--folder-i": i } as React.CSSProperties}
                      onClick={() => enterFolder(f.category)}
                    >
                      <span className="fm-folder-ico" aria-hidden="true">
                        <FolderIco size={17} />
                      </span>
                      <span className="fm-folder-name">{f.name}</span>
                      <span className="fm-folder-count">{f.count}</span>
                      {f.auto && <span className="fm-folder-auto">自动</span>}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="fm-folder is-new"
                    title="新建分类"
                    onClick={() => setNewCategoryFrom("drawer")}
                  >
                    <span className="fm-folder-ico" aria-hidden="true">
                      <PlusIco size={17} />
                    </span>
                    <span className="fm-folder-name">新建分类</span>
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="ns-head fm-manager-head">
                  {fromCollections && (
                    <button
                      type="button"
                      className="fm-back"
                      title="返回合集"
                      aria-label="返回合集"
                      onClick={backToCollections}
                    >
                      <BackIco size={13} />
                      <span className="fm-back-text">合集</span>
                    </button>
                  )}
                  <span className="ns-head-name">{filterName}</span>
                  <span
                    className="ns-count"
                    title={`共 ${notes.length} 条笔记`}
                  >
                    {countText}
                  </span>
                  <div
                    className="ns-search fm-manager-search"
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
                      value={rawQuery}
                      onChange={(e) => setRawQuery(e.target.value)}
                      placeholder="搜索标题和正文…"
                      aria-label="搜索笔记"
                      spellCheck={false}
                    />
                    {rawQuery ? (
                      <button
                        className="ns-search-clear"
                        title="清空搜索"
                        onClick={() => {
                          setRawQuery("");
                          setQuery("");
                          searchRef.current?.focus();
                        }}
                      >
                        <Svg size={11} strokeWidth={2.2}>
                          <path d="M6 6l12 12M18 6L6 18" />
                        </Svg>
                      </button>
                    ) : (
                      <span className="ns-search-key">/</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="fm-close fm-manager-close"
                    title="退出管理台（Esc）"
                    aria-label="退出管理台"
                    onClick={requestClose}
                  >
                    <CloseIco size={15} />
                  </button>
                </div>

                <div
                  className={
                    "ns-grid fm-wall" + (fromCollections ? " is-cat-in" : "")
                  }
                  ref={gridRef}
                  tabIndex={-1}
                  role={rows.length ? "list" : undefined}
                >
                  {rows.map((n, i) => (
                    <NoteCard
                      key={n.id}
                      note={n}
                      selected={n.id === currentId}
                      cursor={n.id === cursorId}
                      query={query.trim().toLowerCase()}
                      showTime={showTime}
                      index={i}
                      launching={n.id === launchingId}
                      onOpen={openNote}
                      onMenu={openMenu}
                      onPin={pinOne}
                    />
                  ))}

                  {rows.length === 0 && (
                    <div className="ns-empty">
                      {query ? (
                        <>
                          <div className="ns-empty-art is-search">
                            <SearchIco size={22} />
                          </div>
                          <div className="ns-empty-title">没有找到相关笔记</div>
                          <div className="ns-empty-sub">
                            换个关键词试试，标题和正文都能搜
                          </div>
                          <button
                            className="ns-empty-btn ghost"
                            onClick={() => {
                              setRawQuery("");
                              setQuery("");
                              searchRef.current?.focus();
                            }}
                          >
                            清空搜索
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="ns-empty-art">
                            <FolderIco size={26} />
                          </div>
                          <div className="ns-empty-title">
                            {filter === "gray"
                              ? "灰度提示词还是空的"
                              : filter === "uncategorized"
                                ? "所有笔记都有分类了"
                                : "这个分类下还没有笔记"}
                          </div>
                          <div className="ns-empty-sub">
                            {filter === "gray"
                              ? "超过 15 天没有打开的笔记会自动移进来"
                              : filter === "uncategorized"
                                ? "在笔记上右键，就能把它移进分类"
                                : "换个分类看看，或新建一条"}
                          </div>
                          <button className="ns-empty-btn" onClick={newNote}>
                            <PlusIco size={13} /> 新建笔记
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* 底部悬浮工具栏：与侧栏同款，只保留「新建 / 退出」 */}
            <div className="ns-toolbar" role="toolbar" aria-label="管理台操作">
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
                title="退出管理台，回到笔记侧栏（Esc）"
                aria-label="退出管理台"
                onClick={requestClose}
              >
                <CollapseIco size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>

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
      {newCategoryFrom && (
        <InputDialog
          title="新建分类"
          initial=""
          placeholder="给分类起个名字"
          hint={`最多 20 个字；「${GRAY_CATEGORY}」是系统自动分类，不用手动建`}
          confirmText="创建"
          onConfirm={confirmNewCategory}
          onCancel={() => setNewCategoryFrom(null)}
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
