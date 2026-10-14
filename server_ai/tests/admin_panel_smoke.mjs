// 管理后台 /admin 面板冒烟自测（真实浏览器驱动，验「点了按钮到底有没有生效」）
// =============================================================================
//   Python 侧回归只验到「页面标记存在、JS 引用的 id 都存在」；本脚本补上运行期：
//     1. 面板能加载、无 JS 异常、无 5xx
//     2. 粘贴管理员密钥 → 用户列表出现（谁登录过 / 首次 / 最近 / 用量 / 累计 / 会员到期）
//     3. 点「重置今日」「开通免费不限量」「取消免费」「全部重置今日用量」
//        —— 逐个确认自绘确认弹窗的文案，并核对**磁盘上的 data/*.json 真的变了**
//     3.5（4.1.0 新增）账号管理：重置密码 / 停用 / 启用 / 踢下线 / 备注 / 新建账号
//        —— 除了核对磁盘 accounts.json，还会直接打 /api/login 验「临时密码真能登、旧密码真失效」
//     3.8（4.1.2 新增）重构后的控制台：概览 KPI + 手写 SVG 趋势图 + 暗色模式 +
//        2 秒实时轮询（外部下单 → 侧边栏徽标自动变）+ 详情抽屉 + 批量操作 +
//        订单确认收款写盘 + 操作审计留痕 + 收款码在线上传/删除 + 布局体检（溢出/裁切/窄屏）
//     4. 密钥填错时给出错误提示且不崩
//
// 依赖：Node >= 22（内置 fetch / WebSocket）+ 本机 Chrome 或 Edge；被测服务端只用标准库。
// 用法（在 server_ai 目录下）：
//     node tests/admin_panel_smoke.mjs          # 本地模式：自建临时服务端 + 种子数据，全过退出码 0
//     MP_KEEP=1 node tests/admin_panel_smoke.mjs  # 保留临时目录便于排查
//     MP_SHOT=D:\shots\p node tests/admin_panel_smoke.mjs  # 顺带把各页签截成 PNG（评审看设计）
//     MP_PYTHON=python3.6 MP_CHROME=<路径> ...    # 指定解释器 / 浏览器
//
// 远程模式（部署后从本机验线上面板，只做只读检查，不会改任何真实账号数据）：
//     MP_PANEL_URL=http://8.163.51.216:2581/admin MP_ADMIN_KEY=<密钥> node tests/admin_panel_smoke.mjs
// =============================================================================

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const SERVER = path.join(SERVER_DIR, 'ai_server.py');
const REMOTE_URL = process.env.MP_PANEL_URL || '';
const ADMIN_KEY = process.env.MP_ADMIN_KEY || 'paneltest-key';
const REMOTE = !!REMOTE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORK = process.env.MP_PANEL_WORK || path.join(os.tmpdir(), 'mp-panel-smoke');
const KEEP = process.env.MP_KEEP === '1';

const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, !!ok]);
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '   ' + detail : ''));
};

