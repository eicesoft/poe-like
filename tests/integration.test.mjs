// @file tests/integration.test.mjs
// 端到端集成测试：用 src/game/app.js 的真实 updateGame 驱动整条玩法闭环。
// 目标是「快而稳」：全套 < 8 秒，不依赖渲染 / DOM，不依赖随机地图的运气。
//
// 覆盖：
//   1. 冒烟：createGame 后 world/dungeon/player/inv 就绪，跑 10 秒 updateGame 不炸
//   2. 战斗闭环：手动在玩家旁边刷怪 → updateGame 攻击 → 击杀 → 经验/击杀数增长
//   3. 升级：grantXp 大量经验 → 等级、maxHp、天赋点
//   4. 拾取/装备：往 world.items 塞物品 → doPickup → 背包 → doEquipFromBag → stats
//   5. 天赋：doTakeTalent 一个与 start-warrior 相邻的节点
//   6. 切图：travelToNewMap 后 tier 增加、怪物清空、玩家在可走点
//   7. 掉落：杀 100 只怪 → world.items 产出且字段齐全
//   8. 长跑：60 秒 updateGame 无 NaN
//   9. 性能：1000 步 updateGame < 3 秒
//
// 注意：本文件只用 app.js / core 的公开接口，不 mock 内部状态；bot 策略与 tools/playtest.mjs 一致。

import { describe, test, assert } from './_runner.mjs';

const DT = 1 / 60;

// 动态 import：某模块还没写完时整份文件也不会崩，而是给出「模块存在」的断言
const mod = {};
async function loadAll() {
  mod.app = await import('../src/game/app.js');
  mod.core = await import('../src/core/index.js');
  mod.skills = await import('../src/core/skills.js');
  mod.monsters = await import('../src/core/monsters.js');
  mod.progression = await import('../src/core/progression.js');
  mod.loot = await import('../src/core/loot.js');
  mod.spawner = await import('../src/core/spawner.js');
  mod.talents = await import('../src/items/talentTree.js');
  mod.inventory = await import('../src/game/inventory.js');
  mod.itemgen = await import('../src/items/itemgen.js');
  return mod;
}
const M = await loadAll();

/** 建一个干净的游戏，UI 用空实现（headless） */
function newGame(seed = 1234, tier = 1) {
  const game = M.app.createGame({ seed, tier });
  game.ui = {
    onEvents() {},
    toast() {},
    onDeath() {},
    onInventoryChange() {},
    onTalentsChange() {},
    onSkillsChange() {},
    onMapChange() {},
    onRespawn() {},
  };
  return game;
}

/** 一帧空输入 */
function emptyInput() {
  return {
    move: { x: 0, z: 0 },
    aim: { x: 0, z: 0 },
    attackHeld: false,
    attackPressed: false,
    skills: [],
    dash: false,
    releaseChannels: false,
  };
}

/** 推进 n 秒；每帧调 updateGame 并清事件（模拟渲染层） */
function stepSeconds(game, seconds, inputFn) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const input = (inputFn && inputFn(i * DT)) || emptyInput();
    M.app.updateGame(game, DT, input);
    M.app.clearEvents(game.world);
  }
}

/**
 * 机器人一帧：朝目标怪走，进入普攻距离就按住攻击。
 * 与 tools/playtest.mjs 的策略一致（锁定目标 + 刀锋距离），保证测试反映真实手感。
 */
function botInput(game) {
  const world = game.world;
  const p = world.player;
  const input = emptyInput();
  const alive = (world.monsters || []).filter((m) => m && !m.dead && world.isWalkable(m.x, m.z));
  let best = null, bd = Infinity;
  for (const m of alive) {
    const d = Math.hypot(m.x - p.x, m.z - p.z);
    if (d < bd) { bd = d; best = m; }
  }
  if (!best) return input;
  input.aim = { x: best.x, z: best.z };
  const dx = best.x - p.x, dz = best.z - p.z;
  const len = Math.hypot(dx, dz) || 1;
  const blade = (best.radius || 0.45) + (p.radius || 0.45) + 0.35;
  if (bd > 2.0) { input.move.x = dx / len; input.move.z = dz / len; }
  else if (bd < blade) { input.move.x = -dx / len; input.move.z = -dz / len; } // 贴身太近反而打不中扇形
  input.attackHeld = bd <= 2.4 && bd >= blade * 0.85;
  if (bd <= 2.6 && p.mp > p.maxMp * 0.2) input.skills.push('whirlwind');
  return input;
}

