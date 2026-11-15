// @file tools/sim-ttk.mjs
// 平衡测量：1 级玩家 vs 1 级地图各种怪的「击杀时间 / 刀数」（纯核心层，不依赖 app.js）。
//
// 用法: node tools/sim-ttk.mjs [--seeds 5] [--json out/ttk.json]
//
// 方法：
//   用真实的 createPlayer + spawnMonster + updateCore 跑 1 对 1 单挑：
//   玩家原地不移动、只按「普攻 + 技能」（与 playtest 机器人相同策略），被怪打死视为失败。
//   1 号技能是「战争践踏 stomp」（圆形范围眩晕 + 命中越多自身护甲越高），
//   记录：击杀耗时、普攻命中次数、技能次数、玩家剩余血量，
//   以及践踏的控制收益：命中数 / 眩晕覆盖率 / 踏地战甲覆盖率。
// 输出对照任务书目标：
//   小怪 1-3 刀死（按普攻命中次数 ≈ 1.25 刀/秒 × 时长估算）
//   精英 3-6 秒；Boss 15-40 秒
//   践踏眩晕覆盖率：小怪应明显 > 0（被控就不打人），Boss 因抗性会低一些

import { createWorld } from '../src/game/world.js';
import { createPlayer, updateCore } from '../src/core/index.js';
import { spawnMonster, BOSS_TEMPLATE_ID } from '../src/core/monsters.js';
import { tryBasicAttack, tryCast, releaseChannel, isChanneling } from '../src/core/skills.js';
import { recalcStats } from '../src/core/stats.js';
import { isWalkable } from '../src/game/world.js';
import { SpatialHash } from '../src/engine/spatial.js';

const DT = 1 / 60;

function makeArena(seed) {
  // 一张平坦的竞技场（不用地牢，避免寻路干扰）：世界 + 可走判定恒真
  const world = createWorld({ seed });
  world.dungeon = { playerStart: { x: 50, z: 50 }, cols: 100, rows: 100, circleWalkable: () => true, isWalkableTile: () => true };
  world.isWalkable = () => true;
  world.randomSpawnPoint = () => ({ x: 60, z: 60 });
  world.__recalc = (w, e, o) => recalcStats(w, e, o);
  const player = createPlayer(world, { x: 50, z: 50 });
  world.player = player;
  world.map = { level: 1, tier: 1, mods: [] };
  world.tier = 1;
  world.hash = new SpatialHash(2);
  player.stats = recalcStats(world, player);
  player.hp = player.maxHp;
  player.mp = player.maxMp;
  world.stats = { kills: 0, waves: 0, waveActive: true, spawnTimer: 999, aliveCount: 0, spawnerReady: true, startTime: 0 };
  return world;
}

/** 单挑：玩家固定站位，怪放在 1.2 距离 */
export function duel(templateId, opts = {}) {
  const { level = 1, rarity = 'normal', maxSec = 90, playerLevel = 1, useSkills = true, dist = 1.2, seed = 1 } = opts;
  const world = makeArena(seed);
  const p = world.player;
  if (playerLevel > 1) {
    p.level = playerLevel;
    p.baseStats = recalcStats(world, { level: playerLevel, stats: {} }, {}) && p.baseStats;
  }
  world.monsters.length = 0;
  world.all.length = 0;
  world.all.push(p);
  const m = spawnMonster(world, templateId, 50 + dist, 50, { level, rarity });
  m.aggro = true;
  m.attackTimer = 1e9; // 只测量输出，不让怪还手（生存另测）
  const hp0 = m.maxHp;
  let basicHits = 0, casts = 0, t = 0, dead = false;
  // 战争践踏（stomp）控制统计：命中数 / 眩晕时长 / 踏地战甲覆盖率
  let stompCasts = 0, stompHits = 0, stunTime = 0, armorTime = 0;

  while (t < maxSec) {
    const dx = m.x - p.x, dz = m.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    p.moveX = 0; p.moveZ = 0;
    p.aim = { x: m.x, z: m.z };
    world.aim = { x: m.x, z: m.z };
    p.facing = Math.atan2(dx, dz);
    // 贴到 1.2 距离（模拟机器人贴身）
    if (d > dist + 0.15) { p.moveX = dx / d; p.moveZ = dz / d; }
    if (isChanneling(p)) releaseChannel(world, p);
    const before = m.hp;
    if (tryBasicAttack(world, p) > 0 && m.hp < before) basicHits++;
    if (useSkills) {
      // 1 号技能：战争践踏（原裂地斩 groundSlam 已整体替换）
      if (tryCast(world, p, 'stomp', p.aim)) stompCasts++;
      if (tryCast(world, p, 'warcry', p.aim)) casts++;
      tryCast(world, p, 'bloodRage', p.aim);
      tryCast(world, p, 'rally', p.aim);
    }
    updateCore(world, DT);
    // 施法后立刻读控制状态（同一帧的施法已经生效）
    if (m.stunTime > 0) stunTime += DT;
    if (hasWarStompArmor(p)) armorTime += DT;
    for (const ev of world.events) if (ev && ev.type === 'stomp' && Number.isFinite(ev.hits)) stompHits += ev.hits;
    world.events.length = 0;
    t += DT;
    if (m.dead) { dead = true; break; }
  }
  return {
    template: templateId,
    rarity,
    hp: Math.round(hp0),
    sec: Math.round(t * 100) / 100,
    basicHits,
    casts: casts + stompCasts,
    stompCasts,
    stompHits,
    // 眩晕覆盖：被控时长 / 总时长（越接近 1 说明几乎一直站着挨打）
    stunCoveragePct: t > 0 ? Math.round((stunTime / t) * 1000) / 10 : 0,
    // 踏地战甲（玩家自身护甲 buff）覆盖
    armorCoveragePct: t > 0 ? Math.round((armorTime / t) * 1000) / 10 : 0,
    killed: dead,
    dps: dead ? Math.round(hp0 / t) : 0,
    playerDmg: `${Math.round(p.stats.dmgMin)}-${Math.round(p.stats.dmgMax)}`,
    aps: Math.round(1.35 * (1 + (p.stats.attackSpeedMult || 0)) * 100) / 100,
  };
}

