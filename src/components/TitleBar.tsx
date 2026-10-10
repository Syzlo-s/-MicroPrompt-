import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import * as backend from "../backend";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Icon from "./Icon";
import pinSvg from "../assets/icons/pin.svg";
import minimizeSvg from "../assets/icons/minimize.svg";
import maximizeSvg from "../assets/icons/maximize.svg";
import restoreSvg from "../assets/icons/restore.svg";
import closeSvg from "../assets/icons/close.svg";
import defaultAvatar from "../assets/icons/default-avatar.svg";

const appWindow = getCurrentWindow();

/**
 * 自定义顶栏（42px）：
 *   - 左上角：用户头像（替代原 Logo 位置，大小与原 Logo 相近）
 *   - 正中间：笔记名，垂直对齐
 *   - 右侧：图钉 + 窗口控制按钮
 */
export default function TitleBar() {
  const note = useStore((s) => s.notes.find((n) => n.id === s.currentId));
  const pinned = useStore((s) => s.pinned);
  const setPinned = useStore((s) => s.setPinned);
  const setMaximized = useStore((s) => s.setMaximized);
  const avatar = useStore((s) => s.avatar);
  const openSettings = useStore((s) => s.openSettings);
  const [maximized, setMaximizedLocal] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // 切换笔记时标题渐出→换字→渐入（与编辑区一致的淡入淡出）
  const [displayTitle, setDisplayTitle] = useState("");
  const [titleFade, setTitleFade] = useState<"idle" | "out" | "in">("idle");
  const titleInit = useRef(false);

  useEffect(() => {
    const t = note?.title ?? "";
    if (!titleInit.current) {
      titleInit.current = true;
      setDisplayTitle(t);
      return;
    }
    if (displayTitle === t) return;
    setTitleFade("out");
  }, [note?.title]);

  const onTitleAnimEnd = (e: React.AnimationEvent) => {
    if (e.animationName === "mp-title-fade-out") {
      setDisplayTitle(note?.title ?? "");
      setTitleFade("in");
    } else if (e.animationName === "mp-title-fade-in") {
      setTitleFade("idle");
    }
  };

  useEffect(() => {
    const un = () => {
      void appWindow.isMaximized().then((m) => {
        setMaximizedLocal(m);
        setMaximized(m);
      });
    };
    void appWindow.isMaximized().then((m) => {
      setMaximizedLocal(m);
      setMaximized(m);
    });
    const cleanup = appWindow.onResized(un);
    return () => {
      cleanup.then((f) => f());
    };
  }, [setMaximized]);

  const handleMinimize = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => {
      void backend.minimizeWindow();
      setLeaving(false);
    }, 220); // 淡出 220ms InCubic
  };

  const handleMaximize = () => void backend.toggleMaximize();

  const closeBtn = (
    <button
      className="winbtn winbtn-close"
      title="关闭"
      onClick={() => void backend.closeWindow()}
    >
      <Icon src={closeSvg} size={14} />
    </button>
  );

  return (
    <div
      className={"titlebar" + (leaving ? " titlebar-leaving" : "")}
      data-tauri-drag-region
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".winbtn")) return;
        handleMaximize();
      }}
    >
      <button
        className="titlebar-avatar"
        title="账号"
        onClick={() => openSettings(true)}
      >
        <img src={avatar ?? defaultAvatar} alt="头像" />
      </button>

      {note && (
        <div className="titlebar-center" data-tauri-drag-region>
          <span className="tb-name" title={note.title}>
            <span className="tb-name-mask">
              <span
                className={
                  "tb-name-inner" +
                  (titleFade === "out"
                    ? " tb-fade-out"
                    : titleFade === "in"
                      ? " tb-fade-in"
                      : "")
                }
                onAnimationEnd={onTitleAnimEnd}
              >
                {displayTitle}
              </span>
            </span>
          </span>
        </div>
      )}

      <div className="tb-spacer" data-tauri-drag-region />
      <button
        className="winbtn winbtn-pin"
        data-pinned={pinned || undefined}
        title={pinned ? "取消置顶" : "置顶"}
        onClick={() => setPinned(!pinned)}
      >
        <Icon src={pinSvg} size={18} />
      </button>
      <button className="winbtn" title="最小化" onClick={handleMinimize}>
        <Icon src={minimizeSvg} size={17} />
      </button>
      <button className="winbtn" title={maximized ? "还原" : "最大化"} onClick={handleMaximize}>
        <Icon src={maximized ? restoreSvg : maximizeSvg} size={17} />
      </button>
      {closeBtn}
    </div>
  );
}
