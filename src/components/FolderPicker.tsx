import React from "react";
import * as backend from "../backend";

/* ============================================================
 * 自绘文件夹选择器（FolderPicker）
 * ------------------------------------------------------------
 * 为什么不用系统弹窗：软件是无边框自绘风格，系统对话框风格割裂；
 * 而且这里只需要「挑一个文件夹」，自绘还能顺手给出「安装目录 /
 * 当前笔记目录 / 旧版本位置」这些常用位置。
 *
 * 交互：
 *   · 左侧：常用位置 + 盘符（点击直接跳转）
 *   · 右侧：面包屑 + 子文件夹列表（双击进入，单击选中）
 *   · 顶部：新建文件夹（就地建一个再选中）
 *   · 底部：选择当前 / 选中的文件夹
 * 键盘：Esc 取消，Enter 确认
 * ============================================================ */

const isRootPath = (p: string) => /^[A-Za-z]:[\\/]?$/.test(p.trim());

/** 拼接子路径（自动处理结尾反斜杠） */
export const joinPath = (dir: string, name: string): string =>
  dir.replace(/[\\/]+$/, "") + "\\" + name;

/** 取父目录；已经是根则返回自身 */
export const parentPath = (p: string): string => {
  const t = p.replace(/[\\/]+$/, "");
  if (isRootPath(t)) return t.endsWith("\\") ? t : t + "\\";
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  if (i <= 0) return t;
  const head = t.slice(0, i);
  return isRootPath(head) ? head + "\\" : head;
};

/** 面包屑分段：[{label, path}] */
export const pathSegments = (p: string): { label: string; path: string }[] => {
  const t = p.replace(/[\\/]+$/, "");
  const parts = t.split(/[\\/]+/).filter(Boolean);
  const out: { label: string; path: string }[] = [];
  let acc = "";
  parts.forEach((seg, i) => {
    acc = i === 0 ? seg + "\\" : acc.replace(/[\\/]+$/, "") + "\\" + seg;
    out.push({ label: i === 0 ? seg : seg, path: i === 0 ? seg + "\\" : acc });
  });
  return out;
};

