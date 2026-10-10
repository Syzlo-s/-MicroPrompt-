import { useState } from "react";
import { useStore } from "../store";
import {
  LOCAL_ADMIN,
  LOCAL_ADMIN_ENABLED,
  loginWithPassword,
  registerWithPassword,
} from "../services/auth";
import {
  localLogin,
  localRegister,
  LOCAL_TOKEN_PREFIX,
} from "../services/localAuth";

const SAVED_USER_KEY = "microprompt.savedUsername";
const SAVED_PWD_KEY = "microprompt.savedPassword";
const loadSaved = (k: string): string => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const saveCred = (u: string, p: string) => {
  try {
    localStorage.setItem(SAVED_USER_KEY, u);
    localStorage.setItem(SAVED_PWD_KEY, p);
  } catch {
    /* ignore */
  }
};

function UserIcon() {
  return (
    <svg
      className="input-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg
      className="input-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg
      className="eye-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 5.1A9.8 9.8 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3.2 4.2" />
      <path d="M6.2 6.2A17 17 0 0 0 2 12s3 7 10 7a9.8 9.8 0 0 0 4.1-.9" />
    </svg>
  ) : (
    <svg
      className="eye-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** 登录 / 注册界面（用户名 + 密码；记住账号密码） */
export default function LoginScreen() {
  const setAuth = useStore((s) => s.setAuth);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState(loadSaved(SAVED_USER_KEY));
  const [password, setPassword] = useState(loadSaved(SAVED_PWD_KEY));
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = () =>
    run(async () => {
      const u = username.trim();
      if (!u || !password) throw new Error("请输入用户名和密码");

      // 1) 内置管理员（.env 未配置凭据时该入口整体关闭）
      if (
        LOCAL_ADMIN_ENABLED &&
        u === LOCAL_ADMIN.username &&
        password === LOCAL_ADMIN.password
      ) {
        saveCred(u, password);
        setAuth("local-admin", {
          id: "local-admin",
          username: LOCAL_ADMIN.username,
        });
        return;
      }

      // 2) 本机注册的账号（离线可用）
      const local = localLogin(u, password);
      if (local) {
        saveCred(u, password);
        setAuth(LOCAL_TOKEN_PREFIX + local.username, {
          id: local.id,
          username: local.username,
        });
        return;
      }

      // 3) 后端账号（PocketBase 部署后）
      const r = await loginWithPassword(u, password);
      saveCred(u, password);
      setAuth(r.token, r.record);
    });

  const handleRegister = () =>
    run(async () => {
      const u = username.trim();
      if (!u) throw new Error("请输入用户名");
      if (password.length < 8) throw new Error("密码至少 8 位");
      if (password !== confirm) throw new Error("两次输入的密码不一致");

      // 1) 优先注册到云端（后端可用时，管理员后台可见）
      try {
        await registerWithPassword(u, password);
        const r = await loginWithPassword(u, password);
        saveCred(u, password);
        setAuth(r.token, r.record);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        // 2) 仅当连接不上服务器时，回退本机注册（离线可用）
        if (!/无法连接服务器|网络/.test(msg)) throw e;
        const acc = localRegister(u, password);
        saveCred(u, password);
        setAuth(LOCAL_TOKEN_PREFIX + acc.username, {
          id: acc.id,
          username: acc.username,
        });
      }
    });

  return (
    <div className="login-root">
      <div className="modern-form">
        <h2 className="form-title">
          {mode === "login" ? "欢迎回来" : "创建账号"}
        </h2>

        <div className="input-group">
          <div className="input-wrapper">
            <input
              className="form-input"
              placeholder="用户名"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <UserIcon />
          </div>
        </div>

        <div className="input-group">
          <div className="input-wrapper">
            <input
              className="form-input"
              type={showPwd ? "text" : "password"}
              placeholder="密码"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && mode === "login" && handleLogin()
              }
            />
            <LockIcon />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPwd((v) => !v)}
              title={showPwd ? "隐藏密码" : "显示密码"}
            >
              <EyeIcon open={showPwd} />
            </button>
          </div>
        </div>

        {mode === "register" && (
          <div className="input-group">
            <div className="input-wrapper">
              <input
                className="form-input"
                type={showPwd ? "text" : "password"}
                placeholder="确认密码"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRegister()}
              />
              <LockIcon />
            </div>
          </div>
        )}

        <button
          className="submit-button"
          disabled={busy}
          onClick={mode === "login" ? handleLogin : handleRegister}
        >
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          <span className="button-glow" />
        </button>

        {error && <div className="login-error">{error}</div>}

        <div className="form-footer">
          {mode === "login" ? (
            <a
              className="login-link"
              onClick={(e) => {
                e.preventDefault();
                setMode("register");
                setError("");
              }}
            >
              还没有账号？<span>立即注册</span>
            </a>
          ) : (
            <a
              className="login-link"
              onClick={(e) => {
                e.preventDefault();
                setMode("login");
                setError("");
              }}
            >
              已有账号？<span>去登录</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
