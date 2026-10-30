#!/usr/bin/env node
/* =============================================================================
 * 轻提词 · 文件管理台命名弹窗「取消」按钮真机回归（WebView2 CDP + 真实鼠标事件）
 * =============================================================================
 *
 * 背景（4.8.7 bug）：
 *   FileManager 把 InputDialog / ConfirmDialog 渲染在 `.fm-layer` 内部，
 *   而 `.fm-layer { pointer-events: none }`（用于管理台展开动画期间点击穿透到侧栏）。
 *   `.dialog-overlay` 没有显式恢复 pointer-events，而 pointer-events 是继承属性
 *   → 整个弹窗（含「取消」「确定」按钮）都无法被鼠标命中，只能靠键盘 Esc / Enter。
 *
 * 本脚本刻意使用 CDP 的 Input.dispatchMouseEvent 派发**真实鼠标事件**
 * （而不是 element.click()）——pointer-events:none 时程序化 click 仍会触发，
 * 会「假通过」。
 *
 * 用例：
 *   A 管理台底部工具栏「新建笔记」→ 弹窗 → 真实鼠标点「取消」→ 弹窗关闭、未新建笔记
 *   B 管理台左栏「＋新建分类合集」→ 弹窗 → 取消 → 关闭、未新增分类
 *   C 管理台卡片「更多」→ 菜单「重命名」→ 弹窗 → 取消 → 关闭
 *   D 管理台卡片「更多」→ 菜单「删除」→ ConfirmDialog → 取消 → 关闭、笔记未删
 *   E 对照组：退出管理台 → Ctrl+Shift+B 打开侧栏 → 侧栏「新建笔记」→ 取消 → 关闭
 *      （作用：证明 bug 只出在 .fm-layer 子树；修复前就应 PASS）
 *   F 附加：管理台「重命名」弹窗 → 真实鼠标点「确定」（标题不变，不产生副作用）→ 关闭
 *      （验证「确定」同样恢复可点）
 *
 * 每个弹窗用例都记录：
 *   - getComputedStyle('.dialog-overlay').pointerEvents（修复前应为 none，修复后 auto）
 *   - 取消按钮中心 document.elementFromPoint() 的 tagName / className
 *     （修复前应为下层元素，修复后应为 .dlg-cancel 按钮自身）
 *   - 真实点击后弹窗是否关闭、管理台/侧栏是否仍打开（防止点击穿透把弹窗连带卸载假通过）
 *   - 页面卡片数与 data/notes.json 条数是否未变
 *
 * 用法（先带调试端口启动便携版/测试 exe）：
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
 *   $env:WEBVIEW2_USER_DATA_FOLDER="D:\mp-cancel-test\wv2"
 *   $env:MICROPROMPT_DATA_DIR="D:\mp-cancel-test\data"
 *   $env:MICROPROMPT_PROFILE="test"
 *   D:\mp-cancel-test\app\轻提词.exe
 *   node scripts/ui-dialog-cancel-smoke.mjs          # 全部通过退出码 0
 *
 * 可调环境变量：
 *   MP_CDP_PORT        调试端口，默认 9222（被占用时换成 9333 等）
 *   MP_CANCEL_BASE     scratch 根目录，默认 D:\mp-cancel-test
 *   MP_DATA_DIR        notes.json 所在目录，默认 <base>\data
 *   MP_EVIDENCE_DIR    截图 / report.json 输出目录，默认 <base>\evidence
 *   MP_APP_EXE         被测 exe（写入报告，便于区分修复前/后），默认 <base>\app\轻提词.exe
 *   MP_EXPECT          'buggy' | 'fixed' | 'auto'（只影响报告里的期望说明，不影响退出码）
 *   MP_ONLY            只跑指定用例，如 "A,E"
 *
 * 退出码：0 = 全部用例通过；1 = 有失败；2 = 环境/启动前置失败。
 *
 * 安全兜底：脚本会先快照 6 个 localStorage 键（登录 token / 用户 / lastUsedAt /
 *   welcomeDone / notesSidebarOpen / noteCategories），用例跑完再原样还原，
 *   尽量不破坏被测页面原有登录态；但仍**强烈建议**用隔离的
 *   WEBVIEW2_USER_DATA_FOLDER + MICROPROMPT_DATA_DIR 启动测试 exe（见上），
 *   不要把本脚本对着用户日常使用的真实 profile 跑。
 * ========================================================================== */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.MP_CDP_PORT || '9222';
