import React from "react";
import { useStore } from "../store";
import * as backend from "../backend";
import { showToast } from "../utils/toast";
import { humanSize, msToLocal } from "../utils/noteText";
import FolderPicker from "./FolderPicker";

/* ============================================================
 * 存储位置控件（4.6.0）
 * ------------------------------------------------------------
 * 一份逻辑，两处皮肤：
 *   · variant="card" —— 设置 → 存储 里的分组卡片（路径 / 统计 /
 *     打开文件夹 / 更改位置 / 恢复默认 / 打开文件管理台）
 *   · variant="bar"  —— 文件管理台底部的单行条（路径 + 打开 + 更改）
 *
 * 为什么搬移要自己做：笔记是用户的命根子，切目录必须
 *  ① 先把内存里的改动落盘 → ② 复制到新位置并读回校验 → ③ 才写配置。
 * 顺序反了或跳过校验，都可能出现「打开软件笔记空了」。
 * ============================================================ */

/** 定位图标（复用一套，卡片与条都用它） */
function FolderIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

/** 切换位置的二次确认（不可逆操作必须说清后果） */
function SwitchDialog({
  path,
  isDefault,
  busy,
  onMove,
  onSwitchOnly,
  onCancel,
}: {
  path: string;
  isDefault: boolean;
  busy: boolean;
  onMove: () => void;
  onSwitchOnly: () => void;
  onCancel: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="dialog-panel storage-confirm">
        <div className="dialog-title">
          {isDefault ? "恢复默认保存位置" : "切换笔记保存位置"}
        </div>
        <div className="dialog-message storage-confirm-msg">
          {isDefault
            ? "默认位置是软件安装目录下的 data 文件夹："
            : "笔记将保存到下面这个文件夹："}
          <div className="storage-confirm-path" title={path}>
            {path}
          </div>
          <div className="storage-confirm-tip">
            「移动并切换」会把现在的笔记复制过去（旧位置的文件保留一份作备份，
            不用怕丢）；「只切换」不搬数据，直接使用该文件夹里已有的笔记。
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className="btn" onClick={onSwitchOnly} disabled={busy}>
            只切换
          </button>
          <button className="btn btn-primary" onClick={onMove} disabled={busy}>
            {busy ? "正在搬移…" : "移动并切换"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StorageControls({
  variant = "card",
  onOpenManager,
}: {
  variant?: "card" | "bar";
  onOpenManager?: () => void;
}) {
  const storage = useStore((s) => s.storage);
  const busy = useStore((s) => s.storageBusy);
  const refreshStorage = useStore((s) => s.refreshStorage);
  const changeDataDir = useStore((s) => s.changeDataDir);
  const restoreDefaultDataDir = useStore((s) => s.restoreDefaultDataDir);

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pending, setPending] = React.useState<{
    path: string;
    isDefault: boolean;
  } | null>(null);

  React.useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const dir = storage?.dir ?? "";
  const files = storage?.files ?? [];

  const apply = async (path: string, moveData: boolean, isDefault = false) => {
    try {
      // 恢复默认走专用命令：它会把 config.json 里的自选项清掉
      const report = isDefault
        ? await restoreDefaultDataDir(moveData)
        : await changeDataDir(path, moveData);
      setPending(null);
      const size = humanSize(report.movedBytes);
      showToast({
        text: report.moved
          ? `已搬到新位置并切换：搬移 ${report.movedFiles.length} 个文件（${size}）`
          : "已切换保存位置",
        tone: "success",
        duration: 3200,
      });
    } catch (e) {
      showToast({
        text: "切换失败：" + (e instanceof Error ? e.message : String(e)),
        tone: "error",
        duration: 4200,
      });
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(dir);
      showToast({ text: "路径已复制", tone: "success" });
    } catch {
      showToast({ text: dir, tone: "info", duration: 4000 });
    }
  };

  const openFolder = async (path?: string) => {
    try {
      await backend.openFolder(path ?? dir);
    } catch (e) {
      showToast({
        text: "打开失败：" + (e instanceof Error ? e.message : String(e)),
        tone: "error",
      });
    }
  };

  const restoreDefault = () => {
    if (!storage) return;
    setPending({ path: storage.defaultDir, isDefault: true });
  };

  /* ---------------- 单行条（文件管理台底部） ---------------- */
  if (variant === "bar") {
    return (
      <>
        <div className="fm-storage">
          <span className="fm-storage-ico" aria-hidden="true">
            <FolderIcon size={14} />
          </span>
          <span className="fm-storage-path" title={dir}>
            {dir || "读取中…"}
          </span>
          <button
            className="btn btn-sm"
            onClick={() => void openFolder()}
            disabled={!dir}
            title="在资源管理器中打开笔记文件夹"
          >
            打开
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
            title="换一个文件夹保存笔记"
          >
            更改
          </button>
        </div>
        {pickerOpen && (
          <FolderPicker
            title="选择笔记保存位置"
            startPath={dir}
            confirmText="保存到这里"
            hint="选好后会问你：是把现在的笔记搬过去，还是直接使用该文件夹里已有的笔记"
            onCancel={() => setPickerOpen(false)}
            onConfirm={(p) => {
              setPickerOpen(false);
              if (p === dir) {
                showToast({ text: "已经是当前的保存位置", tone: "info" });
                return;
              }
              setPending({ path: p, isDefault: false });
            }}
          />
        )}
        {pending && (
          <SwitchDialog
            path={pending.path}
            isDefault={pending.isDefault}
            busy={busy}
            onCancel={() => setPending(null)}
            onMove={() => void apply(pending.path, true, pending.isDefault)}
            onSwitchOnly={() =>
              void apply(pending.path, false, pending.isDefault)
            }
          />
        )}
      </>
    );
  }

  /* ---------------- 卡片（设置 → 存储） ---------------- */
  return (
    <div className="set-stack">
      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-ico">
            <FolderIcon size={14} />
          </span>
          <span className="set-card-title">笔记保存位置</span>
          <span className="set-card-extra">
            {storage?.isDefault ? "默认位置" : "自定义位置"}
          </span>
        </div>

        <div className="storage-path-row">
          <span className="storage-path" title={dir}>
            {dir || "读取中…"}
          </span>
          <button
            className="btn btn-sm"
            onClick={() => void copyPath()}
            disabled={!dir}
            title="复制完整路径"
          >
            复制
          </button>
        </div>

        <div className="storage-meta">
          <span>{storage ? `${storage.noteCount} 条笔记` : "—"}</span>
          <span className="storage-meta-dot" />
          <span>
            {files.length} 个数据文件 · 共 {humanSize(storage?.totalBytes ?? 0)}
          </span>
          {storage && !storage.writable && (
            <span className="storage-warn">该文件夹不可写</span>
          )}
        </div>

        <div className="storage-actions">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void openFolder()}
            disabled={!dir}
            title="在资源管理器中打开这个文件夹"
          >
            打开文件夹
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
            title="换一个文件夹保存笔记"
          >
            更改位置
          </button>
          <button
            className="btn btn-sm"
            onClick={restoreDefault}
            disabled={
              busy ||
              !storage ||
              storage.dir === storage.defaultDir
            }
            title={
              storage ? `恢复为 ${storage.defaultDir}` : "恢复默认位置"
            }
          >
            恢复默认
          </button>
          {onOpenManager && (
            <button
              className="btn btn-sm"
              onClick={onOpenManager}
              title="打开文件管理台：搜索、批量整理、导出"
            >
              文件管理
            </button>
          )}
        </div>

        {files.length > 0 && (
          <div className="storage-files">
            {files.map((f) => (
              <div className="storage-file" key={f.name}>
                <span className="storage-file-name" title={f.name}>
                  {f.name}
                </span>
                <span className="storage-file-size">{humanSize(f.size)}</span>
                <span className="storage-file-time">{msToLocal(f.modifiedMs)}</span>
              </div>
            ))}
          </div>
        )}

        {storage && !storage.isDefault && (
          <div className="storage-hint">
            默认位置是软件安装目录下的 data 文件夹：
            <span className="storage-hint-path" title={storage.defaultDir}>
              {storage.defaultDir}
            </span>
          </div>
        )}

        {storage?.legacyHasData && (
          <div className="storage-hint">
            检测到旧版本的数据还在
            <span className="storage-hint-path" title={storage.legacyDir}>
              {storage.legacyDir}
            </span>
            （第一次用新版本时已自动复制一份到新位置，旧文件仍保留）
            <button
              className="btn btn-sm storage-hint-btn"
              onClick={() => void openFolder(storage.legacyDir)}
            >
              查看旧位置
            </button>
          </div>
        )}

        {pickerOpen && (
          <FolderPicker
            title="选择笔记保存位置"
            startPath={dir}
            confirmText="保存到这里"
            hint="建议建一个专门的文件夹，之后想换回默认位置点「恢复默认」即可"
            onCancel={() => setPickerOpen(false)}
            onConfirm={(p) => {
              setPickerOpen(false);
              if (p === dir) {
                showToast({ text: "已经是当前的保存位置", tone: "info" });
                return;
              }
              setPending({ path: p, isDefault: false });
            }}
          />
        )}
        {pending && (
          <SwitchDialog
            path={pending.path}
            isDefault={pending.isDefault}
            busy={busy}
            onCancel={() => setPending(null)}
            onMove={() => void apply(pending.path, true, pending.isDefault)}
            onSwitchOnly={() =>
              void apply(pending.path, false, pending.isDefault)
            }
          />
        )}
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <span className="set-card-ico">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
              <path d="M3.5 9.5h17M9 9.5v10" />
            </svg>
          </span>
          <span className="set-card-title">文件管理台</span>
        </div>
        <div className="storage-hint">
          搜索标题与正文、按时间或颜色筛选、批量置顶 / 改色 / 删除 / 导出，
          都能在一个面板里完成（快捷键 Ctrl + K）。
        </div>
        {onOpenManager && (
          <div className="storage-actions">
            <button className="btn btn-sm" onClick={onOpenManager}>
              打开文件管理台
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 供外部（文件管理台）复用：打开当前目录 */
export async function openCurrentDataDir(): Promise<void> {
  const dir = useStore.getState().storage?.dir ?? "";
  if (!dir) return;
  try {
    await backend.openFolder(dir);
  } catch (e) {
    showToast({
      text: "打开失败：" + (e instanceof Error ? e.message : String(e)),
      tone: "error",
    });
  }
}
