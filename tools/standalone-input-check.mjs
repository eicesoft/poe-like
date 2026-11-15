// 单文件版「真按键盘/真点按钮」验收：DOM 桩会记录监听器并真的派发事件。
// 与 check-standalone.mjs 的区别：那个只验证"能启动不报错"，这里验证"操作有没有效果"。
// 用法：node tools/standalone-input-check.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index-standalone.html', import.meta.url), 'utf8');
const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!m) { console.error('未找到内联脚本'); process.exit(1); }
const js = m[1];

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${msg}${extra ? '\n    ' + extra : ''}\x1b[0m`); }
};

// ---------------------------------------------------------------------------
// 会派发事件的 DOM 桩
// ---------------------------------------------------------------------------
const ids = {};
let allById = new Map();
function classListOf(n) {
  // 【必须与 className 双向同步】真实浏览器里 el.className='slot' 之后再
  // classList.toggle('ready')，className 会变成 'slot ready'（反之亦然）。
  // 桩如果各存一份，ui.update() 里的 classList.toggle 就会把 'slot' 冲掉，
  // 后续 querySelectorAll('#skillbar .slot') 直接查不到 —— 这是桩的 bug，不是产品的。
  const parse = () => new Set(String(n._className || '').split(/\s+/).filter(Boolean));
  const write = (set) => { n._className = [...set].join(' '); };
  return {
    add: (...c) => { const s = parse(); c.forEach((x) => s.add(x)); write(s); },
    remove: (...c) => { const s = parse(); c.forEach((x) => s.delete(x)); write(s); },
    toggle: (c, on) => {
      const s = parse();
      const want = on === undefined ? !s.has(c) : !!on;
      if (want) s.add(c); else s.delete(c);
      write(s);
      return want;
    },
    contains: (c) => parse().has(c),
  };
}
function mkEl(tag = 'div') {
  const n = {
    tagName: String(tag).toUpperCase(), id: '', _className: '', style: {}, dataset: {}, children: [],
    _html: '', textContent: '', _attrs: {}, _listeners: {}, parentNode: null,
    set className(v) { this._className = String(v); },
    get className() { return this._className; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') { this.id = v; ids[v] = this; } },
    getAttribute(k) { return this._attrs[k]; },
    removeAttribute(k) { delete this._attrs[k]; },
    hasAttribute(k) { return k in this._attrs; },
    appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) ids[c.id] = c; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = this._listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    dispatch(t, ev = {}) {
      const e = { type: t, target: this, defaultPrevented: false, repeat: false, button: 0, clientX: 0, clientY: 0,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev };
      for (const fn of (this._listeners[t] || []).slice()) fn(e);
      return e;
    },
    querySelector(sel) { return findOne(this, sel); },
    querySelectorAll(sel) { return findAll(this, sel); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 810, right: 1440, bottom: 810 }; },
    get clientWidth() { return 1440; },
    get clientHeight() { return 810; },
    get offsetWidth() { return 1440; },
    get offsetHeight() { return 810; },
    getContext() { return mkCtx(); },
    focus() {}, blur() {},
    width: 1440, height: 810,
  };
  n.classList = classListOf(n);
  return n;
}
function matches(el, sel) {
  for (const part of String(sel).split(',')) {
    const s = part.trim();
    if (!s) continue;
    if (s.startsWith('#')) { if (el.id === s.slice(1)) return true; continue; }
    if (s.startsWith('.')) { if (String(el._className).split(/\s+/).includes(s.slice(1))) return true; continue; }
    if (/^[a-zA-Z]+$/.test(s) && el.tagName === s.toUpperCase()) return true;
  }
  return false;
}
function findAll(root, sel) {
  // 支持逗号分隔 + 后代选择器（如 '#skillbar .slot'）：ui.js 的 $ALL('#skillbar .slot') 依赖它
  const parts = String(sel).trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const ancestors = parts.slice(0, -1);
  const out = [];
  const walk = (n, chain) => {
    for (const c of n.children) {
      const nextChain = chain.concat([c]);
      if (matches(c, last) && ancestors.every((a, idx) => {
        // 祖先链里必须存在匹配 a 的节点，且顺序正确
        const from = chain.length - 1;
        for (let i = from; i >= 0; i--) if (matches(chain[i], a)) return true;
        return false;
      })) out.push(c);
      walk(c, nextChain);
    }
  };
  walk(root, [root]);
  if (process.env.DBG_SEL && sel.includes('slot')) { const app=root.children[0]; const sb=app && app.children.find(c=>c.id==='skillbar'); console.log('[findAll]', sel, '=> ', out.length, '| kids cls=', sb?sb.children.map(c=>JSON.stringify(c._className)).join(' ; '):'-'); }
  return out;
}
function findOne(root, sel) { return findAll(root, sel)[0] || null; }
function mkCtx() {
  const noop = () => {};
  const ctx = {
    canvas: { width: 1440, height: 810 },
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop,
    setTransform: noop, resetTransform: noop, save: noop, restore: noop,
  };
  return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}

const body = mkEl('body');
const app = mkEl('div'); app.id = 'app'; body.appendChild(app);
const startIds = ['app', 'game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp',
  'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count', 'wave-count',
  'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip', 'banner', 'damage-layer',
  'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen', 'loading', 'btn-start'];
for (const id of startIds) { const n = mkEl(id === 'game' ? 'canvas' : 'div'); n.id = id; ids[id] = n; app.appendChild(n); }
ids.modal.className = 'hidden';
ids.hud.className = 'hidden';
ids.loading.className = 'hidden';
// banner 子节点
const bt = mkEl('div'); bt.className = 'banner-text'; ids.banner.appendChild(bt);
// 技能栏 7 个格子
const skillbar = ids.skillbar;
for (let i = 0; i < 7; i++) {
  const slot = mkEl('div'); slot.className = 'slot'; slot.dataset.idx = String(i);
  for (const cls of ['key', 'glyph', 'cd', 'cdtxt']) { const c = mkEl('div'); c.className = cls; slot.appendChild(c); }
  skillbar.appendChild(slot);
}

const winListeners = {};
const errors = [];
const sandbox = {
  console: { log: () => {}, warn: (...a) => { /* console.log('[warn]', ...a); */ }, error: (...a) => { errors.push(a.map(String).join(' ')); } },
  setTimeout, clearTimeout, setInterval, clearInterval, performance, URLSearchParams,
  Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Map, Set, Promise, Symbol, Reflect, Proxy,
  Int8Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int16Array, Int32Array, Float32Array, Float64Array,
  document: {
    getElementById: (id) => ids[id] || null,
    querySelector: (s) => (s.startsWith('#') && !s.includes(' ') ? ids[s.slice(1)] || null : findOne(body, s)),
    querySelectorAll: (s) => findAll(body, s),
    createElement: (t) => mkEl(t),
    createElementNS: (ns, t) => mkEl(t),
    body, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, activeElement: null,
  },
  localStorage: (() => { const mp = new Map(); return { getItem: (k) => (mp.has(k) ? mp.get(k) : null), setItem: (k, v) => mp.set(k, String(v)), removeItem: (k) => mp.delete(k) }; })(),
  location: { search: '' },
  navigator: { userAgent: 'node' },
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
  cancelAnimationFrame: (h) => clearTimeout(h),
  devicePixelRatio: 1,
  innerWidth: 1440,
  innerHeight: 810,
  addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
  removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(js, sandbox, { filename: 'index-standalone.html' });
} catch (e) {
  console.log('执行异常：', e.message);
  process.exit(1);
}

const fire = (type, props = {}) => {
  const e = { type, target: body, defaultPrevented: false, repeat: false, button: 0, clientX: 0, clientY: 0,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...props };
  for (const fn of (winListeners[type] || []).slice()) fn(e);
  return e;
};
const KEY = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', Digit1: '1', Digit2: '2', Space: ' ', Escape: 'Escape' };
const keyDown = (code) => fire('keydown', { code, key: KEY[code] ?? code });
const keyUp = (code) => fire('keyup', { code, key: KEY[code] ?? code });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n\x1b[1m单文件版：真键盘 / 真点击验收\x1b[0m');

// ---- 启动 ----
ids['btn-start'].dispatch('click', {});
await wait(300);
const runtime = sandbox.__poeMain;
ok(!!(runtime && runtime.game), '点「进入神庙」后游戏启动');

const game = runtime && runtime.game;
const input = runtime && runtime.input;
const ui = runtime && runtime.ui;
if (!game || !input) {
  console.log('  启动失败，后续跳过。错误：', errors.slice(0, 3));
  process.exit(1);
}
const p = game.world.player;
console.log(`  角色 (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) · 技能栏 ${p.skillBar.filter(Boolean).map((s) => s.id).join('/')}`);

// ---- 键盘移动 ----
console.log('\n▸ 键盘移动');
{
  const x0 = p.x, z0 = p.z;
  ok(input.gameKeysEnabled === true, '键盘输入未被误停用（gameKeysEnabled=true）');
  keyDown('KeyD');
  ok(input.moveDir().x === 1, '按 D → moveDir 返回 (1,0)，实际 ' + JSON.stringify(input.moveDir()));
  await wait(400);
  const moved = Math.hypot(p.x - x0, p.z - z0);
  ok(moved > 0.5, `按住 D 0.4s → 位移 ${moved.toFixed(2)}`);
  keyUp('KeyD');
  await wait(200);
  const x1 = p.x, z1 = p.z;
  await wait(200);
  ok(Math.hypot(p.x - x1, p.z - z1) < 0.5, '松开 D → 停下');
}

// ---- 键盘技能 ----
console.log('\n▸ 键盘技能');
{
  const id = p.skillBar[0].id;
  p.cooldowns[id] = 0;
  keyDown('Digit1');
  await wait(200);
  keyUp('Digit1');
  ok((p.cooldowns[id] || 0) > 0, `按 1 → ${id} 进入冷却 ${(p.cooldowns[id] || 0).toFixed(2)}s`);
}

// ---- 点击技能栏格子（真实 click 事件）----
console.log('\n▸ 点击技能栏按钮');
{
  // 用真实的 DOM 查询拿格子（与 ui.js 的 $ALL('#skillbar .slot') 同一条路径）
  const slots = Array.from(sandbox.document.querySelectorAll('#skillbar .slot'));
  ok(slots.length === 7, `技能栏 7 格（实际 ${slots.length}）`);
  const listenersOf = (n) => n._listeners || n._L || {};
  const clickCount = slots.map((s) => (listenersOf(s).click ? listenersOf(s).click.length : 0));
  ok(clickCount.every((n) => n > 0), '每格都绑定了 click（实际：' + clickCount.join(',') + '）');

  // 等前摇结束
  for (let i = 0; i < 30 && (p.castLock || 0) > 0; i++) await wait(16);
  const id = p.skillBar[2].id;
  p.cooldowns[id] = 0;
  slots[2].dispatch('click', {});
  ok(input._queuedSkills.length > 0 || (p.cooldowns[id] || 0) > 0, `点第 3 格 → 进入输入队列（${id}）`);
  await wait(250);
  ok((p.cooldowns[id] || 0) > 0, `点第 3 格后 ${id} 冷却 ${(p.cooldowns[id] || 0).toFixed(2)}s`);

  // 翻滚格
  for (let i = 0; i < 30 && (p.castLock || 0) > 0; i++) await wait(16);
  p.cooldowns.dash = 0;
  slots[5].dispatch('click', {});
  await wait(250);
  ok((p.cooldowns.dash || 0) > 0, `点「空格」格 → 翻滚冷却 ${(p.cooldowns.dash || 0).toFixed(2)}s`);
}

// ---- 鼠标瞄准 ----
console.log('\n▸ 鼠标');
{
  const canvas = ids.game;
  canvas.dispatch('mousemove', { clientX: 720, clientY: 200 });
  ok(input.mouse.x === 720 && input.mouse.y === 200, `mousemove → (${input.mouse.x}, ${input.mouse.y})`);
  canvas.dispatch('mousedown', { button: 0 });
  ok(input.mouse.down === true, '左键按下被记录');
  fire('mouseup', { button: 0 });
  ok(input.mouse.down === false, '左键松开被记录');
}

// ---- 面板开关后仍可操作 ----
console.log('\n▸ 开面板 / 关面板');
{
  keyDown('KeyI'); keyUp('KeyI'); // 背包
  await wait(300);
  ok(ui.modalOpen === 'inventory', `按 I 打开背包（modalOpen=${ui.modalOpen}）`);
  keyDown('Escape'); keyUp('Escape');
  await wait(300);
  ok(ui.modalOpen === null, `ESC 关闭背包（modalOpen=${ui.modalOpen}）`);
  ok(input.gameKeysEnabled === true, '关面板后键盘恢复（gameKeysEnabled=true）');
  const x0 = p.x, z0 = p.z;
  keyDown('KeyA');
  await wait(350);
  keyUp('KeyA');
  ok(Math.hypot(p.x - x0, p.z - z0) > 0.3, `关面板后仍可移动（位移 ${Math.hypot(p.x - x0, p.z - z0).toFixed(2)}）`);
}

console.log('\n页面错误数：', errors.length);
if (errors.length) console.log(errors.slice(0, 5).join('\n---\n'));
console.log(`\n\x1b[1m${fail === 0 ? '\x1b[32m' : '\x1b[31m'}通过 ${pass}，失败 ${fail}\x1b[0m\n`);
process.exit(fail || errors.length ? 1 : 0);