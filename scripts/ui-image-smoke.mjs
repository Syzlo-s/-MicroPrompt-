#!/usr/bin/env node
/* =============================================================================
 * 轻提词 · 4.9.0「编辑器插入图片」真机冒烟（WebView2 CDP）
 * =============================================================================
 * 前置：带调试端口启动被测 exe（脚本本身不拉进程）
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"
 *   $env:WEBVIEW2_USER_DATA_FOLDER="D:\mp-image-test\wv2"
 *   $env:MICROPROMPT_DATA_DIR="D:\mp-image-test\data"
 *   $env:MICROPROMPT_PROFILE="test"
 *   D:\mp-image-test\app\轻提词.exe
 *   node scripts/ui-image-smoke.mjs
 *
 * 用例：
 *   A 工具栏存在「插入图片」按钮
 *   B 通过文件输入插入 2400x1600 大图 → 出现 .mp-image-frame，src 为 data:image/...
 *   C 正文只存引用：notes.json 含 data-mp-image，且不含 base64 大字符串
 *   D 图片二进制落盘到 <data>/images/<hex>.<ext>
 *   E 点「缩成预览」→ data-mode=preview，横条高度 ≈34px
 *   F 重载页面后仍是预览模式（持久化）
 *   G 大小图显示尺寸一致（都 320×200）
 *
 * 退出码：0 全部通过 / 1 有失败 / 2 环境失败
 * ========================================================================== */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.MP_CDP_PORT || '9333';
const CDP_URL = `http://127.0.0.1:${PORT}/json/list`;
const BASE = process.env.MP_BASE || 'D:\\mp-image-test';
const DATA_DIR = process.env.MP_DATA_DIR || join(BASE, 'data');
const FIXTURES = process.env.MP_FIXTURES || join(BASE, 'fixtures');
const EVIDENCE = process.env.MP_EVIDENCE_DIR || join(BASE, 'evidence');
const BIG = join(FIXTURES, 'big.png');
const SMALL = join(FIXTURES, 'small.png');

const AUTH_TOKEN_KEY = 'microprompt.authToken';
const AUTH_USER_KEY = 'microprompt.authUser';
const LAST_USED_KEY = 'microprompt.lastUsedAt';
const WELCOME_KEY = 'microprompt.welcomeDone';
const SIDEBAR_KEY = 'microprompt.notesSidebarOpen';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (detail ? '  — ' + detail : ''));
}

/* ---------------- CDP ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout ' + method));
        }
      }, 20000);
    });
  }
}

async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function findPageTarget() {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 30000) {
    try {
      const targets = await fetchJson(CDP_URL);
      last = targets;
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      const loaded = pages.find((t) => t.url && t.url !== 'about:blank');
      if (loaded) return loaded;
      if (pages.length && Date.now() - t0 > 5000) return pages[0];
    } catch {
      /* 端口未就绪 */
    }
    await sleep(300);
  }
  throw new Error('没有可用 page target: ' + JSON.stringify(last));
}

let target;
try {
  target = await findPageTarget();
} catch (e) {
  console.error('连不上 CDP(' + CDP_URL + '): ' + e.message);
  process.exit(2);
}
console.log('  已连接 CDP:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('DOM.enable').catch(() => {});
try {
  await cdp.send('Page.bringToFront');
} catch {}

async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
    throw new Error('页面异常: ' + (d || r.exceptionDetails.text));
  }
  return r.result.value;
}
async function evSafe(expression) {
  try {
    return await ev(expression);
  } catch {
    return undefined;
  }
}
async function waitFor(expression, ms = 10000, interval = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evSafe(expression)) return true;
    await sleep(interval);
  }
  return false;
}

/* ---------------- 前置：登录态 ---------------- */
async function waitApp() {
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const st = await evSafe(`(() => ({
      ready: document.readyState,
      appRoot: !!document.querySelector('.app-root'),
      authLoading: !!document.querySelector('.auth-loading'),
      loginForm: !!document.querySelector('input.form-input'),
      editor: !!document.querySelector('.ProseMirror'),
    }))()`);
    if (st && st.appRoot && !st.authLoading && !st.loginForm) return st;
    await sleep(250);
  }
  return null;
}

