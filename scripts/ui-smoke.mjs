// 轻提词 · 界面冒烟自测（走 WebView2 的 CDP，验证「单元测试覆盖不到」的两件事）
// =============================================================================
//   1. 旧「本机离线账号」登录态是否被强制清除 + 是否提示重新登录 + 云端账号是否正常
//   2. AI 额度卡片在「免费不限量」与「免费版」两种状态下的呈现是否正确
//      （第 2 项用 CDP 拦截 /ai/quota 伪造响应，不依赖服务端真的开通）
//
// 用法（先在项目根目录起一个带调试端口的开发版）：
//     PowerShell:
//       $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
//       .\开发版\轻提词.exe          # 或 npm run tauri dev
//     node scripts/ui-smoke.mjs     # 全部通过退出码 0
//
//   换端口：$env:MP_CDP_PORT="9333"；脚本会临时改写登录态并在结束时还原。
//   只在开发机上用；生产包不会开调试端口（该环境变量只影响本次启动）。
// =============================================================================

const PORT = process.env.MP_CDP_PORT || '9222';
const CDP_URL = `http://127.0.0.1:${PORT}/json/list`;
const TOKEN_KEY = 'microprompt.authToken';
const USER_KEY = 'microprompt.authUser';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_QUOTA = {
  member: false, memberUntil: 0, plan: 'unlimited', free: true, unlimitedUsedToday: 7,
  freeQuota: 3, freeUsedToday: 7, memberCap: 300, memberUsedToday: 0,
  remainingToday: -1, totalCalls: 42, day: '2026-10-14',
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, !!ok]);
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '   ' + detail : ''));
};

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) this.handlers.get(msg.method)(msg.params);
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

// ---------- 连接 ----------
let targets;
try {
  targets = await (await fetch(CDP_URL)).json();
} catch (e) {
  console.error(`连不上 CDP（${CDP_URL}）。请先带调试端口启动开发版：`);
  console.error('  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=' + PORT + '"');
  console.error('  .\\开发版\\轻提词.exe');
  process.exit(2);
}
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('没有找到页面目标：' + JSON.stringify(targets)); process.exit(2); }
console.log('已连接:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
const inc = (s, sub) => typeof s === 'string' && s.includes(sub);

/** 轮询等待页面条件成立（默认最多 8 秒） */
async function waitFor(expression, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expression)) return true;
    await sleep(150);
  }
  return false;
}