function findPython() {
  return process.env.MP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function findBrowser() {
  if (process.env.MP_CHROME) return process.env.MP_CHROME;
  const cands = process.platform === 'win32'
    ? [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return cands.find((p) => p && fs.existsSync(p));
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

// ---------------------------------------------------------------- 准备环境
const python = findPython();
const browser = findBrowser();
if (!browser) {
  console.error('找不到 Chrome / Edge，可用 MP_CHROME=<可执行文件路径> 指定。');
  process.exit(2);
}
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true }); // 远程模式也要用（放浏览器 profile 与日志）
const CDP_PORT = await freePort();

let DATA = null;
let PORT = null;
let AUTH_PORT = null;      // 4.1.0 自建账号监听端口（客户端写死的 2580 的角色）
let AUTH_ITERS = 2000;     // 与传给服务端的 MP_PBKDF2_ITERS 保持一致
let ALICE_OLD_PWD = '';    // 种子里 alice 的旧密码，用来验「重置后旧密码失效」
let aliceTempToken = '';   // 重置密码后拿临时密码登录到的令牌（后面下单/验实时要用）
let logFd = null;
let server = null;

if (REMOTE) {
  // 远程模式：不建临时服务端、不写任何数据，只做只读检查
  let ok = false;
  try {
    const r = await fetch(REMOTE_URL, { redirect: 'follow' });
    ok = r.ok;
  } catch (e) { /* 下面统一报错 */ }
  if (!ok) { console.error('打不开远程面板：' + REMOTE_URL + '（检查地址/防火墙）'); process.exit(2); }
  console.log(`远程模式: ${REMOTE_URL}（只读检查，不会改动任何账号数据）`);
} else {
  DATA = path.join(WORK, 'data');
  fs.mkdirSync(DATA, { recursive: true });

  const now = Date.now() / 1000;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // 4.1.0：账号表也要种一份，否则面板不会出现「重置密码 / 停用 / 踢下线」这些按钮
  // （哈希按服务端同一算法算：pbkdf2_sha256$iters$b64salt$b64dk，迭代次数与服务端保持一致）
  AUTH_ITERS = 2000;
  const hashPwd = (pwd) => {
    const salt = crypto.randomBytes(16);
    const dk = crypto.pbkdf2Sync(pwd, salt, AUTH_ITERS, 32, 'sha256');
    return `pbkdf2_sha256$${AUTH_ITERS}$${salt.toString('base64')}$${dk.toString('base64')}`;
  };
  ALICE_OLD_PWD = 'alice-old-password';
  const seed = {
    'users.json': {
      'uid-alice': { id: 'uid-alice', name: 'alice', first: now - 86400 * 3, last: now - 3600 },
      'uid-bob': { id: 'uid-bob', name: 'bob', first: now - 86400 * 10, last: now - 7200 },
      'uid-carol': { id: 'uid-carol', name: 'carol', first: now - 86400 * 30, last: now - 86400 * 5 },
    },
    'usage.json': {
      'uid-alice': { day: today, free: 2, member: 0, unlimited: 0, total: 12 },
      'uid-bob': { day: today, free: 0, member: 0, unlimited: 5, total: 5 },
      'uid-carol': { day: today, free: 0, member: 3, unlimited: 0, total: 40 },
    },
    'members.json': { 'uid-carol': { until: now + 86400 * 30, name: 'carol' } },
    'free.json': { 'uid-bob': { on: true, name: 'bob', updated: now - 86400 } },
    'accounts.json': {
      'uid-alice': {
        id: 'uid-alice', name: 'alice', displayName: '', avatar: '',
        pwd: hashPwd(ALICE_OLD_PWD), created: now - 86400 * 3, lastLogin: now - 3600,
        lastIP: '10.0.0.7', tokenVer: 1, status: 'active', note: '',
      },
      'uid-bob': {
        id: 'uid-bob', name: 'bob', displayName: '老鲍', avatar: '',
        pwd: hashPwd('bob-password-1'), created: now - 86400 * 10, lastLogin: now - 7200,
        lastIP: '10.0.0.8', tokenVer: 1, status: 'active', note: '内部测试',
      },
      'uid-carol': {
        id: 'uid-carol', name: 'carol', displayName: '', avatar: '',
        pwd: hashPwd('carol-password-1'), created: now - 86400 * 30, lastLogin: now - 86400 * 5,
        lastIP: '10.0.0.9', tokenVer: 1, status: 'disabled', note: '',
      },
    },
  };
  for (const [name, obj] of Object.entries(seed)) {
    fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2), 'utf-8');
  }

  PORT = await freePort();
  AUTH_PORT = await freePort();
  logFd = fs.openSync(path.join(WORK, 'server.log'), 'a');
  server = spawn(python, [SERVER], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      MP_PORT: String(PORT), MP_DATA_DIR: DATA, MP_ADMIN_KEY: ADMIN_KEY, MP_MOCK: '1',
      MP_DEEPSEEK_KEY: 'sk-mock', MP_CASDOOR_URL: 'http://127.0.0.1:2600',
      MP_RATE_LIMIT_SEC: '0', MP_FREE_DAILY: '3', PYTHONIOENCODING: 'utf-8',
      // 4.1.0：本地模式也开自建账号，才能验「临时密码真的能登录」
      MP_AUTH_MODE: 'builtin', MP_AUTH_PORT: String(AUTH_PORT),
      MP_PBKDF2_ITERS: String(AUTH_ITERS), MP_IP_MAX_FAIL: '100000',
    },
    stdio: ['ignore', logFd, logFd],
  });
}

const cleanup = () => {
  try { if (server) server.kill(); } catch { /* ignore */ }
  try {
    if (process.platform === 'win32' && proc.pid) {
      // 浏览器会派生子进程（GPU/渲染），要连进程树一起收，否则 profile 目录删不掉
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch { /* ignore */ }
  try { if (logFd) fs.closeSync(logFd); } catch { /* ignore */ }
  try { fs.closeSync(bFd); } catch { /* ignore */ }
};
process.on('exit', cleanup);

// 等服务端（远程模式跳过）
if (!REMOTE) {
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/ai/health`);
      if (r.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
  }
  if (!up) {
    console.error('服务端没起来，日志：\n' + fs.readFileSync(path.join(WORK, 'server.log'), 'utf-8'));
    process.exit(2);
  }
  console.log(`服务端就绪: http://127.0.0.1:${PORT}/admin   （数据目录 ${DATA}）`);
}

// 起无头浏览器
const profile = path.join(WORK, 'profile');
const bFd = fs.openSync(path.join(WORK, 'browser.log'), 'a');
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
  '--window-size=1680,1050',
  '--disable-features=Translate', 'about:blank',
], { stdio: ['ignore', bFd, bFd] });

let targets = null;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const list = await r.json();
    if (list.some((t) => t.type === 'page')) { targets = list; break; }
  } catch { /* 还没起来 */ }
}
if (!targets) { console.error('无头浏览器没起来'); process.exit(2); }
const page = targets.find((t) => t.type === 'page');