// ---------------------------------------------------------------------------
describe('集成 · 冒烟', () => {
  test('createGame 后核心对象就绪', () => {
    const game = newGame();
    const w = game.world;
    assert.ok(w, 'world 存在');
    assert.ok(w.dungeon, 'dungeon 已生成');
    assert.ok(w.dungeon.cols > 0 && w.dungeon.rows > 0, '地牢有尺寸');
    assert.ok(w.player && w.player.kind === 'player', 'player 存在');
    assert.equal(w.player.level, 1, '初始 1 级');
    assert.ok(game.inv && Array.isArray(game.inv.bag), 'inventory 就绪');
    assert.ok(typeof game.recalcPlayer === 'function', 'recalcPlayer 可调用');
    assert.ok(Number.isFinite(w.player.maxHp) && w.player.maxHp > 0, 'maxHp 有限');
    assert.ok(w.isWalkable(w.player.x, w.player.z), '玩家出生点可走');
  });

  test('跑 10 秒 updateGame 不抛异常，且不出 NaN', () => {
    const game = newGame(7);
    const p = game.world.player;
    stepSeconds(game, 10, () => botInput(game));
    assert.ok(Number.isFinite(p.hp) && Number.isFinite(p.maxHp), 'hp 有限');
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), '坐标有限');
    for (const k in p.stats) {
      assert.ok(Number.isFinite(p.stats[k]), `stats.${k} 有限（实际 ${p.stats[k]}）`);
    }
    assert.ok((game.world.monsters || []).length <= 400, '怪物数不超过硬上限');
  });
});

// ---------------------------------------------------------------------------
describe('集成 · 战斗闭环', () => {
  test('刷一只怪 → 用 updateGame 打死 → 经验与击杀数增长', () => {
    const game = newGame(11);
    const world = game.world, p = world.player;
    // 清掉自动刷的怪，避免干扰
    world.monsters.length = 0;
    world.all = world.all.filter((e) => e.kind !== 'monster');
    const killsBefore = botKills(world);
    const xpBefore = p.xp;
    const m = M.monsters.spawnMonster(world, 'husk', p.x + 1.6, p.z, { level: 1 });
    let guard = 0;
    while (!m.dead && guard++ < 60 * 20) {
      const input = botInput(game);
      M.app.updateGame(game, DT, input);
      M.app.clearEvents(world);
    }
    assert.ok(m.dead, `怪应被打死（guard=${guard}）`);
    assert.ok(botKills(world) > killsBefore, 'world.stats.kills 增加');
    assert.ok(p.xp > xpBefore || p.level > 1, '经验增长');
  });

  function botKills(world) {
    return world.stats && world.stats.kills | 0;
  }
});

// ---------------------------------------------------------------------------
describe('集成 · 升级', () => {
  test('grantXp 给足经验 → 等级 / maxHp / 天赋点都上升', () => {
    const game = newGame(13);
    const world = game.world, p = world.player;
    const inv = game.inv;
    const lv0 = p.level, hp0 = p.maxHp;
    const pts0 = (p.talentPoints || 0) + (inv.talentPoints || 0);
    // 直接给够 5 级的经验
    let need = 0;
    for (let lv = 1; lv <= 5; lv++) need += M.progression.xpForLevel(lv);
    world.__grantXp(world, p, need + 1);
    M.app.updateGame(game, DT, emptyInput());
    M.app.clearEvents(world);
    // 天赋点可能记录在 player.talentPoints 或 inv.talentPoints（app 会同步）
    if (world.__syncTalentPoints) world.__syncTalentPoints();
    assert.ok(p.level > lv0, `等级上升（${lv0} → ${p.level}）`);
    assert.ok(p.maxHp > hp0, `maxHp 上升（${hp0} → ${p.maxHp}）`);
    const pts1 = (p.talentPoints || 0) + (inv.talentPoints || 0);
    assert.ok(pts1 > pts0, `天赋点增加（${pts0} → ${pts1}）`);
    assert.ok(Number.isFinite(p.maxHp) && p.maxHp > 0, 'maxHp 有限');
  });
});

