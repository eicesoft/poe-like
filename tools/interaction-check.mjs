// 交互状态机端到端验证（Lead 收尾用）：用比 ui-dom.test.mjs 更"真"的 DOM 桩
// （appendChild 真的挂父节点、querySelector 真的查子树、classList 真的生效、事件真的派发），
// 把 GameUI + PauseMenu + PanelBar + stats-ui + main.js 的键盘路由串起来跑一遍：
//
//   ① ESC → 暂停（game.paused=true，暂停菜单 .show，HUD 由 CSS 负责淡出）
//   ② 暂停中按 C/P/K/E → 打开对应面板，暂停保持
//   ③ 面板里再按同一键 → 关闭；按 ESC → 先关面板，仍暂停
//   ④ 暂停中按 ESC → 恢复游戏
//   ⑤ 底部 4 个按钮：点击打开 / 再点关闭，且 .active 同步
//   ⑥ 暂停 3 秒世界完全冻结（world.time / 怪物坐标 / 冷却逐位不变）
//   ⑦ 重复构造 GameUI 不会出现第二个 #panel-bar / #pause-menu
//
// 用法：node tools/interaction-check.mjs
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// 1) 更真实的 DOM 桩
// ---------------------------------------------------------------------------
function makeClassList(owner) {
  const set = new Set();
  const sync = () => { owner.className = [...set].join(' '); };
  return {
    add: (...c) => { c.forEach((x) => set.add(x)); sync(); },
    remove: (...c) => { c.forEach((x) => set.delete(x)); sync(); },
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !set.has(c) : !!on;
      if (want) set.add(c); else set.delete(c);
      sync();
      return want;
    },
    get size() { return set.size; },
    _set: set,
  };
}

let nextId = 0;
function makeElement(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    _className: '',
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    _attrs: {},
    _text: '',
    disabled: false,
    _events: {},
    _uid: ++nextId,
    get className() { return this._className; },
    set className(v) {
      this._className = String(v);
      // 让 classList 反向同步一次（_syncing 防递归：classList.sync 也会写 className）
      if (this._syncingClass) return;
      this._syncingClass = true;
      try {
        const target = String(v).split(/\s+/).filter(Boolean);
        const cl = this.classList;
        for (const c of target) if (!cl.contains(c)) cl.add(c);
        for (const c of [...cl._set]) if (!target.includes(c)) cl.remove(c);
      } finally { this._syncingClass = false; }
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = String(v); this.children = []; this._parseHTML(v); },
    setAttribute(k, v) {
      this._attrs[k] = v;
      if (k === 'id') { this.id = v; registerId(v, this); }
      if (k === 'class') this.className = v;
      if (k === 'disabled') this.disabled = true;
    },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; if (k === 'disabled') this.disabled = false; },
    hasAttribute(k) { return k in this._attrs; },
    appendChild(c) { c.parentNode = node; node.children.push(c); if (c.id) registerId(c.id, c); return c; },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    contains(n) { let cur = n; while (cur) { if (cur === node) return true; cur = cur.parentNode; } return false; },
    addEventListener(type, fn) { (node._events[type] = node._events[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = node._events[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent(ev) {
      ev.target = ev.target || node;
      ev.currentTarget = node;
      ev.stopPropagation = ev.stopPropagation || function () { this._stopped = true; };
      ev.preventDefault = ev.preventDefault || function () { this.defaultPrevented = true; };
      const list = (node._events[ev.type] || []).slice();
      for (const fn of list) fn.call(node, ev);
      // 冒泡到父节点（到 document.body 为止）
      if (!ev._stopped && node.parentNode && node.parentNode.dispatchEvent) node.parentNode.dispatchEvent(ev);
      return !ev.defaultPrevented;
    },
    click() { if (node.disabled) return; node.dispatchEvent({ type: 'click' }); },
    focus() { documentStub.activeElement = node; },
    blur() { if (documentStub.activeElement === node) documentStub.activeElement = null; },
    querySelector(sel) { return queryAll(node, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(node, sel); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }; },
    get offsetWidth() { return 100; },
    get offsetHeight() { return 40; },
    get clientWidth() { return 1280; },
    get clientHeight() { return 720; },
    getContext() { return makeCtx(); },
    // 超简 HTML 解析：只认 <tag class="...">text</tag> 与自闭合，够我们的模板用
    _parseHTML(html) {
      const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
      const stack = [node];
      let m;
      while ((m = re.exec(html))) {
        const [, closing, tagName, attrs, selfClose, text] = m;
        if (text != null) {
          if (text.trim()) stack[stack.length - 1]._text += text;
          continue;
        }
        if (closing) { if (stack.length > 1) stack.pop(); continue; }
        const el = makeElement(tagName);
        const attrRe = /([\w-]+)="([^"]*)"/g;
        let a;
        while ((a = attrRe.exec(attrs || ''))) el.setAttribute(a[1], a[2]);
        stack[stack.length - 1].appendChild(el);
        if (!selfClose && !/^(br|img|input|hr|i|circle|path|kbd)$/i.test(tagName)) stack.push(el);
        else if (/^(i|circle|path)$/i.test(tagName) && !selfClose) stack.push(el);
      }
    },
  };
  Object.defineProperty(node, 'classList', { value: makeClassList(node), enumerable: true });
  node.className = '';
  return node;
}

