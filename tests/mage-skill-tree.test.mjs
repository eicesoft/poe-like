// 元素法师 · 5 棵技能分叉树：数据完整性 / 加点链路 / 各分支的战斗机制 / 渲染事件冒烟。
//
// 说明：法师的**被动天赋树**（70 节点，四主干）在 tests/mage-talent.test.mjs；
// 本文件测的是每个技能自己的分叉树（items/mageSkillTrees.js → items/skillTree.js）。
import { describe, test, assert } from './_runner.mjs';
import { createGame, updateGame, doSkillRankUp } from '../src/game/app.js';
import { spawnMonster } from '../src/core/monsters.js';
import { activateMageUltimate, MAGE_SKILL_IDS } from '../src/core/mage.js';
import { SKILLS } from '../src/core/skills.js';
import {
  SKILL_TREES, SKILL_IDS, skillEffectsForSkill, skillNodeConflict,
  validateSkillRanks,
} from '../src/items/skillTree.js';
import { Renderer } from '../src/render/renderer.js';

const MAGE_TREE_IDS = ['mageFirebolt', 'mageIceShard', 'mageArc', 'magePyro', 'mageUltimate'];

function makeMageGame(seed = 42) {
  const game = createGame({ classId: 'mage', seed });
  // 停掉刷怪器：测试只关心技能机制，不想被随机刷出来的怪打乱目标/击杀统计。
  game.world.over = true;
  return { game, p: game.world.player };
}

/** 木桩：不会被击杀、不会移动、不会攻击（stunTime 很大），但可正常被锁定/命中。 */
function spawnDummy(game, p, dx = 2.2, dz = 0) {
  const m = spawnMonster(game.world, 'husk', p.x + dx, p.z + dz, {});
  m.maxHp = 1e9;
  m.hp = 1e9;
  m.speedMult = 0;
  m.stunTime = 1e9;
  m.stunMax = 1e9;
  m.dmgMin = 0;
  m.dmgMax = 0;
  return m;
}

/** 直接写入技能 rank（绕过点数/前置，专测机制）并同步到 player.skillMods。 */
function grant(game, ranks) {
  Object.assign(game.inv.skillRanks, ranks);
  game.recalcPlayer();
}

function step(game, seconds) {
  const frames = Math.ceil(seconds * 60);
  for (let i = 0; i < frames; i++) updateGame(game, 1 / 60, {});
}

function eventsOf(game, type) {
  return (game.world.events || []).filter((e) => e && e.type === type);
}

function eventTypes(game) {
  const out = {};
  for (const e of game.world.events || []) if (e && e.type) out[e.type] = (out[e.type] || 0) + 1;
  return out;
}

function castFirebolt(world, p, target) {
  SKILLS.mageFirebolt.cast(world, p, { x: target.x, z: target.z });
}
function castIceShard(world, p, target) {
  SKILLS.mageIceShard.cast(world, p, { x: target.x, z: target.z });
}
function castArc(world, p, target) {
  SKILLS.mageArc.cast(world, p, { x: target.x, z: target.z });
}
function castPyro(world, p, target) {
  SKILLS.magePyro.cast(world, p, { x: target.x, z: target.z });
}

const LEFT_CHAIN = (sid) => ({
  [`${sid}.root`]: 3,
  [`${sid}.l1`]: 1,
  [`${sid}.l2`]: 1,
  [`${sid}.l3`]: 1,
  [`${sid}.l4`]: 1,
});
const RIGHT_CHAIN = (sid) => ({
  [`${sid}.root`]: 3,
  [`${sid}.r1`]: 1,
  [`${sid}.r2`]: 1,
  [`${sid}.r3`]: 1,
  [`${sid}.r4`]: 1,
});

