/* ============================================================
 * 轻提词 · Toast 宿主
 *   挂在 App 根节点内（随「界面大小」一起缩放），监听 showToast 事件。
 *   - 最多同时显示 2 条；同 key 的提示会顶掉旧的（反复双击复制不会叠一屏）
 *   - 进场：从上方淡入 + 轻微放大；退场：淡出 + 轻微上移
 * ============================================================ */
import { useEffect, useRef, useState } from "react";
import { TOAST_EVENT, type ToastPayload, type ToastTone } from "../utils/toast";

interface Item extends ToastPayload {
  id: number;
  tone: ToastTone;
  leaving: boolean;
}

const ICONS: Record<ToastTone, React.ReactNode> = {
  success: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12.5l5.2 5.2L20 7" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 7v7M12 17.2v.1" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 11v6M12 6.8v.1" />
    </svg>
  ),
};

/** 退场动画时长（需与 styles.css 的 .mp-toast.leaving 一致） */
const LEAVE_MS = 180;

export default function ToastHost() {
  const [items, setItems] = useState<Item[]>([]);
  const idRef = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timerMap = timers.current;
    const dismiss = (id: number) => {
      const t = timerMap.get(id);
      if (t) {
        clearTimeout(t);
        timerMap.delete(id);
      }
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, leaving: true } : it)));
      setTimeout(() => setItems((prev) => prev.filter((it) => it.id !== id)), LEAVE_MS);
    };

    const onToast = (ev: Event) => {
      const detail = (ev as CustomEvent<ToastPayload>).detail;
      if (!detail || !detail.text) return;
      const id = ++idRef.current;
      const tone: ToastTone = detail.tone ?? "info";
      const duration = detail.duration ?? (detail.actionLabel ? 4200 : 2000);
      const dedupeKey = detail.key ?? detail.text;
      const item: Item = { ...detail, id, tone, duration, leaving: false };

      setItems((prev) => {
        // 同 key 的旧提示直接顶掉（清掉它的定时器与退场计时）
        const kept: Item[] = [];
        for (const old of prev) {
          if ((old.key ?? old.text) === dedupeKey) {
            const t = timerMap.get(old.id);
            if (t) {
              clearTimeout(t);
              timerMap.delete(old.id);
            }
          } else {
            kept.push(old);
          }
        }
        return [...kept, item].slice(-2);
      });

      timerMap.set(id, setTimeout(() => dismiss(id), duration));
    };

    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      for (const t of timerMap.values()) clearTimeout(t);
      timerMap.clear();
    };
  }, []);

  if (items.length === 0) return null;

  const runAction = (it: Item) => {
    try {
      it.onAction?.();
    } finally {
      const t = timers.current.get(it.id);
      if (t) {
        clearTimeout(t);
        timers.current.delete(it.id);
      }
      setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, leaving: true } : p)));
      setTimeout(() => setItems((prev) => prev.filter((p) => p.id !== it.id)), LEAVE_MS);
    }
  };

  return (
    <div className="mp-toast-layer" role="status" aria-live="polite">
      {items.map((it) => (
        <div
          key={it.id}
          className={"mp-toast tone-" + it.tone + (it.leaving ? " leaving" : "")}
        >
          <span className="mp-toast-ico">{ICONS[it.tone]}</span>
          <span className="mp-toast-text">{it.text}</span>
          {it.actionLabel && (
            <button className="mp-toast-action" onMouseDown={(e) => e.preventDefault()} onClick={() => runAction(it)}>
              {it.actionLabel}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