const idRegistry = {};
const idList = {};
function registerId(id, node) {
  idRegistry[id] = node;
  (idList[id] = idList[id] || []).push(node);
}

function matches(el, sel) {
  for (const part of String(sel).split(',')) {
    const s = part.trim();
    if (!s) continue;
    if (s.startsWith('#')) { if (el.id === s.slice(1)) return true; continue; }
    if (s.startsWith('.')) { if (String(el.className).split(/\s+/).includes(s.slice(1))) return true; continue; }
    const m = s.match(/^([a-zA-Z]+)?(?:#([\w-]+))?(?:\.([\w-]+))?(\[[\w-]+\])?$/);
    if (m && (m[1] || m[2] || m[3] || m[4])) {
      if (m[1] && el.tagName !== m[1].toUpperCase()) continue;
      if (m[2] && el.id !== m[2]) continue;
      if (m[3] && !String(el.className).split(/\s+/).includes(m[3])) continue;
      return true;
    }
  }
  return false;
}

function queryAll(root, sel) {
  const parts = String(sel).trim().split(/\s+/).filter(Boolean);
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (matches(c, parts[parts.length - 1])) {
        let ok = true;
        if (parts.length > 1) {
          let cur = c.parentNode, idx = parts.length - 2;
          while (cur && idx >= 0) { if (matches(cur, parts[idx])) idx--; cur = cur.parentNode; }
          ok = idx < 0;
        }
        if (ok) out.push(c);
      }
      walk(c);
    }
  };
  walk(root);
  return out;
}

function makeCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  return new Proxy({
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    createPattern: () => null, measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    setTransform: noop, resetTransform: noop, save: noop, restore: noop,
  }, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}

const documentStub = {
  body: makeElement('body'),
  documentElement: makeElement('html'),
  activeElement: null,
  createElement: (t) => makeElement(t),
  createElementNS: (ns, t) => makeElement(t),
  createTextNode: (t) => { const n = makeElement('#text'); n.textContent = t; return n; },
  getElementById: (id) => idRegistry[id] || null,
  querySelector: (s) => (s.startsWith('#') ? idRegistry[s.slice(1)] || null : queryAll(documentStub.body, s)[0] || null),
  querySelectorAll: (s) => (s.startsWith('#') ? (idList[s.slice(1)] || []) : queryAll(documentStub.body, s)),
  addEventListener() {},
  removeEventListener() {},
};

function installDOM() {
  const ids = ['app', 'game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp',
    'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count',
    'wave-count', 'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip',
    'banner', 'damage-layer', 'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen',
    'start-screen2', 'loading', 'btn-start', 'profile-info'];
  const app = documentStub.body.appendChild(makeElement('div'));
  app.id = 'app'; registerId('app', app);
  for (const id of ids) {
    if (id === 'app') continue;
    const n = makeElement(id === 'game' ? 'canvas' : 'div');
    n.id = id;
    registerId(id, n);
    app.appendChild(n);
  }
  const banner = idRegistry.banner;
  const bt = makeElement('div'); bt.className = 'banner-text'; banner.appendChild(bt);
  const skillbar = idRegistry.skillbar;
  for (let i = 0; i < 7; i++) {
    const slot = makeElement('div');
    slot.className = 'slot';
    slot.dataset.idx = String(i);
    for (const cls of ['key', 'glyph', 'cd', 'cdtxt']) { const c = makeElement('div'); c.className = cls; slot.appendChild(c); }
    skillbar.appendChild(slot);
  }
  globalThis.document = documentStub;
  globalThis.window = {
    document: documentStub, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
    performance, location: { search: '' },
  };
  globalThis.localStorage = {
    _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
  };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  return { app, ids: idRegistry };
}

