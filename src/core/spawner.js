// @file src/core/spawner.js
// 随机地图刷怪与波次：持续刷新小怪、精英波（每 15 波）、Boss（每 25 波）。
// 纯逻辑，不依赖 DOM / three。
//
// 【world.stats 字段（本模块维护）】
//   kills, elitesKilled, bossKilled, waves, waveActive, spawnTimer, aliveCount,
//   startTime, spawnCap, bossAlive, bossTimer, bossWave, nextWaveIn, waveTime, xpGained
//
// 【刷怪规则】
//   - 依据地图等级决定同屏上限 aliveCap = 14 + 2.4*(lv-1)（Boss 战时暂停刷小怪）
//   - 每 SPAWN_INTERVAL 秒检查：aliveCount < aliveCap 就补怪（一次补 1-3 只）
//   - 每波持续 WAVE_DURATION 秒，波次结束推 'waveEnd'，下一波推 'waveStart'
//   - 波数 % 15 === 0 → 精英波：2 只精英（稀有）
//   - 波数 % 25 === 0 → Boss 波：刷 1 只 Boss，Boss 存活期间暂停小怪刷新

import { pushWorldEvent, rngOf, dist2 } from './combat.js';
import { spawnMonster, pickMonsterTemplateId, BOSS_TEMPLATE_ID, MONSTER_MODS, MOD_IDS, readMapMods } from './monsters.js';

/** 每次小怪刷新的检查间隔（秒） */
export const SPAWN_INTERVAL = 2.2;
/** 一波持续时长（秒） */
export const WAVE_DURATION = 20;
/** 精英波间隔（波数） */
export const ELITE_WAVE_EVERY = 15;
/** Boss 波间隔（波数） */
export const BOSS_WAVE_EVERY = 12;
/** 精英波精英数量 */
export const ELITE_WAVE_COUNT = 2;

/**
 * 按地图等级计算同屏怪物上限。
 * lv1 → 14，lv30 → 约 84。
 * @param {number} mapLevel
 */
export function aliveCapFor(mapLevel) {
  return Math.round(14 + 2.4 * (Math.max(1, mapLevel) - 1));
}

/**
 * 世界当前的地图等级：优先 map.level，其次 map.tier / world.tier，默认 1。
 * （Lead 用 tier 表示地图难度，两个字段都兼容，限制在 1..30）
 * @param {Object} world
 * @returns {number}
 */
export function mapLevelOf(world) {
  const map = (world && world.map) || {};
  const lv = map.level || map.tier || (world && world.tier) || 1;
  return Math.max(1, Math.min(30, Math.floor(lv) || 1));
}

/**
 * 地图面积相对旧版中等地图的系数（1~1.8）。
 * 没有 dungeon 的世界（headless 测试）返回 1，保持旧行为。
 * @param {Object} world
 */
export function mapSizeFactor(world) {
  const d = world && world.dungeon;
  const f = d && Number.isFinite(d.sizeFactor) ? d.sizeFactor : 1;
  return Math.max(1, Math.min(1.8, f));
}

/**
 * 综合地图档位（tier）与地图词缀的最终同屏上限。
 * - 等级取 map.level；若只有 map.tier 则 tier 直接作为等级使用（Lead 用 tier 表示地图难度）
 * - 词缀 monsterCount（「蜂拥」+50% 数量）在基础上限上叠加
 * - 大地图按面积提高上限，维持"走到哪都有怪"的密度
 * @param {Object} world
 * @returns {number}
 */
export function computeAliveCap(world) {
  const base = aliveCapFor(mapLevelOf(world));
  const mm = readMapMods(world);
  const mult = mm ? Math.max(0.3, 1 + mm.monsterCount) : 1;
  return Math.max(4, Math.round(base * mult * mapSizeFactor(world)));
}

/**
 * 初始化刷怪器状态（Lead 在地图创建时调用；updateCore 也会懒初始化）。
 * @param {Object} world @param {{level?:number}} [opts]
 */
