// 元素法师（半自动循环）集成测试：职业创建 / 自动施法 / 印记反应 / 共鸣 / 屏障 / 元素狂潮 / 存档。
import { describe, test, assert } from './_runner.mjs';
import { createGame, updateGame } from '../src/game/app.js';
import { spawnMonster } from '../src/core/monsters.js';
import { tryCast } from '../src/core/skills.js';
import { makeSave, applySave } from '../src/game/save.js';

function makeMageGame(seed = 42) {
  const game = createGame({ classId: 'mage', seed });
  const p = game.world.player;
  return { game, p };
}

/** 放一只高血量木桩，避免自动循环把它秒掉导致后续断言无目标 */
function spawnDummy(game, p, dx = 3) {
  const m = spawnMonster(game.world, 'husk', p.x + dx, p.z, {});
  m.maxHp = 1e6;
  m.hp = 1e6;
  m.speedMult = 0;
  return m;
}

function step(game, frames) {
  for (let i = 0; i < frames; i++) updateGame(game, 1 / 60, {});
}

describe('元素法师 · 半自动循环', () => {
  test('职业创建：法师属性 / 5 个法师技能；默认仍是战士', () => {
    const { p } = makeMageGame();
    assert.equal(p.type, 'mage');
    assert.equal(p.name, '元素法师');
    assert.equal(p.maxHp, 88);
    assert.equal(p.maxMp, 100);
    assert.deepEqual(p.skillBar.slice(0, 5).map((s) => s && s.id),
      ['mageFirebolt', 'mageIceShard', 'mageArc', 'magePyro', 'mageUltimate']);
    assert.equal(p.skillBar[5], null);
    assert.ok(p.mage && p.mage.resonance === 0);

    const warrior = createGame({ seed: 42 });
    assert.equal(warrior.world.player.type, 'warrior');
    assert.equal(warrior.world.player.maxHp, 120);
    assert.equal(warrior.world.player.maxMp, 60);
    assert.deepEqual(warrior.world.player.skillBar.slice(0, 5).map((s) => s && s.id),
      ['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally']);
  });

  test('自动施法：有目标时自动掉血、叠印记、积累共鸣', () => {
    const { game, p } = makeMageGame();
    const m = spawnDummy(game, p);
    step(game, 240); // 4 秒
    assert.ok(m.hp < m.maxHp, '木桩应该被自动循环打掉血');
    assert.ok(p.mage.lastSkillId, '应该至少施放一个技能');
    const marks = m.mageMarks || {};
    assert.ok((marks.fire || 0) + (marks.cold || 0) + (marks.lightning || 0) > 0, '命中应叠元素印记');
    assert.ok(p.mage.resonance > 0, '触发元素反应后应获得共鸣');
  });

  test('自动屏障：生命低于 45% 时获得冰霜屏障护盾', () => {
    const { game, p } = makeMageGame(7);
    spawnDummy(game, p);
    p.hp = 10;
    step(game, 30);
    assert.ok(p.energyShield > 0, '应该获得护盾，实际 ' + p.energyShield);
    assert.ok(p.buffs.some((b) => b.id === 'mageBarrier'), '应挂上冰霜屏障 buff');
  });

  test('元素狂潮：共鸣 100 才能手动开启，8 秒后结束并造成范围爆发', () => {
    const { game, p } = makeMageGame(11);
    const m = spawnDummy(game, p);
    p.mage.resonance = 100;
    const hpBefore = m.hp;
    assert.equal(tryCast(game.world, p, 'mageUltimate', { x: m.x, z: m.z }), true);
    assert.equal(p.mage.resonance, 0);
    assert.ok(p.mage.ultTimer > 7.9 && p.mage.ultTimer <= 8, '元素狂潮应持续 8 秒');
    step(game, 510); // 8.5 秒
    assert.equal(p.mage.ultTimer, 0);
    assert.ok(m.hp < hpBefore, '元素狂潮期间/结束时目标应受到伤害');

    // 共鸣不足时不能重复开启
    p.mage.resonance = 0;
    assert.equal(tryCast(game.world, p, 'mageUltimate', { x: m.x, z: m.z }), false);
  });

  test('存档：classId 与法师状态可往返，老存档默认战士', () => {
    const { game, p } = makeMageGame(3);
    p.level = 5;
    p.mage.resonance = 42;
    p.mage.preset = 'reaction';
    const data = makeSave(game.world, game.inv);
    assert.equal(data.player.classId, 'mage');
    assert.equal(data.player.mage.preset, 'reaction');

    const fresh = createGame({ classId: 'warrior', seed: 3 });
    assert.equal(applySave(fresh, data), true);
    const fp = fresh.world.player;
    assert.equal(fp.type, 'mage');
    assert.equal(fp.mage.resonance, 42);
    assert.equal(fp.mage.preset, 'reaction');
    assert.deepEqual(fp.skillBar.slice(0, 5).map((s) => s && s.id),
      ['mageFirebolt', 'mageIceShard', 'mageArc', 'magePyro', 'mageUltimate']);

    // 老存档（没有 classId）按战士读取
    const old = makeSave(fresh.world, fresh.inv);
    delete old.player.classId;
    delete old.player.mage;
    const oldGame = createGame({ classId: 'mage', seed: 3 });
    assert.equal(applySave(oldGame, old), true);
    assert.equal(oldGame.world.player.type, 'warrior');
  });
});