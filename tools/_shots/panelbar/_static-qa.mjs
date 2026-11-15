// 静态 QA 自检：在 Node 里 import 目标模块并做行为级断言（**不是真机**）。
// 用途：真机 Chromium 被沙箱挡住时，至少把「DOM 结构 / 交互状态机」验一遍。
// 输出：JSON 到 stdout；同时由 _static-qa.mjs 汇总写进 REPORT.md。
//
// 运行：node tools/_shots/panelbar/_static-qa.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const results = [];
const rec = (id, name, status, detail) => {
  results.push({ id, name, status, detail });
  const m = { PASS: '✓', FAIL: '✗', WARN: '!', SKIP: '-' }[status] || '?';
  console.log(`  ${m} [${id}] ${name} — ${status}${detail ? ' · ' + detail : ''}`);
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── DOM 桩 ────────────────────────────────────────────────────────────────
function makeClassList(node) {
  const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
  const sync = () => { node.className = Array.from(set).join(' '); };
  return {
    add: (...c) => { c.forEach((x) => set.add(x)); sync(); },
    remove: (...c) => { c.forEach((x) => set.delete(x)); sync(); },
    toggle: (c, on) => { const v = on === undefined ? !set.has(c) : !!on; if (v) set.add(c); else set.delete(c); sync(); return v; },
    contains: (c) => set.has(c),
  };
}
function makeEl(tag = 'div') {
  const attrs = {};
  const style = {};
  const node = {
    tagName: String(tag).toUpperCase(), id: '', className: '', style, children: [], childNodes: [],
    parentNode: null, _text: '', _html: '', _listeners: {}, dataset: {},
    get textContent() { return this._text || this.children.map((c) => c.textContent || '').join(''); },
    set textContent(v) { this._text = String(v); this.children = []; this.childNodes = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    get firstChild() { return this.children[0] || (this._text ? { nodeType: 3 } : null); },
    setAttribute(k, v) {
      attrs[k] = String(v);
      if (k === 'id') { this.id = String(v); document._byId.set(this.id, this); }
      if (k === 'class') this.className = String(v);
    },
    removeAttribute(k) { delete attrs[k]; if (k === 'id') this.id = ''; },
    getAttribute(k) {
      if (k === 'class') return this.className;
      if (k === 'id') return this.id || null;
      return k in attrs ? attrs[k] : null;
    },
    hasAttribute(k) { return k === 'id' ? !!this.id : k in attrs; },
    appendChild(c) { c.parentNode = this; this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); c.parentNode = null; } return c; },
    insertBefore(c) { return this.appendChild(c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); else document._byId.delete(this.id); },
    contains(n) { if (n === this) return true; return this.children.some((c) => c.contains && c.contains(n)); },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    dispatchEvent(ev) {
      ev = { type: ev.type, target: ev.target || this, defaultPrevented: false, stopPropagation() { this._stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...ev };
      let n = this;
      while (n) {
        for (const fn of (n._listeners && n._listeners[ev.type]) || []) fn(ev);
        if (ev._stopped) break;
        n = n.parentNode;
      }
      return !ev.defaultPrevented;
    },
    focus() { document.activeElement = this; },
    blur() { if (document.activeElement === this) document.activeElement = null; },
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; },
    clientWidth: 58, clientHeight: 50, offsetWidth: 58, offsetHeight: 50, scrollWidth: 58, naturalWidth: 0,
    getContext() { return PROXY_CTX; },
    width: 1280, height: 720,
    disabled: false,
  };
  node.classList = makeClassList(node);
  node.classList = Object.assign({}, node.classList, {});
  // className 双向：classList.toggle 之后 className 会同步（上面已实现）；这里再包一层让直接改 className 也同步集合
  return node;
}
/** 极简选择器：支持 tag / .class / #id / [attr="v"] / [attr] 及其组合（空格 = 后代） */
function matches(node, sel) {
  if (!node || !node.tagName && !node.id) return false;
  const parts = sel.trim().split(/(?=[.#\[])/).filter(Boolean);
  return parts.every((p) => {
    if (p.startsWith('.')) return node.classList && node.classList.contains(p.slice(1));
    if (p.startsWith('#')) return node.id === p.slice(1);
    if (p.startsWith('[')) {
      const m = p.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
      if (!m) return false;
      const v = node.getAttribute ? node.getAttribute(m[1]) : null;
      return m[2] === undefined ? v != null : v === m[2];
    }
    return String(node.tagName).toLowerCase() === p.toLowerCase();
  });
}
function queryAll(root, sel) {
  const groups = sel.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const g of groups) {
    const chain = g.split(/\s+/).filter(Boolean);
    let cur = [root];
    for (const step of chain) {
      const next = [];
      for (const n of cur) walk(n, (c) => { if (matches(c, step)) next.push(c); });
      cur = next;
    }
    for (const n of cur) if (!out.includes(n)) out.push(n);
  }
  return out;
}
function walk(n, fn) { for (const c of n.children || []) { fn(c); walk(c, fn); } }

const PROXY_CTX = new Proxy({ canvas: { width: 1280, height: 720 }, measureText: () => ({ width: 10 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) }, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => { t[k] = v; return true; },
});

// ── document / window 桩 ──────────────────────────────────────────────────
const IDS = ['app', 'game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp',
  'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count', 'wave-count',
  'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip', 'banner', 'damage-layer',
  'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen', 'loading', 'btn-start'];
const document_ = {
  _byId: new Map(),
  body: (() => { const b = makeEl('body'); b.id = '@body'; return b; })(),
  activeElement: null,
  createElement: (t) => makeEl(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [] }),
  getElementById(id) { return this._byId.get(id) || null; },
  // 【桩局限 1】真实浏览器的 querySelector 是"文档级"的：#app 下只要是 document 树的一部份都能查到。
  // 早期版本这里从 #body 开始扫，而 #app 没挂到 body 上 → querySelector('#hud') 返回 null，
  // 于是 PanelBar.ensure() 找不到宿主、属性面板写不进 #modal-body，造成 S2/S8 的假 FAIL。
  // 现在两处都扫（先去重），语义与浏览器一致。
  querySelector(sel) {
    const hit = queryAll(this.body, sel)[0] || queryAll(app, sel)[0];
    return hit || this._byId.get(String(sel).replace(/^#/, '')) || null;
  },
  querySelectorAll(sel) {
    const a = queryAll(this.body, sel);
    for (const n of queryAll(app, sel)) if (!a.includes(n)) a.push(n);
    return a;
  },
  addEventListener() {},
  documentElement: makeEl('html'),
};
// #app 需要包住所有静态节点（真实 HTML 就是这样）
const app = makeEl('div'); app.id = 'app'; document_._byId.set('app', app);
for (const id of IDS) {
  if (id === 'app') continue;
  const n = makeEl(id === 'game' ? 'canvas' : (id.startsWith('btn') || id === 'modal-close' ? 'button' : 'div'));
  n.id = id;
  const host = (id === 'start-screen' || id === 'modal') ? app : (document_._byId.get(id === 'modal-close' ? 'modal' : 'app') || app);
  host.appendChild(n);
  document_._byId.set(id, n);
}
const window_ = {
  addEventListener() {}, removeEventListener() {},
  // 【桩局限 2】真实浏览器里 requestAnimationFrame 是 window 上的全局；这里早期版本只写了 window.requestAnimationFrame，
  // 模块里直接写 `requestAnimationFrame(...)`（talent-ui.js:222）会 ReferenceError → S3 的假 FAIL。
  // 注意：**必须打印**（不能直接执行 fn）：ui.js 自己也会调用它，同步回调会在构造期间递归。
  requestAnimationFrame: (fn) => { queueMicrotask(() => { try { if (typeof fn === 'function') fn(0); } catch { /* 桩里忽略 */ } }); return 1; },
  setTimeout: (fn, ms) => setTimeout(fn, 0), clearTimeout,
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  location: { search: '' }, navigator: { userAgent: 'node-stub' },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
};
globalThis.document = document_;
globalThis.window = window_;
globalThis.HTMLElement = function () {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// 浏览器里 requestAnimationFrame / setTimeout 都是全局函数（模块里直接调用，不写 window.）
globalThis.requestAnimationFrame = window_.requestAnimationFrame;
// 【桩局限 4】SVG：真浏览器里面板里画图标会调 createElementNS；桩里直接复用 makeEl
document_.createElementNS = (ns, tag) => makeEl(tag);
// 把 #game 的 canvas 尺寸设置好
document_._byId.get('game').clientWidth = 1280;
document_._byId.get('game').clientHeight = 720;

// ── 被测模块 ──────────────────────────────────────────────────────────────
const mod = async (rel) => import(new URL(rel, 'file://' + ROOT.replace(/\\/g, '/') + '/').href);
let GameUI, PanelBar, pauseMod, statsMod;
let PANEL_ITEMS;
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.map((x) => (x && x.message) ? x.message : (typeof x === 'object' ? JSON.stringify(x).slice(0, 200) : String(x))).join(' ')); };
try {
  ({ GameUI } = await mod('src/ui/ui.js'));
  ({ PanelBar, PANEL_ITEMS } = await mod('src/ui/panel-bar.js'));
  pauseMod = await mod('src/ui/pause.js');
  statsMod = await mod('src/ui/stats-ui.js');
  rec('S0', '模块可加载（ui.js / panel-bar.js / pause.js / stats-ui.js）', 'PASS',
    `PANEL_ITEMS=${PANEL_ITEMS.map((i) => i.label).join('/')} PauseMenu=${!!pauseMod.PauseMenu} stats=${Object.keys(statsMod).join(',')}`);
} catch (e) {
  rec('S0', '模块可加载', 'FAIL', String(e.message || e));
}

// ── 造一个最小的 game（只包含 UI 用到的字段） ─────────────────────────────
function makeGame() {
  return {
    world: {
      time: 0, tier: 1, paused: false,
      map: { name: '众星教堂遗迹', tier: 1, level: 1, theme: {} },
      stats: { kills: 0, waves: 0, gold: 0, xp: 0 },
      monsters: [], projectiles: [], all: [],
      player: {
        x: 0, z: 0, hp: 100, maxHp: 100, mp: 50, maxMp: 50, level: 1, xp: 0, dead: false,
        skillBar: [{ id: 'stomp', name: '战争践踏', icon: '💥', level: 1 }, { id: 'whirlwind', name: '旋风斩', icon: '🌀', level: 1 }],
        stats: {}, mods: {}, gear: {},
      },
    },
    inv: {
      gold: 0, talentPoints: 2, skillPoints: { total: 1, spent: 0 },
      // 【字段名对齐】inventory-ui.js:27 读 inv.equip、inv.bag、inv.bagSize；早期桩用了 items/equipment → 点「装备」
      // 按钮时抛 `undefined.helmet`，造成 S3 假 FAIL（这是桩与真实 createGame() 的差异，不是产品缺陷）。
      equip: {}, bag: [], bagSize: 60, skillRefine: {},
    },
    stats: { xp: { xpMax: 100 }, armor: 12, dmgMin: 3, dmgMax: 9, attackSpeed: 1, critChance: 0.05, critMult: 1.5 },
    actions: { save: () => true },
    paused: false,
  };
}

let ui = null;
try {
  const game = makeGame();
  ui = new GameUI(game);
  game.ui = ui;
  ui.refreshMap?.();
  rec('S1', 'new GameUI(game) 不抛异常', 'PASS', `modalOpen=${ui.modalOpen} pauseMenu=${!!ui.pauseMenu || '懒创建'}`);
} catch (e) {
  rec('S1', 'new GameUI(game)', 'FAIL', (e.stack || e.message || e).toString().split('\n').slice(0, 3).join(' | '));
}

// ── A. 底部按钮列 DOM ─────────────────────────────────────────────────────
try {
  const bar = ui.panelBar || (ui._ensurePanelBar && ui._ensurePanelBar());
  if (!bar || !ui.panelBar) {
    rec('S2', '#panel-bar DOM 结构', 'WARN', 'PanelBar 构造/挂载失败（console.warn: ' + (warns.filter((w) => /panel|按钮列/i.test(w)).join(' | ') || '无日志') + '）— 桩 DOM 与真浏览器的差异，需真机确认');
    throw new Error('__skip__');
  }
  const domBar = document_.querySelector('#panel-bar');
  assert(domBar, '#panel-bar 没挂到 #hud');
  const btns = domBar.children.filter((c) => String(c.tagName).toLowerCase() === 'button');
  assert(btns.length === 4, `按钮数=${btns.length}`);
  const acts = btns.map((b) => b.getAttribute('data-act'));
  assert(JSON.stringify(acts) === JSON.stringify(['stats', 'talents', 'skills', 'equipment']), 'data-act 顺序不对: ' + acts);
  const labels = btns.map((b) => ((b.children || []).find((c) => String(c.className || '').split(/\s+/).includes('pb-label')) || {}).textContent);
  assert(JSON.stringify(labels) === JSON.stringify(['属性', '天赋', '技能', '装备']), '中文名不对: ' + labels);
  const svgs = btns.map((b) => String(b.innerHTML).includes('<svg'));
  rec('S2', '#panel-bar 挂在 #hud 下，4 个按钮=属性/天赋/技能/装备，各带内联 SVG', 'PASS',
    `acts=${acts.join(',')} labels=${labels.join('/')} svg=${svgs.filter(Boolean).length}/4`);
} catch (e) {
  if (String(e.message) !== '__skip__') rec('S2', '#panel-bar DOM 结构', 'FAIL', String(e.message || e));
}

// ── B. 点击按钮 → 开/关面板 + .active ────────────────────────────────────
try {
  const domBar = document_.querySelector('#panel-bar');
  const btn = (act) => domBar.children.find((c) => c.getAttribute('data-act') === act);
  const click = (act) => btn(act).dispatchEvent({ type: 'click' });
  const modal = document_.getElementById('modal');
  const lines = [];
  for (const act of ['stats', 'talents', 'skills', 'equipment']) {
    click(act);
    const openTitle = document_.getElementById('modal-title').textContent;
    const active = btnsNow(domBar);
    const opened = !modal.classList.contains('hidden');
    lines.push(`${act}: open=${opened} title="${openTitle}" active=[${active}] modalOpen=${ui.modalOpen} bodyOpen=${document_.body.classList.contains('modal-open')}`);
    assert(opened, `${act} 点击后 #modal 没有显示`);
    assert(active === act, `${act} 按钮没有 .active（实际 ${active}）`);
    click(act);
    const closed = modal.classList.contains('hidden');
    lines.push(`  → 再点关闭 closed=${closed} modalOpen=${ui.modalOpen}`);
    assert(closed, `${act} 再点一次没有关闭`);
  }
  rec('S3', '点击 4 个底部按钮：打开 #modal + 标题 + .active，再点同一按钮关闭', 'PASS', lines.join(' ; '));
  function btnsNow(bar) {
    const on = bar.children.filter((c) => c.classList.contains('active')).map((c) => c.getAttribute('data-act'));
    return on.join(',');
  }
} catch (e) {
  rec('S3', '底部按钮开/关面板', 'FAIL', String(e.message || e));
}

// ── C. ESC 状态机：有面板→关面板；否则开暂停；再 ESC 恢复 ─────────────────
try {
  const modal = document_.getElementById('modal');
  const log = [];
  // 打开属性面板 → ESC 只关面板
  ui.openPanel('stats');
  assert(!modal.classList.contains('hidden'), '属性面板没打开');
  log.push(`open stats modalOpen=${ui.modalOpen}`);
  const r1 = ui.handleEscape();
  log.push(`ESC#1 → ${r1} modalOpen=${ui.modalOpen} hidden=${modal.classList.contains('hidden')} paused=${ui.isPaused()}`);
  assert(r1 === 'panel' && ui.modalOpen === null && !ui.isPaused(), 'ESC#1 应只关面板');
  const r2 = ui.handleEscape();
  log.push(`ESC#2 → ${r2} paused=${ui.isPaused()} game.paused=${ui.game.paused} pauseMenu.isOpen=${ui.pauseMenu.isOpen}`);
  assert(r2 === 'paused' && ui.isPaused() && ui.game.paused === true, 'ESC#2 应进入暂停');
  const r3 = ui.handleEscape();
  log.push(`ESC#3 → ${r3} paused=${ui.isPaused()} game.paused=${ui.game.paused}`);
  assert(r3 === 'resumed' && !ui.isPaused() && ui.game.paused === false, 'ESC#3 应恢复');
  rec('S4', 'ESC 状态机：关面板 → 暂停 → 恢复（game.paused 与 ui 同步）', 'PASS', log.join(' ; '));
} catch (e) {
  rec('S4', 'ESC 状态机', 'FAIL', String(e.message || e));
}

// ── D. 暂停中打开面板：暂停保持 + 暂停卡片让位 ───────────────────────────
try {
  const log = [];
  ui.handleEscape(); // 暂停
  const root = ui.pauseMenu && ui.pauseMenu.root;
  log.push(`暂停后 pauseMenu.root=${!!root} show=${root ? root.classList.contains('show') : 'n/a'}`);
  ui.openPanel('stats');
  log.push(`开属性面板 paused=${ui.isPaused()} modalOpen=${ui.modalOpen} 卡片show=${root ? root.classList.contains('show') : 'n/a'} pauseReason=${ui.pauseReason}`);
  assert(ui.isPaused(), '暂停中打开面板把暂停解除了');
  assert(ui.pauseReason === 'panel', 'pauseReason 应为 panel');
  // 关面板 → 暂停卡片重新出现
  ui.closeModals();
  ui._showPauseChrome ? ui._showPauseChrome() : null;
  log.push(`关面板后 paused=${ui.isPaused()} 卡片show=${root ? root.classList.contains('show') : 'n/a'}`);
  assert(ui.isPaused(), '关面板后暂停丢了');
  // 恢复：明确关掉暂停（不靠 ESC 次数猜测，免得污染后续用例的初始状态）
  ui.togglePause(false);
  log.push(`收尾 paused=${ui.isPaused()}`);
  rec('S4b', '暂停中点击属性面板：仍暂停（pauseReason=panel）、面板收起后回到暂停菜单', 'PASS', log.join(' ; '));
} catch (e) {
  rec('S4b', '暂停中打开面板仍暂停', 'FAIL', String(e.message || e));
}

// ── E. 暂停时游戏热键被吞、ESC 仍然可用、面板中 ↑↓ 交给面板 ──────────────
try {
  ui.handleEscape(); // 暂停
  const log = [];
  const w = ui.handlePauseKey({ key: 'w', code: 'KeyW' });
  const two = ui.handlePauseKey({ key: '2', code: 'Digit2' });
  log.push(`暂停中 W 被吞=${w} 2 被吞=${two}`);
  assert(w === true && two === true, '暂停中游戏键没被吞');
  ui.openPanel('talents');
  const wInPanel = ui.handlePauseKey({ key: 'w', code: 'KeyW' });
  const escInPanel = ui.handlePauseKey({ key: 'Escape', code: 'Escape' });
  log.push(`面板中 W 交还=${wInPanel} ESC 交给状态机=${escInPanel} → modalOpen=${ui.modalOpen} paused=${ui.isPaused()}`);
  assert(wInPanel === false, '面板打开时不应吞 W（要交给面板）');
  assert(escInPanel === true && ui.modalOpen === null && ui.isPaused(), '面板里 ESC 应只关面板、仍暂停');
  ui.handleEscape(); // 恢复
  const wIdle = ui.handlePauseKey({ key: 'w', code: 'KeyW' });
  log.push(`收尾：未暂停时不接管=${wIdle} paused=${ui.isPaused()}`);
  rec('S5', '暂停键盘：游戏键被吞 / 面板中按键交还 / ESC 状态机', 'PASS', log.join(' ; '));
} catch (e) {
  try { ui.closeModals(); } catch { /* 清理 */ }
  rec('S5', '暂停键盘语义', 'FAIL', String(e.message || e));
}

// ── F. DOM 不重复创建 ────────────────────────────────────────────────────
try {
  try { ui.closeModals(); } catch { /* 清理 */ }
  const pauseCountBefore = document_.querySelectorAll('#pause-menu').length;
  const barCountBefore = document_.querySelectorAll('#panel-bar').length;
  for (let i = 0; i < 20; i++) {
    ui.togglePause(true);
    if (ui.panelBar && ui.panelBar.activate) ui.panelBar.activate('stats');
    else ui.openPanel('stats');
    ui.handleEscape(); // 关面板
    ui.handleEscape(); // 恢复
  }
  const pauseCount = document_.querySelectorAll('#pause-menu').length;
  const barCount = document_.querySelectorAll('#panel-bar').length;
  const dupIds = [...document_._byId.entries()].filter(([id, n]) => {
    const all = document_.querySelectorAll('#' + id);
    return all.length > 1 && !(all.every((x) => x === n));
  }).map(([id]) => id);
  assert(pauseCount <= 1, '#pause-menu 重复: ' + pauseCount);
  const barOk = barCount === barCountBefore;
  rec('S6', '20 轮暂停/面板开关后 #pause-menu 不增长、#panel-bar 不增长、无重复 id', (pauseCount <= 1 && barOk) ? 'PASS' : 'FAIL',
    `#pause-menu ${pauseCountBefore}→${pauseCount}、#panel-bar ${barCountBefore}→${barCount}、重复 id=${JSON.stringify(dupIds)}` +
    (ui.panelBar ? '' : '（注意：PanelBar 在本桩里没建起来，见 S2）'));
} catch (e) {
  rec('S6', 'DOM 不重复创建', 'FAIL', String(e.message || e));
}

// ── G. PauseMenu / 属性面板内容 ──────────────────────────────────────────
try {
  const root = ui.pauseMenu.root;
  const counts = root && root.querySelectorAll ? Array.from(root.querySelectorAll('.pause-btn')).length : 0;
  const acts = pauseMod.ACTIONS ? pauseMod.ACTIONS.map((a) => a.act) : [];
  rec('S7', '暂停菜单：8 个动作（继续/属性/天赋/技能/装备/音效/保存/返回主菜单）', acts.length >= 8 ? 'PASS' : 'WARN',
    `ACTIONS=[${acts.join(',')}] DOM .pause-btn 数=${counts}${counts ? '' : '（桩 querySelectorAll 限制，需真机确认渲染）'}`);
} catch (e) {
  rec('S7', '暂停菜单按钮', 'FAIL', String(e.message || e));
}
try {
  if (ui.isPaused()) ui.togglePause(false);
  ui.openPanel('stats');
  // 【桩局限 3】stats-ui 的 openStats 是**真实 DOM** 写法：`body.innerHTML = ''` 之后用 appendChild 逐个挂节点。
  // 真实浏览器里 innerHTML 反映子节点；我们的桩里 innerHTML 只是个字符串字段，所以必须读 textContent
  // （桩已实现 textContent 聚合子节点文本）。早期版本读 innerHTML.length → 假 FAIL。
  const title = document_.getElementById('modal-title').textContent;
  const bodyEl = document_.getElementById('modal-body');
  const text = String(bodyEl.textContent || '').replace(/\s+/g, ' ').trim();
  const childCount = (bodyEl.children || []).length;
  rec('S8', '属性面板有标题 + 非空内容', (title.includes('属性') && (text.length > 40 || childCount > 3)) ? 'PASS' : 'FAIL',
    `title="${title}" 子节点=${childCount} 文本长度=${text.length} 片段="${text.slice(0, 120)}"`);
  ui.closeModals();
} catch (e) {
  rec('S8', '属性面板内容', 'FAIL', String(e.message || e));
}

// ── H. 静态源码风险复核（只读，不修改） ──────────────────────────────────
try {
  const main = readFileSync(join(ROOT, 'src', 'ui', 'main.js'), 'utf8');
  const lines = main.split('\n');
  const idxRunHotkey = lines.findIndex((l) => l.startsWith('function runHotkey'));
  const idxBlocked = lines.findIndex((l, i) => i > idxRunHotkey && l.includes('if (isInputBlocked()) return false;'));
  const idxPanel = lines.findIndex((l, i) => i > idxRunHotkey && l.includes('if (spec.panel)'));
  const order = `${idxBlocked + 1} vs ${idxPanel + 1}`;
  rec('S9', 'main.js runHotkey：isInputBlocked() 在 spec.panel 之前（面板打开时再按 C/P/K/E/Tab 会被吞）', idxBlocked < idxPanel ? 'WARN' : 'PASS',
    `isInputBlocked 在第 ${idxBlocked + 1} 行、spec.panel 在第 ${idxPanel + 1} 行（${order}）`);
  const readInputIdx = lines.findIndex((l) => l.startsWith('function readInput'));
  const clearIdx = lines.findIndex((l, i) => i > readInputIdx && l.includes('_pendingHotkeys.clear()'));
  const pausedBranch = lines.findIndex((l, i) => i > 500 && l.includes('if (paused) {'));
  // input-dev 的修复：暂停时在捕获层直接处理（handlePausedKey），ESC 走 escapeRoute()，其它键交 ui.handlePauseKey
  const hasPausedKeyFn = lines.some((l) => l.includes('function handlePausedKey'));
  const callsPausedKey = lines.some((l) => /return handlePausedKey\(e\)/.test(l));
  const escInPaused = lines.some((l, i) => i > 500 && l.includes('escapeRoute()'));
  rec('S10', 'main.js: 暂停时有独立键盘通道（handlePausedKey：ESC→escapeRoute，其他键→ui.handlePauseKey），不再依赖 readInput 消费',
    (hasPausedKeyFn && callsPausedKey && escInPaused) ? 'PASS' : 'WARN',
    `handlePausedKey 定义=${hasPausedKeyFn}、捕获层调用=${callsPausedKey}、暂停里直接 escapeRoute=${escInPaused}；` +
    `readInput 第 ${readInputIdx + 1} 行、其内 clear 第 ${clearIdx + 1} 行、暂停分支第 ${pausedBranch + 1} 行`);
} catch (e) {
  rec('S9', '静态复核', 'FAIL', String(e.message || e));
}

console.log('\n' + JSON.stringify({ results }, null, 2));
writeFileSync(join(ROOT, 'tools', '_shots', 'panelbar', 'static-qa.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
// 给调试脚本留个后门：POEQA_KEEP=1 时不退出、不卸载桩，方便 _dbg-stub.mjs 接着检查 DOM
try { globalThis.__qaUi = ui; } catch { /* 调试用 */ }
if (!process.env.POEQA_KEEP) process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
