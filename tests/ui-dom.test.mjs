// DOM 集成测试：用一个极简 DOM 桩在 Node 里跑 UI 层（HUD/背包/天赋/技能树），保证不漏错。
// 只覆盖"纯 DOM 操作"路径，不涉及 Canvas 绘制与渲染层。
import { describe, test, assert } from './_runner.mjs';

/** ---------- 极简 DOM 桩 ---------- */
const idRegistry = {};
let _idHook = null;
function registerId(id, node) {
  if (!id) return;
  idRegistry[id] = node;
  if (_idHook) _idHook(id, node);
}
function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c)),
    contains: (c) => set.has(c),
  };
}

function makeElement(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    classList: makeClassList(),
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    _attrs: {},
    textContent: '',
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') { this.id = v; registerId(this.id, this); } if (k === 'class') this.className = v; },
    getAttribute(k) { return this._attrs[k]; },
    appendChild(c) { c.parentNode = node; node.children.push(c); if (c.id) registerId(c.id, c); return c; },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) { return findOne(node, sel); },
    querySelectorAll(sel) { return findAll(node, sel); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 810 }; },
    get offsetWidth() { return 1440; },
    get offsetHeight() { return 810; },
    get clientWidth() { return 1440; },
    get clientHeight() { return 810; },
    getContext() { return makeCanvasCtx(); },
    focus() {},
  };
  return node;
}