describe('元素法师 · 技能分叉树（数据）', () => {
  test('5 棵树全部注册、classId=mage、结构符合分叉契约', () => {
    assert.deepEqual([...MAGE_SKILL_IDS].slice().sort(), [...MAGE_TREE_IDS].slice().sort());
    for (const sid of MAGE_TREE_IDS) {
      const tree = SKILL_TREES[sid];
      assert.ok(tree, `缺少技能树 ${sid}`);
      assert.equal(tree.classId, 'mage', `${sid} 的 classId 应为 mage`);
      assert.ok(tree.name && tree.icon && tree.desc, `${sid} 缺少展示字段`);
      assert.equal(tree.nodes.length, 10, `${sid} 应有 10 个节点`);
      const root = tree.nodes.find((n) => !n.requires || !n.requires.length);
      assert.equal(root.maxRank, 3, `${sid} 的 ROOT 应为 3 档`);
      for (const g of ['fork', 'tier2', 'tier3', 'forkFinal']) {
        const group = tree.nodes.filter((n) => n.group === g);
        assert.equal(group.length, 2, `${sid} 的互斥组 ${g} 应恰好 2 个节点`);
      }
      const ult = tree.nodes.find((n) => n.branch === 'ultimate');
      assert.ok(ult && !ult.group, `${sid} 应有不互斥的终极节点`);
      for (const n of tree.nodes) {
        assert.ok(n.name && n.desc, `${n.id} 缺 name/desc`);
        assert.ok(Array.isArray(n.effects) && n.effects.length > 0, `${n.id} 没有效果`);
      }
    }
    // 战士面板不会混进法师树（classId 区分）
    for (const sid of ['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally']) {
      assert.equal(SKILL_TREES[sid].classId, 'warrior');
    }
    assert.ok(SKILL_IDS.length === 10);
  });

  test('法师树的互斥 / 前置 / 校验与战士树走同一套规则', () => {
    const eff = skillEffectsForSkill('mageFirebolt', {
      'mageFirebolt.root': 1, 'mageFirebolt.l1': 1,
    });
    assert.ok(eff.damageMult > 1, '左支 L1 应提升伤害');
    const both = skillEffectsForSkill('mageFirebolt', {
      'mageFirebolt.root': 1, 'mageFirebolt.l1': 1, 'mageFirebolt.r1': 1,
    });
    assert.equal(both.damageMult, eff.damageMult, '互斥时右支不应生效');
    assert.ok(!both.nodes.includes('mageFirebolt.r1'));

    const conflict = skillNodeConflict('mageFirebolt', { 'mageFirebolt.l1': 1 }, 'mageFirebolt.r1');
    assert.ok(conflict && conflict.group === 'fork', '同组第二支应报冲突');

    assert.equal(validateSkillRanks('mageFirebolt', { 'mageFirebolt.root': 1 }).ok, true);
    assert.equal(validateSkillRanks('mageFirebolt', {
      'mageFirebolt.root': 1, 'mageFirebolt.l1': 1, 'mageFirebolt.r1': 1,
    }).ok, false, '同组互斥应判非法');
  });

  test('app 动作：法师技能可以加点、互斥锁定、等级写入技能栏', () => {
    const { game, p } = makeMageGame();
    game.inv.skillPoints = { total: 12, spent: 0, avail: 12 };
    assert.equal(doSkillRankUp(game, 'mageFirebolt', 'root'), true);
    assert.equal(doSkillRankUp(game, 'mageFirebolt', 'l1'), true);
    assert.equal(doSkillRankUp(game, 'mageFirebolt', 'r1'), false, '互斥的右支不能加点');
    const mods = p.skillMods.mageFirebolt;
    assert.ok(mods && mods.damageMult > 1, '天赋应进入 player.skillMods');
    assert.equal(mods.focus, 'left');
    const inst = p.skillBar.find((s) => s && s.id === 'mageFirebolt');
    assert.ok(inst.level >= 3, `技能等级应 = 1 + 已点节点数，实际 ${inst.level}`);
    assert.ok(p.skills.mageFirebolt.refine === 0 && p.skills.mageFirebolt.talentPoints === 2);
  });
});

describe('元素法师 · 灼热飞弹分支机制', () => {
  test('爆燃支线：余烬爆炸必定触发（左支专精）', () => {
    const { game, p } = makeMageGame(11);
    grant(game, LEFT_CHAIN('mageFirebolt'));
    const m = spawnDummy(game, p);
    castFirebolt(game.world, p, m);
    castFirebolt(game.world, p, m);
    assert.ok(eventsOf(game, 'mageEmberBurst').length >= 2, '每次命中都应引爆余烬');
    assert.ok(m.hp < 1e9, '余烬/飞弹应造成伤害');
  });

  test('爆燃 + 终极：6 次灼热飞弹召唤凤凰之焰', () => {
    const { game, p } = makeMageGame(12);
    grant(game, { ...LEFT_CHAIN('mageFirebolt'), 'mageFirebolt.u': 1 });
    const m = spawnDummy(game, p);
    for (let i = 0; i < 6; i++) castFirebolt(game.world, p, m);
    assert.ok(eventsOf(game, 'magePhoenix').length >= 1, '第 6 发应召唤凤凰');
    assert.ok(eventsOf(game, 'mageEmberBurst').length >= 6, '余烬应随每次命中触发');
  });

  test('流火右支：余火追击 + 生命/法力回复', () => {
    const { game, p } = makeMageGame(13);
    grant(game, RIGHT_CHAIN('mageFirebolt'));
    const m = spawnDummy(game, p);
    p.hp = p.maxHp * 0.4;
    p.mp = 0;
    for (let i = 0; i < 8; i++) castFirebolt(game.world, p, m);
    assert.ok(p.hp > p.maxHp * 0.4, '命中应回复生命');
    assert.ok(p.mp > 0, '命中应回复法力');
    assert.ok(eventTypes(game).skillCast >= 8, '飞弹本体应产生 skillCast');
  });
});

