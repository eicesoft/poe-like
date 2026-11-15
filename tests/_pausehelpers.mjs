// @file tests/_pausehelpers.mjs
// 暂停系统测试的公共脚手架：迷你 DOM 桩（真实父节点链 + 可派发事件 + innerHTML 按钮解析）
// + 真实 createGame() + GameUI 加载器。被 tests/pause.test.mjs 与 tests/pause-ui.test.mjs 共用；
// 文件名不含 .test.mjs，所以 run-all.mjs 不会把它当测试文件加载。
import { createGame } from '../src/game/app.js';
import * as appMod from '../src/game/app.js';
// ═══════════════════════════════════════════════════════════════════════════
// 迷你 DOM（比 ui-dom.test.mjs 的桩多两样东西：真实父节点链 + 可派发的事件）
// ═══════════════════════════════════════════════════════════════════════════
function makeClassList(owner) {
  const read = () => new Set(String(owner.className || '').split(/\s+/).filter(Boolean));
  return {
    add: (...c) => { const s = read(); c.forEach((x) => s.add(x)); owner.className = [...s].join(' '); },
    remove: (...c) => { const s = read(); c.forEach((x) => s.delete(x)); owner.className = [...s].join(' '); },
    toggle: (c, on) => {
      const s = read();
      const want = on === undefined ? !s.has(c) : !!on;
      if (want) s.add(c); else s.delete(c);
      owner.className = [...s].join(' ');
      return want;
    },
    contains: (c) => read().has(c),
  };
}

let _uid = 0;

export function makeElement(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    _attrs: {},
    _listeners: {},
    _html: '',
    _text: '',
    _uid: ++_uid,
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this.children = [];
      parseButtons(this, this._html);
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); },
    setAttribute(k, v) {
      this._attrs[k] = v;
      if (k === 'id') this.id = v;
      if (k === 'class') this.className = v;
      if (k === 'title') this.title = v;
    },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; if (k === 'disabled') this.disabled = false; },
    hasAttribute(k) { return k in this._attrs; },
    appendChild(c) {
      if (!c) return c;
      c.parentNode = node;
      node.children.push(c);
      if (c.id === 'pause-menu') pauseRootRef = c; // 浏览器里 appendChild 之后 getElementById 立刻可查
      return c;
    },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    addEventListener(t, fn) { (node._listeners[t] = node._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const l = node._listeners[t] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(t, ev = {}) {
      let target = ev.target || node;
      for (const fn of node._listeners[t] || []) {
        fn({ target, preventDefault() {}, stopPropagation() {}, ...ev, target });
      }
    },
    click() { node.dispatch('click', { target: node }); },
    contains(n) { let c = n; while (c) { if (c === node) return true; c = c.parentNode; } return false; },
    querySelector: (sel) => findOne(node, sel),
    querySelectorAll: (sel) => findAll(node, sel),
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 810 }; },
    getContext() { return makeCanvasCtx(); },
    focus() { if (docRef) docRef.activeElement = node; },
    blur() { if (docRef && docRef.activeElement === node) docRef.activeElement = null; },
    get offsetWidth() { return 560; },
    get offsetHeight() { return 480; },
    get clientWidth() { return 1440; },
    get clientHeight() { return 810; },
    disabled: false,
  };
  node.classList = makeClassList(node);
  return node;
}