const CDP_URL = `http://127.0.0.1:${PORT}/json/list`;
const BASE_DIR = process.env.MP_CANCEL_BASE || 'D:\\mp-cancel-test';
const DATA_DIR = process.env.MP_DATA_DIR || join(BASE_DIR, 'data');
const EVIDENCE_DIR = process.env.MP_EVIDENCE_DIR || join(BASE_DIR, 'evidence');
const APP_EXE = process.env.MP_APP_EXE || join(BASE_DIR, 'app', '轻提词.exe');
const EXPECT = process.env.MP_EXPECT || 'auto';
const ONLY = (process.env.MP_ONLY || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const AUTH_TOKEN_KEY = 'microprompt.authToken';
const AUTH_USER_KEY = 'microprompt.authUser';
const LAST_USED_KEY = 'microprompt.lastUsedAt';
const WELCOME_KEY = 'microprompt.welcomeDone';
const SIDEBAR_KEY = 'microprompt.notesSidebarOpen';
const CATEGORIES_KEY = 'microprompt.noteCategories';
/** 脚本会临时改写、跑完要原样还原的 localStorage 键（安全兜底） */
const RESTORE_KEYS = [
  AUTH_TOKEN_KEY,
  AUTH_USER_KEY,
  LAST_USED_KEY,
  WELCOME_KEY,
  SIDEBAR_KEY,
  CATEGORIES_KEY,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 结果收集 ---------------- */
const startedAt = new Date().toISOString();
const cases = new Map();
const caseOrder = [];
const preflight = [];
const results = [];

function ensureCase(id, label) {
  if (!cases.has(id)) {
    const c = { id, label, checks: [], passed: false, error: '', evidence: null };
    cases.set(id, c);
    caseOrder.push(id);
  }
  return cases.get(id);
}
function ck(id, name, ok, detail = '') {
  const c = ensureCase(id, id);
  const check = { name, ok: !!ok, detail };
  c.checks.push(check);
  results.push([`${id} · ${name}`, !!ok]);
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + `${id} · ${name}` + (detail ? '   ' + detail : ''));
  return !!ok;
}
function pre(name, ok, detail = '') {
  preflight.push({ name, ok: !!ok, detail });
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + `[前置] ${name}` + (detail ? '   ' + detail : ''));
  return !!ok;
}
const shouldRun = (id) => ONLY.length === 0 || ONLY.includes(id);

/* ---------------- CDP 客户端（参照 scripts/ui-smoke.mjs） ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method && this.handlers.has(msg.method)) {
        this.handlers.get(msg.method)(msg.params);
      }
    });
  }
  on(m, fn) {
    this.handlers.set(m, fn);
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

/* ---------------- 连接 ---------- */
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
      /* 端口还没起来 */
    }
    await sleep(300);
  }
  throw new Error('CDP 没有可用的 page target：' + JSON.stringify(last));
}

let target;
try {
  target = await findPageTarget();
} catch (e) {
  console.error('连不上 WebView2 CDP（' + CDP_URL + '）：' + e.message);
  console.error('请先按文件头注释设置 4 个环境变量并启动被测 exe（调试端口 ' + PORT + '）。');
  process.exit(2);
}
console.log('已连接 CDP target:', target.url, '(' + target.id + ')');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
const cdp = new CDP(ws);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
try {
  await cdp.send('Page.bringToFront');
} catch {
  /* 老版本不支持就忽略 */
}

async function ev(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
    throw new Error('页面脚本异常: ' + (d || r.exceptionDetails.text));
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
async function waitFor(expression, ms = 8000, interval = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evSafe(expression)) return true;
    await sleep(interval);
  }
  return false;
}

/* ---------------- 真实输入事件 ---------------- */
async function mouseMove(x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  });
}
async function realClick(x, y) {
  await mouseMove(x, y);
  await sleep(35);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'mouse',
  });
  await sleep(45);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'mouse',
  });
}
async function keyTap(key, code, vk, modifiers = 0) {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await sleep(25);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(25);
}
const pressEscape = () => keyTap('Escape', 'Escape', 27);
const pressCtrlK = () => keyTap('k', 'KeyK', 75, 2);
const pressCtrlShiftB = () => keyTap('b', 'KeyB', 66, 2 | 8);