async function injectAuthAndReload() {
  await waitFor(`document.readyState === 'complete'`, 15000);
  await ev(`(() => {
    localStorage.setItem(${JSON.stringify(AUTH_TOKEN_KEY)}, 'eyJtest-image-smoke');
    localStorage.setItem(${JSON.stringify(AUTH_USER_KEY)}, JSON.stringify({ id: 't1', name: '测试用户', username: 'tester', email: 't@t.t' }));
    localStorage.setItem(${JSON.stringify(LAST_USED_KEY)}, String(Date.now()));
    localStorage.setItem(${JSON.stringify(WELCOME_KEY)}, '1');
    localStorage.setItem(${JSON.stringify(SIDEBAR_KEY)}, '1');
    return true;
  })()`);
  await cdp.send('Page.reload', { ignoreCache: false });
  return waitApp();
}

console.log('\n[前置] 注入登录态并重载');
let st = await injectAuthAndReload().catch((e) => {
  console.error('  前置失败: ' + e.message);
  return null;
});
if (!st) {
  ws.close();
  process.exit(2);
}

/** 确保编辑区里打开了一篇笔记 */
async function ensureEditor() {
  for (let i = 0; i < 40; i++) {
    const has = await evSafe(`!!document.querySelector('.ProseMirror')`);
    if (has) return true;
    const card = await evSafe(`(() => {
      const c = document.querySelector('.ns-card') || document.querySelector('.note-card');
      if (!c) return false;
      c.click(); return true;
    })()`);
    await sleep(300);
  }
  return false;
}
if (!(await ensureEditor())) {
  console.error('  打不开编辑区');
  ws.close();
  process.exit(2);
}
await ev(`(() => { const pm = document.querySelector('.ProseMirror'); if (pm) pm.focus(); return true; })()`);
await sleep(400);

/* ---------------- 用例 ---------------- */
console.log('\n[用例]');

// A 工具栏按钮
const hasBtn = await evSafe(`!!document.querySelector('[data-tool="insert-image"]')`);
record('A 工具栏存在「插入图片」按钮', !!hasBtn, hasBtn ? '' : '找不到 [data-tool="insert-image"]');

