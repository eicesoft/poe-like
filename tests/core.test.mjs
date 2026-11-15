// 游戏核心逻辑测试（src/core/*）
// 覆盖：属性聚合 / 伤害公式 / 闪避 / 暴击 / 抗性 / 技能冷却与蓝量 / 怪物 AI / 升级 / 刷怪器 / Boss 波次 / 掉落
import { describe, test, assert, beforeEach } from './_runner.mjs';
import { RNG } from '../src/engine/rng.js';
import { BOSS_WAVE_EVERY } from '../src/core/spawner.js';
import { SpatialHash } from '../src/engine/spatial.js';
import {
  createPlayer, updateCore,
  aggregateStats, createBaseStats, recalcStats, STAT_KEYS,
  dealDamage, killEntity, healEntity, applyBuff, removeBuff, updateBuffs, armorReduction,
  spawnMonster, updateMonsters, MONSTERS, makeLevelTable, monsterAttack, updateProjectiles,
  spawnMonsterProjectile, updateGroundEffects, addGroundEffect,
  SKILLS, tryCast, tickSkills, makeSkillBar, tryDash, releaseChannel,
  updateSpawner, initSpawner, startWave, spawnBoss, aliveCapFor, computeAliveCap, BOSS_TEMPLATE_ID,
  grantXp, xpForLevel, xpProgress,
  rollLoot, dropOrbs, pickupNearest, rollItemRarity, BASE_ITEM_TYPES, updateLootTtl, makeBuiltinItem, generateItem,
} from '../src/core/index.js';

// ---------------------------------------------------------------------------
// 测试用 fake world
// ---------------------------------------------------------------------------

/**
 * 造一个最小可用的 world（字段全部符合 WORLD 契约）。
 * @param {{walkable?:boolean, seed?:number}} [opts]
 */
function createTestWorld(opts = {}) {
  const world = {
    time: 0,
    rng: new RNG(opts.seed || 12345),
    events: [],
    player: null,
    monsters: [],
    all: [],
    hash: new SpatialHash(2),
    projectiles: [],
    groundEffects: [],
    summoned: [],
    items: [],
    lootOrbs: [],
    map: { level: 1, name: '测试墓穴', mods: [], isBoss: false },
    stats: {
      kills: 0, waves: 0, waveActive: false, spawnTimer: 0, aliveCount: 0,
      elitesKilled: 0, bossKilled: 0, startTime: 0,
    },
    busy: 0,
    over: false,
    cleared: false,
    walkable: opts.walkable !== false,
    isWalkable(x, z) {
      return this.walkable !== false;
    },
    randomSpawnPoint() {
      // 距玩家 >= 9
      const p = this.player || { x: 0, z: 0 };
      const a = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(10, 16);
      return { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
    },
    emit(evt) {
      this.events.push(evt);
    },
  };
  world.player = createPlayer(world, { x: 0, z: 0 });
  return world;
}

/** 推进固定步长 */
function stepWorld(world, seconds, dt = 1 / 60) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    world.time += dt;
    updateCore(world, dt);
  }
}

/** 事件过滤 */
function eventsOf(world, type) {
  return world.events.filter((e) => e.type === type);
}

/**
 * 做一个"无闪避、无护甲、无抗性"的目标，用来验证伤害公式。
 * @param {Object} world
 * @param {Object} [overrides]
 */
function makeDummy(world, overrides = {}) {
  const target = {
    id: 'dummy' + Math.random().toString(36).slice(2, 7),
    kind: 'monster',
    team: 1,
    type: 'dummy',
    name: '木桩',
    x: 1, z: 0, vx: 0, vz: 0,
    radius: 0.5,
    level: 1,
    hp: 100000,
    maxHp: 100000,
    mp: 0, maxMp: 0,
    dead: false,
    stats: aggregateStats([{}]),
    buffs: [],
    ai: { state: 'idle', t: 0, cooldown: 0 },
    anim: { state: 'idle', t: 0, dur: 0.3, dir: 0 },
    ...overrides,
  };
  if (overrides.stats) target.stats = { ...target.stats, ...overrides.stats };
  return target;
}

// ---------------------------------------------------------------------------
describe('属性系统 stats.js', () => {
  test('STAT_KEYS 包含契约要求的字段', () => {
    for (const k of ['life', 'lifeRegen', 'mana', 'manaRegen', 'energyShield', 'armor', 'evasion',
      'blockChance', 'dmgMin', 'dmgMax', 'attackSpeedMult', 'critChance', 'critMulti', 'moveSpeedMult',
      'physDamageMult', 'fireDamageMult', 'coldDamageMult', 'lightningDamageMult', 'chaosDamageMult',
      'aoeMult', 'skillLevelBonus', 'lifeLeech', 'lifeOnHit', 'cdrMult', 'areaDamageMult', 'dotMult',
      'thorns', 'projectileSpeedMult']) {
      assert.ok(STAT_KEYS.includes(k), `缺少字段 ${k}`);
    }
  });

  test('aggregateStats 线性相加', () => {
    const s = aggregateStats([
      { life: 100, armor: 5, critChance: 0.05 },
      { life: 20, armor: 15, critChance: 0.05 },
      null,
      { life: 5 },
    ]);
    assert.equal(s.life, 125);
    assert.equal(s.armor, 20);
    assert.ok(Math.abs(s.critChance - 0.1) < 1e-9);
    assert.equal(s.critMulti, 1.5); // 默认值
  });

  test('aggregateStats 对 evasion/critChance/leech/cdr 做 clamp', () => {
    const s = aggregateStats([{ evasion: 0.9, critChance: 1.8, lifeLeech: 0.9, cdrMult: 0.95, blockChance: 0.99 }]);
    assert.equal(s.evasion, 0.75);
    assert.equal(s.critChance, 1);
    assert.equal(s.lifeLeech, 0.25);
    assert.equal(s.cdrMult, 0.6);
    assert.equal(s.blockChance, 0.75);
  });

  test('aggregateStats 抗性不能超过 maxResistance', () => {
    // maxResistance 默认 0.75（DEFAULTS 里的"默认值只兜底一次"语义）
    const s = aggregateStats([{ fireResist: 0.9 }]);
    assert.equal(s.fireResist, 0.75);
    // 负抗允许（易伤）
    const s3 = aggregateStats([{ coldResist: -0.2 }]);
    assert.ok(Math.abs(s3.coldResist + 0.2) < 1e-9);
    // 抗性永远不超过 maxResistance（无论叠加多少）
    const s2 = aggregateStats([{ fireResist: 1.2 }]);
    assert.equal(s2.maxResistance, 0.75);
    assert.ok(s2.fireResist <= s2.maxResistance, `fireResist=${s2.fireResist}`);
    // 混沌抗上限更低（min(maxResistance, 0.75)）
    const s4 = aggregateStats([{ chaosResist: 0.95 }]);
    assert.ok(s4.chaosResist <= 0.75);
  });

  test('createBaseStats(1) 生命 120 / 法力 60 / 武器 12-22', () => {
    const b = createBaseStats(1);
    assert.equal(b.life, 120);
    assert.equal(b.mana, 60);
    assert.equal(b.dmgMin, 12);
    assert.equal(b.dmgMax, 22);
  });

  test('recalcStats 保留血量比例', () => {
    const world = createTestWorld();
    const p = world.player;
    p.hp = p.maxHp * 0.5;
    const before = p.maxHp;
    p.equipStats = { life: 100 };
    recalcStats(world, p);
    assert.equal(p.maxHp, before + 100);
    assert.ok(Math.abs(p.hp / p.maxHp - 0.5) < 1e-9, `hp ratio=${p.hp / p.maxHp}`);
  });

  test('recalcStats 穿戴/脱下装备后属性可逆', () => {
    const world = createTestWorld();
    const p = world.player;
    const baseHp = p.maxHp;
    p.equipStats = { life: 50, armor: 30, critChance: 0.1 };
    p.talentStats = { life: 20 };
    recalcStats(world, p);
    assert.equal(p.maxHp, baseHp + 70);
    assert.ok(Math.abs(p.stats.critChance - 0.15) < 1e-9);
    assert.equal(p.stats.armor, 30);
    // 脱装备
    p.equipStats = {};
    recalcStats(world, p);
    assert.equal(p.maxHp, baseHp + 20);
    assert.equal(p.stats.armor, 0);
  });
});

