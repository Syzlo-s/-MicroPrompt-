import { FolderIco, PinIco, PlusIco, Svg } from "./NoteCard";

/* ============================================================
 * 4.8.6 · 侧栏分类导航（NotesNav）
 * ------------------------------------------------------------
 * 只负责「画导航 + 上报点击」，筛选 / 排序 / 数据统计都留在
 * NotesSidebar 里，避免分类逻辑散落两处。
 *
 * 结构（自上而下，4.8.6 紧凑 chip 版）：
 *   【全部笔记】    全部 / 置顶 / 今天 —— 同一行 3 个 chip
 *   【按颜色】      黑色 / 蓝色 / 红色 —— 同一行 3 个 chip（带颜色圆点）
 *   【我的合集】    未分类合集 / 每个用户分类 / ＋新建分类合集 —— chip 自动换行
 *
 * 注意：「最近打开」不是分类，不在导航里 —— 它是卡片墙顶部的一张快捷卡片
 * （由 NotesSidebar 渲染），点开过的笔记在列表原位不动，只是多了一个入口。
 *
 * 这样默认 696px 高度下导航约 190px、不出现滚动条，卡片墙能完整看到 2 行；
 * 窗口过矮或合集特别多时再让导航区自己滚（分类多时只在合集区换行）。
 *
 * 「灰度提示词」不在这里：它要固定在侧栏最下方、像回收站一样常驻，
 * 由 NotesSidebar 单独渲染成灰色页脚。
 * ============================================================ */

/** 侧栏当前选中的分类键；用户合集用 cat: 前缀，避免与内部键撞名 */
export type SidebarFilter =
  | "all"
  | "pinned"
  | "today"
  | "c0"
  | "c1"
  | "c2"
  | "uncategorized"
  | "gray"
  | `cat:${string}`;

/** 用户分类名 → 过滤键（与文件管理台的 cat: 规则保持一致） */
export function categoryKey(name: string): `cat:${string}` {
  return `cat:${name}`;
}

/** 导航里的一个可点项 */
export interface NavItem {
  key: SidebarFilter;
  name: string;
  count: number;
  /** 颜色圆点（黑色 / 蓝色 / 红色用） */
  dot?: string;
  /** 系统自动分类（灰度提示词）的「自动」小标记 */
  auto?: boolean;
  title?: string;
  /** 用户合集名：供 data-category 与「刚建好」高亮使用 */
  category?: string;
}

/** 一个分组（带小标题） */
export interface NavGroup {
  label: string;
  items: NavItem[];
  /** 合集分组：chip 自动换行（每行 2-3 个）；其余分组固定一行 3 个 chip */
  wrap?: boolean;
}

export interface NotesNavProps {
  active: SidebarFilter;
  groups: NavGroup[];
  onPick: (key: SidebarFilter) => void;
  /** 点「＋新建分类合集」：弹命名框，确认后留在侧栏 */
  onCreateCategory: () => void;
  /** 刚建好的分类：短暂高亮，用户一眼能看到新合集 */
  freshCategory?: string | null;
}

/* ---------------- 细图标（内联 SVG，跟 currentColor 走） ---------------- */

/** 最近打开：时钟 */
export const ClockIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 13} strokeWidth={1.8}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.8V12l2.9 1.8" />
  </Svg>
);

/** 今天：日历 */
const CalendarIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 13} strokeWidth={1.8}>
    <rect x="4" y="5.5" width="16" height="14.5" rx="2.4" />
    <path d="M8.5 3.6v3.2M15.5 3.6v3.2M4 10.2h16" />
  </Svg>
);

/** 全部：三行列表 */
const ListIco = (p: { size?: number }) => (
  <Svg size={p.size ?? 13} strokeWidth={1.8}>
    <path d="M4.5 7h15M4.5 12h15M4.5 17h9.5" />
  </Svg>
);

/** 按过滤键取左侧小图标；颜色分类走圆点，不在这里 */
function itemIcon(key: SidebarFilter) {
  if (key === "all") return <ListIco size={12} />;
  if (key === "pinned") return <PinIco size={12} />;
  if (key === "today") return <CalendarIco size={12} />;
  return <FolderIco size={12} />;
}

export function NotesNav({
  active,
  groups,
  onPick,
  onCreateCategory,
  freshCategory,
}: NotesNavProps) {
  return (
    <nav className="ns-nav" aria-label="笔记分类">
      {groups.map((g) => (
        <section className="ns-nav-group" data-group={g.label} key={g.label}>
          <div className="ns-nav-label">{g.label}</div>
          {/* chip 容器：全部笔记 / 按颜色 固定一行；我的合集自动换行 */}
          <div className={"ns-nav-items" + (g.wrap ? " is-wrap" : " is-row")}>
            {g.items.map((it) => (
              <button
                key={it.key}
                type="button"
                className={
                  "ns-nav-item" +
                  (active === it.key ? " on" : "") +
                  (it.category && it.category === freshCategory
                    ? " is-fresh"
                    : "")
                }
                data-filter={it.key}
                data-category={it.category}
                aria-pressed={active === it.key}
                title={it.title}
                onClick={() => onPick(it.key)}
              >
                {it.dot ? (
                  <span
                    className="ns-nav-dot"
                    style={{ background: it.dot }}
                    aria-hidden="true"
                  />
                ) : (
                  <span className="ns-nav-ico" aria-hidden="true">
                    {itemIcon(it.key)}
                  </span>
                )}
                <span className="ns-nav-name">{it.name}</span>
                {it.auto && <span className="ns-nav-auto">自动</span>}
                <span className="ns-nav-count">{it.count}</span>
              </button>
            ))}

            {/* 新建分类只在「我的合集」里出现，不再有独立入口 */}
            {g.label === "我的合集" && (
              <button
                type="button"
                className="ns-nav-item ns-nav-new"
                title="新建一个分类合集（建好后留在侧栏）"
                onClick={onCreateCategory}
              >
                <span className="ns-nav-ico" aria-hidden="true">
                  <PlusIco size={12} />
                </span>
                <span className="ns-nav-name">新建分类合集</span>
              </button>
            )}
          </div>
        </section>
      ))}
    </nav>
  );
}
