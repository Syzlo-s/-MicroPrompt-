import { useStore } from "../store";
import SettingsDialog from "./SettingsDialog";
import MemberDialog from "./MemberDialog";
import SettingsToolbar from "./SettingsToolbar";

/**
 * 底部停靠区：
 *   - 侧栏关闭时右下角的「展开笔记侧栏」浮钮
 *   - 设置弹窗 / 会员弹窗
 *
 * 设置已固定到编辑区底部工具栏（「回到底部」右侧），这里不再重复；
 * 侧栏展开后浮钮隐藏，动作由 NotesSidebar 底栏的新建 / 管理 / 收起接管。
 */
export default function BottomDock() {
  const settingsOpen = useStore((s) => s.settingsOpen);
  const settingsAccountOnly = useStore((s) => s.settingsAccountOnly);
  const closeSettings = useStore((s) => s.closeSettings);
  const sidebarOpen = useStore((s) => s.notesSidebarOpen);
  const toggleNotesSidebar = useStore((s) => s.toggleNotesSidebar);
  const memberOpen = useStore((s) => s.memberOpen);
  const closeMember = useStore((s) => s.closeMember);

  return (
    <>
      {/* 侧栏展开后浮钮隐藏；设置已在编辑区底栏，不受侧栏开合影响 */}
      {!sidebarOpen && (
        <SettingsToolbar onToggleSidebar={toggleNotesSidebar} />
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
