// 单文件版（index-standalone.html）冒烟验证：在 Node VM 里用 DOM 桩执行 bundle，
// 检查：无启动异常、UI 模块全部初始化、开始游戏流程可以跑通（不依赖真实浏览器）。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index-standalone.html', import.meta.url), 'utf8');
const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!m) {
  console.error('未找到内联脚本');
  process.exit(1);
}
const js = m[1];

// ---- DOM 桩（与 tests/ui-dom.test.mjs 同思路的简化版）----
const ids = {};
function mkEl(tag = 'div') {
  const n = {
    tagName: String(tag).toUpperCase(), id: '', className: '', style: {}, dataset: {}, children: [],
    _html: '', textContent: '', _attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') { this.id = v; ids[v] = this; } },
    getAttribute(k) { return this._attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) ids[c.id] = c; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    remove() {},
    addEventListener() {},
    querySelector() { return mkEl(); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 810 }; },
    get clientWidth() { return 1440; },
    get clientHeight() { return 810; },
    get offsetWidth() { return 1440; },
    get offsetHeight() { return 810; },
    getContext() { return mkCtx(); },
    width: 1440, height: 810,
  };
  return n;
}
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
for (const id of ['app', 'game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp',
  'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count', 'wave-count',
  'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip', 'banner', 'damage-layer',
  'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen', 'loading', 'btn-start']) {
  ids[id] = mkEl(id === 'game' ? 'canvas' : 'div');
  ids[id].id = id;
}

const errors = [];
const sandbox = {
  console: { log: (...a) => console.log('[page]', ...a), warn: () => {}, error: (...a) => { errors.push(a.map(String).join(' ')); console.log('[page:error]', ...a); } },
  setTimeout, clearTimeout, setInterval, clearInterval, performance, URLSearchParams, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Map, Set, Promise, Symbol, Reflect, Proxy, Int8Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int16Array, Int32Array, Float32Array, Float64Array,
  document: {
    getElementById: (id) => ids[id] || null,
    querySelector: (s) => (s.startsWith('#') ? ids[s.slice(1)] || null : mkEl()),
    querySelectorAll: () => [],
    createElement: (t) => mkEl(t),
    createElementNS: (ns, t) => mkEl(t),
    body: mkEl('body'),
    documentElement: mkEl('html'),
    addEventListener() {},
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { search: '?autostart=1&debugBundle=1' },
  navigator: { userAgent: 'node' },
  requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 16),
  cancelAnimationFrame: () => {},
  devicePixelRatio: 1,
  innerWidth: 1440,
  innerHeight: 810,
  addEventListener() {},
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

// 等待若干帧（autostart=1 会自动开始游戏）
await new Promise((r) => setTimeout(r, 1200));
console.log('页面错误数：', errors.length);
if (errors.slice(0, 3).length) console.log(errors.slice(0, 3).join('\n---\n'));
const ok = errors.length === 0;
console.log(ok ? '✅ 单文件版冒烟通过' : '❌ 单文件版存在运行时错误');
process.exit(ok ? 0 : 1);