// ---------------------------------------------------------------------------
describe('集成 · 拾取与装备', () => {
  test('地上物品 → doPickup → 背包 → doEquipFromBag → 装备槽非空 + stats 变化', () => {
    const game = newGame(17);
    const world = game.world, p = world.player;
    world.items.length = 0;
    const item = M.itemgen.generateItem({ level: 5, slot: 'helmet', rarity: 'rare' });
    assert.ok(item && item.name, 'generateItem 产出有效物品');
    world.items.push({
      id: 'drop-test', x: p.x, z: p.z, item, ttl: 120, born: 0,
      rarity: item.rarity, color: item.color, icon: item.icon, name: item.name,
    });
    const bag0 = game.inv.bag.length;
    const got = M.app.doPickup(game);
    assert.ok(got, 'doPickup 应成功');
    assert.ok(game.inv.bag.length > bag0, '背包增加');
    const armorBefore = p.stats.armor;
    const ok = M.app.doEquipFromBag(game, game.inv.bag.indexOf(item));
    assert.ok(ok, 'doEquipFromBag 应成功');
    assert.ok(game.inv.equip.helmet, 'helmet 槽非空');
    assert.ok(p.stats.armor >= armorBefore, `护甲不下降（${armorBefore} → ${p.stats.armor}）`);
    assert.ok(Number.isFinite(p.stats.armor), '护甲有限');
    assert.ok(!game.inv.bag.includes(item), '装备后离开背包');
  });

  test('自动拾取：稀有/传奇靠近后也会自动入包（不再需要手动 F）', () => {
    const game = newGame(18);
    const world = game.world, p = world.player;
    world.items.length = 0;
    game.inv.bag.length = 0;
    const mkDrop = (rarity, slot) => {
      const item = M.itemgen.generateItem({ level: 5, slot, rarity });
      const drop = {
        id: 'auto-' + rarity, x: p.x, z: p.z, item, ttl: 120, born: 0,
        rarity, color: item.color, icon: item.icon, name: item.name,
      };
      world.items.push(drop);
      return { item, drop };
    };
    const rare = mkDrop('rare', 'helmet');
    const uniq = mkDrop('unique', 'weapon');
    M.app.updateAutoPickup(game);
    assert.ok(game.inv.bag.includes(rare.item), '稀有装备应自动进包');
    assert.ok(game.inv.bag.includes(uniq.item), '传奇装备应自动进包');
    assert.ok(!world.items.includes(rare.drop), '稀有掉落应从地上移除');
    assert.ok(!world.items.includes(uniq.drop), '传奇掉落应从地上移除');
  });
});

// ---------------------------------------------------------------------------
describe('集成 · 自动换装', () => {
  const clearEquip = (inv) => { for (const k in inv.equip) inv.equip[k] = null; inv.bag.length = 0; };

  test('稀有/传奇不会被自动装备，普通/魔法会', () => {
    const game = newGame(21);
    const inv = game.inv;
    clearEquip(inv);
    const rare = M.itemgen.generateItem({ level: 10, slot: 'body', rarity: 'rare' });
    const unique = M.itemgen.generateItem({ level: 10, slot: 'helmet', rarity: 'unique' });
    const normal = M.itemgen.generateItem({ level: 10, slot: 'boots', rarity: 'normal' });
    assert.ok(rare && unique && normal, '物品生成成功');
    inv.bag.push(rare, unique, normal);

    M.app.autoEquipBetter(game);

    assert.ok(inv.bag.includes(rare), '稀有装备应留在背包里（不再被悄悄穿走）');
    assert.ok(inv.bag.includes(unique), '传奇装备应留在背包里');
    assert.ok(!inv.bag.includes(normal), '普通装备应被自动穿上');
    assert.equal(inv.equip.boots, normal);
  });

  test('自动换装替换装备时，旧装备只回背包一份', () => {
    const game = newGame(22);
    const inv = game.inv;
    clearEquip(inv);
    const oldBody = M.itemgen.generateItem({ level: 5, slot: 'body', rarity: 'normal' });
    const better = M.itemgen.generateItem({ level: 30, slot: 'body', rarity: 'magic' });
    inv.equip.body = oldBody;
    inv.bag.push(better);

    M.app.autoEquipBetter(game);

    assert.equal(inv.equip.body, better, '更强装备已穿上');
    assert.equal(inv.bag.filter((i) => i === oldBody).length, 1, '旧装备在背包里只能有一份（曾重复两份）');
  });

  test('手动装备替换装备时，旧装备也只回背包一份', () => {
    const game = newGame(23);
    const inv = game.inv;
    clearEquip(inv);
    const oldBody = M.itemgen.generateItem({ level: 5, slot: 'body', rarity: 'normal' });
    const next = M.itemgen.generateItem({ level: 8, slot: 'body', rarity: 'rare' });
    inv.equip.body = oldBody;
    inv.bag.push(next);

    assert.ok(M.app.doEquipFromBag(game, inv.bag.indexOf(next)), '手动装备成功');
    assert.equal(inv.equip.body, next);
    assert.equal(inv.bag.filter((i) => i === oldBody).length, 1, '旧装备在背包里只能有一份（曾重复两份）');
  });
});

