// @file tests/stats-ui.test.mjs
// 属性面板（src/ui/stats-ui.js）测试。
//
// 覆盖两个层面：
//   1. 纯逻辑层：decomposeStat / collectStatsData 对真实 createGame() 的 6 个关键属性做
//      「基础 + 装备 + 天赋 + 技能 + 增益 = 总计」恒等式校验（误差 ≤ 1e-6），并要求拆解里
//      出现真实来源（点过天赋 / 装过装备后，对应来源必须非 0 —— 证明不是硬编码）。
//   2. DOM 层：在极简 DOM 桩里调用 openStats(ui)，校验分区标题、属性文本、
//      抗性金色/红色着色、点击行展开/收起、10 个装备槽位、悬停 tooltip、以及
//      「数据全缺失也不抛异常」的降级路径。
//
// 注意：本文件不修改 src/ui/ui.js / inventory-ui.js（并行开发契约），
// 只依赖 openStats(ui) 约定：调用方已调 ui.openModal('stats')，openStats 只填内容。
import { describe, test, assert } from './_runner.mjs';

// ---------------------------------------------------------------------------
// 极简 DOM 桩（与 tests/_skillhelpers.mjs 的桩同构，但本文件独立（不共享全局），
// 且 ui-dom.test.mjs 可能已经装过全局 window：这里用「属性存在才覆盖」的方式安装，
// 避免把别的套件的桩顶掉导致它们失败）
// ---------------------------------------------------------------------------
function makeClassList(node) {
  const read = () => new Set(String(node.className || '').split(/\s+/).filter(Boolean));
  return {
    add: (...c) => { const s = read(); c.forEach((x) => s.add(x)); node.className = [...s].join(' '); },
    remove: (...c) => { const s = read(); c.forEach((x) => s.delete(x)); node.className = [...s].join(' '); },
    toggle: (c, on) => {
      const s = read();
      const want = on === undefined ? !s.has(c) : !!on;
      if (want) s.add(c); else s.delete(c);
      node.className = [...s].join(' ');
      return want;
    },
    contains: (c) => read().has(c),
  };
}

function makeElement(tag = 'div') {
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
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    get textContent() { return ownText + node.children.map((c) => (c && c.textContent) || '').join(''); },
    set textContent(v) { ownText = v == null ? '' : String(v); node.children = []; node._text = ownText; },
    setAttribute(k, v) { node._attrs[k] = v; if (k === 'id') node.id = v; if (k === 'class') node.className = v; },
    getAttribute(k) { return node._attrs[k]; },
    appendChild(c) { if (!c) return c; c.parentNode = node; node.children.push(c); return c; },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    addEventListener(t, fn) { (node._listeners[t] = node._listeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev = {}) { for (const fn of node._listeners[t] || []) fn({ target: node, preventDefault() {}, stopPropagation() {}, ...ev }); },
    click() { node.dispatch('click'); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1440, height: 810 }; },
    focus() {},
  };
  node.classList = makeClassList(node);
  return node;
}

/** 本套件专用的桩（不写 document.getElementById 的全局行为，只用于 el() 创建节点） */
function installLocalDOM() {
  const root = makeElement('div');
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const doc = {
    body: makeElement('body'),
    createElement: (t) => makeElement(t),
    createElementNS: (ns, t) => makeElement(t),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = doc;
  if (!globalThis.window) globalThis.window = { document: doc, innerWidth: 1440, innerHeight: 810, addEventListener() {} };
  return {
    root,
    restore() {
      globalThis.document = prevDoc;
      if (prevWin === undefined) delete globalThis.window;
      else globalThis.window = prevWin;
    },
  };
}

/** 深搜（桩里没有 querySelector 的子树查找能力，自己写一个） */
function walk(node, out = []) {
  for (const c of node.children || []) { out.push(c); walk(c, out); }
  return out;
}
function byClass(root, cls) {
  return walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(cls));
}
function allText(root) {
  // 每个节点既可能有 _html（字符串拼的），也可能有 textContent（(el({text}))：
  // 两者都收（后者由桩的 getter 拼上后代），重复无害 —— 断言只做 includes。
  return walk(root).map((n) => (
    (n._html ? String(n._html).replace(/<[^>]*>/g, ' ') : '') + ' ' +
    (typeof n._text === 'string' ? n._text : '')
  )).join(' ');
}

