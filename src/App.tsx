import { useEffect, useRef } from "react";
import { useStore, applyTheme } from "./store";
import TitleBar from "./components/TitleBar";
import EditorArea from "./components/EditorArea";
import BottomDock from "./components/BottomDock";
import LoginScreen from "./components/LoginScreen";
import WelcomeScreen from "./components/WelcomeScreen";
import ToastHost from "./components/ToastHost";

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
      className="app-root"
      style={{ background: bg }}
    >
      <TitleBar />
      <div className="app-body" style={{ background: bg }}>
        <EditorArea />
        <BottomDock />
      </div>
      {!welcomeDone && <WelcomeScreen />}
      <ToastHost />
    </div>
  );
}