describe('元素法师 · 寒冰箭分支机制', () => {
  test('碎冰支线：冰爆 → 冻结，8 次后降下极寒领域', () => {
    const { game, p } = makeMageGame(21);
    grant(game, { ...LEFT_CHAIN('mageIceShard'), 'mageIceShard.u': 1 });
    const m = spawnDummy(game, p);
    for (let i = 0; i < 8; i++) castIceShard(game.world, p, m);
    assert.ok(eventsOf(game, 'mageFrostBurst').length >= 8, '冰爆必定触发');
    assert.ok(eventsOf(game, 'mageIceField').length >= 1, '第 8 次应降下极寒领域');
    assert.ok((m.stunTime || 0) > 0, '冰爆/极寒领域应冻结目标');
  });

  test('寒流支线：分裂冰片 + 寒冰护甲', () => {
    const { game, p } = makeMageGame(22);
    grant(game, { ...RIGHT_CHAIN('mageIceShard'), 'mageIceShard.u': 1 });
    const m = spawnDummy(game, p, 2.2);
    spawnDummy(game, p, 3.0);
    spawnDummy(game, p, 3.8);
    castIceShard(game.world, p, m);
    assert.ok((p.energyShield || 0) > 0, '冰甲应提供护盾');
    assert.ok(eventsOf(game, 'mageIceArmor').length >= 1);
    assert.ok(eventsOf(game, 'skillCast').filter((e) => e.split).length >= 2, '应弹射 2 枚冰片');
  });
});

describe('元素法师 · 电弧分支机制', () => {
  test('连锁支线：跳弧串起多个敌人', () => {
    const { game, p } = makeMageGame(31);
    grant(game, LEFT_CHAIN('mageArc'));
    const m = spawnDummy(game, p, 2.2);
    spawnDummy(game, p, 3.0, 0.6);
    spawnDummy(game, p, 4.0, -0.5);
    castArc(game.world, p, m);
    assert.ok(eventsOf(game, 'mageArcJump').length >= 2, '跳弧应至少跳 2 次');
  });

  test('过载支线：静电额外叠层 + 疾电 + 雷霆万钧', () => {
    const { game, p } = makeMageGame(32);
    grant(game, { ...RIGHT_CHAIN('mageArc'), 'mageArc.u': 1 });
    const m = spawnDummy(game, p, 2.2);
    castArc(game.world, p, m);
    assert.ok((m.mageMarks && m.mageMarks.lightning) >= 2, '静电应额外叠 1 层雷印记');
    assert.ok(p.buffs.some((b) => b && b.id === 'mageArcHaste'), '疾电应给移速 buff');
    for (let i = 0; i < 4; i++) castArc(game.world, p, m);
    assert.ok(eventsOf(game, 'mageThunder').length >= 1, '第 5 次电弧应召唤雷暴');
    const thunder = eventsOf(game, 'mageThunder').pop();
    assert.ok(Array.isArray(thunder.points) && thunder.points.length >= 1);
  });
});

describe('元素法师 · 炎爆术分支机制', () => {
  test('陨火支线：双重引爆 + 流星雨', () => {
    const { game, p } = makeMageGame(41);
    grant(game, LEFT_CHAIN('magePyro'));
    const m = spawnDummy(game, p, 2.2);
    spawnDummy(game, p, 2.8, 0.6);
    spawnDummy(game, p, 3.4, -0.6);
    castPyro(game.world, p, m);
    step(game, 1.2);
    assert.ok(eventsOf(game, 'mageDoubleDetonate').length >= 1, '应触发二段爆炸');
    assert.ok(eventsOf(game, 'mageMeteorRain').length >= 1, '应触发流星雨');
    assert.ok(eventsOf(game, 'mageMeteor').length >= 2, '每颗小陨星都应有事件');
  });

  test('熔核支线：熔岩池 + 天火焚世', () => {
    const { game, p } = makeMageGame(42);
    grant(game, { ...RIGHT_CHAIN('magePyro'), 'magePyro.u': 1 });
    const m = spawnDummy(game, p, 2.2);
    spawnDummy(game, p, 3.0, 0.5);
    spawnDummy(game, p, 3.6, -0.5);
    castPyro(game.world, p, m);
    step(game, 3.2);
    assert.ok(eventsOf(game, 'mageLava').length >= 3, '熔岩池应持续 3 跳');
    assert.ok(eventsOf(game, 'mageCataclysm').length >= 1, '应降下天火焚世');
  });
});

describe('元素法师 · 元素狂潮分支机制', () => {
  test('永动支线：延长持续时间、降低冷却、开启奇点', () => {
    const { game, p } = makeMageGame(51);
    grant(game, { ...RIGHT_CHAIN('mageUltimate'), 'mageUltimate.u': 1 });
    spawnDummy(game, p, 2.2);
    p.mage.resonance = 100;
    assert.equal(activateMageUltimate(game.world, p), true);
    assert.ok(p.mage.ultTimer > 13, `持续时间应被天赋延长，实际 ${p.mage.ultTimer}`);
    assert.ok(p.cooldowns.mageUltimate < 7, `冷却应被天赋降低，实际 ${p.cooldowns.mageUltimate}`);
    assert.ok(eventsOf(game, 'mageSingularity').length >= 1, '终极节点应生成元素奇点');
    // 直接把剩余时间清零，验证结束爆发与击杀延长字段存在于 mods 中
    p.mage.ultTimer = 0.01;
    step(game, 0.1);
    const end = eventsOf(game, 'skillCast').find((e) => e && e.skillId === 'iceNova' && e.ultimateEnd);
    assert.ok(end, '狂潮结束应推送 iceNova(ultimateEnd)');
  });

  test('万相支线：结束时保留共鸣 + 奇点关闭爆发', () => {
    const { game, p } = makeMageGame(52);
    grant(game, { ...LEFT_CHAIN('mageUltimate'), 'mageUltimate.u': 1 });
    spawnDummy(game, p, 2.2);
    p.mage.resonance = 100;
    assert.equal(activateMageUltimate(game.world, p), true);
    p.mage.ultTimer = 0.01;
    step(game, 0.1);
    assert.ok(p.mage.resonance >= 30, `超载共鸣应保留 30 点，实际 ${p.mage.resonance}`);
    assert.ok(eventsOf(game, 'mageSingularity').some((e) => e.phase === 'close'), '结束时应关闭奇点');
  });
});

describe('元素法师 · 技能树视觉事件冒烟', () => {
  test('新增的 mage* 事件都不会让 Renderer 抛异常', () => {
    const r = new Renderer(null);
    const events = [
      { type: 'mageEmberBurst', x: 1, z: 1, radius: 1.6 },
      { type: 'magePhoenix', x: 1, z: 1, radius: 4.5, fromX: 0, fromZ: 0 },
      { type: 'mageFrostBurst', x: 1, z: 1, radius: 1.7, frozen: true },
      { type: 'mageIceField', x: 1, z: 1, radius: 4.4 },
      { type: 'mageIceArmor', x: 1, z: 1, amount: 20 },
      { type: 'mageArcJump', x: 2, z: 1, fromX: 1, fromZ: 1, index: 0 },
      { type: 'mageArcHaste', x: 1, z: 1 },
      { type: 'mageThunder', x: 1, z: 1, radius: 6, points: [{ x: 1, z: 1 }, { x: 2, z: 2 }] },
      { type: 'mageMeteorRain', x: 1, z: 1, points: [{ x: 1, z: 1 }, { x: 2, z: 2 }] },
      { type: 'mageDoubleDetonate', x: 1, z: 1, radius: 2.7 },
      { type: 'mageCataclysm', x: 1, z: 1, radius: 4, points: [{ x: 1, z: 1 }] },
      { type: 'mageLava', x: 1, z: 1, radius: 2.4, tick: 0 },
      { type: 'mageSingularity', x: 1, z: 1, radius: 4.6, phase: 'open' },
      { type: 'mageSingularity', x: 1, z: 1, radius: 4.6, phase: 'close' },
      { type: 'skillCast', skillId: 'fireNova', x: 1, z: 1, radius: 2.4, ultSplash: true, torrent: true },
    ];
    for (const e of events) r.emitFromEvent(e);
    assert.ok(r.particles.emitted > 0, '事件应产生粒子');
  });
});