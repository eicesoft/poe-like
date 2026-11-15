// @file tools/sim-bot-selftest.mjs
// 机器人自检：在真实核心逻辑上跑 Bot（不依赖 src/game/app.js）。
//
// 用途：
//   1) 当 src/items/{talentTree,skillTree,itemgen}.js 还没写完、app.js import 失败时，
//      用本文件验证 tools/playtest.mjs 的 AI 策略、掉落/拾取、换图、NaN 检查是否正常。
//   2) 作为核心层（core-only）的快速回归：不 import 任何 items/UI 模块。
//
// 用法: node tools/sim-bot-selftest.mjs [--minutes 2] [--seed 5] [--verbose]
// 退出码: 0 = 无异常/无 NaN；1 = 失败。
//
// 与 playtest.mjs 的差别：没有装备/天赋/背包（这些在 app.js 里），只有：
//   找怪 → 移动 → 普攻 + 技能 → 捡魂火 → 换图（loadMap）→ 统计。

import { createWorld, loadMap, isWalkable } from '../src/game/world.js';
import { SpatialHash } from '../src/engine/spatial.js';
import { createPlayer, updateCore } from '../src/core/index.js';
import {
  tryBasicAttack, tryCast, tryDash, releaseChannel, isChanneling,
} from '../src/core/skills.js';

/** skills.js 实际没有导出 SKILL_IDS，这里自己定义（与 makeSkillBar 默认技能栏一致） */
const SKILL_IDS = ['groundSlam', 'whirlwind', 'warcry', 'bloodRage', 'rally'];
import { recalcStats } from '../src/core/stats.js';
import { grantXp } from '../src/core/progression.js';
import { collectOrb } from '../src/core/loot.js';

const FPS = 60;
const DT = 1 / FPS;

function parseArgs(argv) {
  const o = { minutes: 2, seed: 5, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--minutes' || a === '-m') o.minutes = Number(argv[++i]);
    else if (a === '--seed' || a === '-s') o.seed = Number(argv[++i]);
    else if (a === '--verbose' || a === '-v') o.verbose = true;
  }
  return o;
}

/** 建一个最小可用的 headless world（复刻 app.js 里注入的钩子） */
export function makeCoreWorld(seed = 1, tier = 1) {
  const world = createWorld({ seed });
  world.isWalkable = (x, z, r = 0) => isWalkable(world, x, z, Math.max(r, 0.32));
  world.randomSpawnPoint = (minD = 9, maxD = 16) => randomSpawnPointOf(world, minD, maxD);
  world.__recalc = (w, e, o) => recalcStats(w, e, o);
  world.__grantXp = (w, e, amt) => grantXp(w, e, amt);
  const player = createPlayer(world, {});
  world.player = player;
  loadMap(world, { tier });
  player.x = world.dungeon.playerStart.x;
  player.z = world.dungeon.playerStart.z;
  player.stats = recalcStats(world, player);
  player.hp = player.maxHp;
  player.mp = player.maxMp;
  world.hash = new SpatialHash(2);
  return world;
}

function randomSpawnPointOf(world, minD, maxD) {
  const d = world.dungeon;
  const rng = world.rng;
  const p = world.player;
  for (let i = 0; i < 60; i++) {
    const cx = Math.floor(rng.range(2, d.cols - 2));
    const cz = Math.floor(rng.range(2, d.rows - 2));
    if (!d.isWalkableTile(cx, cz)) continue;
    const w = d.toWorld(cx, cz);
    const dd = Math.hypot(w.x - p.x, w.z - p.z);
    if (dd >= minD && dd <= maxD) return w;
  }
  return { x: p.x + 5, z: p.z + 5 };
}

/** 核心层的单帧「输入 → 更新」，等价于 app.updateGame 的玩家部分 */
function stepCore(world, input) {
  const p = world.player;
  world.time += DT;
  world.career.playTime += DT;
  if (!p.dead) {
    p.moveX = input.move.x; p.moveZ = input.move.z;
    world.aim.x = input.aim.x; world.aim.z = input.aim.z;
    p.aim = { x: input.aim.x, z: input.aim.z };
    if (input.dash) tryDash(world, p);
    if (input.attackHeld) {
      if (isChanneling(p)) releaseChannel(world, p);
      tryBasicAttack(world, p);
    }
    for (const s of input.skills) tryCast(world, p, s, world.aim);
    if (input.releaseChannels && !input.attackHeld) {
      if (isChanneling(p)) releaseChannel(world, p);
    }
  }
  updateCore(world, DT);
  // 魂火吸收（与 app.updateOrbs 相同规则）
  for (let i = world.lootOrbs.length - 1; i >= 0; i--) {
    const o = world.lootOrbs[i];
    if (o.collected) { world.lootOrbs.splice(i, 1); continue; }
    const dx = p.x - o.x, dz = p.z - o.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 9) {
      const d = Math.sqrt(d2) || 1;
      const pull = Math.min(1, (3.4 - Math.min(d, 3.4)) / 3.4);
      o.x += (dx / d) * DT * (6 + 14 * pull);
      o.z += (dz / d) * DT * (6 + 14 * pull);
    }
    if (!p.dead && d2 < 0.55 * 0.55) { collectOrb(world, p, o); world.lootOrbs.splice(i, 1); }
  }
  world.events.length = 0; // 模拟渲染层 clearEvents
}

