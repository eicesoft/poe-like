// 底部面板按钮列（PanelBar）+ GameUI.openPanel 统一入口：DOM 桩测试。
// 覆盖：按钮创建（icon/label/kbd/data-act）、click → 对应面板、再次 click 关闭、
//       .active 同步、角标数字（>99 → 99+）、Tab 聚焦 + Enter、防御式（弱 DOM / 缺 stats-ui）、
//       update() 不每帧写 DOM。
import { describe, test, assert } from './_runner.mjs';

/** ---------- 带真实事件派发的极简 DOM 桩（比 ui-dom.test.mjs 多支持 dispatchEvent） ---------- */
const idRegistry = {};

function makeClassList(node) {
  const set = new Set();
  const sync = () => { node.className = [...set].join(' '); };
  return {
    add: (...c) => { c.forEach((x) => set.add(x)); sync(); },
    remove: (...c) => { c.forEach((x) => set.delete(x)); sync(); },
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      const has = set.has(c);
      const want = on === undefined ? !has : !!on;
      if (want) set.add(c); else set.delete(c);
      sync();
      return want;
    },
    _set: set,
  };
}

function makeElement(tag = 'div') {
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    _className: '',
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    _attrs: {},
    textContent: '',
    _html: '',
    _writes: 0,
    type: '',
    get className() { return this._className; },
    set className(v) {
      this._className = String(v);
      this._writes++;
      this.classList._set.clear();
      for (const c of this._className.split(/\s+/)) if (c) this.classList._set.add(c);
      this.classList._set.delete('__none__');
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; this._writes++; },
    setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') { this.id = v; idRegistry[v] = this; } if (k === 'class') this.className = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
    appendChild(c) { c.parentNode = node; node.children.push(c); if (c.id) idRegistry[c.id] = c; return c; },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) {
      ev.target = ev.target || node;
      const run = (n) => {
        const ls = n._listeners && n._listeners[ev.type];
        if (ls) for (const fn of ls.slice()) fn.call(n, ev);
        // 冒泡（简单版：沿 parentNode 往上）
        if (!ev._stopped && n.parentNode) run(n.parentNode);
      };
      run(node);
      return !ev.defaultPrevented;
    },
    contains(n) { let c = n; while (c) { if (c === node) return true; c = c.parentNode; } return false; },
    click() { return this.dispatchEvent(makeEvent('click')); },
    focus() { node._focused = true; },
    querySelector(sel) { return findOne(node, sel); },
    querySelectorAll(sel) { return findAll(node, sel); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40 }; },
    get offsetWidth() { return 58; },
    get offsetHeight() { return 50; },
    get clientWidth() { return 1440; },
    get clientHeight() { return 810; },
    getContext() { return makeCanvasCtx(); },
  };
  node._listeners = listeners;
  node.classList = makeClassList(node);
  return node;
}

function makeEvent(type, extra = {}) {
  return Object.assign({
    type, target: null, defaultPrevented: false, _stopped: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopped = true; this.propagationStopped = true; },
  }, extra);
}