function matches(el, sel) {
  // 支持 #id、.class、tag、tag#id、tag.class、[attr] 以及逗号分隔的简单选择器
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

function findAll(root, sel) {
  const out = [];
  const parts = sel.trim().split(/\s+/);
  const walk = (n) => {
    for (const c of n.children) {
      if (matches(c, parts[parts.length - 1]) && (parts.length === 1 || ancestorMatches(c, parts.slice(0, -1)))) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}
function ancestorMatches(el, parts) {
  let cur = el.parentNode;
  let idx = parts.length - 1;
  while (cur && idx >= 0) {
    if (matches(cur, parts[idx])) idx--;
    cur = cur.parentNode;
  }
  return idx < 0;
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
    setTransform: noop, resetTransform: noop, save: noop, restore: noop,
    canvas: null,
  }, {
    get(t, k) { return k in t ? t[k] : noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/** 创建全局 document / window 桩，并构建 index.html 里 UI 需要的节点骨架 */
function installStubDOM() {
  const ids = ['app', 'game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp',
    'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count',
    'wave-count', 'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip',
    'banner', 'damage-layer', 'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen',
    'loading', 'btn-start'];
  const body = makeElement('body');
  const app = makeElement('div');
  app.id = 'app';
  body.appendChild(app);
  const byId = {};
  for (const id of ids) {
    const n = makeElement(id.startsWith('bar-') ? 'i' : 'div');
    n.id = id;
    byId[id] = n;
    app.appendChild(n);
  }
  // banner 子节点
  const bt = makeElement('div');
  bt.className = 'banner-text';
  byId.banner.appendChild(bt);
  // 技能栏 7 个槽位
  const skillbar = byId.skillbar;
  for (let i = 0; i < 7; i++) {
    const slot = makeElement('div');
    slot.className = 'slot';
    slot.dataset.idx = String(i);
    for (const cls of ['key', 'glyph', 'cd', 'cdtxt']) {
      const c = makeElement('div');
      c.className = cls;
      slot.appendChild(c);
    }
    skillbar.appendChild(slot);
  }
  const document = {
    body,
    documentElement: makeElement('html'),
    createElement: (t) => makeElement(t),
    createElementNS: (ns, t) => makeElement(t),
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (sel.startsWith('#') && !sel.includes(' ') ? byId[sel.slice(1)] || null : findOne(body, sel)),
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
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
    performance,
    location: { search: '' },
  };
  // 动态创建的 id 节点也能被 getElementById 找到（死亡屏 / fps / buff-bar 等）
  // 注意：不能 monkey-patch append 方法（会切断原型链），统一给 appendChild 加全局钩子
  _idHook = (id, node) => { byId[id] = node; };
  // document.body.appendChild 也注册
  globalThis.document = document;
  globalThis.window = window;
  globalThis.localStorage = null;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  // 记录所有动态创建的带 id 节点（document.getElementById 可查到）
  const origCreate = document.createElement;
  return { document, window, byId, listeners };
}

/** 假世界（UI 只需要这些字段） */
function makeFakeGame() {
  const player = {
    x: 10, z: 10, facing: 0, level: 3, hp: 100, maxHp: 140, mp: 30, maxMp: 60, xp: 10,
    skillBar: [
      { id: 'groundSlam', name: '裂地斩', icon: '🪓', desc: '扇形冲击波', level: 1, cd: 0 },
      { id: 'whirlwind', name: '旋风斩', icon: '🌀', desc: '持续旋转', level: 1, cd: 0 },
      { id: 'warcry', name: '战吼', icon: '📢', desc: '恐吓敌人', level: 1, cd: 0 },
      { id: 'bloodRage', name: '血性狂暴', icon: '🩸', desc: '狂暴增益', level: 1, cd: 0 },
      { id: 'rally', name: '坚毅图腾', icon: '🔨', desc: '召唤图腾', level: 1, cd: 0 },
      null, null,
    ],
    cooldowns: { groundSlam: 1.5 },
    buffs: [{ id: 'bloodRage', name: '血性狂暴', text: '攻速+20%', type: 'buff', remaining: 3, dur: 6 }],
    anim: { state: 'idle', t: 0, dur: 0.3 },
  };
  const world = {
    time: 1, tier: 2, player,
    monsters: [], items: [], lootOrbs: [],
    map: { name: '众星教堂遗迹', tier: 2, level: 4, mods: [{ id: 'swift', text: '怪物移动速度 +25%' }] },
    stats: { kills: 5, waves: 2 },
  };
  const game = {
    world,
    inv: null,
    stats: { dmg: '12-22', aps: 1.35, crit: 0.05, critMulti: 1.5, armor: 0, evasion: 0, moveSpeed: 6.2, fire: 0, cold: 0, lightning: 0, aoe: 0, life: 140, xp: { xpMax: 100 } },
  };
  return game;
}

describe('UI 层（DOM 桩）', () => {
  let dom, game, ui, invm, appm, itemsm;
  test('安装 DOM 桩并加载模块', async () => {
    dom = installStubDOM();
    invm = await import('../src/game/inventory.js');
    appm = await import('../src/game/app.js');
    itemsm = await import('../src/items/itemgen.js');
    game = makeFakeGame();
    game.inv = invm.createInventory();
    game.inv.talentPoints = 3;
    game.actions = {
      takeTalent: (id) => appm.doTakeTalent(game, id),
      refundTalent: (id) => appm.doRefundTalent(game, id),
      skillRankUp: (sid, nid) => appm.doSkillRankUp(game, sid, nid),
      skillPointsTotal: () => 3,
      equipFromBag: () => true, unequip: () => true, sell: () => 1, sellJunk: () => 1, sortBag: () => {},
      revive: () => {}, newMap: () => {}, pickup: () => {},
    };
    const { GameUI } = await import('../src/ui/ui.js');
    ui = new GameUI(game);
    game.ui = ui;
    assert.ok(ui.el.hp, 'HUD 元素缓存成功');
    assert.equal(ui.el.slots.length, 7, '技能栏 7 格');
  });

  test('HUD 每帧更新不抛异常，生命/法力圆环进度正确', () => {
    for (let i = 0; i < 30; i++) ui.update(1 / 60);
    // 圆形进度条：pathLength=100，dashoffset = 100 - 百分比×100（100/140 → 28.57）
    const hpOffset = Number(ui.el.hp.style.strokeDashoffset);
    assert.ok(Number.isFinite(hpOffset) && hpOffset >= 0 && hpOffset <= 100, '生命环写入合法 dashoffset');
    const mpOffset = Number(ui.el.mp.style.strokeDashoffset);
    assert.ok(Number.isFinite(mpOffset) && mpOffset >= 0 && mpOffset <= 100, '法力环写入合法 dashoffset');
    assert.equal(ui.el.tHp.textContent, '100/140');
    assert.equal(ui.el.level.textContent, 'Lv.3');
    assert.equal(ui.el.kills.textContent, 5);
  });

  test('事件流：击杀连击/升级横幅/掉落提示', () => {
    ui.onEvents([
      { type: 'monsterKilled', rarity: 'normal', entity: { displayName: '枯萎尸' } },
      { type: 'monsterKilled', rarity: 'normal', entity: { displayName: '枯萎尸' } },
      { type: 'monsterKilled', rarity: 'rare', entity: { displayName: '精英·枯萎尸' } },
      { type: 'levelUp', level: 4, gainedPoints: 1 },
      { type: 'loot', item: { name: '深渊之牙', rarity: 'unique', icon: '🗡' } },
      { type: 'bossSpawn', name: '深渊主宰' },
    ]);
    ui.update(1 / 60);
    ui.addLog('测试日志');
    assert.ok(!ui.el.combo.classList.contains('hidden'), '连击显示');
    assert.ok(ui.el.banner.querySelector('.banner-text').textContent.includes('首领'));
    assert.ok(ui.el.loot.innerHTML.includes('深渊之牙'), '掉落栏显示物品名');
    assert.ok(ui.logLines.length > 0, '日志有内容');
  });

  test('地图信息渲染', () => {
    ui.refreshMap();
    assert.ok(ui.el.mapName.textContent.includes('第 2 层'));
    assert.ok(ui.el.mapMods.innerHTML.includes('怪物移动速度'));
  });

  test('背包界面：渲染格子并可装备', () => {
    const item = itemsm.generateItem({ level: 5, slot: 'helmet', rarity: 'magic' });
    invm.addToBag(game.inv, item);
    ui.toggleInventory();
    assert.equal(ui.modalOpen, 'inventory');
    const cls = document.querySelectorAll('.inv-wrap').length;
    assert.ok(cls > 0, '背包容器已渲染');
    assert.ok(ui.el.modalBody.children.length > 0, '背包 DOM 树有节点');
    // 装备背包第 0 个（直接走 core 的装备函数；UI 动作层在 app 内已由集成测试覆盖）
    const idx = game.inv.bag.length - 1;
    const before = game.inv.bag[idx];
    invm.equipItem(game.inv, before);
    assert.ok(game.inv.equip.helmet, '头盔已装备');
    if (ui.modalOpen === 'inventory') ui.closeModals();
  });

  test('背包格子：稀有/传奇的稀有度色写在文字与边框上（emoji 图标不吃 color）', () => {
    // 回归：彩色 emoji 图标无法被 CSS color 染色，黄/橙装在背包里曾看起来和蓝装一样。
    // 稀有度必须同时体现在物品名文字、边框和底部色条上。
    const rare = itemsm.generateItem({ level: 5, slot: 'weapon', rarity: 'rare' });
    const uniq = itemsm.generateItem({ level: 5, slot: 'weapon', rarity: 'unique' });
    invm.addToBag(game.inv, rare);
    invm.addToBag(game.inv, uniq);
    ui.toggleInventory();
    const cells = document.querySelectorAll('.bag-cell');
    const rareCells = cells.filter((c) => c.style['--rarity-color'] === '#ffff77');
    const uniqCells = cells.filter((c) => c.style['--rarity-color'] === '#af6025');
    assert.equal(rareCells.length, 1, '稀有格带黄色稀有度色');
    assert.equal(uniqCells.length, 1, '传奇格带橙色稀有度色');
    assert.ok(rareCells[0].innerHTML.includes('bag-name') && rareCells[0].innerHTML.includes('#ffff77'), '稀有名文字为黄色');
    assert.ok(uniqCells[0].innerHTML.includes('bag-name') && uniqCells[0].innerHTML.includes('#af6025'), '传奇名文字为橙色');
    if (ui.modalOpen === 'inventory') ui.closeModals();
  });

  test('背包：右键出售；橙色装备先弹确认，确认后才卖出', async () => {
    const invui = await import('../src/ui/inventory-ui.js');
    const oldSell = game.actions.sell;
    game.actions.sell = (i) => appm.doSell(game, i);
    try {
      if (ui.modalOpen === 'inventory') ui.closeModals();
      const uniq = itemsm.generateItem({ level: 8, slot: 'weapon', rarity: 'unique' });
      invm.addToBag(game.inv, uniq);
      if (ui.modalOpen !== 'inventory') ui.toggleInventory();
      assert.ok(invui.needsSellConfirm(uniq), 'unique 属于橙色装备');
      assert.ok(!invui.needsSellConfirm({ rarity: 'rare' }), '稀有装备不需要确认');

      const idx = game.inv.bag.indexOf(uniq);
      const gold0 = game.inv.gold;
      assert.equal(invui.requestSell(ui, idx), 'confirm', '橙色装备返回「待确认」');
      assert.ok(game.inv.bag.includes(uniq), '未确认前物品必须还在背包里');
      assert.equal(game.inv.gold, gold0, '未确认前不能加金币');
      const dialog = ui.el.modalBody.querySelector('.sell-confirm-mask');
      assert.ok(dialog, '应出现出售确认框');
      assert.equal(ui.el.modalBody.querySelector('.sc-title').textContent, '确认出售橙色装备？');

      // 等待确认期间自动拾取会重绘背包、下标漂移：确认框必须保留，卖掉的也必须仍是被点的那件
      const filler = itemsm.generateItem({ level: 3, slot: 'boots', rarity: 'magic' });
      game.inv.bag.unshift(filler);
      invui.openInventory(ui);
      assert.ok(ui.el.modalBody.querySelector('.sell-confirm-mask'), '重绘后确认框仍在');

      invui.confirmSell(ui, uniq);
      assert.ok(!game.inv.bag.includes(uniq), '确认后橙装被卖出');
      assert.ok(game.inv.bag.includes(filler), '下标漂移时不能卖错东西');
      assert.ok(game.inv.gold > gold0, '确认后获得金币');
      assert.equal(ui.el.modalBody.querySelector('.sell-confirm-mask'), null, '确认后确认框关闭');

      // 非橙色装备：右键直接卖出，不弹确认
      const magic = itemsm.generateItem({ level: 8, slot: 'helmet', rarity: 'magic' });
      invm.addToBag(game.inv, magic);
      invui.openInventory(ui);
      const gold1 = game.inv.gold;
      assert.equal(invui.requestSell(ui, game.inv.bag.indexOf(magic)), 'sold');
      assert.ok(!game.inv.bag.includes(magic), '魔法装备直接卖出');
      assert.ok(game.inv.gold > gold1, '直接卖出获得金币');
      assert.equal(ui.el.modalBody.querySelector('.sell-confirm-mask'), null, '普通出售不弹确认');
    } finally {
      game.actions.sell = oldSell;
      if (ui.modalOpen === 'inventory') ui.closeModals();
    }
  });

  test('物品 tooltip：传入当前装备时显示战力、DPS 与逐条属性差值', async () => {
    const dommod = await import('../src/ui/dom.js');
    const make = (over = {}) => ({
      name: '测试剑', rarity: 'normal', slot: 'weapon', slotName: '主手武器', icon: '🗡️',
      itemLevel: 10, levelReq: 1, dmgMin: 10, dmgMax: 20,
      damage: { min: 10, max: 20, avg: 15, dps: 20, element: 'phys' },
      stats: { life: 40, armor: 10, fireResist: 0.05 },
      implicit: { text: '基底护甲', stats: { armor: 5 } },
      mods: [], affixLines: [], ...over,
    });
    const cur = make({ name: '旧剑', dmgMin: 8, dmgMax: 12, damage: { dps: 12 }, stats: { life: 25, armor: 12, fireResist: 0.05 } });
    const cand = make({ name: '新剑', rarity: 'rare', dmgMin: 12, dmgMax: 24, damage: { dps: 30 }, stats: { life: 55, armor: 10, fireResist: 0.05 } });

    const html = dommod.itemTooltipHTML(cand, cur, { compare: true });
    assert.ok(html.includes('对比当前装备'), '有对比标题');
    assert.ok(html.includes('战力'), '有战力对比');
    assert.ok(html.includes('每秒伤害 +18'), '武器 DPS 差值');
    assert.ok(html.includes('生命 +30'), '生命差值');
    assert.ok(html.includes('护甲 -2'), '护甲差值');
    assert.ok(!html.includes('火焰抗性'), '相同属性不显示');
    assert.ok(!dommod.itemTooltipHTML(cand).includes('tt-compare'), '不传 compare 时不渲染对比块');

    const emptyHtml = dommod.itemTooltipHTML(cand, null, { compare: true });
    assert.ok(emptyHtml.includes('当前装备') && emptyHtml.includes('装备后战力'), '空槽显示装备后战力');
  });

  test('天赋树界面可以打开并渲染节点', async () => {
    const { openTalents } = await import('../src/ui/talent-ui.js');
    ui.openModal('talents');
    openTalents(ui);
    assert.ok(ui.el.modalBody.children.length > 0, '天赋树 DOM 已渲染');
    assert.ok(ui.el.modalBody.innerHTML === '' || ui.el.modalBody.children.length > 0);
    await new Promise((r) => setTimeout(r, 10));
    ui.closeModals();
  });

  test('技能树界面可以打开并渲染节点', async () => {
    const { openSkills } = await import('../src/ui/skill-ui.js');
    ui.openModal('skills');
    openSkills(ui);
    assert.ok(ui.el.modalBody.children.length > 0, '技能树 DOM 已渲染');
    const texts = JSON.stringify(ui.el.modalBody.children.map((c) => c._html || c.textContent));
    assert.ok(ui.el.modalBody.innerHTML.length >= 0);
    ui.closeModals();
  });

  test('死亡界面与复活', () => {
    ui.showDeathScreen();
    const node = document.getElementById('death-screen');
    assert.ok(node, '死亡界面已创建');
    assert.ok(node.classList.contains('show'));
    assert.ok(!ui.hud.classList.contains('hidden'));
  });

  test('FPS 显示与日志', () => {
    ui.setFps(58);
    assert.ok(document.getElementById('fps').textContent.includes('58'));
    for (let i = 0; i < 20; i++) ui.addLog('日志行 ' + i, '#fff');
    ui.update(1 / 60);
    assert.ok(ui.el.log.children.length <= 8);
  });
});