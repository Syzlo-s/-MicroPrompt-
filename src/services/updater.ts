/* ============================================================
 * 轻提词 · 在线升级（4.7.0）
 * ------------------------------------------------------------
 * 流程：
 *   1) 取清单   GET <更新源>/latest.json   （版本 / 说明 / 两个下载项 / SHA-256）
 *   2) 比版本   比当前版本新 → 提示；否则「已是最新」
 *   3) 下载     fetch + ReadableStream（有进度）→ crypto.subtle 算 SHA-256 校验
 *   4) 落盘     invoke("save_update_file")：Rust 先写 .part 再改名
 *   5) 应用     invoke("apply_update")：Rust 写更新脚本、分离启动，然后自己退出
 *              脚本等本进程退出后：
 *                · 安装版 → 静默覆盖安装（快捷方式 / 卸载注册表一起更新）
 *                · 便携版 → 旧 exe 改名留底，写入新 exe，再启动
 *
 * 更新源：`VITE_UPDATE_URL`（.env，可指向任意 http/https 目录）；
 *         不配则默认跟着 AI 服务端走 —— `<AI_URL>/updates`。
 *
 * 安全：清单里带 SHA-256，下载后**必须**比对通过才允许落盘/执行；
 *       校验不通过一律拒绝。这只防"传输损坏 / 文件被换"，真正的防篡改
 *       还得靠 HTTPS + 代码签名（见 _deploy/安装与分发_轻提词.md）。
 * ============================================================ */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { AI_URL } from "./ai";
import { showToast } from "../utils/toast";

/** 更新源（不含结尾斜杠）。三级优先级：
 *    ① localStorage["microprompt.update.base"] —— 运行期兜底（换镜像/内网测试用，不用重打包）
 *    ② .env 的 VITE_UPDATE_URL
 *    ③ <AI_URL>/updates（默认：更新包就放在 AI 服务端上）
 */
export const UPDATE_BASE = (
  localStorage.getItem("microprompt.update.base") ||
  (import.meta.env.VITE_UPDATE_URL as string | undefined) ||
  `${AI_URL}/updates`
).replace(/\/+$/, "");

export interface UpdateAsset {
  url: string;
  size?: number;
  sha256?: string;
}

export interface UpdateManifest {
  version: string;
  /** 低于这个版本必须更新（预留：强制升级用） */
  minSupported?: string;
  releasedAt?: string;
  notes?: string;
  installer?: UpdateAsset;
  exe?: UpdateAsset;
}

export interface UpdateInfo {
  version: string;
  exePath: string;
  appDir: string;
  isInstalled: boolean;
  updateDir: string;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "latest"
  | "available"
  | "downloading"
  | "ready"
  | "applying"
  | "error";

const LS_AUTO = "microprompt.update.autoCheck";
const LS_SKIP = "microprompt.update.skipped";
const LS_APPLIED = "microprompt.update.applied";

/** 下载中的字节数（用于进度条） */
export interface UpdateProgress {
  got: number;
  total: number;
}

interface UpdateStore {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  manifest: UpdateManifest | null;
  progress: UpdateProgress;
  error: string;
  /** 本次要用的下载项（按安装版 / 便携版选） */
  asset: UpdateAsset | null;
  filePath: string;
  /** 卡片是否被用户临时收起 */
  collapsed: boolean;
  autoCheck: boolean;

