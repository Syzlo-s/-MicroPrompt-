/* ============================================================
 * 轻提词 · 更新小按钮（4.7.1）
 * ------------------------------------------------------------
 * 挂在右下角设置工具栏里（SettingsToolbar），就一个 80×24 的小药丸：
 *   available    「新版本」     —— 点一下就下载，不弹窗、不抢焦点
 *   downloading  「下载 42%」   —— 进度条就画在按钮自己身上（从左往右填充）
 *   ready        「重启更新」   —— 下载 + 校验都过了，什么时候重启由用户决定
 *   applying     「正在重启」
 *   error        「重试」
 * 没有新版时渲染 null，工具栏宽度与原来完全一致。
 * 颜色 / 圆角 / 缓动一律走主题变量，换主题色、开护眼模式自动跟随。
 * ============================================================ */

import { useUpdateStore, formatBytes } from "../services/updater";

export default function UpdateButton() {
  const phase = useUpdateStore((s) => s.phase);
  const manifest = useUpdateStore((s) => s.manifest);
  const asset = useUpdateStore((s) => s.asset);
  const info = useUpdateStore((s) => s.info);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const skipped = useUpdateStore((s) => s.skipped);
  const download = useUpdateStore((s) => s.download);
  const apply = useUpdateStore((s) => s.apply);

  if (!manifest || skipped) return null;
  if (
    phase !== "available" &&
    phase !== "downloading" &&
    phase !== "ready" &&
    phase !== "applying" &&
    phase !== "error"
  ) {
    return null;
  }

  const ver = manifest.version;
  const pct = progress.total
    ? Math.min(100, Math.round((progress.got / progress.total) * 100))
    : 0;
  const isInstaller = asset != null && asset === manifest.installer;
  const kind = isInstaller ? "安装包" : "便携版";

  let label = "新版本";
  let title = "";
  switch (phase) {
    case "downloading":
      label = progress.total ? `下载 ${pct}%` : "下载中";
      title = progress.total
        ? `正在下载 ${ver}：${pct}%（${formatBytes(progress.got)} / ${formatBytes(progress.total)}）`
        : `正在下载 ${ver}：已下载 ${formatBytes(progress.got)}`;
      break;
    case "ready":
      label = "重启更新";
      title = `新版本 ${ver} 已下载并校验通过\n点击重启并安装（约 10 秒，笔记不会动）`;
      break;
    case "applying":
      label = "正在重启";
      title = "正在重启并安装更新…";
      break;
    case "error":
      label = "重试";
      title = `更新失败：${error}\n点击重试下载`;
      break;
    default:
      title =
        `新版本 ${ver}${manifest.releasedAt ? `（${manifest.releasedAt}）` : ""}` +
        `\n当前 ${info?.version ?? "?"} → ${ver}` +
        (asset?.size ? ` · ${formatBytes(asset.size)}` : "") +
        ` · ${kind}` +
        "\n点击下载并安装；不想升级可在 设置 → 关于 里「忽略此版本」";
  }

  const busy = phase === "downloading" || phase === "applying";

  return (
    <button
      type="button"
      className="upd-pill"
      data-phase={phase}
      title={title}
      disabled={busy}
      onClick={() => {
        if (phase === "available" || phase === "error") void download();
        else if (phase === "ready") void apply();
      }}
    >
      {phase === "downloading" && (
        <span
          className={"upd-pill-fill" + (progress.total ? "" : " indet")}
          style={progress.total ? { width: `${pct}%` } : undefined}
          aria-hidden="true"
        />
      )}
      <span className="upd-pill-label">{label}</span>
    </button>
  );
}
