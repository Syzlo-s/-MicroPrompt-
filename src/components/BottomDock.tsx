import React, { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import NoteCard from "./NoteCard";
import { ContextMenu, type MenuItem } from "./context-menu";
import { ConfirmDialog, InputDialog } from "./dialogs";
import Icon from "./Icon";
import SettingsDialog from "./SettingsDialog";
import MemberDialog from "./MemberDialog";
import SettingsToolbar from "./SettingsToolbar";
import chuangjianSvg from "../assets/icons/chuangjian.svg";
import penSvg from "../assets/icons/pen.svg";
import type { Note } from "../types";

const COLOR_NAMES = ["黑色", "红色", "蓝色"];
const COLOR_DOTS = ["#2b2b2b", "#C0392B", "#4A90D9"];

/** 抽屉卡片逐个动画：每张间隔 55ms */
const STAGGER = 55;

type DrawerState = "closed" | "open" | "closing";

/**
 * 底部停靠区：
 *   - 贯穿横条：头像 / 展开箭头 / 设置 / 新建笔记
 *   - 抽屉浮层：笔记卡片自底部依次向上弹出（收起时倒序下沉），浮在编辑区下半部
 */
export default function BottomDock() {
  const notes = useStore((s) => s.notes);
  const currentId = useStore((s) => s.currentId);
  const select = useStore((s) => s.select);
  const createNote = useStore((s) => s.createNote);
  const removeNote = useStore((s) => s.removeNote);
  const rename = useStore((s) => s.rename);
  const setColor = useStore((s) => s.setColor);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const settingsAccountOnly = useStore((s) => s.settingsAccountOnly);
  const openSettings = useStore((s) => s.openSettings);
  const closeSettings = useStore((s) => s.closeSettings);
  const memberOpen = useStore((s) => s.memberOpen);
  const closeMember = useStore((s) => s.closeMember);

  const [drawer, setDrawer] = useState<DrawerState>("closed");
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [renaming, setRenaming] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isOpen = drawer === "open";

  const openDrawer = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setDrawer("open");
  };

  const closeDrawer = () => {
    setDrawer((d) => {
      if (d !== "open") return d;
      const dur = Math.max(0, (notes.length - 1) * STAGGER) + 340;
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => setDrawer("closed"), dur);
      return "closing";
    });
  };

  const toggleDrawer = () => (isOpen ? closeDrawer() : openDrawer());

  // 点击软件任意位置收回（抽屉与箭头除外）
  useEffect(() => {
    if (drawer !== "open") return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".note-drawer") || t.closest(".settings-toolbar")) return;
      closeDrawer();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [drawer, notes.length]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const menuNote = menu ? notes.find((n) => n.id === menu.id) : null;

  const items: MenuItem[] = [
    {
      label: "重命名",
      icon: <Icon src={penSvg} size={16} />,
      onClick: () => menuNote && setRenaming(menuNote),
    },
    {
      label: "更改提示词颜色",
      children: COLOR_NAMES.map((name, i) => ({
        label: name,
        icon: <span className="ctx-dot" style={{ background: COLOR_DOTS[i] }} />,
        onClick: () => menuNote && setColor(menuNote.id, i),
      })),
    },
    {
      label: "删除",
      danger: true,
      onClick: () => menuNote && setDeleting(menuNote),
    },
  ];

  const handleDelete = () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    void removeNote(id);
  };

  return (
    <>
      {/* ===== 笔记抽屉浮层（从底部依次弹出） ===== */}
      {drawer !== "closed" && (
        <div className={"note-drawer " + drawer}>
          <button
            className="drawer-new"
            onClick={() => void createNote()}
          >
            <Icon src={chuangjianSvg} size={16} />
            <span>新建笔记</span>
          </button>
          <div className="note-drawer-scroll">
            <div className="list-cards">
              {notes.map((n, i) => (
                <div
                  className="drawer-card"
                  key={n.id}
                  style={
                    { "--i": i, "--r": notes.length - 1 - i } as React.CSSProperties
                  }
                >
                  <NoteCard
                    note={n}
                    selected={n.id === currentId}
                    onSelect={() => {
                      void select(n.id);
                      closeDrawer();
                    }}
                    onDelete={() => setDeleting(n)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, id: n.id });
                    }}
                  />
                </div>
              ))}
              {notes.length === 0 && <div className="list-empty">暂无笔记</div>}
            </div>
          </div>
        </div>
      )}

      {/* ===== 右下角设置工具栏（展开笔记列表 / 设置） ===== */}
      <SettingsToolbar
        drawerOpen={isOpen}
        onToggleDrawer={toggleDrawer}
        onOpenSettings={() => openSettings(false)}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}

      {renaming && (
        <InputDialog
          title="重命名笔记"
          initial={renaming.title}
          onConfirm={(v) => {
            rename(renaming.id, v);
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="删除笔记"
          message={`确定要删除笔记「${deleting.title}」吗？该操作不可恢复。`}
          confirmText="删除"
          danger
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          accountOnly={settingsAccountOnly}
          onClose={closeSettings}
        />
      )}

      {/* 开通 AI 会员弹窗（额度用尽 / 设置里点开通都会打开） */}
      {memberOpen && <MemberDialog onClose={closeMember} />}
    </>
  );
}
