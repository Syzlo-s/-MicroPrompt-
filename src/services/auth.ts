/* ============================================================
 * Casdoor 认证封装（纯前端 fetch）
 *   - 自托管 Casdoor（中文后台，端口 8000）
 *   - 用户名 + 密码 注册 / 登录（OAuth2 password grant）
 *   - 管理员可在 Casdoor 后台重置用户密码
 *   - 短信验证码暂不启用
 * ============================================================ */

/** Casdoor 服务地址。真实地址写在项目根目录 .env（VITE_CASDOOR_URL），
 *  模板见 .env.example；源码内不留真实服务器地址与凭据。 */
export const CASDOOR_URL = (
  (import.meta.env.VITE_CASDOOR_URL as string | undefined) ||
  "http://127.0.0.1:2580"
).replace(/\/+$/, "");
/** Casdoor 应用凭据（对应后台应用 app-microprompt，配置在 .env） */
const CLIENT_ID =
  (import.meta.env.VITE_CASDOOR_CLIENT_ID as string | undefined) || "";
const CLIENT_SECRET =
  (import.meta.env.VITE_CASDOOR_CLIENT_SECRET as string | undefined) || "";
/** 应用名 / 组织名 */
const APP_NAME = "app-microprompt";
const ORG_NAME = "microprompt";

export interface AuthUser {
  id: string;
  username?: string;
  phone?: string;
  email?: string;
  [key: string]: unknown;
}

export interface AuthResponse {
  token: string;
  record: AuthUser;
}

/** 本地内置管理员账号（离线可用；凭据配置在 .env，未配置时该登录入口关闭） */
const LOCAL_ADMIN_USER =
  (import.meta.env.VITE_LOCAL_ADMIN_USER as string | undefined) || "";
const LOCAL_ADMIN_PASSWORD =
  (import.meta.env.VITE_LOCAL_ADMIN_PASSWORD as string | undefined) || "";
export const LOCAL_ADMIN = {
  username: LOCAL_ADMIN_USER,
  password: LOCAL_ADMIN_PASSWORD,
};
/** 未配置 .env 时禁用内置管理员登录，避免出现"空用户名/空密码可登录"的默认账号 */
export const LOCAL_ADMIN_ENABLED = Boolean(
  LOCAL_ADMIN_USER && LOCAL_ADMIN_PASSWORD,
);
export const LOCAL_ADMIN_TOKEN = "local-admin";

/** 解析 JWT payload（Casdoor 的 access_token） */
function parseJwt(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 从 Casdoor token 里取出用户名（payload.name） */
function usernameFromToken(token: string, fallback: string): string {
  const p = parseJwt(token);
  const name = typeof p.name === "string" ? p.name : "";
  if (name) return name;
  const sub = typeof p.sub === "string" ? p.sub : "";
  return sub.split("/").pop() || fallback;
}

/** 从 Casdoor token 里取出用户 id */
function idFromToken(token: string, fallback: string): string {
  const p = parseJwt(token);
  return typeof p.id === "string" && p.id ? p.id : fallback;
}

/** 注册（用户名 + 密码）。成功返回该用户信息 */
export async function registerWithPassword(
  username: string,
  password: string,
): Promise<AuthUser> {
  let res: Response;
  try {
    res = await fetch(`${CASDOOR_URL}/api/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        application: APP_NAME,
        organization: ORG_NAME,
        username,
        password,
      }),
    });
  } catch {
    throw new Error("无法连接服务器，请检查网络或服务器地址");
  }
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    msg?: string;
    data?: string;
  };
  if (data.status !== "ok") {
    throw new Error(data.msg || "注册失败");
  }
  const id = typeof data.data === "string" ? data.data : username;
  return { id, username };
}

/** 用户名 + 密码登录（OAuth2 password grant） */
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    username,
    password,
    scope: "read",
  });
  let res: Response;
  try {
    res = await fetch(`${CASDOOR_URL}/api/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    throw new Error("无法连接服务器，请检查网络或服务器地址");
  }
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "用户名或密码错误",
    );
  }
  const name = usernameFromToken(data.access_token, username);
  const id = idFromToken(data.access_token, name);
  return { token: data.access_token, record: { id, username: name } };
}

/** 用已保存的 token 校验登录态（Casdoor /api/get-account） */
export async function authRefresh(token: string): Promise<AuthResponse> {
  let res: Response;
  try {
    res = await fetch(`${CASDOOR_URL}/api/get-account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error("无法连接服务器，请检查网络或服务器地址");
  }
  if (!res.ok) throw new Error("登录已过期");
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    data?: { id?: string; name?: string; username?: string };
  };
  if (data.status !== "ok" || !data.data) throw new Error("登录已过期");
  const rec = data.data;
  const name = rec.name || rec.username || usernameFromToken(token, "");
  return { token, record: { ...rec, id: rec.id || name, username: name } };
}

/**
 * 上传头像文件到 Casdoor（/api/upload-resource），返回图片 URL。
 * @param token 当前登录用户的 access_token
 * @param file  头像图片文件
 */
export async function uploadAvatar(token: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("owner", ORG_NAME);
  form.append("tag", "avatar");
  form.append("application", APP_NAME);

  let res: Response;
  try {
    res = await fetch(`${CASDOOR_URL}/api/upload-resource`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    throw new Error("无法连接服务器，请检查网络或服务器地址");
  }
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    msg?: string;
    data?: string;
  };
  if (data.status !== "ok" || !data.data) {
    throw new Error(data.msg || "头像上传失败");
  }
  return data.data;
}

/**
 * 更新当前用户的 Casdoor 资料（显示名 displayName、头像 avatar URL）。
 * 先拉取当前用户对象，合并后调用 /api/update-user，避免覆盖其它字段。
 */
export async function updateProfile(
  token: string,
  patch: { displayName?: string; avatar?: string },
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${CASDOOR_URL}/api/get-account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error("无法连接服务器，请检查网络或服务器地址");
  }
  const acc = (await res.json().catch(() => ({}))) as {
    status?: string;
    data?: Record<string, unknown>;
  };
  if (acc.status !== "ok" || !acc.data) {
    throw new Error("无法获取用户信息");
  }
  const user = acc.data;
  if (patch.displayName) user.displayName = patch.displayName;
  if (patch.avatar) user.avatar = patch.avatar;

  let up: Response;
  try {
    up = await fetch(`${CASDOOR_URL}/api/update-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(user),
    });
  } catch {
    throw new Error("无法连接服务器，请检查网络或服务器地址");
  }
  const data = (await up.json().catch(() => ({}))) as {
    status?: string;
    msg?: string;
  };
  if (data.status !== "ok") {
    throw new Error(data.msg || "更新失败");
  }
}