  loadInfo: () => Promise<UpdateInfo | null>;
  check: (opts?: { silent?: boolean }) => Promise<void>;
  download: () => Promise<void>;
  apply: () => Promise<void>;
  setAutoCheck: (on: boolean) => void;
  skipCurrent: () => void;
  dismiss: () => void;
  expand: () => void;
}

/** 4.6.0 / 4.10.2 这类点号版本比较：a > b 返回 true（忽略 -beta 之类后缀） */
export function isNewer(a: string, b: string): boolean {
  const pa = String(a).split(".").map((x) => parseInt(x.replace(/[^\d].*$/, ""), 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x.replace(/[^\d].*$/, ""), 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!crypto?.subtle) throw new Error("当前环境不支持校验（crypto.subtle 不可用），已拒绝安装");
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000; // 一次 32KB，避免 fromCharCode 参数过多
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** 带进度的 GET；返回完整字节 */
async function fetchBytes(
  url: string,
  onProgress?: (p: UpdateProgress) => void,
): Promise<Uint8Array> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}\n${url}`);
  const total = Number(res.headers.get("Content-Length") || 0);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.({ got: buf.length, total: total || buf.length });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      got += value.length;
      onProgress?.({ got, total });
    }
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 清单里的下载地址可能写成两种形式，都要能认：
 *    · 绝对地址  https://cdn.example.com/x.exe        → 原样用
 *    · 相对路径  files/轻提词_v4.7.0.exe 或 /updates/files/…  → 按「清单所在目录」解析
 *  踩过的坑：相对路径如果直接丢给 fetch()，会被当成**应用自身**的地址
 *  （http://tauri.localhost/…）而拿到 400 字节的 index.html，所以必须先解析。
 *  兜底还有一道：下载完比对 size 与 SHA-256。
 */
function resolveUrl(raw: string, manifestUrl: string): string {
  const u = String(raw || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  try {
    return new URL(u, manifestUrl).toString();
  } catch {
    return u;
  }
}

/** 起个名字方便排障：轻提词安装包_v4.7.0.exe / 轻提词_v4.7.0.exe */
function assetFileName(manifest: UpdateManifest, kind: "installer" | "exe"): string {
  const tail = kind === "installer" ? "轻提词安装包" : "轻提词";
  return `${tail}_v${manifest.version}.exe`;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  phase: "idle",
  info: null,
  manifest: null,
  progress: { got: 0, total: 0 },
  error: "",
  asset: null,
  filePath: "",
  collapsed: false,
  autoCheck: (localStorage.getItem(LS_AUTO) ?? "1") !== "0",

  loadInfo: async () => {
    try {
      const info = await invoke<UpdateInfo>("get_update_info");
      set({ info });
      return info;
    } catch (e) {
      set({ error: String((e as Error)?.message ?? e) });
      return null;
    }
  },

  check: async (opts) => {
    const silent = opts?.silent === true;
    if (get().phase === "downloading" || get().phase === "applying") return;
    set({ phase: "checking", error: "" });
    try {
      const info = get().info ?? (await get().loadInfo());
      if (!info) throw new Error("拿不到程序版本信息");
      const manifestUrl = `${UPDATE_BASE}/latest.json`;
      const res = await fetch(`${manifestUrl}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`更新源返回 HTTP ${res.status}\n${manifestUrl}`);
      const manifest = (await res.json()) as UpdateManifest;
      if (!manifest?.version) throw new Error("更新清单格式不对（缺少 version）");
      // 下载地址统一解析成可直接 fetch 的绝对地址
      if (manifest.installer?.url) manifest.installer.url = resolveUrl(manifest.installer.url, manifestUrl);
      if (manifest.exe?.url) manifest.exe.url = resolveUrl(manifest.exe.url, manifestUrl);

      if (!isNewer(manifest.version, info.version)) {
        set({ phase: "latest", manifest, asset: null, filePath: "" });
        localStorage.removeItem(LS_APPLIED);
        if (!silent) showToast({ text: `已是最新版本 ${info.version}`, tone: "success" });
        return;
      }

      // 安装版走安装包（会更新快捷方式/注册表）；便携版只换 exe
      const wantInstaller = info.isInstalled && !!manifest.installer;
      const asset = wantInstaller ? manifest.installer! : manifest.exe || manifest.installer;
      if (!asset?.url) throw new Error("更新清单里没有可用的下载地址");