export function initSpawner(world, opts = {}) {
  if (!world) return;
  if (!world.stats) world.stats = {};
  const st = world.stats;
  const mapLevel = opts.level || mapLevelOf(world);
  if (st.startTime === undefined) st.startTime = world.time || 0;
  if (st.spawnTimer === undefined) st.spawnTimer = 0;
  if (st.waves === undefined) st.waves = 0;
  if (st.waveActive === undefined) st.waveActive = false;
  if (st.aliveCount === undefined) st.aliveCount = 0;
  if (st.aliveCap === undefined) st.aliveCap = computeAliveCap(world);
  if (st.bossAlive === undefined) st.bossAlive = false;
  if (st.bossTimer === undefined) st.bossTimer = 0;
  if (st.waveTime === undefined) st.waveTime = 0;
  if (st.kills === undefined) st.kills = 0;
  if (st.elitesKilled === undefined) st.elitesKilled = 0;
  if (st.bossKilled === undefined) st.bossKilled = 0;
  st.spawnerReady = true;
}

/**
 * 取一个合法的刷怪点（距玩家 >= 9）：优先 world.randomSpawnPoint()，否则用随机角度兜底。
 * 注意：Lead 的 randomSpawnPoint 可能接受 (minD, maxD) 参数，这里两个参数都传。
 * @param {Object} world @param {Object} player
 * @returns {{x:number,z:number}}
 */
export function getSpawnPoint(world, player) {
  if (world && typeof world.randomSpawnPoint === 'function') {
    const p = world.randomSpawnPoint(MIN_SPAWN_DIST, MAX_SPAWN_DIST);
    if (p && typeof p.x === 'number' && typeof p.z === 'number') return p;
  }
  const rng = rngOf(world);
  const px = player ? player.x : 0;
  const pz = player ? player.z : 0;
  for (let i = 0; i < 40; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(MIN_SPAWN_DIST, MAX_SPAWN_DIST);
    const x = px + Math.cos(a) * r;
    const z = pz + Math.sin(a) * r;
    if (!world || !world.isWalkable || world.isWalkable(x, z)) return { x, z };
  }
  return { x: px + MAX_SPAWN_DIST, z: pz };
}

/** 刷怪距离下限（契约：距玩家 >= 9） */
export const MIN_SPAWN_DIST = 9.5;
/** 刷怪距离上限 */
export const MAX_SPAWN_DIST = 17;

/**
 * 计算当前存活的怪物数量（不含死亡动画中的）。
 * @param {Object} world
 */
export function countAlive(world) {
  if (!world || !Array.isArray(world.monsters)) return 0;
  let n = 0;
  for (const m of world.monsters) if (m && !m.dead) n++;
  return n;
}

/**
 * 刷一只普通小怪。
 * @param {Object} world @returns {Object|null}
 */
export function spawnRegular(world) {
  const player = world.player;
  const mapLevel = mapLevelOf(world);
  const pt = getSpawnPoint(world, player);
  const id = pickMonsterTemplateId(world, mapLevel);
  return spawnMonster(world, id, pt.x, pt.z, { level: mapLevel, rarity: 'normal' });
}

/**
 * 刷一波精英（默认 2 只稀有怪）。
 * @param {Object} world @param {number} [count]
 * @returns {Array<Object>}
 */
export function spawnEliteWave(world, count = ELITE_WAVE_COUNT) {
  const out = [];
  const mapLevel = mapLevelOf(world);
  const rng = rngOf(world);
  const heavyPool = ['brute', 'hellhound', 'wraith', 'husk'];
  for (let i = 0; i < count; i++) {
    const pt = getSpawnPoint(world, world.player);
    const id = rng.pick(heavyPool);
    out.push(spawnMonster(world, id, pt.x, pt.z, { level: mapLevel, rarity: 'rare', elite: true }));
  }
  pushWorldEvent(world, 'eliteWave', { x: out[0] ? out[0].x : 0, z: out[0] ? out[0].z : 0, count, monsters: out });
  return out;
}

