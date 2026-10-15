/* ============================================================
 * 轻提词 · 统一轻提示（Toast）
 * ------------------------------------------------------------
 * 用途：复制成功、删除成功、额度提示、AI 润色失败等一次性反馈。
 * 用法：
 *   import { showToast } from "../utils/toast";
 *   showToast({ text: "已复制", tone: "success" });
 *   showToast({ text: "已删除润色框", tone: "success",
 *               actionLabel: "撤销", onAction: () => editor.commands.undo() });
 *
 * 说明：事件总线 + <ToastHost />（挂载在 App 根节点内），
 *       这样提示会跟随「界面大小」缩放，视觉上和窗口保持一致。
 * ============================================================ */

export type ToastTone = "success" | "error" | "warn" | "info";

export interface ToastPayload {
  /** 提示文字（必填） */
  text: string;
  /** 语义色调，决定图标与强调色，默认 info */
  tone?: ToastTone;
  /** 右侧行动按钮文字（如「撤销」） */
  actionLabel?: string;
  /** 行动按钮回调；点击后提示立即关闭 */
  onAction?: () => void;
  /** 显示时长（ms），默认 2000；带行动按钮时默认 4000 */
  duration?: number;
  /** 去重键：相同 key 的新提示会顶掉旧的（默认用 text 去重） */
  key?: string;
}

export const TOAST_EVENT = "mp:toast";

/** 弹出一条轻提示 */
export function showToast(payload: ToastPayload): void {
  if (typeof window === "undefined" || !payload?.text) return;
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }));
}
