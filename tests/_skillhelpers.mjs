// @file tests/_skillhelpers.mjs
// 技能升级 / 分叉天赋 / 战争践踏 / 眩晕 测试的公共脚手架。
//
// 另外，加载本文件时会顺手修掉测试套件结尾的已知崩溃：
//   旧 DOM 桩里 requestAnimationFrame = setTimeout(...)，测试进程结束后定时器才触发
//   document.body.classList.remove(...) → 此时 globalThis.document 已被卸载 → TypeError。
//   这里换成「受控帧队列」+「带命名空间的定时器」，run-all.mjs 会在所有测试跑完后取消它们。
import { RNG } from '../src/engine/rng.js';

// ---------------------------------------------------------------------------
// 0. 定时器隔离（必须在任何 UI 模块被 import 之前安装）
// ---------------------------------------------------------------------------
const origSetTimeout = globalThis.setTimeout;
const origClearTimeout = globalThis.clearTimeout;
/** @type {Set<any>} */
const trackedTimers = new Set();
const NS = '__poelikeTestTimer';
let patched = false;

function installTimerCapture() {
  if (patched) return;
  patched = true;
  globalThis.setTimeout = function patchedSetTimeout(fn, delay, ...args) {
    let id;
    const wrapped = (...a) => {
      trackedTimers.delete(id);
      try {
        return typeof fn === 'function' ? fn(...a) : undefined;
      } catch {
        // 测试进程结束后回调触发的异常一律吞掉（不污染测试结果）
        return undefined;
      }
    };
    id = origSetTimeout(wrapped, delay, ...args);
    if (id && typeof id === 'object' && 'ref' in id) id[NS] = true;
    trackedTimers.add(id);
    return id;
  };
  globalThis.clearTimeout = function patchedClearTimeout(id) {
    trackedTimers.delete(id);
    return origClearTimeout(id);
  };
}
installTimerCapture();

/** 取消所有测试期间创建、且还没触发的定时器（run-all.mjs 在末尾调用）。 */
export function clearTrackedTimers() {
  for (const id of trackedTimers) {
    try { origClearTimeout(id); } catch { /* ignore */ }
  }
  trackedTimers.clear();
}

export function trackedTimerCount() {
  return trackedTimers.size;
}

// ---------------------------------------------------------------------------
// 1. 测试用的真实 world（用 src/game/world.js 的 createWorld，保证字段齐全）
// ---------------------------------------------------------------------------
/**
 * 创建一个"和平"的 world：不自动刷怪、地图无限可走、RNG 固定。
 * @param {{seed?:number, tier?:number}} [opts]
 */
export async function makeWorld(opts = {}) {
  const { createWorld } = await import('../src/game/world.js');
  const { createPlayer } = await import('../src/core/index.js');
  const world = createWorld({ seed: opts.seed ?? 20260101, tier: opts.tier ?? 1 });
  // createWorld 不建玩家（createPlayer 由 app 负责）；测试床自己补一个，保证 world.player 永远存在
  if (!world.player) {
    world.player = createPlayer(world, { x: 0, z: 0 });
    if (!world.all.includes(world.player)) world.all.unshift(world.player);
  }
  world.isWalkable = () => true;
  world.randomSpawnPoint = (minD = 9, maxD = 16) => {
    const p = world.player || { x: 0, z: 0 };
    const a = world.rng.range(0, Math.PI * 2);
    const d = world.rng.range(minD, maxD);
    return { x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d };
  };
  return world;
}

/**
 * 把一个 world 变成"纯木桩"测试床：玩家固定在原点，清空所有集合。
 * @param {Object} world
 */
