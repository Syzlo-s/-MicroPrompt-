// 轻提词 · 发布前置检查（构建/打包前跑一遍）
// 用法： node scripts/preflight.mjs        （在 轻提词V4.0 目录下）
//
// 为什么需要它：
//   4.0.2 起，登录凭据（Casdoor）与 AI 服务地址都改成从 .env 注入（Vite 构建期注入）。
//   .env 被 .gitignore 忽略、只存在本机 —— 换台电脑构建会得到「能编译、能安装，
//   但登录凭据为空、AI 地址缺失」的包，装完才发现就晚了。
//   这个脚本在构建前把这些坑和版本号不一致一次性查出来。

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
const has = (p) => existsSync(resolve(ROOT, p));

let fail = 0;
let warn = 0;
const ok = (m) => console.log("  [OK]   " + m);
const bad = (m) => {
  fail++;
  console.log("  [FAIL] " + m);
};
const soft = (m) => {
  warn++;
  console.log("  [WARN] " + m);
};

console.log("轻提词 发布前置检查");
console.log("=".repeat(64));

/* ---------- 1. .env 与登录/AI 配置 ---------- */
console.log("[1] .env 与构建期配置");
const envPath = resolve(ROOT, ".env");
if (!has(".env")) {
  bad("缺少 .env：登录凭据与 AI 地址都注入不进去，构建出来的包无法登录");
  console.log("        处理：cp .env.example .env 并填好 VITE_* 各项");
} else {
  const env = read(".env");
  const need = [
    ["VITE_CASDOOR_URL", "Casdoor 地址（登录用）"],
    ["VITE_CASDOOR_CLIENT_ID", "Casdoor CLIENT_ID（登录用）"],
    ["VITE_CASDOOR_CLIENT_SECRET", "Casdoor CLIENT_SECRET（登录用）"],
    ["VITE_AI_URL", "AI 中转服务地址（额度/会员用）"],
  ];
  for (const [key, desc] of need) {
    const m = env.match(new RegExp("^\\s*" + key + "\\s*=\\s*(.*)$", "m"));
    if (!m || !m[1].trim()) bad(key + " 未配置（" + desc + "）");
    else ok(key + " = " + m[1].trim());
  }
  // 4.0.3 起已移除「本机离线账号 / 内置管理员」，VITE_LOCAL_ADMIN_* 不再需要
  if (/\bVITE_LOCAL_ADMIN_(USER|PASSWORD)\s*=\s*\S/.test(env)) {
    soft("检测到已废弃的 VITE_LOCAL_ADMIN_*（4.0.3 起不再使用，可从 .env 删除）");
  }
  if (/VITE_AI_URL\s*=\s*http:\/\/127\.0\.0\.1/.test(env)) {
    soft("VITE_AI_URL 指向本机地址（127.0.0.1）—— 别把这个包发给用户");
  }
}

/* ---------- 2. 版本号是否全部一致 ---------- */
console.log("[2] 版本号一致性");
const versions = {};
const pick = (p, re) => {
  try {
    const m = read(p).match(re);
    return m ? m[1] : null;
  } catch {
    return null;
  }
};
// 客户端 6 处必须完全一致（这 6 处决定安装包与「关于」页显示什么）
versions["package.json"] = pick("package.json", /"version"\s*:\s*"([^"]+)"/);
versions["tauri.conf.json"] = pick("src-tauri/tauri.conf.json", /"version"\s*:\s*"([^"]+)"/);
versions["Cargo.toml"] = pick("src-tauri/Cargo.toml", /^version\s*=\s*"([^"]+)"/m);
versions["setup.iss(MyAppVersion)"] = pick("src-tauri/inno/setup.iss", /MyAppVersion\s+"([^"]+)"/);
versions["关于页"] = pick("src/components/SettingsDialog.tsx", /轻提词 测试 ([0-9.]+)/);
versions["欢迎页"] = pick("src/components/WelcomeScreen.tsx", /当前版本：测试 ([0-9.]+)/);
// ai_server.py 里版本是常量 VERSION = "x.y.z"（/ai/health 上报的就是它），
// 旧正则 /version="…"/ 匹配的是带引号的字面量，永远取不到值（会静默显示 null）。
// 4.1.2 起服务端是**独立**版本号：服务端可以单独发版（例如只改后台与接口，
// 桌面端仍是 4.1.1、用户不用重装），所以只要求它不落后于客户端。
const serverVersion = pick("server_ai/ai_server.py", /^VERSION\s*=\s*"([^"]+)"/m);
const uniq = Array.from(new Set(Object.values(versions).filter(Boolean)));
for (const [k, v] of Object.entries(versions)) console.log("         " + k.padEnd(24) + v);
console.log("         " + "ai_server(health)".padEnd(24) + serverVersion + "   ← 服务端独立版本");
if (uniq.length === 1) ok("客户端 6 处一致：" + uniq[0]);
else bad("客户端版本号不一致：" + uniq.join(" / ") + " —— 改版本号要同步这 6 处");
const vcmp = (a, b) => {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
};
if (!serverVersion) bad("取不到 server_ai/ai_server.py 里的 VERSION 常量");
else if (uniq.length === 1 && vcmp(serverVersion, uniq[0]) < 0) {
  bad("服务端版本 " + serverVersion + " 落后于客户端 " + uniq[0] + "（客户端会用到服务端的新接口）");
} else if (uniq.length === 1) {
  ok("服务端版本 " + serverVersion + "（可独立发版，不落后于客户端即可）");
}
const issName = pick("src-tauri/inno/setup.iss", /OutputBaseFilename=([^\r\n]+)/);
if (issName && uniq.length === 1 && !issName.includes(uniq[0])) {
  bad("安装包输出文件名与版本不一致：" + issName);
} else if (issName) ok("安装包输出名：" + issName);

