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
  for (const [key, desc] of [
    ["VITE_LOCAL_ADMIN_USER", "内置管理员账号"],
    ["VITE_LOCAL_ADMIN_PASSWORD", "内置管理员密码"],
  ]) {
    const m = env.match(new RegExp("^\\s*" + key + "\\s*=\\s*(.*)$", "m"));
    if (!m || !m[1].trim()) soft(key + " 未配置 —— 内置管理员登录会被禁用（" + desc + "）");
    else ok(key + " 已配置");
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
versions["package.json"] = pick("package.json", /"version"\s*:\s*"([^"]+)"/);
versions["tauri.conf.json"] = pick("src-tauri/tauri.conf.json", /"version"\s*:\s*"([^"]+)"/);
versions["Cargo.toml"] = pick("src-tauri/Cargo.toml", /^version\s*=\s*"([^"]+)"/m);
versions["setup.iss(MyAppVersion)"] = pick("src-tauri/inno/setup.iss", /MyAppVersion\s+"([^"]+)"/);
versions["关于页"] = pick("src/components/SettingsDialog.tsx", /轻提词 测试 ([0-9.]+)/);
versions["欢迎页"] = pick("src/components/WelcomeScreen.tsx", /当前版本：测试 ([0-9.]+)/);
versions["ai_server(health)"] = pick("server_ai/ai_server.py", /version="([^"]+)"/);
const uniq = Array.from(new Set(Object.values(versions).filter(Boolean)));
for (const [k, v] of Object.entries(versions)) console.log("         " + k.padEnd(24) + v);
if (uniq.length === 1) ok("全部一致：" + uniq[0]);
else bad("版本号不一致：" + uniq.join(" / ") + " —— 改版本号要同步这 7 处");
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
];
for (const [p, d] of must) (has(p) ? ok(p) : bad("缺少 " + p + "（" + d + "）"));
// setup.iss 必须是 UTF-8 with BOM，否则中文应用名/输出文件名会乱码
try {
  const buf = readFileSync(resolve(ROOT, "src-tauri/inno/setup.iss"));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ok("setup.iss 是 UTF-8 with BOM");
  else bad("setup.iss 丢了 BOM —— 中文（应用名/输出文件名）会变乱码");
} catch {
  /* 上面已报缺失 */
}

/* ---------- 4. 线上 AI 服务是否已经是新版 ---------- */
console.log("[4] AI 服务端版本（看线上是否已部署 4.0.2）");
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