export function resetArena(world) {
  world.monsters.length = 0;
  world.all.length = 0;
  world.projectiles.length = 0;
  world.groundEffects.length = 0;
  world.summoned.length = 0;
  world.items.length = 0;
  world.lootOrbs.length = 0;
  if (world.hash && typeof world.hash.rebuild === 'function') world.hash.rebuild(world.all);
  world.events.length = 0;
  const p = world.player;
  if (p) {
    p.x = 0; p.z = 0; p.vx = 0; p.vz = 0; p.moveX = 0; p.moveZ = 0;
    p.buffs.length = 0;
    p.cooldowns = {};
    p.castLock = 0;
    p.dead = false;
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    p.flash = 0;
    p.hitFlash = 0;
    p.invuln = 0;
    if (typeof world.__recalc === 'function') world.__recalc(world, p, { keepRatio: false });
  }
  return world;
}

/** 事件过滤 */
export function eventsOf(world, type) {
  return (world.events || []).filter((e) => e && e.type === type);
}

/** 玩家身上某个 id 的 buff */
export function buffOf(entity, id) {
  return (entity.buffs || []).find((b) => b && b.id === id) || null;
}

// ---------------------------------------------------------------------------
// 2. DOM 桩（与 tests/ui-dom.test.mjs 的桩保持同构，但支持事件派发 + 全局只装一次）
// ---------------------------------------------------------------------------
const par = (id) => document.getElementById(id);

function makeClassList(el) {
  return {
    add: (...c) => { const s = new Set(String(el.className || '').split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); el.className = [...s].join(' '); },
    remove: (...c) => { const s = new Set(String(el.className || '').split(/\s+/).filter(Boolean)); c.forEach((x) => s.delete(x)); el.className = [...s].join(' '); },
    contains: (c) => String(el.className || '').split(/\s+/).includes(c),
    toggle: (c, on) => { const has = String(el.className || '').split(/\s+/).includes(c); const want = on === undefined ? !has : !!on; if (want && !has) el.className = (el.className ? el.className + ' ' : '') + c; if (!want && has) el.className = String(el.className).split(/\s+/).filter((x) => x !== c).join(' '); return want; },
  };
}