/** 精确读一个节点自己的文本（不含后代；桩里 el({text}) 走 textContent setter） */
function ownText(node) {
  if (!node) return '';
  if (typeof node._text === 'string' && node._text) return node._text;
  return '';
}

/** 节点的完整文本（自己 + 后代；桩的 textContent getter 已按真实 DOM 语义拼接） */
function nodeText(node) {
  if (!node) return '';
  if (typeof node.textContent === 'string') return node.textContent;
  return walk(node).map((n) => n._text || '').join('');
}

/** 假 ui：只需要 el.modalTitle / el.modalBody / el.modalFoot + tooltip + closeModals */
function makeUI(game) {
  const nodes = { modalTitle: makeElement('h2'), modalBody: makeElement('div'), modalFoot: makeElement('div') };
  const calls = { tooltip: [], closed: 0, modal: [] };
  const ui = {
    game,
    modalOpen: null,
    el: { modal: makeElement('div'), ...nodes },
    openModal(kind) { this.modalOpen = kind; calls.modal.push(kind); },
    closeModals() { this.modalOpen = null; calls.closed++; },
    showTooltip(html, x, y) { calls.tooltip.push({ html, x, y }); },
    hideTooltip() { calls.tooltip.push({ html: null }); },
    calls,
  };
  return ui;
}

const KEYS = ['life', 'armor', 'evasion', 'critChance', 'moveSpeedMult', 'fireResist'];