function tagMatches(el, sel) {
  for (const part of String(sel).split(',')) {
    const s = part.trim();
    if (!s) continue;
    if (s.startsWith('#')) { if (el.id === s.slice(1)) return true; continue; }
    if (s.startsWith('.')) { if (String(el.className || '').split(/\s+/).includes(s.slice(1))) return true; continue; }
    // 形如 .pause-btn[data-act="save"] 的复合选择器：拆成「类 + 属性」
    const m = s.match(/^([a-zA-Z]*)(#[-\w]+)?((?:\.[-\w]+)*)((?:\[[^\]]+\])*)$/);
    if (m) {
      if (m[1] && el.tagName !== m[1].toUpperCase()) continue;
      if (m[2] && el.id !== m[2].slice(1)) continue;
      const classes = m[3] ? m[3].slice(1).split('.').filter(Boolean) : [];
      if (classes.length && !classes.every((c) => String(el.className || '').split(/\s+/).includes(c))) continue;
      const attrMatches = (m[4].match(/\[([-\w]+)(?:="([^"]*)")?\]/g) || []).every((a) => {
        const am = a.match(/\[([-\w]+)(?:="([^"]*)")?\]/);
        const v = el.getAttribute ? el.getAttribute(am[1]) : undefined;
        if (v == null) return false;
        return am[2] === undefined ? true : String(v) === am[2];
      });
      if (attrMatches) return true;
    }
  }
  return false;
}

function findAll(root, sel) {
  const out = [];
  const last = String(sel).trim().split(/\s+/).pop();
  const walk = (n) => {
    for (const c of n.children) {
      if (tagMatches(c, last)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function findOne(root, sel) {
  const all = findAll(root, sel);
  return all.length ? all[0] : null;
}

let docRef = null;
/** 当前页面上的暂停菜单根节点（模拟浏览器：appendChild 之后 getElementById 就能查到） */
let pauseRootRef = null;

const STUB_IDS = ['app', 'game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp',
  'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count',
  'wave-count', 'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip',
  'banner', 'damage-layer', 'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen',
  'loading', 'btn-start', 'profile-info'];

/**
 * 把 <button …> 字符串解析成真的按钮节点（挂到 parent 的 children 上）。
 * 为什么必须这么干：暂停菜单的按钮全部来自 innerHTML 模板。如果桩不解析，
 * querySelectorAll('.pause-btn') 永远是空 → 焦点/二次确认/disabled 这些动态行为完全测不到。
 * 也顺带模拟了「.pb-text / .pb-kbd 子节点」——菜单靠它们改文案。
 */
function parseButtons(parent, html) {
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  const attr = (s, k) => {
    const mm = s.match(new RegExp(k + '=["]([^"]*)["]'));
    return mm ? mm[1] : null;
  };
  while ((m = re.exec(String(html)))) {
    const attrs = m[1];
    const inner = m[2];
    const btn = makeElement('button');
    btn.className = attr(attrs, 'class') || '';
    btn.type = attr(attrs, 'type') || 'button';
    btn.setAttribute('data-act', attr(attrs, 'data-act') || '');
    if (attr(attrs, 'title')) btn.setAttribute('title', attr(attrs, 'title'));
    if (attr(attrs, 'aria-label')) btn.setAttribute('aria-label', attr(attrs, 'aria-label'));
    if (/\sdisabled(\s|$)/.test(attrs) || attr(attrs, 'disabled') !== null) btn.setAttribute('disabled', '');
    // 子节点：<span class="pb-ico">▶</span><span class="pb-text">继续游戏</span><kbd class="pb-kbd">ESC</kbd>
    const childRe = /<(span|kbd)\b([^>]*)>([^]*?)<\/\1>/g;
    let cm;
    while ((cm = childRe.exec(inner))) {
      const childCls = attr(cm[2], 'class') || '';
      const child = makeElement(cm[1]);
      child.className = childCls;
      child.textContent = cm[3];
      btn.appendChild(child);
    }
    parent.appendChild(btn);
  }
  return parent;
}

/**
 * 安装迷你 DOM。
 * 关键点：Node 里 `document` 是自由变量（会走 globalThis），但 `requestAnimationFrame` 等
 * 是以裸标识符被调用的 —— 只挂在 window 上不够，必须同时挂到 globalThis，
 * 否则 UI 模块里 setTimeout/rAF 驱动的代码会 ReferenceError。
 */
export function installStubDOM() {
  const prev = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  pauseRootRef = null;
  const byId = {};
  const body = makeElement('body');
  const app = makeElement('div');
  app.id = 'app';
  byId.app = app;
  body.appendChild(app);
  for (const id of STUB_IDS) {
    if (byId[id]) continue;
    const n = makeElement(id === 'game' ? 'canvas' : 'div');
    n.id = id;
    byId[id] = n;
    app.appendChild(n);
  }
  // banner 子节点（banner() 里写 .banner-text）
  const bt = makeElement('div');
  bt.className = 'banner-text';
  byId.banner.appendChild(bt);
  // 技能栏 7 格 + 子元素（HUD update 要读写 .cd/.cdtxt）
  for (let i = 0; i < 7; i++) {
    const slot = makeElement('div');
    slot.className = 'slot';
    slot.dataset.idx = String(i);
    for (const cls of ['key', 'glyph', 'cd', 'cdtxt']) {
      const c = makeElement('div');
      c.className = cls;
      slot.appendChild(c);
    }
    byId.skillbar.appendChild(slot);
  }
  const document = {
    body,
    documentElement: makeElement('html'),
    createElement: (t) => makeElement(t),
    createElementNS: (ns, t) => makeElement(t),
    getElementById: (id) => (id === 'pause-menu' && pauseRootRef ? pauseRootRef : null) || byId[id] || null,
    querySelector: (sel) => (sel.startsWith('#') && !sel.includes(' ') ? byId[sel.slice(1)] || null : findOne(body, sel)),
    querySelectorAll: (sel) => findAll(body, sel),
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
  docRef = document;
  // 【兜底】别的套件可能先在 globalThis.window 上留了一个极简桩（只有 addEventListener）。
  // talent-ui 的清理定时器会调用 window.removeEventListener，缺了它会抛异常并打崩整个测试进程；
  // 这里在覆盖前先把它补齐（只补缺失方法，不替换对象语义）。
  try {
    const prior = globalThis.window;
    if (prior && typeof prior === 'object' && typeof prior.removeEventListener !== 'function') {
      prior.removeEventListener = () => {};
    }
  } catch { /* ignore */ }
  const listeners = {};
  const window = {
    document,
    devicePixelRatio: 1,
    innerWidth: 1440,
    innerHeight: 810,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
    performance,
    location: { search: '' },
  };
  globalThis.document = document;
  globalThis.window = window;
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = window.requestAnimationFrame;
  if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = () => {};
  const dispatchWindow = (t, ev) => { for (const fn of listeners[t] || []) fn(ev); };
  /**
   * 还原全局（便于其它套件重新安装自己的桩）。
   * 注意本套件默认**不还原**：run-all 里后面的套件（stats-ui 等）依赖全局仍有一份 DOM，
   * 中途把 document/window 换掉会让它们读到 undefined。
   */
  const restore = () => {
    globalThis.document = prev.document;
    globalThis.window = prev.window;
    globalThis.requestAnimationFrame = prev.raf;
    globalThis.cancelAnimationFrame = prev.caf;
    docRef = null;
    pauseRootRef = null;
  };
  return { byId, body, app, document, window, listeners, dispatchWindow, restore };
}

/** 真实游戏（headless）：UI 只需要 world/inv/actions，其余字段给全更真实 */
export function makeGame() {
  const game = createGame({});
  game.stats = game.stats || {};
  // 【必须提供 save】：暂停菜单按「有没有 game.actions.save」决定存档按钮是否 disabled。
  // 真实 main.js 的 startGame 一定会挂上 save（任务 4 的存档接线），所以默认给一个可用的桩，
  // 测「存档不可用」的用例自己 delete 掉即可。
  let saveCalls = 0;
  game.saveCalls = () => saveCalls;
  game.actions = {
    revive: () => {}, newMap: () => {}, pickup: () => {},
    save: () => { saveCalls++; return true; },
    ...(typeof appMod.doTakeTalent === 'function' ? { takeTalent: (id) => appMod.doTakeTalent(game, id) } : {}),
    ...(typeof appMod.doSkillRankUp === 'function' ? { skillRankUp: (sid, nid) => appMod.doSkillRankUp(game, sid, nid) } : {}),
    skillPointsTotal: () => 3,
  };
  return game;
}

/** 记录 game.actions.save 的调用 */
export function withSaveSpy(game, result = true) {
  let calls = 0;
  game.actions.save = () => { calls++; return result; };
  return () => calls;
}

export let GameUI = null;
let _uiLoading = null;
export async function loadUI() {
  if (GameUI) return GameUI;
  if (!_uiLoading) {
    _uiLoading = import('../src/ui/ui.js').then((m) => { GameUI = m.GameUI; return GameUI; });
  }
  return _uiLoading;
}


/** Canvas2D 桩：任何属性调用都当 no-op（天赋面板的 rAF 回调会真的画两笔） */
function makeCanvasCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({
    canvas: { width: 1440, height: 810 },
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {},
  }, {
    get(t, k) { return k in t ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; },
  });
}
