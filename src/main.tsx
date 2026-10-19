import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { startUpdateWatcher } from "./services/updater";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 在线升级（4.7.1）：启动 3 秒后静默查一次，与登录态无关。
// 入口是右下角工具栏里的小按钮（新版本 → 下载中 → 重启更新）和 设置 → 关于。
void startUpdateWatcher(3000);