describe('属性面板（纯逻辑：来源拆解）', () => {
  let statsUI, appMod, itemsMod, invMod, treeMod, game;

  test('加载模块 + 真实 createGame()', async () => {
    statsUI = await import('../src/ui/stats-ui.js');
    appMod = await import('../src/game/app.js');
    itemsMod = await import('../src/items/itemgen.js');
    invMod = await import('../src/game/inventory.js');
    treeMod = await import('../src/items/talentTree.js');
    assert.equal(typeof statsUI.openStats, 'function', '必须导出 openStats(ui)');
    game = appMod.createGame({ seed: 20261114 });
    assert.ok(game.world.player.stats, '真实玩家有核心属性');
  });

  test('新角色：6 个属性的拆解之和 == 总值（±1e-6）', () => {
    const d = statsUI.collectStatsData(makeUI(game));
    for (const key of KEYS) {
      const dc = statsUI.decomposeStat(d.layers, key, d.stats[key]);
      const sum = dc.parts.reduce((a, p) => a + p.value, 0);
      assert.ok(Math.abs(sum - dc.total) <= 1e-6, `${key}: 拆解和 ${sum} != 总值 ${dc.total}`);
      assert.ok(Math.abs(sum + dc.residual - dc.total) <= 1e-6, `${key}: 总和+差值 == 总值`);
    }
  });

  test('点天赋 / 装备 / 增益后：拆解仍然恒等，且来源来自真实数据', () => {
    const p = game.world.player;
    const inv = game.inv;
    // 1) 点 3 个真实存在的天赋（铁壁 +30 护甲、厚皮 +60 护甲、幻影 +10% 闪避、疾影 +6% 闪避）
    for (const id of ['forge-hub', 'forge-stem2', 'fate-stem2', 'fate-armR']) {
      const node = treeMod.talentById(id);
      assert.ok(node, '天赋节点存在：' + id);
      if (!inv.talents.includes(id)) inv.talents.push(id);
    }
    inv.talentPoints = 0;
    // 2) 换一件带抗性/生命的装备（直接用 itemgen 造一件手套）
    const glove = itemsMod.generateItem({ seed: 5, level: 8, slot: 'gloves', rarity: 'rare' });
    if (glove) invMod.equipItem(inv, glove);
    game.recalcPlayer();
    // 3) 一个带属性的 buff（模拟战吼/战争践踏护甲）
    p.buffs = [{ id: 'warStompArmor', name: '踏地护甲', stats: { armor: 37 }, remaining: 3, dur: 4 }];
    game.recalcPlayer();

    const d = statsUI.collectStatsData(makeUI(game));
    for (const key of KEYS) {
      const dc = statsUI.decomposeStat(d.layers, key, d.stats[key]);
      const sum = dc.parts.reduce((a, x) => a + x.value, 0);
      assert.ok(Math.abs(sum - dc.total) <= 1e-6, `${key}: 拆解和 ${sum} != 总值 ${dc.total}`);
    }
    // 护甲：天赋与 buff 层都必须真的有贡献（证明拆解读的是真实分层，不是硬编码）
    const armor = statsUI.decomposeStat(d.layers, 'armor', d.stats.armor);
    const byKey = Object.fromEntries(armor.parts.map((x) => [x.key, x.value]));
    assert.ok(byKey.talent > 0, '护甲的天赋来源必须 > 0（铁壁 30 + 厚皮 60），实际 ' + byKey.talent);
    assert.ok(byKey.buff > 0, '护甲的增益来源必须 > 0，实际 ' + byKey.buff);
    assert.ok(armor.total > 0, '护甲总值 > 0');
    // 闪避：天赋层必须贡献（幻影 10% + 疾影 6%）
    const eva = statsUI.decomposeStat(d.layers, 'evasion', d.stats.evasion);
    const evaTalent = eva.parts.find((x) => x.key === 'talent').value;
    assert.ok(evaTalent > 0, '闪避的天赋来源必须 > 0，实际 ' + evaTalent);
  });

  test('上限截断 / 默认值兜底会体现在「差值」而不是丢失', async () => {
    // 人为把火焰抗性堆到远超上限（核心会截断到 maxResistance），差值应 ≈ 超出部分（负数）
    const layers = {
      base: { maxResistance: 0.75 },
      equip: { fireResist: 1.2 },
      talent: { fireResist: 0.4 },
      skill: null,
      buff: null,
    };
    const { aggregateStats } = await import('../src/core/stats.js');
    const final = aggregateStats([layers.base, layers.equip, layers.talent]).fireResist;
    assert.ok(Math.abs(final - 0.75) < 1e-9, '抗性被截断到 75%，实际 ' + final);
    const dc = statsUI.decomposeStat(layers, 'fireResist', final);
    const sum = dc.parts.reduce((a, p) => a + p.value, 0);
    assert.ok(Math.abs(sum + dc.residual - dc.total) <= 1e-9);
    assert.ok(dc.residual < -1e-6, '差值应为负（上限截断），实际 ' + dc.residual);
    // 来源不全：skill 层整个不存在（= engine 层字段还没接上）必须被标注；
    // buff 层不存在但抗性的基础来源已经给出真实数值（0%）→ 不要求标注
    assert.ok(dc.missing.includes('技能'), '缺失的整层要被标注：' + dc.missing.join(','));
  });

  test('有默认值的属性（暴击率）在其它层"没有贡献"时标注来源不全', () => {
    // 暴击率默认 0.05：装备层里没有任何 critChance →
    // 基础 5% + 装备 0% + 天赋 0% = 5% 虽然等式成立，但「装备/天赋」其实只是"没给"，要标来源不全
    const layers = { base: { critChance: 0.05 }, equip: { armor: 10 }, talent: {}, skill: {} };
    const final = 0.05 + 0.03; // 假设最终被别的路径抬到了 8%
    const dc = statsUI.decomposeStat(layers, 'critChance', final);
    const sum = dc.parts.reduce((a, p) => a + p.value, 0);
    assert.ok(Math.abs(sum + dc.residual - dc.total) <= 1e-9, '恒等式仍成立');
    assert.ok(dc.missing.includes('装备') && dc.missing.includes('天赋'), '零贡献的层要标来源不全：' + dc.missing.join(','));
    assert.ok(dc.residual > 1e-6, '多出来的那部分记为差值（来源不明），而不是被丢进某一层');
    // 没有默认值的属性（生命）不因"0 贡献"误报
    const life = statsUI.decomposeStat({ base: { life: 120 }, equip: {}, talent: {}, skill: {} }, 'life', 120);
    assert.deepEqual(life.missing, [], '生命没有默认值，装备/天赋 0 贡献不算缺失');
  });
});