/**
 * 刷 Boss「深渊主宰」。
 * Boss 存活期间 world.stats.bossAlive = true，spawner 暂停小怪刷新。
 * @param {Object} world
 * @returns {Object|null}
 */
export function spawnBoss(world) {
  if (!world) return null;
  const mapLevel = mapLevelOf(world);
  const pt = getSpawnPoint(world, world.player);
  const boss = spawnMonster(world, BOSS_TEMPLATE_ID, pt.x, pt.z, { level: mapLevel, rarity: 'boss' });
  if (world.stats) {
    world.stats.bossAlive = true;
    world.stats.bossWave = world.stats.waves || 1;
    world.stats.bossHp = boss.hp;
    world.stats.bossHpMax = boss.maxHp;
    world.stats.bossName = boss.name;
  }
  pushWorldEvent(world, 'bossWave', { x: boss.x, z: boss.z, entity: boss, name: boss.name, level: mapLevel });
  return boss;
}

/**
 * 波次开始（推 waveStart）。波数由 stats.waves 决定，并按规则刷精英/Boss。
 * @param {Object} world
 */
export function startWave(world) {
  const st = world.stats;
  st.waves = (st.waves || 0) + 1;
  st.waveActive = true;
  st.waveTime = 0;
  const n = st.waves;
  const isEliteWave = n % ELITE_WAVE_EVERY === 0;
  const isBossWave = n % BOSS_WAVE_EVERY === 0;
  pushWorldEvent(world, 'waveStart', {
    x: world.player ? world.player.x : 0,
    z: world.player ? world.player.z : 0,
    wave: n, eliteWave: isEliteWave, bossWave: isBossWave,
    text: isBossWave ? `第 ${n} 波 · 深渊主宰降临` : isEliteWave ? `第 ${n} 波 · 精英来袭` : `第 ${n} 波`,
  });
  if (isBossWave) {
    spawnBoss(world);
  } else if (isEliteWave) {
    spawnEliteWave(world, ELITE_WAVE_COUNT);
  }
  // 立刻补一批小怪（波次开场只给少量，避免一上来就淹没玩家）
  const cap = st.aliveCap || computeAliveCap(world);
  const alive = countAlive(world);
  const openingBatch = n === 1 ? 2 : 3;
  const batch = Math.min(openingBatch, Math.max(0, cap - alive));
  for (let i = 0; i < batch; i++) spawnRegular(world);
}

/**
 * 每帧更新刷怪器。由 updateCore 调用。
 * @param {Object} world @param {number} dt
 */
export function updateSpawner(world, dt) {
  if (!world) return;
  if (!world.stats || !world.stats.spawnerReady) initSpawner(world);
  const st = world.stats;
  const player = world.player;
  if (world.over || (player && player.dead)) {
    // 玩家死亡后停止刷怪（保留已有怪物）
    st.aliveCount = countAlive(world);
    return;
  }
  st.aliveCap = computeAliveCap(world);
  st.aliveCount = countAlive(world);

  // ---- 波次计时 ----
  if (!st.waveActive) {
    startWave(world);
  } else {
    st.waveTime = (st.waveTime || 0) + dt;
    if (st.waveTime >= WAVE_DURATION) {
      st.waveActive = false;
      pushWorldEvent(world, 'waveEnd', { x: player ? player.x : 0, z: player ? player.z : 0, wave: st.waves });
    }
  }

  // ---- Boss 状态同步 ----
  if (st.bossAlive) {
    const boss = world.monsters ? world.monsters.find((m) => m && m.isBoss && !m.dead) : null;
    if (boss) {
      st.bossHp = boss.hp;
      st.bossHpMax = boss.maxHp;
    } else {
      st.bossAlive = false;
      st.bossHp = 0;
    }
  }

  // ---- 小怪刷新 ----
  st.spawnTimer = (st.spawnTimer || 0) - dt;
  if (st.spawnTimer > 0) return;
  st.spawnTimer = SPAWN_INTERVAL;
  if (st.bossAlive) return; // Boss 活着时暂停小怪刷新

  const alive = st.aliveCount;
  const cap = st.aliveCap;
  if (alive >= cap) return;
  const rng = rngOf(world);
  // 大地图每个补怪间隔多补 1~2 只，缩短"从空图刷到满"的时间
  const maxBatch = 2 + Math.floor((mapSizeFactor(world) - 1) * 1.5);
  const batch = Math.min(rng.int(1, maxBatch), cap - alive);
  for (let i = 0; i < batch; i++) spawnRegular(world);
  st.aliveCount = countAlive(world);
}