/* ---------------- 页面探测 ---------------- */
async function getRect(selector, index = 0) {
  return await ev(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 };
  })()`);
}
async function hitAt(cx, cy) {
  return await ev(`(() => {
    const h = document.elementFromPoint(${Number(cx)}, ${Number(cy)});
    if (!h) return null;
    return {
      tag: h.tagName,
      cls: String(h.className || ''),
      text: (h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      inCancel: !!(h.closest && h.closest('.dlg-cancel')),
      inConfirm: !!(h.closest && h.closest('.dlg-confirm')),
      inPanel: !!(h.closest && h.closest('.dlg-panel')),
      inManager: !!(h.closest && h.closest('.fm-layer')),
      inSidebar: !!(h.closest && h.closest('.notes-sidebar')),
    };
  })()`);
}
const DIALOG_SNAPSHOT = `(() => {
  const overlay = document.querySelector('.dialog-overlay');
  if (!overlay) return null;
  const panel = overlay.querySelector('.dlg-panel');
  const cancel = overlay.querySelector('.dlg-cancel');
  const confirm = overlay.querySelector('.dlg-confirm');
  const titleEl = overlay.querySelector('.dlg-title');
  const r = cancel ? cancel.getBoundingClientRect() : null;
  const cx = r ? r.x + r.width / 2 : null;
  const cy = r ? r.y + r.height / 2 : null;
  const hit = cx === null ? null : document.elementFromPoint(cx, cy);
  return {
    title: titleEl ? titleEl.textContent.trim() : null,
    overlayPointerEvents: getComputedStyle(overlay).pointerEvents,
    panelPointerEvents: panel ? getComputedStyle(panel).pointerEvents : null,
    cancelPointerEvents: cancel ? getComputedStyle(cancel).pointerEvents : null,
    confirmPointerEvents: confirm ? getComputedStyle(confirm).pointerEvents : null,
    cancelRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height, cx, cy } : null,
    hit: hit ? {
      tag: hit.tagName,
      cls: String(hit.className || ''),
      text: (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      inCancel: !!(hit.closest && hit.closest('.dlg-cancel')),
      inConfirm: !!(hit.closest && hit.closest('.dlg-confirm')),
      inPanel: !!(hit.closest && hit.closest('.dlg-panel')),
      inManager: !!(hit.closest && hit.closest('.fm-layer')),
      inSidebar: !!(hit.closest && hit.closest('.notes-sidebar')),
    } : null,
    managerOpen: !!document.querySelector('.fm-layer'),
    sidebarOpen: !!document.querySelector('.notes-sidebar.open'),
    menuOpen: !!document.querySelector('.ctx-menu'),
    activeTag: document.activeElement ? document.activeElement.tagName : null,
  };
})()`;

async function baselineState() {
  return await ev(`(() => {
    let categories = -1;
    try { categories = JSON.parse(localStorage.getItem(${JSON.stringify(CATEGORIES_KEY)}) || '[]').length; } catch (e) { categories = -1; }
    return {
      pageCards: document.querySelectorAll('.ns-card').length,
      managerCards: document.querySelectorAll('.fm-layer .ns-card').length,
      sidebarCards: document.querySelectorAll('.notes-sidebar .ns-card').length,
      managerOpen: !!document.querySelector('.fm-layer'),
      sidebarOpen: !!document.querySelector('.notes-sidebar.open'),
      dialogOpen: !!document.querySelector('.dialog-overlay .dlg-panel'),
      menuOpen: !!document.querySelector('.ctx-menu'),
      categories,
      railCustom: document.querySelectorAll('.fm-layer [data-group="我的合集"] .fm-rail-item').length,
    };
  })()`);
}
function diskNotes() {
  try {
    const arr = JSON.parse(readFileSync(join(DATA_DIR, 'notes.json'), 'utf8'));
    return Array.isArray(arr) ? arr.length : null;
  } catch {
    return null;
  }
}

/* ---------------- 截图 ---------------- */
let shotCount = 0;
async function shot(name) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(EVIDENCE_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    shotCount++;
    return file;
  } catch (e) {
    console.log('  [warn] 截图失败 ' + name + ': ' + e.message);
    return null;
  }
}

/* ---------------- 动作封装 ---------------- */
async function clickSelector(selector, index = 0) {
  const rect = await getRect(selector, index);
  if (!rect || !rect.visible) throw new Error('找不到可点击元素：' + selector);
  const hit = await hitAt(rect.cx, rect.cy);
  await realClick(rect.cx, rect.cy);
  return { rect, hit };
}

/** 关闭残留的弹窗 / 右键菜单（仅用于用例之间的清场，不参与断言） */
async function closeTransientUi() {
  for (let i = 0; i < 4; i++) {
    const bad = await evSafe(
      `!!(document.querySelector('.dialog-overlay .dlg-panel') || document.querySelector('.ctx-menu'))`,
    );
    if (!bad) return;
    await pressEscape();
    await sleep(250);
  }
  if (await evSafe(`!!document.querySelector('.ctx-menu')`)) {
    await evSafe(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await sleep(200);
  }
}

async function managerOpen() {
  return !!(await evSafe(`!!document.querySelector('.fm-layer')`));
}
async function sidebarOpen() {
  return !!(await evSafe(`!!document.querySelector('.notes-sidebar.open')`));
}

async function ensureManagerOpen() {
  await closeTransientUi();
  if (await managerOpen()) {
    if (!(await waitFor(`document.querySelectorAll('.fm-layer .ns-card').length > 0`, 4000))) {
      throw new Error('管理台已打开但没有卡片');
    }
    return 'already-open';
  }
  await pressCtrlK();
  let ok = await waitFor(`!!document.querySelector('.fm-layer')`, 2500);
  if (!ok) {
    await evSafe(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`,
    );
    ok = await waitFor(`!!document.querySelector('.fm-layer')`, 2500);
  }
  if (!ok) throw new Error('Ctrl+K 未能打开文件管理台');
  const wallOk = await waitFor(`document.querySelectorAll('.fm-layer .ns-card').length > 0`, 6000);
  if (!wallOk) throw new Error('管理台打开后卡片墙没有渲染出卡片');
  await sleep(550); // 等 480ms FLIP 展开动画结束，坐标稳定
  return 'ctrl+k';
}

