// 轻提词 · 在线升级清单生成（发版时跑）
// 用法：
//   node scripts/make-update-manifest.mjs
//   node scripts/make-update-manifest.mjs --notes "这一版改了什么…"
//   node scripts/make-update-manifest.mjs --notes-file release/notes-4.7.0.md
//
// 它做四件事：
//   1) 从 tauri.conf.json 取版本号（和 preflight 核对的那 6 处同源）
//   2) 找齐两份产物：安装包（release/installer/轻提词安装包_v<版本>.exe）
//                    便携版（release/轻提词.exe）
//   3) 算 size + SHA-256，写成 server_ai/updates/latest.json
//      并把两份产物复制到 server_ai/updates/files/（目录可直接 scp 上服务器）
//   4) 打印部署命令与在服务端的核对方法
//
// 为什么要有 SHA-256：客户端下载后必须比对通过才允许安装（updater.ts），
// 清单和文件都在同一个 HTTP 响应里，所以这是"防传输损坏 / 防文件被换"，
// 真正的防篡改还得靠 HTTPS + 代码签名。
//
// 退出码 0 = 清单已生成；非 0 = 产物不齐，别发版。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');
const ok = (m) => console.log('  [OK]   ' + m);
const bad = (m) => console.log('  [FAIL] ' + m);
const info = (m) => console.log('         ' + m);

/* ---------- 1. 版本 ---------- */
const version = (read('src-tauri/tauri.conf.json').match(/"version"\s*:\s*"([^"]+)"/) || [])[1];
if (!version) {
  console.error('读不到 src-tauri/tauri.conf.json 的版本号');
  process.exit(2);
}

/* ---------- 2. 说明文字 ---------- */
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
let notes = argOf('--notes');
const notesFile = argOf('--notes-file');
if (!notes && notesFile) {
  const p = path.resolve(ROOT, notesFile);
  if (fs.existsSync(p)) notes = fs.readFileSync(p, 'utf8').trim();
  else info(`提示：说明文件不存在（${notesFile}），notes 留空`);
}

/* ---------- 3. 产物 ---------- */
const relInstaller = path.join('release', 'installer', `轻提词安装包_v${version}.exe`);
const relExe = path.join('release', '轻提词.exe');
const absInstaller = path.resolve(ROOT, relInstaller);
const absExe = path.resolve(ROOT, relExe);

let fail = 0;
for (const [label, abs, rel] of [['安装包', absInstaller, relInstaller], ['便携版 exe', absExe, relExe]]) {
  if (fs.existsSync(abs)) ok(`${label}：${rel}`);
  else { bad(`${label} 不存在：${rel}`); fail++; }
}
if (fail) {
  info('先把产物准备好：npm run build:checked → 打包（见 README「构建发布」），再跑本脚本');
  process.exit(1);
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const stat = (p) => fs.statSync(p).size;

const installer = { size: stat(absInstaller), sha256: sha256(absInstaller) };
const exe = { size: stat(absExe), sha256: sha256(absExe) };

/* ---------- 4. 落盘（清单 + files/） ---------- */
const updatesDir = path.resolve(ROOT, 'server_ai', 'updates');
const filesDir = path.join(updatesDir, 'files');
fs.mkdirSync(filesDir, { recursive: true });

const installerName = path.basename(absInstaller);   // 轻提词安装包_v4.7.0.exe
const exeName = `轻提词_v${version}.exe`;            // 服务端统一按 "轻提词_v<版本>.exe" 存
fs.copyFileSync(absInstaller, path.join(filesDir, installerName));
fs.copyFileSync(absExe, path.join(filesDir, exeName));

const manifest = {
  version,
  releasedAt: new Date().toISOString().slice(0, 10),
  notes: notes || `轻提词 ${version}`,
  // 下载地址写**相对清单所在目录**的路径（files/xxx.exe）：换域名、换机器、
  // 放到别的子目录都不用重新生成。客户端也认绝对 http(s) 地址。
  installer: { url: `files/${installerName}`, size: installer.size, sha256: installer.sha256 },
  exe: { url: `files/${exeName}`, size: exe.size, sha256: exe.sha256 },
};
const manifestPath = path.join(updatesDir, 'latest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('');
ok(`清单已写出：server_ai/updates/latest.json`);
ok(`安装包 ${installer.size} 字节  sha256 ${installer.sha256}`);
ok(`便携版 ${exe.size} 字节  sha256 ${exe.sha256}`);
console.log('');
info('部署（把整个 updates/ 目录 scp 到服务器 server_ai/ 下）：');
info('  scp -r server_ai/updates root@<服务器>:/opt/microprompt/server_ai/');
info('  # 或自定义位置： MP_UPDATES_DIR=/srv/mp-updates python3 ai_server.py');
console.log('');
info('核对（不用登录）：');
info('  curl -s http://<服务器>:2581/updates/latest.json | head -c 300');
info('  curl -sI http://<服务器>:2581/updates/files/' + installerName);
console.log('');
info('注意：客户端只在「清单里的版本 > 当前版本」时才提示更新，');
info('      发版后把版本号 6 处一起升（npm run preflight 会核对）。');