/**
 * 玩家身上有没有「踏地战甲」(warStompArmor) —— buff 容器可能是数组也可能是对象，两种都兼容。
 * core 还没实现这个 buff 时恒返回 false（覆盖率显示 0，不会报错）。
 * @param {Object} p
 * @returns {boolean}
 */
function hasWarStompArmor(p) {
  const buffs = p && p.buffs;
  if (!buffs) return false;
  const hit = (b) => !!b && (b.id === 'warStompArmor' || b.key === 'warStompArmor');
  if (Array.isArray(buffs)) return buffs.some(hit);
  if (typeof buffs === 'object') {
    if (hit(buffs.warStompArmor)) return true;
    for (const k in buffs) if (hit(buffs[k])) return true;
  }
  return false;
}

/** 玩家能不能扛住：不还手的玩家被同等级怪打死需要多少秒（生存测量） */
export function survive(templateId, opts = {}) {
  const { level = 1, rarity = 'normal', maxSec = 60, seed = 1 } = opts;
  const world = makeArena(seed);
  const p = world.player;
  world.monsters.length = 0;
  const m = spawnMonster(world, templateId, 51.2, 50, { level, rarity });
  m.aggro = true;
  m.attackTimer = 0;
  let t = 0;
  const hp0 = p.maxHp;
  while (t < maxSec) {
    p.moveX = 0; p.moveZ = 0;
    updateCore(world, DT);
    world.events.length = 0;
    t += DT;
    if (p.dead || p.hp <= 0) break;
  }
  return { template: templateId, level, aliveSec: Math.round(t * 100) / 100, hp0: Math.round(hp0), hpLeft: Math.round(p.hp) };
}

function parseArgs(argv) {
  const o = { seeds: 3, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seeds') o.seeds = Math.max(1, Number(argv[++i]));
    else if (argv[i] === '--json') o.json = argv[++i];
  }
  return o;
}

