import Icon from "./Icon";
import UpdateButton from "./UpdateButton";
import designSvg from "../assets/icons/design.svg";

/**
 * 设置工具栏：页面右下角的小工具栏，外观与底部主工具栏一致。
 * 含两个常驻按钮：「展开 / 收起笔记列表」与「设置」；
 * 有新版时最左边多出一个小按钮（新版本 → 下载中 → 重启更新）。
 * 展开按钮图标为「汉堡菜单 ↔ 叉」动画（参照经典 hamburger 动效）。
 */
export default function SettingsToolbar({
  drawerOpen,
  onToggleDrawer,
  onOpenSettings,
}: {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="settings-toolbar">
      <UpdateButton />
      <button
        className={"tool-btn dock-toggle" + (drawerOpen ? " open" : "")}
        title={drawerOpen ? "收起笔记列表" : "展开笔记列表"}
        onClick={onToggleDrawer}
      >
        <svg
          className="hamburger"
          viewBox="0 0 32 32"
          width={18}
          height={18}
          aria-hidden="true"
        >
          <line className="line line-top" x1="6" y1="10" x2="26" y2="10" />
          <line className="line line-mid" x1="6" y1="16" x2="26" y2="16" />
          <line className="line line-bot" x1="6" y1="22" x2="26" y2="22" />
        </svg>
      </button>
      <div className="tool-vline" />
      <button className="tool-btn" title="设置" onClick={onOpenSettings}>
        <Icon src={designSvg} size={18} />
      </button>
    </div>
  );
}