/** 填 React 受控输入框（直接赋 .value 不生效，必须走原生 setter + input 事件） */
const setInput = (index, value) => ev(`(() => {
  const el = document.querySelectorAll('input.form-input')[${index}];
  if (!el) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);

async function readLoginState() {
  return await ev(`(() => {
    let tok = null; let usr = null;
    try { tok = localStorage.getItem(${JSON.stringify(TOKEN_KEY)}); } catch (e) { tok = 'ERR'; }
    try { usr = localStorage.getItem(${JSON.stringify(USER_KEY)}); } catch (e) { usr = null; }
    const body = (document.body && document.body.innerText) || '';
    const t = body.replace(/\\s+/g, ' ');
    return {
      token: tok,
      user: usr,
      kind: tok === null ? 'null' : (String(tok).startsWith('local') ? 'LOCAL' : (String(tok).startsWith('eyJ') ? 'JWT' : 'other')),
      notice: t.includes('本机离线账号已停用'),
      hasRegister: t.includes('立即注册'),
      loggedIn: t.includes('新建'),
    };
  })()`);
}

async function fabTitle() {
  return await ev(`(() => { const b = document.querySelector('.ai-polish-fab'); return b ? b.title : 'no-fab'; })()`);
}

async function openAiCard() {
  await ev(`(() => { const b = document.querySelector('button[title="设置"]'); if (b) b.click(); return !!b; })()`);
  await sleep(1300);
  const menu = await ev(`(() => {
    const items = [...document.querySelectorAll('button.set-menu-item')];
    const ai = items.find((b) => { const n = b.querySelector('.set-menu-name'); return n && n.textContent.includes('AI 助手'); });
    if (!ai) return { found: false };
    return { found: true, hasBadge: !!ai.querySelector('.set-menu-badge') };
  })()`);
  await ev(`(() => {
    const items = [...document.querySelectorAll('button.set-menu-item')];
    const ai = items.find((b) => { const n = b.querySelector('.set-menu-name'); return n && n.textContent.includes('AI 助手'); });
    if (ai) ai.click();
    return !!ai;
  })()`);
  await sleep(1300);
  const card = await ev(`(() => {
    const g = (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; };
    return {
      line: g('.ai-member-line'), sub: g('.ai-member-sub'), hint: g('.ai-member-card .set-hint'),
      buttons: [...document.querySelectorAll('.ai-member-actions button')].map((b) => b.textContent.trim()),
    };
  })()`);
  return { menu, card };
}

// ============ 1. 旧「本机离线账号」登录态 ============
console.log('[1] 旧 local 登录态迁移');
const before = await readLoginState();
await ev(`(() => {
  localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, 'local:tester');
  localStorage.setItem(${JSON.stringify(USER_KEY)}, JSON.stringify({ name: 'tester', local: true }));
  return 1;
})()`);
await ev('location.reload()');
await sleep(6000);
const afterLocal = await readLoginState();
console.log('  注入前:', before.kind, '| 注入后:', afterLocal.kind, '| 提示:', afterLocal.notice);
check('注入前是云端 JWT 登录态', before.kind === 'JWT', before.kind);
check('注入 local:tester 后 token 被清除', afterLocal.token === null);
check('登录页提示「本机离线账号已停用」', afterLocal.notice === true);
check('登录页有「立即注册」入口', afterLocal.hasRegister === true);
check('不再显示已登录界面', afterLocal.loggedIn === false);

if (before.token) {
  await ev(`(() => {
    localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(before.token)});
    ${before.user ? `localStorage.setItem(${JSON.stringify(USER_KEY)}, ${JSON.stringify(before.user)});` : `localStorage.removeItem(${JSON.stringify(USER_KEY)});`}
    return 1;
  })()`);
  await ev('location.reload()');
  await sleep(6000);
  const restored = await readLoginState();
  check('还原云端 JWT 后恢复登录', restored.kind === 'JWT' && restored.loggedIn === true);
}

// ============ 2. AI 额度卡片：免费不限量 vs 免费版 ============
console.log('[2] AI 额度卡片（伪造 free:true）');
// 统一的请求拦截器：CDP 的 Fetch.requestPaused 只能有一个处理函数，用 mode 决定行为
let mode = 'off'; // off | quota-fake | quota-fail | casdoor-fail
let intercepted = 0;
cdp.on('Fetch.requestPaused', async (p) => {
  intercepted++;
  const url = p.request.url || '';
  try {
    if (mode === 'casdoor-fail' && url.includes(':2580')) {
      await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
      return;
    }
    if (mode === 'quota-fail' && url.includes('/ai/quota')) {
      await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
      return;
    }
    if (mode === 'quota-fake' && url.includes('/ai/quota')) {
      if (p.request.method === 'OPTIONS') {
        await cdp.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Access-Control-Allow-Methods', value: 'POST, GET, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
          ], body: '',
        });
        return;
      }
      await cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: Buffer.from(JSON.stringify({ quota: FAKE_QUOTA }), 'utf-8').toString('base64'),
      });
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId: p.requestId });
  } catch (e) { console.log('  拦截异常:', e.message); }
});

mode = 'quota-fake';
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/ai/quota*', requestStage: 'Request' }] });
await ev('location.reload()');
await sleep(6000);
const fabA = await fabTitle();
const A = await openAiCard();
console.log('  按钮提示:', fabA);
console.log('  卡片:', JSON.stringify(A.card));
check('拦截确实命中 /ai/quota', intercepted > 0, '命中 ' + intercepted + ' 次');
check('按钮提示=免费不限量 + 已用次数', inc(fabA, '免费不限量') && inc(fabA, '今日已用 7 次'), fabA);
check('卡片主行=免费不限量 · 管理员已为你的账号开通', inc(A.card.line, '免费不限量') && inc(A.card.line, '管理员已为你的账号开通'));
check('卡片副行=今日已用 7 次 · 不限次数', inc(A.card.sub, '今日已用 7 次') && inc(A.card.sub, '不限次数'));
check('主按钮=续费 / 升级', A.card.buttons.includes('续费 / 升级'));
check('不显示「开通会员」', !A.card.buttons.includes('开通会员'));
check('不显示免费版提示行', A.card.hint === null);
check('设置菜单不挂「会员」标签', A.menu.hasBadge === false);

// 解除拦截 → 回真实服务器
console.log('[3] 解除拦截，读真实额度');
mode = 'off';
await cdp.send('Fetch.disable');
await ev('location.reload()');
await sleep(6000);
const fabB = await fabTitle();
const B = await openAiCard();
console.log('  按钮提示:', fabB);
console.log('  卡片:', JSON.stringify(B.card));
check('真实额度下按钮提示正常', inc(fabB, '今日剩余') || inc(fabB, '会员') || inc(fabB, '免费不限量'), fabB);
check('真实额度下卡片主行正常', inc(B.card.line, '免费版') || inc(B.card.line, '会员') || inc(B.card.line, '免费不限量'));
check('真实额度下主按钮正常', B.card.buttons.includes('开通会员') || B.card.buttons.includes('续费 / 升级'));

// ============ 4. 失败路径：账号服务器不可达（绝不能退回离线账号） ============
console.log('[4] 账号服务器不可达时的失败路径');
const loginError = () => ev(`(document.querySelector('.login-error') || {}).innerText || ''`);
const tokenNow = () => ev(`localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`);

await ev(`(() => { localStorage.removeItem(${JSON.stringify(TOKEN_KEY)}); localStorage.removeItem(${JSON.stringify(USER_KEY)}); return 1; })()`);
await ev('location.reload()');
await sleep(5000);
check('能退到登录页（表单出现）', await waitFor(`!!document.querySelector('input.form-input')`));

mode = 'casdoor-fail';
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*2580*', requestStage: 'Request' }] });

// 4a. 登录
await setInput(0, 'Ethan');
await setInput(1, 'whatever-password');
await ev(`document.querySelector('button.submit-button').click()`);
const loginOk = await waitFor(`!!(document.querySelector('.login-error') || {}).innerText`);
const loginErr = loginOk ? await loginError() : '';
console.log('  登录报错:', loginErr);
check('连不上账号服务器时登录明确报错（不是一直转圈）', /无法连接服务器|连接账号服务器超时/.test(loginErr), loginErr);
check('报错文案说明未创建任何账号', inc(loginErr, '未创建任何账号'));
check('登录失败没有生成 token（未退回离线账号）', (await tokenNow()) === null);

// 4b. 注册
await ev(`(() => {
  const l = [...document.querySelectorAll('.login-link')].find((x) => (x.innerText || '').includes('立即注册'));
  if (l) l.click();
  return !!l;
})()`);
await sleep(900);
await setInput(0, 'newuser-try');
await setInput(1, 'password123');
const confirmFilled = await setInput(2, 'password123');
await ev(`document.querySelector('button.submit-button').click()`);
const regOk = await waitFor(`!!(document.querySelector('.login-error') || {}).innerText`);
const regErr = regOk ? await loginError() : '';
console.log('  注册报错:', regErr);
check('注册页可切换且能填三个输入框', confirmFilled === 'ok');
check('注册时连不上服务器同样明确报错', /无法连接服务器|连接账号服务器超时/.test(regErr), regErr);
check('注册失败时说明未创建任何账号', inc(regErr, '未创建任何账号'));
check('注册失败后依然没有 token', (await tokenNow()) === null);

// 4c. 额度接口取不到时的界面表现（需要先恢复登录态）
mode = 'off';
await cdp.send('Fetch.disable');
if (before.token) {
  await ev(`(() => {
    localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(before.token)});
    ${before.user ? `localStorage.setItem(${JSON.stringify(USER_KEY)}, ${JSON.stringify(before.user)});` : `localStorage.removeItem(${JSON.stringify(USER_KEY)});`}
    return 1;
  })()`);
}
mode = 'quota-fail';
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/ai/quota*', requestStage: 'Request' }] });
await ev('location.reload()');
await sleep(6000);
check('恢复 JWT 后回到已登录界面', await waitFor(`(document.body.innerText || '').includes('新建')`));
const C = await openAiCard();
const cBtn = await ev(`(() => {
  const b = [...document.querySelectorAll('.ai-member-actions button')].pop();
  return b ? { text: b.textContent.trim(), disabled: !!b.disabled } : null;
})()`);
console.log('  额度取不到时卡片:', JSON.stringify(C.card.line), JSON.stringify(cBtn));
check('额度取不到时卡片给出明确状态（不是空白）',
  /无法连接|超时|尚未获取|正在获取/.test(C.card.line || ''), C.card.line || '');
check('额度不可用时「开通会员」按钮被禁用（避免点了没反应）', cBtn && cBtn.disabled === true, JSON.stringify(cBtn));

// 收尾：解除拦截、还原登录态
mode = 'off';
await cdp.send('Fetch.disable');
if (before.token) {
  await ev(`(() => {
    localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(before.token)});
    ${before.user ? `localStorage.setItem(${JSON.stringify(USER_KEY)}, ${JSON.stringify(before.user)});` : `localStorage.removeItem(${JSON.stringify(USER_KEY)});`}
    return 1;
  })()`);
}
await ev('location.reload()');
await sleep(6000);
const finalState = await readLoginState();
check('收尾后登录态已还原为原 JWT', finalState.token === before.token && finalState.kind === 'JWT');

const bad = results.filter(([, ok]) => !ok).length;
console.log(`=== ${results.length - bad}/${results.length} 通过（拦截命中 ${intercepted} 次）===`);
ws.close();
process.exit(bad === 0 ? 0 : 1);