// ---------------------------------------------------------------- CDP
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) this.handlers.get(m.method)(m.params);
    });
  }
  on(m, fn) { this.handlers.set(m, fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new CDP(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');

const dialogs = [];
const exceptions = [];
const badResponses = [];
let authErrorExpected = false; // 「密钥填错」那一段会故意产生 403，不算异常
let badRequestExpected = false; // 故意触发的 400（如重名新建），也不算异常
let nextPromptText = null;     // 下一次 prompt() 要回填的文本（4.1.0 的「备注」用它）
cdp.on('Page.javascriptDialogOpening', async (p) => {
  dialogs.push(p.message);
  const params = { accept: true };
  if (p.type === 'prompt' && nextPromptText !== null) params.promptText = nextPromptText;
  nextPromptText = null;
  try { await cdp.send('Page.handleJavaScriptDialog', params); } catch { /* ignore */ }
});
cdp.on('Runtime.exceptionThrown', (p) => {
  exceptions.push((p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text);
});
cdp.on('Log.entryAdded', (p) => {
  const e = p.entry || {};
  if (e.level !== 'error') return;
  const url = e.url || '';
  if (url.includes('favicon')) return; // 浏览器自动请求站点图标，404 与面板无关
  if (authErrorExpected && /403|Forbidden/.test(e.text || '')) return;
  if (badRequestExpected && /400|Bad Request/.test(e.text || '')) return;
  exceptions.push('console: ' + (e.text || '') + (url ? '  <' + url + '>' : ''));
});
cdp.on('Network.responseReceived', (p) => {
  if (p.response && p.response.status >= 500) badResponses.push(`${p.response.status} ${p.response.url}`);
});

async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expression, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expression)) return true;
    await sleep(150);
  }
  return false;
}
const panelText = () => ev(`(document.getElementById('users')||{}).innerText || ''`);
const outText = () => ev(`(document.getElementById('out')||{}).textContent || ''`);

/** 切页签（4.1.2 起后台是「左侧导航 + 多页签」的单页应用） */
async function nav(tab) {
  await ev(`(() => { const b = document.querySelector('.nav-item[data-tab=${JSON.stringify(tab)}]');
                      if (b) b.click(); return !!b; })()`);
  await sleep(300);
}
/** 点一个会弹确认的按钮：4.1.2 起改成自绘弹窗（不再用原生 confirm），所以要多点一次「确定」 */
async function act(sel) {
  await ev(`(document.querySelector(${JSON.stringify(sel)})||{click(){}}).click()`);
  await waitFor(`document.getElementById('askModal').classList.contains('on')`, 2500);
  const body = await ev(`document.getElementById('askBody').textContent || ''`);
  await ev(`document.getElementById('askOk').click()`);
  return body;
}
/** 截图（评审看设计用；MP_SHOT=<前缀> 时才会拍） */
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(name, Buffer.from(r.data, 'base64'));
  console.log('  截图: ' + name);
}

