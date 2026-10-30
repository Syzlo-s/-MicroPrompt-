import { useEffect, useRef } from "react";
import { useStore, applyTheme } from "./store";
import TitleBar from "./components/TitleBar";
import EditorArea from "./components/EditorArea";
import BottomDock from "./components/BottomDock";
import LoginScreen from "./components/LoginScreen";
import WelcomeScreen from "./components/WelcomeScreen";
import ToastHost from "./components/ToastHost";
import FileManager from "./components/FileManager";
import NotesSidebar from "./components/NotesSidebar";

/** UI 缩放：小 / 中 / 大 */
const UI_ZOOMS = [1, 1.15, 1.3];
/** 缩放过渡时长（ms） */
const ZOOM_MS = 420;
/** 缓动曲线：从慢到快（ease-in） */
const easeIn = (t: number) => t * t;

export default function App() {
  const init = useStore((s) => s.init);
  const restoreAuth = useStore((s) => s.restoreAuth);
  const authReady = useStore((s) => s.authReady);
  const authToken = useStore((s) => s.authToken);
  const uiScale = useStore((s) => s.uiScale);
  const welcomeDone = useStore((s) => s.welcomeDone);
  const eyeCare = useStore((s) => s.eyeCareMode);
  const themeColor = useStore((s) => s.themeColor);
  const notesManagerOpen = useStore((s) => s.notesManagerOpen);
  const openNotesManager = useStore((s) => s.openNotesManager);
  const closeNotesManager = useStore((s) => s.closeNotesManager);
  const notesSidebarOpen = useStore((s) => s.notesSidebarOpen);
  const toggleNotesSidebar = useStore((s) => s.toggleNotesSidebar);
  const closeNotesSidebar = useStore((s) => s.closeNotesSidebar);
  const refreshAutoCategories = useStore((s) => s.refreshAutoCategories);
  const bg = eyeCare ? "#FFF8E7" : "#FFFFFF";

  const rootRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(UI_ZOOMS[uiScale] ?? 1);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    void restoreAuth();
  }, [restoreAuth]);

  useEffect(() => {
    void init();
  }, [init]);

  // 4.8.5：自动分类（灰度提示词）定时刷新——开着软件跨过 15 天阈值也能及时归档
  useEffect(() => {
    const timer = window.setInterval(() => refreshAutoCategories(), 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [refreshAutoCategories]);

  useEffect(() => {
    applyTheme(themeColor);
  }, [themeColor]);

  // 界面大小切换：手动补间 zoom，曲线从慢到快
  useEffect(() => {
    const target = UI_ZOOMS[uiScale] ?? 1;
    const start = zoomRef.current;
    if (start === target) return;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ZOOM_MS);
      const z = start + (target - start) * easeIn(p);
      zoomRef.current = z;
      if (rootRef.current) rootRef.current.style.zoom = String(z);
      rafRef.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [uiScale]);

  // 禁用 WebView2 自带的浏览器右键菜单（刷新/另存为等），右键菜单一律由软件自绘
  useEffect(() => {
    const prevent = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  // 全局快捷键：Ctrl/Cmd + K 打开文件管理台（已登录时才有意义）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      if (!useStore.getState().authToken) return;
      e.preventDefault();
      openNotesManager();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openNotesManager]);

  // 全局快捷键：Ctrl/Cmd + Shift + B 开合右侧笔记侧栏
  // （不用 Ctrl+B：那是编辑器的加粗，不能抢）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "b") return;
      const s = useStore.getState();
      if (!s.authToken) return;
      // 管理台 / 设置 / 会员弹窗在上层时，不抢它们的键盘操作
      if (s.notesManagerOpen || s.settingsOpen || s.memberOpen) return;
      e.preventDefault();
      const willOpen = !s.notesSidebarOpen;
      toggleNotesSidebar();
      // 快捷键打开时把焦点交给侧栏列表：↑↓ 直接走位，Esc 直接收起
      if (willOpen) {
        window.setTimeout(() => {
          document.querySelector<HTMLElement>(".ns-grid")?.focus();
        }, 80);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleNotesSidebar]);

  if (!authReady) {
    return <div className="auth-loading">加载中…</div>;
  }

  if (!authToken) {
    return <LoginScreen />;
  }

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        // 每次挂载（含登录后重建）按当前档位初始化缩放，避免闪跳
        if (el && !el.style.zoom) {
          const z = UI_ZOOMS[useStore.getState().uiScale] ?? 1;
          el.style.zoom = String(z);
          zoomRef.current = z;
        }
      }}
      className={
        "app-root" +
        (notesSidebarOpen ? " sidebar-open" : "") +
        (notesManagerOpen ? " manager-open" : "")
      }
      style={{ background: bg }}
    >
      <TitleBar />
      <div
        className={"app-body" + (notesSidebarOpen ? " sidebar-open" : "")}
        style={{ background: bg }}
      >
        <div className={"workspace" + (notesSidebarOpen ? " sidebar-open" : "")}>
          <EditorArea />
          {/* 窄窗时侧栏是浮层：点编辑区任意位置收起 */}
          <div
            className={"sb-scrim" + (notesSidebarOpen ? " show" : "")}
            aria-hidden="true"
            onMouseDown={(e) => {
              e.preventDefault();
              closeNotesSidebar();
            }}
          />
          <NotesSidebar open={notesSidebarOpen} />
          {/* 文件管理台（4.8.3）：从侧栏「管理」或 Ctrl+K 打开，整页铺满（顶部只留头像与窗口按钮） */}
          {notesManagerOpen && <FileManager onClose={closeNotesManager} />}
        </div>
        <BottomDock />
      </div>
      {!welcomeDone && <WelcomeScreen />}
      <ToastHost />
    </div>
  );
}
