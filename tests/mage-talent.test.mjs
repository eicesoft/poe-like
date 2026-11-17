// 元素法师专属天赋树：数据 / 职业接入 / 天赋机制（陨星、法球、三相、回响）/ 渲染事件冒烟。
import { describe, test, assert } from './_runner.mjs';
import { createGame, updateGame, doTakeTalent, doRefundTalent } from '../src/game/app.js';
import { spawnMonster } from '../src/core/monsters.js';
import { mageTalentMods } from '../src/core/mage.js';
import { makeSave, applySave } from '../src/game/save.js';
import {
  MAGE_TALENTS, MAGE_TALENT_BY_ID, MAGE_START_NODE, MAGE_BRANCHES,
  mageReachableFrom, mageTalentStats,
} from '../src/items/mageTalentTree.js';
import { TALENTS, talentStats } from '../src/items/talentTree.js';
import { ITEM_STAT_KEYS } from '../src/items/common.js';

function makeMageGame(seed = 42) {
  const game = createGame({ classId: 'mage', seed });
  return { game, p: game.world.player };
}

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

/** 直接把节点塞进已点亮列表（绕过点数/前置，专测机制）。 */
function grant(game, ids) {
  for (const id of ids) if (!game.inv.talents.includes(id)) game.inv.talents.push(id);
  game.recalcPlayer();
}

function eventsOfType(game, type) {
  return (game.world.events || []).filter((e) => e && e.type === type);
}