async function ensureManagerClosed() {
  if (!(await managerOpen())) return 'already-closed';
  await closeTransientUi();
  await pressEscape();
  let ok = await waitFor(`!document.querySelector('.fm-layer')`, 3000);
  if (!ok) {
    await pressCtrlK();
    ok = await waitFor(`!document.querySelector('.fm-layer')`, 3000);
  }
  if (!ok) throw new Error('Esc / Ctrl+K 未能退出文件管理台');
  await sleep(250);
  return 'escape';
}

async function ensureSidebarOpenByShortcut() {
  let open = await sidebarOpen();
  if (open) {
    // 先收起，确保「Ctrl+Shift+B 打开侧栏」这条键盘路径确实被走到
    await pressCtrlShiftB();
    let closed = await waitFor(`!document.querySelector('.notes-sidebar.open')`, 1800);
    if (!closed) {
      await evSafe(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, shiftKey: true, bubbles: true }))`,
      );
      closed = await waitFor(`!document.querySelector('.notes-sidebar.open')`, 1800);
    }
    open = !closed;
  }
  if (!open) {
    await pressCtrlShiftB();
    let ok = await waitFor(`!!document.querySelector('.notes-sidebar.open')`, 2500);
    if (!ok) {
      await evSafe(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, shiftKey: true, bubbles: true }))`,
      );
      ok = await waitFor(`!!document.querySelector('.notes-sidebar.open')`, 2500);
    }
    if (!ok) throw new Error('Ctrl+Shift+B 未能打开笔记侧栏');
  }
  await sleep(600); // 侧栏展开动画
  return 'ctrl+shift+b';
}

/** 打开管理台卡片「更多」菜单 */
async function openCardContextMenu() {
  const cards = await ev(`[...document.querySelectorAll('.fm-layer .ns-card')].map((el) => {
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height };
  })`);
  if (!cards.length) throw new Error('管理台卡片墙里没有笔记卡片');
  const card = cards[0];
  await mouseMove(card.cx, card.cy);
  await sleep(420); // 等 .ns-card:hover .ns-card-acts 的 160ms 过渡
  for (let attempt = 0; attempt < 3; attempt++) {
    const rect = await getRect('.fm-layer .ns-card .ns-card-acts button[aria-label="更多操作"]', 0);
    if (!rect || !rect.visible) {
      await mouseMove(card.cx, card.cy);
      await sleep(350);
      continue;
    }
    await realClick(rect.cx, rect.cy);
    if (await waitFor(`!!document.querySelector('.ctx-menu')`, 2500)) {
      await sleep(150);
      return { card, rect };
    }
    await mouseMove(card.cx, card.cy);
    await sleep(350);
  }
  throw new Error('点击卡片「更多操作」后右键菜单没有出现');
}

/** 真实鼠标点击 portal 到 body 的右键菜单项 */
async function clickContextMenuItem(labelIncludes) {
  const appeared = await waitFor(`!!document.querySelector('.ctx-menu .ctx-item')`, 3000);
  if (!appeared) throw new Error('右键菜单没有出现');
  await sleep(150);
  const item = await ev(`(() => {
    const items = [...document.querySelectorAll('.ctx-menu .ctx-item')];
    const it = items.find((e) => (e.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(labelIncludes)}));
    if (!it) return null;
    const r = it.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height, text: (it.textContent || '').trim() };
  })()`);
  if (!item) {
    const texts = await ev(
      `[...document.querySelectorAll('.ctx-menu .ctx-item')].map((e) => (e.textContent || '').trim())`,
    );
    throw new Error('菜单里找不到包含「' + labelIncludes + '」的项；现有：' + JSON.stringify(texts));
  }
  const hit = await hitAt(item.cx, item.cy);
  await realClick(item.cx, item.cy);
  return { item, hit };
}

