// @file src/core/index.js
// 游戏核心逻辑统一入口：createPlayer / updateCore / 各模块 re-export。
// 纯逻辑，禁止 import DOM / three —— 必须能在 Node 下跑。
//
// 【每帧固定顺序（updateCore）】dt 固定 1/60；**本函数不推进 world.time**（由 Lead 维护）
//   0. 字段兜底 + 安装 world 钩子 + 刷怪器懒初始化
//   1. buff 倒计时 / 持续伤害（玩家 + 怪物）
//   2. 玩家资源：法力回复 / 生命回复 / 护盾回复（脱战 2 秒后回盾）
//   3. 玩家移动：moveX/moveZ → 速度（基础 6.2 × (1+moveSpeedMult)），遵守 isWalkable 贴墙滑行
//   4. 玩家技能：冷却倒计时、持续施法（旋风斩）、攻速/无敌/前摇计时
//   5. 怪物投射物（命中玩家 / 落地消失）
//   6. 地面效果（毒池、火焰符文等，按 tickRate 结算 dot）
//   7. 怪物 AI（仇恨 → 追击 → 攻击/冲锋/自爆；死亡动画后出数组）
//   8. 召唤物（图腾回蓝）
//   9. 刷怪器（波次计时 / 持续刷怪 / 每 15 波精英 / 每 25 波 Boss）
//  10. 拾取物 ttl（items 120 秒、lootOrbs 60 秒）
//  11. 统计（updateWorldStats，只读快照，不递增 kills）
//
// 【world 上本模块读取的字段】
//   time, rng, events, player, monsters, all, hash, projectiles, groundEffects,
//   summoned, items, lootOrbs, map { level|tier, mods, name, isBoss }, tier,
//   mapMods { monsterLife, monsterDamage, monsterSpeed, monsterResist, monsterCount, itemQuantity },
//   stats, busy, over, isWalkable(x,z), randomSpawnPoint(minD,maxD), itemGen, emit(evt) | emit(type,payload)
//
// 【world 上由本模块安装的钩子（下划线前缀，内部使用）】
//   world.__grantXp / world.__rollLoot / world.__recalc / world.__killEntity

import { createBaseStats, recalcStats } from './stats.js';
import { updateBuffs, killEntity } from './combat.js';
import {
  makeSkillBar, tickSkills, tryCast, tryDash, tryBasicAttack, releaseChannel,
  BASE_MOVE_SPEED, isChanneling, SKILL_IDS,
} from './skills.js';
import {
  updateMage, createMageState, MAGE_SKILL_IDS, MAGE_LOOK, isMage,
} from './mage.js';
import {
  updateMonsters, updateProjectiles, updateGroundEffects, updateSummons,
} from './monsters.js';
import { updateSpawner, updateWorldStats, initSpawner } from './spawner.js';
import { rollLoot, dropOrbs, updateLootTtl } from './loot.js';
import { grantXp } from './progression.js';

export * from './stats.js';
export * from './combat.js';
export * from './skills.js';
// 法师：半自动循环 / 印记 / 反应 / 共鸣 / 元素狂潮（纯核心）
export * from './mage.js';
// 技能等级 / 天赋聚合的最终数值计算（纯核心，不依赖 items 层，契约 §2.3 / §3.3）
export * from './skillsUpgrade.js';
export * from './monsters.js';
export * from './spawner.js';
export * from './loot.js';
export * from './progression.js';

/**
 * @typedef {Object} PlayerEntity
 * @property {string} id
 * @property {'player'} kind
 * @property {number} team 0
 * @property {number} level
 * @property {number} x @property {number} z
 * @property {number} moveX @property {number} moveZ 方向（0..1，由输入层写入）
 * @property {number} facing 弧度
 * @property {number} hp @property {number} maxHp
 * @property {number} mp @property {number} maxMp
 * @property {number} energyShield
 * @property {Object} stats StatBlock
 * @property {Array<Object|null>} skillBar 长度 7
 * @property {Object<string,number>} cooldowns
 * @property {Object<string,number>} combat
 */

/**
 * 职业基础属性（等级成长）。
 * 战士沿用原有曲线；法师换成「低生命、高法力、稳定远程法术伤害」。
 * 必须在 createPlayer 与 app 的 recalcPlayer 共用，否则读档/升级会把法师属性冲回战士。
 *
 * @param {number} level
 * @param {'warrior'|'mage'} [classId]
 * @returns {import('./stats.js').StatBlock}
 */