export function runCoreSim({ minutes = 2, seed = 5, verbose = false } = {}) {
  const world = makeCoreWorld(seed, 1);
  const p = world.player;
  const stats = { kills: 0, hits: 0, dealt: 0, taken: 0, deaths: 0, traveled: 0, orbs: 0, gold: 0 };
  const nan = new Set();
  const peak = { monsters: 0, projectiles: 0, events: 0 };
  let lastPos = { x: p.x, z: p.z };
  let stuck = 0;
  let mapEnteredAt = 0;
  const mapDur = 60; // 自检时每 60 秒换图，跑得快
  const steps = Math.round(minutes * 60 * FPS);
  let elapsed = 0;

  for (let i = 0; i < steps; i++) {
    const input = { move: { x: 0, z: 0 }, aim: { x: p.x, z: p.z + 1 }, attackHeld: false, skills: [], dash: false, releaseChannels: false };
    // 最近怪
    let near = null, nd = Infinity;
    for (const m of world.monsters) {
      if (!m || m.dead) continue;
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < nd) { nd = d; near = m; }
    }
    const hpPct = p.hp / p.maxHp;
    let tx = p.x, tz = p.z;
    if (hpPct < 0.35 && near) {
      const dx = p.x - near.x, dz = p.z - near.z, l = Math.hypot(dx, dz) || 1;
      tx = p.x + (dx / l) * 6; tz = p.z + (dz / l) * 6;
      input.releaseChannels = true;
    } else if (near) {
      tx = near.x; tz = near.z;
    } else {
      const a = elapsed * 0.35;
      tx = p.x + Math.cos(a) * 6; tz = p.z + Math.sin(a) * 6;
    }
    const dx = tx - p.x, dz = tz - p.z, l = Math.hypot(dx, dz);
    // 卡住检测
    const moved = Math.hypot(p.x - lastPos.x, p.z - lastPos.z);
    lastPos = { x: p.x, z: p.z };
    if (l > 0.25 && moved < 0.02) stuck += DT; else stuck = Math.max(0, stuck - DT);
    if (l > 0.25) {
      if (stuck > 0.35) { input.move.x = -dz / l; input.move.z = dx / l; }
      else { input.move.x = dx / l; input.move.z = dz / l; }
    }
    if (near) input.aim = { x: near.x, z: near.z };
    if (near && nd <= 2.0) input.attackHeld = true;
    if (near && nd <= 2.6) input.skills.push('whirlwind');
    if (near && nd <= 3.8) input.skills.push('groundSlam');
    if (near && nd <= 6) input.skills.push('warcry', 'bloodRage', 'rally');

    stepCore(world, input);
    elapsed += DT;

    // 统计（事件已被 stepCore 清空，所以这里用 world.stats 的累计值 + 自己数）
    for (const it of world.lootOrbs) void it;
    stats.kills = world.stats.kills || 0;
    peak.monsters = Math.max(peak.monsters, world.monsters.length);
    peak.projectiles = Math.max(peak.projectiles, world.projectiles.length);

    if (!Number.isFinite(p.hp) || !Number.isFinite(p.x)) nan.add('player');

    if (p.dead) {
      stats.deaths++;
      p.dead = false; p.alive = true; p.hp = p.maxHp * 0.5; world.over = false;
    }
    if (elapsed - mapEnteredAt >= mapDur) {
      mapEnteredAt = elapsed;
      loadMap(world, { tier: world.tier + 1 });
      stats.traveled++;
    }
    if (verbose && Math.abs(elapsed % 10) < DT) {
      console.log(`[${elapsed.toFixed(0)}s] 层${world.tier} Lv${p.level} HP ${p.hp.toFixed(0)}/${p.maxHp.toFixed(0)} 击杀 ${stats.kills} 怪 ${world.monsters.length}`);
    }
  }
  return { stats, nan: [...nan], peak, elapsed, world };
}

const isMain = (() => {
  try {
    const e = process.argv[1];
    return !!e && new URL(`file://${e.replace(/\\/g, '/')}`).href === import.meta.url;
  } catch { return false; }
})();

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const r = runCoreSim(opts);
  const ok = r.nan.length === 0;
  console.log('── 核心层机器人自检 ──────────────────────────');
  console.log(`模拟 ${opts.minutes} 分钟 / seed=${opts.seed}：击杀 ${r.stats.kills}，死亡 ${r.stats.deaths}，换图 ${r.stats.traveled} 次，等级 ${r.world.player.level}`);
  console.log(`峰值：怪 ${r.peak.monsters}，投射物 ${r.peak.projectiles}；耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  console.log(`NaN：${ok ? '✅ 无' : '❌ ' + r.nan.join(',')}`);
  console.log(ok ? '结果：✅ 通过' : '结果：❌ 失败');
  process.exitCode = ok ? 0 : 1;
}

export { SKILL_IDS };