export default function FolderPicker({
  title = "选择文件夹",
  startPath,
  confirmText = "选择此文件夹",
  hint,
  onConfirm,
  onCancel,
}: {
  title?: string;
  /** 打开时定位到的目录 */
  startPath?: string;
  confirmText?: string;
  hint?: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}) {
  const [cwd, setCwd] = React.useState("");
  const [entries, setEntries] = React.useState<backend.DirEntry[]>([]);
  const [drives, setDrives] = React.useState<backend.DirEntry[]>([]);
  const [places, setPlaces] = React.useState<backend.DirEntry[]>([]);
  const [picked, setPicked] = React.useState<backend.DirEntry | null>(null);
  const [err, setErr] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  /** 新建文件夹：null = 未展开；string = 正在输入的名字 */
  const [newName, setNewName] = React.useState<string | null>(null);

  // 打开时定位：显式传入 > 当前笔记目录 > 安装目录
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [d, q] = await Promise.all([
          backend.listDrives(),
          backend.getQuickPlaces(),
        ]);
        if (!alive) return;
        setDrives(d);
        setPlaces(q);
      } catch {
        /* 忽略：列表拉不到不影响手输路径 */
      }
      let start = startPath?.trim();
      if (!start) {
        try {
          start = await backend.getDataDir();
        } catch {
          start = "";
        }
      }
      if (!alive) return;
      setCwd(start);
      void load(start);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async (path: string) => {
    setErr("");
    setLoading(true);
    setPicked(null);
    try {
      const list = await backend.listDirs(path);
      setEntries(list);
    } catch (e) {
      setEntries([]);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const goto = (path: string) => {
    if (!path) return;
    setCwd(path);
    setNewName(null);
    void load(path);
  };

  const createFolder = async () => {
    const name = (newName ?? "").trim();
    if (!name || !cwd) return;
    try {
      const created = await backend.createFolder(joinPath(cwd, name));
      setNewName(null);
      await load(cwd);
      setPicked({ name, path: created, hasChild: false });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const target = picked?.path ?? cwd;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
      if (e.key === "Enter" && !newName && target) onConfirm(target);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onConfirm, target, newName]);

  const segs = cwd ? pathSegments(cwd) : [];

  return (
    <div
      className="dialog-overlay fp-overlay"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="fp-panel">
        <div className="fp-head">
          <div className="dialog-title">{title}</div>
          <button className="fp-close" title="关闭" onClick={onCancel}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="fp-body">
          {/* 左侧：常用位置 + 盘符 */}
          <div className="fp-side">
            <div className="fp-side-label">常用位置</div>
            {places.map((p) => (
              <button
                key={p.path}
                className={"fp-side-item" + (cwd === p.path ? " on" : "")}
                onClick={() => goto(p.path)}
                title={p.path}
              >
                <span className="fp-side-name">{p.name}</span>
              </button>
            ))}
            <div className="fp-side-label">此电脑</div>
            {drives.map((d) => (
              <button
                key={d.path}
                className={"fp-side-item" + (cwd === d.path ? " on" : "")}
                onClick={() => goto(d.path)}
              >
                <span className="fp-side-name">{d.name}</span>
              </button>
            ))}
          </div>

          {/* 右侧：面包屑 + 目录列表 */}
          <div className="fp-main">
            <div className="fp-crumbs">
              <button
                className="fp-up"
                title="上一级"
                disabled={!cwd || isRootPath(cwd)}
                onClick={() => goto(parentPath(cwd))}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
              <div className="fp-crumb-list">
                {segs.map((s, i) => (
                  <React.Fragment key={s.path}>
                    {i > 0 && <span className="fp-crumb-sep">›</span>}
                    <button
                      className="fp-crumb"
                      onClick={() => goto(s.path)}
                      title={s.path}
                    >
                      {s.label}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>

            <div className="fp-list">
              {loading && <div className="fp-empty">读取中…</div>}
              {!loading && entries.length === 0 && !err && (
                <div className="fp-empty">这个文件夹里没有子文件夹</div>
              )}
              {err && <div className="fp-error">{err}</div>}
              {!loading &&
                entries.map((d) => (
                  <button
                    key={d.path}
                    className={"fp-row" + (picked?.path === d.path ? " on" : "")}
                    onClick={() => setPicked(d)}
                    onDoubleClick={() => goto(d.path)}
                    title={d.path}
                  >
                    <span className="fp-row-ico" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
                      </svg>
                    </span>
                    <span className="fp-row-name">{d.name}</span>
                  </button>
                ))}
            </div>

            {newName !== null && (
              <div className="fp-new">
                <input
                  className="dialog-input fp-new-input"
                  autoFocus
                  placeholder="新文件夹名称"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createFolder();
                    if (e.key === "Escape") setNewName(null);
                  }}
                />
                <button className="btn btn-sm btn-primary" onClick={() => void createFolder()}>
                  创建
                </button>
                <button className="btn btn-sm" onClick={() => setNewName(null)}>
                  取消
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="fp-foot">
          <div className="fp-picked" title={target}>
            <span className="fp-picked-label">
              {picked ? "已选中" : "当前文件夹"}
            </span>
            <span className="fp-picked-path">{target || "—"}</span>
          </div>
          <div className="fp-actions">
            <button
              className="btn btn-sm"
              onClick={() => setNewName("")}
              disabled={!cwd}
              title="在当前位置新建一个文件夹"
            >
              新建文件夹
            </button>
            <button
              className="btn btn-sm btn-primary"
              disabled={!target}
              onClick={() => target && onConfirm(target)}
            >
              {confirmText}
            </button>
          </div>
        </div>
        {hint && <div className="fp-hint">{hint}</div>}
      </div>
    </div>
  );
}