/** 直接打自建账号服务验「临时密码/停用到底有没有真的生效」（面板只是外壳） */
async function apiLogin(name, pwd) {
  try {
    const body = new URLSearchParams({
      grant_type: 'password', client_id: 'b49640f6c4dabd78ce94', client_secret: 'x'.repeat(40),
      username: name, password: pwd, scope: 'read',
    });
    const r = await fetch(`http://127.0.0.1:${AUTH_PORT}/api/login/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && !!d.access_token, token: d.access_token || '', desc: d.error_description || '' };
  } catch (e) {
    return { ok: false, token: '', desc: String(e) };
  }
}

async function apiGetAccount(token) {
  try {
    const r = await fetch(`http://127.0.0.1:${AUTH_PORT}/api/get-account`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    return await r.json().catch(() => ({}));
  } catch { return {}; }
}

// ---------------------------------------------------------------- 1. 打开面板
const PANEL_URL = REMOTE ? REMOTE_URL : `http://127.0.0.1:${PORT}/admin`;
await cdp.send('Network.enable');
await cdp.send('Page.navigate', { url: PANEL_URL });
const loaded = await waitFor(`!!document.getElementById('key') && document.readyState === 'complete'`);
check('面板页面能打开并加载出脚本（#key 存在）', loaded);
check('页面标题正确', (await ev('document.title')) === '轻提词 · AI 服务后台', await ev('document.title'));

// ---------------------------------------------------------------- 2. 填密钥 → 加载用户
await ev(`(() => {
  document.getElementById('key').value = ${JSON.stringify(ADMIN_KEY)};
  document.getElementById('save').click();
  return 1;
})()`);
await sleep(400);
// 4.1.2：用户列表在「用户与额度」页签里，先切过去（页签没激活时 innerText 是空的）
await nav('users');
let listed;
if (REMOTE) {
  // 线上数据不确定：只要能渲染出表格或空态就算通过
  listed = await waitFor(`(() => {
    const t = document.getElementById('users').innerText || '';
    return t.includes('账号') || t.includes('还没有任何账号') || t.includes('没有匹配的用户');
  })()`);
} else {
  listed = await waitFor(`(document.getElementById('users').innerText || '').includes('alice')`);
}
check('粘贴管理员密钥后能加载用户列表', listed, (await panelText()).replace(/\s+/g, ' ').slice(0, 90));
let text = await panelText();

if (REMOTE) {
  console.log('  线上面板摘要：' + text.replace(/\s+/g, ' ').slice(0, 180));
  check('线上面板不是报错状态（无「密钥不正确 / 无法连接服务」）',
    !/密钥不正确|无法连接服务|请先填写/.test(text));
  check('线上面板已是新版（表头带注册时间 / 最后登录 / 备注）',
    text.includes('注册时间') && text.includes('最后登录') && text.includes('备注'));
  check('线上账号行有账号操作按钮（重置密码 / 备注 / 踢下线）',
    /重置密码/.test(text) || /还没有任何账号/.test(text));
  check('线上面板带实时刷新状态点与 2 秒轮询接口',
    (await ev(`!!document.getElementById('liveDot') && !!document.getElementById('syncText')`)) === true);
} else {
  check('运营摘要：账号 3 个 / 免费不限量 1 个 / 今日 AI 调用 10 次',
    text.includes('账号 3 个') && text.includes('免费不限量 1 个') && text.includes('今日 AI 调用 10 次'),
    text.split('\n').slice(0, 1).join(''));
  check('三个账号都出现（谁登录过）', ['alice', 'bob', 'carol'].every((n) => text.includes(n)));
  check('bob 显示「免费不限量」徽标', /bob[\s\S]{0,200}免费不限量/.test(text));
  check('carol 显示「会员」徽标', /carol[\s\S]{0,200}会员/.test(text));
  check('alice 显示「免费版」', /alice[\s\S]{0,200}免费版/.test(text));
  check('alice 累计 12 次（读的是 totalCalls）', /alice[\s\S]{0,300}12 次/.test(text));
}

// ---------------------------------------------------------------- 3~5. 写操作（仅本地模式；远程模式绝不改真实数据）
if (!REMOTE) {
  // 3. 重置某个账号「今日用量」
  const rbody = await act('button[data-reset="alice"]');
  const resetOk = await waitFor(`(document.getElementById('users').innerText || '').includes('今日 AI 调用 8 次')`);
  check('点「重置今日」弹出确认弹窗（自绘，不是原生 confirm）', dialogs.length === 0, JSON.stringify(dialogs));
  check('确认弹窗文案带用户名', rbody.includes('alice') && rbody.includes('今日用量清零'), rbody);
  check('重置后列表刷新（今日 AI 调用 10 → 8 次）', resetOk);
  let usage = readJson(path.join(DATA, 'usage.json'));
  check('磁盘 usage.json：alice 今日 free 归零', (usage['uid-alice'] || {}).free === 0, JSON.stringify(usage['uid-alice']));
  check('磁盘 usage.json：alice 累计 total 保留 12', (usage['uid-alice'] || {}).total === 12);
  check('磁盘 usage.json：其他人不受影响（carol.member 仍为 3）', (usage['uid-carol'] || {}).member === 3);

  // 4. 开通 / 取消「免费不限量」
  const f1 = await act('button[data-free="1"][data-name="alice"]');
  const freeOn = await waitFor(`!!document.querySelector('button[data-free="0"][data-name="alice"]')`);
  check('点「开通免费不限量」弹出确认弹窗', dialogs.length === 0 && f1.includes('免费不限量'), f1);
  check('确认弹窗文案带用户名', f1.includes('alice'), f1);
  check('开通后按钮变为「取消免费」', freeOn);
  text = await panelText();
  check('开通后摘要：免费不限量 1 → 2 个', text.includes('免费不限量 2 个'));
  let free = readJson(path.join(DATA, 'free.json'));
  check('磁盘 free.json：alice.on = true', (free['uid-alice'] || {}).on === true, JSON.stringify(free['uid-alice']));

  const f2 = await act('button[data-free="0"][data-name="alice"]');
  const freeOff = await waitFor(`!!document.querySelector('button[data-free="1"][data-name="alice"]')`);
  check('点「取消免费」弹出确认弹窗', dialogs.length === 0 && f2.includes('取消'), f2);
  check('取消后按钮变回「开通免费不限量」', freeOff);
  free = readJson(path.join(DATA, 'free.json'));
  check('磁盘 free.json：alice 已移除（取消 = 删条目，is_free 视为关闭）', !free['uid-alice'],
    JSON.stringify(free));
  check('磁盘 free.json：bob 仍然保留', (free['uid-bob'] || {}).on === true);

  // 5. 全部重置「今日用量」
  const abody = await act('#uresetall');
  const allReset = await waitFor(`(document.getElementById('out').textContent || '').includes('已重置全部账号')`);
  check('点「全部重置今日用量」弹出确认弹窗', dialogs.length === 0, JSON.stringify(dialogs));
  check('确认弹窗文案说明累计会保留', abody.includes('累计调用数保留'), abody);
  check('操作结果提示出现', allReset, await outText());
  usage = readJson(path.join(DATA, 'usage.json'));
  const allZero = ['uid-alice', 'uid-bob', 'uid-carol'].every((k) => {
    const u = usage[k] || {};
    return !u.free && !u.member && !u.unlimited;
  });
  check('磁盘 usage.json：三个账号今日用量全部归零', allZero, JSON.stringify(usage));
  check('磁盘 usage.json：累计 total 全部保留（12/5/40）',
    usage['uid-alice'].total === 12 && usage['uid-bob'].total === 5 && usage['uid-carol'].total === 40);

  // ------------------------------------------------ 5.5 账号管理（4.1.0）
  // 这一段的判据是「点了按钮 → 磁盘变了 → 真的能/不能登录」，不只是页面长得对
  text = await panelText();
  check('账号表新增列：注册时间 / 最后登录 / 备注',
    text.includes('注册时间') && text.includes('最后登录') && text.includes('备注'));
  check('已停用账号显示「已停用」徽标（carol 种子里就是停用）',
    /carol[\s\S]{0,300}已停用/.test(text));
  check('有账号的行才出现账号操作按钮（重置密码 / 踢下线 / 停用）',
    (await ev(`!!document.querySelector('button[data-pwd="bob"]') &&
               !!document.querySelector('button[data-kick="bob"]') &&
               !!document.querySelector('button[data-status="disabled"][data-name="bob"]')`)) === true);
  check('已停用的账号按钮变成「启用」',
    (await ev(`!!document.querySelector('button[data-status="active"][data-name="carol"]')`)) === true);

  const aliceHashBefore = (readJson(path.join(DATA, 'accounts.json'))['uid-alice'] || {}).pwd;
  const before = await apiLogin('alice', ALICE_OLD_PWD);
  check('重置前：alice 的旧密码本来可以登录（自建账号服务确实在跑）', before.ok, before.desc);

  // 重置密码
  const pbody = await act('button[data-pwd="alice"]');
  const pwdDone = await waitFor(`(document.getElementById('out').textContent||'').includes('临时密码')`);
  check('点「重置密码」弹出确认弹窗且文案说明旧令牌会失效',
    dialogs.length === 0 && pbody.includes('旧令牌会立刻失效'), pbody);
  const temp = ((await outText()).match(/临时密码：(\S+)/) || [])[1] || '';
  check('面板把一次性临时密码显示出来（10 位）', pwdDone && temp.length === 10,
    (await outText()).replace(/\s+/g, ' ').slice(0, 90));
  let acc = readJson(path.join(DATA, 'accounts.json'));
  check('磁盘 accounts.json：alice 的哈希已换新，且 tokenVer 1 → 2',
    (acc['uid-alice'] || {}).pwd !== aliceHashBefore && (acc['uid-alice'] || {}).tokenVer === 2);
  const withTemp = await apiLogin('alice', temp);
  const withOld = await apiLogin('alice', ALICE_OLD_PWD);
  aliceTempToken = withTemp.token;
  check('临时密码可以真的登录', withTemp.ok, withTemp.desc);
  check('旧密码已失效（重置不是只改了页面）', !withOld.ok, withOld.desc);
  const accView = await apiGetAccount(withTemp.token);
  check('客户端拿到的用户对象里没有备注/哈希（后台字段不外泄）',
    !JSON.stringify(accView).includes('note') && !JSON.stringify(accView).includes('pbkdf2'),
    JSON.stringify(accView).slice(0, 120));

  // 停用 / 启用
  const sbody = await act('button[data-status="disabled"][data-name="bob"]');
  const bobOff = await waitFor(`!!document.querySelector('button[data-status="active"][data-name="bob"]')`);
  check('点「停用」弹出确认弹窗且文案说明将无法登录',
    dialogs.length === 0 && sbody.includes('无法登录'), sbody);
  check('停用后按钮变成「启用」', bobOff);
  acc = readJson(path.join(DATA, 'accounts.json'));
  check('磁盘 accounts.json：bob.status = disabled 且 tokenVer 1 → 2',
    (acc['uid-bob'] || {}).status === 'disabled' && (acc['uid-bob'] || {}).tokenVer === 2,
    JSON.stringify(acc['uid-bob']).slice(0, 120));
  const bobOffLogin = await apiLogin('bob', 'bob-password-1');
  check('停用后 bob 即使密码正确也登不上，且提示「已停用」',
    !bobOffLogin.ok && /停用/.test(bobOffLogin.desc), bobOffLogin.desc);
  await act('button[data-status="active"][data-name="bob"]');
  await waitFor(`!!document.querySelector('button[data-status="disabled"][data-name="bob"]')`);
  check('启用后 bob 可以重新登录', (await apiLogin('bob', 'bob-password-1')).ok);

  // 踢下线
  const verBefore = (readJson(path.join(DATA, 'accounts.json'))['uid-bob'] || {}).tokenVer || 0;
  const kbody = await act('button[data-kick="bob"]');
  const kicked = await waitFor(`(document.getElementById('out').textContent||'').includes('踢下线')`);
  check('点「踢下线」弹出确认弹窗且文案说明密码不变',
    dialogs.length === 0 && kbody.includes('密码不变'), kbody);
  acc = readJson(path.join(DATA, 'accounts.json'));
  check('磁盘 accounts.json：踢下线只把 tokenVer +1（状态仍为 active）',
    kicked && (acc['uid-bob'] || {}).tokenVer === verBefore + 1
    && (acc['uid-bob'] || {}).status === 'active', JSON.stringify(acc['uid-bob']).slice(0, 120));

  // 备注（4.1.2 起用自绘弹窗 + 多行输入框，不再用原生 prompt）
  await ev(`document.querySelector('button[data-note="bob"]').click()`);
  const noteModal = await waitFor(`document.getElementById('askModal').classList.contains('on')`);
  await ev(`(() => { const i = document.getElementById('askInput'); i.value = 'VIP 客户'; return 1; })()`);
  await ev(`document.getElementById('askOk').click()`);
  const noteOk = await waitFor(`(document.getElementById('out').textContent||'').includes('备注')`);
  acc = readJson(path.join(DATA, 'accounts.json'));
  check('点「备注」用自绘弹窗收集内容并写盘（仅内部可见）',
    noteModal && noteOk && (acc['uid-bob'] || {}).note === 'VIP 客户',
    'note=' + JSON.stringify((acc['uid-bob'] || {}).note));

  // 新建账号
  await ev(`(() => {
    document.getElementById('nname').value = 'dave';
    document.getElementById('npwd').value = 'dave-password';
    return 1;
  })()`);
  const nbody = await act('#ncreate');
  const created = await waitFor(`(document.getElementById('out').textContent||'').includes('已新建账号')`);
  const daveAcc = Object.values(readJson(path.join(DATA, 'accounts.json')) || {})
    .find((a) => a.name === 'dave') || {};
  check('面板「新建账号」写盘成功且 uid 是自动生成的 UUID',
    created && nbody.includes('dave') && /^[0-9a-f-]{36}$/.test(daveAcc.id || ''),
    JSON.stringify(daveAcc).slice(0, 120));
  check('新建的账号可以立刻登录', (await apiLogin('dave', 'dave-password')).ok);
  await ev(`(() => {
    document.getElementById('nname').value = 'dave';
    document.getElementById('npwd').value = 'dave-password';
    return 1;
  })()`);
  badRequestExpected = true;
  await act('#ncreate');
  check('重名新建被拒且提示原因',
    await waitFor(`(document.getElementById('out').textContent||'').includes('已被注册')`),
    (await outText()).replace(/\s+/g, ' ').slice(0, 90));
  await sleep(500);   // 等这条 400 的 console 日志进来再撤销豁免
  badRequestExpected = false;
}

// ------------------------------------------------ 5.8 4.1.2 新界面：概览 / 实时 / 抽屉 / 批量 / 订单 / 日志 / 收款码
// 这一段专门验「重构后的界面真的能用」：数据是不是自己刷新、按钮是不是真的写盘
if (!REMOTE) {
  // 概览页
  await nav('dash');
  const kpiOk = await waitFor(`document.querySelectorAll('#kpiRow .kpi').length === 4`);
  const ktext = await ev(`(document.getElementById('kpiRow').innerText||'')`);
  check('概览页 4 张 KPI 卡片（账号总数 / 今日 AI 调用 / 待处理订单 / 今日收入）',
    kpiOk && ktext.includes('账号总数') && ktext.includes('今日 AI 调用') && ktext.includes('今日收入'),
    ktext.replace(/\s+/g, ' ').slice(0, 90));
  check('概览页手写 SVG 趋势图渲染（折线 + 数据点）',
    (await ev(`document.querySelectorAll('#chart svg.chart polyline').length === 1 &&
               document.querySelectorAll('#chart svg circle').length >= 1`)) === true);
  check('概览页额度分布条渲染 4 档',
    (await ev(`document.querySelectorAll('#dist .bar').length === 4`)) === true);
  check('概览页有「最近操作」与「调用最多的账号」两块',
    (await ev(`!!document.getElementById('recentLogs') && !!document.getElementById('topUsers')`)) === true);

  // 暗色模式
  await ev(`document.getElementById('themeBtn').click()`);
  const dark = await ev(`document.documentElement.getAttribute('data-theme')`);
  await ev(`document.getElementById('themeBtn').click()`);
  const light = await ev(`document.documentElement.getAttribute('data-theme')`);
  check('INS 风暗色模式可切换（light ↔ dark）', dark === 'dark' && light === 'light', dark + ' → ' + light);

  // 实时轮询：状态点 + 同步时间
  const liveOn = await waitFor(`document.getElementById('liveDot').className.includes('on')`, 9000);
  const syncTxt = await ev(`(document.getElementById('syncText').textContent||'')`);
  check('2 秒实时轮询在跑（状态点变绿 + 显示同步时间）',
    liveOn && /\d\d:\d\d:\d\d/.test(syncTxt), syncTxt);

  // 详情抽屉
  await nav('users');
  await ev(`document.querySelector('tr[data-row="alice"]').click()`);
  const drawerOn = await waitFor(`document.getElementById('drawer').classList.contains('on')`);
  const dtext = await ev(`(document.getElementById('dBody').innerText||'')`);
  check('点账号行打开详情抽屉（含最后 IP / 凭证版本 / 累计调用）',
    drawerOn && dtext.includes('凭证版本') && dtext.includes('累计调用') && dtext.includes('最后 IP'),
    dtext.replace(/\s+/g, ' ').slice(0, 90));
  await ev(`document.getElementById('dClose').click()`);
  check('抽屉可关闭', (await ev(`document.getElementById('drawer').classList.contains('on')`)) === false);

  // 多选批量操作
  await ev(`document.querySelector('input[data-check="bob"]').click()`);
  await ev(`document.querySelector('input[data-check="carol"]').click()`);
  const selOn = await waitFor(`document.getElementById('selbar').classList.contains('on') &&
                               (document.getElementById('selCount').textContent||'') === '2'`);
  check('勾选两个账号后出现批量操作条', selOn,
    await ev(`document.getElementById('selCount').textContent`));
  await act('button[data-batch="reset"]');
  const batchOk = await waitFor(`(document.getElementById('out').textContent||'').includes('批量重置今日用量完成')`, 9000);
  check('批量重置今日用量执行成功（成功 2 个）',
    batchOk && (await outText()).includes('成功 2 个'), await outText());

  // 客户端下单 → 侧边栏徽标实时变化 → 订单页确认收款开通
  const ores = await fetch(`http://127.0.0.1:${PORT}/ai/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + aliceTempToken },
    body: JSON.stringify({ plan: 'day' }),
  }).then((r) => r.json()).catch(() => ({}));
  const oid = ((ores.order || {}).id) || '';
  check('客户端下单成功（用于验实时刷新与订单页）', !!oid, JSON.stringify(ores).slice(0, 120));
  const badge = await waitFor(`(document.getElementById('navOrders').textContent||'').trim() === '1'`, 9000);
  check('实时：外部下单后侧边栏「订单」待处理徽标自动变 1', badge,
    await ev(`document.getElementById('navOrders').textContent`));
  await nav('orders');
  const orderShown = await waitFor(
    `(document.getElementById('orderList').innerText||'').includes(${JSON.stringify(oid)})`, 8000);
  check('订单页列出这笔新订单（待付款 + 订单号）', orderShown);
  check('订单页有状态筛选与搜索框（4.1.2 新增）',
    (await ev(`document.querySelectorAll('#oFilters .chip').length === 4 && !!document.getElementById('oq')`)) === true);
  const cbody = await act(`button[data-confirm="${oid}"]`);
  check('点「确认收款并开通」弹出确认弹窗且文案带订单号', cbody.includes(oid), cbody.slice(0, 70));
  const confirmed = await waitFor(`(document.getElementById('out').textContent||'').includes('已开通')`, 9000);
  const odisk = readJson(path.join(DATA, 'orders.json')) || {};
  check('确认收款后写盘：订单 paid + alice 成为会员',
    confirmed && (odisk[oid] || {}).status === 'paid'
    && !!readJson(path.join(DATA, 'members.json'))['uid-alice'],
    JSON.stringify(odisk[oid] || {}).slice(0, 120));

  // 操作日志留痕
  await nav('logs');
  const logShown = await waitFor(`(document.getElementById('logList').innerText||'').includes('确认收款开通')`, 8000);
  const logDisk = readJson(path.join(DATA, 'admin_log.json')) || {};
  check('操作日志页出现「确认收款开通」留痕（后台每次操作都记）',
    logShown && Array.isArray(logDisk.items) && logDisk.items.length > 0,
    '磁盘 ' + ((logDisk.items || []).length) + ' 条');
  check('日志页带登录锁定记录与后台密钥错误两块',
    (await ev(`!!document.getElementById('guardList') && !!document.getElementById('failList')`)) === true);

  // 收款码在线管理：上传 → 页面自动出现预览；删除 → 自动消失
  await nav('pay');
  await waitFor(`document.querySelectorAll('#pcWrap .pc').length === 4`, 6000);
  // 注意：Buffer.from(字符串) 默认按 utf8 编码，\x89 会变成两个字节、魔数就废了，
  // 所以这里必须用字节数组拼（服务端只认文件头魔数）
  const pngData = 'data:image/png;base64,' + Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(60),
  ]).toString('base64');
  const upRes = await fetch(`http://127.0.0.1:${PORT}/ai/admin/paycode/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify({ plan: 'month', method: 'wechat', data: pngData }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
  check('收款码上传接口返回 ok', upRes.ok === true, JSON.stringify(upRes).slice(0, 120));
  const pcShown = await waitFor(`document.querySelectorAll('#pcWrap img').length >= 1`, 9000);
  check('收款码在线上传后页面自动出现预览（不再需要 scp）',
    pcShown && fs.existsSync(path.join(DATA, 'paycode_month_wechat.png')));
  await fetch(`http://127.0.0.1:${PORT}/ai/admin/paycode/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
    body: JSON.stringify({ plan: 'month', method: 'wechat' }),
  }).then((r) => r.json());
  const pcGone = await waitFor(`document.querySelectorAll('#pcWrap img').length === 0`, 9000);
  check('收款码删除后页面自动去掉预览',
    pcGone && !fs.existsSync(path.join(DATA, 'paycode_month_wechat.png')));

  check('导出 CSV 按钮存在（用户 / 订单）',
    (await ev(`!!document.getElementById('uExport') && !!document.getElementById('oExport')`)) === true);
  check('不再使用原生 confirm / prompt（全部换成自绘弹窗）', dialogs.length === 0, JSON.stringify(dialogs));

  // 布局体检：界面重构成「左侧导航 + 卡片 + 宽表格」后，最容易出的问题是溢出和挤压
  // 注意：隐藏的页签（display:none）尺寸全是 0，所以要在对应页签可见时分别量
  await nav('dash');
  const dashBox = await ev(`(() => {
    const cards = Array.from(document.querySelectorAll('#kpiRow .card'));
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      sideW: Math.round(document.querySelector('.side').getBoundingClientRect().width),
      mainW: Math.round(document.querySelector('main').getBoundingClientRect().width),
      minCardW: Math.min.apply(null, cards.map((c) => Math.round(c.getBoundingClientRect().width))),
      cardTop: cards.map((c) => Math.round(c.getBoundingClientRect().top)),
    };
  })()`);
  check('桌面宽度下页面没有横向溢出（scrollWidth <= innerWidth）',
    dashBox.scrollW <= dashBox.innerW + 1, JSON.stringify([dashBox.scrollW, dashBox.innerW]));
  check('左侧导航 200~280px、主区足够宽（≥900px）',
    dashBox.sideW >= 200 && dashBox.sideW <= 280 && dashBox.mainW >= 900,
    `side=${dashBox.sideW} main=${dashBox.mainW}`);
  check('概览 KPI 卡片一行 4 张（每张 ≥240px）',
    dashBox.cardTop.length === 4 && new Set(dashBox.cardTop).size === 1 && dashBox.minCardW >= 240,
    `minW=${dashBox.minCardW} top=${JSON.stringify(dashBox.cardTop)}`);
  await nav('users');
  const tableOver = await ev(`(() => {
    const w = document.getElementById('users');       // 它自己就是 .tblwrap（横向滚动容器）
    const t = document.querySelector('#users table');
    return (t && w) ? (t.scrollWidth - w.clientWidth) : -1;
  })()`);
  check('用户表 10 列在桌面宽度下不被裁切（表宽 <= 容器宽）',
    tableOver >= 0 && tableOver <= 8, 'overflow=' + tableOver);
  const lightCard = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--card').trim()`);
  await ev(`document.getElementById('themeBtn').click()`);
  const darkCard = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--card').trim()`);
  await ev(`document.getElementById('themeBtn').click()`);
  check('明暗两套配色确实生效（--card 亮 #ffffff / 暗 #121212）',
    lightCard === '#ffffff' && darkCard === '#121212', lightCard + ' / ' + darkCard);
  // 窄屏（手机应急确认收款）也要不炸
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  const mobile = await ev(`({ scrollW: document.documentElement.scrollWidth,
                              innerW: window.innerWidth,
                              nav: getComputedStyle(document.querySelector('.side')).position })`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
  check('窄屏（390px）下没有横向溢出、导航改为顶部横排',
    mobile.scrollW <= mobile.innerW + 1 && mobile.nav === 'static',
    JSON.stringify(mobile));

  // 评审看设计用：MP_SHOT=<前缀> 时把各页签拍成 PNG
  if (process.env.MP_SHOT) {
    const p = process.env.MP_SHOT;
    await nav('dash'); await sleep(900); await shot(p + '_dash.png');
    await nav('users'); await sleep(900); await shot(p + '_users.png');
    await nav('orders'); await sleep(900); await shot(p + '_orders.png');
    await nav('logs'); await sleep(800); await shot(p + '_logs.png');
    await ev(`document.getElementById('themeBtn').click()`);
    await nav('dash'); await sleep(1000); await shot(p + '_dash_dark.png');
    await ev(`document.getElementById('themeBtn').click()`);
  }
}

// ---------------------------------------------------------------- 6. 密钥填错
await nav('users');
dialogs.length = 0;
// 密钥填错会持续产生 403（实时轮询每 2 秒一次），所以这里一直保留豁免到最后
authErrorExpected = true;
await ev(`(() => {
  document.getElementById('key').value = 'wrong-key';
  document.getElementById('save').click();
  return 1;
})()`);
const errShown = await waitFor(`(() => { const t = document.getElementById('users').innerText || ''; return t.includes('密钥') || t.includes('无法') || t.includes('错误') || t.includes('403'); })()`);
check('密钥填错时给出错误提示（不白屏、不崩）', errShown, (await panelText()).replace(/\s+/g, ' ').slice(0, 80));

// ---------------------------------------------------------------- 7. 运行期健康度
check('没有未捕获的 JS 异常 / console.error', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
check('没有 5xx 响应', badResponses.length === 0, badResponses.slice(0, 2).join(' | '));

// ---------------------------------------------------------------- 收尾
const bad = results.filter(([, ok]) => !ok).length;
console.log(`=== ${results.length - bad}/${results.length} 通过 ===`);
cleanup();
await sleep(900); // 等浏览器进程树退干净，否则 Windows 上 profile 目录可能删不掉
if (!KEEP) {
  try {
    fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (e) {
    console.log('（临时目录未删净，可忽略：' + WORK + '）');
  }
} else {
  console.log('保留临时目录：' + WORK);
}
process.exit(bad === 0 ? 0 : 1);