// ---------------------------------------------------------------------------
describe('集成 · 天赋', () => {
  test('doTakeTalent 相邻节点 → 已点天赋 +1、点数 -1', () => {
    const game = newGame(19);
    const inv = game.inv;
    const world = game.world;
    // 先造几个天赋点（走 core 的升级路径，保证两种记账方式都被覆盖）
    world.__grantXp(world, world.player, M.progression.xpForLevel(1) * 3);
    M.app.updateGame(game, DT, emptyInput());
    M.app.clearEvents(world);
    if (world.__syncTalentPoints) world.__syncTalentPoints();
    world.__grantXp(world, world.player, M.progression.xpForLevel(world.player.level) * 3);
    M.app.updateGame(game, DT, emptyInput());
    M.app.clearEvents(world);
    if (world.__syncTalentPoints) world.__syncTalentPoints();
    inv.talentPoints = Math.max(inv.talentPoints || 0, 1);

    const start = M.talents.START_NODE;
    // 找一个与 start-warrior 相邻、且未被点过的节点
    const neighbour = M.talents.TALENTS.find(
      (n) => n && n.id !== start && Array.isArray(n.neighbors) && n.neighbors.includes(start) && !inv.talents.includes(n.id),
    );
    assert.ok(neighbour, 'start-warrior 有相邻节点');
    const before = inv.talents.length;
    const ptsBefore = inv.talentPoints;
    const ok = M.app.doTakeTalent(game, neighbour.id);
    assert.ok(ok, `doTakeTalent(${neighbour.id}) 应成功`);
    assert.equal(inv.talents.length, before + 1, '已点天赋 +1');
    assert.equal(inv.talentPoints, ptsBefore - 1, '天赋点 -1');
  });
});

// ---------------------------------------------------------------------------
describe('集成 · 切图', () => {
  test('travelToNewMap → 层数 +1、怪物刷新、玩家位置可走', () => {
    const game = newGame(23, 1);
    const world = game.world, p = world.player;
    const tier0 = world.tier;
    // 先塞几只怪，确认换图会清空
    M.monsters.spawnMonster(world, 'husk', p.x + 2, p.z, { level: 1 });
    M.app.travelToNewMap(game);
    assert.equal(world.tier, tier0 + 1, `层数 +1（${tier0} → ${world.tier}）`);
    assert.equal(world.monsters.length, 0, '换图后怪物清空');
    assert.ok(world.isWalkable(p.x, p.z), '玩家在可走点');
    // 换图瞬间必须回满血（这一步不依赖时间推进，是 travelToNewMap 的确定性行为）
    assert.equal(p.hp, p.maxHp, '换图回满血');
    // 跑几秒让刷怪器重新刷出怪
    stepSeconds(game, 4, () => emptyInput());
    assert.ok((world.monsters || []).length > 0, '换图后重新刷怪');
    // [稳定性修复] 原来还断言「4 秒后仍满血」。新地图是随机的（travelToNewMap 用 Math.random
    // 当种子），玩家出生点可能正好被刷怪器刷在怪堆里挨打，实测 40 次里 5 次会掉血——
    // 这是随机刷怪的正常行为，不是切图 bug。这里只要求「没被打死」。
    assert.ok(!p.dead, '换图后 4 秒内玩家不应死亡');
  });
});