// 通过文件输入插入图片
async function insertViaInput(filePath) {
  const root = await cdp.send('DOM.getDocument', { depth: -1 });
  const q = await cdp.send('DOM.querySelector', {
    nodeId: root.root.nodeId,
    selector: 'input[data-mp-image-input="1"]',
  });
  if (!q.nodeId) return false;
  await cdp.send('DOM.setFileInputFiles', { files: [filePath], nodeId: q.nodeId });
  // 兜底：显式触发 change（部分 WebView2 版本不自动派发）
  await evSafe(`(() => {
    const el = document.querySelector('input[data-mp-image-input="1"]');
    if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  return true;
}

// B 插入大图
const insertedBig = existsSync(BIG) ? await insertViaInput(BIG) : false;
const gotBig = await waitFor(`document.querySelectorAll('.mp-image-frame').length >= 1`, 12000);
const imgInfo = await evSafe(`(() => {
  const f = document.querySelector('.mp-image-frame');
  const im = f && f.querySelector('img');
  const r = f ? f.getBoundingClientRect() : null;
  return {
    frames: document.querySelectorAll('.mp-image-frame').length,
    nodes: document.querySelectorAll('.mp-image-node').length,
    srcKind: im && im.src ? im.src.slice(0, 22) : null,
    w: r ? Math.round(r.width) : 0,
    h: r ? Math.round(r.height) : 0,
    mode: document.querySelector('.mp-image-node')?.getAttribute('data-mode') || null,
  };
})()`);
record(
  'B 插入大图后出现图片框（data:image 渲染）',
  !!(insertedBig && gotBig && imgInfo && imgInfo.w > 0 && String(imgInfo.srcKind).startsWith('data:image')),
  JSON.stringify(imgInfo),
);

// 等落盘（500ms 防抖 + 原子写）
await sleep(1800);

// C 正文只存引用
function readNotes() {
  const p = join(DATA_DIR, 'notes.json');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}
const notesRaw = readNotes();
// 注意：正文 HTML 存在 JSON 字符串里，引号是转义的（\"），所以正则要容许可选反斜杠
const REF_RE = /data-mp-image=\\?"([0-9a-f]{16}\.(png|jpg|jpeg|gif|webp|bmp))\\?"/i;
const hasRef = !!notesRaw && REF_RE.test(notesRaw);
const noBase64 = !!notesRaw && !/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{200,}/.test(notesRaw);
record('C 正文只存图片引用、不含 base64 大串', hasRef && noBase64, hasRef ? 'ref ok' : 'no data-mp-image ref');

// D 图片落盘
const imgDir = join(DATA_DIR, 'images');
const files = existsSync(imgDir) ? readdirSync(imgDir) : [];
const refId = notesRaw && (notesRaw.match(REF_RE) || [])[1];
const diskOk = !!refId && files.includes(refId);
record('D 图片二进制落盘到 images/<hash>.<ext>', diskOk, `ref=${refId || '-'} files=${files.length}`);

// 缩放系数（应用可能带 CSS zoom，320x200 是 CSS 尺寸，实际 rect 会按 zoom 放大）
const zoom = imgInfo && imgInfo.h > 0 ? imgInfo.h / 200 : 1;

// E 缩成预览
const toggled = await evSafe(`(() => {
  const b = document.querySelector('.mp-image-node .mp-image-tools button[aria-label="缩成预览"]');
  if (!b) return false;
  b.click(); return true;
})()`);
await sleep(600);
const previewState = await evSafe(`(() => {
  const n = document.querySelector('.mp-image-node');
  const chip = document.querySelector('.mp-image-chip');
  const r = chip ? chip.getBoundingClientRect() : null;
  return { mode: n?.getAttribute('data-mode'), h: r ? Math.round(r.height) : 0, chip: !!chip };
})()`);
record(
  'E 点「缩成预览」收成 34px 横条',
  !!toggled &&
    previewState &&
    previewState.mode === 'preview' &&
    previewState.chip &&
    Math.abs(previewState.h - 34 * zoom) <= 6,
  JSON.stringify(previewState) + ' zoom=' + zoom.toFixed(2),
);

// F 持久化：等落盘后重载
await sleep(1800);
const savedMode = /data-mp-mode=\\?"preview\\?"/.test(readNotes() || '');
await cdp.send('Page.reload', { ignoreCache: false });
await waitApp();
await ensureEditor();
await waitFor(`!!document.querySelector('.mp-image-node')`, 12000);
const afterReload = await evSafe(`(() => {
  const n = document.querySelector('.mp-image-node');
  return { mode: n?.getAttribute('data-mode'), chip: !!document.querySelector('.mp-image-chip') };
})()`);
record(
  'F 重载后仍是预览模式（持久化生效）',
  savedMode && afterReload && afterReload.mode === 'preview' && afterReload.chip,
  `saved=${savedMode} after=${JSON.stringify(afterReload)}`,
);

// 全部展开回 normal，便于比较尺寸
await evSafe(`(() => {
  document.querySelectorAll('.mp-image-node.is-preview .mp-image-chip').forEach((c) => c.click());
  return true;
})()`);
await sleep(500);

// G 大小图尺寸一致（插入小图后两张都应是同一显示尺寸）
const smallInserted = existsSync(SMALL) ? await insertViaInput(SMALL) : false;
await waitFor(`document.querySelectorAll('.mp-image-frame').length >= 2`, 12000);
await sleep(1200);
const sizeCmp = await evSafe(`(() => {
  const frames = [...document.querySelectorAll('.mp-image-node')]
    .filter((n) => n.getAttribute('data-mode') !== 'preview')
    .map((n) => { const f = n.querySelector('.mp-image-frame'); const r = f.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  return { frames };
})()`);
const sameSize =
  sizeCmp &&
  sizeCmp.frames.length >= 2 &&
  sizeCmp.frames.every((f) => Math.abs(f[0] - sizeCmp.frames[0][0]) <= 1 && Math.abs(f[1] - sizeCmp.frames[0][1]) <= 1) &&
  Math.abs(sizeCmp.frames[0][0] / sizeCmp.frames[0][1] - 1.6) < 0.02;
record('G 大图/小图显示尺寸一致（同尺寸、320:200 比例）', !!smallInserted && sameSize, JSON.stringify(sizeCmp));

// H 重复插入同一张图不产生新文件（FNV-1a 去重）
const beforeCount = (existsSync(imgDir) ? readdirSync(imgDir) : []).length;
await insertViaInput(BIG);
await sleep(1500);
const afterCount = (existsSync(imgDir) ? readdirSync(imgDir) : []).length;
record('H 同一张图重复插入不新增文件（内容哈希去重）', afterCount === beforeCount, `before=${beforeCount} after=${afterCount}`);

/* ---------------- 报告 ---------------- */
const failed = results.filter((r) => !r.pass);
mkdirSync(EVIDENCE, { recursive: true });
const report = {
  when: new Date().toISOString(),
  dataDir: DATA_DIR,
  imagesOnDisk: files,
  results,
  pass: results.length - failed.length,
  fail: failed.length,
};
writeFileSync(join(EVIDENCE, 'image-smoke.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\n  结果: ${report.pass}/${results.length} 通过` + (failed.length ? '，失败: ' + failed.map((f) => f.name).join('; ') : ''));
ws.close();
process.exit(failed.length ? 1 : 0);