async function waitDialog() {
  const ok = await waitFor(`!!document.querySelector('.dialog-overlay .dlg-panel')`, 5000);
  if (!ok) throw new Error('弹窗没有出现（.dialog-overlay .dlg-panel）');
  await sleep(260); // 等弹窗 pop-in 动画结束，按钮坐标稳定
}

function compactDialog(s) {
  if (!s) return null;
  return {
    title: s.title,
    overlayPointerEvents: s.overlayPointerEvents,
    panelPointerEvents: s.panelPointerEvents,
    cancelPointerEvents: s.cancelPointerEvents,
    confirmPointerEvents: s.confirmPointerEvents,
    cancelRect: s.cancelRect,
    elementFromPoint: s.hit,
    managerOpen: s.managerOpen,
    sidebarOpen: s.sidebarOpen,
  };
}

/**
 * 通用：对一个已打开的弹窗记录证据 → 真实鼠标点击指定按钮 → 断言关闭与无副作用。
 * opts: { id, buttonSelector, expectedTitle, container: 'manager'|'sidebar', base, baseDisk, checkCategories }
 */
async function dialogButtonCase(opts) {
  const { id, buttonSelector, expectedTitle, container, base, baseDisk, checkCategories } = opts;
  const label = buttonSelector === '.dlg-confirm' ? '确定' : '取消';
  const before = await ev(DIALOG_SNAPSHOT);
  if (!before) {
    ck(id, '弹窗出现', false, '未检测到 .dialog-overlay');
    return;
  }
  const shotBefore = await shot(`${id}-dialog-before-${label}`);
  ck(id, '弹窗出现', true);
  ck(
    id,
    `弹窗标题为「${expectedTitle}」`,
    (before.title || '').includes(expectedTitle),
    `title=${JSON.stringify(before.title)}`,
  );
  ck(
    id,
    '取消按钮已渲染且尺寸有效',
    !!(before.cancelRect && before.cancelRect.w > 0 && before.cancelRect.h > 0),
    JSON.stringify(before.cancelRect),
  );
  ck(
    id,
    '取消按钮中心 elementFromPoint 命中按钮自身',
    !!(before.hit && before.hit.inCancel),
    `overlay.pointerEvents=${before.overlayPointerEvents}；命中=${
      before.hit ? before.hit.tag + '.' + before.hit.cls : 'null'
    }${before.hit && before.hit.text ? `（"${before.hit.text}"）` : ''}`,
  );
  ck(
    id,
    "getComputedStyle('.dialog-overlay').pointerEvents 可命中鼠标",
    before.overlayPointerEvents === 'auto' || before.overlayPointerEvents === 'all',
    `pointerEvents=${before.overlayPointerEvents}`,
  );

  // 目标按钮中心
  const btnRect = await getRect(buttonSelector, 0);
  if (!btnRect || !btnRect.visible) {
    ck(id, `${label}按钮可见`, false, JSON.stringify(btnRect));
    return;
  }
  const btnHit = await hitAt(btnRect.cx, btnRect.cy);
  await realClick(btnRect.cx, btnRect.cy);
  await sleep(550);

  const after = await ev(DIALOG_SNAPSHOT);
  const shotAfter = await shot(`${id}-after-${label}`);
  ck(
    id,
    `真实鼠标点「${label}」后弹窗已关闭`,
    !after,
    after ? `弹窗仍在：title=${JSON.stringify(after.title)}` : '',
  );
  const now = await baselineState();
  const containerOk = container === 'manager' ? now.managerOpen : now.sidebarOpen;
  ck(
    id,
    container === 'manager' ? '文件管理台仍然打开（未点穿到下层）' : '笔记侧栏仍然打开',
    containerOk,
    JSON.stringify({ managerOpen: now.managerOpen, sidebarOpen: now.sidebarOpen }),
  );
  await sleep(400); // 给可能触发的落盘留出时间
  const diskNow = diskNotes();
  ck(
    id,
    '笔记数量未变（页面卡片）',
    now.pageCards === base.pageCards,
    `before=${base.pageCards} after=${now.pageCards}`,
  );
  ck(
    id,
    '笔记数量未变（data/notes.json）',
    diskNow === baseDisk,
    `before=${baseDisk} after=${diskNow}`,
  );
  if (checkCategories) {
    ck(
      id,
      '未新增分类（localStorage noteCategories）',
      now.categories === base.categories,
      `before=${base.categories} after=${now.categories}`,
    );
    ck(
      id,
      '未新增分类（管理台左栏「我的合集」项数）',
      now.railCustom === base.railCustom,
      `before=${base.railCustom} after=${now.railCustom}`,
    );
  }
  ensureCase(id).evidence = {
    dialogBefore: compactDialog(before),
    buttonClicked: { label, selector: buttonSelector, rect: btnRect, elementFromPoint: btnHit },
    dialogAfter: compactDialog(after),
    stateAfter: now,
    screenshots: [shotBefore, shotAfter],
  };
  return { before, after, now, diskNow, shotBefore, shotAfter, btnHit };
}