/* ---------- 3. 打包所需文件 ---------- */
console.log("[3] 打包所需文件");
const must = [
  ["src-tauri/inno/setup.iss", "Inno 安装脚本"],
  ["src-tauri/icons/icon.ico", "安装包图标"],
  ["server_ai/ai_server.py", "AI 服务端"],
  ["server_ai/admin_cli.py", "管理员命令行"],
  ["server_ai/selfcheck.py", "部署自检"],
  ["server_ai/admin_ui.html", "管理后台界面源文件"],
  ["server_ai/sync_admin_page.py", "后台界面注入脚本"],
];
for (const [p, d] of must) (has(p) ? ok(p) : bad("缺少 " + p + "（" + d + "）"));
// 含中文的构建脚本必须是 UTF-8 with BOM：
//   没有 BOM 时 Windows PowerShell 5.1 按 GBK(936) 读，中文注释会“吃掉”换行，
//   脚本直接被解析坏（build.ps1 踩过一次；sign.ps1 被编辑器吃掉过一次 BOM）。
//   任何工具改完这些文件都要回来跑一遍本检查。
const bomFiles = [
  ["src-tauri/inno/setup.iss", "中文应用名/输出文件名会变乱码"],
  ["build.ps1", "PowerShell 5.1 会按 GBK 读 → 中文吃掉换行、脚本解析失败"],
  ["scripts/sign.ps1", "同上"],
];
for (const [p, why] of bomFiles) {
  if (!has(p)) continue; // 文件缺失已在上面的 must 列表里报过
  try {
    const buf = readFileSync(resolve(ROOT, p));
    const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const nonAscii = /[^\x00-\x7F]/.test(buf.toString("utf8"));
    if (bom) ok(p + " 是 UTF-8 with BOM");
    else if (!nonAscii) ok(p + " 全 ASCII（无需 BOM）");
    else bad(p + " 丢了 BOM —— " + why);
  } catch {
    /* 上面已报缺失 */
  }
}

/* ---------- 4. 线上 AI 服务是否已经是新版 ---------- */
console.log("[4] 线上 AI 服务端版本（是否与客户端同版本）");
let aiUrl = null;
try {
  const m = read(".env").match(/^\s*VITE_AI_URL\s*=\s*(.*)$/m);
  aiUrl = m && m[1].trim();
} catch {
  /* .env 缺失已上报 */
}
if (!aiUrl) {
  soft("没有 VITE_AI_URL，跳过线上检查");
} else {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(aiUrl.replace(/\/$/, "") + "/ai/health", { signal: ctrl.signal });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.version) {
      ok("线上 AI 服务版本：" + d.version + (d.mock ? "（mock 模式！）" : ""));
      if (d.mock) soft("线上服务处于 MP_MOCK 模式：不会真的调用 DeepSeek，别对外发布");
    } else {
      soft(
        "线上 /ai/health 返回 HTTP " + r.status + " —— 多半还是 4.0.0 旧版（旧版没有该接口）；" +
          "客户端会把老服务端识别为「服务端旧版本」，额度与会员暂不可用",
      );
      soft("部署：见 server_ai/README_部署.md 第二节，部署后跑 python3 selfcheck.py 确认");
    }
  } catch {
    soft("连不上 " + aiUrl + "/ai/health —— 服务未启动 / 端口不通 / 地址不对");
  } finally {
    clearTimeout(t);
  }
}

console.log("=".repeat(64));
console.log(
  fail === 0
    ? "结论：可以构建（" + (warn ? warn + " 条提醒请留意" : "无提醒") + "）"
    : "结论：有 " + fail + " 项必须先处理，否则打出来的包会出问题",
);
process.exit(fail === 0 ? 0 : 1);
