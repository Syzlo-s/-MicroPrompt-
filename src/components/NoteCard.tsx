import React from "react";
import type { Note } from "../types";
import { cardDate } from "../utils";
import { useStore } from "../store";
import Icon from "./Icon";
import shanchuSvg from "../assets/icons/shanchu.svg";

/**
 * 笔记气泡卡片：
 *   - 未选中：默认缩小、以中轴线居中，淡靛蓝气泡
 *   - 选中：放大到正常尺寸，品牌蓝气泡 + 白字（带放大动画）
 *   - 标题与日期整体居中显示；可在设置中关闭时间显示，
 *     关闭后标题在气泡内单独居中
 */
export default function NoteCard({
  note,
  selected,
  onSelect,
  onContextMenu,
  onDelete,
}: {
  note: Note;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDelete?: () => void;
}) {
  const showTime = useStore((s) => s.showNoteTime);
  return (
    <div
      className={"note-card" + (selected ? " note-card-selected" : "")}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <span
        className={"nc-center" + (showTime ? "" : " nc-center-title-only")}
      >
        <span className="nc-title" title={note.title}>
          {note.title}
        </span>
        {showTime && <span className="nc-date">{cardDate(note.created)}</span>}
      </span>
      {onDelete && (
        <button
          className="nc-del"
          title="删除笔记"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Icon src={shanchuSvg} size={14} />
        </button>
      )}
    </div>
  );
}