/* ---------------- 用例（失败不中断，汇总 PASS/FAIL） ---------------- */
async function runCase(id, label, fn) {
  ensureCase(id, label);
  if (!shouldRun(id)) {
    console.log(`  [SKIP] ${id} · ${label}（MP_ONLY 未包含）`);
    return;
  }
  console.log(`\n[用例 ${id}] ${label}`);
  try {
    await fn();
  } catch (e) {
    const c = ensureCase(id);
    c.error = 'EXCEPTION: ' + (e && e.message);
    console.log('  [FAIL] ' + id + ' · 用例异常：' + (e && e.message));
  } finally {
    try {
      await closeTransientUi();
    } catch {
      /* ignore */
    }
    const c = ensureCase(id);
    c.passed = !c.error && c.checks.length > 0 && c.checks.every((x) => x.ok);
    c.failedChecks = c.checks.filter((x) => !x.ok).map((x) => x.name);
    console.log(`  → ${id} ${c.passed ? 'PASS' : 'FAIL'}（${c.checks.filter((x) => x.ok).length}/${c.checks.length} 子项通过）`);
  }
}

/* =========================================================================
 * 0. 前置：登录态注入 + reload + 等主界面
 * ======================================================================= */
async function injectAuthAndReload() {
  const ready = await waitFor(
    `document.readyState === 'complete' || (document.body && document.body.childElementCount > 0)`,
    15000,
  );
  if (!ready) throw new Error('页面一直没就绪');
  const hrefBefore = await evSafe('location.href');
  // 先快照会被改写的 localStorage 键，结束时还原（防止误跑真实 profile 覆盖登录态 / 分类）
  const storageSnapshot = await evSafe(`(() => {
    const keys = ${JSON.stringify(RESTORE_KEYS)};
    const out = {};
    for (const k of keys) {
      try { out[k] = localStorage.getItem(k); } catch (e) { out[k] = null; }
    }
    return out;
  })()`);
  await ev(`(() => {
    localStorage.setItem(${JSON.stringify(AUTH_TOKEN_KEY)}, 'eyJtest-cancel-fix');
    localStorage.setItem(${JSON.stringify(AUTH_USER_KEY)}, JSON.stringify({ id: 't1', name: '测试用户', username: 'tester', email: 't@t.t' }));
    localStorage.setItem(${JSON.stringify(LAST_USED_KEY)}, String(Date.now()));
    localStorage.setItem(${JSON.stringify(WELCOME_KEY)}, '1');
    localStorage.setItem(${JSON.stringify(SIDEBAR_KEY)}, '1');
    localStorage.setItem(${JSON.stringify(CATEGORIES_KEY)}, '[]');
    return true;
  })()`);
  await cdp.send('Page.reload', { ignoreCache: false });
  const t0 = Date.now();
  let state = null;
  while (Date.now() - t0 < 30000) {
    state = await evSafe(`(() => ({
      ready: document.readyState,
      href: location.href,
      authLoading: !!document.querySelector('.auth-loading'),
      appRoot: !!document.querySelector('.app-root'),
      loginForm: !!document.querySelector('input.form-input'),
      cards: document.querySelectorAll('.ns-card').length,
      token: (() => { try { return localStorage.getItem(${JSON.stringify(AUTH_TOKEN_KEY)}); } catch (e) { return 'ERR'; } })(),
    }))()`);
    if (state && state.appRoot && !state.authLoading && !state.loginForm && state.cards > 0) break;
    await sleep(250);
  }
  await sleep(300);
  return { hrefBefore, state, storageSnapshot };
}

console.log('\n[前置] 注入登录态并重载页面');
const startup = await injectAuthAndReload().catch((e) => {
  console.error('前置失败：' + e.message);
  return null;
});
if (!startup) {
  ws.close();
  process.exit(2);
}
const viewport = await evSafe(`(() => {
  const root = document.querySelector('.app-root');
  return {
    w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
    zoom: root ? root.style.zoom || null : null,
    href: location.href,
    ua: navigator.userAgent,
  };
})()`);
pre('页面已重载并进入主界面（.app-root）', !!(startup.state && startup.state.appRoot), JSON.stringify(startup.state));
pre('登录态 token 已注入', startup.state && startup.state.token !== null, String(startup.state && startup.state.token));
pre('笔记数据已加载（页面卡片 > 0）', !!(startup.state && startup.state.cards > 0), `cards=${startup.state && startup.state.cards}`);
const startupShot = await shot('00-startup');
const dataNotesStart = diskNotes();
console.log(`  视口：${JSON.stringify(viewport)}；data/notes.json=${dataNotesStart} 条`);

