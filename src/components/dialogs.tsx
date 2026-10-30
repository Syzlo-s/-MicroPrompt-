import React, { useEffect, useRef, useState } from "react";

/* ============================================================
 * 轻量自绘弹窗（4.8.5 重做视觉）
 * ------------------------------------------------------------
 * 统一使用 .dlg-* 类，不改动设置 / 存储 / 密码面板里复用的
 * .dialog-input 等旧类，避免连带影响。
 *
 * 输入框：1px 细描边（#E2E8F0）+ 白底 + 圆角 10px，聚焦时主题色
 *         描边 + 极淡主题色光环 —— 不再是粗灰线。
 * 按钮：取消 = ghost（无边框、hover 浅底）；确定 = 主题色实心胶囊，
 *       按下有 1px 下沉反馈；禁用态降透明度。
 * ============================================================ */

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="dialog-panel dlg-panel">{children}</div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      // 焦点在按钮上时把 Enter 交给按钮自己的默认行为（否则「取消」按钮也会确认）
      if (e.key === "Enter") {
        const el = document.activeElement;
        if (el instanceof HTMLButtonElement) return;
        onConfirm();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel, onConfirm]);

  return (
    <Overlay>
      <div className="dlg-title">{title}</div>
      <div className="dlg-message">{message}</div>
      <div className="dlg-actions">
        <button className="dlg-btn dlg-cancel" onClick={onCancel}>
          {cancelText}
        </button>
        <button
          className={
            "dlg-btn " + (danger ? "dlg-confirm is-danger" : "dlg-confirm")
          }
          onClick={onConfirm}
        >
          {confirmText}
        </button>
      </div>
    </Overlay>
  );
}

export function InputDialog({
  title,
  initial,
  placeholder = "",
  hint = "",
  confirmText = "确定",
  cancelText = "取消",
  onConfirm,
  onCancel,
}: {
  title: string;
  initial: string;
  placeholder?: string;
  /** 输入框下方的一行说明（可选） */
  hint?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  // 仅在打开时聚焦并全选一次（不能依赖 value，否则每次输入都会重新全选）
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && value.trim()) {
        // 焦点在按钮上时让按钮自己处理（避免在「取消」上按回车却创建笔记）
        const el = document.activeElement;
        if (el instanceof HTMLButtonElement) return;
        onConfirm(value.trim());
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel, onConfirm, value]);

  const empty = !value.trim();

  return (
    <Overlay>
      <div className="dlg-title">{title}</div>
      <input
        ref={inputRef}
        className="dlg-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
      />
      {hint && <div className="dlg-hint">{hint}</div>}
      <div className="dlg-actions">
        <button className="dlg-btn dlg-cancel" onClick={onCancel}>
          {cancelText}
        </button>
        <button
          className="dlg-btn dlg-confirm"
          disabled={empty}
          onClick={() => !empty && onConfirm(value.trim())}
        >
          {confirmText}
        </button>
      </div>
    </Overlay>
  );
}
