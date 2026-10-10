import React, { useEffect, useRef, useState } from "react";

/* ============================================================
 * 轻量自绘弹窗（对齐 QMessageBox / QInputDialog 视觉规范：
 * 白底、圆角 8、边框 #D8D8D8、正文 13px #1A1A1A、按钮 12px）
 * ============================================================ */

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="dialog-overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="dialog-panel">{children}</div>
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
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel, onConfirm]);

  return (
    <Overlay>
      <div className="dialog-title">{title}</div>
      <div className="dialog-message">{message}</div>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          {cancelText}
        </button>
        <button
          className={"btn" + (danger ? " btn-danger" : " btn-primary")}
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
  onConfirm,
  onCancel,
}: {
  title: string;
  initial: string;
  placeholder?: string;
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
      if (e.key === "Enter" && value.trim()) onConfirm(value.trim());
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel, onConfirm, value]);

  return (
    <Overlay>
      <div className="dialog-title">{title}</div>
      <input
        ref={inputRef}
        className="dialog-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn btn-primary"
          disabled={!value.trim()}
          onClick={() => value.trim() && onConfirm(value.trim())}
        >
          确定
        </button>
      </div>
    </Overlay>
  );
}
