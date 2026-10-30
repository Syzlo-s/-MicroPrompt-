import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { startUpdateWatcher } from "./services/updater";
import "./styles.css";
// 4.8.5：合集 / 我的分类的样式单独一文件，放在主样式之后，保证同权重时后者生效
import "./styles/collections.css";
// 4.8.6：六项改动各自单独一份样式，放在最后，按 item 分文件、互不覆盖
import "./styles/v486-avatar.css";
import "./styles/v486-manager.css";
import "./styles/v486-sidebar.css";
import "./styles/v486-toolbar.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 在线升级（4.7.1）：启动 3 秒后静默查一次，与登录态无关。
// 入口是右下角工具栏里的小按钮（新版本 → 下载中 → 重启更新）和 设置 → 关于。
void startUpdateWatcher(3000);
