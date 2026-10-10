/* ============================================================
 * 离线临时账号系统（过渡用）
 *   - 账号存本机 localStorage，不依赖后端
 *   - 登录 token 以 "local:" 前缀标识，restoreAuth 直接放行
 *   - 后端就绪后，把注册/登录切回 PocketBase 即可，界面不变
 * ============================================================ */

export interface LocalAccount {
  id: string;
  username: string;
  password: string;
}

const KEY = "microprompt.localAccounts";
export const LOCAL_TOKEN_PREFIX = "local:";

function loadAll(): Record<string, LocalAccount> {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object"
      ? (obj as Record<string, LocalAccount>)
      : {};
  } catch {
    return {};
  }
}

function saveAll(map: Record<string, LocalAccount>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function localRegister(
  username: string,
  password: string,
): LocalAccount {
  const map = loadAll();
  if (map[username]) throw new Error("该用户名已被注册");
  const acc: LocalAccount = {
    id: "local-" + Date.now().toString(36),
    username,
    password,
  };
  map[username] = acc;
  saveAll(map);
  return acc;
}

export function localLogin(
  username: string,
  password: string,
): LocalAccount | null {
  const acc = loadAll()[username];
  if (!acc || acc.password !== password) return null;
  return acc;
}

/** 修改本机账号的用户名 / 密码（用户名留空则不变，密码留空则不改） */
export function localUpdateAccount(
  oldUsername: string,
  patch: { username?: string; password?: string },
): LocalAccount {
  const map = loadAll();
  const acc = map[oldUsername];
  if (!acc) throw new Error("未找到当前账号，请重新登录");

  const nextName = (patch.username ?? "").trim();
  if (nextName && nextName !== oldUsername) {
    if (map[nextName]) throw new Error("该用户名已被占用");
    delete map[oldUsername];
    acc.username = nextName;
  }

  if (patch.password) {
    if (patch.password.length < 8) throw new Error("密码至少 8 位");
    acc.password = patch.password;
  }

  map[acc.username] = acc;
  saveAll(map);
  return acc;
}