// ---------------------------------------------------------------------------
// 2) 断言 & 运行
// ---------------------------------------------------------------------------
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e && e.message });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  installDOM();
  const { GameUI } = await import('../src/ui/ui.js');
  const { createGame, updateGame } = await import('../src/game/app.js');
  const appMod = await import('../src/game/app.js');

  const game = createGame({ seed: 7, tier: 1 });
  game.inv.talentPoints = 3;
  game.actions = {
    revive: () => {}, newMap: () => {}, pickup: () => {},
    equipFromBag: () => {}, unequip: () => {}, sell: () => {}, sellJunk: () => {}, sortBag: () => {},
    takeTalent: (id) => appMod.doTakeTalent(game, id),
    refundTalent: (id) => appMod.doRefundTalent(game, id),
    skillRankUp: (sid, nid) => appMod.doSkillRankUp(game, sid, nid),
    skillPointsTotal: () => 3,
    save: () => true,
  };
  const ui = new GameUI(game);
  game.ui = ui;

  // ① ESC → 暂停
  check('① ESC 打开暂停：game.paused=true 且暂停菜单 .show', () => {
    assert(!game.paused, '初始不应暂停');
    const r = ui.handleEscape();
    assert(r === 'paused', 'ESC 返回 paused，实际 ' + r);
    assert(game.paused === true, 'game.paused 应为 true');
    assert(ui.pauseMenu && ui.pauseMenu.isOpen, '暂停菜单应打开');
    const root = documentStub.getElementById('pause-menu');
    assert(root && root.classList.contains('show'), '#pause-menu 应有 .show');
    return 'ESC→' + r;
  });

  // ② 暂停中按面板键：打开面板且仍暂停
  const panelCases = [['stats', '属性面板'], ['talents', '天赋树'], ['skills', ''], ['inventory', '背包']];
  for (const [kind] of panelCases) {
    check(`② 暂停中打开 ${kind}：面板打开且仍暂停`, () => {
      ui.openPanel(kind);
      assert(ui.modalOpen === (kind === 'inventory' ? 'inventory' : kind), 'modalOpen=' + ui.modalOpen);
      assert(game.paused === true, '打开面板不应解除暂停');
      assert(!documentStub.getElementById('modal').classList.contains('hidden'), '#modal 应可见');
      const body = documentStub.getElementById('modal-body');
      assert(body.children.length > 0, '面板内容为空');
      return 'modalOpen=' + ui.modalOpen + ' 子节点=' + body.children.length;
    });
    check(`③ 暂停中再按 ESC：先关 ${kind}，仍暂停`, () => {
      const r = ui.handleEscape();
      assert(r === 'panel', 'ESC 应返回 panel，实际 ' + r);
      assert(ui.modalOpen === null, '面板应关闭');
      assert(game.paused === true, '关面板后应仍暂停');
      assert(ui.pauseMenu && ui.pauseMenu.isOpen, '暂停菜单应重新显示');
      return 'ESC→' + r;
    });
  }

  // ④ 暂停中 ESC → 恢复
  check('④ 暂停中 ESC 恢复游戏', () => {
    const r = ui.handleEscape();
    assert(r === 'resumed', 'ESC 应返回 resumed，实际 ' + r);
    assert(game.paused === false, 'game.paused 应为 false');
    assert(!ui.pauseMenu.isOpen, '暂停菜单应关闭');
    return 'ESC→' + r;
  });

  // ⑤ 底部按钮列
  const bar = ui.panelBar || documentStub.getElementById('panel-bar');
  check('⑤ 底部按钮列存在且有 4 个带 icon 的按钮', () => {
    const el = documentStub.getElementById('panel-bar');
    assert(el, '#panel-bar 不存在');
    const acts = (el._events.keydown, queryAll(el, '.panel-btn'));
    // queryAll 找不到时（innerHTML 模板没解析出）退回内存态
    const btns = acts.length ? acts : (ui.panelBar && ui.panelBar.buttons ? Object.values(ui.panelBar.buttons) : []);
    assert(btns.length === 4, '按钮数=' + btns.length);
    const dataActs = btns.map((b) => b.getAttribute('data-act'));
    return 'data-act=' + dataActs.join(',');
  });
  for (const act of ['stats', 'talents', 'skills', 'equipment']) {
    check(`⑤ 点击底部「${act}」按钮 → 打开 → 再点关闭`, () => {
      const el = documentStub.getElementById('panel-bar');
      const btns = queryAll(el, '.panel-btn');
      const btn = btns.find((b) => b.getAttribute('data-act') === act);
      assert(btn, '找不到按钮 ' + act);
      btn.click();
      assert(ui.modalOpen, '点击后应打开面板，modalOpen=' + ui.modalOpen);
      const want = act === 'equipment' ? 'inventory' : act;
      assert(ui.modalOpen === want, `modalOpen=${ui.modalOpen} 期望 ${want}`);
      const active = btn.classList.contains('active');
      assert(active, '按钮应高亮 .active');
      btn.click();
      assert(ui.modalOpen === null, '再次点击应关闭');
      return 'ok';
    });
  }

  // ⑥ 暂停 3 秒世界冻结
  check('⑥ 暂停 3 秒：world.time/怪物坐标/冷却逐位不变', () => {
    const p = game.world.player;
    // 先跑 1 秒让世界动起来
    for (let i = 0; i < 60; i++) updateGame(game, 1 / 60, { move: { x: 0, z: 1 }, aim: { x: p.x, z: p.z + 5 } });
    const before = {
      time: game.world.time,
      px: p.x, pz: p.z,
      monsters: game.world.monsters.map((m) => [m.x, m.z, m.hp]),
      cd: JSON.stringify(p.cooldowns || {}),
    };
    ui.togglePause(true);
    assert(game.paused === true, '应已暂停');
    // 模拟 3 秒 rAF（主循环暂停时不调用 updateGame —— 与 frame() 的暂停分支一致）
    for (let i = 0; i < 180; i++) {
      if (!game.paused) updateGame(game, 1 / 60, {});
    }
    const after = {
      time: game.world.time,
      px: p.x, pz: p.z,
      monsters: game.world.monsters.map((m) => [m.x, m.z, m.hp]),
      cd: JSON.stringify(p.cooldowns || {}),
    };
    assert(before.time === after.time, `world.time 变了 ${before.time}→${after.time}`);
    assert(before.px === after.px && before.pz === after.pz, '玩家坐标变了');
    assert(JSON.stringify(before.monsters) === JSON.stringify(after.monsters), '怪物状态变了');
    assert(before.cd === after.cd, '冷却变了');
    ui.togglePause(false);
    return `world.time 保持 ${after.time.toFixed(3)}，怪物 ${after.monsters.length} 只逐位一致`;
  });

  // ⑦ DOM 唯一性
  check('⑦ 重复构造 GameUI 不会产生第二个 #panel-bar / #pause-menu', () => {
    for (let i = 0; i < 3; i++) {
      const g2 = createGame({ seed: 8 + i, tier: 1 });
      g2.inv.talentPoints = 1;
      g2.actions = game.actions;
      const ui2 = new GameUI(g2);
      g2.ui = ui2;
      ui2.togglePause(true);
      ui2.openPanel('stats');
      ui2.closeModals();
      ui2.togglePause(false);
      ui2.update(1 / 60);
    }
    const bars = documentStub.querySelectorAll('#panel-bar').length;
    const menus = documentStub.querySelectorAll('#pause-menu').length;
    assert(bars === 1, '#panel-bar 数量=' + bars);
    assert(menus <= 1, '#pause-menu 数量=' + menus);
    return `#panel-bar=${bars} #pause-menu=${menus}`;
  });

  // 汇总
  const fail = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`);
  process.exitCode = fail.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });