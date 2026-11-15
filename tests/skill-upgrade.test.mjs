// @file tests/skill-upgrade.test.mjs
// 技能升级 / 分叉天赋 / 战争践踏 / 眩晕 —— 覆盖 docs/skill-upgrade-contract.md §7 的全部条目。
//
// 文件结构（每组一个 describe）：
//   1. 战争践踏 stomp：圆形范围 / 眩晕 / 护甲随命中数 / 持续时长 / 保底 / 刷新不叠层
//   2. 眩晕：被控不动不攻击 / Boss 抗性 / stunEnd
//   3. 技能等级：天赋 + 精炼叠加 / 上限 5 / 冷却·半径·伤害随等级
//   4. 分叉与互斥：skillEffectsForSkill 只认一支 / skillNodeConflict / validateSkillRanks / 5 棵树连通
//   5. 精炼与重置：canRefineSkill / refineSkill / respecSkill
//   6. 技能精炼石掉落与自动拾取
//   7. app 动作（createGame 真跑）：doSkillRankUp / doSkillRefine / doSkillRespec / 实例 level 同步
//   8. UI（DOM 桩）：技能面板 5 个标签 / 精炼按钮 / 互斥锁定 / 事件提醒 / HUD 光点
//   9. 渲染（mock canvas）：stomp / stun / stunEnd / skillRankUp 不抛异常
//
// 约定：契约里写死的字段名与语义 → 测试按契约写死，不迁就实现；
//      契约没规定的数值（18/5/4 秒、精炼消耗 3/4/6/8 等）→ 从源码读真实值，用区间/相对断言。
import { describe, test, assert } from './_runner.mjs';
import {
  makeWorld, resetArena, eventsOf, buffOf,
  load, loadSafe, ensureStubDOM, makeNullUI, seeded,
} from './_skillhelpers.mjs';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 推进 world（真调用 updateCore：buff/眩晕/AI 都会走真实路径） */
async function stepWorld(world, seconds, dt = DT) {
  const { updateCore } = await load('../src/core/index.js');
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    world.time += dt;
    updateCore(world, dt);
  }
}

/** 在玩家周围按极坐标放 n 个木桩，返回它们 */
function placeDummies(world, n, dist = 2, hp = 1e6) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    const m = makeDummy(world, {
      x: world.player.x + Math.cos(a) * dist,
      z: world.player.z + Math.sin(a) * dist,
      hp, maxHp: hp,
    });
    world.monsters.push(m);
    world.all.push(m);
    out.push(m);
  }
  rebuildHash(world);
  return out;
}

function rebuildHash(world) {
  if (world.hash && typeof world.hash.rebuild === 'function') world.hash.rebuild(world.all);
}

/**
 * 木桩怪物：结构兼容 spawnMonster 的产物（AI / 眩晕 / stats 都在）。
 * 用 spawnMonster 生成再覆盖 HP，保证和真实怪物走同一条 updateMonsters 路径。
 */
function makeDummy(world, overrides = {}) {
  const m = {
    kind: 'monster',
    team: 1,
    id: 'dummy' + (dummySeq++),
    type: 'husk',
    name: '木桩',
    x: 0, z: 0, vx: 0, vz: 0,
    radius: 0.45,
    level: 1,
    hp: 100000,
    maxHp: 100000,
    dead: false,
    rarity: 'normal',
    buffs: [],
    stats: {},
    stunTime: 0,
    stunMax: 0,
    ai: { state: 'chase', t: 0, cooldown: 0, windup: 0, stuckT: 0, farT: 0 },
    anim: { state: 'idle', t: 0, dur: 0.3, dir: 0 },
    visual: { color: '#7f9a74', size: 1, shape: 'humanoid' },
    displayName: '木桩',
  };
  return Object.assign(m, overrides);
}
let dummySeq = 0;

/** 造一个"玩家附近的真怪物"（用 spawnMonster，带模板与 AI） */
async function spawnReal(world, templateId = 'husk', x = 2, z = 0, opts = {}) {
  const { spawnMonster } = await load('../src/core/monsters.js');
  const m = spawnMonster(world, templateId, x, z, { level: 1, mods: [], ...opts });
  return m;
}

/** 干净的手工玩家：不依赖 core 的 createPlayer 默认值，避免"技能栏 5 技能"之类的耦合 */
function manualPlayer(overrides = {}) {
  const p = {
    kind: 'player',
    team: 0,
    id: 'p1',
    x: 0, z: 0, vx: 0, vz: 0,
    facing: 0,
    radius: 0.45,
    level: 10,
    hp: 500, maxHp: 500,
    mp: 500, maxMp: 500,
    dead: false,
    buffs: [],
    cooldowns: {},
    stats: { aoeMult: 0, cdrMult: 0, skillLevelBonus: 0 },
    skillBar: [],
    anim: { state: 'idle', t: 0, dur: 0.3, dir: 0 },
  };
  return Object.assign(p, overrides);
}

function skillInst(id, level = 1) {
  return { id, level, cd: 0, active: false, holding: false, tick: 0, elapsed: 0, name: id, icon: '?' };
}

// ===========================================================================
// 1. 战争践踏 stomp
// ===========================================================================
describe('战争践踏 stomp（契约 §3.3）', () => {
  test('技能定义：id/name/icon/manaCost/cooldown/radius/damagePct/armorGain 符合契约', async () => {
    const { SKILLS, SKILL_IDS } = await load('../src/core/skills.js');
    assert.ok(SKILLS.stomp, 'SKILLS.stomp 必须存在');
    const def = SKILLS.stomp;
    assert.equal(def.id, 'stomp');
    assert.equal(def.name, '战争践踏');
    assert.equal(def.icon, '💥', '图标必须是契约规定的 💥（区别于旧 groundSlam 的 🪓）');
    assert.equal(def.kind, 'attack');
    assert.equal(def.manaCost, 14);
    assert.equal(def.cooldown, 7);
    assert.equal(def.castTime, 0.3);
    assert.equal(def.radius, 3.6);
    assert.equal(def.damagePct, 0.9);
    assert.ok(def.armorGain && Number.isFinite(def.armorGain.flat) && Number.isFinite(def.armorGain.per) && Number.isFinite(def.armorGain.dur),
      'armorGain 必须含 flat/per/dur 三个数字');
    assert.ok(def.armorGain.flat > 0, '基础护甲 > 0');
    assert.ok(def.armorGain.per > 0, '每名敌人的护甲 > 0');
    assert.ok(def.armorGain.dur > 0, '持续时长 > 0');
    // 技能等级成长字段（契约 §2.2）
    assert.ok(Math.abs(def.cooldownMultLevel - 0.04) < 1e-9, 'cooldownMultLevel = 0.04');
    assert.ok(Math.abs(def.radiusMultLevel - 0.05) < 1e-9, 'radiusMultLevel = 0.05');
    assert.ok(Math.abs(def.damageMultLevel - 0.08) < 1e-9, 'damageMultLevel = 0.08');
    // 1 号技能是战争践踏
    assert.deepEqual(SKILL_IDS.slice(0, 5), ['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally']);
    // 旧技能 id 彻底消失（改名 = id / 名称 / 图标 / 天赋树 / 渲染全换）
    assert.equal(SKILLS.groundSlam, undefined, '旧 groundSlam 必须被移除');
    assert.equal(SKILLS.stomp.name.includes('裂地'), false);
  });

  test('圆形范围：范围内的敌人受伤 + 被眩晕，范围外完全不受影响', async () => {
    const { SKILLS } = await load('../src/core/skills.js');
    const combat = await load('../src/core/combat.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    p.skillBar = [skillInst('stomp')];
    const r = SKILLS.stomp.radius;
    // 圆内 3 个（任意方向 —— 践踏不是扇形）＋ 圆外 1 个
    const inside = [
      makeDummy(world, { x: p.x + r * 0.35, z: p.z, hp: 1e6, maxHp: 1e6 }),
      makeDummy(world, { x: p.x, z: p.z - r * 0.5, hp: 1e6, maxHp: 1e6 }),
      makeDummy(world, { x: p.x - r * 0.6, z: p.z + r * 0.3, hp: 1e6, maxHp: 1e6 }),
    ];
    const outside = makeDummy(world, { x: p.x + r + 2.2, z: p.z, hp: 1e6, maxHp: 1e6 });
    world.monsters.push(...inside, outside);
    world.all.push(...inside, outside);
    rebuildHash(world);
    const hits = SKILLS.stomp.cast(world, p, { x: p.x + 3, z: p.z }, { bar: p.skillBar[0] });
    assert.equal(hits, 3, `应命中 3 个敌人，实际 ${hits}`);
    for (const m of inside) {
      assert.ok(m.hp < m.maxHp, '范围内的敌人必须受伤');
      assert.ok((m.stunTime || 0) > 0, '范围内的敌人必须被眩晕');
      assert.equal(typeof combat.applyStun, 'function');
    }
    assert.equal(outside.hp, outside.maxHp, '范围外敌人不应受伤');
    assert.ok(!(outside.stunTime > 0), '范围外敌人不应被眩晕');
    // 契约事件：'stomp' { x, z, r, radius, hits, stunned, armor, dur, level, color }
    const evts = eventsOf(world, 'stomp');
    assert.equal(evts.length, 1);
    const e = evts[0];
    for (const k of ['x', 'z', 'r', 'radius', 'hits', 'stunned', 'armor', 'dur', 'level', 'color']) {
      assert.ok(k in e, `stomp 事件缺字段 ${k}`);
    }
    assert.equal(e.hits, 3);
    assert.equal(e.stunned, 3);
    assert.ok(Number.isFinite(e.radius) && e.radius > 0);
    // 事件坐标 = 玩家位置（以自身为圆心）
    assert.ok(Math.abs(e.x - p.x) < 1e-9 && Math.abs(e.z - p.z) < 1e-9, '践踏以玩家为圆心');
    // 震屏事件
    assert.ok(eventsOf(world, 'shake').length >= 1, '践踏要推 shake');
  });

  test('护甲随命中数递增：0 命中也有保底护甲，1/3 命中的护甲按 armorGain 递增', async () => {
    const { SKILLS } = await load('../src/core/skills.js');
    const { flat, per } = SKILLS.stomp.armorGain;
    const world = resetArena(await makeWorld());
    const p = world.player;
    p.skillBar = [skillInst('stomp')];

    /** 只清场、不动玩家位置/护甲属性 */
    const clearMonsters = () => {
      world.monsters.length = 0;
      world.all.length = 0;
      world.all.push(p);
      rebuildHash(world);
    };
    const castAndReadArmor = () => {
      // 清掉上一脚的护甲 buff，单独测量本次
      p.buffs.length = 0;
      if (typeof world.__recalc === 'function') world.__recalc(world, p);
      const hits = SKILLS.stomp.cast(world, p, { x: p.x + 3, z: p.z }, { bar: p.skillBar[0] });
      const b = buffOf(p, 'warStompArmor');
      assert.ok(b, '每次施放都必须有 warStompArmor buff');
      return { hits, armor: b.stats.armor, dur: b.remaining, dur0: b.dur };
    };

    clearMonsters();
    const a0 = castAndReadArmor();
    assert.equal(a0.hits, 0);
    assert.equal(a0.armor, flat, `0 命中应有保底护甲 ${flat}，实际 ${a0.armor}`);

    clearMonsters();
    placeDummies(world, 1, SKILLS.stomp.radius * 0.5);
    const a1 = castAndReadArmor();
    assert.equal(a1.hits, 1);
    assert.equal(a1.armor, flat + per, `1 命中护甲应为 ${flat + per}，实际 ${a1.armor}`);

    clearMonsters();
    placeDummies(world, 3, SKILLS.stomp.radius * 0.5);
    const a3 = castAndReadArmor();
    assert.equal(a3.hits, 3);
    assert.equal(a3.armor, flat + per * 3, `3 命中护甲应为 ${flat + per * 3}，实际 ${a3.armor}`);

    // 严格递增（契约：命中越多护甲越高）
    assert.ok(a0.armor < a1.armor && a1.armor < a3.armor, `护甲必须随命中数递增：${a0.armor}/${a1.armor}/${a3.armor}`);
    // 持续时长（契约 §3.3：dur = armorGain.dur × armorDurMult）
    assert.ok(Math.abs(a1.dur0 - SKILLS.stomp.armorGain.dur) < 1e-6, `持续时长应为 ${SKILLS.stomp.armorGain.dur}，实际 ${a1.dur0}`);
  });

  test('护甲 buff 的 id / 名称 / 图标 / 类型正确，并真实进入 player.stats.armor', async () => {
    const { SKILLS } = await load('../src/core/skills.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    p.skillBar = [skillInst('stomp')];
    placeDummies(world, 2, SKILLS.stomp.radius * 0.5);
    const armorBefore = p.stats.armor;
    SKILLS.stomp.cast(world, p, { x: p.x + 3, z: p.z }, { bar: p.skillBar[0] });
    const b = buffOf(p, 'warStompArmor');
    assert.ok(b, 'buff id 必须是 warStompArmor');
    assert.equal(b.name, '踏地战甲');
    assert.equal(b.icon, '🛡');
    assert.equal(b.type, 'buff');
    assert.ok(b.stats && Number.isFinite(b.stats.armor) && b.stats.armor > 0);
    assert.ok(Math.abs(p.stats.armor - armorBefore - b.stats.armor) < 1e-6,
      `护甲属性应提升 ${b.stats.armor}：${armorBefore} → ${p.stats.armor}`);
  });

  test('连续施放是「刷新」不是叠层：护甲值不累加、只有 1 个 buff、时长被重置', async () => {
    const { SKILLS } = await load('../src/core/skills.js');
    const { updateBuffs } = await load('../src/core/combat.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    p.skillBar = [skillInst('stomp')];
    placeDummies(world, 3, SKILLS.stomp.radius * 0.5);
    const baseArmor = p.stats.armor;

    SKILLS.stomp.cast(world, p, { x: p.x + 3, z: p.z }, { bar: p.skillBar[0] });
    const first = buffOf(p, 'warStompArmor');
    const armorOnce = first.stats.armor;
    const durOnce = first.dur;
    // 先消耗 1 秒，确认时长真的在走
    for (let i = 0; i < 60; i++) updateBuffs(world, p, 1 / 60);
    const remainingAfter1s = buffOf(p, 'warStompArmor').remaining;
    assert.ok(remainingAfter1s < durOnce - 0.8, `buff 剩余时间应随时间递减：${remainingAfter1s}`);

    // 第二次践踏（同样 3 个敌人）
    SKILLS.stomp.cast(world, p, { x: p.x + 3, z: p.z }, { bar: p.skillBar[0] });
    const sameId = p.buffs.filter((x) => x.id === 'warStompArmor');
    assert.equal(sameId.length, 1, `同名 buff 只能有 1 层，实际 ${sameId.length} 层`);
    assert.equal(sameId[0].stats.armor, armorOnce, '再次施放不能叠加护甲');
    assert.ok(Math.abs(p.stats.armor - baseArmor - armorOnce) < 1e-6,
      `护甲属性必须仍是 ${armorOnce} 而非 ${armorOnce * 2}`);
    assert.ok(Math.abs(sameId[0].remaining - durOnce) < 1e-6, `时长必须被刷新回 ${durOnce}，实际 ${sameId[0].remaining}`);
  });

  test('护甲 buff 到期自动移除、护甲属性还原', async () => {
    const { SKILLS } = await load('../src/core/skills.js');
    const { updateBuffs } = await load('../src/core/combat.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    p.skillBar = [skillInst('stomp')];
    const baseArmor = p.stats.armor;
    SKILLS.stomp.cast(world, p, { x: p.x + 3, z: p.z }, { bar: p.skillBar[0] });
    const b = buffOf(p, 'warStompArmor');
    assert.ok(b.stats.armor > 0);
    const steps = Math.ceil((b.dur + 0.5) / DT);
    for (let i = 0; i < steps; i++) updateBuffs(world, p, DT);
    assert.equal(buffOf(p, 'warStompArmor'), null, 'buff 应到期消失');
    assert.ok(Math.abs(p.stats.armor - baseArmor) < 1e-6, `护甲应还原：${baseArmor} vs ${p.stats.armor}`);
  });

  test('天赋 multiplierBonuses 生效：armorPerEnemyMult / armorFlat 放大护甲', async () => {
    const { SKILLS } = await load('../src/core/skills.js');
    const { flat, per } = SKILLS.stomp.armorGain;
    const world = resetArena(await makeWorld());
    const p = world.player;
    p.skillBar = [skillInst('stomp')];
    placeDummies(world, 2, SKILLS.stomp.radius * 0.5);
    // 模拟 app 写入的天赋聚合（契约 §2.1）
    p.skillMods = {
      stomp: {
        damageMult: 1, radiusMult: 1, cooldownMult: 1,
        multiplierBonuses: { stunDurMult: 1, armorPerEnemyMult: 1.5, armorDurMult: 1.25 },
        flags: {}, stats: {}, ranks: {}, nodes: [],
      },
    };
    // armorFlat 走 flatBonuses / stats.armorFlat 两条路都能被读到
    p.skillMods.stomp.flatBonuses = { armorFlat: 10 };
    SKILLS.stomp.cast(world, p, { x: p.x + 3, z: p.z }, { bar: p.skillBar[0] });
    const b = buffOf(p, 'warStompArmor');
    const expect = Math.round((flat + per * 2) * 1.5 + 10);
    assert.equal(b.stats.armor, expect, `期望 (flat+per*2)*1.5+10=${expect}，实际 ${b.stats.armor}`);
    assert.ok(Math.abs(b.dur - SKILLS.stomp.armorGain.dur * 1.25) < 1e-6, `持续时长应 ×1.25，实际 ${b.dur}`);
  });

  test('通过 tryCast 施放：扣蓝 14、进入 7 秒冷却、推 skillCast(skillId=stomp)', async () => {
    const { tryCast, SKILLS } = await load('../src/core/skills.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    p.skillBar = [skillInst('stomp')];
    const mp0 = p.mp;
    assert.equal(tryCast(world, p, 'stomp', { x: p.x + 3, z: p.z }), true);
    assert.ok(Math.abs(p.mp - (mp0 - SKILLS.stomp.manaCost)) < 1e-6, `应扣 ${SKILLS.stomp.manaCost} 法力`);
    assert.ok(p.cooldowns.stomp > SKILLS.stomp.cooldown - 0.01, `应进入 ${SKILLS.stomp.cooldown}s 冷却，实际 ${p.cooldowns.stomp}`);
    const cast = eventsOf(world, 'skillCast');
    assert.equal(cast.length, 1);
    assert.equal(cast[0].skillId, 'stomp');
    // 冷却中不能再放
    assert.equal(tryCast(world, p, 'stomp', { x: p.x + 3, z: p.z }), false);
  });
});

// ===========================================================================
// 2. 眩晕
// ===========================================================================
describe('眩晕（契约 §3.6）', () => {
  test('applyStun：stunTime 生效、推 stun 事件（target.stunTime / stunMax 供渲染）', async () => {
    const { applyStun } = await load('../src/core/combat.js');
    const world = resetArena(await makeWorld());
    const m = makeDummy(world, { x: 3, z: 0, stunResist: 0 });
    world.monsters.push(m);
    world.all.push(m);
    rebuildHash(world);
    const ok = applyStun(world, m, 1.5, 'stomp');
    assert.equal(ok, true);
    assert.ok(Math.abs(m.stunTime - 1.5) < 1e-9, `stunTime=${m.stunTime}`);
    assert.ok(m.stunMax >= m.stunTime, 'stunMax 必须 >= stunTime');
    const evts = eventsOf(world, 'stun');
    assert.equal(evts.length, 1);
    assert.equal(evts[0].target, m);
    assert.equal(evts[0].sourceSkill, 'stomp');
    assert.ok(evts[0].dur > 0);
    // 施法来源技能名可以不同（参数化），但契约要求 target.stunTime / target.stunMax 透出
    assert.ok('stunTime' in evts[0] && 'stunMax' in evts[0]);
  });

  test('被眩晕的怪物在 updateMonsters 后不再移动、不攻击', async () => {
    const { applyStun } = await load('../src/core/combat.js');
    const { updateMonsters } = await load('../src/core/monsters.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    // 一只在 3 单位外的真怪：正常会追过来
    const m = await spawnReal(world, 'husk', p.x + 3, p.z);
    m.stunResist = 0;
    applyStun(world, m, 2.0, 'stomp');
    const x0 = m.x, z0 = m.z;
    let attacked = false;
    const hp0 = p.hp;
    // 记录攻击事件
    world.events.length = 0;
    for (let i = 0; i < 90; i++) {
      world.time += DT;
      updateMonsters(world, DT);
      if (eventsOf(world, 'hit').some((e) => e.target === p && e.source === m)) attacked = true;
    }
    assert.ok(Math.hypot(m.x - x0, m.z - z0) < 1e-6, `被眩晕的怪不应移动：(${x0.toFixed(2)},${z0.toFixed(2)}) → (${m.x.toFixed(2)},${m.z.toFixed(2)})`);
    assert.equal(m.vx || 0, 0, 'vx 应被清零');
    assert.equal(m.vz || 0, 0, 'vz 应被清零');
    assert.equal(attacked, false, '被眩晕的怪不应攻击');
    assert.equal(p.hp, hp0, '玩家不应掉血');
    assert.ok(m.stunTime > 0, '1.5 秒后仍在眩晕中（总时长 2.0）');
  });

  test('眩晕结束后怪物恢复追击；stunTime 归零时推 stunEnd', async () => {
    const { applyStun } = await load('../src/core/combat.js');
    const { updateMonsters } = await load('../src/core/monsters.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    const m = await spawnReal(world, 'husk', p.x + 5, p.z);
    m.stunResist = 0;
    applyStun(world, m, 0.5, 'stomp');
    world.events.length = 0;
    // 0.7 秒：眩晕结束
    for (let i = 0; i < 42; i++) { world.time += DT; updateMonsters(world, DT); }
    assert.equal(eventsOf(world, 'stunEnd').length, 1, 'stunTime 归零时应推一次 stunEnd');
    assert.equal(m.stunTime, 0);
    const x0 = m.x, z0 = m.z;
    for (let i = 0; i < 60; i++) { world.time += DT; updateMonsters(world, DT); }
    assert.ok(Math.hypot(m.x - x0, m.z - z0) > 0.5, '眩晕结束后应恢复移动');
  });

  test('Boss 眩晕时长被抗性打折（约 40%），普通怪不打折', async () => {
    const { applyStun } = await load('../src/core/combat.js');
    const world = resetArena(await makeWorld());
    const normal = makeDummy(world, { x: 3, z: 0, rarity: 'normal', stunResist: 0 });
    const boss = makeDummy(world, { x: 5, z: 0, rarity: 'boss', isBoss: true, stunResist: 0.6 });
    applyStun(world, normal, 1.0, 'stomp');
    applyStun(world, boss, 1.0, 'stomp');
    assert.ok(Math.abs(normal.stunTime - 1.0) < 1e-9, `普通怪应不折不扣 1.0s，实际 ${normal.stunTime}`);
    // 契约：dur *= (1 - clamp(stunResist, 0, 0.9))
    assert.ok(Math.abs(boss.stunTime - 0.4) < 1e-9, `Boss（抗性 0.6）应只被眩晕 0.4s，实际 ${boss.stunTime}`);
    assert.ok(boss.stunTime < normal.stunTime * 0.5, 'Boss 眩晕必须明显短于普通怪');
    // 从真实 spawn 出来的 Boss 也带抗性
    const realBoss = await spawnReal(world, 'abyssOverlord', 8, 0, { rarity: 'boss' });
    applyStun(world, realBoss, 1.0, 'stomp');
    assert.ok(realBoss.stunTime > 0.05 && realBoss.stunTime < 1.0 - 1e-6,
      `真实 Boss 的眩晕时长应被抗性打折：${realBoss.stunTime}`);
    // 精英也有抗性（契约规定 0.25）
    const elite = await spawnReal(world, 'husk', 9, 0, { rarity: 'rare' });
    applyStun(world, elite, 1.0, 'stomp');
    assert.ok(elite.stunTime < 1.0 - 1e-6 && elite.stunTime > 0.4, `精英眩晕应打折（0.75s 左右），实际 ${elite.stunTime}`);
  });

  test('践踏对 Boss 的实际眩晕 = stomp 基础眩晕 × (1-抗性)', async () => {
    const { SKILLS, stompStunDuration } = await load('../src/core/skills.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    p.skillBar = [skillInst('stomp')];
    const boss = makeDummy(world, { x: p.x + 2, z: p.z, rarity: 'boss', isBoss: true, stunResist: 0.6, hp: 1e7, maxHp: 1e7 });
    world.monsters.push(boss);
    world.all.push(boss);
    rebuildHash(world);
    const base = typeof stompStunDuration === 'function' ? stompStunDuration(p, SKILLS.stomp) : 1.2;
    SKILLS.stomp.cast(world, p, { x: p.x + 3, z: p.z }, { bar: p.skillBar[0] });
    assert.ok(Math.abs(boss.stunTime - base * 0.4) < 1e-6, `Boss 实际眩晕 ${boss.stunTime}，期望 ${base * 0.4}`);
    const evts = eventsOf(world, 'stun');
    assert.ok(evts.some((e) => e.boss === true), 'stun 事件应标记 boss');
  });
});
// ===========================================================================
// 3. 技能等级（天赋点 + 精炼叠加，上限 5）
// ===========================================================================
describe('技能等级（契约 §0 / §2.2 / §3.4）', () => {
  test('skillProgression 导出契约要求的常量与函数', async () => {
    const m = await load('../src/items/skillProgression.js');
    assert.equal(m.SKILL_LEVEL_CAP, 5, 'SKILL_LEVEL_CAP = 5');
    assert.equal(m.REFINE_MAX, 4, 'REFINE_MAX = 4');
    for (const fn of ['refineCost', 'skillLevelFrom', 'canRefineSkill', 'refineSkill', 'respecCost', 'respecSkill', 'syncSkillInstances']) {
      assert.equal(typeof m[fn], 'function', `缺少导出 ${fn}`);
    }
  });

  test('skillLevelFrom：天赋点数 + 精炼等级 − 1（1 起算），封顶 5', async () => {
    const { skillLevelFrom } = await load('../src/items/skillProgression.js');
    // 无天赋无精炼 = 1 级
    assert.equal(skillLevelFrom({}, 0), 1);
    // 每点 1 个节点 +1 级
    assert.equal(skillLevelFrom({ 'stomp.root': 1 }, 0), 2);
    assert.equal(skillLevelFrom({ 'stomp.root': 1, 'stomp.l1': 1 }, 0), 3);
    // 精炼单独叠加
    assert.equal(skillLevelFrom({}, 1), 2);
    assert.equal(skillLevelFrom({}, 4), 5);
    // 两条线叠加
    assert.equal(skillLevelFrom({ 'stomp.root': 1 }, 1), 3);
    assert.equal(skillLevelFrom({ 'stomp.root': 1, 'stomp.l1': 1 }, 1), 4);
    // 上限 5（天赋点再多也封顶）
    const many = { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1, 'stomp.l3': 1, 'stomp.l4': 1, 'stomp.u': 1 };
    assert.equal(skillLevelFrom(many, 0), 5, '6 个节点也应封顶在 5 级');
    assert.equal(skillLevelFrom(many, 4), 5, '天赋 + 精炼一起封顶 5');
    // 负档位 / 非法值被忽略
    assert.equal(skillLevelFrom({ 'stomp.root': -3 }, -2), 1);
    assert.equal(skillLevelFrom({ 'stomp.root': 0 }, 0), 1);
  });

  test('技能等级 = 天赋节点投入 + 精炼叠加（有效等级），上限 5', async () => {
    const world = resetArena(await makeWorld());
    const { updateCore } = await load('../src/core/index.js');
    const { SKILLS } = await load('../src/core/skills.js');
    const { skillDisplayInfo } = await load('../src/core/skills.js');
    const p = world.player;
    p.skillBar = [skillInst('stomp')];
    p.skillMods = {};
    p.skills = { stomp: { refine: 0, level: 1 } };
    const lvlOf = () => {
      const info = skillDisplayInfo(p, 'stomp');
      assert.ok(info, 'skillDisplayInfo 必须返回对象');
      return info.level;
    };
    assert.equal(lvlOf(), 1, '裸技能 1 级');

    // 3 个天赋节点 → 4 级
    p.skillMods.stomp = {
      damageMult: 1, radiusMult: 1, cooldownMult: 1,
      multiplierBonuses: { stunDurMult: 1, armorPerEnemyMult: 1, armorDurMult: 1 },
      flags: {}, stats: {},
      ranks: { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1 },
      nodes: ['stomp.root', 'stomp.l1', 'stomp.l2'],
    };
    assert.equal(lvlOf(), 4, '3 个天赋节点 → 4 级');
    // 叠加精炼 1 → 5 级
    p.skills.stomp.refine = 1;
    assert.equal(lvlOf(), 5, '3 节点 + 精炼 1 → 5 级');
    // 满级后再加天赋也不会超过 5
    p.skillMods.stomp.ranks = { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1, 'stomp.l3': 1, 'stomp.l4': 1 };
    assert.equal(lvlOf(), 5, '上限必须封在 5');

    // 冷却 / 半径 / 伤害 随等级提升：5 级 vs 1 级
    p.skills.stomp.refine = 4;
    p.skillMods.stomp.ranks = {};
    p.skillMods.stomp.nodes = [];
    const hi = skillDisplayInfo(p, 'stomp');
    p.skills.stomp.refine = 0;
    const lo = skillDisplayInfo(p, 'stomp');
    assert.ok(hi.cooldown < lo.cooldown, `冷却应随等级缩短：Lv1=${lo.cooldown} Lv5=${hi.cooldown}`);
    assert.ok(hi.radius > lo.radius, `半径应随等级变大：Lv1=${lo.radius} Lv5=${hi.radius}`);
    assert.ok(hi.damagePct > lo.damagePct, `伤害应随等级变大：Lv1=${lo.damagePct} Lv5=${hi.damagePct}`);
    // 契约 §2.2 的成长口径：4 级差 → 冷却 -4%×4（封顶 20%）、半径 +5%×4、伤害 +8%×4
    assert.ok(Math.abs(hi.cooldown / lo.cooldown - (1 - 0.04 * 4)) < 0.02, `冷却比 ${hi.cooldown / lo.cooldown}`);
    assert.ok(Math.abs(hi.radius / lo.radius - (1 + 0.05 * 4)) < 1e-6, `半径比 ${hi.radius / lo.radius}`);
    assert.ok(Math.abs(hi.damagePct / lo.damagePct - (1 + 0.08 * 4)) < 1e-6, `伤害比 ${hi.damagePct / lo.damagePct}`);

    // 真正施放时冷却 / 命中半径也随等级变化（不是只有 UI 数字变）
    // 注意：stomp 有 0.3 秒前摇（castLock），两次施放之间必须让前摇+冷却自然走完，
    // 否则第二次会被前摇锁挡下（契约 §3.3 castTime 0.3）。
    const { tryCast } = await load('../src/core/skills.js');
    /** 推进秒数（每帧 updateCore）；advance 会推进 castLock / cooldowns */
    const advance = (seconds) => {
      const n = Math.ceil(seconds / DT) + 2;
      for (let i = 0; i < n; i++) { world.time += DT; updateCore(world, DT); }
    };
    p.skills.stomp.refine = 0;
    p.cooldowns = {};
    advance(1);
    assert.equal(tryCast(world, p, 'stomp', { x: 3, z: 0 }), true, 'Lv1 践踏应施放成功');
    const cdLow = p.cooldowns.stomp;
    assert.ok(cdLow > 0, `Lv1 施放后应有冷却，实际 ${cdLow}`);
    // 等前摇走完 + 冷却自然走完，再切到 5 级施放
    advance((SKILLS.stomp.cooldown || 7) + (SKILLS.stomp.castTime || 0) + 1);
    assert.equal(p.cooldowns.stomp || 0, 0, '冷却应已自然走完（不要手动清空）');
    p.skills.stomp.refine = 4;
    assert.equal(tryCast(world, p, 'stomp', { x: 3, z: 0 }), true, 'Lv5 践踏应施放成功（注意先等前摇）');
    const cdHigh = p.cooldowns.stomp;
    assert.ok(cdHigh > 0, 'Lv5 施放后应有冷却');
    assert.ok(cdHigh < cdLow - 0.1, `5 级技能的实战冷却必须更短：Lv1=${cdLow} Lv5=${cdHigh}`);

    // 高等级践踏的半径更大：1 级打不到的敌人，5 级能打到
    p.skills.stomp.refine = 0;
    p.cooldowns = {};
    p.castLock = 0;
    const far = makeDummy(world, { x: SKILLS.stomp.radius + 0.15, z: 0, hp: 1e6, maxHp: 1e6, stunResist: 0 });
    world.monsters.push(far);
    world.all.push(far);
    rebuildHash(world);
    p.buffs.length = 0;
    SKILLS.stomp.cast(world, p, { x: 3, z: 0 }, { bar: p.skillBar[0] });
    assert.equal(far.hp, far.maxHp, '1 级践踏不应打到半径外的敌人');
    p.skills.stomp.refine = 4;
    p.buffs.length = 0;
    SKILLS.stomp.cast(world, p, { x: 3, z: 0 }, { bar: p.skillBar[0] });
    assert.ok(far.hp < far.maxHp, '5 级践踏半径更大，应打到同一个敌人');
  });

  test('skillDisplayInfo / nextRefineCost / skillCooldownTotal 可在没有 world 时调用', async () => {
    const { skillDisplayInfo, nextRefineCost, skillCooldown } = await load('../src/core/skills.js');
    // 信息极少的 player 也不能崩
    const bare = { skillBar: [], skills: {} };
    const info = skillDisplayInfo(bare, 'stomp');
    assert.equal(info.id, 'stomp');
    assert.equal(info.name, '战争践踏');
    assert.equal(info.icon, '💥');
    assert.equal(info.levelCap, 5);
    assert.ok(info.level >= 1);
    assert.ok(Number.isFinite(info.cooldown) && info.cooldown > 0);
    assert.ok(Number.isFinite(info.radius) && info.radius > 0);
    assert.ok(Number.isFinite(info.damagePct) && info.damagePct > 0);
    assert.ok(Array.isArray(info.refines), 'refines 必须是数组（精炼条 4 格）');
    assert.equal(info.refines.length, 4);
    for (const f of info.refines) {
      for (const k of ['key', 'name', 'desc', 'refine', 'max', 'cost']) assert.ok(k in f, `refine 项缺 ${k}`);
    }
    assert.equal(typeof info.focus, 'string');
    // 满精炼时 nextRefineCost 返回 null
    const maxed = { skillBar: [], skills: { stomp: { refine: 4, level: 5 } } };
    assert.equal(nextRefineCost(maxed, 'stomp'), null, '满精炼时 nextRefineCost 应为 null');
    assert.equal(skillDisplayInfo(maxed, 'stomp').level, 5);
    assert.ok(Number.isFinite(skillCooldown(bare, 'stomp')));
    // 缺 world 也能算（无 world 参数）
    assert.equal(typeof skillCooldown, 'function');
  });

  test('stats.skillLevelBonus 仍然叠加（契约 §2.1 的兼容语义），且总等级封顶', async () => {
    const { skillDisplayInfo } = await load('../src/core/skills.js');
    const p = { skillBar: [skillInst('stomp', 1)], skills: {}, stats: { skillLevelBonus: 2 } };
    assert.equal(skillDisplayInfo(p, 'stomp').level, 3, 'bar.level 1 + skillLevelBonus 2 = 3');
    p.stats.skillLevelBonus = 10;
    assert.ok(skillDisplayInfo(p, 'stomp').level <= 5, 'skillLevelBonus 也不能突破 5 级上限');
  });
});

// ===========================================================================
// 4. 分叉与互斥
// ===========================================================================
describe('分叉天赋与互斥（契约 §3.1 / §3.2）', () => {
  test('skillTree.js 导出新的互斥 API；5 棵树都叫 stomp/whirlwind/warcry/bloodRage/rally', async () => {
    const m = await load('../src/items/skillTree.js');
    for (const fn of ['skillNodeConflict', 'skillBranchOf', 'validateSkillRanks', 'skillEffectsForSkill']) {
      assert.equal(typeof m[fn], 'function', `缺少导出 ${fn}`);
    }
    assert.deepEqual([...m.SKILL_IDS].sort(), ['bloodRage', 'rally', 'stomp', 'warcry', 'whirlwind']);
    assert.ok(!m.SKILL_TREES.groundSlam, 'groundSlam 树必须被移除');
  });

  test('每棵树 9~12 个节点、有 branch/group/requires、4 个互斥组', async () => {
    const { SKILL_TREES, SKILL_IDS } = await load('../src/items/skillTree.js');
    for (const sid of SKILL_IDS) {
      const tree = SKILL_TREES[sid];
      assert.ok(tree.name && tree.name.length > 0, `${sid} 缺 name`);
      assert.ok(Array.isArray(tree.nodes), `${sid} nodes 不是数组`);
      assert.ok(tree.nodes.length >= 9 && tree.nodes.length <= 12, `${sid} 节点数 ${tree.nodes.length} 应在 9-12`);
      for (const n of tree.nodes) {
        assert.ok(n.id.startsWith(`${sid}.`), `${n.id} 前缀不对`);
        assert.ok(n.name && n.desc, `${n.id} 缺 name/desc`);
        assert.ok(n.cost >= 1 && n.maxRank >= 1, `${n.id} cost/maxRank 非法`);
        assert.ok(Array.isArray(n.effects) && n.effects.length > 0, `${n.id} 没有效果`);
        for (const e of n.effects) assert.equal(typeof e.type, 'string');
        assert.ok(Array.isArray(n.requires), `${n.id} requires 不是数组`);
        assert.ok(typeof n.branch === 'string' && n.branch.length > 0, `${n.id} 缺 branch 字段`);
      }
      const root = tree.nodes.filter((n) => !n.requires || !n.requires.length);
      assert.equal(root.length, 1, `${sid} 应恰好 1 个 ROOT（无前置）`);
      assert.equal(root[0].maxRank, 3, `${sid} ROOT 的 maxRank 必须是 3`);
      // 4 个互斥组，各含左/右两个节点
      const groups = {};
      for (const n of tree.nodes) if (n.group) (groups[n.group] = groups[n.group] || []).push(n);
      const names = Object.keys(groups).sort();
      for (const g of ['fork', 'tier2', 'tier3', 'forkFinal']) {
        assert.ok(groups[g], `${sid} 缺少互斥组 ${g}（实际 ${names.join(',')}）`);
        assert.equal(groups[g].length, 2, `${sid} 的互斥组 ${g} 应恰好 2 个节点`);
        const branches = groups[g].map((n) => n.branch);
        assert.ok(branches.some((b) => String(b).includes('left')) && branches.some((b) => String(b).includes('right')),
          `${sid} 的互斥组 ${g} 必须一左一右`);
      }
      // 终极节点存在且不互斥
      const ultimates = tree.nodes.filter((n) => n.branch === 'ultimate');
      assert.equal(ultimates.length, 1, `${sid} 应有 1 个 ultimate 节点`);
      assert.ok(!ultimates[0].group, `${sid} 的终极节点不应属于互斥组`);
    }
  });

  test('L1/R1 的前置是 ROOT（契约 §3.2 的拓扑）', async () => {
    const { SKILL_TREES, SKILL_IDS } = await load('../src/items/skillTree.js');
    for (const sid of SKILL_IDS) {
      const tree = SKILL_TREES[sid];
      const root = tree.nodes.find((n) => !n.requires || !n.requires.length);
      const firsts = tree.nodes.filter((n) => n.group === 'fork');
      assert.equal(firsts.length, 2, `${sid} fork 组应有 2 个节点`);
      for (const n of firsts) assert.deepEqual(n.requires, [root.id], `${n.id} 的前置必须只有 ROOT`);
      // 终极节点的前置里包含 ROOT 与末端专精
      const ult = tree.nodes.find((n) => n.branch === 'ultimate');
      assert.ok(ult.requires.includes(root.id), `${sid} 终极节点 requires 应含 ROOT`);
    }
  });

  test('skillEffectsForSkill：无加点时为中性值，multiplierBonuses 默认 1', async () => {
    const { skillEffectsForSkill } = await load('../src/items/skillTree.js');
    const e = skillEffectsForSkill('stomp', {});
    assert.equal(e.damageMult, 1);
    assert.equal(e.radiusMult, 1);
    assert.equal(e.cooldownMult, 1);
    assert.equal(e.count, 0);
    assert.deepEqual(e.nodes, []);
    assert.ok(e.multiplierBonuses, '必须返回 multiplierBonuses');
    for (const k of ['stunDurMult', 'armorPerEnemyMult', 'armorDurMult']) {
      assert.equal(e.multiplierBonuses[k], 1, `未点任何节点时 ${k} 应为 1`);
    }
    assert.equal(typeof e.flags, 'object');
    assert.equal(typeof e.stats, 'object');
  });

  test('skillEffectsForSkill：只认选中的一支（另一支的节点不生效）', async () => {
    const { skillEffectsForSkill } = await load('../src/items/skillTree.js');
    // 左支 L1 生效 → damage/radius 变化；右支 R1（同 fork 组）必须被忽略
    const leftOnly = skillEffectsForSkill('stomp', { 'stomp.root': 1, 'stomp.l1': 1 });
    const both = skillEffectsForSkill('stomp', { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.r1': 1 });
    const eq = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(eq(leftOnly.damageMult, both.damageMult), `互斥时 R1 不应生效：${leftOnly.damageMult} vs ${both.damageMult}`);
    assert.ok(eq(leftOnly.radiusMult, both.radiusMult));
    assert.ok(eq(leftOnly.multiplierBonuses.armorPerEnemyMult, both.multiplierBonuses.armorPerEnemyMult),
      `R1 的 armorPerEnemyMult 不应生效：${leftOnly.multiplierBonuses.armorPerEnemyMult} vs ${both.multiplierBonuses.armorPerEnemyMult}`);
    assert.ok(!both.nodes.includes('stomp.r1'), '冲突节点不应出现在生效节点列表里');

    // 右支生效时，左支的数值类节点同样被忽略
    const rightOnly = skillEffectsForSkill('stomp', { 'stomp.root': 1, 'stomp.r1': 1 });
    assert.ok(rightOnly.multiplierBonuses.armorPerEnemyMult > 1, 'R1 应提升 armorPerEnemyMult');
    assert.ok(eq(rightOnly.damageMult, 1 + 0.1), `右支不应吃到左支的伤害加成：${rightOnly.damageMult}`);
    assert.ok(!rightOnly.nodes.includes('stomp.l1'));

    // 其它技能也遵循同样规则（逐层互斥）
    const wwLeft = skillEffectsForSkill('whirlwind', { 'whirlwind.root': 1, 'whirlwind.l1': 1 });
    const wwBoth = skillEffectsForSkill('whirlwind', { 'whirlwind.root': 1, 'whirlwind.l1': 1, 'whirlwind.r1': 1 });
    assert.ok(Math.abs(wwLeft.radiusMult - wwBoth.radiusMult) < 1e-9, 'whirlwind：互斥后 r1 的半径加成不应生效');
  });

  test('skillNodeConflict：同组已选则返回冲突信息，不同组/未选返回 null', async () => {
    const { skillNodeConflict, SKILL_TREES } = await load('../src/items/skillTree.js');
    const tree = SKILL_TREES.stomp;
    // 没点任何节点 → 不冲突
    assert.equal(skillNodeConflict(tree, {}, 'stomp.l1'), null);
    // 点了 L1 再点 R1 → 冲突
    const c1 = skillNodeConflict(tree, { 'stomp.l1': 1 }, 'stomp.r1');
    assert.ok(c1, '同组第二个节点必须报冲突');
    assert.equal(c1.group, 'fork');
    assert.equal(c1.takenNodeId, 'stomp.l1');
    assert.ok(c1.takenName && c1.takenName.length > 0, '冲突信息要带已选节点名（UI tooltip 用）');
    // 反过来也一样
    const c2 = skillNodeConflict(tree, { 'stomp.r1': 1 }, 'stomp.l1');
    assert.equal(c2.takenNodeId, 'stomp.r1');
    // 不同组不冲突：点了 L1 仍可点 L2（tier2 组）
    assert.equal(skillNodeConflict(tree, { 'stomp.l1': 1 }, 'stomp.l2'), null);
    // 终极节点不互斥
    assert.equal(skillNodeConflict(tree, { 'stomp.l4': 1 }, 'stomp.u'), null);
    // 支持技能 id 字符串 + 短名
    assert.ok(skillNodeConflict('stomp', { l2: 1 }, 'r2'), '短名写法也要能查出冲突');
    // 重复点自己不算冲突（加点升档）
    assert.equal(skillNodeConflict(tree, { 'stomp.l1': 1 }, 'stomp.l1'), null);
  });

  test('validateSkillRanks：合法的 ranks 通过，互斥/前置/超档被报出来并给出 fixedRanks', async () => {
    const { validateSkillRanks } = await load('../src/items/skillTree.js');
    const ok = { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1, 'stomp.l3': 1, 'stomp.l4': 1 };
    const r0 = validateSkillRanks('stomp', ok);
    assert.equal(r0.ok, true, `合法 ranks 应通过，reason=${r0.reason}`);
    assert.equal(r0.reason, '');
    assert.deepEqual(r0.fixedRanks, ok, '合法数据 fixedRanks 不应被改动');
    // 空 ranks 也合法
    assert.equal(validateSkillRanks('stomp', {}).ok, true);
    // 互斥：L1 + R1 同时点 → 非法
    const r1 = validateSkillRanks('stomp', { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.r1': 1 });
    assert.equal(r1.ok, false, '同组两点应判非法');
    assert.ok(r1.reason.length > 0, '非法时必须给 reason');
    assert.ok(!r1.fixedRanks['stomp.r1'], `修好的副本里应剔除冲突节点：${JSON.stringify(r1.fixedRanks)}`);
    // 前置缺失：只点 L2（需要 L1）→ 非法
    const r2 = validateSkillRanks('stomp', { 'stomp.l2': 1 });
    assert.equal(r2.ok, false, '前置缺失应判非法');
    assert.ok(!r2.fixedRanks['stomp.l2'], '修好的副本里应剔除前置缺失的节点');
    // 超档：ROOT maxRank=3，写 9 → 非法（或被裁剪）
    const r3 = validateSkillRanks('stomp', { 'stomp.root': 9 });
    assert.equal(r3.ok, false, '超出 maxRank 应判非法');
    assert.ok((r3.fixedRanks['stomp.root'] || 0) <= 3, '修好的副本里档位应被裁剪');
    // 未知技能
    const r4 = validateSkillRanks('nope', {});
    assert.equal(r4.ok, false);
  });

  test('短名/全名混写同一节点时取最大值（防止以后回退）', async () => {
    const { validateSkillRanks, skillEffectsForSkill, skillNodeById } = await load('../src/items/skillTree.js');
    // { root: 1, 'stomp.root': 3 } → ROOT 应算 3 档（而不是被后写的 1 覆盖）
    const mixed = { root: 1, 'stomp.root': 3 };
    const eff = skillEffectsForSkill('stomp', mixed);
    assert.equal(eff.ranks['stomp.root'], 3, `混写时应取最大值 3，实际 ${eff.ranks['stomp.root']}`);
    // validate：3 档在 maxRank(=3) 之内，不应报超档
    const v = validateSkillRanks('stomp', mixed);
    assert.equal(v.ok, true, `混写且不超档时应合法，reason=${v.reason} / problems=${JSON.stringify(v.problems)}`);
    assert.equal(v.fixedRanks['stomp.root'], 3, 'fixedRanks 也应保留最大值');
    // 反过来写（全名在前、短名在后）结果一致
    const eff2 = skillEffectsForSkill('stomp', { 'stomp.root': 3, root: 1 });
    assert.equal(eff2.ranks['stomp.root'], 3, '顺序不影响取最大值');
    // 数值确实按 3 档结算
    const root = skillNodeById('stomp.root');
    const per = (root.effects || []).filter((e) => e.type === 'damageMult').reduce((a, e) => a + e.value, 0);
    assert.equal(eff.damageMult, Math.round((1 + per * 3) * 1000) / 1000, '伤害应按 3 档结算');
    // 超档混写：{ root: 1, 'stomp.root': 9 } → 取 9 但裁剪到 maxRank，且 validate 报超档
    const eff3 = skillEffectsForSkill('stomp', { root: 1, 'stomp.root': 9 });
    assert.equal(eff3.ranks['stomp.root'], root.maxRank, '超档应被裁到 maxRank');
    assert.equal(validateSkillRanks('stomp', { root: 1, 'stomp.root': 9 }).ok, false, '超档混写应判非法');
  });

  test('5 棵树全部连通：每个节点都能从 ROOT 沿 requires 到达', async () => {
    const { SKILL_TREES, SKILL_IDS } = await load('../src/items/skillTree.js');
    for (const sid of SKILL_IDS) {
      const tree = SKILL_TREES[sid];
      const byId = Object.fromEntries(tree.nodes.map((n) => [n.id, n]));
      const root = tree.nodes.find((n) => !n.requires || !n.requires.length);
      assert.ok(root, `${sid} 缺 ROOT`);
      // 正向 BFS（requires 视为「指向父节点」的边）
      const seen = new Set([root.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of tree.nodes) {
          if (seen.has(n.id)) continue;
          if ((n.requires || []).some((r) => seen.has(byId[r] ? r : `${sid}.${r}`))) { seen.add(n.id); grew = true; }
        }
      }
      const missing = tree.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
      assert.deepEqual(missing, [], `${sid} 存在无法从 ROOT 到达的节点：${missing.join(',')}`);
      // 所有 requires 都必须指向本树里存在的节点（拼错 = 永远点不了）
      for (const n of tree.nodes) {
        for (const r of n.requires) {
          assert.ok(byId[r] || byId[`${sid}.${r}`], `${n.id} 的前置 ${r} 不存在`);
        }
      }
    }
  });

  test('skillBranchOf：返回 core/left/right/leftDeep/rightDeep/ultimate', async () => {
    const { skillBranchOf, SKILL_TREES, SKILL_IDS } = await load('../src/items/skillTree.js');
    const allow = new Set(['core', 'left', 'right', 'leftDeep', 'rightDeep', 'ultimate']);
    for (const sid of SKILL_IDS) {
      const tree = SKILL_TREES[sid];
      for (const n of tree.nodes) {
        assert.ok(allow.has(skillBranchOf(tree, n.id)), `${sid}.${n.id} 分支非法`);
      }
    }
    assert.equal(skillBranchOf(SKILL_TREES.stomp, 'stomp.root'), 'core');
  });
});

// ===========================================================================
// 5. 精炼与重置
// ===========================================================================
describe('精炼与重置（契约 §3.4）', () => {
  /** 造一个最小 inv/player 组合 */
  async function makeInvPlayer() {
    const invMod = await load('../src/game/inventory.js');
    const inv = invMod.createInventory();
    inv.skillRanks = inv.skillRanks || {};
    inv.skillRefine = inv.skillRefine || {};
    inv.skillOrbs = 0;
    const player = manualPlayer({ skillBar: [skillInst('stomp')], skills: {} });
    return { inv, player };
  }

  test('refineCost 花费表：3 / 4 / 6 / 8（不写死浮点，按挡位递增校验）', async () => {
    const { refineCost, REFINE_COSTS } = await load('../src/items/skillProgression.js');
    const costs = [refineCost(1, 0), refineCost(2, 1), refineCost(3, 2), refineCost(4, 3)];
    assert.deepEqual(costs, [3, 4, 6, 8], `精炼花费应为 3/4/6/8，实际 ${costs.join(',')}`);
    if (Array.isArray(REFINE_COSTS)) assert.deepEqual([...REFINE_COSTS], [3, 4, 6, 8]);
    assert.equal(refineCost(5, 4), 0, '满级时花费为 0（或 null，见 canRefineSkill）');
  });

  test('canRefineSkill：石头不足 / 满级 都返回 ok=false 且带原因', async () => {
    const { canRefineSkill, refineCost } = await load('../src/items/skillProgression.js');
    const { inv, player } = await makeInvPlayer();
    const cost = refineCost(1, 0);
    // 一颗石头都没有
    let r = canRefineSkill(inv, player, 'stomp');
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.reason.length > 0, '失败必须给原因');
    assert.equal(r.cost, cost);
    assert.equal(r.have, 0);
    // 差 1 颗
    inv.skillOrbs = cost - 1;
    r = canRefineSkill(inv, player, 'stomp');
    assert.equal(r.ok, false, '石头差 1 颗时不可精炼');
    // 刚好够
    inv.skillOrbs = cost;
    r = canRefineSkill(inv, player, 'stomp');
    assert.equal(r.ok, true, `石头刚好够（${cost}）应可精炼，reason=${r.reason}`);
    assert.equal(r.have, cost);
    // 精炼满 4
    inv.skillRefine.stomp = 4;
    inv.skillOrbs = 999;
    r = canRefineSkill(inv, player, 'stomp');
    assert.equal(r.ok, false, '精炼已满时不可精炼');
    assert.ok(/满/.test(r.reason), `满级原因应含「满」，实际「${r.reason}」`);
    // 天赋把等级顶到 5 时也不可精炼（白花石头）
    inv.skillRefine.stomp = 0;
    inv.skillRanks = {
      'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1, 'stomp.l3': 1, 'stomp.l4': 1,
    };
    r = canRefineSkill(inv, player, 'stomp');
    assert.equal(r.ok, false, '技能等级已达上限 5 时不可再精炼');
  });

  test('refineSkill：扣除精炼石、精炼等级 +1、写回技能实例等级（等级封顶 5）', async () => {
    const { refineSkill, canRefineSkill, refineCost, skillLevelFrom } = await load('../src/items/skillProgression.js');
    const { inv, player } = await makeInvPlayer();
    const cost1 = refineCost(1, 0);
    inv.skillOrbs = cost1 + 5;
    const before = inv.skillOrbs;
    assert.equal(refineSkill(inv, player, 'stomp'), true, '石头足够时应成功');
    assert.equal(inv.skillRefine.stomp, 1);
    assert.equal(inv.skillOrbs, before - cost1, `应扣 ${cost1} 颗`);
    assert.equal(player.skillBar[0].level, skillLevelFrom({}, 1), '实例等级应同步为 2');
    assert.equal(player.skillBar[0].refine, 1);
    assert.equal(player.skills.stomp.level, 2, 'player.skills[skillId].level 也要同步');
    // 余额不足时失败且不扣款
    inv.skillOrbs = 0;
    const snapshot = JSON.stringify({ refine: inv.skillRefine, orbs: inv.skillOrbs });
    assert.equal(refineSkill(inv, player, 'stomp'), false);
    assert.equal(JSON.stringify({ refine: inv.skillRefine, orbs: inv.skillOrbs }), snapshot, '失败不能改数据');
    assert.equal(canRefineSkill(inv, player, 'stomp').ok, false);
    // 一路精炼到 4 再精炼失败
    inv.skillOrbs = 1000;
    while ((inv.skillRefine.stomp || 0) < 4) assert.equal(refineSkill(inv, player, 'stomp'), true);
    assert.equal(inv.skillRefine.stomp, 4);
    assert.equal(refineSkill(inv, player, 'stomp'), false, '精炼 4 级后再精炼必须失败');
    // 技能等级不超过 5
    assert.ok(player.skillBar[0].level <= 5);
  });

  test('respecCost = 2 + 已点节点数；respecSkill 退还技能点并清除该技能节点（保留精炼）', async () => {
    const { respecSkill, respecCost, refineSkill } = await load('../src/items/skillProgression.js');
    const { skillPointsFor } = await load('../src/game/app.js');
    const { inv, player } = await makeInvPlayer();
    // [Lead 拍板口径] respecCost 是纯函数，不读全局状态：
    //   respecCost(skillId)         → 2（UI 按钮显示用）
    //   respecCost(skillId, ranks)  → 2 + 已点节点数
    //   respecCost(skillId, inv)    → 2 + inv.skillRanks 里该技能的节点数
    assert.equal(respecCost('stomp'), 2, `单参数时应为 2，实际 ${respecCost('stomp')}`);
    inv.skillRanks = { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1 };
    assert.equal(respecCost('stomp', inv.skillRanks), 2 + 3, `传 ranks：3 个节点时应为 5，实际 ${respecCost('stomp', inv.skillRanks)}`);
    assert.equal(respecCost('stomp', inv), 2 + 3, `传 inv：3 个节点时应为 5，实际 ${respecCost('stomp', inv)}`);
    inv.skillRanks['whirlwind.root'] = 1;
    assert.equal(respecCost('stomp', inv.skillRanks), 5, '其它技能的节点不计入本技能的重置花费');
    assert.equal(respecCost('stomp', inv), 5, '传 inv 时其它技能也不计入');
    assert.equal(respecCost('stomp'), 2, '纯函数：单参数永远只返回基础花费 2，不读 inv');

    // 先精炼 1 级（重置不应退还精炼）
    inv.skillOrbs = 100;
    refineSkill(inv, player, 'stomp');
    assert.equal(inv.skillRefine.stomp, 1);

    const orbs0 = inv.skillOrbs;
    const before = { root: inv.skillRanks['stomp.root'], l1: inv.skillRanks['stomp.l1'], ww: inv.skillRanks['whirlwind.root'] };
    assert.equal(respecSkill(inv, player, 'stomp'), true, '石头足够时应成功');
    assert.equal(inv.skillOrbs, orbs0 - 5, `重置应扣 5 颗石头，实际扣 ${orbs0 - inv.skillOrbs}`);
    assert.equal(inv.skillRanks['stomp.root'], undefined, '该技能的节点应被清空');
    assert.equal(inv.skillRanks['stomp.l1'], undefined);
    assert.equal(inv.skillRanks['whirlwind.root'], before.ww, '其它技能的天赋不受影响');
    assert.equal(inv.skillRefine.stomp, 1, '重置天赋保留精炼等级（契约 §3.4）');
    assert.equal(player.skillBar[0].level, 2, '等级回到 1 + 精炼 1 = 2');
    // 技能点退回到全局池：用 app 的统计口径验证（inv.skillRanks 一空，可用点数就回来了）
    const game = { inv, world: { player } };
    assert.ok(skillPointsFor(game, 'stomp') >= 0);
    // 没点过天赋时重置失败（不白花石头）
    const orbs1 = inv.skillOrbs;
    assert.equal(respecSkill(inv, player, 'stomp'), false, '没点天赋时重置应失败');
    assert.equal(inv.skillOrbs, orbs1);
  });

  test('同步：syncSkillInstances 把等级/精炼写回技能栏实例', async () => {
    const { syncSkillInstances } = await load('../src/items/skillProgression.js');
    const { inv, player } = await makeInvPlayer();
    player.skillBar = [skillInst('stomp'), skillInst('whirlwind')];
    inv.skillRanks = { 'stomp.root': 1, 'stomp.l1': 1 };
    inv.skillRefine = { whirlwind: 2 };
    syncSkillInstances(inv, player);
    assert.equal(player.skillBar[0].level, 3, 'stomp：2 节点 + 精炼 0 = 3 级');
    assert.equal(player.skillBar[0].refine, 0);
    assert.equal(player.skillBar[1].level, 3, 'whirlwind：0 节点 + 精炼 2 = 3 级');
    assert.equal(player.skillBar[1].refine, 2);
    assert.equal(player.skills.stomp.level, 3);
    assert.equal(player.skills.whirlwind.refine, 2);
  });
});

// ===========================================================================
// 5.5 回归：killEntity 的参数顺序兜底（core-dev 加的防护）
// ===========================================================================
describe('回归：killEntity 参数顺序（防止误杀玩家）', () => {
  test('killEntity(world, player, monster) 这种"参数写反"的调用不会让玩家暴毙', async () => {
    const { killEntity } = await load('../src/core/combat.js');
    const world = resetArena(await makeWorld());
    const p = world.player;
    const hp0 = p.hp;
    const dummy = makeDummy(world, { x: p.x + 1, z: p.z, hp: 10, maxHp: 10, xp: 5 });
    world.monsters.push(dummy);
    world.all.push(dummy);
    rebuildHash(world);
    // 参数顺序写反：把玩家当成 killer、把怪物当成被击杀者（这是 killEntity 的**正常**签名，
    // 真正写反的是 killEntity(world, monster, player) —— 两种都试一遍，玩家都不能死）
    killEntity(world, p, dummy);
    assert.equal(dummy.dead, true, '怪应该被击杀');
    assert.equal(p.dead, false, '玩家不能被误杀');
    assert.equal(p.hp, hp0, '玩家血量不能变');
    // 真正写反的调用：第一个参数是怪物、第二个是玩家
    const dummy2 = makeDummy(world, { x: p.x + 1, z: p.z, hp: 10, maxHp: 10, xp: 5 });
    world.monsters.push(dummy2);
    world.all.push(dummy2);
    rebuildHash(world);
    killEntity(world, dummy2, p);
    assert.equal(p.dead, false, '参数写反时玩家也不能死');
    assert.equal(p.hp, hp0, '参数写反时玩家血量不能变');
    assert.equal(dummy2.dead, true, '参数写反时仍应击杀那只怪（兜底后语义仍然正确）');
    // 玩家仍然活着、还能继续跑一帧
    world.time += DT;
    const { updateCore } = await load('../src/core/index.js');
    updateCore(world, DT);
    assert.equal(p.dead, false);
  });
});

// ===========================================================================
// 6. 技能精炼石：掉落（core/loot.js）与自动拾取（app）
// ===========================================================================
describe('技能精炼石掉落与拾取（契约 §3.5）', () => {
  test('击杀普通怪：world.items 里按 6% 概率出现 kind==="skillOrb" 的掉落', async () => {
    const { killEntity } = await load('../src/core/combat.js');
    const world = resetArena(await makeWorld({ seed: 777 }));
    world.__coreRollLoot = (w, m) => ({});  // 兜底：不让核心钩子干扰我们直接调 killEntity
    const { rollLoot } = await load('../src/core/loot.js');
    world.__rollLoot = null;
    world.__coreRollLoot = (w, m) => rollLoot(w, m);
    let kills = 0, orbKills = 0, totalOrbs = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const m = makeDummy(world, { x: 5 + (i % 7), z: 5, rarity: 'normal', level: 1, xp: 0, hp: 1 });
      m.dead = false;
      world.items.length = 0;
      killEntity(world, world.player, m);
      kills++;
      const orbs = world.items.filter((d) => d && d.kind === 'skillOrb');
      if (orbs.length) {
        orbKills++;
        for (const o of orbs) {
          totalOrbs += o.amount || 0;
          assert.ok(Number.isFinite(o.x) && Number.isFinite(o.z), 'skillOrb 掉落必须有坐标');
          assert.ok(o.amount >= 1, `skillOrb.amount 必须 >= 1，实际 ${o.amount}`);
          assert.ok(o.item === undefined, 'skillOrb 不是装备掉落（不应带 item 字段）');
        }
      }
    }
    const rate = orbKills / kills;
    assert.ok(rate > 0.03 && rate < 0.10, `普通怪精炼石掉落率应约 6%，实际 ${(rate * 100).toFixed(2)}%（${orbKills}/${kills}）`);
    assert.ok(totalOrbs >= orbKills, '每份掉落至少 1 颗');
  });

  test('Boss 必掉精炼石（一次给多颗），精英掉率明显更高', async () => {
    const { killEntity } = await load('../src/core/combat.js');
    const { rollLoot } = await load('../src/core/loot.js');
    const world = resetArena(await makeWorld());
    world.__rollLoot = null;
    world.__coreRollLoot = (w, m) => rollLoot(w, m);
    // Boss：100% 掉，且 amount 总和 >= 2（契约：一次给 3 个）
    for (let i = 0; i < 20; i++) {
      const boss = makeDummy(world, { x: 5, z: 5, rarity: 'boss', isBoss: true, elite: true, level: 5, xp: 0 });
      world.items.length = 0;
      killEntity(world, world.player, boss);
      const orbs = world.items.filter((d) => d && d.kind === 'skillOrb');
      assert.ok(orbs.length >= 1, `Boss 第 ${i + 1} 次击杀必须掉精炼石`);
      const sum = orbs.reduce((a, o) => a + (o.amount || 0), 0);
      assert.ok(sum >= 2, `Boss 一次应给多颗精炼石，实际 ${sum}`);
    }
    // 精英（rare）：35% 左右
    let rareKills = 0, rareHit = 0;
    for (let i = 0; i < 2000; i++) {
      const e = makeDummy(world, { x: 5, z: 5, rarity: 'rare', elite: true, level: 1, xp: 0 });
      world.items.length = 0;
      killEntity(world, world.player, e);
      rareKills++;
      if (world.items.some((d) => d && d.kind === 'skillOrb')) rareHit++;
    }
    const rate = rareHit / rareKills;
    assert.ok(rate > 0.22 && rate < 0.48, `精英精炼石掉率应约 35%，实际 ${(rate * 100).toFixed(1)}%`);
  });

  test('app 自动拾取：靠近的精炼石进 inv.skillOrbs，并从 world.items 移除（1.6 半径内）', async () => {
    const app = await load('../src/game/app.js');
    const game = app.createGame({ seed: 2024, tier: 1 });
    game.ui = makeNullUI();
    const p = game.world.player;
    const before = game.inv.skillOrbs || 0;
    game.world.items.length = 0;
    const drop = { kind: 'skillOrb', amount: 2, x: p.x + 0.5, z: p.z + 0.4, uid: 'orb-1' };
    game.world.items.push(drop);
    const far = { kind: 'skillOrb', amount: 5, x: p.x + 40, z: p.z, uid: 'orb-2' };
    game.world.items.push(far);
    app.updateGame(game, DT, emptyInput());
    assert.equal(game.inv.skillOrbs, before + 2, `拾取后应 +2（${before} → ${game.inv.skillOrbs}）`);
    assert.ok(!game.world.items.includes(drop), '拾取后掉落必须从世界移除');
    assert.ok(game.world.items.includes(far), '远处的精炼石不应被拾取');
    // 事件：skillOrbGain { amount, total }
    const gained = game.world.events.filter((e) => e && e.type === 'skillOrbGain');
    assert.ok(gained.length >= 1, '应推 skillOrbGain 事件');
    assert.equal(gained[gained.length - 1].amount, 2);
    assert.equal(gained[gained.length - 1].total, before + 2);
  });

  test('自动拾取不需要背包空位（精炼石不占格子）', async () => {
    const app = await load('../src/game/app.js');
    const game = app.createGame({ seed: 2025, tier: 1 });
    game.ui = makeNullUI();
    const p = game.world.player;
    // 把背包塞满
    const itemgen = await load('../src/items/itemgen.js');
    game.inv.bag.length = 0;
    while (game.inv.bag.length < game.inv.bagSize) game.inv.bag.push(itemgen.fallbackItem({ level: 1 }));
    const before = game.inv.skillOrbs || 0;
    game.world.items.push({ kind: 'skillOrb', amount: 1, x: p.x + 0.3, z: p.z });
    app.updateGame(game, DT, emptyInput());
    assert.equal(game.inv.skillOrbs, before + 1, '背包满时精炼石仍应自动拾取');
  });
});

// ===========================================================================
// 7. app 层动作（createGame 真跑 headless）
// ===========================================================================
function emptyInput() {
  return { move: { x: 0, z: 0 }, aim: { x: 0, z: 0 }, attackHeld: false, attackPressed: false, skills: [], dash: false, releaseChannels: false };
}

describe('app 动作：技能升级 / 精炼 / 重置（契约 §4）', () => {
  /** 建 game，清场不刷怪，并把等级拉到指定值 */
  async function newGame(level = 10, seed = 99) {
    const app = await load('../src/game/app.js');
    const game = app.createGame({ seed, tier: 1 });
    game.ui = makeNullUI();
    game.paused = false;
    const world = game.world;
    // 清掉地图上已有的怪，避免干扰
    world.monsters.length = 0;
    world.all.length = 0;
    world.all.push(world.player);
    if (world.hash && world.hash.rebuild) world.hash.rebuild(world.all);
    const p = world.player;
    p.level = level;
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    p.buffs.length = 0;
    p.cooldowns = {};
    world.over = false;
    p.dead = false;
    game.recalcPlayer();
    if (typeof world.__syncTalentPoints === 'function') world.__syncTalentPoints();
    return { app, game };
  }

  const setAvail = (game, n) => {
    // 技能点曲线（Lead 拍板）：skillPointsForLevel(level) = level（每升 1 级 +1 点）
    // 反解「至少 n 点」所需的等级：lv >= n
    const lv = Math.max(1, n);
    game.world.player.level = lv;
    game.recalcPlayer();
    if (typeof game.world.__syncTalentPoints === 'function') game.world.__syncTalentPoints();
  };

  test('app 导出契约要求的 5 个动作', async () => {
    const app = await load('../src/game/app.js');
    for (const fn of ['doSkillRankUp', 'doSkillRefine', 'doSkillRespec', 'syncSkillSystems', 'skillPointsTotal', 'skillPointsFor']) {
      assert.equal(typeof app[fn], 'function', `app.js 缺少导出 ${fn}`);
    }
  });

  test('doSkillRankUp：点数不足返回 false 且不写数据', async () => {
    // 技能点曲线 = 等级（每升 1 级 +1）：Lv.1 也有 1 点，所以先把它花光，构造 avail === 0
    const { app, game } = await newGame(1);
    const inv = game.inv;
    inv.skillRanks = {};
    const total = app.skillPointsTotal(game).total;
    assert.equal(total, 1, `Lv.1 应恰好 1 点技能点（曲线 = 等级），实际 ${total}`);
    assert.equal(app.skillPointsFor(game, 'stomp'), 1, 'Lv.1 角色应有 1 点可用技能点');
    // 花掉唯一的一点
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), true, '第 1 点应能点上去');
    assert.equal(app.skillPointsFor(game, 'stomp'), 0, '花光后应没有可用技能点');
    // 现在再点任何节点都必须被拒，且不产生任何副作用
    const before = JSON.stringify(inv.skillRanks);
    const evtCount = (game.world.events || []).filter((e) => e && e.type === 'skillRankUp').length;
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.l1'), false, '没有点数时必须返回 false');
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), false, '没有点数时连已点节点也不能升档');
    assert.equal(JSON.stringify(inv.skillRanks), before, '失败不能写入 rank');
    assert.equal((game.world.events || []).filter((e) => e && e.type === 'skillRankUp').length, evtCount, '失败不能推事件');
  });

  test('回归：技能点曲线 = 等级（每升 1 级 +1 点）', async () => {
    const { skillPointsForLevel } = await load('../src/game/app.js');
    // Lead 拍板的曲线（保证短局也能点出「分叉」）
    assert.equal(skillPointsForLevel(1), 1, 'Lv.1 = 1');
    assert.equal(skillPointsForLevel(2), 2, 'Lv.2 = 2');
    assert.equal(skillPointsForLevel(3), 3, 'Lv.3 = 3');
    assert.equal(skillPointsForLevel(4), 4, 'Lv.4 = 4');
    assert.equal(skillPointsForLevel(10), 10, 'Lv.10 = 10');
    assert.equal(skillPointsForLevel(14), 14, 'Lv.14 = 14');
    // 单调不减，且每升 1 级恰好 +1（1 级起至少 1 点，否则新玩家开局点不了任何天赋）
    let prev = 0;
    for (let lv = 1; lv <= 30; lv++) {
      const v = skillPointsForLevel(lv);
      assert.ok(v >= prev, `技能点必须随等级单调不减：Lv.${lv - 1}=${prev} → Lv.${lv}=${v}`);
      assert.equal(v, lv, `Lv.${lv} 应等于等级`);
      assert.equal(v - prev, 1, `Lv.${lv - 1} → Lv.${lv} 应恰好 +1 点，实际 +${v - prev}`);
      prev = v;
    }
    // 非法输入兜底（不能返回 NaN / undefined）
    for (const bad of [0, -5, undefined, null, 'abc']) {
      const v = skillPointsForLevel(bad);
      assert.ok(Number.isFinite(v) && v >= 0, `skillPointsForLevel(${String(bad)}) 应返回有限数字，实际 ${v}`);
    }
  });

  test('doSkillRankUp：前置未点返回 false（L1 需要 ROOT）', async () => {
    const { app, game } = await newGame(10);
    setAvail(game, 5);
    game.inv.skillRanks = {};
    assert.ok(app.skillPointsFor(game, 'stomp') >= 1, '应有可用技能点');
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.l1'), false, 'ROOT 没点时 L1 应被拒');
    assert.equal(app.doSkillRankUp(game, 'stomp', 'l2'), false, 'L2 前置（L1）也没点');
    assert.deepEqual(game.inv.skillRanks, {}, '被拒时不能写入任何 rank');
  });

  test('doSkillRankUp：互斥冲突返回 false，且成功加点后技能实例 level 同步', async () => {
    const { app, game } = await newGame(10);
    const p = game.world.player;
    const inv = game.inv;
    setAvail(game, 8);
    inv.skillRanks = {};
    const inst = p.skillBar.find((s) => s && s.id === 'stomp');
    assert.ok(inst, '技能栏里必须有 stomp');
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), true, 'ROOT 应能加点');
    assert.equal(inv.skillRanks['stomp.root'], 1);
    assert.equal(inst.level, 2, '1 个天赋节点 → 技能 2 级（实例 level 必须同步）');
    assert.equal(p.skills.stomp.level, 2, 'player.skills[skillId].level 也必须同步');
    // 左支
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.l1'), true);
    assert.equal(inst.level, 3, '2 个节点 → 3 级');
    // 右支同组 → 互斥，必须被拒
    const before = JSON.stringify(inv.skillRanks);
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.r1'), false, '互斥组已选左支，右支必须被拒');
    assert.equal(JSON.stringify(inv.skillRanks), before, '互斥被拒时不能改数据');
    // 事件：skillRankUp { skillId, name, nodeName, rank, maxRank }
    const evts = (game.world.events || []).filter((e) => e && e.type === 'skillRankUp');
    assert.equal(evts.length, 2, `成功 2 次应推 2 个事件，实际 ${evts.length}`);
    const e = evts[evts.length - 1];
    for (const k of ['skillId', 'name', 'nodeName', 'rank', 'maxRank']) assert.ok(k in e, `skillRankUp 事件缺字段 ${k}`);
    assert.equal(e.skillId, 'stomp');
    assert.equal(e.nodeName.length > 0, true);
    assert.equal(e.rank, 1);
  });

  test('doSkillRankUp：节点满档、未知技能/节点都返回 false', async () => {
    const { app, game } = await newGame(20);
    setAvail(game, 8);
    game.inv.skillRanks = {};
    assert.equal(app.doSkillRankUp(game, 'nope', 'nope.root'), false);
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.nope'), false);
    // ROOT 点满 3 档
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), true);
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), true);
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), true);
    assert.equal(game.inv.skillRanks['stomp.root'], 3);
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), false, '满档后应返回 false');
  });

  test('doSkillRefine：消耗精炼石、余额不足返回 false、技能等级提升', async () => {
    const { app, game } = await newGame(10);
    const inv = game.inv;
    const p = game.world.player;
    const inst = p.skillBar.find((s) => s && s.id === 'stomp');
    inv.skillRanks = {};
    inv.skillRefine = {};
    // 余额不足
    inv.skillOrbs = 0;
    assert.equal(app.doSkillRefine(game, 'stomp'), false, '没有精炼石时必须失败');
    assert.equal(inv.skillRefine.stomp || 0, 0, '失败不能增加精炼等级');
    // 够 1 次
    inv.skillOrbs = 3;
    const lvlBefore = inst.level;
    assert.equal(app.doSkillRefine(game, 'stomp'), true, '3 颗精炼石应能精炼 1 次');
    assert.equal(inv.skillRefine.stomp, 1, '精炼等级 +1');
    assert.equal(inv.skillOrbs, 0, '应扣掉 3 颗');
    assert.ok(inst.level > lvlBefore, `技能实例等级应提升：${lvlBefore} → ${inst.level}`);
    assert.equal(inst.refine, 1, '实例 refine 也要同步');
    const evts = (game.world.events || []).filter((e) => e && e.type === 'skillRefine');
    assert.ok(evts.length >= 1, '应推 skillRefine 事件');
    const e = evts[evts.length - 1];
    for (const k of ['skillId', 'name', 'level', 'refine']) assert.ok(k in e, `skillRefine 事件缺字段 ${k}`);
    assert.equal(e.level, 2);
    // 再精炼需要 4 颗：只有 3 颗 → 失败
    inv.skillOrbs = 3;
    assert.equal(app.doSkillRefine(game, 'stomp'), false, '第二次精炼需要 4 颗，只有 3 颗必须失败');
    assert.equal(inv.skillOrbs, 3, '失败不能扣款');
  });

  test('doSkillRespec：退还技能点、清除该技能节点、保留精炼，并推 skillRespec 事件', async () => {
    const { app, game } = await newGame(10);
    const inv = game.inv;
    const p = game.world.player;
    const inst = p.skillBar.find((s) => s && s.id === 'stomp');
    setAvail(game, 8);
    inv.skillRanks = {};
    inv.skillRefine = {};
    inv.skillOrbs = 100;
    // 点 ROOT + L1，再精炼 1 级
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), true);
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.l1'), true);
    assert.equal(app.doSkillRefine(game, 'stomp'), true);
    const availBefore = app.skillPointsFor(game, 'stomp');
    const levelBefore = inst.level;
    assert.ok(levelBefore >= 4, `3 节点 + 精炼 1 应 >= 4 级，实际 ${levelBefore}`);
    assert.equal(app.doSkillRespec(game, 'stomp'), true, '重置应成功');
    assert.equal(inv.skillRanks['stomp.root'], undefined, '该技能节点应被清空');
    assert.equal(inv.skillRanks['stomp.l1'], undefined);
    assert.equal(inv.skillRefine.stomp, 1, '精炼等级必须保留');
    assert.equal(app.skillPointsFor(game, 'stomp'), availBefore + 2, `技能点应退还 2 点（${availBefore} → ${app.skillPointsFor(game, 'stomp')}）`);
    assert.ok(inst.level < levelBefore, '重置后技能等级应下降');
    const evts = (game.world.events || []).filter((e) => e && e.type === 'skillRespec');
    assert.ok(evts.length >= 1, '应推 skillRespec 事件');
    const e = evts[evts.length - 1];
    for (const k of ['skillId', 'name', 'refunded']) assert.ok(k in e, `skillRespec 事件缺字段 ${k}`);
    assert.equal(e.refunded, 2);
  });

  test('syncSkillSystems：player.skillMods / skills / 实例等级三处一致', async () => {
    const { app, game } = await newGame(10);
    const inv = game.inv;
    const p = game.world.player;
    inv.skillRanks = { 'stomp.root': 1, 'stomp.r1': 1 };
    inv.skillRefine = { stomp: 1 };
    app.syncSkillSystems(game);
    const inst = p.skillBar.find((s) => s && s.id === 'stomp');
    assert.ok(p.skillMods && p.skillMods.stomp, 'player.skillMods[stomp] 必须被写入（契约 §2.1）');
    assert.ok(p.skillMods.stomp.multiplierBonuses, 'skillMods 必须带 multiplierBonuses');
    assert.ok(p.skillMods.stomp.multiplierBonuses.armorPerEnemyMult > 1, '点了右支 R1，armorPerEnemyMult 应 > 1');
    assert.equal(inst.level, 4, '2 节点 + 精炼 1 = 4 级');
    assert.equal(inst.refine, 1);
    assert.equal(p.skills.stomp.level, 4);
    assert.equal(p.skills.stomp.refine, 1);
    // 分支专精（契约 §2.3 + Lead 对齐口径）：
    //   · 首次选支（L1/R1）时 mods.focus 就有值；flags.focusLeft/right 只在点 L4/R4 时置位
    //   · player.skills[skillId] = { level, refine, talentPoints, focus }
    assert.equal(p.skillMods.stomp.focus, 'right', '点右支 R1 → mods.focus 应为 right');
    assert.equal(p.skills.stomp.focus, 'right', 'player.skills.stomp.focus 应同步为 right');
    assert.equal(p.skills.stomp.talentPoints, 2, 'player.skills.stomp.talentPoints 应为已点节点数 2');
    assert.equal(p.skills.stomp.refine, 1);
    const { skillDisplayInfo } = await load('../src/core/skills.js');
    assert.equal(skillDisplayInfo(p, 'stomp').focus, 'right', 'core 的 skillDisplayInfo(...).focus 应能返回 right');
    // 换到左支（先重置）后 focus 应该变成 left
    inv.skillRanks = { 'stomp.root': 1, 'stomp.l1': 1 };
    app.syncSkillSystems(game);
    assert.equal(p.skillMods.stomp.focus, 'left', '只点左支时 focus 应为 left');
    assert.equal(p.skillMods.stomp.flags.focusLeft, true, '只点 L1 时 flags.focusLeft 必须为 true');
    assert.equal(p.skillMods.stomp.flags.focusRight, undefined, '只点 L1 时不应有 flags.focusRight');
    // 再切回右支：[Lead 拍板] flags.focusLeft/focusRight 由当前分支推出：首次选支（L1/R1）就置位
    inv.skillRanks = { 'stomp.root': 1, 'stomp.r1': 1 };
    app.syncSkillSystems(game);
    assert.equal(p.skillMods.stomp.focus, 'right', '切回右支后 focus 应为 right');
    assert.equal(p.skillMods.stomp.flags.focusRight, true, '选右支后 flags.focusRight 必须为 true');
    assert.equal(p.skillMods.stomp.flags.focusLeft, undefined, '选右支后不应有 flags.focusLeft');
  });

  test('headless 跑 60 帧不崩，技能点/精炼石数据保持有限数', async () => {
    const { app, game } = await newGame(6);
    game.ui = makeNullUI();
    for (let i = 0; i < 60; i++) app.updateGame(game, DT, emptyInput());
    const inv = game.inv;
    assert.ok(Number.isFinite(inv.skillOrbs), 'inv.skillOrbs 必须是数字');
    assert.ok(Number.isFinite(app.skillPointsTotal(game).total), 'skillPointsTotal().total 必须是数字');
    assert.ok(Number.isFinite(app.skillPointsTotal(game).avail));
  });
});

// ===========================================================================
// 8. UI（DOM 桩）：技能面板 / 精炼按钮 / 互斥锁定 / 事件提醒 / HUD 光点
// ===========================================================================
describe('UI 技能面板与提醒（契约 §5）', () => {
  /** 安装一次全局 DOM 桩（模块级 document 只能装一次）并装好 UI */
  async function bootUI() {
    const dom = ensureStubDOM();
    const app = await load('../src/game/app.js');
    const game = app.createGame({ seed: 4242, tier: 1 });
    // 清场
    game.world.monsters.length = 0;
    game.world.all.length = 0;
    game.world.all.push(game.world.player);
    game.world.player.level = 12;
    game.inv.skillRanks = {};
    game.inv.skillRefine = {};
    game.inv.skillOrbs = 40;
    game.recalcPlayer();
    if (typeof game.world.__syncTalentPoints === 'function') game.world.__syncTalentPoints();
    const { GameUI } = await load('../src/ui/ui.js');
    const ui = new GameUI(game);
    game.ui = ui;
    game.actions = {
      ...(game.actions || {}),
      takeTalent: (id) => app.doTakeTalent(game, id),
      refundTalent: (id) => app.doRefundTalent(game, id),
      skillRankUp: (sid, nid) => app.doSkillRankUp(game, sid, nid),
      refineSkill: (sid) => app.doSkillRefine(game, sid),
      respecSkill: (sid) => app.doSkillRespec(game, sid),
      skillPointsTotal: () => app.skillPointsTotal(game).avail,
      equipFromBag: () => true, unequip: () => true, sell: () => 1, sellJunk: () => 1, sortBag: () => {},
      revive: () => {}, newMap: () => {}, pickup: () => {},
    };
    return { dom, game, ui, app };
  }

  test('技能面板渲染 5 个技能标签（stomp 在第一个）', async () => {
    const { ui, game } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    ui.openModal('skills');
    openSkills(ui);
    const body = ui.el.modalBody;
    const tabs = body.querySelectorAll('.skill-tab');
    assert.ok(tabs.length >= 5, `技能面板应有 5 个技能标签，实际 ${tabs.length}`);
    const ids = tabs.map((t) => t.dataset.skill || t.getAttribute('data-skill')).filter(Boolean);
    assert.deepEqual(ids.slice(0, 5), ['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally'], `标签顺序=${ids.join(',')}`);
    // 每个标签带图标 + Lv.X
    // 注意：标签里的图标/名称/Lv 是子元素，必须用 textContent（innerHTML 不含子节点文本）
    const html = tabs.map((t) => t.textContent).join('');
    assert.ok(/💥/.test(html), '战争践踏的标签应带 💥 图标');
    assert.ok(/Lv\.\d/.test(html), '标签应显示 Lv.X');
    // stomp 的树渲染出来（分叉节点都在 DOM 里）
    const nodes = body.querySelectorAll('.tree-node');
    const tree = game.inv.skillRanks;
    assert.ok(nodes.length >= 9, `stomp 的分叉树应渲染 >= 9 个节点，实际 ${nodes.length}`);
    void tree;
    ui.closeModals();
  });

  test('技能面板有「精炼」与「重置天赋」按钮，且精炼按钮显示花费', async () => {
    const { ui } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    ui.openModal('skills');
    openSkills(ui);
    const body = ui.el.modalBody;
    // 用属性查询（DOM 桩的 querySelector('.a.b') 只支持简单选择器组合；这里用 [class*=] 更稳）
    const refineBtn = body.querySelector('[class*="refine"]');
    assert.ok(refineBtn, `技能卡必须有精炼按钮（class 含 refine），现有按钮 class：${body.querySelectorAll('button').map((b) => b.className).join(' | ')}`);
    assert.ok(/skill-btn/.test(refineBtn.className), `精炼按钮应带 skill-btn 类，实际 class="${refineBtn.className}"`);
    // 按钮文案（「精炼」+ 消耗数量）由子节点 <span> 承载，用 textContent 读取；允许显示在 title 里作为兜底
    const btnText = (refineBtn.textContent || '') + ' ' + (refineBtn.innerHTML || '') + ' ' + (refineBtn.title || '');
    assert.ok(/精炼/.test(btnText), `精炼按钮文案应含「精炼」，实际「${btnText.trim()}」`);
    assert.ok(/\d/.test(btnText), `精炼按钮应显示消耗数量（颗），实际「${btnText.trim()}」`);
    const respecBtn = body.querySelector('[class*="respec"]');
    assert.ok(respecBtn, '技能卡必须有「重置天赋」按钮（class 含 respec）');
    assert.ok(/skill-btn/.test(respecBtn.className), `重置按钮应带 skill-btn 类，实际 class="${respecBtn.className}"`);
    const respecText = (respecBtn.textContent || '') + ' ' + (respecBtn.innerHTML || '') + ' ' + (respecBtn.title || '');
    assert.ok(/重置/.test(respecText), `重置按钮文案应含「重置」，实际「${respecText.trim()}」`);
    ui.closeModals();
  });

  test('精炼格子 4 个、等级显示、技能点/精炼石在底部栏', async () => {
    const { ui, game } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    game.inv.skillRefine.stomp = 2;
    game.recalcPlayer();
    ui.openModal('skills');
    openSkills(ui);
    const body = ui.el.modalBody;
    const pips = body.querySelectorAll('.sc-pip');
    assert.ok(pips.length === 4, `精炼条应有 4 格，实际 ${pips.length}`);
    const on = pips.filter((p) => p.classList.contains('on'));
    assert.equal(on.length, 2, `精炼 2 级应有 2 格点亮，实际 ${on.length}`);
    const footEl = body.querySelector('.skill-foot') || body;
    const foot = (footEl.textContent || '') + ' ' + (footEl.innerHTML || '') + ' ' + (ui.el.modalFoot.textContent || '');
    assert.ok(/精炼石/.test(foot), '底部栏应显示精炼石数量');
    assert.ok(/技能点/.test(foot), '底部栏应显示可用技能点');
    assert.ok(/互斥/.test(foot), '底部栏应给出互斥说明');
    ui.closeModals();
  });

  test('互斥锁定态：点了左支后右支节点带 locked 样式 + 原因', async () => {
    const { ui, game, app } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    game.world.player.level = 20;
    game.recalcPlayer();
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), true);
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.l1'), true);
    ui.openModal('skills');
    openSkills(ui);
    const body = ui.el.modalBody;
    const treeNodes = body.querySelectorAll('.tree-node');
    assert.ok(treeNodes.length >= 9, `stomp 的分叉树应渲染 >= 9 个节点，实际 ${treeNodes.length}`);
    // 节点标识兼容 data-node="r1" 与 data-node="stomp.r1" 两种写法
    const nodeOf = (key) => treeNodes.find((n) => {
      const dn = n.dataset.node || (n.getAttribute && n.getAttribute('data-node')) || '';
      return dn === key || dn === `stomp.${key}`;
    });
    const r1 = nodeOf('r1');
    assert.ok(r1, '右支 R1 节点必须渲染出来（data-node="stomp.r1" / "r1"）');
    const cls = r1.className;
    assert.ok(/locked|conflict/.test(cls), `选左支后 R1 应为锁定态，class="${cls}"`);
    assert.ok(!/buyable/.test(cls), `R1 不应可点，class="${cls}"`);
    // 锁定原因（tooltip）不能为空
    const tip = r1.title || (r1.getAttribute && r1.getAttribute('title')) || '';
    assert.ok(tip && tip.length > 0, '锁定的节点必须给出原因（title / tooltip）');
    // 左支 L1 已点：taken
    const l1 = nodeOf('l1');
    assert.ok(l1 && /taken/.test(l1.className), `已点的 L1 应带 taken，class="${l1 && l1.className}"`);
    ui.closeModals();
  });

  test('分叉树连线对齐：每条线的两端都落在节点盒子里（不悬空 / 不错位）', async () => {
    const { ui } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    ui.openModal('skills');
    openSkills(ui);
    const body = ui.el.modalBody;

    // 节点坐标写在行内 style（left/top；left 就是盒子中心，盒子用 margin-left 居中）
    const boxes = body.querySelectorAll('.tree-node').map((n) => {
      const s = String(n.getAttribute('style') || '');
      const lx = /left:\s*(-?[\d.]+)px/.exec(s);
      const ly = /top:\s*(-?[\d.]+)px/.exec(s);
      return { x: lx ? Number(lx[1]) : NaN, y: ly ? Number(ly[1]) : NaN };
    });
    assert.ok(boxes.length >= 9, `分叉树应渲染 >= 9 个节点，实际 ${boxes.length}`);
    assert.ok(boxes.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)), '每个节点都应有 left/top 坐标');

    const lines = body.querySelectorAll('.tree-links line');
    assert.ok(lines.length >= 8, `分叉树应画出 >= 8 条连线，实际 ${lines.length}`);

    // 端点约定：x = 盒子中心，y = top + 盒子高度/2。盒子高度实测 44~45px（skill-ui 的 NODE_H_FALLBACK=44），
    // 这里给 6px 容差覆盖字体/缩放造成的几像素差异——只要落进盒子，视觉上就是「接上了」。
    const H = 44;
    const BAND = 6;
    const inBox = (x, y) => boxes.some((b) => Math.abs(b.x - x) <= 2 && y >= b.y - BAND && y <= b.y + H + BAND);
    const loose = [];
    for (const l of lines) {
      const x1 = Number(l.getAttribute('x1'));
      const y1 = Number(l.getAttribute('y1'));
      const x2 = Number(l.getAttribute('x2'));
      const y2 = Number(l.getAttribute('y2'));
      assert.ok([x1, y1, x2, y2].every(Number.isFinite), `连线坐标必须有效，实际 (${x1},${y1})->(${x2},${y2})`);
      if (!inBox(x1, y1) || !inBox(x2, y2)) loose.push(`(${x1},${y1})->(${x2},${y2})`);
    }
    // 旧实现把子节点端固定写成 top-26（悬在节点上方），这条断言就是防它复发
    assert.equal(loose.length, 0, `连线端点必须落在节点盒子里，悬空的连线：${loose.join(' | ')}`);
    ui.closeModals();
  });

  test('ui.onEvents 处理 skillRankUp / skillRefine / skillOrbGain 不抛异常且有日志', async () => {
    const { ui } = await bootUI();
    const before = ui.logLines.length;
    ui.onEvents([
      { type: 'skillRankUp', skillId: 'stomp', name: '战争践踏', nodeName: '震怒', rank: 1, maxRank: 1 },
      { type: 'skillRankUp', skillId: 'stomp', name: '战争践踏', nodeName: '踏地', rank: 2, maxRank: 3 },
      { type: 'skillRefine', skillId: 'stomp', name: '战争践踏', level: 3, refine: 2 },
      { type: 'skillOrbGain', amount: 3, total: 7 },
    ]);
    assert.ok(ui.logLines.length > before, '事件提醒应写进日志');
    const text = ui.logLines.map((l) => (l.node._html || '').replace(/<[^>]*>/g, '')).join('|');
    assert.ok(/战争践踏|踏地|震怒/.test(text), `日志应包含技能/节点名，实际：${text}`);
    assert.ok(/精炼/.test(text), `日志应包含精炼提示，实际：${text}`);
    // 不抛异常（能走到这里就算）
    ui.update(1 / 60);
  });

  test('HUD 技能栏光点角标：有可用技能点 / 可精炼时出现', async () => {
    const { ui, game, app, dom } = await bootUI();
    // dom 桩里给技能栏加一个光点角标节点（ui 自己会建 #skill-notify；找不到就手动建）
    let notify = ui.el.skillNotify || dom.document.getElementById('skill-notify');
    if (!notify && dom.byId.skillbar) {
      notify = dom.document.createElement('div');
      notify.id = 'skill-notify';
      dom.byId.skillbar.appendChild(notify);
    }
    assert.ok(notify, '技能栏上应有光点角标节点（#skill-notify）');
    // 满足条件：有可分配技能点 + 有精炼石
    game.inv.skillOrbs = 99;
    game.world.player.level = 12;
    game.recalcPlayer();
    ui.update(1 / 60);
    const dotState = () => ({ cls: notify.className, text: notify.textContent, html: notify.innerHTML });
    const s1 = dotState();
    assert.ok(!/hidden/.test(s1.cls), `有可分配技能点时光点角标应可见：${JSON.stringify(s1)}`);
    // 花光点数 / 没有精炼石 → 角标隐藏
    game.inv.skillOrbs = 0;
    game.inv.skillRanks = { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1, 'stomp.l3': 1, 'stomp.l4': 1, 'stomp.r1': 1, 'stomp.r2': 1, 'stomp.r3': 1, 'stomp.r4': 1, 'stomp.u': 1 };
    game.world.player.level = 1; // 1 级 = 0 技能点，配合已花光 → 没有任何可分配点
    game.recalcPlayer();
    if (typeof game.world.__syncTalentPoints === 'function') game.world.__syncTalentPoints();
    ui.update(1 / 60);
    const s2 = dotState();
    assert.ok(app.skillPointsFor(game, 'stomp') === 0);
    assert.ok(/hidden/.test(s2.cls), `没有可用点数与精炼石时光点应隐藏：${JSON.stringify(s2)}`);
  });

  /** 递归找第一个满足条件的元素（兼容（（不依赖 querySelector 的类名精确匹配） */
  function findBy(node, pred) {
    for (const ch of node.children || []) {
      if (pred(ch)) return ch;
      const r = findBy(ch, pred);
      if (r) return r;
    }
    return null;
  }

  test('点击「精炼」按钮 → app.doSkillRefine 真跑：扣精炼石、精炼 +1、等级 +1、面板重绘', async () => {
    const { ui, game } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    game.world.player.level = 20;
    game.inv.skillRanks = {};
    game.inv.skillRefine = {};
    game.inv.skillOrbs = 3; // 1→2 级正好 3 颗
    game.recalcPlayer();
    game.world.__syncTalentPoints();
    const inst = game.world.player.skillBar.find((s) => s && s.id === 'stomp');
    const lvl0 = inst.level;
    ui.openModal('skills');
    openSkills(ui);

    const btn = findBy(ui.el.modalBody, (n) => /refine/.test(String(n.className)) && n.tagName === 'BUTTON');
    assert.ok(btn, '技能面板里应有「精炼」按钮');
    assert.equal(typeof btn._listeners.click, 'object', '精炼按钮必须绑了 click（DOM 桩的事件派发）');
    // 用 DOM 桩派发 click（同步执行，不依赖任何真实定时器）
    btn.dispatch('click');

    assert.equal(game.inv.skillOrbs, 0, `点精炼后应扣掉 3 颗精炼石，实际剩 ${game.inv.skillOrbs}`);
    assert.equal(game.inv.skillRefine.stomp, 1, '精炼等级应为 1');
    assert.equal(inst.level, lvl0 + 1, `技能等级应 +1：${lvl0} → ${inst.level}`);
    assert.ok(game.world.events.some((e) => e && e.type === 'skillRefine'), '应推 skillRefine 事件（给 UI 横幅/音效用）');
    // 面板重绘：精炼格点亮 1 个
    const pips = ui.el.modalBody.querySelectorAll('.sc-pip');
    if (pips.length) {
      assert.equal(pips.filter((x) => x.classList.contains('on')).length, 1, '重绘后精炼条应有 1 格点亮');
    }
    ui.closeModals();
  });

  test('点击「精炼」按钮但石头不足 → 不扣款、等级不变（只有点击时的错因日志）', async () => {
    const { ui, game } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    game.world.player.level = 20;
    game.inv.skillRanks = {};
    game.inv.skillRefine = {};
    game.inv.skillOrbs = 0;
    game.recalcPlayer();
    game.world.__syncTalentPoints();
    const inst = game.world.player.skillBar.find((s) => s && s.id === 'stomp');
    const lvl0 = inst.level;
    ui.openModal('skills');
    openSkills(ui);
    const btn = findBy(ui.el.modalBody, (n) => /refine/.test(String(n.className)) && n.tagName === 'BUTTON');
    assert.ok(btn, '技能面板里应有「精炼」按钮');
    btn.dispatch('click');
    assert.equal(game.inv.skillOrbs, 0, '失败不能扣款（本来就是 0，不能变成负数）');
    assert.equal(game.inv.skillRefine.stomp || 0, 0, '失败不能增加精炼等级');
    assert.equal(inst.level, lvl0, '失败不能改技能等级');
    ui.closeModals();
  });

  test('点击「重置天赋」按钮 → 技能点退回、节点清空、精炼保留', async () => {
    const { ui, game, app } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    game.world.player.level = 20;
    game.inv.skillRanks = {};
    game.inv.skillRefine = {};
    game.inv.skillOrbs = 100;
    game.recalcPlayer();
    game.world.__syncTalentPoints();
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.root'), true);
    assert.equal(app.doSkillRankUp(game, 'stomp', 'stomp.l1'), true);
    assert.equal(app.doSkillRefine(game, 'stomp'), true);
    const avail0 = app.skillPointsFor(game, 'stomp');
    const orbs0 = game.inv.skillOrbs;
    ui.openModal('skills');
    openSkills(ui);
    const btn = findBy(ui.el.modalBody, (n) => /respec/.test(String(n.className)) && n.tagName === 'BUTTON');
    assert.ok(btn, '技能面板里应有「重置天赋」按钮');
    btn.dispatch('click');
    assert.equal(game.inv.skillRanks['stomp.root'], undefined, '重置后 stomp 节点应清空');
    assert.equal(app.skillPointsFor(game, 'stomp'), avail0 + 2, '技能点应退回 2 点');
    assert.ok(game.inv.skillOrbs < orbs0, `重置应消耗精炼石：${orbs0} → ${game.inv.skillOrbs}`);
    assert.equal(game.inv.skillRefine.stomp, 1, '精炼等级必须保留');
    assert.ok(game.world.events.some((e) => e && e.type === 'skillRespec'), '应推 skillRespec 事件');
    ui.closeModals();
  });

  test('点击天赋树里的节点 → 真的加点（UI → app.doSkillRankUp 闭环）', async () => {
    const { ui, game, app } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    game.world.player.level = 20;
    game.inv.skillRanks = {};
    game.inv.skillOrbs = 0;
    game.recalcPlayer();
    game.world.__syncTalentPoints();
    ui.openModal('skills');
    openSkills(ui);
    const nodes = ui.el.modalBody.querySelectorAll('.tree-node');
    assert.ok(nodes.length >= 9, `分叉树应渲染节点，实际 ${nodes.length}`);
    // 找一个「可点」的叶子（ROOT：无前置）
    const rootNode = nodes.find((n) => {
      const dn = n.dataset.node || (n.getAttribute && n.getAttribute('data-node')) || '';
      return dn === 'stomp.root' || dn === 'root';
    });
    assert.ok(rootNode, 'ROOT 节点应渲染出来且可点');
    rootNode.dispatch('click');
    if (game.inv.skillRanks['stomp.root'] === undefined) {
      // 兜底：UI 可能用别的标识；直接找到任意 buyable 节点再点一次
      const buyable = nodes.find((n) => n.className.includes('buyable'));
      assert.ok(buyable, `点击 ROOT 没加点，且没有 buyable 节点；耗时节点 class：${nodes.map((n) => n.className).join(' / ')}`);
      buyable.dispatch('click');
    }
    const added = Object.values(game.inv.skillRanks).some((v) => v > 0);
    assert.ok(added, `点击天赋节点后 inv.skillRanks 应有加点，实际 ${JSON.stringify(game.inv.skillRanks)}`);
    assert.ok(app.skillPointsFor(game, 'stomp') < app.skillPointsTotal(game).total, '应消耗技能点');
    ui.closeModals();
  });

  test('新手引导：首次打开技能面板显示引导条（localStorage 取不到时按首次处理）', async () => {
    const { ui, dom } = await bootUI();
    const { openSkills } = await load('../src/ui/skill-ui.js');
    // 桩里没有 localStorage → 按首次处理
    globalThis.localStorage = null;
    ui.openModal('skills');
    openSkills(ui);
    const guide = ui.el.modalBody.querySelector('.skill-guide');
    assert.ok(guide, '首次打开技能面板应显示新手引导条（.skill-guide）');
    assert.ok((guide.textContent || guide.innerHTML).length > 10, '引导条应有文案');
    ui.closeModals();
    void dom;
  });
});

// ===========================================================================
// 9. 渲染（mock canvas）：stomp / stun / stunEnd / skillRankUp 事件不抛异常
// ===========================================================================
describe('渲染：战争践踏/眩晕/升星事件（契约 §6）', () => {
  async function makeRenderer() {
    const { Renderer } = await load('../src/render/renderer.js');
    const { createMockCanvas } = await import('./_mockcanvas.mjs');
    const r = new Renderer(createMockCanvas(960, 600));
    r.resize(960, 600);
    return r;
  }

  /** 最小 world（渲染层只读这些字段） */
  function renderWorld() {
    const player = {
      kind: 'player', id: 'p', x: 10, z: 10, vx: 0, vz: 0, facing: 0.5, radius: 0.45,
      hp: 90, maxHp: 120, mp: 30, maxMp: 60, level: 5,
      anim: { state: 'idle', t: 0.2, dur: 0.3, dir: 0 }, attackAnim: 0, hitFlash: 0,
      stats: { armor: 30, dmgMin: 12, dmgMax: 22 },
      buffs: [{ id: 'warStompArmor', name: '踏地战甲', icon: '🛡', type: 'buff', dur: 4, remaining: 3.2, stats: { armor: 33 } }],
      skillBar: [{ id: 'stomp', level: 3, icon: '💥', cd: 0 }],
      look: { armorColor: '#8a1f1f', weaponType: 'axe', cape: true },
    };
    const monsters = [];
    for (let i = 0; i < 5; i++) {
      monsters.push({
        kind: 'monster', id: 'm' + i, type: 'husk', x: 8 + i, z: 9 + (i % 3), vx: 0, vz: 0, facing: i,
        radius: 0.45, hp: 20, maxHp: 40, level: 3,
        // 眩晕中的怪物：渲染层要画星星
        stunTime: i < 3 ? 0.8 - i * 0.1 : 0, stunMax: 1.2,
        rarity: i === 4 ? 'boss' : 'normal', isBoss: i === 4,
        anim: { state: 'idle', t: 0.1, dur: 0.3 }, hitFlash: 0,
        visual: { color: '#7f9a74', size: 1, shape: 'humanoid' },
        displayName: '怪物' + i, mods: [],
      });
    }
    return {
      time: 1, tier: 2,
      map: { name: '测试', tier: 2, level: 3, mods: [] },
      dungeon: { cols: 32, rows: 32, tileSize: 1, tiles: new Uint8Array(1024), isWall: () => false, theme: { floor: '#222', wall: '#111', accent: '#e8c05a', fog: '#000' } },
      player, monsters, all: [player, ...monsters],
      projectiles: [], groundEffects: [], summoned: [], items: [], lootOrbs: [], events: [],
      aim: { x: 12, z: 12 },
    };
  }

  test('world.emit({type:"stomp"}) 后 render 不抛异常，且确实产生了视觉对象', async () => {
    const r = await makeRenderer();
    const world = renderWorld();
    r.emit({ type: 'stomp', x: 10, z: 10, r: 3.6, radius: 3.6, hits: 3, stunned: 3, armor: 33, dur: 4, level: 1, color: '#ffb057', sourceSkill: 'stomp' });
    for (let i = 0; i < 12; i++) r.render(world, DT, 1 + i * DT);
    assert.equal(r.errorCount || 0, 0, `stomp 渲染不应吞到整帧异常（errorCount=${r.errorCount}）`);
    // 拖尾/粒子/环：至少有一个被创建（视觉反馈必须存在）
    const visualCount = (r.particles && r.particles.size) || 0;
    const rings = (r.effects && r.effects.rings ? r.effects.rings.filter((x) => x && x.active).length : 0);
    const shocks = (r.shockwaves || []).length || (r.slamRings || []).length;
    assert.ok(visualCount > 0 || rings > 0 || shocks > 0,
      `践踏应产生粒子/冲击环：particles=${visualCount} rings=${rings} shocks=${shocks}`);
  });

  test('world.events 里同时有 stomp + stun + stunEnd + skillRankUp 时跑 20 帧不崩', async () => {
    const r = await makeRenderer();
    const world = renderWorld();
    world.events.push(
      { type: 'stomp', x: 10, z: 10, r: 3.6, radius: 3.6, hits: 2, stunned: 2, armor: 28, dur: 4, level: 3, color: '#ffb057', sourceSkill: 'stomp' },
      { type: 'stun', x: 9, z: 10, target: world.monsters[0], targetId: 'm0', dur: 1.2, rawDur: 1.2, resist: 0, sourceSkill: 'stomp', stunTime: 1.2, stunMax: 1.2 },
      { type: 'stun', x: 11, z: 9, target: world.monsters[4], targetId: 'm4', dur: 0.48, rawDur: 1.2, resist: 0.6, sourceSkill: 'stomp', stunTime: 0.48, stunMax: 0.48, boss: true },
      { type: 'stunEnd', x: 8, z: 9, target: world.monsters[2], targetId: 'm2', sourceSkill: 'stomp' },
      { type: 'skillRankUp', skillId: 'stomp', name: '战争践踏', nodeName: '震怒', rank: 1, maxRank: 1 },
      { type: 'skillRefine', skillId: 'stomp', name: '战争践踏', level: 4, refine: 3 },
      { type: 'skillCast', x: 10, z: 10, skillId: 'stomp', name: '战争践踏', icon: '💥' },
    );
    for (let i = 0; i < 20; i++) r.render(world, DT, 1 + i * DT);
    assert.equal(r.errorCount || 0, 0, `多事件同帧渲染不应出错（errorCount=${r.errorCount}）`);
    // 事件不应被渲染层清空（由主循环 clearEvents 负责）
    assert.ok(world.events.length >= 7, 'render 不应清空 world.events');
  });

  test('眩晕中的怪物头顶画标记（stunTime > 0）不会崩；结算后也没残留', async () => {
    const r = await makeRenderer();
    const world = renderWorld();
    const ctx = r.ctx;
    const calls = { arc: 0, ellipse: 0, fill: 0 };
    // mock ctx 的计数器：包一层统计
    for (const k of ['arc', 'ellipse', 'fill', 'fillText']) {
      const orig = ctx[k].bind(ctx);
      ctx[k] = (...a) => { if (calls[k] !== undefined) calls[k]++; return orig(...a); };
    }
    for (let i = 0; i < 10; i++) r.render(world, DT, i * DT);
    assert.ok(calls.arc + calls.ellipse > 0, '应当画出了圆形/椭圆（头顶星星就是用这些画的）');
    assert.equal(r.errorCount || 0, 0);
    // 眩晕结束后（stunTime = 0, stunMax = 0）继续渲染不崩
    for (const m of world.monsters) { m.stunTime = 0; m.stunMax = 0; }
    for (let i = 0; i < 5; i++) r.render(world, DT, 0.2 + i * DT);
    assert.equal(r.errorCount || 0, 0);
  });

  test('玩家身上的踏地战甲（warStompArmor buff）会画护甲辉光，不崩', async () => {
    const r = await makeRenderer();
    const world = renderWorld();
    const ctx = r.ctx;
    let radial = 0;
    const origRadial = ctx.createRadialGradient.bind(ctx);
    ctx.createRadialGradient = (...a) => { radial++; return origRadial(...a); };
    for (let i = 0; i < 6; i++) r.render(world, DT, i * DT);
    assert.equal(r.errorCount || 0, 0);
    assert.ok(radial > 0, '护甲辉光应使用径向渐变（createRadialGradient）');
    // buff 到期后不崩
    world.player.buffs = [];
    r.render(world, DT, 0.5);
    assert.equal(r.errorCount || 0, 0);
  });

  test('knockback/坐标异常也能隔离：stomp 事件缺字段不崩', async () => {
    const r = await makeRenderer();
    const world = renderWorld();
    world.events.push({ type: 'stomp' }); // 全缺字段
    world.events.push({ type: 'stun' });
    world.events.push({ type: 'stunEnd' });
    world.events.push({ type: 'skillRankUp' });
    for (let i = 0; i < 5; i++) r.render(world, DT, i * DT);
    // 允许被渲染层吞成 skippedEntities / 局部异常，但不能整帧崩到 errorCount 累积
    assert.ok((r.errorCount || 0) <= 1, `缺字段事件最多允许 1 次整帧异常，实际 ${r.errorCount}`);
  });
});
