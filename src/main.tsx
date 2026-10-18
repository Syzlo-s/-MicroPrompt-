import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import UpdateWatcher from "./components/UpdateWatcher";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    {/* 在线升级提示卡（4.7.0）：与登录态无关，启动后静默检查一次 */}
    <UpdateWatcher />
  </React.StrictMode>,
);