describe('属性面板（DOM 桩）', () => {
  let statsUI, appMod, itemsMod, invMod, dom, ui, game;

  test('安装桩 + 打开面板', async () => {
    statsUI = await import('../src/ui/stats-ui.js');
    appMod = await import('../src/game/app.js');
    itemsMod = await import('../src/items/itemgen.js');
    invMod = await import('../src/game/inventory.js');
    dom = installLocalDOM();
    game = appMod.createGame({ seed: 99 });
    // 造一点真实数据：天赋（抗性 + 护甲）+ 金币/石头
    const tree = await import('../src/items/talentTree.js');
    game.inv.talents.push('ring-in-1', 'forge-hub', 'forge-armR'); // 淬火(+6% 火抗)、铁壁(+30 护甲)、钢铁之躯(+100 护甲)
    assert.ok(tree.talentById('ring-in-1'));
    assert.ok(tree.talentById('forge-armR'));
    const ring = itemsMod.generateItem({ seed: 3, level: 10, slot: 'ring', rarity: 'unique' });
    if (ring) invMod.equipItem(game.inv, ring);
    game.inv.gold = 1234;
    game.inv.skillOrbs = 7;
    game.recalcPlayer();
    assert.ok(game.world.player.stats.armor > 0, '铁壁 / 钢铁之躯提供护甲（拆解行要有非零来源）');

    ui = makeUI(game);
    ui.openModal('stats'); // 调用方负责（契约）
    statsUI.openStats(ui);
  });

  test('标题 / 底部按钮 / 六个分区都在', () => {
    assert.equal(ui.el.modalTitle.textContent, '属性面板');
    const body = ui.el.modalBody;
    assert.ok(body.children.length > 0, '面板有内容');
    const text = allText(body);
    for (const t of ['概要', '攻击', '防御', '抗性', '资源', '已装备']) {
      assert.ok(text.includes(t), '缺少分区：' + t);
    }
    assert.equal(ui.el.modalFoot.children.length, 1, '底部有一个关闭按钮');
    ui.el.modalFoot.children[0].click();
    assert.equal(ui.calls.closed, 1, '关闭按钮会调用 ui.closeModals()');
  });

  test('关键属性文本存在（生命当前/最大、攻速、暴击、抗性百分比）', () => {
    const p = game.world.player;
    const text = allText(ui.el.modalBody);
    assert.ok(text.includes('生命'), '有生命行');
    assert.ok(text.includes(`${Math.round(p.hp)} / ${Math.round(p.maxHp)}`), '生命显示 当前 / 最大');
    assert.ok(text.includes(`${Math.round(p.mp)} / ${Math.round(p.maxMp)}`), '法力显示 当前 / 最大');
    assert.ok(text.includes('攻击速度'), '有攻速行');
    assert.ok(text.includes('暴击率'), '有暴击行');
    assert.ok(text.includes('火焰抗性'), '有火抗行');
    assert.ok(/\d+%/.test(text), '数值带 %');
    // 经验进度条：宽度是百分比字符串
    const bars = byClass(ui.el.modalBody, 'stp-bar');
    assert.ok(bars.length >= 3, '至少 生命/法力/经验 三条进度条，实际 ' + bars.length);
    const widths = bars.map((b) => b.children[0] && b.children[0].style.width);
    assert.ok(widths.every((w) => typeof w === 'string' && w.endsWith('%')), '进度条宽度是百分比：' + widths.join(','));
  });

  test('点击属性行展开来源拆解，再点收起', () => {
    const rows = byClass(ui.el.modalBody, 'stp-row').filter((r) => String(r.className).split(/\s+/).includes('has-src'));
    // 生命/法力/移速/武器伤害/攻速/暴击/暴击伤害/护甲/闪避/格挡/四抗 = 至少 14 行
    assert.ok(rows.length >= 6, '可展开的行至少 6 个，实际 ' + rows.length);
    // 选一个来源确定的行：护甲（石化之躯 +200 护甲，天赋来源非零）
    const target = rows.find((r) => r.textContent.includes('护甲'));
    assert.ok(target, '找到护甲行');
    const src = byClass(target.parentNode, 'stp-src')[0];
    assert.ok(src, '护甲行有拆解容器');
    assert.ok(!String(src.className).includes('open'), '默认收起');
    target.click();
    assert.ok(String(src.className).includes('open'), '点击后展开');
    const parsed = parseSrc(src.innerHTML);
    assert.ok(parsed, '拆解文本可解析：' + src.innerHTML);
    const { parts, total } = parsed;
    const sum = parts.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - total) <= 1e-2, `DOM 里「基础+装备+天赋+技能+增益」(${sum}) 应等于总计(${total})`);
    assert.ok(parts.some((v) => Math.abs(v) > 1e-6), '拆解里至少有一个非零来源');
    // 拆解里的总计必须等于面板上的最终值（护甲 = 天赋 +200）
    assert.ok(Math.abs(total - game.world.player.stats.armor) <= 1e-2, `总计 ${total} 应等于最终护甲 ${game.world.player.stats.armor}`);
    assert.ok(src.innerHTML.includes('总计'), '有「总计」标注');
    assert.ok(src.innerHTML.includes('天赋'), '护甲来源里出现「天赋」');
    target.click();
    assert.ok(!String(src.className).includes('open'), '再点收起');
  });

  test('抗性 ≥ 上限显示金色，负数显示红色', () => {
    const rows = byClass(ui.el.modalBody, 'stp-row');
    const fireRow = rows.find((r) => r.textContent.includes('火焰抗性'));
    assert.ok(fireRow, '有火抗行');
    // 灰烬行者 +10% 火抗 → 不到上限 → 不应是金色
    assert.ok(!String(fireRow.className).includes('tone-gold'), '10% 火抗不应显示金色');
    // 满抗：雷电之肤 +15% 远不到上限，用一件高热抗装备把火抗垫到 75% 上限
    const p = game.world.player;
    const realStats = p.stats;
    const realEquip = p.equipStats;
    p.stats = { ...realStats, fireResist: p.stats.maxResistance };
    p.equipStats = { ...realEquip, fireResist: 10 };
    statsUI.openStats(ui);
    const fireRow2 = byClass(ui.el.modalBody, 'stp-row').find((r) => r.textContent.includes('火焰抗性'));
    assert.ok(String(fireRow2.className).includes('tone-gold'), '满抗（75%）显示金色，实际 ' + fireRow2.textContent);
    // 负抗：混沌抗 -30%
    p.stats = { ...realStats, chaosResist: -0.3 };
    p.equipStats = { ...realEquip, chaosResist: -0.3 };
    statsUI.openStats(ui);
    const chaosRow = byClass(ui.el.modalBody, 'stp-row').find((r) => r.textContent.includes('混沌抗性'));
    assert.ok(String(chaosRow.className).includes('tone-red'), '负抗显示红色');
    assert.ok(chaosRow.textContent.includes('-30%') || chaosRow.textContent.includes('−30%'), '负抗数值为负：' + chaosRow.textContent);
    // 还原，后面的用例（已装备/资源）不受影响
    p.stats = realStats;
    p.equipStats = realEquip;
    statsUI.openStats(ui);
  });

  test('已装备：10 个槽位，稀有度着色，悬停出完整 tooltip', () => {
    const slots = byClass(ui.el.modalBody, 'stp-slot');
    assert.equal(slots.length, 10, '10 个槽位小卡片，实际 ' + slots.length);
    const filled = slots.filter((s) => String(s.className).includes('filled'));
    assert.ok(filled.length >= 1, '至少有一个已装备物品');
    const weapon = slots.find((s) => s.getAttribute('data-slot') === 'weapon');
    assert.ok(String(weapon.className).includes('filled'), '新手武器已装备');
    // 名称按稀有度着色（普通 = #c8c8c8）
    const nameEl = byClass(weapon, 'stp-slot-name')[0];
    assert.ok(nameEl && nameEl.style.color, '名称有稀有度颜色');
    assert.equal(String(nameEl.textContent), String(game.inv.equip.weapon.name));
    // 悬停 → ui.showTooltip(itemTooltipHTML(item))
    const before = ui.calls.tooltip.length;
    weapon.dispatch('mouseenter', { clientX: 100, clientY: 200 });
    const tip = ui.calls.tooltip[ui.calls.tooltip.length - 1];
    assert.ok(ui.calls.tooltip.length > before, '悬停触发了 tooltip');
    assert.ok(tip.html && tip.html.includes('item-tooltip'), 'tooltip 是完整物品卡：' + String(tip.html).slice(0, 80));
    assert.ok(tip.html.includes(game.inv.equip.weapon.name), 'tooltip 含物品名');
    weapon.dispatch('mouseleave', {});
    assert.equal(ui.calls.tooltip[ui.calls.tooltip.length - 1].html, null, '离开时隐藏 tooltip');
  });

  test('资源分区：天赋点 / 技能点 / 精炼石 / 金币', () => {
    const text = allText(ui.el.modalBody);
    assert.ok(text.includes('天赋点'), '有天赋点');
    assert.ok(text.includes('技能点'), '有技能点');
    assert.ok(text.includes('技能精炼石'), '有精炼石');
    assert.ok(text.includes('1234'), '金币显示 1234：' + text.slice(0, 0));
    assert.ok(text.includes('◆ 7'), '精炼石显示 ◆ 7');
  });

  test('数据缺失也不能抛异常（降级路径）', async () => {
    const broken = [
      { game: null, el: makeElement('div') },
      { game: {}, el: { modalTitle: makeElement('h2'), modalBody: makeElement('div'), modalFoot: makeElement('div') } },
      { game: { world: {}, inv: null, stats: null }, el: { modalTitle: makeElement('h2'), modalBody: makeElement('div') } },
      { game: { world: { player: { level: 'x', stats: null } } }, el: { modalTitle: makeElement('h2'), modalBody: makeElement('div'), modalFoot: null } },
      null,
      { el: null },
    ];
    for (const u of broken) {
      let threw = null;
      try { statsUI.openStats(u); } catch (e) { threw = e; }
      assert.equal(threw, null, 'openStats 不应抛异常：' + (threw && threw.message));
    }
    // 完全正常的 game 但 world.player.stats 被清空（core 还没跑）：要能现场预演，不能空白
    const g2 = appMod.createGame({ seed: 5 });
    delete g2.world.player.stats;
    const ui2 = makeUI(g2);
    statsUI.openStats(ui2);
    assert.ok(allText(ui2.el.modalBody).includes('生命'), 'player.stats 缺失时用分层预演兜底');
  });

  test('最小化 EL 桩（appendChild/querySelector 都是假值）也不崩', () => {
    const fakeEl = {
      id: '', className: '', style: {},
      set innerHTML(v) { this._h = v; },
      get innerHTML() { return this._h || ''; },
      set textContent(v) { this._t = v; },
      get textContent() { return this._t || ''; },
      appendChild(c) { return c; },
      querySelector() { return undefined; },
      querySelectorAll() { return undefined; },
      addEventListener() {},
      classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
      setAttribute() {}, getAttribute() { return undefined; },
    };
    const tinyUI = { game, el: { modal: fakeEl, modalTitle: { textContent: '' }, modalBody: fakeEl, modalFoot: fakeEl } };
    let threw = null;
    try { statsUI.openStats(tinyUI); } catch (e) { threw = e; }
    assert.equal(threw, null, '极简 EL 桩下不抛异常：' + (threw && threw.message));
  });

  test('恢复全局 DOM 桩（不影响其他测试套件）', () => {
    dom.restore();
    assert.ok(true);
  });
});

