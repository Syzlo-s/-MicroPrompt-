import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  /** 子菜单（右侧展开） */
  children?: MenuItem[];
  /** 分隔线 */
  separator?: boolean;
  /** 水平图标行：一组图标按钮横排显示 */
  row?: MenuItem[];
}

/**
 * 自绘右键菜单：白底圆角 10px + 1px #E2E6EE 边框，
 * 弹出动画：淡入 + 下方 10px 上浮，190ms OutCubic
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 自适应定位：默认显示在光标右下；右侧放不下翻到左侧，下方放不下翻到上方
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    let nx = x;
    let ny = y;
    if (x + r.width > window.innerWidth - margin) {
      nx = Math.max(margin, x - r.width);
    }
    if (y + r.height > window.innerHeight - margin) {
      ny = Math.max(margin, y - r.height);
    }
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="ctx-sep" />
        ) : item.row ? (
          <div key={i} className="ctx-row">
            {item.row.map((r, j) => (
              <button
                key={j}
                className={"ctx-row-btn" + (r.danger ? " ctx-danger" : "")}
                title={r.label}
                onClick={() => {
                  onClose();
                  r.onClick?.();
                }}
              >
                {r.icon}
              </button>
            ))}
          </div>
        ) : item.children ? (
          <SubMenu key={i} item={item} onClose={onClose} />
        ) : (
          <div
            key={i}
            className={"ctx-item" + (item.danger ? " ctx-danger" : "")}
            onClick={() => {
              onClose();
              item.onClick?.();
            }}
          >
            {item.icon && <span className="ctx-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </div>
        ),
      )}
    </div>,
    document.body,
  );
}

function SubMenu({
  item,
  onClose,
}: {
  item: MenuItem;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });

  // 子菜单挂载后同步测量并定位：相对菜单项显示在其右侧（右侧放不下时翻到左侧）
  useLayoutEffect(() => {
    if (!open) return;
    const r = ref.current?.getBoundingClientRect();
    const sr = subRef.current?.getBoundingClientRect();
    if (!r || !sr) return;
    const margin = 8;
    const gap = 6;
    let x = r.width + gap; // 子菜单在菜单项右侧，留空隙
    if (r.right + gap + sr.width > window.innerWidth - margin) {
      x = -sr.width - gap; // 右侧放不下，翻到左侧
    }
    let y = -4; // 顶部略上对齐
    if (r.top + sr.height > window.innerHeight - margin) {
      y = Math.max(-r.top + margin, window.innerHeight - margin - r.top - sr.height);
    }
    setSubPos({ x, y });
  }, [open]);

  return (
    <div
      className="ctx-item ctx-has-sub"
      ref={ref}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {item.icon && <span className="ctx-icon">{item.icon}</span>}
      <span>{item.label}</span>
      <span className="ctx-arrow">›</span>
      {open && (
        <div
          ref={subRef}
          className="ctx-menu ctx-submenu"
          style={{ left: subPos.x, top: subPos.y }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {item.children!.map((c, i) =>
            c.separator ? (
              <div key={i} className="ctx-sep" />
            ) : (
              <div
                key={i}
                className={"ctx-item" + (c.danger ? " ctx-danger" : "")}
                onClick={() => {
                  onClose();
                  c.onClick?.();
                }}
              >
                {c.icon && <span className="ctx-icon">{c.icon}</span>}
                <span>{c.label}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