if (!(startup.state && startup.state.appRoot)) {
  console.error('主界面没有出现，后续用例没有意义，退出。');
  ws.close();
  process.exit(2);
}

/* ---------- A：管理台底部工具栏「新建笔记」→ 取消 ---------- */
await runCase('A', '文件管理台「新建笔记」弹窗：真实鼠标点「取消」应关闭', async () => {
  const via = await ensureManagerOpen();
  const base = await baselineState();
  const baseDisk = diskNotes();
  await clickSelector('.fm-layer .ns-toolbar button[aria-label="新建笔记"]');
  await waitDialog();
  const r = await dialogButtonCase({
    id: 'A',
    buttonSelector: '.dlg-cancel',
    expectedTitle: '新建笔记',
    container: 'manager',
    base,
    baseDisk,
    checkCategories: false,
  });
  if (r && r.before) ensureCase('A').evidence.openVia = via;
});

/* ---------- B：管理台左栏「＋新建分类合集」→ 取消 ---------- */
await runCase('B', '文件管理台「新建分类」弹窗：真实鼠标点「取消」应关闭且不新增分类', async () => {
  const via = await ensureManagerOpen();
  const base = await baselineState();
  const baseDisk = diskNotes();
  await clickSelector('.fm-layer .fm-rail-new');
  await waitDialog();
  const r = await dialogButtonCase({
    id: 'B',
    buttonSelector: '.dlg-cancel',
    expectedTitle: '新建分类',
    container: 'manager',
    base,
    baseDisk,
    checkCategories: true,
  });
  if (r && r.before) ensureCase('B').evidence.openVia = via;
});

/* ---------- C：管理台卡片「更多」→「重命名」→ 取消 ---------- */
await runCase('C', '文件管理台「重命名笔记」弹窗：真实鼠标点「取消」应关闭', async () => {
  const via = await ensureManagerOpen();
  const base = await baselineState();
  const baseDisk = diskNotes();
  await openCardContextMenu();
  await clickContextMenuItem('重命名');
  await waitDialog();
  const r = await dialogButtonCase({
    id: 'C',
    buttonSelector: '.dlg-cancel',
    expectedTitle: '重命名笔记',
    container: 'manager',
    base,
    baseDisk,
    checkCategories: false,
  });
  if (r && r.before) ensureCase('C').evidence.openVia = via;
});

/* ---------- D：管理台卡片「更多」→「删除」→ ConfirmDialog → 取消 ---------- */
await runCase('D', '文件管理台「删除笔记」确认弹窗：真实鼠标点「取消」应关闭且不删除', async () => {
  const via = await ensureManagerOpen();
  const base = await baselineState();
  const baseDisk = diskNotes();
  await openCardContextMenu();
  await clickContextMenuItem('删除');
  await waitDialog();
  const r = await dialogButtonCase({
    id: 'D',
    buttonSelector: '.dlg-cancel',
    expectedTitle: '删除笔记',
    container: 'manager',
    base,
    baseDisk,
    checkCategories: false,
  });
  if (r && r.before) ensureCase('D').evidence.openVia = via;
});

/* ---------- F（附加）：「确定」按钮也恢复可点（重命名弹窗，值不变 → 无副作用） ---------- */
await runCase('F', '文件管理台「重命名笔记」弹窗：真实鼠标点「确定」应关闭（验证确定按钮同样可点）', async () => {
  const via = await ensureManagerOpen();
  const base = await baselineState();
  const baseDisk = diskNotes();
  await openCardContextMenu();
  await clickContextMenuItem('重命名');
  await waitDialog();
  const r = await dialogButtonCase({
    id: 'F',
    buttonSelector: '.dlg-confirm',
    expectedTitle: '重命名笔记',
    container: 'manager',
    base,
    baseDisk,
    checkCategories: false,
  });
  ensureCase('F').evidence.openVia = via;
  // 重命名弹窗初始值就是原标题，直接点「确定」= rename 成同名 → store 内 no-op（不产生数据变化）
});

/* ---------- E（对照组）：侧栏「新建笔记」→ 取消，修复前就应 PASS ---------- */
await runCase('E', '对照组：侧栏「新建笔记」弹窗（不在 .fm-layer 子树）真实鼠标点「取消」应关闭', async () => {
  const exitVia = await ensureManagerClosed();
  const sidebarVia = await ensureSidebarOpenByShortcut();
  const base = await baselineState();
  const baseDisk = diskNotes();
  await clickSelector('.notes-sidebar .ns-toolbar button[aria-label="新建笔记"]');
  await waitDialog();
  const r = await dialogButtonCase({
    id: 'E',
    buttonSelector: '.dlg-cancel',
    expectedTitle: '新建笔记',
    container: 'sidebar',
    base,
    baseDisk,
    checkCategories: false,
  });
  if (ensureCase('E').evidence) {
    ensureCase('E').evidence.group = { exitManagerVia: exitVia, openSidebarVia: sidebarVia };
  }
});