/**
 * 从拆解 HTML 里解析出「各来源数值 + 总计」，用于验证 Σ来源 == 总计。
 * 结构：<span class="stp-seg"><em>基础</em><b>120</b></span>
 *       <span class="stp-seg"><em>装备</em><b><i>+</i>40</b></span> … <span class="stp-seg stp-total">…<b>240</b></span>
 * 注意：允许文本里有 "·0" 之类的尾随内容（圆整），所以用宽松的数字提取。
 * @param {string} html
 * @returns {{parts:number[], total:number}|null}
 */
export function parseSrc(html) {
  const str = String(html || '');
  const segs = str.match(/<span class="stp-seg[^"]*">[\s\S]*?<\/span>/g);
  if (!segs) return null;
  const parts = [];
  let total = null;
  for (const seg of segs) {
    const isTotal = seg.includes('stp-total');
    const label = (seg.match(/<em>([^<]*)<\/em>/) || [])[1] || '';
    const body = seg.replace(/<em>[\s\S]*?<\/em>/, '');
    const neg = body.includes('−') || body.includes('>-</i>');
    const numMatch = body.match(/-?\d+(?:\.\d+)?/);
    if (!numMatch) continue;
    const v = Number(numMatch[0]) * (neg && !numMatch[0].startsWith('-') ? -1 : 1);
    if (isTotal || label === '总计') total = Math.abs(v);
    else parts.push(v);
  }
  if (total == null) return null;
  return { parts, total };
}