describe('元素法师 · 专属天赋树', () => {
  test('数据：4 条主干 + 全连通 + 70 节点与战士树对齐', () => {
    const s = mageTalentStats();
    assert.equal(s.total, 70, '法师天赋树应为 70 个节点');
    assert.equal(MAGE_TALENTS.length, TALENTS.length, '法师与战士天赋数量必须一致');
    assert.equal(MAGE_BRANCHES.length, 4);
    assert.deepEqual(MAGE_BRANCHES.map((b) => b.id).sort(), ['arcane', 'fire', 'frost', 'storm']);
    assert.equal(mageReachableFrom().size, MAGE_TALENTS.length, '所有节点都应从起点可达');
    assert.equal(s.byKind.classStart, 1);
    assert.equal(s.byKind.keystone, 4);
    assert.equal(s.byKind.legendary, 5);
    // 结构对齐：两边都是 9 个「基石 + 传奇」大节点；每棵树都能提供足够多的构筑点。
    const w = talentStats();
    assert.equal((s.byKind.keystone + s.byKind.legendary), (w.byKind.keystone + w.byKind.legendary),
      '两个职业的基石 + 传奇数量应一致');
    assert.ok(s.byKind.notable >= 8, `法师 notable 只有 ${s.byKind.notable}`);
    assert.ok(MAGE_TALENT_BY_ID[MAGE_START_NODE], '起点存在');
    // 起点不能连到战士树的起点
    assert.ok(!MAGE_TALENT_BY_ID[MAGE_START_NODE].neighbors.includes('start-warrior'));
    // 每条主干都有自己的基石，且每支 14 个节点（13 + 基石）
    for (const b of MAGE_BRANCHES) {
      assert.ok(MAGE_TALENT_BY_ID[`m-ks-${b.id}`], `缺少基石 ${b.id}`);
      assert.equal(s.byBranch[b.id] + 1, 14, `${b.id} 主干应有 14 个节点`);
    }
    assert.equal(s.byBranch.ring, 8, '4 内环 + 4 外环接缝');
  });

  test('几何与数据质量：短边 / 不交叉 / 近邻已连 / 统计键合法', () => {
    const edges = [];
    const seen = new Set();
    for (const n of MAGE_TALENTS) {
      for (const nb of n.neighbors) {
        const key = n.id < nb ? `${n.id}|${nb}` : `${nb}|${n.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([n, MAGE_TALENT_BY_ID[nb]]);
      }
    }
    // 短边
    for (const [a, b] of edges) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ks = a.kind === 'keystone' || b.kind === 'keystone';
      assert.ok(d <= (ks ? 165 : 175), `${a.id}~${b.id} 边长 ${d.toFixed(1)}`);
    }
    // 节点不贴脸
    let minD = Infinity;
    let pair = '';
    for (let i = 0; i < MAGE_TALENTS.length; i++) {
      for (let j = i + 1; j < MAGE_TALENTS.length; j++) {
        const d = Math.hypot(MAGE_TALENTS[i].x - MAGE_TALENTS[j].x, MAGE_TALENTS[i].y - MAGE_TALENTS[j].y);
        if (d < minD) { minD = d; pair = `${MAGE_TALENTS[i].id}/${MAGE_TALENTS[j].id}`; }
      }
    }
    assert.ok(minD >= 20, `最近节点只隔 ${minD.toFixed(1)}px（${pair}）`);
    // 近邻必须相连
    for (const n of MAGE_TALENTS) {
      for (const m of MAGE_TALENTS) {
        if (m === n || n.neighbors.includes(m.id)) continue;
        const d = Math.hypot(n.x - m.x, n.y - m.y);
        assert.ok(d >= 25, `${n.id} 与 ${m.id} 只隔 ${d.toFixed(1)}px 却没连`);
      }
    }
    // 不交叉 + 度数
    const orient = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const crosses = (p1, p2, p3, p4) => {
      const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4);
      const o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
      return o1 !== o2 && o3 !== o4;
    };
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const [a, b] = edges[i], [c, d] = edges[j];
        if (a.id === c.id || a.id === d.id || b.id === c.id || b.id === d.id) continue;
        assert.ok(!crosses(a, b, c, d), `${a.id}~${b.id} × ${c.id}~${d.id} 交叉`);
      }
    }
    for (const n of MAGE_TALENTS) assert.ok(n.neighbors.length <= 6, `${n.id} 度数 ${n.neighbors.length}`);
    // 统计键：标准键或 core/mage.js 读取的 mage* 自定义字段
    const custom = new Set([
      'mageReactionMult', 'mageResonanceMult', 'mageMarkMax', 'mageAutoCastMult',
      'mageEmpoweredMult', 'mageShieldMult', 'mageNovaRadius', 'mageNovaCdr',
      'mageChainJumpBonus', 'mageReactionEcho', 'mageUltDuration', 'mageUltCdr',
      'mageMeteor', 'mageMeteorRate', 'mageOrbs', 'mageTrinity', 'mageUltKillExtend',
      'mageControlMult',
    ]);
    const allowed = new Set([...ITEM_STAT_KEYS, ...custom]);
    for (const n of MAGE_TALENTS) {
      for (const k of Object.keys(n.stats)) {
        assert.ok(allowed.has(k), `${n.id}（${n.name}）使用了非法统计键 ${k}`);
        assert.ok(Number.isFinite(n.stats[k]), `${n.id}.${k} 不是有限数字`);
      }
    }
  });

  test('旧存档清理：已删除的节点会被移除并自动退回天赋点', () => {
    const { game } = makeMageGame(37);
    game.world.player.talentPoints = 5;
    game.inv.talents = [MAGE_START_NODE, 'm-fire-trunc', 'war-stem3', 'not-a-node'];
    game.recalcPlayer();
    assert.deepEqual(game.inv.talents, [MAGE_START_NODE, 'm-fire-trunc'], '无效节点应被清理');
    assert.equal(game.inv.talentPoints, 4, '只花 1 点，剩余 4 点');
  });

  test('职业接入：法师用法师树，战士仍用战士树', () => {
    const { game, p } = makeMageGame();
    assert.deepEqual(game.inv.talents, [MAGE_START_NODE]);
    assert.equal(game.talentTree.id, 'mage');
    assert.equal(game.talentTree.start, MAGE_START_NODE);
    assert.equal(p.type, 'mage');

    const warrior = createGame({ seed: 1 });
    assert.equal(warrior.talentTree.id, 'warrior');
    assert.deepEqual(warrior.inv.talents, ['start-warrior']);
  });

  test('加点 / 退点：只能点相邻节点，属性真的进入 player.talentStats', () => {
    const { game, p } = makeMageGame(7);
    game.inv.talentPoints = 5;
    const fireBefore = p.stats.fireDamageMult || 0;
    assert.equal(doTakeTalent(game, 'm-fire-trunc'), true);
    assert.ok(game.inv.talents.includes('m-fire-trunc'));
    assert.ok((p.stats.fireDamageMult || 0) > fireBefore, '火种应提高火焰伤害');
    assert.equal(doTakeTalent(game, 'start-warrior'), false, '不能点另一棵树的节点');
    assert.equal(doTakeTalent(game, 'm-fire-stem2'), false, '隔层节点不能越过前置');
    assert.equal(doRefundTalent(game, 'm-fire-trunc'), true, '末端节点可以退回');
    assert.ok(!game.inv.talents.includes('m-fire-trunc'));
  });

  test('陨星：点亮「陨星之契」后周期轰击目标并推 mageMeteor 事件', () => {
    const { game, p } = makeMageGame(11);
    grant(game, ['m-fire-trunc', 'm-fire-hub', 'm-fire-stem1', 'm-fire-stem2', 'm-fire-armL', 'm-fire-armR', 'm-fire-cap']);
    assert.ok(mageTalentMods(p).meteor >= 1);
    const m = spawnDummy(game, p);
    const hpBefore = m.hp;
    step(game, 660); // 11 秒，足以触发至少一次陨星
    assert.ok(eventsOfType(game, 'mageMeteor').length >= 1, '应推送 mageMeteor 事件');
    assert.ok(m.hp < hpBefore, '陨星应造成伤害');
    assert.ok(p.mage.meteorTimer > 0, '陨星计时器应重置为下一次间隔');
  });

  test('环形法球：点亮传奇后推 mageOrb 事件并自动发射', () => {
    const { game, p } = makeMageGame(13);
    grant(game, ['m-lg-orbit', 'm-fire-trunc', 'm-fire-hub']);
    assert.equal(mageTalentMods(p).orbs, 1);
    const m = spawnDummy(game, p);
    const hpBefore = m.hp;
    step(game, 240); // 4 秒
    assert.ok(eventsOfType(game, 'mageOrb').length >= 1, '应推送 mageOrb 事件');
    assert.ok(m.hp < hpBefore, '法球应造成伤害');
  });

  test('三相归一：每 3 次填充施法触发一次三色齐射', () => {
    const { game, p } = makeMageGame(17);
    grant(game, ['m-lg-trinity', 'm-fire-trunc']);
    spawnDummy(game, p);
    step(game, 600); // 10 秒
    assert.ok(p.mage.fillerCount >= 3, '自动循环应至少施放 3 次填充技，实际 ' + p.mage.fillerCount);
    assert.ok(eventsOfType(game, 'mageTrinity').length >= 1, '应触发三相齐射');
  });

  test('元素回响：反应会向周围敌人弹射 mageReactionEcho', () => {
    const { game, p } = makeMageGame(19);
    grant(game, ['m-lg-echo', 'm-fire-trunc']);
    const a = spawnDummy(game, p, 3);
    spawnDummy(game, p, 4.2);
    step(game, 480); // 8 秒，足够触发多次反应
    assert.ok(eventsOfType(game, 'mageReaction').length >= 1, '应至少触发一次元素反应');
    assert.ok(eventsOfType(game, 'mageReactionEcho').length >= 1, '反应应产生回响');
    assert.ok(a.hp < a.maxHp);
  });

  test('三相共鸣把印记上限从 3 提到 4', () => {
    const { game, p } = makeMageGame(23);
    assert.equal(mageTalentMods(p).markMax, 3);
    grant(game, ['m-arcane-trunc', 'm-arcane-hub', 'm-arcane-stem1', 'm-arcane-stem2']);
    assert.equal(mageTalentMods(p).markMax, 4);
  });

  test('存档：法师天赋节点与职业一起往返', () => {
    const { game } = makeMageGame(29);
    grant(game, ['m-fire-trunc', 'm-fire-hub']);
    const data = makeSave(game.world, game.inv);
    assert.deepEqual(data.inv.talents, game.inv.talents);

    const fresh = createGame({ classId: 'warrior', seed: 29 });
    assert.equal(applySave(fresh, data), true);
    assert.equal(fresh.world.player.type, 'mage');
    assert.deepEqual(fresh.inv.talents, game.inv.talents);
    assert.equal(fresh.talentTree.id, 'mage');
  });

  test('旧法师存档（带 start-warrior）读档后自动切到法师起点', () => {
    const { game } = makeMageGame(31);
    const data = makeSave(game.world, game.inv);
    data.inv.talents = ['start-warrior'];
    const fresh = createGame({ classId: 'warrior', seed: 31 });
    assert.equal(applySave(fresh, data), true);
    assert.deepEqual(fresh.inv.talents, [MAGE_START_NODE]);
    assert.equal(fresh.talentTree.id, 'mage');
  });

  test('渲染层：法师新事件不会抛异常，并会生成粒子/特效', async () => {
    const { Renderer } = await import('../src/render/renderer.js');
    const r = new Renderer(null);
    const before = r.particles.size + r.effects.disks.filter((d) => d.active).length
      + r.effects.bolts.filter((b) => b.active).length;
    const events = [
      { type: 'mageReaction', x: 0, z: 0, name: '超载', hue: 48 },
      { type: 'mageReactionEcho', x: 1, z: 0, fromX: 0, fromZ: 0, element: 'lightning', hue: 55 },
      { type: 'mageMeteor', x: 0, z: 0, radius: 3, level: 2, hue: 24 },
      { type: 'mageOrb', x: 2, z: 1, fromX: 0, fromZ: 0, element: 'fire', hue: 24, index: 0 },
      { type: 'mageTrinity', x: 2, z: 2, fromX: 0, fromZ: 0, elements: ['cold', 'lightning'], primary: 'fire' },
      { type: 'skillCast', skillId: 'mageFirebolt', x: 2, z: 0, fromX: 0, fromZ: 0, hue: 24 },
      { type: 'skillCast', skillId: 'magePyro', x: 2, z: 0, radius: 4, empowered: true, hue: 38 },
      { type: 'skillCast', skillId: 'mageNova', x: 0, z: 0, radius: 6, empowered: true, hue: 195 },
      { type: 'skillCast', skillId: 'mageUltimate', x: 0, z: 0, radius: 5, hue: 280 },
    ];
    for (const e of events) r.emitFromEvent(e);
    const after = r.particles.size + r.effects.disks.filter((d) => d.active).length
      + r.effects.bolts.filter((b) => b.active).length;
    assert.ok(after > before, `法师事件应产生视觉，before=${before} after=${after}`);
    assert.equal(r.lastError, null);
  });

  test('天赋面板（纯绘制层）：法师树用 70 个节点 / 4 条主干渲染，tooltip 显示元素主干', async () => {
    const { drawTalentMap, talentTooltipHTML } = await import('../src/ui/talent-ui.js');
    const ctx = makeStubCtx();
    const result = drawTalentMap(ctx, {
      width: 900,
      height: 600,
      view: { zoom: 0.8, panX: 0, panY: 0 },
      taken: new Set([MAGE_START_NODE, 'm-fire-trunc']),
      available: (t) => t && t.id === 'm-fire-hub',
      byId: MAGE_TALENT_BY_ID,
      nodes: MAGE_TALENTS,
      ringRadii: [300, 425, 560],
      time: 1.2,
    });
    assert.equal(result.nodes, MAGE_TALENTS.length, '应画出全部法师节点');
    assert.ok(result.edges > 0, '应画出天赋连线');
    assert.ok(result.names.includes('元素之心'), '起点名字应显示');
    assert.ok(result.names.includes('天火降世'), '基石名字应显示');

    const node = MAGE_TALENT_BY_ID['m-fire-cap'];
    const html = talentTooltipHTML(node, {
      taken: false, points: 3, canTake: true, branches: MAGE_BRANCHES,
    });
    assert.ok(html.includes('天火陨星'), 'tooltip 应展示陨星说明');
    assert.ok(html.includes('主干 · 烈焰'), 'tooltip 应使用法师主干名');
  });
});

/** 最小 Canvas2D 桩：覆盖 drawTalentMap 用到的绘制原语。 */
function makeStubCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  return {
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop,
    arc: noop, ellipse: noop, fill: noop, stroke: noop,
    strokeText: noop, fillText: noop,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: '', textBaseline: '',
  };
}