/**
 * 更新进度统计（Lead 可单独调用，updateCore 已包含）。
 * 维护 kills / elapsed / 最近击杀距离等 UI 需要的字段。
 * @param {Object} world @param {number} dt
 */
export function updateWorldStats(world, dt) {
  if (!world || !world.stats) return;
  const st = world.stats;
  if (st.startTime === undefined) st.startTime = world.time || 0;
  st.elapsed = (world.time || 0) - st.startTime;
  st.aliveCount = countAlive(world);
  if (world.player) {
    st.playerHp = world.player.hp;
    st.playerHpMax = world.player.maxHp;
    st.playerMp = world.player.mp;
    st.playerMpMax = world.player.maxMp;
    st.playerLevel = world.player.level;
    st.playerXp = world.player.xp || 0;
  }
  void dt;
}

/**
 * 随机为地图分配怪物词缀（Lead 建图时写入 world.map.mods）。
 * 返回的词缀对象结构与契约一致：{ id, text, type, value }；
 * spawnMonster 会读取 world.map.mods 里的 id 来强化怪物。
 * @param {Object} world @param {number} [count]
 * @returns {Array<{id:string,text:string,type:string,value:number,name:string}>}
 */
export function rollMapMods(world, count = 2) {
  const rng = rngOf(world);
  const ids = rng.shuffle(MOD_IDS).slice(0, Math.max(0, Math.min(count, MOD_IDS.length)));
  return ids.map((id) => {
    const def = MONSTER_MODS[id];
    return {
      id,
      name: def.name,
      text: def.text,
      type: id === 'fireAura' || id === 'toxic' || id === 'berserk' ? 'deadly' : 'monster',
      value: mapModValue(def),
    };
  });
}

/** 从词缀定义里粗略取一个数值（给 UI 显示难度） */
function mapModValue(def) {
  if (typeof def.lifeMult === 'number') return def.lifeMult;
  if (typeof def.speedMult === 'number') return def.speedMult;
  if (typeof def.damageMult === 'number') return def.damageMult;
  return 0.2;
}

/**
 * 波次信息（UI 用）。
 * @param {Object} world
 * @returns {{wave:number, waveActive:boolean, waveTime:number, waveDuration:number, alive:number, cap:number, bossAlive:boolean, nextEliteWave:number, nextBossWave:number}}
 */
export function waveInfo(world) {
  const st = (world && world.stats) || {};
  const wave = st.waves || 0;
  return {
    wave,
    waveActive: !!st.waveActive,
    waveTime: st.waveTime || 0,
    waveDuration: WAVE_DURATION,
    alive: st.aliveCount || 0,
    cap: st.aliveCap || computeAliveCap(world),
    bossAlive: !!st.bossAlive,
    nextEliteWave: (Math.floor(wave / ELITE_WAVE_EVERY) + 1) * ELITE_WAVE_EVERY,
    nextBossWave: (Math.floor(wave / BOSS_WAVE_EVERY) + 1) * BOSS_WAVE_EVERY,
  };
}

/**
 * 距离玩家最近的怪物（UI 血条/仇恨提示用）。
 * @param {Object} world @param {number} [maxDist]
 */
export function nearestMonster(world, maxDist = 100) {
  const player = world && world.player;
  if (!player || !world.monsters) return null;
  let best = null;
  let bd = maxDist * maxDist;
  for (const m of world.monsters) {
    if (!m || m.dead) continue;
    const d = dist2(player.x, player.z, m.x, m.z);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}