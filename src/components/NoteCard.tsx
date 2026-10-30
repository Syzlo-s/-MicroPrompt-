import React, { useMemo } from "react";
import type { Note } from "../types";
import type { MenuItem } from "./context-menu";
import { cardDate } from "../utils";

/* ============================================================
 * 4.8.3 · 共享笔记卡片（侧栏 / 文件管理台同款）
 * ------------------------------------------------------------
 * 侧栏和管理台卡片墙必须长得一模一样，所以卡片、图标、右键菜单
 * 全部收在这一处，两处只负责布局与状态。
 *
 * 卡片只留标题（单行省略）+ 时间 + 颜色点，不再显示正文摘要：
 *   · 正文不在卡片上露头，扫描列表更快、卡片更小；
 *   · 搜索仍走「标题 + 正文」，命中标题时高亮；
 *   · 置顶只加一枚小图钉，悬停浮出「置顶 / 更多」小胶囊。
 * ============================================================ */

export const COLOR_NAMES = ["黑色", "红色", "蓝色"];
export const COLOR_DOTS = ["#2b2b2b", "#C0392B", "#4A90D9"];

/* ---------------- 时间 ---------------- */

/** 卡片角上只给绝对时间，不出现「今天 / 昨天」这些分组词 */
export function noteStamp(iso: string): string {
  const t = Date.parse((iso ?? "").replace(" ", "T"));
  if (!Number.isFinite(t) || !t) return "";
  const d = new Date(t);
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---------------- 细图标（内联，跟着 currentColor 走） ---------------- */

export function Svg({
  children,
  size = 14,
  className,
  strokeWidth = 1.8,
}: {
  children: React.ReactNode;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const SearchIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 13} strokeWidth={2}>
    <circle cx="11" cy="11" r="6.4" />
    <path d="M16 16l4.4 4.4" />
  </Svg>
);

export const PlusIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 14} strokeWidth={2}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Svg>
);

export const CollapseIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 15} strokeWidth={1.9}>
    <path d="M9 5.5l6.5 6.5L9 18.5" />
  </Svg>
);

export const PinIco = ({
  filled = false,
  size = 13,
}: {
  filled?: boolean;
  size?: number;
}) => (
  <Svg size={size} strokeWidth={1.7}>
    <path
      d="M9.4 3.6h5.2l-.7 5 2.6 2.6v1.7H7.5v-1.7l2.6-2.6-.7-5Z"
      fill={filled ? "currentColor" : "none"}
    />
    <path d="M12 12.9V20" />
  </Svg>
);

export const MoreIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 14} strokeWidth={2.4}>
    <path d="M5 12h.01M12 12h.01M19 12h.01" />
  </Svg>
);

export const TrashIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 14} strokeWidth={1.8}>
    <path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12" />
  </Svg>
);

export const FolderIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 13} strokeWidth={1.8}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
  </Svg>
);

export const PencilIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 14} strokeWidth={1.8}>
    <path d="M4 20l.9-4.2L16.2 4.5a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8L8.2 19.1 4 20Z" />
    <path d="M14.8 6l3.2 3.2" />
  </Svg>
);

export const NoteIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 30} strokeWidth={1.4}>
    <path d="M6 3.8h8.4L19 8.4v11.8H6z" />
    <path d="M14 3.8v4.9h5" />
    <path d="M9 12.2h6M9 15.4h4.2" />
  </Svg>
);

export const CloseIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 14} strokeWidth={2.2}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

/* ---------------- 标题高亮 ---------------- */

type TitlePiece = { text: string; hit: boolean };

function highlightTitle(title: string, query: string): TitlePiece[] | null {
  if (!query) return null;
  const i = title.toLowerCase().indexOf(query);
  if (i < 0) return null;
  const out: TitlePiece[] = [];
  if (i > 0) out.push({ text: title.slice(0, i), hit: false });
  out.push({ text: title.slice(i, i + query.length), hit: true });
  if (i + query.length < title.length) {
    out.push({ text: title.slice(i + query.length), hit: false });
  }
  return out;
}

/* ---------------- 单张笔记卡片 ---------------- */

export interface NoteCardProps {
  note: Note;
  /** 当前正在编辑的笔记 */
  selected: boolean;
  /** 键盘光标所在卡片 */
  cursor?: boolean;
  /** 搜索词（只用于标题高亮） */
  query?: string;
  showTime: boolean;
  /** 网格里的序号：只用于入场动画的错峰延迟 */
  index?: number;
  /** 刚被点击、正在打开（给一个按下回弹动画） */
  launching?: boolean;
  onOpen: (id: string) => void;
  onMenu: (e: React.MouseEvent, note: Note) => void;
  onPin: (note: Note) => void;
}