// ---------------------------------------------------------------------------
describe('集成 · 掉落', () => {
  test('连续击杀 100 只怪 → 有掉落且物品字段齐全', () => {
    const game = newGame(29);
    const world = game.world, p = world.player;
    world.items.length = 0;
    const before = world.items.length;
    const rarities = new Set();
    for (let i = 0; i < 100; i++) {
      const m = M.monsters.spawnMonster(world, i % 3 === 0 ? 'husk' : i % 3 === 1 ? 'crawler' : 'brute', p.x + 2 + (i % 5) * 0.2, p.z, { level: 1 });
      M.core.killEntity(world, m, p); // source 传玩家本体，保证按玩家击杀结算
    }
    M.app.clearEvents(world);
    assert.ok(world.items.length > before, `掉落产出（${world.items.length - before} 件）`);
    const drop = world.items.find((d) => d && d.item);
    assert.ok(drop.item, '掉落带 item');
    const it = drop.item;
    assert.ok(typeof it.name === 'string' && it.name.length > 0, 'name 合法');
    assert.ok(typeof it.slot === 'string' && it.slot.length > 0, 'slot 合法');
    assert.ok(['normal', 'magic', 'rare', 'legendary', 'unique'].includes(it.rarity), `rarity 合法（${it.rarity}）`);
    assert.ok(Number.isFinite(it.level) || Number.isFinite(it.ilvl), 'level/ilvl 有限');
    // 稀有度归一化后统计
    for (const d of world.items) if (d && d.item) rarities.add(normalize(d.item.rarity));
    assert.ok(rarities.size >= 1, '至少有一种稀有度');
    // 掉落率健康检查：100 杀至少 5 件（目标 8-15 件，这里放宽到 5 防随机波动）
    const n = world.items.length;
    assert.ok(n >= 5, `100 杀掉落 ${n} 件，低于 5 件（掉落率过低）`);
  });

  function normalize(r) {
    return r === 'unique' || r === 'legendary' ? 'legendary' : r;
  }
});

// ---------------------------------------------------------------------------
describe('集成 · 稳定性', () => {
  test('60 秒长跑（每帧真调 updateGame）无 NaN、无异常、数量不失控', () => {
    const game = newGame(31);
    const world = game.world, p = world.player;
    const nan = new Set();
    const check = () => {
      if (!Number.isFinite(p.hp)) nan.add('hp');
      if (!Number.isFinite(p.maxHp)) nan.add('maxHp');
      if (!Number.isFinite(p.x)) nan.add('x');
      if (!Number.isFinite(p.level)) nan.add('level');
      for (const k in p.stats) if (!Number.isFinite(p.stats[k])) nan.add('stats.' + k);
    };
    const n = 60 * 60;
    for (let i = 0; i < n; i++) {
      M.app.updateGame(game, DT, botInput(game));
      M.app.clearEvents(world);
      if (p.dead) M.app.revivePlayer(game);
      if (i % 10 === 0) check();
    }
    check();
    assert.equal(nan.size, 0, `出现 NaN 字段：${[...nan].join(',')}`);
    assert.ok((world.monsters || []).length <= 400, `怪物数 ${world.monsters.length} 超过 400`);
    assert.ok((world.projectiles || []).length <= 800, `投射物数 ${world.projectiles.length} 超过 800`);
    assert.ok((world.events || []).length < 2000, '事件队列没有无限增长');
    assert.ok(p.level >= 1 && p.level <= 60, `等级合法（${p.level}）`);
  });
});

// ---------------------------------------------------------------------------
describe('集成 · 性能', () => {
  test('1000 步 updateGame 耗时 < 3 秒', () => {
    const game = newGame(37);
    const world = game.world;
    // 预热：让刷怪器把怪刷起来，避免只测空场景
    stepSeconds(game, 6, () => emptyInput());
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      M.app.updateGame(game, DT, botInput(game));
      M.app.clearEvents(world);
    }
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `1000 步耗时 ${ms}ms，超过 3000ms`);
  });
});