/* ---------- 收尾：把开始前快照的 localStorage 键原样还原（安全兜底） ---------- */
async function restoreOriginalStorage(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  try {
    const ok = await ev(`(() => {
      const snap = ${JSON.stringify(snapshot)};
      for (const k of Object.keys(snap)) {
        try {
          if (snap[k] === null) localStorage.removeItem(k);
          else localStorage.setItem(k, snap[k]);
        } catch (e) { /* ignore */ }
      }
      return true;
    })()`);
    return ok === true;
  } catch {
    return false;
  }
}

const storageRestored = await restoreOriginalStorage(startup && startup.storageSnapshot);
if (storageRestored) {
  console.log('  已还原被测页面原有 localStorage（登录态 / 侧栏开合 / 分类）');
}

/* =========================================================================
 * 汇总 + 报告
 * ======================================================================= */
const finishedAt = new Date().toISOString();
const caseList = caseOrder.map((id) => cases.get(id)).filter(Boolean);
const ranCases = caseList.filter((c) => !ONLY.length || ONLY.includes(c.id));
const passedCases = ranCases.filter((c) => c.passed);
const failedCases = ranCases.filter((c) => !c.passed);

// 期望判定：buggy = A/B/C/D/F 应 FAIL 且 E PASS；fixed = 全 PASS
let verdict = 'UNKNOWN';
if (EXPECT === 'buggy') {
  const fmCases = ranCases.filter((c) => c.id !== 'E');
  const fmAllFailed = fmCases.length > 0 && fmCases.every((c) => !c.passed);
  const ePassed = !cases.get('E') || cases.get('E').passed;
  verdict = fmAllFailed && ePassed ? 'BUG_REPRODUCED（管理台弹窗全部点不动 + 对照组正常）' : 'UNEXPECTED（修复前基线不符合预期）';
} else if (EXPECT === 'fixed') {
  verdict = failedCases.length === 0 ? 'FIXED_CONFIRMED（全部用例通过）' : 'STILL_BROKEN（修复后仍有用例失败）';
}

let exeInfo = { path: APP_EXE, exists: existsSync(APP_EXE) };
try {
  if (exeInfo.exists) {
    const buf = readFileSync(APP_EXE);
    exeInfo = {
      path: APP_EXE,
      exists: true,
      size: statSync(APP_EXE).size,
      mtime: statSync(APP_EXE).mtime.toISOString(),
      sha256: createHash('sha256').update(buf).digest('hex').toUpperCase(),
    };
  }
} catch {
  /* ignore */
}

const report = {
  script: 'scripts/ui-dialog-cancel-smoke.mjs',
  title: '文件管理台命名弹窗「取消/确定」按钮真实鼠标回归',
  startedAt,
  finishedAt,
  expect: EXPECT,
  verdict,
  cdpPort: PORT,
  targetId: target.id,
  pageUrl: viewport && viewport.href,
  viewport,
  testedExe: exeInfo,
  dataDir: DATA_DIR,
  evidenceDir: EVIDENCE_DIR,
  notesOnDiskAtStart: dataNotesStart,
  storageRestored,
  preflight,
  startup: startup ? startup.state : null,
  screenshots: { startup: startupShot, count: shotCount },
  cases: caseList,
  summary: {
    total: ranCases.length,
    passed: passedCases.length,
    failed: failedCases.length,
    passedCases: passedCases.map((c) => c.id),
    failedCases: failedCases.map((c) => c.id),
    failedChecks: ranCases.flatMap((c) => (c.failedChecks || []).map((n) => `${c.id} · ${n}`)),
  },
};

mkdirSync(EVIDENCE_DIR, { recursive: true });
const reportPath = join(EVIDENCE_DIR, 'report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log('\n==================== 汇总 ====================');
for (const c of ranCases) {
  console.log(`${c.passed ? 'PASS' : 'FAIL'}  ${c.id}  ${c.label}` + (c.error ? '   [' + c.error + ']' : ''));
  for (const f of c.failedChecks || []) console.log(`        ✗ ${f}`);
}
console.log(`\n用例通过：${passedCases.length}/${ranCases.length}；截图 ${shotCount} 张`);
console.log(`期望模式：${EXPECT}；判定：${verdict}`);
console.log(`报告：${reportPath}`);
console.log('==============================================');

ws.close();
process.exit(failedCases.length === 0 ? 0 : 1);