export const NoteCard = React.memo(function NoteCard({
  note,
  selected,
  cursor = false,
  query = "",
  showTime,
  index,
  launching = false,
  onOpen,
  onMenu,
  onPin,
}: NoteCardProps) {
  const titlePieces = useMemo(
    () => highlightTitle(note.title || "未命名笔记", query),
    [note.title, query],
  );
  const dot = COLOR_DOTS[note.color] ?? COLOR_DOTS[0];

  return (
    <div
      className={
        "ns-card" +
        (selected ? " is-current" : "") +
        (cursor ? " is-cursor" : "") +
        (launching ? " is-launching" : "")
      }
      data-note-id={note.id}
      role="listitem"
      aria-current={selected ? "true" : undefined}
      title={`${note.title || "未命名笔记"}\n${cardDate(note.modified)}`}
      style={
        index === undefined
          ? undefined
          : ({ "--card-i": index } as React.CSSProperties)
      }
      onClick={() => onOpen(note.id)}
      onContextMenu={(e) => onMenu(e, note)}
    >
      <div className="ns-card-top">
        {note.pinned && (
          <span className="ns-card-pin" title="已置顶">
            <PinIco filled size={10} />
          </span>
        )}
        <span className="ns-card-title-wrap">
          <span className="ns-card-title">
            {titlePieces
              ? titlePieces.map((p, i) =>
                  p.hit ? (
                    <mark key={i} className="ns-hit">
                      {p.text}
                    </mark>
                  ) : (
                    <React.Fragment key={i}>{p.text}</React.Fragment>
                  ),
                )
              : note.title || "未命名笔记"}
          </span>
        </span>
      </div>

      <div className="ns-card-foot">
        {showTime && <span className="ns-card-time">{noteStamp(note.modified)}</span>}
        <span className="ns-card-dot" style={{ background: dot }} aria-hidden="true" />
      </div>

      {/* 悬停时从卡片右侧整块滑入：与卡片同高的「置顶 / 更多」两个操作 */}
      <span className="ns-card-acts" onMouseDown={(e) => e.stopPropagation()}>
        <button
          className={"ns-act" + (note.pinned ? " on" : "")}
          title={note.pinned ? "取消置顶" : "置顶"}
          aria-label={note.pinned ? "取消置顶" : "置顶"}
          onClick={(e) => {
            e.stopPropagation();
            onPin(note);
          }}
        >
          <PinIco filled={!!note.pinned} size={13} />
        </button>
        <button
          className="ns-act"
          title="更多操作"
          aria-label="更多操作"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e, note);
          }}
        >
          <MoreIco size={14} />
        </button>
      </span>
    </div>
  );
});

/* ---------------- 右键菜单（侧栏 / 管理台共用） ---------------- */

export interface NoteMenuActions {
  onOpen: (note: Note) => void;
  onRename: (note: Note) => void;
  onPin: (note: Note) => void;
  onColor: (id: string, color: number) => void;
  onDelete: (note: Note) => void;
  /**
   * 4.8.5：可选——用户自选分类列表。传了才显示「移动到分类」子菜单；
   * 「灰度提示词」是系统自动分类，不出现在手动选择里。
   */
  categories?: string[];
  /** 4.8.5：把笔记移动到某个分类；null = 未分类 */
  onCategory?: (id: string, category: string | null) => void;
}

export function noteMenuItems(note: Note, a: NoteMenuActions): MenuItem[] {
  const name = note.title || "未命名笔记";
  const curCategory = (note.category ?? "").trim();
  return [
    {
      label: "在编辑器中打开",
      icon: <NoteIco size={15} />,
      onClick: () => a.onOpen(note),
    },
    {
      label: "重命名",
      icon: <PencilIco size={15} />,
      onClick: () => a.onRename(note),
    },
    {
      label: note.pinned ? "取消置顶" : "置顶",
      icon: <PinIco filled={!!note.pinned} size={15} />,
      onClick: () => a.onPin(note),
    },
    {
      label: "更改提示词颜色",
      icon: (
        <span
          className="ctx-dot"
          style={{ background: COLOR_DOTS[note.color] ?? COLOR_DOTS[0] }}
        />
      ),
      children: COLOR_NAMES.map((cn, i) => ({
        label: cn,
        icon: <span className="ctx-dot" style={{ background: COLOR_DOTS[i] }} />,
        onClick: () => a.onColor(note.id, i),
      })),
    },
    ...(a.categories && a.onCategory
      ? [
          {
            label: `分类：${curCategory || "未分类"}`,
            icon: <FolderIco size={15} />,
            children: [
              {
                label: "未分类",
                icon: curCategory ? undefined : <span className="ctx-check">✓</span>,
                onClick: () => a.onCategory!(note.id, null),
              },
              ...a.categories.map((c) => ({
                label: c,
                icon:
                  curCategory === c ? (
                    <span className="ctx-check">✓</span>
                  ) : undefined,
                onClick: () => a.onCategory!(note.id, c),
              })),
            ],
          } as MenuItem,
        ]
      : []),
    { separator: true },
    {
      label: `删除「${name}」`,
      danger: true,
      icon: <TrashIco size={15} />,
      onClick: () => a.onDelete(note),
    },
  ];
}