export function createClassBaseStats(level = 1, classId = 'warrior') {
  const lv = Math.max(1, Math.floor(level));
  const n = lv - 1;
  const base = createBaseStats(lv);
  if (classId === 'mage') {
    base.life = 88 + 10 * n + 0.9 * n * n;
    base.lifeRegen = 0.8 + 0.1 * n;
    base.mana = 100 + 12 * n;
    base.manaRegen = 7 + 0.6 * n;
    base.energyShield = 0;
    base.armor = 0;
    base.evasion = 0;
    base.dmgMin = 10 + 1.2 * n;
    base.dmgMax = 17 + 1.8 * n;
    base.critChance = 0.06;
    base.moveSpeedMult = 0.05;
  } else {
    // 战士：保留原有 12-22 起手武器伤害
    base.dmgMin = 12 + 1.6 * n;
    base.dmgMax = 22 + 2.4 * n;
  }
  return base;
}

/**
 * 创建玩家。
 * 初始：1 级、战士 120hp/60mp，法师 88hp/100mp；5 个技能。
 *
 * @param {Object} world 世界对象（用于登记 world.player / world.all / world.hash）
 * @param {{x?:number, z?:number, level?:number, name?:string, classId?:'warrior'|'mage'}} [opts]
 * @returns {PlayerEntity}
 */
export function createPlayer(world, opts = {}) {
  const level = Math.max(1, Math.floor(opts.level || 1));
  const x = typeof opts.x === 'number' ? opts.x : 0;
  const z = typeof opts.z === 'number' ? opts.z : 0;
  const classId = opts.classId === 'mage' ? 'mage' : 'warrior';
  const baseStats = createClassBaseStats(level, classId);
  /** @type {any} */
  const player = {
    id: 'player',
    kind: 'player',
    team: 0,
    type: classId,
    name: opts.name || (classId === 'mage' ? '元素法师' : '流浪战士'),
    level,
    x, z,
    vx: 0, vz: 0,
    facing: 0,
    radius: 0.45,
    height: 1.7,

    hp: Math.max(1, baseStats.life),
    maxHp: Math.max(1, baseStats.life),
    mp: Math.max(0, baseStats.mana),
    maxMp: Math.max(0, baseStats.mana),
    energyShield: 0,
    esRegen: 1,
    manaRegen: baseStats.manaRegen || 4.5,

    dead: false,
    alive: true,

    baseStats,
    talentStats: {},
    equipStats: {},
    pendingXp: 0,
    talentPoints: 0,
    unspentPoints: 0,
    levelsGained: 0,
    xp: 0,
    gold: 0,

    // 移动/输入
    moveX: 0, moveZ: 0,
    speedMult: 1,
    attackSpeedMult: 0,
    attackCooldown: 0,
    attackTimer: 0,
    attackAnim: 0,
    castLock: 0,
    invuln: 0,
    isDashing: false,
    dashTimer: 0,
    channelHold: false,
    aim: { x, z },
    moveSpeedPenalty: 0,

    // 技能：战士为 5 个近战技能；法师为火/冰/雷填充 + 炎爆 + 元素狂潮。
    skillBar: makeSkillBar(classId === 'mage' ? MAGE_SKILL_IDS.slice() : SKILL_IDS.slice()),
    cooldowns: {},
    // 技能升级数据（app 层写入；核心缺省时全部按中性值跑，见 skillsUpgrade.js）
    skillMods: {},
    skills: {},

    // 法师自动循环状态（战士为 null）
    mage: classId === 'mage' ? createMageState() : null,

    // 视觉
    look: classId === 'mage' ? { ...MAGE_LOOK } : undefined,
    anim: { state: 'idle', t: 0, dur: 0.3, dir: 0 },
    hitFlash: 0,
    flash: 0,

    buffs: [],
    statsRaw: null,
  };
  recalcStats(world, player, { refill: true });
  player.hp = player.maxHp;
  player.mp = player.maxMp;
  player.energyShield = player.stats.energyShield;

  if (world) {
    world.player = player;
    if (!Array.isArray(world.all)) world.all = [];
    if (!world.all.includes(player)) world.all.push(player);
    if (world.hash && typeof world.hash.insert === 'function') world.hash.insert(player);
    installWorldHooks(world);
  }
  return player;
}

/**
 * 把一个已存在的玩家切换成指定职业（读档 / 重新开始用）。
 * 只改职业相关字段，不重算属性；调用方随后执行 game.recalcPlayer()。
 *
 * @param {Object} player
 * @param {'warrior'|'mage'} classId
 * @returns {Object} player
 */