function makeElement(tag = 'div') {
  /** 自身文本（不含后代）；textContent 读取时会拼上所有后代的 */
  let ownText = '';
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    title: '',
    _attrs: {},
    _listeners: {},
    value: '',
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    // textContent 与真实 DOM 一致：读 = 自身文本 + 所有后代文本；写 = 清空子节点
    get textContent() { return ownText + node.children.map((c) => (c && c.textContent) || '').join(''); },
    set textContent(v) { ownText = v == null ? '' : String(v); node.children = []; },
    setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') this.id = v; if (k === 'class') this.className = v; },
    getAttribute(k) { return this._attrs[k]; },
    removeAttribute(k) { delete this._attrs[k]; },
    appendChild(...cs) {
      for (const c of cs) { if (!c) continue; c.parentNode = node; node.children.push(c); }
      return cs[0];
    },
    append(...cs) { return node.appendChild(...cs); },
    prepend(...cs) { for (const c of cs.slice().reverse()) { if (!c) continue; c.parentNode = node; node.children.unshift(c); } },
    insertBefore(c) { return node.appendChild(c); },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    addEventListener(t, fn) { (node._listeners[t] = node._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const l = node._listeners[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
    dispatch(t, ev = {}) { for (const fn of node._listeners[t] || []) fn({ target: node, preventDefault() {}, stopPropagation() {}, ...ev }); },
    click() { node.dispatch('click'); },
    querySelector(sel) { return findOne(node, sel); },
    querySelectorAll(sel) { return findAll(node, sel); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 810, right: 1440, bottom: 810 }; },
    focus() {},
    clientWidth: 1440,
    clientHeight: 810,
  };
  node.classList = makeClassList(node);
  return node;
}

function matches(el, sel) {
  if (!el) return false;
  for (const raw of String(sel).split(',')) {
    const s = raw.trim();
    if (!s) continue;
    // 支持 "tag.class"、"#id"、".cls"、"[data-x]"、"tag"、
    if (s.startsWith('#')) { if (el.id === s.slice(1)) return true; continue; }
    if (s.startsWith('.')) { if (String(el.className).split(/\s+/).includes(s.slice(1))) return true; continue; }
    if (s.startsWith('[')) {
      const m = s.match(/^\[([\w-]+)(?:([~|^$*]?=)["']?([^"'\]]*)["']?)?\]$/);
      if (m) {
        const key = m[1];
        const op = m[2] || '';
        const want = m[3];
        const val = key.startsWith('data-') ? el.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : el._attrs[key];
        if (op === '' && val !== undefined) return true;
        if (op === '=' && val !== undefined && String(val) === want) return true;
        // [class*="x"] / [class^="x"] / [class$="x"] / [class~="x"] —— 属性选择器要能匹配 class
        if (key === 'class') {
          const cls = String(el.className || '');
          if (op === '*=' && want && cls.includes(want)) return true;
          if (op === '^=' && want && cls.startsWith(want)) return true;
          if (op === '$=' && want && cls.endsWith(want)) return true;
          if (op === '~=' && want && cls.split(/\s+/).includes(want)) return true;
        }
      }
      continue;
    }
    const m = s.match(/^([a-zA-Z][\w-]*)((?:[.#][\w-]+)*)$/);
    if (m) {
      if (el.tagName !== m[1].toUpperCase()) continue;
      let ok = true;
      for (const part of m[2].match(/[.#][\w-]+/g) || []) {
        if (part[0] === '#' && el.id !== part.slice(1)) ok = false;
        if (part[0] === '.' && !String(el.className).split(/\s+/).includes(part.slice(1))) ok = false;
      }
      if (ok) return true;
      continue;
    }
    if (el.tagName === s.toUpperCase()) return true;
  }
  return false;
}

function walkAll(root, out = []) {
  for (const c of root.children || []) { out.push(c); walkAll(c, out); }
  return out;
}

function findAll(root, sel) {
  const parts = String(sel).trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  const out = [];
  for (const el of walkAll(root)) {
    if (!matches(el, last)) continue;
    if (parts.length === 1) { out.push(el); continue; }
    let cur = el.parentNode;
    let idx = parts.length - 2;
    while (cur && idx >= 0) { if (matches(cur, parts[idx])) idx--; cur = cur.parentNode; }
    if (idx < 0) out.push(el);
  }
  return out;
}

function findOne(root, sel) {
  const all = findAll(root, sel);
  return all.length ? all[0] : null;
}

function makeCanvasCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const target = {
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)), width: w, height: h }),
    putImageData: noop,
    canvas: null,
    // 数值校验：渲染层写出 NaN 坐标/尺寸时立刻暴露（否则测试会"静默通过"）
    arc(...a) { num(a); },
    ellipse(...a) { num(a); },
    fillRect(...a) { num(a); },
    strokeRect(...a) { num(a); },
    moveTo(...a) { num(a); },
    lineTo(...a) { num(a); },
    translate(...a) { num(a); },
    scale(...a) { num(a); },
    createRadialGradient(...a) { num(a); return grad; },
    createLinearGradient(...a) { num(a); return grad; },
  };
  const num = (args) => {
    for (const v of args) if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite coord in canvas call');
  };
  return new Proxy(target, {
    get(t, k) { return k in t ? t[k] : noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
}

export const STUB_IDS = [
  'app', 'game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp',
  'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count',
  'wave-count', 'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip',
  'banner', 'damage-layer', 'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen',
  'loading', 'btn-start',
];

/** 幂等：多次调用只装一次（返回同一个 dom 句柄） */
let _dom = null;

export function ensureStubDOM() {
  if (_dom) return _dom;
  const byId = {};
  const body = makeElement('body');
  const app = makeElement('div');
  app.id = 'app';
  body.appendChild(app);
  for (const id of STUB_IDS) {
    const n = makeElement(id.startsWith('bar-') ? 'i' : 'div');
    n.id = id;
    byId[id] = n;
    app.appendChild(n);
  }
  // banner 文本节点
  const bt = makeElement('div');
  bt.className = 'banner-text';
  byId.banner.appendChild(bt);
  // 技能栏 7 格
  for (let i = 0; i < 7; i++) {
    const slot = makeElement('div');
    slot.className = 'slot';
    slot.dataset.idx = String(i);
    for (const cls of ['key', 'glyph', 'cd', 'cdtxt', 'dot']) {
      const c = makeElement('div');
      c.className = cls;
      slot.appendChild(c);
    }
    byId.skillbar.appendChild(slot);
  }
  const document = {
    body,
    documentElement: makeElement('html'),
    head: makeElement('head'),
    createElement: (t) => {
      // 渲染层会在离屏 canvas 上画 bloom/后处理，必须返回能 getContext 的 canvas
      if (t === 'canvas') {
        const c = makeElement('canvas');
        c.getContext = () => makeCanvasCtx();
        c.width = 1;
        c.height = 1;
        return c;
      }
      return makeElement(t);
    },
    createElementNS: (ns, t) => makeElement(t),
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (typeof sel === 'string' && sel.startsWith('#') && !sel.includes(' ') ? byId[sel.slice(1)] || findOne(body, sel) : findOne(body, sel)),
    querySelectorAll: (sel) => findAll(body, sel),
    addEventListener() {},
    removeEventListener() {},
  };
  const listeners = {};
  const window = {
    document,
    devicePixelRatio: 1,
    innerWidth: 1440,
    innerHeight: 810,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    // 受控帧队列：不排真定时器，由 rafQueue.flush() 手动推进
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame(id) { rafQueue[id - 1] = null; },
    performance: globalThis.performance,
    location: { search: '', href: 'http://localhost/' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  _dom = { document, window, byId, listeners, body, app, rafQueue };
  return _dom;
}

/** rAF 队列（受控；不会在测试进程结束后触发） */
export const rafQueue = {
  items: [],
  push(fn) { this.items.push(fn); return this.items.length; },
  clear() { this.items.length = 0; },
  flush(times = 1, t = 1) {
    for (let i = 0; i < times; i++) {
      const list = this.items.slice();
      this.items.length = 0;
      for (const fn of list) if (typeof fn === 'function') fn(t);
    }
  },
};

/** headless 的 ui 替代品：记录被调用的事件 */
export function makeNullUI() {
  const events = [];
  return {
    events,
    onEvents(list) { for (const e of list || []) events.push(e); },
    toast() {},
    onDeath() {},
    onInventoryChange() {},
    onTalentsChange() {},
    onSkillsChange() {},
    onMapChange() {},
    onRespawn() {},
    banner() {},
    flashSide() {},
    addLog() {},
    update() {},
  };
}

// ---------------------------------------------------------------------------
// 3. 小工具
// ---------------------------------------------------------------------------
/** 近似相等断言辅助 */
export function closeTo(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

/** 固定种子的 RNG（需要自己造随机时用，禁止 Math.random） */
export function seeded(seed = 42) {
  return new RNG(seed);
}

/** 技能树里某个技能的"根"节点（requires 为空的 core 节点） */
export function rootNodeOf(tree) {
  if (!tree || !Array.isArray(tree.nodes)) return null;
  return tree.nodes.find((n) => !n.requires || n.requires.length === 0) || null;
}

/** 技能树里某分支的第一个节点（branch 字段或 key 推断） */
export function nodesByBranch(tree) {
  const out = { core: [], left: [], right: [], leftDeep: [], rightDeep: [], ultimate: [] };
  for (const n of (tree && tree.nodes) || []) {
    const b = n.branch || 'core';
    (out[b] = out[b] || []).push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. 模块加载（懒加载 + 失败给清晰信息；队友并行开发时模块可能还不存在）
// ---------------------------------------------------------------------------
const cache = {};
export async function load(path) {
  if (cache[path]) return cache[path];
  cache[path] = await import(path);
  return cache[path];
}

export async function loadSafe(path) {
  try {
    return { mod: await load(path), err: null };
  } catch (e) {
    return { mod: null, err: e };
  }
}