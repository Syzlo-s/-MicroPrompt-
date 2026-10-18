/* ============================================================
 * 轻提词 · 在线升级提示卡（4.7.0）
 * ------------------------------------------------------------
 * 挂在 main.tsx 里，**与登录状态无关**（更新不需要登录）：
 *   · 启动 3 秒后静默检查一次（设置里可关）
 *   · 有新版本 → 右上角浮出卡片（不抢焦点、不遮编辑器）
 *   · 下载中显示真实进度；下载完按钮变「重启并安装」
 *   · 「稍后」「忽略此版本」都会收起卡片，不打断写作
 *
 * 视觉沿用 Toast 那套深色玻璃卡：进场 --ease-out-back、退场 --ease-in-cubic。
 * ============================================================ */

import { useEffect, useRef, useState } from "react";
import {
  useUpdateStore,
  formatBytes,
  UPDATE_BASE,
  startUpdateWatcher,
} from "../services/updater";

/** 退场动画时长（与 styles.css 的 .upd-card.leaving 一致） */
const LEAVE_MS = 190;

/** 全局只挂一次启动检查（React 严格模式下 effect 会跑两遍） */
let watcherStarted = false;

export default function UpdateWatcher() {
  const phase = useUpdateStore((s) => s.phase);
  const manifest = useUpdateStore((s) => s.manifest);
  const asset = useUpdateStore((s) => s.asset);
  const info = useUpdateStore((s) => s.info);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const collapsed = useUpdateStore((s) => s.collapsed);
  const download = useUpdateStore((s) => s.download);
  const apply = useUpdateStore((s) => s.apply);
  const skipCurrent = useUpdateStore((s) => s.skipCurrent);
  const dismiss = useUpdateStore((s) => s.dismiss);

  // 启动静默检查（只一次；严格模式下 effect 会跑两遍，用模块级标记挡住）
  useEffect(() => {
    if (watcherStarted) return;
    watcherStarted = true;
    return startUpdateWatcher(3000);
  }, []);

  const want = !collapsed &&
    (phase === "available" || phase === "downloading" || phase === "ready" || phase === "error");
  const [mounted, setMounted] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    if (want) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
      leaveTimer.current = null;
    }, LEAVE_MS);
    return () => {
      if (leaveTimer.current !== null) {
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
    };
  }, [want, mounted]);

  if (!mounted || !manifest) return null;

  const ver = manifest.version;
  const pct = progress.total
    ? Math.min(100, Math.round((progress.got / progress.total) * 100))
    : 0;
  const isInstaller = asset != null && asset === manifest.installer;

  const title =
    phase === "ready"
      ? `新版本 ${ver} 已就绪`
      : phase === "downloading"
        ? `正在下载 ${ver}`
        : phase === "error"
          ? "更新没成功"
          : `发现新版本 ${ver}`;

  return (
    <div className={"upd-card" + (leaving ? " leaving" : "")} role="dialog" aria-label="软件更新">
      <div className="upd-head">
        <span className="upd-dot" data-phase={phase} />
        <span className="upd-title">{title}</span>
        <button
          className="upd-x"
          title={phase === "downloading" ? "后台继续下载" : "收起"}
          onClick={() => useUpdateStore.setState({ collapsed: true })}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="upd-meta">
        当前 {info?.version ?? "?"} → 目标 {ver}
        {manifest.releasedAt ? ` · ${manifest.releasedAt}` : ""}
        {asset?.size ? ` · ${formatBytes(asset.size)}` : ""}
        {phase === "available" || phase === "ready" ? (isInstaller ? " · 安装包" : " · 便携版") : ""}
      </div>

      {manifest.notes && (
        <div className="upd-notes">
          {manifest.notes.split("\n").map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {phase === "downloading" && (
        <div className="upd-progress" aria-label="下载进度">
          <div className="upd-bar">
            <div
              className={"upd-bar-fill" + (progress.total ? "" : " indet")}
              style={progress.total ? { width: pct + "%" } : undefined}
            />
          </div>
          <div className="upd-pct">
            {progress.total
              ? `${pct}% · ${formatBytes(progress.got)} / ${formatBytes(progress.total)}`
              : `已下载 ${formatBytes(progress.got)}`}
          </div>
        </div>
      )}

      {phase === "error" && <div className="upd-err">{error}</div>}

      <div className="upd-actions">
        {phase === "available" && (
          <>
            <button className="btn btn-primary upd-btn" onClick={() => void download()}>
              立即更新
            </button>
            <button className="upd-link" onClick={dismiss}>
              稍后
            </button>
            <button className="upd-link" onClick={skipCurrent}>
              忽略此版本
            </button>
          </>
        )}
        {phase === "downloading" && (
          <button className="upd-link" onClick={() => useUpdateStore.setState({ collapsed: true })}>
            后台继续下载（不占界面）
          </button>
        )}
        {phase === "ready" && (
          <>
            <button className="btn btn-primary upd-btn" onClick={() => void apply()}>
              重启并安装
            </button>
            <button className="upd-link" onClick={() => useUpdateStore.setState({ collapsed: true })}>
              稍后
            </button>
          </>
        )}
        {phase === "error" && (
          <>
            <button className="btn upd-btn" onClick={() => void download()}>
              重试
            </button>
            <button className="upd-link" onClick={() => useUpdateStore.setState({ collapsed: true })}>
              关闭
            </button>
          </>
        )}
        {phase === "applying" && <div className="upd-meta">正在重启并安装…</div>}
      </div>

      <div className="upd-src" title="更新源（可用 .env 的 VITE_UPDATE_URL 改）">
        {UPDATE_BASE}
      </div>
    </div>
  );
}
