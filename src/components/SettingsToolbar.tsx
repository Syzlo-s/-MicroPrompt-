import UpdateButton from "./UpdateButton";

/**
 * 侧栏开关：侧栏关闭时停在页面右下角，只保留「展开笔记侧栏」。
 * 设置已固定到编辑区底部工具栏（「回到底部」右侧），这里不再重复。
 */
export default function SettingsToolbar({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}) {
  return (
    <div className="settings-toolbar">
      <UpdateButton />
      <button
        type="button"
        className="tool-btn dock-toggle"
        title="展开笔记侧栏（Ctrl+Shift+B）"
        aria-label="展开笔记侧栏"
        aria-expanded={false}
        onClick={onToggleSidebar}
      >
        <svg
          className="sb-glyph"
          viewBox="0 0 32 32"
          width={18}
          height={18}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4.8" y="6.6" width="22.4" height="18.8" rx="4.6" />
          <line x1="19.6" y1="6.6" x2="19.6" y2="25.4" />
          <rect
            className="sb-glyph-fill"
            x="21.4"
            y="8.4"
            width="3.8"
            height="16"
            rx="1.9"
            stroke="none"
          />
        </svg>
      </button>
    </div>
  );
}
