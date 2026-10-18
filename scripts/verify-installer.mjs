// 轻提词 · 安装包真机验证（打完包必须跑一遍）
// 用法： node scripts/verify-installer.mjs [安装包路径]
//
// 为什么需要它：
//   4.1.8 发版时踩过两次坑，都是「只验证主程序 exe 查不出来」的：
//     1) 第一次 `npm run tauri build` 出来的 NSIS 包是坏的 —— 静默安装（/S）什么都不装、
//        退出码还是 0；手动双击则报「无法打开要写入的文件: <安装目录>\microprompt-v4.exe」。
//     2) 换 Inno Setup 路线（项目历史上一直用的那条）才拿到稳定的包。
//   所以脚本必须**真的装一次**、启动一次、卸载一次。四件事：
//     1) 静默安装到临时目录（ASCII 路径）
//     2) 核对装出来的 exe 版本号 == tauri.conf.json 里的版本
//     3) 启动它（走 WebView2 的 CDP），核对：界面渲染出来了 / Tauri 运行期在 /
//        加载的前端 bundle 文件名与 dist/ 里刚构建的一致（证明新界面真的进了包）/ 无 JS 异常
//     4) 卸载，并把机器上原有的卸载注册表项还原（不破坏用户已装的版本）
//
//   两种安装包都支持：Inno Setup（release\installer\轻提词安装包_v*.exe）与
//   Tauri 自带的 NSIS（<target>\release\bundle\nsis\轻提词_*_x64-setup.exe），
//   静默参数、主程序名、卸载程序名都不一样，脚本会自动识别。
//
//   退出码 0 = 安装包可用；非 0 = 别发出去。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');

let fail = 0;
const ok = (m) => console.log('  [PASS] ' + m);
const bad = (m) => { fail++; console.log('  [FAIL] ' + m); };
const info = (m) => console.log('         ' + m);

/* ---------- 0. 找安装包与期望版本 ---------- */
const version = (read('src-tauri/tauri.conf.json').match(/"version"\s*:\s*"([^"]+)"/) || [])[1];
if (!version) { console.error('读不到 tauri.conf.json 的版本号'); process.exit(2); }

const targetRoot = process.env.CARGO_TARGET_DIR || path.join(ROOT, 'src-tauri', 'target');
const candidates = [
  process.argv[2],
  path.join(ROOT, 'release', 'installer', `轻提词安装包_v${version}.exe`),          // Inno（首选：历史发布路线）
  path.join(targetRoot, 'release', 'bundle', 'nsis', `轻提词_${version}_x64-setup.exe`), // NSIS
].filter(Boolean);

const setup = candidates.find((p) => fs.existsSync(p));
console.log('轻提词 安装包验证');
console.log('='.repeat(64));
if (!setup) {
  console.error('找不到安装包，试过：\n  ' + candidates.join('\n  '));
  process.exit(2);
}

// 看名字判断是哪条路线：Inno 输出叫 轻提词安装包_v<x>.exe，NSIS 叫 轻提词_<x>_x64-setup.exe
const isNsis = /_x64-setup\.exe$/i.test(setup) || /bundle[\\/]nsis/i.test(setup);
const kind = isNsis ? 'NSIS（Tauri 自带打包器）' : 'Inno Setup';
const silentArgs = isNsis ? ['/S'] : ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
const dirArg = (d) => (isNsis ? `/D=${d}` : `/DIR=${d}`);
const setupSize = fs.statSync(setup).size;
const setupMd5 = (spawnSync('certutil', ['-hashfile', setup, 'MD5'], { encoding: 'utf8' }).stdout || '')
  .split(/\r?\n/)[1]?.replace(/\s/g, '') || '';
info('安装包: ' + setup);
info('类型: ' + kind);
info('大小: ' + setupSize + ' 字节   MD5: ' + setupMd5);
info('期望版本: ' + version);