      const skipped = localStorage.getItem(LS_SKIP) || "";
      set({ phase: "available", manifest, asset, filePath: "", error: "", collapsed: skipped === manifest.version });
      if (!silent && skipped === manifest.version) {
        showToast({ text: `新版本 ${manifest.version} 已忽略，可在设置 → 关于里更新`, tone: "info" });
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // 静默检查失败不打扰用户（服务器没开、断网都很正常）
      set({ phase: silent ? "idle" : "error", error: msg });
      if (!silent) showToast({ text: `检查更新失败：${msg}`, tone: "error", duration: 3600 });
    }
  },

  download: async () => {
    const { manifest, asset } = get();
    if (!manifest || !asset) return;
    set({ phase: "downloading", error: "", progress: { got: 0, total: asset.size ?? 0 } });
    try {
      const bytes = await fetchBytes(asset.url, (p) => set({ progress: p }));
      if (asset.size && bytes.length !== asset.size) {
        throw new Error(`文件大小不符：期望 ${asset.size} 字节，实际 ${bytes.length}`);
      }
      if (asset.sha256) {
        const got = await sha256Hex(bytes);
        if (got.toLowerCase() !== asset.sha256.toLowerCase()) {
          throw new Error(`校验失败（SHA-256 不匹配）\n期望 ${asset.sha256}\n实际 ${got}`);
        }
      }
      const name = assetFileName(manifest, asset === manifest.installer ? "installer" : "exe");
      const filePath = await invoke<string>("save_update_file", {
        name,
        base64: toBase64(bytes),
      });
      set({ phase: "ready", filePath, collapsed: false });
      showToast({ text: `新版本 ${manifest.version} 已下载完成`, tone: "success", duration: 3000 });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      set({ phase: "error", error: msg });
      showToast({ text: `下载更新失败：${msg}`, tone: "error", duration: 4200 });
    }
  },

  apply: async () => {
    const { manifest, filePath, info, asset } = get();
    if (!manifest || !filePath || !info) return;
    set({ phase: "applying", error: "" });
    try {
      // 记下"正在装的是哪个版本"，重启后能认出升级成功
      localStorage.setItem(LS_APPLIED, manifest.version);
      const kind = asset === manifest.installer ? "installer" : "portable";
      await invoke("apply_update", { filePath, kind, version: info.version });
      // Rust 侧 1.2 秒后退出进程，这里只负责把提示留住
      showToast({ text: "正在重启并安装更新…", tone: "info", duration: 60000 });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      localStorage.removeItem(LS_APPLIED);
      set({ phase: "error", error: msg });
      showToast({ text: `启动更新失败：${msg}`, tone: "error", duration: 4200 });
    }
  },

  setAutoCheck: (on) => {
    localStorage.setItem(LS_AUTO, on ? "1" : "0");
    set({ autoCheck: on });
  },

  skipCurrent: () => {
    const v = get().manifest?.version;
    if (v) localStorage.setItem(LS_SKIP, v);
    set({ collapsed: true });
    showToast({ text: `已忽略 ${v}，可在设置 → 关于里手动更新`, tone: "info" });
  },

  /** 「稍后」：只是收起卡片，下次启动还会提醒（不写"忽略"） */
  dismiss: () => set({ collapsed: true }),

  expand: () => set({ collapsed: false }),
}));

/** 启动时的静默检查（错过一次就等下次启动，不轮询） */
export function startUpdateWatcher(delayMs = 3000): () => void {
  const t = window.setTimeout(() => {
    void useUpdateStore
      .getState()
      .loadInfo()
      .then(() => {
        // 上一次会话点过「重启并安装」→ 看看究竟装上了没
        const applied = localStorage.getItem(LS_APPLIED);
        if (applied) {
          localStorage.removeItem(LS_APPLIED);
          const cur = useUpdateStore.getState().info?.version ?? "";
          if (cur && !isNewer(applied, cur)) {
            showToast({ text: `已更新到 ${cur}`, tone: "success", duration: 3000 });
          } else if (cur) {
            showToast({ text: `更新似乎没装上（仍是 ${cur}），可再试一次`, tone: "warn", duration: 4200 });
          }
        }
        if (!useUpdateStore.getState().autoCheck) return;
        void useUpdateStore.getState().check({ silent: true });
      });
  }, delayMs);
  return () => window.clearTimeout(t);
}

/** 供设置页 / 卡片显示用 */
export function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