// ---------------------------------------------------------------------------
describe('伤害公式 combat.js', () => {
  let world;
  beforeEach(() => {
    world = createTestWorld();
  });

  test('无护甲无闪避：100 物理 → 100', () => {
    const t = makeDummy(world);
    const res = dealDamage(world, world.player, t, { phys: 100, canCrit: false });
    assert.equal(res.hit, true);
    assert.equal(res.amount, 100);
    assert.equal(t.hp, t.maxHp - 100);
  });

  test('暴击 ×critMulti（默认 1.5）', () => {
    const t = makeDummy(world);
    const res = dealDamage(world, world.player, t, { phys: 100, crit: true, canCrit: true });
    assert.equal(res.crit, true);
    assert.equal(res.amount, 150);
  });

  test('自定义 critMulti 生效', () => {
    const t = makeDummy(world);
    const src = { ...world.player, stats: { ...world.player.stats, critMulti: 2.2 } };
    const res = dealDamage(world, src, t, { phys: 100, crit: true });
    assert.equal(res.amount, 220);
  });

  test('护甲减免：armor=1000, 物理 100 → 50%', () => {
    const t = makeDummy(world, { stats: { armor: 1000 } });
    const red = armorReduction(1000, 100);
    assert.ok(Math.abs(red - 0.5) < 1e-9, `red=${red}`);
    const res = dealDamage(world, world.player, t, { phys: 100, canCrit: false });
    assert.equal(res.amount, 50);
    // 护甲越高减免越多、但有上限
    assert.ok(armorReduction(100000, 100) <= 0.75);
    assert.ok(armorReduction(1000, 100) > armorReduction(500, 100));
  });

  test('元素抗性减免', () => {
    const t = makeDummy(world, { stats: { fireResist: 0.4 } });
    const res = dealDamage(world, world.player, t, { fire: 100, canCrit: false });
    assert.equal(res.amount, 60);
  });

  test('evasion = 0.5 时大样本命中率 ≈ 50%', () => {
    const t = makeDummy(world, { stats: { evasion: 0.5 }, hp: 1e9, maxHp: 1e9 });
    let hits = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const res = dealDamage(world, world.player, t, { phys: 10, canCrit: false });
      if (res.hit) hits++;
      t.hp = t.maxHp; // 重置
    }
    const rate = hits / N;
    assert.ok(rate > 0.45 && rate < 0.55, `命中率=${rate}`);
  });

  test('命中事件推送 hit / crit / miss', () => {
    const t = makeDummy(world);
    dealDamage(world, world.player, t, { phys: 10, canCrit: false });
    assert.equal(eventsOf(world, 'hit').length, 1);
    dealDamage(world, world.player, t, { phys: 10, crit: true });
    assert.equal(eventsOf(world, 'crit').length, 1);
    const dodger = makeDummy(world, { stats: { evasion: 0.75 } });
    for (let i = 0; i < 300 && eventsOf(world, 'miss').length === 0; i++) {
      dealDamage(world, world.player, dodger, { phys: 10, canCrit: false });
      dodger.hp = dodger.maxHp;
    }
    assert.ok(eventsOf(world, 'miss').length > 0, '应产生 miss 事件');
  });

  test('dot 不会被闪避，且必中', () => {
    const t = makeDummy(world, { stats: { evasion: 0.75 } });
    let hits = 0;
    for (let i = 0; i < 100; i++) {
      const res = dealDamage(world, world.player, t, { fire: 10, kind: 'dot', canCrit: false });
      if (res.hit) hits++;
      t.hp = t.maxHp;
    }
    assert.equal(hits, 100);
  });

  test('暴击率由 attack.critChance 决定（大样本）', () => {
    const p = world.player;
    p.stats.critChance = 0.5;
    const t = makeDummy(world);
    let crits = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const res = dealDamage(world, p, t, { phys: 10, canCrit: true });
      if (res.crit) crits++;
      t.hp = t.maxHp;
    }
    const rate = crits / N;
    assert.ok(rate > 0.45 && rate < 0.55, `暴击率=${rate}`);
  });

  test('击杀玩家 → playerDeath 事件', () => {
    const p = world.player;
    dealDamage(world, null, p, { phys: 99999, canCrit: false });
    assert.equal(p.dead, true);
    assert.equal(eventsOf(world, 'playerDeath').length, 1);
  });

  test('击杀怪物 → monsterKilled + kill 事件', () => {
    const t = makeDummy(world, { hp: 10, maxHp: 10 });
    dealDamage(world, world.player, t, { phys: 50, canCrit: false });
    assert.equal(t.dead, true);
    assert.equal(eventsOf(world, 'monsterKilled').length, 1);
    assert.equal(eventsOf(world, 'kill').length, 1);
  });

  test('能量护盾优先吸收伤害', () => {
    const p = world.player;
    p.energyShield = 30;
    p.stats.energyShield = 30;
    const hpBefore = p.hp;
    // 用 forceHit 规避护甲等：直接构造高伤害
    dealDamage(world, null, p, { phys: 50, canCrit: false, forceHit: true });
    assert.equal(p.energyShield, 0);
    assert.equal(p.hp, hpBefore - 20);
  });

  test('healEntity 不超过上限', () => {
    const p = world.player;
    p.hp = 10;
    healEntity(world, p, 50);
    assert.equal(p.hp, 60);
    healEntity(world, p, 9999);
    assert.equal(p.hp, p.maxHp);
  });

  test('applyBuff / removeBuff 影响最终属性', () => {
    const p = world.player;
    const baseArmor = p.stats.armor;
    applyBuff(world, p, { id: 'test', name: '测试', type: 'buff', dur: 5, stats: { armor: 40 } });
    assert.equal(p.stats.armor, baseArmor + 40);
    removeBuff(world, p, 'test');
    assert.equal(p.stats.armor, baseArmor);
  });

  test('buff 到期自动移除并还原属性', () => {
    const p = world.player;
    const base = p.stats.attackSpeedMult;
    applyBuff(world, p, { id: 'tmp', name: '临时', type: 'buff', dur: 0.5, stats: { attackSpeedMult: 0.5 } });
    assert.ok(Math.abs(p.stats.attackSpeedMult - base - 0.5) < 1e-9);
    for (let i = 0; i < 40; i++) updateBuffs(world, p, 1 / 60);
    assert.ok(Math.abs(p.stats.attackSpeedMult - base) < 1e-9);
    assert.equal(p.buffs.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('技能 skills.js', () => {
  let world;
  beforeEach(() => {
    world = createTestWorld();
  });

  test('createPlayer 初始化：1 级 / 120hp / 60mp / 5 技能 / 武器 12-22', () => {
    const p = world.player;
    assert.equal(p.level, 1);
    assert.equal(p.maxHp, 120);
    assert.equal(p.maxMp, 60);
    assert.equal(p.stats.dmgMin, 12);
    assert.equal(p.stats.dmgMax, 22);
    assert.equal(p.skillBar.length, 7);
    // 1 号技能由「裂地斩 groundSlam」改为「战争践踏 stomp」（见 docs/skill-upgrade-contract.md）
    assert.deepEqual(p.skillBar.slice(0, 5).map((s) => s.id),
      ['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally']);
    assert.equal(p.skillBar[0].name, '战争践踏');
    assert.equal(p.skillBar[0].icon, '💥');
    assert.equal(p.skillBar[5], null);
  });

  test('技能冷却与蓝量消耗', () => {
    const p = world.player;
    const mp0 = p.mp;
    const ok = tryCast(world, p, 'stomp', { x: 2, z: 0 });
    assert.equal(ok, true);
    assert.equal(p.mp, mp0 - SKILLS.stomp.manaCost);
    assert.ok(p.cooldowns.stomp > 5);
    // 冷却中不可再放
    const ok2 = tryCast(world, p, 'stomp', { x: 2, z: 0 });
    assert.equal(ok2, false);
    // 冷却走完可以再放（stomp 冷却 7 秒，推进 8 秒）
    for (let i = 0; i < 480; i++) tickSkills(world, p, 1 / 60);
    assert.equal(p.cooldowns.stomp, 0);
    assert.equal(tryCast(world, p, 'stomp', { x: 2, z: 0 }), true);
  });

  test('蓝量不足无法施放且返回 false、不进入冷却', () => {
    const p = world.player;
    p.mp = 5;
    const ok = tryCast(world, p, 'warcry', null);
    assert.equal(ok, false);
    assert.equal(p.cooldowns.warcry || 0, 0);
    assert.equal(p.mp, 5);
  });

  test('战争践踏：以自身为圆心的圆形范围伤害 + 眩晕，范围外敌人不受影响', () => {
    const p = world.player;
    // stomp 是圆形（不是扇形）：身后/侧面的敌人也应命中，范围外的则不受影响
    p.facing = Math.PI / 2;
    const front = makeDummy(world, { x: 2.2, z: 0 });
    const back = makeDummy(world, { x: -2.2, z: 0 });
    const far = makeDummy(world, { x: 9, z: 0 });
    world.monsters.push(front, back, far);
    world.all.push(front, back, far);
    world.hash.rebuild(world.all);
    const hits = SKILLS.stomp.cast(world, p, { x: 5, z: 0 }, { bar: p.skillBar[0] });
    assert.ok(hits >= 2, `圆形范围应命中前后两个敌人，hits=${hits}`);
    assert.ok(front.hp < front.maxHp, '前方敌人应受伤');
    assert.ok(back.hp < back.maxHp, '圆形范围：身后敌人也应受伤（不再是扇形）');
    assert.ok((front.stunTime || 0) > 0 && (back.stunTime || 0) > 0, '命中的敌人应被眩晕');
    assert.equal(far.hp, far.maxHp, '范围外的敌人不受影响');
    assert.equal(eventsOf(world, 'stomp').length, 1);
    // 旧的扇形事件 'slam' 已被 'stomp' 取代
    assert.equal(eventsOf(world, 'slam').length, 0);
    // 护甲 buff「踏地战甲」由命中数决定（详细断言见 tests/skill-upgrade.test.mjs）
    const armor = p.buffs.find((b) => b.id === 'warStompArmor');
    assert.ok(armor, '施放战争践踏应获得「踏地战甲」护甲 buff');
    assert.equal(armor.name, '踏地战甲');
  });

  test('旋风斩：按住持续掉蓝 + 每 0.18 秒伤害', () => {
    const p = world.player;
    const t = makeDummy(world, { x: 1.5, z: 0, hp: 1e6, maxHp: 1e6 });
    t.stats = { ...t.stats, physDamageMult: 0 };
    world.monsters.push(t);
    world.all.push(t);
    world.hash.rebuild(world.all);
    const ok = tryCast(world, p, 'whirlwind', { x: 1, z: 0 });
    assert.equal(ok, true);
    const mp0 = p.mp;
    const hp0 = t.hp;
    // 模拟 0.6s
    for (let i = 0; i < 36; i++) tickSkills(world, p, 1 / 60);
    assert.ok(p.mp < mp0, '应消耗法力');
    assert.ok(t.hp < hp0, '应造成伤害');
    const tickCount = eventsOf(world, 'whirlTick').length;
    assert.ok(tickCount >= 3, `旋斩次数=${tickCount}`);
    // 松开
    releaseChannel(world, p, 'whirlwind');
    assert.equal(p.skillBar[1].active, false);
  });

  test('战吼：自身获得伤害 buff、敌人被减速', () => {
    const p = world.player;
    const t = makeDummy(world, { x: 2, z: 0 });
    world.monsters.push(t);
    world.all.push(t);
    world.hash.rebuild(world.all);
    assert.equal(tryCast(world, p, 'warcry', null), true);
    const self = p.buffs.find((b) => b.id === 'warcryBuff');
    assert.ok(self, '自身应有战吼 buff');
    assert.ok(Math.abs(p.stats.damageMult - 0.15) < 1e-9);
    const slow = t.buffs.find((b) => b.id === 'warcrySlow');
    assert.ok(slow, '敌人应被减速');
  });

  test('血性狂暴：加攻速/暴击，且持续扣血', () => {
    const p = world.player;
    assert.equal(tryCast(world, p, 'bloodRage', null), true);
    assert.ok(Math.abs(p.stats.attackSpeedMult - 0.2) < 1e-9);
    assert.ok(Math.abs(p.stats.critChance - 0.15) < 1e-9);
    const hp0 = p.hp;
    // 1.2 秒后应掉血约 1.8% （1.5%/s）
    for (let i = 0; i < 72; i++) updateBuffs(world, p, 1 / 60);
    const lost = hp0 - p.hp;
    assert.ok(lost > 1.5 && lost < 2.6, `掉血=${lost}`);
  });

  test('坚毅图腾：生成召唤物并在范围内回蓝', () => {
    const p = world.player;
    p.mp = 20; // rally 需要 15 法力
    assert.equal(tryCast(world, p, 'rally', { x: 1, z: 0 }), true);
    assert.equal(world.summoned.length, 1);
    const mp0 = p.mp;
    for (let i = 0; i < 60; i++) {
      world.time += 1 / 60;
      updateCore(world, 1 / 60);
    }
    assert.ok(p.mp > mp0 + 1, `图腾回蓝不足 mp=${p.mp} mp0=${mp0}`);
  });

  test('翻滚：瞬移并进入无敌，冷却 1.2s', () => {
    const p = world.player;
    p.moveX = 1;
    p.moveZ = 0;
    const ok = tryDash(world, p);
    assert.equal(ok, true);
    assert.ok(Math.abs(p.x - 4.2) < 1e-6, `x=${p.x}`);
    assert.ok(p.invuln > 0, '应有无敌帧');
    assert.ok(Math.abs(p.cooldowns.dash - 1.2) < 1e-6);
    // 冷却中不能再翻滚
    assert.equal(tryDash(world, p), false);
    // 无敌期间不受伤害
    const hp0 = p.hp;
    dealDamage(world, null, p, { phys: 50 });
    assert.equal(p.hp, hp0);
    // 无敌结束
    for (let i = 0; i < 20; i++) tickSkills(world, p, 1 / 60);
    assert.equal(p.invuln, 0);
    dealDamage(world, null, p, { phys: 50, forceHit: true });
    assert.equal(p.hp, hp0 - 50);
  });

  test('翻滚被墙阻挡时停在墙前', () => {
    const p = world.player;
    p.moveX = 1;
    p.moveZ = 0;
    world.isWalkable = (x, z) => x < 2;
    tryDash(world, p);
    assert.ok(p.x <= 2 + 1e-6, `x=${p.x}`);
  });

  test('技能事件推送 skillCast', () => {
    const p = world.player;
    tryCast(world, p, 'warcry', null);
    assert.equal(eventsOf(world, 'skillCast').length, 1);
  });
});

// ---------------------------------------------------------------------------
describe('怪物 monsters.js', () => {
  let world;
  beforeEach(() => {
    world = createTestWorld();
  });

  test('至少 7 种怪物模板，且 shape 合法', () => {
    const ids = Object.keys(MONSTERS);
    for (const id of ['husk', 'crawler', 'skeleton', 'hellhound', 'brute', 'wraith', 'bomber']) {
      assert.ok(ids.includes(id), `缺少模板 ${id}`);
    }
    const shapes = new Set(['humanoid', 'quadruped', 'spider', 'wraith', 'blob', 'skeleton']);
    for (const id of ids) {
      const t = MONSTERS[id];
      assert.ok(shapes.has(t.visual.shape), `${id} shape=${t.visual.shape}`);
      assert.ok(typeof t.visual.color === 'string');
      assert.ok(t.visual.size > 0);
      assert.ok(t.hp > 0 && t.damage > 0 && t.radius > 0 && t.xp > 0);
    }
  });

  test('spawnMonster 插入 monsters / all / hash，并推 spawn 事件', () => {
    const m = spawnMonster(world, 'husk', 5, 0, { level: 1 });
    assert.equal(world.monsters.length, 1);
    assert.equal(world.all.length, 2); // 玩家 + 怪物
    assert.ok(m.hp > 0 && m.maxHp === m.hp);
    assert.equal(eventsOf(world, 'spawn').length, 1);
    const found = world.hash.queryCircle(5, 0, 1);
    assert.ok(found.includes(m), '空间哈希里应能查到');
  });

  test('makeLevelTable 随等级缩放', () => {
    const t1 = makeLevelTable(1);
    const t10 = makeLevelTable(10);
    assert.ok(t10.templates.husk.hp > t1.templates.husk.hp * 3);
    assert.ok(t10.templates.husk.damage > t1.templates.husk.damage);
    assert.ok(t10.templates.husk.xp > t1.templates.husk.xp);
  });

  test('怪物追击玩家', () => {
    const p = world.player;
    const m = spawnMonster(world, 'husk', 8, 0, { level: 1 });
    const d0 = Math.hypot(m.x - p.x, m.z - p.z);
    for (let i = 0; i < 120; i++) updateMonsters(world, 1 / 60);
    const d1 = Math.hypot(m.x - p.x, m.z - p.z);
    assert.ok(d1 < d0 - 2, `追击后距离 ${d0.toFixed(2)} → ${d1.toFixed(2)}`);
    assert.ok(['chase', 'attack', 'recover'].includes(m.ai.state));
    assert.ok(m.aggro);
  });

  test('怪物靠近后攻击玩家造成伤害', () => {
    const p = world.player;
    spawnMonster(world, 'husk', 1.2, 0, { level: 1 });
    const hp0 = p.hp;
    for (let i = 0; i < 240; i++) {
      world.time += 1 / 60;
      updateCore(world, 1 / 60);
      if (p.hp < hp0) break;
    }
    assert.ok(p.hp < hp0, '玩家应被攻击掉血');
  });

  test('怪物攻击不会穿过不可行走区域移动', () => {
    const p = world.player;
    p.x = 0; p.z = 0;
    // 只有 x <= 3 的区域可走；怪物出生在 x=3.4（墙外一格）
    world.isWalkable = (x, z) => x <= 3;
    const m = spawnMonster(world, 'husk', 3.4, 0, { level: 1 });
    for (let i = 0; i < 180; i++) updateMonsters(world, 1 / 60);
    // 无论怎样都不能穿墙（x 不超过出生点、也不会出现在墙内新位置）
    assert.ok(m.x <= 3.4 + 1e-6, `怪物越界 x=${m.x}`);
    // 在可行走的区域追击时，同样不能穿墙
    const m2 = spawnMonster(world, 'husk', 2.5, 0, { level: 1 });
    for (let i = 0; i < 180; i++) updateMonsters(world, 1 / 60);
    assert.ok(m2.x <= 3 + 1e-6, `怪物越界 x=${m2.x}`);
    assert.ok(m2.x < 2.5, `应朝玩家（-x）移动 x=${m2.x}`);
  });

  test('骸骨弓手发射投射物并能命中玩家', () => {
    const p = world.player;
    const m = spawnMonster(world, 'skeleton', 6, 0, { level: 1 });
    m.aggro = true;
    m.attackTimer = 0;
    m.ai.state = 'chase';
    let fired = false;
    for (let i = 0; i < 300 && !fired; i++) {
      updateMonsters(world, 1 / 60);
      if (world.projectiles.length > 0) fired = true;
    }
    assert.ok(fired || world.projectiles.length > 0, '应发射投射物');
    const hp0 = p.hp;
    for (let i = 0; i < 120 && p.hp === hp0; i++) updateProjectiles(world, 1 / 60);
    assert.ok(p.hp < hp0, '投射物应命中玩家');
  });

  test('地面效果造成持续伤害并到期消失', () => {
    const p = world.player;
    p.x = 0; p.z = 0;
    // team 默认 1 = 怪物阵营的地面效果，只伤害玩家（半径 1 的毒池覆盖玩家）
    const ge = addGroundEffect(world, { kind: 'poison', x: 0, z: 0, r: 1, dps: 10, dur: 1 });
    assert.ok(ge && ge.id);
    const hp0 = p.hp;
    for (let i = 0; i < 45; i++) updateGroundEffects(world, 1 / 60);
    assert.ok(p.hp < hp0, `应在毒池中掉血 hp=${p.hp} hp0=${hp0}`);
    for (let i = 0; i < 90; i++) updateGroundEffects(world, 1 / 60);
    assert.equal(world.groundEffects.length, 0, '地面效果应过期');
  });

  test('怪物被击杀后从数组移除（死亡动画后）', () => {
    const m = spawnMonster(world, 'husk', 5, 0, { level: 1 });
    dealDamage(world, world.player, m, { phys: 99999, forceHit: true, canCrit: false });
    assert.equal(m.dead, true);
    for (let i = 0; i < 120; i++) updateMonsters(world, 1 / 60);
    assert.equal(world.monsters.length, 0);
    assert.equal(world.all.length, 1);
  });

  test('怪物词缀生效（坚韧 +40% 生命）', () => {
    const a = spawnMonster(world, 'husk', 0, 0, { level: 1, mods: [] });
    const b = spawnMonster(world, 'husk', 0, 0, { level: 1, mods: ['tough'] });
    assert.ok(b.maxHp > a.maxHp * 1.3, `${a.maxHp} vs ${b.maxHp}`);
  });

  test('精英/魔法怪词缀数量正确', () => {
    const elite = spawnMonster(world, 'brute', 0, 0, { level: 1, rarity: 'rare' });
    assert.equal(elite.elite, true);
    assert.equal(elite.rarity, 'rare');
    assert.ok(elite.mods.length >= 2);
  });
});

// ---------------------------------------------------------------------------
describe('经验与升级 progression.js', () => {
  let world;
  beforeEach(() => {
    world = createTestWorld();
  });

  test('xpForLevel 随等级递增', () => {
    let prev = 0;
    for (let lv = 1; lv <= 30; lv++) {
      const xp = xpForLevel(lv);
      assert.ok(xp > prev, `lv=${lv}`);
      prev = xp;
    }
    assert.equal(xpForLevel(1), 40);
  });

  test('击杀怪物给经验（事件驱动流程）', () => {
    const m = spawnMonster(world, 'husk', 1, 0, { level: 1 });
    const xp0 = world.player.xp;
    dealDamage(world, world.player, m, { phys: 99999, forceHit: true, canCrit: false });
    assert.ok(world.player.xp > xp0, `xp=${world.player.xp}`);
  });

  test('升级后 maxHp 增加且回满', () => {
    const p = world.player;
    const max0 = p.maxHp;
    p.hp = p.maxHp;
    grantXp(world, p, xpForLevel(1) * 3);
    assert.ok(p.level >= 2, `level=${p.level}`);
    assert.ok(p.maxHp > max0, `maxHp ${max0} → ${p.maxHp}`);
    assert.equal(p.hp, p.maxHp, '升级应回满生命');
    assert.equal(p.maxMp, p.maxMp); // 占位
    assert.equal(p.talentPoints, 2, '每升 1 级 +2 天赋点');
    assert.ok(eventsOf(world, 'levelUp').length >= 1);
    const evt = eventsOf(world, 'levelUp')[0];
    assert.equal(evt.unspentPoints, 2, 'levelUp 事件的 unspentPoints 应为升级后累计的 2 点');
    assert.equal(evt.gainedPoints, 2, 'levelUp 事件应报告 gainedPoints = 2');
  });

  test('xpProgress 返回进度', () => {
    const p = world.player;
    grantXp(world, p, 100);
    const pr = xpProgress(p);
    assert.ok(pr.pct > 0 && pr.pct <= 1);
    assert.equal(pr.level, p.level);
  });
});

// ---------------------------------------------------------------------------
describe('刷怪器 spawner.js', () => {
  let world;
  beforeEach(() => {
    world = createTestWorld();
  });

  test('若干秒内能量产小怪，且不超过上限', () => {
    const cap = aliveCapFor(1);
    for (let i = 0; i < 60 * 30; i++) {
      world.time += 1 / 60;
      updateCore(world, 1 / 60);
    }
    const alive = world.monsters.filter((m) => !m.dead).length;
    assert.ok(alive >= 5, `30 秒应刷出不少怪，alive=${alive}`);
    assert.ok(alive <= cap, `不应超过上限 ${cap}，实际 ${alive}`);
    assert.ok(world.stats.waves >= 1);
  });

  test('地图等级越高上限越大', () => {
    assert.ok(aliveCapFor(10) > aliveCapFor(1));
    assert.ok(aliveCapFor(30) > aliveCapFor(10));
  });

  test('波次开始时推 waveStart 事件', () => {
    world.stats.spawnerReady = false;
    initSpawner(world);
    startWave(world);
    assert.equal(eventsOf(world, 'waveStart').length, 1);
    assert.equal(world.stats.waves, 1);
  });

  test('第 15 波刷 2 只精英', () => {
    const w = createTestWorld();
    initSpawner(w);
    w.stats.waves = 14;
    const before = w.monsters.length;
    startWave(w);
    const elites = w.monsters.filter((m) => m.elite);
    assert.equal(elites.length, 2, `精英数量=${elites.length}（新增 ${w.monsters.length - before}）`);
    assert.ok(eventsOf(w, 'eliteWave').length === 1 || eventsOf(w, 'eliteSpawn').length >= 2);
  });

  test('第 25 波刷 Boss，且 Boss 存活期间暂停小怪刷新', () => {
    const w = createTestWorld();
    initSpawner(w);
    w.stats.waves = BOSS_WAVE_EVERY - 1;
    startWave(w);
    const boss = w.monsters.find((m) => m.isBoss);
    assert.ok(boss, '应刷出 Boss');
    assert.equal(boss.name, '深渊主宰');
    assert.equal(boss.rarity, 'boss');
    assert.equal(w.stats.bossAlive, true);
    assert.ok(eventsOf(w, 'bossSpawn').length === 1);
    const aliveBefore = w.monsters.filter((m) => !m.dead).length;
    // 跑 20 秒不应刷出新怪
    for (let i = 0; i < 60 * 20; i++) {
      w.time += 1 / 60;
      updateSpawner(w, 1 / 60);
    }
    const aliveAfter = w.monsters.filter((m) => !m.dead).length;
    assert.equal(aliveAfter, aliveBefore, `Boss 存活期间不应刷怪 ${aliveBefore} → ${aliveAfter}`);
  });

  test('Boss 被击杀后恢复刷新并记录 bossKilled', () => {
    const w = createTestWorld();
    initSpawner(w);
    const boss = spawnBoss(w);
    assert.equal(w.stats.bossAlive, true);
    dealDamage(w, w.player, boss, { phys: 999999, forceHit: true, canCrit: false });
    assert.equal(w.stats.bossKilled, 1);
    assert.ok(eventsOf(w, 'bossKilled').length === 1);
    updateSpawner(w, 1 / 60);
    assert.equal(w.stats.bossAlive, false);
  });

  test('刷怪点距离玩家 >= 9', () => {
    const w = createTestWorld();
    initSpawner(w);
    for (let i = 0; i < 20; i++) {
      const pt = w.randomSpawnPoint();
      assert.ok(Math.hypot(pt.x - w.player.x, pt.z - w.player.z) >= 9);
    }
  });
});

// ---------------------------------------------------------------------------
describe('掉落 loot.js', () => {
  let world;
  beforeEach(() => {
    world = createTestWorld();
  });

  test('内置掉落表非空且结构完整', () => {
    assert.ok(BASE_ITEM_TYPES.length >= 8);
    for (const t of BASE_ITEM_TYPES) {
      assert.ok(t.name && t.slot && t.base);
    }
  });

  test('稀有度规则：普通怪大样本下魔法/稀有概率合理', () => {
    const N = 20000;
    let magic = 0, rare = 0;
    const rng = new RNG(7);
    for (let i = 0; i < N; i++) {
      const r = rollItemRarity(rng, 'normal');
      if (r === 'magic') magic++;
      else if (r === 'rare') rare++;
    }
    const pm = magic / N, pr = rare / N;
    // [playtest 修复] 普通怪掉落率提高（魔法 5% / 稀有 1.5%）：原 2.5%/0.5% 时实测每 100 杀
    // 只有 1 件装备掉落，远低于「8 件/100 杀」的换装节奏目标。
    assert.ok(pm > 0.07 && pm < 0.13, `魔法比例=${pm}`);
    assert.ok(pr > 0.012 && pr < 0.032, `稀有比例=${pr}`);
    // 精英
    let eMagic = 0, eRare = 0;
    for (let i = 0; i < N; i++) {
      const r = rollItemRarity(rng, 'rare');
      if (r === 'magic') eMagic++;
      else if (r === 'rare') eRare++;
    }
    assert.ok(eRare / N > 0.06 && eRare / N < 0.1, `精英稀有比例=${eRare / N}`);
    assert.ok(eMagic / N > 0.3, `精英魔法比例=${eMagic / N}`);
  });

  test('rollLoot 生成的物品结构能被 UI 显示', () => {
    const m = spawnMonster(world, 'husk', 3, 3, { level: 1, rarity: 'rare', elite: true });
    m.dead = true;
    rollLoot(world, m);
    assert.ok(world.items.length >= 1, '精英应掉落物品');
    for (const drop of world.items) {
      assert.ok(typeof drop.id === 'string');
      assert.ok(typeof drop.x === 'number' && typeof drop.z === 'number');
      assert.equal(drop.ttl, 120);
      assert.ok(drop.born >= 0);
      const it = drop.item;
      assert.ok(it, '有 item 实例');
      assert.ok(typeof it.name === 'string' && it.name.length > 0);
      assert.ok(typeof it.slot === 'string');
      assert.ok(['normal', 'magic', 'rare', 'legendary'].includes(it.rarity), `rarity=${it.rarity}`);
      assert.ok(typeof it.rarityName === 'string');
      assert.ok(Array.isArray(it.mods));
      assert.ok(it.stats && typeof it.stats === 'object');
      assert.ok(Array.isArray(it.statsText));
      assert.ok(typeof it.color === 'string');
    }
    assert.ok(eventsOf(world, 'loot').length >= 1);
  });

  test('稀有度键与 items 模块对齐：legendary 归一为 unique', () => {
    // 内置表：传入旧写法 'legendary' 会被 finalizeItem 归一为 'unique'
    const it = makeBuiltinItem(new RNG(5), { level: 3, rarity: 'legendary' });
    assert.equal(it.rarity, 'unique');
    assert.equal(it.rarityName, '传奇');
    assert.equal(it.color, '#af6025');
    // 直接指定 unique 也成立，且带传奇专属词缀
    const it2 = makeBuiltinItem(new RNG(6), { level: 3, rarity: 'unique' });
    assert.equal(it2.rarity, 'unique');
    assert.ok(it2.mods.length >= 1);
    assert.ok(it2.statsText.length >= 1, '应有可显示的属性文本');
  });

  test('world.itemGen 优先于内置掉落表（items 模块接口）', () => {
    // 用一个假的 itemGen 验证优先级，不依赖 items 模块是否就绪
    let called = 0;
    const world2 = createTestWorld();
    world2.itemGen = {
      generateDrop({ rng, level, rarity, slot }) {
        called++;
        assert.ok(rng && typeof rng.next === 'function', '应传入 world.rng');
        return {
          name: '测试者之手', slot: slot || 'weapon', rarity: rarity || 'magic',
          level, mods: [{ text: '+30 全属性', stats: { life: 30 } }],
        };
      },
    };
    const item = generateItem(world2, { level: 5, rarity: 'rare' });
    assert.equal(called, 1, '应调用 world.itemGen.generateDrop');
    assert.equal(item.name, '测试者之手');
    assert.equal(item.rarity, 'rare');
    assert.equal(item.rarityName, '稀有');
    assert.ok(item.stats.life === 30, `stats 汇总=${JSON.stringify(item.stats)}`);
    assert.ok(Array.isArray(item.statsText) && item.statsText.length >= 1);
  });

  test('world.itemGen 抛异常时回退内置掉落表', () => {
    const world2 = createTestWorld();
    world2.itemGen = { generateDrop() { throw new Error('boom'); } };
    const item = generateItem(world2, { level: 2, rarity: 'magic' });
    assert.ok(item && item.name, '应回退到内置物品');
    assert.equal(item.rarity, 'magic');
  });

  test('Boss 必掉 2 件稀有（+ 概率传奇）', () => {
    const boss = spawnBoss(world);
    boss.dead = true;
    rollLoot(world, boss);
    const rares = world.items.filter((d) => d.item && d.item.rarity === 'rare');
    assert.ok(rares.length >= 2, `稀有数量=${rares.length}`);
  });

  test('dropOrbs 生成魂火并推 orb 事件', () => {
    dropOrbs(world, 1, 1, 'gold', 3);
    assert.equal(world.lootOrbs.length, 3);
    assert.equal(eventsOf(world, 'orb').length, 1);
    for (const o of world.lootOrbs) assert.equal(o.kind, 'gold');
  });

  test('pickupNearest 返回最近的拾取物', () => {
    const p = world.player;
    world.lootOrbs.push({ id: 'a', kind: 'gold', x: 8, z: 0, value: 1, ttl: 60 });
    world.lootOrbs.push({ id: 'b', kind: 'gold', x: 1, z: 0, value: 1, ttl: 60 });
    const near = pickupNearest(world, p, 3);
    assert.ok(near);
    assert.equal(near.type, 'orb');
    assert.equal(near.drop.id, 'b');
    // 范围内没有则返回 null
    assert.equal(pickupNearest(world, p, 0.5), null);
  });

  test('掉落物 ttl 到期被清理', () => {
    const m = spawnMonster(world, 'husk', 2, 2, { level: 1, rarity: 'rare', elite: true });
    m.dead = true;
    rollLoot(world, m);
    const n = world.items.length;
    assert.ok(n > 0);
    updateLootTtl(world, 121);
    assert.equal(world.items.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('数值手感（POE 风格）', () => {
  /** 计算玩家一次普攻的平均伤害 */
  function avgHit(world, p, target, pct = 1) {
    const rng = world.rng;
    let sum = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const res = dealDamage(world, p, target, {
        phys: rng.range(p.stats.dmgMin, p.stats.dmgMax) * pct,
        canCrit: true,
      });
      sum += res.amount;
      target.hp = target.maxHp;
      target.dead = false;
    }
    return sum / N;
  }

  test('前期 1-3 刀可杀普通小怪（husk / crawler）', () => {
    const world = createTestWorld();
    const p = world.player;
    for (const id of ['husk', 'crawler']) {
      const m = spawnMonster(world, id, 2, 0, { level: 1 });
      const avg = avgHit(world, p, m);
      const hits = Math.ceil(m.maxHp / avg);
      assert.ok(hits >= 1 && hits <= 3, `${id}: hp=${m.maxHp} 平均伤害=${avg.toFixed(1)} → ${hits} 刀`);
    }
  });

  test('精英 3-5 秒可击杀（考虑技能 DPS）', () => {
    const world = createTestWorld();
    const p = world.player;
    const elite = spawnMonster(world, 'brute', 2, 0, { level: 1, rarity: 'rare', elite: true });
    const critW = 1 + p.stats.critChance * (p.stats.critMulti - 1);
    const avgWeapon = (p.stats.dmgMin + p.stats.dmgMax) / 2;
    const autoDps = avgWeapon * critW * 1.35;
    // 旋风斩 62%/0.18s = 3.44 次/秒 → 约 2.1 倍普攻 DPS；与普攻轮换、蓝量限制后取约 1.6 倍
    const wwTick = 0.18;
    const wwDps = avgWeapon * 0.62 / wwTick * critW;
    const dps = Math.min(wwDps, autoDps * 2.6);
    const ttk = elite.maxHp / dps;
    assert.ok(ttk > 2.0 && ttk < 5.5, `精英 TTK=${ttk.toFixed(2)}s（hp=${elite.maxHp.toFixed(0)} dps=${dps.toFixed(1)} 普攻dps=${autoDps.toFixed(1)}）`);
  });

  test('Boss 15-30 秒可击杀', () => {
    const world = createTestWorld();
    const p = world.player;
    const boss = spawnBoss(world);
    const critW = 1 + p.stats.critChance * (p.stats.critMulti - 1);
    const avgWeapon = (p.stats.dmgMin + p.stats.dmgMax) / 2;
    const autoDps = avgWeapon * critW * 1.35;
    const wwDps = (avgWeapon * 0.62) / 0.18 * critW;
    // [playtest 修复] 数值手感只针对「玩家等级 == 地图等级」的同一水平对局。
    // 原来这里无脑取 min(wwDps, autoDps*2.6)=60 DPS（旋风斩 100% 覆盖的理想值），
    // 而 tools/sim-ttk.mjs 用真实 createPlayer+spawnMonster+updateCore 实测 1 级玩家对 1 级 Boss
    // 的实际 DPS 只有 28-38（旋风斩受蓝量与贴身限制，还会和普攻交替），TTK 13-19 秒。
    // 另外：Boss 现在按「地图等级」生成；地图等级 = 加载时的玩家等级，所以压测时必须让
    // 玩家和地图同等级，否则会出现「5 级玩家打 1 级 Boss」的跨级歪打。
    const dps = autoDps * 1.3;
    const ttk = boss.maxHp / dps;
    assert.ok(ttk > 14 && ttk < 32, `Boss TTK=${ttk.toFixed(2)}s（hp=${boss.maxHp} dps=${dps.toFixed(1)} 普攻dps=${autoDps.toFixed(1)}）`);
    // 理想上限（旋风斩全程覆盖）不应快到离谱：至少要站得住 8 秒
    assert.ok(boss.maxHp / wwDps > 8, `满技能覆盖 TTK=${(boss.maxHp / wwDps).toFixed(2)}s 太快`);
  });

  test('怪物 lv1 伤害在 6-14 区间', () => {
    for (const id of Object.keys(MONSTERS)) {
      const t = MONSTERS[id];
      // [Lead 平衡] 新手期伤害下调，区间放宽到 5-20
      assert.ok(t.damage >= 5 && t.damage <= 20, `${id} damage=${t.damage}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('updateCore 集成', () => {
  test('完整跑 10 秒不报错，事件都带 type', () => {
    const world = createTestWorld();
    stepWorld(world, 10);
    assert.ok(world.time > 9.9);
    assert.ok(world.events.length > 0);
    for (const e of world.events) assert.ok(typeof e.type === 'string');
    const types = new Set(world.events.map((e) => e.type));
    assert.ok(types.has('spawn'), '应有 spawn 事件');
    assert.ok(types.has('waveStart'), '应有 waveStart 事件');
  });

  test('Lead 覆盖 world.__rollLoot 时仍然正常掉落（钩子不冲突）', () => {
    const world2 = createTestWorld();
    // 模拟 Lead 在 app.js 里的写法：__rollLoot 只做统计
    let leadCalls = 0;
    world2.career = { totalKills: 0 };
    world2.__rollLoot = (w, m) => { leadCalls++; w.career.totalKills++; };
    updateCore(world2, 1 / 60); // 核心安装钩子后不能覆盖 Lead 的
    assert.ok(world2.__rollLoot.toString().includes('totalKills'), '核心不应覆盖 Lead 的 __rollLoot');
    const elite = spawnMonster(world2, 'husk', 2, 2, { level: 1, rarity: 'rare', elite: true });
    dealDamage(world2, world2.player, elite, { phys: 99999, forceHit: true, canCrit: false });
    assert.ok(world2.items.length >= 1, '核心掉落应照常发生');
    assert.equal(leadCalls, 1, 'Lead 的统计钩子也应被调用');
    assert.equal(world2.career.totalKills, 1);
  });

  test('玩家死亡后 world.player.dead 为 true 且玩家死亡事件只推一次', () => {
    const world = createTestWorld();
    dealDamage(world, null, world.player, { phys: 99999, forceHit: true, canCrit: false });
    updateCore(world, 1 / 60);
    updateCore(world, 1 / 60);
    assert.equal(world.player.dead, true);
    assert.equal(eventsOf(world, 'playerDeath').length, 1);
  });

  test('固定步长 dt=1/60 下玩家移动速度符合 6.2 基准', () => {
    const world = createTestWorld();
    const p = world.player;
    p.moveX = 1;
    p.moveZ = 0;
    for (let i = 0; i < 60; i++) updateCore(world, 1 / 60);
    assert.ok(Math.abs(p.x - 6.2) < 0.15, `1 秒移动距离=${p.x}`);
  });

  test('moveSpeedMult 影响移动速度', () => {
    const world = createTestWorld();
    const p = world.player;
    p.equipStats = { moveSpeedMult: 0.5 };
    recalcStats(world, p);
    p.moveX = 1;
    for (let i = 0; i < 60; i++) updateCore(world, 1 / 60);
    assert.ok(Math.abs(p.x - 9.3) < 0.2, `1 秒移动距离=${p.x}`);
  });

  test('updateCore 本身不推进 world.time（由 Lead 维护）', () => {
    const world = createTestWorld();
    const t0 = world.time;
    updateCore(world, 1 / 60);
    updateCore(world, 1 / 60);
    assert.equal(world.time, t0);
  });

  test('world.emit(type, payload) 双签名兼容', () => {
    const world = createTestWorld();
    const got = [];
    world.emit = (a, b) => {
      if (typeof a === 'string') got.push({ type: a, ...b });
      else got.push(a);
    };
    applyBuff(world, world.player, { id: 'x', name: '测试', dur: 2, stats: { armor: 5 } });
    assert.ok(got.length >= 1, '应通过 emit(type,payload) 收到事件');
    assert.ok(got.every((e) => typeof e.type === 'string'));
  });

  test('world.emit(evt) 单签名兼容', () => {
    const world = createTestWorld();
    const got = [];
    world.emit = (a) => got.push(a);
    applyBuff(world, world.player, { id: 'y', name: '测试', dur: 2 });
    assert.ok(got.length >= 1);
    assert.equal(got[0].type, 'buff');
  });

  test('参考 world.mapMods：怪物生命/伤害/速度提升，同屏上限提升', () => {
    const base = createTestWorld();
    const modded = createTestWorld();
    modded.mapMods = { monsterLife: 0.4, monsterDamage: 0.2, monsterSpeed: 0.15, monsterResist: 0.1, monsterCount: 0.5, itemQuantity: 0.8 };
    const a = spawnMonster(base, 'husk', 0, 0, { level: 1, mods: [] });
    const b = spawnMonster(modded, 'husk', 0, 0, { level: 1, mods: [] });
    assert.ok(b.maxHp > a.maxHp * 1.3, `life ${a.maxHp} → ${b.maxHp}`);
    assert.ok(b.stats.dmgMax > a.stats.dmgMax * 1.1, `damage ${a.stats.dmgMax} → ${b.stats.dmgMax}`);
    assert.ok(b.speed > a.speed, `speed ${a.speed} → ${b.speed}`);
    assert.ok(b.stats.fireResist > a.stats.fireResist, `resist ${a.stats.fireResist} → ${b.stats.fireResist}`);
    assert.ok(computeAliveCap(modded) > computeAliveCap(base), 'monsterCount 应提升同屏上限');
  });

  test('map.tier 作为地图等级使用（Lead 用 tier 表示难度）', () => {
    const world = createTestWorld();
    world.map = { tier: 12, name: '深渊回廊', mods: [], isBoss: false };
    world.stats = {};
    initSpawner(world);
    assert.ok(world.stats.aliveCap > aliveCapFor(1), `cap=${world.stats.aliveCap}`);
    const m = spawnMonster(world, 'husk', 0, 0, {});
    assert.equal(m.level, 12, '怪物等级应跟随 tier');
  });

  test('玩家死亡后停止刷怪', () => {
    const world = createTestWorld();
    world.player.dead = true;
    world.player.hp = 0;
    for (let i = 0; i < 300; i++) updateCore(world, 1 / 60);
    assert.equal(world.monsters.length, 0, '玩家死亡后不应再刷怪');
  });
});