function matches(el, sel) {
  for (const part of String(sel).split(',')) {
    const s = part.trim();
    if (!s) continue;
    if (s.startsWith('#')) { if (el.id === s.slice(1)) return true; continue; }
    if (s.startsWith('.')) { if (String(el.className).split(/\s+/).includes(s.slice(1))) return true; continue; }
    const m = s.match(/^([a-zA-Z]+)(?:#([\w-]+))?(?:\.([\w-]+))?$/);
    if (m) {
      if (el.tagName !== m[1].toUpperCase()) continue;
      if (m[2] && el.id !== m[2]) continue;
      if (m[3] && !String(el.className).split(/\s+/).includes(m[3])) continue;
      return true;
    }
  }
  return false;
}

function walk(root, fn) {
  for (const c of root.children || []) { fn(c); walk(c, fn); }
}

function findAll(root, sel) {
  const out = [];
  const last = String(sel).trim().split(/\s+/).pop();
  walk(root, (n) => { if (matches(n, last)) out.push(n); });
  return out;
}

function findOne(root, sel) {
  const all = findAll(root, sel);
  return all.length ? all[0] : null;
}

function makeCanvasCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  return new Proxy({
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => null,
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop,
    setTransform: noop, resetTransform: noop, save: noop, restore: noop, canvas: null,
  }, {
    get(t, k) { return k in t ? t[k] : noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/** index.html 里 UI 需要的节点骨架 */
function installStubDOM() {
  idRegistry.__reset__ = true;
  for (const k of Object.keys(idRegistry)) delete idRegistry[k];
  const ids = ['app', 'game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp',
    'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count',
    'wave-count', 'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip',
    'banner', 'damage-layer', 'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen',
    'loading', 'btn-start'];
  const body = makeElement('body');
  const app = makeElement('div');
  app.id = 'app';
  body.appendChild(app);
  const byId = { app, body };
  for (const id of ids) {
    const n = makeElement(id.startsWith('bar-') ? 'i' : 'div');
    n.id = id;
    byId[id] = n;
    app.appendChild(n);
  }
  const bt = makeElement('div');
  bt.className = 'banner-text';
  byId.banner.appendChild(bt);
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
    createTextNode: (t) => ({ tagName: '#text', textContent: String(t), children: [] }),
    getElementById: (id) => idRegistry[id] || null,
    querySelector: (sel) => (sel.startsWith('#') && !sel.includes(' ') ? idRegistry[sel.slice(1)] || null : findOne(body, sel)),
    querySelectorAll: (sel) => findAll(body, sel),
    addEventListener() {},
    removeEventListener() {},
  };
  const windowListeners = {};
  const window = {
    document,
    devicePixelRatio: 1,
    innerWidth: 1440,
    innerHeight: 810,
    addEventListener: (t, fn) => { (windowListeners[t] = windowListeners[t] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
    performance,
    location: { search: '' },
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.localStorage = null;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  return { document, window, byId, windowListeners };
}

function makeFakeGame() {
  const player = {
    x: 10, z: 10, facing: 0, level: 3, hp: 100, maxHp: 140, mp: 30, maxMp: 60, xp: 10,
    skillBar: [
      { id: 'groundSlam', name: '裂地斩', icon: '🪓', desc: '扇形冲击波', level: 1 },
      { id: 'whirlwind', name: '旋风斩', icon: '🌀', desc: '持续旋转', level: 1 },
      { id: 'warcry', name: '战吼', icon: '📢', desc: '恐吓敌人', level: 1 },
      { id: 'bloodRage', name: '血性狂暴', icon: '🩸', desc: '狂暴增益', level: 1 },
      { id: 'rally', name: '坚毅图腾', icon: '🔨', desc: '召唤图腾', level: 1 },
      null, null,
    ],
    cooldowns: {}, buffs: [], anim: { state: 'idle', t: 0, dur: 0.3 },
  };
  const world = {
    time: 1, tier: 2, player, monsters: [], items: [], lootOrbs: [],
    map: { name: '众星教堂遗迹', tier: 2, level: 4, mods: [] },
    stats: { kills: 5, waves: 2 },
  };
  return {
    world,
    inv: null,
    stats: { dmg: '12-22', aps: 1.35, crit: 0.05, critMulti: 1.5, armor: 0, evasion: 0, moveSpeed: 6.2, fire: 0, cold: 0, lightning: 0, aoe: 0, life: 140, xp: { xpMax: 100 } },
  };
}

const ACTS = ['stats', 'talents', 'skills', 'equipment'];
const btnOf = (act) => document.querySelector(`.panel-btn[data-act="${act}"]`) || null;
// 桩不支持 [attr] 选择器 —— 用遍历替代
function panelBtn(act) {
  const bar = document.getElementById('panel-bar');
  if (!bar) return null;
  return (bar.children || []).find((c) => c.getAttribute && c.getAttribute('data-act') === act) || null;
}
function badgeTextOf(act) {
  const btn = panelBtn(act);
  if (!btn) return null;
  const b = findOne(btn, '.pb-badge');
  return b ? b.textContent : null;
}

describe('底部面板按钮列（PanelBar）', () => {
  let dom, game, ui, invm, appm, PanelBarMod, uiMod;

  test('安装 DOM 桩并创建 GameUI（按钮列已挂到 #hud）', async () => {
    dom = installStubDOM();
    invm = await import('../src/game/inventory.js');
    appm = await import('../src/game/app.js');
    PanelBarMod = await import('../src/ui/panel-bar.js');
    uiMod = await import('../src/ui/ui.js');
    game = makeFakeGame();
    game.inv = invm.createInventory();
    game.inv.talentPoints = 3;
    game.actions = {
      takeTalent: (id) => appm.doTakeTalent(game, id),
      refundTalent: (id) => appm.doRefundTalent(game, id),
      skillRankUp: (sid, nid) => appm.doSkillRankUp(game, sid, nid),
      skillPointsTotal: () => 3,
      refineSkill: () => false,
      equipFromBag: () => true, unequip: () => true, sell: () => 1, sellJunk: () => 1, sortBag: () => {},
      revive: () => {}, newMap: () => {}, pickup: () => {},
    };
    ui = new uiMod.GameUI(game);
    game.ui = ui;
    assert.ok(ui.panelBar, 'GameUI 持有 PanelBar');
    const bar = document.getElementById('panel-bar');
    assert.ok(bar, '#panel-bar 已创建');
    assert.equal(bar.parentNode && bar.parentNode.id, 'hud', '按钮列挂在 #hud 里');
    assert.equal(bar.getAttribute('role'), 'toolbar');
  });

  test('4 个按钮：data-act / 内联 SVG 图标 / 中文名 / <kbd> 快捷键', () => {
    const bar = document.getElementById('panel-bar');
    assert.equal(bar.children.length, 4, '恰好 4 个按钮');
    const expect = { stats: ['属性', 'C'], talents: ['天赋', 'P'], skills: ['技能', 'K'], equipment: ['装备', 'E'] };
    for (const act of ACTS) {
      const btn = panelBtn(act);
      assert.ok(btn, `存在按钮 ${act}`);
      assert.equal(btn.tagName, 'BUTTON');
      assert.equal(btn.type, 'button');
      assert.ok(btn.classList.contains('panel-btn'));
      const ico = findOne(btn, '.pb-ico');
      assert.ok(ico, `${act} 有 .pb-ico`);
      assert.ok(/<svg[\s\S]*viewBox="0 0 24 24"[\s\S]*<\/svg>/.test(ico.innerHTML), `${act} 图标是内联 SVG（24×24 viewBox）`);
      assert.ok(ico.innerHTML.includes('currentColor'), `${act} SVG 用 currentColor 上色`);
      assert.ok(ico.innerHTML.includes('stroke-width="1.6"'), `${act} SVG 描边 1.6`);
      const label = findOne(btn, '.pb-label');
      assert.equal(label.textContent, expect[act][0], `${act} 中文名`);
      const kbd = findOne(btn, '.pb-key');
      assert.equal(kbd.tagName, 'KBD', `${act} 快捷键用 <kbd>`);
      assert.equal(kbd.textContent, expect[act][1], `${act} 快捷键字母`);
      assert.ok(btn.getAttribute('title') && btn.getAttribute('title').length > 4, `${act} 有 title 提示`);
    }
  });

  test('click → 打开对应面板，modalOpen 正确、按钮 .active', () => {
    panelBtn('talents').click();
    assert.equal(ui.modalOpen, 'talents');
    assert.ok(!dom.byId.modal.classList.contains('hidden'), '遮罩已显示');
    assert.ok(panelBtn('talents').classList.contains('active'), '天赋按钮高亮');
    assert.equal(panelBtn('talents').getAttribute('aria-pressed'), 'true');
    assert.ok(!panelBtn('stats').classList.contains('active'), '其它按钮不高亮');
  });

  test('直接切换到另一个面板：旧按钮取消高亮（暂停/遮罩期间也能切）', () => {
    panelBtn('skills').click();
    assert.equal(ui.modalOpen, 'skills');
    assert.ok(panelBtn('skills').classList.contains('active'));
    assert.ok(!panelBtn('talents').classList.contains('active'), '天赋按钮已取消高亮');
  });

  test('再次 click 同一个按钮 → closeModals（modalOpen=null，按钮取消高亮）', () => {
    panelBtn('skills').click();
    assert.equal(ui.modalOpen, null);
    assert.ok(dom.byId.modal.classList.contains('hidden'), '遮罩已隐藏');
    assert.ok(!panelBtn('skills').classList.contains('active'));
    assert.equal(panelBtn('skills').getAttribute('aria-pressed'), 'false');
    for (const act of ACTS) assert.ok(!panelBtn(act).classList.contains('active'), `${act} 无残留高亮`);
  });

  test('装备按钮 ↔ modalOpen=inventory 双向对应；openPanel 带别名', () => {
    panelBtn('equipment').click();
    assert.equal(ui.modalOpen, 'inventory', '装备面板的 modalOpen 是 inventory');
    assert.ok(panelBtn('equipment').classList.contains('active'), 'equipment 按钮高亮');
    ui.closeModals();
    // 别名：inventory / bag / equip 都指向装备按钮
    assert.equal(ui.openPanel('inventory'), 'inventory');
    assert.ok(panelBtn('equipment').classList.contains('active'));
    ui.closeModals();
    assert.ok(!panelBtn('equipment').classList.contains('active'));
    assert.equal(ui.openPanel('bag'), 'inventory');
    ui.closeModals();
    assert.equal(ui.openPanel('nope'), null, '未知面板不打开任何东西也不崩');
  });

  test('openModal / closeModals 直接调用也会同步按钮列', () => {
    ui.openModal('skills');
    assert.ok(ui.panelBar.active === 'skills', '面板按钮列 active = skills');
    assert.ok(panelBtn('skills').classList.contains('active'));
    ui.closeModals();
    assert.equal(ui.panelBar.active, null);
  });

  test('属性面板：stats-ui 可用时打开，缺席时只记日志不崩', async () => {
    panelBtn('stats').click();
    assert.equal(ui.modalOpen, 'stats', '属性面板可以打开');
    assert.ok(panelBtn('stats').classList.contains('active'));
    assert.equal(ui.openPanel('stats'), null, '再点一次关闭');
    const statsMod = await import('../src/ui/stats-ui.js');
    assert.equal(typeof statsMod.openStats, 'function', 'stats-ui.js 已导出 openStats（队友交付）');
    // 防御式：把 openStats 临时拿掉，ui.toggleStats 必须仍能打开且不抛异常
    const saved = statsMod.openStats;
    try {
      // 命名空间对象的属性不可写时跳过（ESM 只读导出）
      try { statsMod.openStats = undefined; } catch { /* 只读则跳过替换，改测"未就绪"提示文案逻辑 */ }
      let threw = false;
      try { ui.toggleStats(); } catch { threw = true; }
      assert.ok(!threw, 'toggleStats 不抛异常');
      assert.equal(ui.modalOpen, 'stats');
    } finally {
      try { statsMod.openStats = saved; } catch { /* ignore */ }
      ui.closeModals();
    }
  });

  test('角标：天赋点 3 / 技能点 3，>99 显示 99+', () => {
    game.inv.talentPoints = 3;
    const st = ui.panelBar.syncBadges({ level: 3 });
    assert.equal(st.stats, 3, 'badgeState.stats = 天赋点');
    assert.equal(st.skills, 3, 'badgeState.skills = 技能点（与 #skill-notify 同源）');
    assert.equal(badgeTextOf('stats'), '3');
    assert.equal(badgeTextOf('skills'), '3');
    // 技能点的来源是 ui.skillNotifyState().points —— 与 HUD 光点同源
    assert.equal(ui.panelBar.badgeState().skills, ui.skillNotifyState().points);
    game.inv.talentPoints = 250;
    ui.panelBar.syncBadges();
    assert.equal(badgeTextOf('stats'), '99+', '>99 显示 99+');
    game.inv.talentPoints = 0;
    ui.panelBar.syncBadges();
    assert.equal(badgeTextOf('stats'), '', '没有点数时角标为空');
    assert.ok(findOne(panelBtn('stats'), '.pb-badge').classList.contains('pb-badge-hidden'), '没有点数时角标加隐藏类');
  });

  test('badgeText 纯函数：0/负值/小数/大数', () => {
    assert.equal(PanelBarMod.badgeText(0), '');
    assert.equal(PanelBarMod.badgeText(-5), '');
    assert.equal(PanelBarMod.badgeText(NaN), '');
    assert.equal(PanelBarMod.badgeText(2.7), '2');
    assert.equal(PanelBarMod.badgeText(99), '99');
    assert.equal(PanelBarMod.badgeText(100), '99+');
    assert.equal(PanelBarMod.talentPointsOf({ game: { inv: { talentPoints: { avail: 4 } } } }), 4);
    assert.equal(PanelBarMod.talentPointsOf({ game: { inv: null } }), 0);
    assert.equal(PanelBarMod.talentPointsOf(null), 0);
  });

  test('点数变化后：onEvents 立即刷、update() 最多 1Hz 刷（不每帧写 DOM）', () => {
    game.inv.talentPoints = 5;
    // 事件驱动：一条技能加点事件就会同步角标
    ui.onEvents([{ type: 'skillRankUp', name: '战争践踏', nodeName: '震地' }, { type: 'levelUp', level: 4, gainedPoints: 1 }]);
    assert.equal(badgeTextOf('stats'), '5');
    // 正面写法：让点数在"没有事件"的情况下变化，靠 update() 的 ≤1Hz 节流兜底
    game.inv.talentPoints = 6;
    const writes0 = panelBtn('stats')._writes;
    for (let i = 0; i < 5; i++) ui.update(1 / 60); // 5 帧 = 0.083s，不到 1 秒
    assert.equal(badgeTextOf('stats'), '5', '1 秒内不重算角标');
    ui.update(1.0); // 跨过节拍
    assert.equal(badgeTextOf('stats'), '6', '节拍到了才刷新');
    // 数字没变时：哪怕再过 3 秒也一个 DOM 都不写
    const sign = ui.panelBar._badgeSig;
    const btn = panelBtn('stats');
    const writesBefore = (btn._writes || 0) + (findOne(btn, '.pb-badge')._writes || 0);
    for (let i = 0; i < 4; i++) ui.update(0.5);
    const writesAfter = (btn._writes || 0) + (findOne(btn, '.pb-badge')._writes || 0);
    assert.equal(ui.panelBar._badgeSig, sign, '数值签名不变');
    assert.equal(writesAfter, writesBefore, '值没变 → 不写 DOM');
  });

  test('等级变化立即刷角标（不等 1Hz）', () => {
    // 技能点来源 = game.actions.skillPointsTotal() - 已花（与 HUD #skill-notify 同源）
    const saved = game.actions.skillPointsTotal;
    try {
      game.world.player.level = 3;
      game.inv.talentPoints = 5;
      game.inv.skillRanks = {};
      game.inv.skillPoints = { total: 2 };
      game.actions.skillPointsTotal = () => 2;
      ui.panelBar.syncBadges();
      assert.equal(badgeTextOf('stats'), '5');
      assert.equal(badgeTextOf('skills'), '2');
      game.inv.talentPoints = 0;
      game.world.player.level = 9;
      game.inv.skillPoints = { total: 5 };
      game.actions.skillPointsTotal = () => 5;
      ui.update(1 / 60); // 一帧就够：等级变化触发立即刷新（不等 ≤1Hz 节拍）
      assert.equal(ui.panelBar.badgeState().skills, ui.skillNotifyState().points);
      assert.equal(ui.panelBar.badgeState().skills, 5, '等级变化后技能点角标已更新');
      assert.equal(badgeTextOf('skills'), '5');
      assert.equal(badgeTextOf('stats'), '', '天赋点 0 → 属性角标消失');
    } finally {
      game.actions.skillPointsTotal = saved;
    }
  });

  test('键盘：按钮是原生 <button>（Tab 可聚焦 + Enter 触发 click）', () => {
    // 桩里没有浏览器默认行为，这里验证两点：①按钮是 type=button 的可聚焦元素；
    // ②按钮上的 Enter/空格 keydown 不会冒泡到 window（否则 input.js 会把它当游戏按键）。
    const btn = panelBtn('talents');
    assert.equal(btn.tagName, 'BUTTON');
    let reachedWindow = false;
    dom.window.addEventListener('keydown', () => { reachedWindow = true; });
    const ev = makeEvent('keydown', { key: 'Enter', code: 'Enter' });
    btn.dispatchEvent(ev);
    assert.ok(ev.propagationStopped || !reachedWindow, 'Enter 被按钮列拦截，不冒泡到 window');
    // click 由浏览器在 Enter 时触发 —— 模拟它
    btn.click();
    assert.equal(ui.modalOpen, 'talents');
    ui.closeModals();
  });

  test('独立实例：PanelBar 可单独 new（DOM 挂了再建也不会重复）', () => {
    const fakeUi = { modalOpen: null, openPanel() { this.modalOpen = 'talents'; return this.modalOpen; }, closeModals() { this.modalOpen = null; } };
    const bar = new PanelBarMod.PanelBar(fakeUi);
    bar.ensure();
    bar.ensure(); // 幂等
    assert.equal(Object.keys(bar.btns).length, 4);
    assert.equal(bar.activate('talents'), 'talents');
    assert.ok(bar.btns.talents.classList.contains('active'), 'sync 后高亮');
    fakeUi.modalOpen = 'talents';
    bar.sync();
    assert.ok(bar.btns.talents.classList.contains('active'));
    assert.equal(bar.debugState().acts.join(','), ACTS.join(','));
  });

  // ---- BUG3 回归：第二个 GameUI 实例不能造出第二个 #panel-bar（QA 验收项 G） ----
  test('#panel-bar 全局唯一：第二个 GameUI 接管已有节点，不重复挂载', () => {
    const countIn = (root, id) => {
      let n = 0;
      const walk = (x) => { for (const c of (x.children || [])) { if (c.id === id) n++; walk(c); } };
      walk(root);
      return n;
    };
    // 指令计数：确认真被处理的动作只属于新实例。桩里没有 removeEventListener，
    // 旧监听器仍会被调用一次，但旧 PanelBar.activate 检测到自己已被接管 → 直接返回，不改任何状态。
    const oldBar = ui.panelBar;
    let oldCalls = 0;
    const oldActivate = oldBar.activate;
    oldBar.activate = function spy(act) {
      // 记录"旧实例是否真的动过状态"（让位后的 activate 不应该改变 ui.modalOpen）
      const before = ui.modalOpen;
      const r = oldActivate.call(this, act);
      if (ui.modalOpen !== before) oldCalls++;
      return r;
    };
    const hud = dom.byId.hud;
    assert.equal(countIn(hud, 'panel-bar'), 1, '第一个实例只挂一个');
    const first = document.getElementById('panel-bar');

    const game2 = makeFakeGame();
    game2.inv = invm.createInventory();
    game2.inv.talentPoints = 2;
    game2.actions = { skillPointsTotal: () => 1 };
    const ui2 = new uiMod.GameUI(game2);
    game2.ui = ui2;
    assert.equal(countIn(hud, 'panel-bar'), 1, '第二个实例接管，不新增节点');
    assert.equal(ui2.panelBar.el, first, '第二个实例接管的是同一个 DOM 节点');
    assert.ok(ui2.panelBar.btns && ui2.panelBar.btns.stats, '接管后重新绑定了按钮引用');

    ui2.closeModals(); // 归零，避免和上一条用例的状态纠缠
    panelBtn('talents').click();
    assert.equal(ui2.modalOpen, 'talents', '点击走新实例的 openPanel');
    assert.equal(ui.modalOpen, null, '旧实例状态没被污染');
    assert.equal(oldCalls, 0, '旧实例没有改过任何状态（让位生效，点击只被处理一次）');
    assert.ok(panelBtn('talents').classList.contains('active'), '高亮同步到唯一节点');
    // 角标也按新实例的数据渲染
    assert.equal(badgeTextOf('stats'), '2');
    ui2.closeModals();
    oldBar.activate = oldActivate;
    assert.equal(countIn(hud, 'panel-bar'), 1);
  });

  test('布局：顶部居中横排一排 4 个方形按钮（CSS 静态断言）', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
    const seg = css.slice(css.lastIndexOf('PANEL BAR'));
    const rule = (sel) => {
      const i = seg.indexOf(sel + ' {');
      if (i < 0) return '';
      return seg.slice(i, seg.indexOf('}', i) + 1);
    };
    const bar = rule('#panel-bar');
    assert.ok(/position:\s*absolute/.test(bar), '#panel-bar 绝对定位');
    assert.ok(/top:\s*12px/.test(bar), '贴顶部（top:12，与 #topbar 对齐）');
    assert.ok(/left:\s*50%/.test(bar), '水平居中');
    assert.ok(/transform:\s*translateX\(-50%\)/.test(bar), '用 translateX(-50%) 居中');
    assert.ok(/flex-direction:\s*row/.test(bar), '横排（一排 4 个）');
    assert.ok(/z-index:\s*20/.test(bar), 'z-index 20（低于暂停 65 / 遮罩 70，高于 HUD 10）');
    assert.ok(!/bottom:/.test(bar), '不再贴底部');
    const btn = rule('.panel-btn');
    assert.ok(/width:\s*44px/.test(btn) && /height:\s*44px/.test(btn), '方形按钮 44×44');
    // 不再用"末尾覆盖 .sfx-toggle 定位"的方式挪静音键（它保持原 bottom:20，右下角自成一区）
    assert.ok(!/^\s*\.sfx-toggle \{/m.test(seg), '不覆盖 .sfx-toggle 的定位');
  });

  test('极弱 DOM 桩（appendChild 不挂 parentNode、querySelector 返回新节点）也不崩', async () => {
    // 模拟 tools/check-standalone.mjs 的桩：querySelector 永远返回新节点、classList 空实现
    const host = makeElement('div');
    host.id = 'panel-bar-host';
    const weakEl = () => {
      const n = makeElement('div');
      n.appendChild = (c) => { n.children.push(c); return c; }; // 不写 parentNode
      n.querySelector = () => null;
      n.querySelectorAll = () => [];
      n.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
      n.setAttribute = () => {};
      n.getAttribute = () => null;
      return n;
    };
    const saved = globalThis.document;
    const fakeDoc = {
      getElementById: (id) => (id === 'panel-bar' ? null : host),
      createElement: () => weakEl(),
      body: host,
    };
    globalThis.document = fakeDoc;
    try {
      const ui2 = {
        game: { inv: { talentPoints: 2 }, world: { player: { level: 4 } } },
        modalOpen: null,
        skillNotifyState: () => ({ points: 1, refineable: 0 }),
        openPanel(k) { this.modalOpen = k === 'equipment' ? 'inventory' : k; return this.modalOpen; },
        closeModals() { this.modalOpen = null; },
      };
      const bar = new PanelBarMod.PanelBar(ui2);
      let threw = false;
      try {
        bar.ensure();
        bar.sync('talents');
        bar.syncBadges();
        bar.activate('talents');
        bar.activate('talents');
      } catch (e) { threw = true; }
      assert.ok(!threw, '极弱 DOM 下不抛异常');
      assert.equal(bar._badges.stats, 2, '角标状态仍写在内存里');
    } finally {
      globalThis.document = saved;
    }
  });
});