/* ---------- 1. 备份并摘掉原有的卸载注册表项（装完要还原） ---------- */
// 两种路线的注册表键不一样；测试前都摘掉，让安装程序看到一台"干净"的机器。
// （NSIS 模板在 /S 静默模式下遇到「同版本已安装」会走维护流程、什么都不装且退出码为 0，
//   不摘掉的话这个脚本会误报，见 installer.nsi 的 PageReinstall/PageLeaveReinstall。）
const UNINST_BASE = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';
const KEYS = [UNINST_BASE + '轻提词', UNINST_BASE + '{8D7B2C9A-1F3E-4A6B-9C2D-5E6F7A8B9C0D}_is1'];
const backups = [];
for (const k of KEYS) {
  const exists = spawnSync('reg', ['query', k], { encoding: 'utf8' }).status === 0;
  if (!exists) continue;
  const f = path.join(os.tmpdir(), 'mp-uninst-' + (backups.length + 1) + '.reg');
  spawnSync('reg', ['export', k, f, '/y'], { encoding: 'utf8' });
  spawnSync('reg', ['delete', k, '/f'], { encoding: 'utf8' });
  backups.push(f);
  info('已备份并暂时摘掉已有安装的卸载项: ' + k);
}
if (!backups.length) info('机器上原本没有「轻提词」安装，这次是全新安装');

const restoreKeys = () => {
  for (const f of backups) spawnSync('reg', ['import', f], { encoding: 'utf8' });
};

/* ---------- 1.5 备份「轻提词」快捷方式（4.7.0 才发现：这个测试会顺手删掉用户桌面那份） ----------
   安装包和用户机器上的正式安装共用同一个 AppId，{autodesktop}\轻提词.lnk 是同一个路径：
   测试安装会先创建它（指向临时目录），卸载时又把它删掉 —— 连用户原来那份一起没了。
   这里先按字节备份，跑完原样还原。 */
const shellLnkPaths = (() => {
  const q = (cmd) => (spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout || '').trim();
  const desk = q("[Environment]::GetFolderPath('Desktop')");
  const appdata = q("[Environment]::GetFolderPath('ApplicationData')");
  const progdata = process.env.ProgramData || 'C:\\ProgramData';
  const out = [];
  if (desk) out.push(path.join(desk, '轻提词.lnk'));
  out.push(path.join(progdata, 'Desktop', '轻提词.lnk'));
  if (appdata) out.push(path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', '轻提词', '轻提词.lnk'));
  out.push(path.join(progdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', '轻提词', '轻提词.lnk'));
  return [...new Set(out)];
})();
const lnkBackups = [];
for (const p of shellLnkPaths) {
  const exists = fs.existsSync(p);
  const bak = path.join(os.tmpdir(), 'mp-lnk-' + lnkBackups.length + '.lnk');
  if (exists) fs.copyFileSync(p, bak);
  lnkBackups.push({ path: p, exists, bak });
}
const hadLnks = lnkBackups.filter((b) => b.exists).length;
info('记录了 ' + hadLnks + ' 个「轻提词」快捷方式（测试结束后会还原）');

const restoreShortcuts = () => {
  for (const b of lnkBackups) {
    try {
      if (b.exists) {
        const same = fs.existsSync(b.path) && fs.readFileSync(b.path).equals(fs.readFileSync(b.bak));
        if (!same) {
          fs.mkdirSync(path.dirname(b.path), { recursive: true });
          fs.copyFileSync(b.bak, b.path);
        }
      } else if (fs.existsSync(b.path)) {
        fs.rmSync(b.path, { force: true });
      }
    } catch (e) {
      info('快捷方式还原失败 ' + b.path + '：' + e.message);
    }
  }
  if (hadLnks) ok('原有的桌面 / 开始菜单快捷方式已还原（' + hadLnks + ' 个）');
};

/* ---------- 2. 静默安装到临时目录 ---------- */
const DIR = path.join(os.tmpdir(), 'mp-installer-verify');
console.log('[1] 静默安装到 ' + DIR);
fs.rmSync(DIR, { recursive: true, force: true });
const inst = spawnSync(setup, [...silentArgs, dirArg(DIR)], { windowsHide: true, timeout: 180000 });
info('安装程序退出码: ' + inst.status);
if (inst.error) bad('安装程序没能启动: ' + inst.error.message);

const exeNames = ['轻提词.exe', 'microprompt-v4.exe'];
const exeName = exeNames.find((n) => fs.existsSync(path.join(DIR, n)));
if (!exeName) {
  bad('安装目录里没有主程序 —— 这个安装包是坏的（4.1.8 的 NSIS 包就是这个症状）');
  restoreKeys();
  restoreShortcuts();
  console.log('='.repeat(64));
  console.log('结论：安装包不可用，别发出去');
  process.exit(1);
}
const exe = path.join(DIR, exeName);
ok('静默安装成功，文件已落盘（' + exeName + '）');

/* ---------- 3. 版本号 ---------- */
console.log('[2] 装出来的版本');
const psVer = spawnSync('powershell', ['-NoProfile', '-Command',
  `(Get-Item -LiteralPath '${exe}').VersionInfo.FileVersion`], { encoding: 'utf8' }).stdout?.trim();
if ((psVer || '').includes(version)) ok('FileVersion = ' + psVer);
else bad('FileVersion = ' + psVer + '，期望 ' + version);

/* ---------- 4. 启动 + CDP 核对界面 ---------- */
console.log('[3] 启动真机并核对界面');
const PORT = 9225;
const distAssets = path.resolve(ROOT, 'dist', 'assets');
const expectJs = fs.existsSync(distAssets) ? fs.readdirSync(distAssets).filter((f) => f.endsWith('.js')) : [];
const expectCss = fs.existsSync(distAssets) ? fs.readdirSync(distAssets).filter((f) => f.endsWith('.css')) : [];

const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --no-proxy-server` },
  stdio: 'ignore', windowsHide: false,
});

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  if (app.exitCode !== null) { bad('应用启动后立刻退出（exit ' + app.exitCode + '）'); break; }
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* 还没起来 */ }
}

if (target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map(); const exceptions = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id; pend.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error('timeout ' + method)); } }, 15000);
  });
  await send('Runtime.enable');
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  await sleep(4000);
  const d = JSON.parse(await ev(`JSON.stringify({
    title: document.title,
    scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')),
    styles: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.getAttribute('href')),
    tauri: typeof window.__TAURI_INTERNALS__ === 'object',
    nodes: document.querySelectorAll('*').length
  })`));

  if (/轻提词/.test(d.title || '')) ok('窗口标题：' + d.title); else bad('窗口标题不对：' + d.title);
  if (d.tauri) ok('Tauri 运行期可用'); else bad('没有 __TAURI_INTERNALS__（不是真的桌面端）');
  if (d.nodes > 50) ok('界面渲染出来了（' + d.nodes + ' 个 DOM 节点）'); else bad('界面几乎是空的（' + d.nodes + ' 个节点）');
  if (!expectJs.length) info('dist/assets 里没有 js，跳过 bundle 比对（先跑一次 npm run build）');
  else if (expectJs.some((f) => (d.scripts || []).some((s) => s.includes(f)))) ok('加载的前端就是刚构建的那份（' + expectJs.join(', ') + '）');
  else bad('加载的前端与 dist/ 不一致：' + (d.scripts || []).join(' '));
  if (expectCss.length && expectCss.some((f) => (d.styles || []).some((s) => s.includes(f)))) ok('样式表也是刚构建的那份');
  else if (expectCss.length) bad('样式表与 dist/ 不一致：' + (d.styles || []).join(' '));
  if (exceptions.length === 0) ok('运行期没有 JS 异常'); else bad('运行期有 JS 异常：' + exceptions.slice(0, 3).join(' | '));
  ws.close();
} else if (app.exitCode === null) {
  bad('连不上 WebView2 的调试端口，无法核对界面');
}

app.kill();
await sleep(1200);

/* ---------- 5. 卸载 + 还原原有注册表项 ---------- */
console.log('[4] 卸载测试安装');
const un = ['unins000.exe', 'uninstall.exe']
  .map((n) => path.join(DIR, n))
  .find((p) => fs.existsSync(p));
if (un) {
  spawnSync(un, isNsis ? ['/S'] : ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true, timeout: 120000 });
  await sleep(3000);
}
if (!fs.existsSync(DIR)) ok('卸载干净了');
else {
  fs.rmSync(DIR, { recursive: true, force: true });
  info('卸载程序留下了残留，已手动清理');
}
for (const k of KEYS) spawnSync('reg', ['delete', k, '/f'], { encoding: 'utf8' });
if (backups.length) {
  restoreKeys();
  const back = KEYS.some((k) => spawnSync('reg', ['query', k], { encoding: 'utf8' }).status === 0);
  if (back) ok('机器上原有的「轻提词」卸载项已还原');
  else bad('原有卸载项还原失败，请看 ' + backups.join(' / '));
} else {
  ok('机器上原本没有「轻提词」安装，测试痕迹已清空');
}
restoreShortcuts();

console.log('='.repeat(64));
console.log(fail === 0
  ? '结论：安装包可用（真机装过、启动过、界面与版本都对）'
  : '结论：有 ' + fail + ' 项没过，别发这个包');
process.exit(fail === 0 ? 0 : 1);