export function applyPlayerClass(player, classId) {
  if (!player || typeof player !== 'object') return player;
  const cid = classId === 'mage' ? 'mage' : 'warrior';
  player.type = cid;
  player.name = cid === 'mage' ? '元素法师' : '流浪战士';
  player.skillBar = makeSkillBar(cid === 'mage' ? MAGE_SKILL_IDS.slice() : SKILL_IDS.slice());
  player.cooldowns = {};
  player.castLock = 0;
  player.channelHold = false;
  player.mage = cid === 'mage' ? createMageState() : null;
  player.look = cid === 'mage'
    ? { ...MAGE_LOOK }
    : { armorColor: '#8a1f1f', weaponType: 'axe', cape: true };
  return player;
}

/**
 * 在 world 上安装核心钩子（允许 core 模块间无需静态循环依赖地互相调用）。
 * 重复调用是安全的，但**不会覆盖调用方（Lead）已经设置的钩子**：
 *   - world.__recalc / __grantXp / __killEntity：仅在缺失时安装
 *   - 掉落钩子用 world.__coreRollLoot（核心专用名），避免与 Lead 的 world.__rollLoot 冲突；
 *     若 Lead 自己实现了 __rollLoot，核心仍会通过 __coreRollLoot 产生掉落。
 * @param {Object} world
 */
export function installWorldHooks(world) {
  if (!world) return;
  if (typeof world.__grantXp !== 'function') world.__grantXp = grantXp;
  if (typeof world.__recalc !== 'function') world.__recalc = (w, e, o) => recalcStats(w, e, o);
  if (typeof world.__killEntity !== 'function') world.__killEntity = killEntity;
  if (typeof world.__coreRollLoot !== 'function') {
    world.__coreRollLoot = (w, monster) => {
      if (!monster || monster.noLoot) return [];
      if (monster.exploded) return dropOrbs(w, monster.x, monster.z, 'gold', 1);
      return rollLoot(w, monster);
    };
  }
  // 兼容：没有 Lead 版 __rollLoot 时，核心自己提供一份
  if (typeof world.__rollLoot !== 'function') world.__rollLoot = world.__coreRollLoot;
  return world;
}

/**
 * 法力/生命/护盾的回复与资源结算。
 * @param {Object} world @param {Object} player @param {number} dt
 */
export function updatePlayerResources(world, player, dt) {
  if (!player || player.dead) return;
  const s = player.stats || {};
  // 法力
  const manaRegen = (s.manaRegen || 0) * (player.manaRegenMult || 1);
  if (manaRegen > 0) player.mp = Math.min(player.maxMp, player.mp + manaRegen * dt);
  // 生命
  if ((s.lifeRegen || 0) > 0 && player.hp < player.maxHp) {
    player.hp = Math.min(player.maxHp, player.hp + s.lifeRegen * dt);
  }
  // 能量护盾（脱战 2 秒后按 esRegen 回复）
  player.noDamageTimer = (player.noDamageTimer || 0) + dt;
  if (s.energyShield > 0) {
    if (player.energyShield < s.energyShield && player.noDamageTimer > 2) {
      player.energyShield = Math.min(s.energyShield, player.energyShield + (player.esRegen || 1) * dt);
      if (player.energyShield >= s.energyShield) player.energyShield = s.energyShield;
    } else if (player.energyShield > s.energyShield) {
      player.energyShield = s.energyShield;
    }
  } else if ((player.energyShield || 0) > 0) {
    player.energyShield = 0;
  }
}

/**
 * 玩家移动：读取 moveX/moveZ（输入层写入），根据属性计算速度，遵守 isWalkable 的滑行。
 * @param {Object} world @param {Object} player @param {number} dt
 */
export function updatePlayerMovement(world, player, dt) {
  if (!player || player.dead) return;
  const s = player.stats || {};
  let mx = player.moveX || 0;
  let mz = player.moveZ || 0;
  const len = Math.sqrt(mx * mx + mz * mz);
  if (len > 1) { mx /= len; mz /= len; }
  let speed = BASE_MOVE_SPEED * (1 + (s.moveSpeedMult || 0));
  // 施法中减速（旋风斩 -25%，其他持续施法也稍慢）
  if (isChanneling(player)) speed *= 1 + (player.channelSpeedPenalty || -0.25);
  // 其他施法惩罚
  speed *= 1 + (player.moveSpeedPenalty || 0);
  speed = Math.max(0.8, speed);
  const vx = mx * speed;
  const vz = mz * speed;
  player.vx = vx;
  player.vz = vz;
  if (Math.abs(mx) > 0.01 || Math.abs(mz) > 0.01) {
    player.facing = Math.atan2(mx, mz);
    if (player.anim && player.anim.state !== 'attack' && player.anim.state !== 'dash' && player.anim.state !== 'cast') {
      player.anim.state = 'walk';
      player.anim.t = 0.2;
      player.anim.dur = 0.2;
    }
  } else if (player.anim && player.anim.state === 'walk') {
    player.anim.state = 'idle';
    player.anim.t = 0.3;
    player.anim.dur = 0.3;
  }
  if (player.isDashing) return; // 翻滚期间位移由 tryDash 即时完成
  const nx = player.x + vx * dt;
  const nz = player.z + vz * dt;
  const walkable = (x, z) => !world || typeof world.isWalkable !== 'function' || world.isWalkable(x, z);
  if (walkable(nx, nz)) {
    player.x = nx;
    player.z = nz;
  } else {
    // 贴墙滑行
    if (walkable(nx, player.z)) player.x = nx;
    if (walkable(player.x, nz)) player.z = nz;
  }
  player.anim && (player.anim.dir = player.facing);
}