const isMain = (() => {
  try {
    const e = process.argv[1];
    return !!e && new URL(`file://${e.replace(/\\/g, '/')}`).href === import.meta.url;
  } catch { return false; }
})();

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const rows = [];
  const mobs = ['husk', 'crawler', 'skeleton', 'bomber', 'hellhound', 'brute', 'wraith'];
  for (const id of mobs) {
    for (let s = 1; s <= opts.seeds; s++) rows.push(duel(id, { seed: s, level: 1 }));
  }
  const elites = [];
  for (const id of ['brute', 'hellhound', 'wraith', 'husk']) {
    for (let s = 1; s <= opts.seeds; s++) elites.push(duel(id, { seed: s, level: 1, rarity: 'rare' }));
  }
  const bosses = [];
  for (let s = 1; s <= opts.seeds; s++) bosses.push(duel(BOSS_TEMPLATE_ID, { seed: s, level: 1, maxSec: 120 }));
  const surv = mobs.map((id) => survive(id, { seed: 1, level: 1 }));

  const avg = (arr, k) => Math.round((arr.reduce((a, b) => a + b[k], 0) / Math.max(1, arr.length)) * 100) / 100;
  const report = {
    playerAtLv1: { dmg: rows[0].playerDmg, aps: rows[0].aps, basicDpsTheoretical: Number(rows[0].playerDmg.split('-').reduce((a, b) => a + Number(b), 0)) / 2 * rows[0].aps },
    normal: rows.map((r) => ({ ...r })),
    elite: elites,
    boss: bosses,
    summary: {
      normalAvgSec: avg(rows, 'sec'),
      normalAvgBasicHits: avg(rows, 'basicHits'),
      normalMaxSec: Math.max(...rows.map((r) => r.sec)),
      eliteAvgSec: avg(elites, 'sec'),
      bossAvgSec: avg(bosses, 'sec'),
      bossAvgDps: avg(bosses, 'dps'),
      // 战争践踏控制收益（平均）
      stompCasts: avg(rows, 'stompCasts'),
      stompHits: avg(rows, 'stompHits'),
      stunCoveragePct: avg(rows, 'stunCoveragePct'),
      bossStunCoveragePct: avg(bosses, 'stunCoveragePct'),
      armorCoveragePct: avg(rows, 'armorCoveragePct'),
    },
    surviveVsNormal: surv,
    targets: {
      normalMobSec: '1-3 刀（约 0.8-2.5 秒）', eliteSec: '3-6 秒', bossSec: '15-40 秒',
      stunCoverage: '小怪 > 20%（践踏 CD 7 秒，单目标一次控 1.5-2.5 秒）',
    },
  };
  console.log('── 1 级玩家 vs 1 级地图 TTK ─────────────────────────────');
  console.log(`玩家面板：${rows[0].playerDmg} × ${rows[0].aps}/s（理论普攻 DPS ${report.playerAtLv1.basicDpsTheoretical.toFixed(1)}）`);
  console.log('\n小怪（普通）：');
  console.log('  模板        血量    耗时(s)  普攻命中  普攻DPS  践踏/命中  眩晕覆盖  击杀');
  for (const r of rows) {
    console.log(`  ${r.template.padEnd(11)} ${String(r.hp).padStart(5)}  ${String(r.sec).padStart(7)}  ${String(r.basicHits).padStart(8)}  ${String(Math.round(r.hp / Math.max(0.01, r.sec))).padStart(7)}  ${String(r.stompCasts + '/' + r.stompHits).padStart(9)}  ${String(r.stunCoveragePct + '%').padStart(8)}  ${r.killed ? '✅' : '❌超时'}`);
  }
  console.log('\n精英（rare，生命倍率见 monsters.spawnMonster 的 rareMult，当前 2.3）：');
  for (const r of elites) console.log(`  ${r.template.padEnd(11)} 血量 ${String(r.hp).padStart(5)}  耗时 ${String(r.sec).padStart(6)}s  践踏 ${r.stompCasts} 次/命中 ${r.stompHits}  眩晕覆盖 ${r.stunCoveragePct}%  ${r.killed ? '✅' : '❌超时'}`);
  console.log('\nBoss（深渊主宰 lv1）：');
  for (const r of bosses) console.log(`  血量 ${String(r.hp).padStart(5)}  耗时 ${String(r.sec).padStart(6)}s  DPS ${r.dps}  践踏 ${r.stompCasts} 次/命中 ${r.stompHits}  眩晕覆盖 ${r.stunCoveragePct}%  ${r.killed ? '✅' : '❌超时'}`);
  console.log('\n站桩挨打（不还手，被打死时间）：');
  for (const s of surv) console.log(`  ${s.template.padEnd(11)} ${s.aliveSec}s（血量 ${s.hp0}）`);
  // 战争践踏（stomp）控制收益一行摘要
  const sm = report.summary;
  console.log('\n战争践踏（stomp）控制收益：');
  console.log(`  单目标：平均施放 ${sm.stompCasts} 次 / 命中 ${sm.stompHits} 次   眩晕覆盖率 ${sm.stunCoveragePct}%   踏地战甲覆盖率 ${sm.armorCoveragePct}%`);
  console.log(`  Boss：  眩晕覆盖率 ${sm.bossStunCoveragePct}%（Boss 有眩晕抗性，偏低属预期）`);
  // [注意] 短 TTK 的怪（0.02~0.33 秒）会在践踏的眩晕生效前就被打死，或被一脚踩死（applyStun 因 dead 返回 false），
  // 所以「小怪平均眩晕覆盖率」会被这些样本拉低；看控制收益请对照「精英」那一栏。
  console.log('  （短 TTK 小怪常被一击秒杀，践踏的眩晕来不及计入；控制收益看上面「精英」一栏）');
  console.log('\n对照目标：小怪', report.targets.normalMobSec, '/ 精英', report.targets.eliteSec, '/ Boss', report.targets.bossSec);
  console.log('         践踏眩晕覆盖率', report.targets.stunCoverage);
  if (opts.json) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nJSON：${opts.json}`);
  }
}

export { survive as surviveTest };