/**
 * 核心每帧更新。Lead 的主循环每帧调用一次（固定 dt = 1/60）。
 * **本函数不推进 world.time** —— 由 Lead 在调用前 world.time += dt。
 * 顺序见文件头注释。
 * @param {Object} world
 * @param {number} dt
 */
export function updateCore(world, dt) {
  if (!world) return;
  if (typeof world.time !== 'number') world.time = 0;
  if (!Array.isArray(world.events)) world.events = [];
  if (!Array.isArray(world.monsters)) world.monsters = [];
  if (!Array.isArray(world.all)) world.all = [];
  if (!Array.isArray(world.projectiles)) world.projectiles = [];
  if (!Array.isArray(world.groundEffects)) world.groundEffects = [];
  if (!Array.isArray(world.summoned)) world.summoned = [];
  if (!Array.isArray(world.items)) world.items = [];
  if (!Array.isArray(world.lootOrbs)) world.lootOrbs = [];
  if (!world.stats) world.stats = {};
  installWorldHooks(world);
  if (!world.stats.spawnerReady) {
    world.stats.startTime = world.time;
    initSpawner(world);
  }

  const player = world.player;

  // 1. buff 倒计时 / 持续伤害（玩家 + 怪物）
  if (player) updateBuffs(world, player, dt);
  for (const m of world.monsters) if (m && !m.dead && m.buffs && m.buffs.length) updateBuffs(world, m, dt);

  if (player) {
    // 玩家态校验
    if (!player.dead && player.hp <= 0) killEntity(world, player, null);
    if (player.dead) player.alive = false;
    // 待结算经验（来自 combat 的兜底路径）
    if (player.pendingXp) {
      const amt = player.pendingXp;
      player.pendingXp = 0;
      grantXp(world, player, amt);
    }
    // buff 属性变化但缺少 __recalc 时的兜底
    if (player.needsRecalc) {
      player.needsRecalc = false;
      recalcStats(world, player);
    }
    // 2. 玩家资源（法力/生命/护盾）
    updatePlayerResources(world, player, dt);
    // 3. 玩家移动（遵守 isWalkable）
    updatePlayerMovement(world, player, dt);
    // 4. 玩家技能：冷却 / 持续施法 / 攻速与无敌计时
    tickSkills(world, player, dt);
    // 5. 法师自动循环（战士直接返回）
    if (isMage(player)) updateMage(world, player, dt);
  }

  // 5. 怪物投射物
  updateProjectiles(world, dt);
  // 6. 地面效果
  updateGroundEffects(world, dt);
  // 7. 怪物 AI
  updateMonsters(world, dt);
  // 8. 召唤物
  updateSummons(world, dt);
  // 9. 刷怪器
  updateSpawner(world, dt);
  // 10. 拾取物 ttl
  updateLootTtl(world, dt);
  // 11. 统计（只读快照；kills 等由 combat 维护，这里不重复递增）
  updateWorldStats(world, dt);
}

/**
 * 便捷：推进世界 time 并调用 updateCore（Lead 若自己维护 time 则只调 updateCore）。
 * @param {Object} world @param {number} dt
 */
export function step(world, dt = 1 / 60) {
  if (!world) return;
  world.time = (world.time || 0) + dt;
  updateCore(world, dt);
}

/**
 * 玩家使用物品/装备后由 Lead 调用：重算属性并保留血量比例。
 * @param {Object} world @param {Object} player
 */
export function refreshPlayerStats(world, player) {
  return recalcStats(world, player || (world && world.player));
}

/** 全部键（供 Lead 的调试/存档使用） */
export const CORE_EXPORTS = Object.freeze({
  createPlayer, updateCore, step, tryCast, tryDash, releaseChannel, tryBasicAttack,
  installWorldHooks, refreshPlayerStats,
});