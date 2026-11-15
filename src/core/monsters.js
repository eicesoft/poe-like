// @file src/core/monsters.js
// 怪物模板 / 地图词缀 / 生成 / AI 状态机 / 投射物 / 地面效果 / 召唤物。
// 纯逻辑，不依赖 DOM / three。
//
// 【怪物实体附加字段】
//   ai: { state:'idle'|'chase'|'attack'|'recover'|'charge'|'dead', t:number, cooldown:number, ... }
//   mods: [{id, text, stats?}]     怪物词缀
//   rarity: 'normal'|'magic'|'rare'|'boss'
//   xp, aggro, spawnT, flash, height
//   移动相关：speedMult（词缀加成后）、baseSpeed
//   visual: {color, size, shape}   shape ∈ 'humanoid'|'quadruped'|'spider'|'wraith'|'blob'|'skeleton'
//
// 【AI 说明】
//   - 仇恨半径 aggroRadius；玩家在半径内或被打 → aggro=true
//   - chase：向玩家移动，遵守 world.isWalkable
//   - 近战进入 attackRange 后进入 attack，攻击有前摇（attackWindup），然后 hitFrame 结算
//   - 攻击无穿墙：只用 isWalkable 判定位置，不做视线检测
//   - 只发事件，不画任何东西（伤害数字由渲染层按 'hit' 事件生成）

import { clamp, createMonsterStats, recalcStats, refreshStats } from './stats.js';
import {
  dealDamage, pushWorldEvent, rngOf, normDir, dist, dist2, moveEntity, applyBuff, radiusOf, updateStun,
} from './combat.js';
import { monsterXpValue } from './progression.js';

/**
 * @typedef {Object} MonsterTemplate
 * @property {string} id 模板 id
 * @property {string} name 中文名
 * @property {number} hp 1 级血量
 * @property {number} damage 1 级攻击伤害（浮动 0.8~1.2）
 * @property {number} speed 移动速度（单位/秒）
 * @property {number} radius 碰撞半径
 * @property {number} xp 经验（1 级基值，实际按等级重算）
 * @property {number} attackRange 攻击距离
 * @property {number} attackCooldown 攻击间隔（秒）
 * @property {string} ai AI 类型：'melee'|'ranged'|'charger'|'heavy'|'bomber'|'wraith'
 * @property {{color:string,size:number,shape:string}} visual 视觉（渲染层依赖）
 * @property {number} [attackWindup] 前摇（秒）
 * @property {number} [attackSpeedMult]
 * @property {number} [armor]
 * @property {Object} [resists]
 * @property {number} [projectileSpeed] 远程投射物速度
 * @property {number} [aggroRadius]
 * @property {number} [knockbackResist]
 */

/** @type {Record<string, MonsterTemplate>} */
export const MONSTERS = {
  husk: {
    id: 'husk', name: '枯萎尸',
    hp: 34, damage: 7, speed: 2.6, radius: 0.45, xp: 8,
    attackRange: 1.35, attackCooldown: 1.25, attackWindup: 0.32,
    ai: 'melee', armor: 0,
    visual: { color: '#6f7a4a', size: 0.95, shape: 'humanoid' },
    aggroRadius: 12,
  },
  crawler: {
    id: 'crawler', name: '毒蛛',
    hp: 22, damage: 5, speed: 4.6, radius: 0.36, xp: 7,
    attackRange: 1.15, attackCooldown: 0.9, attackWindup: 0.2,
    ai: 'melee',
    visual: { color: '#7a3f9a', size: 0.72, shape: 'spider' },
    aggroRadius: 13,
    onHitPoison: { chance: 0.32, dps: 2.2, dur: 3 },
  },
  skeleton: {
    id: 'skeleton', name: '骸骨弓手',
    hp: 26, damage: 7, speed: 2.9, radius: 0.4, xp: 9,
    attackRange: 8.5, attackCooldown: 1.65, attackWindup: 0.45,
    ai: 'ranged', projectileSpeed: 15,
    visual: { color: '#d8d2bb', size: 0.92, shape: 'skeleton' },
    aggroRadius: 14,
    keepAway: 6.5,
  },
  hellhound: {
    id: 'hellhound', name: '地狱犬',
    hp: 42, damage: 9, speed: 3.6, radius: 0.5, xp: 11,
    attackRange: 1.4, attackCooldown: 1.2, attackWindup: 0.28,
    ai: 'charger',
    chargeCooldown: 4.2, chargeSpeed: 13, chargeRange: 6.5, chargeDamageMult: 1.6, chargeWindup: 0.42,
    visual: { color: '#a03822', size: 1.0, shape: 'quadruped' },
    aggroRadius: 13,
  },
  brute: {
    id: 'brute', name: '重装屠夫',
    // [playtest 平衡] 96 → 84：1 级普攻 5-6 刀偏肉（目标 1-3 刀的是小怪，brute 是 lv3+ 才刷的
    // 重量怪，84 血 → 4-5 刀），同时让「精英 brute」×2.3 后 TTK 落进 3-6 秒。
    hp: 84, damage: 11, speed: 2.0, radius: 0.68, xp: 16,
    attackRange: 1.85, attackCooldown: 1.95, attackWindup: 0.6,
    ai: 'heavy', armor: 25, knockbackResist: 0.6,
    visual: { color: '#8b5a2b', size: 1.3, shape: 'humanoid' },
    aggroRadius: 11,
  },
  wraith: {
    id: 'wraith', name: '幽魂',
    hp: 30, damage: 9, speed: 3.1, radius: 0.42, xp: 12,
    attackRange: 9.5, attackCooldown: 2.1, attackWindup: 0.6,
    ai: 'wraith', projectileSpeed: 11, pierce: 3,
    visual: { color: '#5f7fd6', size: 1.05, shape: 'wraith' },
    aggroRadius: 15,
    keepAway: 7,
    resistFire: 0.4, resistCold: 0.5,
    resists: { fire: 0.4, cold: 0.4, lightning: -0.2, chaos: 0.3 },
  },
  bomber: {
    id: 'bomber', name: '自爆尸',
    hp: 18, damage: 13, speed: 3.9, radius: 0.44, xp: 8,
    attackRange: 1.5, attackCooldown: 99, attackWindup: 0.55,
    ai: 'bomber', explodeRange: 1.9, explodeRadius: 2.8,
    visual: { color: '#c9b35a', size: 0.95, shape: 'blob' },
    aggroRadius: 14,
  },
};

/** Boss 模板：深渊主宰 */
export const BOSS_TEMPLATE_ID = 'abyssOverlord';

/**
 * 生成 Boss 模板。
 * 设计目标：15-30 秒击杀（玩家 lv1 DPS 约 40-60 时）。
 *
 * 注意：hp / damage 必须是 **1 级基础值** —— 等级缩放由 stats.createMonsterStats 统一处理，
 * 这里再按等级缩放会导致双重放大（lv5 Boss 会变成 1 万血）。
 * @param {number} [level] 仅用于微调细节（当前不参与 hp/damage）
 * @returns {MonsterTemplate}
 */
export function makeBossTemplate(level = 1) {
  const lv = clamp(level, 1, 30);
  return {
    id: BOSS_TEMPLATE_ID,
    name: '深渊主宰',
    // [playtest 平衡] 900 → 520：1 级玩家普攻 DPS 约 23（理论），900 血 = 39 秒（目标上限边缘），
    // 且实战里被击退/闪避后经常打到 60 秒以上。520 血 → 15-23 秒，落在 15-30 秒目标内。
    hp: 520,
    damage: 17,
    speed: 2.5,
    radius: 1.25,
    xp: 400,
    attackRange: 2.9,
    attackCooldown: 1.7,
    attackWindup: 0.55,
    ai: 'boss',
    armor: 40,
    knockbackResist: 0.95,
    baseDefaults: { critChance: 0.06, critMulti: 1.5, maxResistance: 0.75 },
    slamCooldown: 6.5,
    slamRadius: 5.2,
    slamWindup: 0.85,
    slamDamageMult: 1.9,
    visual: { color: '#4b1a6b', size: 2.1, shape: 'humanoid' },
    aggroRadius: 30,
    bossLevel: lv,
    resists: { fire: 0.35, cold: 0.25, lightning: 0.2, chaos: 0.5 },
    isBoss: true,
    // Boss 的眩晕抗性 0.6：践踏的有效控制只有 40%。Boss 战必须能被"打断/减速节奏"，
    // 但不能被 7 秒冷却的践踏无限锁死。
    stunResist: 0.6,
  };
}

/**
 * 地图词缀 → 怪物强化。每个词缀可带 mods 应用的 stats 与行为调整。
 * type: 'buff' | 'debuff' | 'neutral'
 */
export const MONSTER_MODS = {
  swift: { id: 'swift', name: '迅捷', text: '迅捷 · 移动速度 +25%', speedMult: 0.25, stats: { attackSpeedMult: 0.1 } },
  tough: { id: 'tough', name: '坚韧', text: '坚韧 · 最大生命 +40%', lifeMult: 0.4, stats: {} },
  armored: { id: 'armored', name: '铁甲', text: '铁甲 · 护甲 +60', stats: { armor: 60 } },
  berserk: { id: 'berserk', name: '狂暴', text: '狂暴 · 伤害 +30%，承受伤害 +10%', damageMult: 0.3, stats: { damageTakenMult: 0.1 } },
  swiftStrike: { id: 'swiftStrike', name: '疾风', text: '疾风 · 攻击速度 +30%', stats: { attackSpeedMult: 0.3 } },
  vampiric: { id: 'vampiric', name: '吸血', text: '吸血 · 攻击伤害的 12% 回复自身生命', stats: { lifeLeech: 0.12 } },
  fireAura: { id: 'fireAura', name: '火焰光环', text: '火焰光环 · 附加 30% 火焰伤害', stats: { fireDamageMult: 0.3, fireResist: 0.0 } },
  magicGuard: { id: 'magicGuard', name: '魔能护体', text: '魔能护体 · 元素抗性 +25%', stats: { fireResist: 0.25, coldResist: 0.25, lightningResist: 0.25 } },
  evasive: { id: 'evasive', name: '灵巧', text: '灵巧 · 闪避率 +12%', stats: { evasion: 0.12 } },
  toxic: { id: 'toxic', name: '剧毒', text: '剧毒 · 命中附加中毒', poison: { dps: 2.5, dur: 3 } },
};

/** 地图词缀 id 列表（spawner 会随机分配到地图上） */
export const MOD_IDS = Object.keys(MONSTER_MODS);

/** 词缀中文显示文本（给 Lead 的 world.map.mods 用） */
export function modText(id) {
  const m = MONSTER_MODS[id];
  return m ? m.text : id;
}

/** 模板血量系数（用于经验值） */
function templateHpFactor(t) {
  return clamp(t.hp / 34, 0.5, 3);
}

/**
 * 读取 Lead 在 world 上计算好的地图词缀倍率（world.mapMods）。
 * 结构：{ monsterLife, monsterDamage, monsterSpeed, monsterResist, monsterCount, itemQuantity }
 * 全部是"加成比例"，可为 0 或负。缺省时返回 null。
 * @param {Object|null} world
 * @returns {{monsterLife:number,monsterDamage:number,monsterSpeed:number,monsterResist:number,monsterCount:number,itemQuantity:number}|null}
 */
export function readMapMods(world) {
  const src = world && (world.mapMods || (world.map && world.map.mapMods));
  if (!src || typeof src !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out = {
    monsterLife: num(src.monsterLife),
    monsterDamage: num(src.monsterDamage),
    monsterSpeed: num(src.monsterSpeed),
    monsterResist: num(src.monsterResist),
    monsterCount: num(src.monsterCount),
    itemQuantity: num(src.itemQuantity),
  };
  if (!out.monsterLife && !out.monsterDamage && !out.monsterSpeed && !out.monsterResist
    && !out.monsterCount && !out.itemQuantity) return out;
  return out;
}

/**
 * 按地图等级生成怪物等级表（lv 1-30 缩放）。返回一个函数，也可以直接读 .templates。
 * @param {number} lv 地图等级
 * @returns {{level:number, scale:Object, statsOf:(id:string)=>Object, templates:Object}}
 */
export function makeLevelTable(lv) {
  const level = clamp(Math.floor(lv) || 1, 1, 30);
  const hpScale = 1 + 0.55 * (level - 1) + 0.045 * (level - 1) * (level - 1);
  const dmgScale = 1 + 0.28 * (level - 1);
  const xpScale = 1 + 0.35 * (level - 1);
  /** @type {Record<string, Object>} */
  const templates = {};
  for (const id in MONSTERS) {
    const t = MONSTERS[id];
    templates[id] = {
      ...t,
      hpBase: t.hp,
      damageBase: t.damage,
      level,
      hp: t.hp * hpScale,
      damage: t.damage * dmgScale,
      xp: Math.round(t.xp * xpScale),
    };
  }
  return {
    level,
    scale: { hp: hpScale, damage: dmgScale, xp: xpScale },
    statsOf: (id) => templates[id] || templates.husk,
    templates,
  };
}

/** 按权重挑一个怪物模板 id（地图等级影响） */
export function pickMonsterTemplateId(world, level = 1) {
  const rng = rngOf(world);
  const lv = Math.max(1, level);
  /** @type {Array<{id:string, weight:number}>} */
  const pool = [
    { id: 'husk', weight: 26 },
    { id: 'crawler', weight: 24 },
    { id: 'skeleton', weight: 18 },
    { id: 'bomber', weight: 12 },
    { id: 'hellhound', weight: lv >= 2 ? 12 : 0 },
    { id: 'brute', weight: lv >= 3 ? 9 : 0 },
    { id: 'wraith', weight: lv >= 4 ? 9 : 0 },
  ].filter((p) => p.weight > 0);
  const chosen = rng.weighted(pool);
  return chosen.id;
}

let _monsterId = 0;

/**
 * 生成一只怪物并插入 world.monsters / world.all / world.hash。
 *
 * @param {Object} world
 * @param {string} templateId 模板 id（MONSTERS 的键，或 BOSS_TEMPLATE_ID）
 * @param {number} x @param {number} z
 * @param {{level?:number, rarity?:'normal'|'magic'|'rare'|'boss', mods?:Array<string|Object>, elite?:boolean, name?:string}} [opts]
 * @returns {Object} 怪物实体
 */
export function spawnMonster(world, templateId, x, z, opts = {}) {
  const rng = rngOf(world);
  const map = (world && world.map) || {};
  const mapLevel = Math.max(1, Math.min(30, Math.floor(map.level || map.tier || (world && world.tier) || 1) || 1));
  const level = clamp(Math.floor(opts.level || mapLevel), 1, 30);
  const isBoss = templateId === BOSS_TEMPLATE_ID || opts.rarity === 'boss';
  const baseTpl = isBoss ? makeBossTemplate(level) : MONSTERS[templateId] || MONSTERS.husk;
  const rarity = opts.rarity || (opts.elite ? 'rare' : 'normal');

  // 稀有度倍率（生命倍率写进 baseStats.life，recalcStats 不会重复乘）
  // [playtest 平衡] 精英生命倍率 2.8 → 2.3：精英 brute 269血 实测 TTK 6.4-8.7s（目标 3-6s）
  const rareMult = rarity === 'boss' ? 1 : rarity === 'rare' ? 2.3 : rarity === 'magic' ? 1.6 : 1;
  const dmgMult = rarity === 'boss' ? 1 : rarity === 'rare' ? 1.35 : rarity === 'magic' ? 1.15 : 1;

  // 词缀：显式传入优先，否则按稀有度随机
  /** @type {Array<Object>} */
  const mods = [];
  // [playtest 平衡] Boss 的随机词缀池里排除「坚韧(+40%生命)」：Boss 基础血量是按 TTK 目标定的
  // （1 级 520 ≈ 15-20 秒），再随机 +40% 会让同一场 Boss 战在 12 秒和 30 秒之间乱跳，
  // 数值手感测试与 playtest 报告都无法稳定复现。其它词缀保留（它们不改变血量期望）。
  const bossModPool = MOD_IDS.filter((id) => {
    const def = MONSTER_MODS[id];
    return !(def && typeof def.lifeMult === 'number' && def.lifeMult > 0);
  });
  const modCount = isBoss ? 2 : rarity === 'rare' ? 2 : rarity === 'magic' ? 1 : 0;
  if (Array.isArray(opts.mods) && opts.mods.length) {
    for (const m of opts.mods) {
      const def = typeof m === 'string' ? MONSTER_MODS[m] : m;
      if (def && (!def.id || !mods.some((x) => x.id === def.id))) mods.push({ ...def, text: def.text || modText(def.id) });
    }
  } else if (modCount > 0) {
    const pickFrom = rng.shuffle(isBoss ? bossModPool : MOD_IDS);
    for (let i = 0; i < modCount && i < pickFrom.length; i++) {
      mods.push({ ...MONSTER_MODS[pickFrom[i]] });
    }
  }
  // 地图词缀：world.map.mods 里出现的怪物词缀有 50% 概率强化这只怪
  if (world && world.map && Array.isArray(world.map.mods)) {
    for (const mm of world.map.mods) {
      if (mm && mm.id && MONSTER_MODS[mm.id] && !mods.some((x) => x.id === mm.id) && rng.chance(0.5)) {
        mods.push({ ...MONSTER_MODS[mm.id] });
      }
    }
  }

  // lifeMult / speedMult / damageMult / poison 不属于 StatBlock，在这里单独汇总
  let lifeMult = rareMult;
  let speedMult = 1;
  let damageMult = dmgMult;
  let poison = baseTpl.onHitPoison || null;
  for (const m of mods) {
    if (m.lifeMult) lifeMult *= 1 + m.lifeMult;
    if (m.speedMult) speedMult *= 1 + m.speedMult;
    if (m.damageMult) damageMult *= 1 + m.damageMult;
    if (m.poison) poison = m.poison;
  }

  // 注意：mods[].stats 由 recalcStats → collectMonsterModStats 汇总，这里不能重复加
  const baseStats = createMonsterStats(level, baseTpl);
  baseStats.life *= lifeMult;
  // ---- 世界级地图词缀（Lead 的 world.mapMods）----
  // { monsterLife, monsterDamage, monsterSpeed, monsterResist } 均为"加成比例"（0.4 = +40%）
  const mm = readMapMods(world);
  if (mm) {
    if (mm.monsterLife) baseStats.life *= 1 + mm.monsterLife;
    if (mm.monsterDamage) {
      const k = 1 + mm.monsterDamage;
      baseStats.dmgMin *= k;
      baseStats.dmgMax *= k;
    }
    if (mm.monsterSpeed) speedMult *= 1 + mm.monsterSpeed;
    if (mm.monsterResist) {
      const r = mm.monsterResist;
      baseStats.fireResist += r;
      baseStats.coldResist += r;
      baseStats.lightningResist += r;
    }
  }

  const namePrefix = rarity === 'rare' ? '精英 · ' : rarity === 'magic' ? '魔法 · ' : '';
  const entity = {
    id: `m${++_monsterId}`,
    kind: 'monster',
    team: 1,
    type: baseTpl.id,
    name: isBoss ? baseTpl.name : opts.name || baseTpl.name,
    displayName: isBoss ? baseTpl.name : `${namePrefix}${baseTpl.name}`,
    level,
    x, z, vx: 0, vz: 0,
    facing: rng.range(0, Math.PI * 2),
    radius: baseTpl.radius * (isBoss ? 1 : rarity === 'rare' ? 1.15 : 1),
    template: baseTpl,
    rarity,
    elite: rarity === 'rare' && !isBoss,
    isBoss,
    mods,
    stats: {},
    baseStats,
    baseDefaults: baseTpl.baseDefaults || undefined,
    hp: 1, maxHp: 1, mp: 0, maxMp: 0,
    dead: false,
    speed: baseTpl.speed * speedMult,
    baseSpeed: baseTpl.speed,
    attackRange: baseTpl.attackRange,
    attackCooldown: baseTpl.attackCooldown,
    attackTimer: rng.range(0, 0.4),
    attackSpeedMult: 0,
    attackAnim: 0,
    anim: { state: 'idle', t: 0, dur: 0.4, dir: 0 },
    hitFlash: 0, flash: 0,
    xp: monsterXpValue(level, isBoss ? 'boss' : rarity, templateHpFactor(baseTpl)),
    aggro: isBoss,
    spawnT: (world && world.time) || 0,
    height: baseTpl.visual.size * 1.7,
    visual: baseTpl.visual,
    poison,
    resist: { phys: 0 },
    moveSpeedMult: 0,
    attackDamageMult: damageMult,
    knockbackResist: baseTpl.knockbackResist || 0,
    // ---- 眩晕（契约 §3.6）----
    // 模板显式给了 stunResist 就用模板值；否则按稀有度给默认抗性：
    //   Boss 0.6（践踏只剩 40% 时长，否则 5 只 Boss 被无限锁直接无敌）、精英 0.25、普通 0。
    // 放在 spawn 时就写好（而不是 applyStun 里临时推断）：渲染层/HUD 可以直接读来做图鉴。
    stunResist: typeof baseTpl.stunResist === 'number'
      ? clamp(baseTpl.stunResist, 0, 0.9)
      : isBoss ? 0.6 : rarity === 'rare' ? 0.25 : 0,
    stunTime: 0,
    stunMax: 0,
    stunSource: null,
    ai: {
      state: 'idle',
      t: 0,
      cooldown: rng.range(0.2, 1.0),
      chargeTimer: 0,
      windup: 0,
      anim: 0,
      lastHit: null,
      chargeDir: { x: 1, z: 0 },
      wanderT: 0,
      slamTimer: 4,
      isSlam: false,
    },
    buffs: [],
    lootRolled: false,
  };
  recalcStats(world, entity);
  entity.hp = entity.maxHp;

  if (world) {
    if (!Array.isArray(world.monsters)) world.monsters = [];
    if (!Array.isArray(world.all)) world.all = [];
    world.monsters.push(entity);
    world.all.push(entity);
    if (world.hash && typeof world.hash.insert === 'function') world.hash.insert(entity);
    if (world.stats) {
      world.stats.aliveCount = (world.stats.aliveCount || 0) + 1;
      if (isBoss) { world.stats.bossAlive = true; world.stats.bossHpMax = entity.maxHp; }
    }
  }
  pushWorldEvent(world, 'spawn', {
    x, z, entity, monster: entity, name: entity.displayName, templateId: baseTpl.id,
    rarity, elite: entity.elite, isBoss, shape: baseTpl.visual.shape,
    color: baseTpl.visual.color, size: baseTpl.visual.size,
  });
  if (isBoss) {
    pushWorldEvent(world, 'bossSpawn', { x, z, entity, name: entity.name, level });
  } else if (entity.elite) {
    pushWorldEvent(world, 'eliteSpawn', { x, z, entity, name: entity.displayName });
  }
  return entity;
}

/**
 * 玩家攻击结算（近战挥砍）。所有技能命中请用这个，保证附加伤害/暴击/吸血一致。
 *
 * [playtest 修复] 原来这里把 `(1 + stats.damageMult)` 乘进了 k，而 combat.dealDamage 第 178 行
 * 又会乘一次 `packet.damageMult`，导致每次命中伤害翻倍（1 级普攻 DPS 变成面板的 2 倍）。
 * 现在约定：**本函数产出的 phys/fire/cold/lightning 已经包含全部基础加成，
 * packet 上不再带 damageMult**，由 dealDamage 只做一次减免/暴击/范围结算。
 *
 * @param {Object} world @param {Object} player @param {Object} target
 * @param {{dmgPct?:number, area?:boolean, sourceSkill?:string, knockback?:number, tags?:string[], flatMult?:number, canCrit?:boolean, convertFirePct?:number, damageMult?:number}} opts
 *   damageMult：旧的「额外倍率」参数，仍然生效，但会被折进单次乘算（不会再与 dealDamage 叠加）。
 * @returns {ReturnType<typeof dealDamage>}
 */
export function playerHit(world, player, target, opts = {}) {
  if (!target || target.dead) return { amount: 0, hit: false, blocked: false, crit: false, element: 'phys', dead: false };
  const s = player.stats || {};
  const rng = rngOf(world);
  const pct = typeof opts.dmgPct === 'number' ? opts.dmgPct : 1;
  const flat = typeof opts.flatMult === 'number' ? opts.flatMult : 1;
  // 全局伤害加成（战吼 buff 等走 stats.damageMult）只在这里出现一次
  const k = pct * flat * (1 + (s.damageMult || 0)) * (opts.damageMult || 1);
  const conv = clamp(opts.convertFirePct || 0, 0, 1);
  const weaponRoll = rng.range(s.dmgMin || 0, Math.max(s.dmgMin || 0, s.dmgMax || 0));
  const rollAdd = (lo, hi) => (hi > 0 || lo > 0) ? rng.range(lo || 0, Math.max(lo || 0, hi || 0)) : 0;
  const phys = ((weaponRoll * (1 - conv) + rollAdd(s.physAddedMin, s.physAddedMax)) * (1 + (s.physDamageMult || 0))) * k;
  const fire = ((weaponRoll * conv + rollAdd(s.addedFireMin, s.addedFireMax)) * (1 + (s.fireDamageMult || 0))) * k;
  const cold = rollAdd(s.addedColdMin, s.addedColdMax) * (1 + (s.coldDamageMult || 0)) * k;
  const lightning = rollAdd(s.addedLightningMin, s.addedLightningMax) * (1 + (s.lightningDamageMult || 0)) * k;
  const packet = {
    phys, fire, cold, lightning, chaos: 0,
    // [playtest 修复] 不传 damageMult：倍率已在上面折进 k，避免 dealDamage 二次相乘
    canCrit: opts.canCrit !== false,
    area: !!opts.area,
    aoeMult: opts.area ? (s.aoeMult || 0) : 0,
    knockback: opts.knockback || 0,
    sourceSkill: opts.sourceSkill,
    tags: opts.tags || ['attack', 'melee'],
  };
  return dealDamage(world, player, target, packet);
}

// ---------------------------------------------------------------------------
// 怪物攻击辅助
// ---------------------------------------------------------------------------

/**
 * 怪物对玩家的一次攻击（近战/远程投射物调用）。
 * @param {Object} world @param {Object} m @param {Object} target
 * @param {{dmgMult?:number, sourceSkill?:string, knockback?:number, kind?:string}} [opts]
 */
export function monsterAttack(world, m, target, opts = {}) {
  if (!m || m.dead || !target || target.dead) return null;
  const s = m.stats || {};
  const dmgMult = (opts.dmgMult || 1) * (m.attackDamageMult || 1);
  const rng = rngOf(world);
  const phys = rng.range(s.dmgMin || 1, Math.max(s.dmgMin || 1, s.dmgMax || 2)) * dmgMult;
  const packet = {
    phys,
    fire: (s.addedFireMin || 0) * dmgMult,
    canCrit: true,
    knockback: opts.knockback || 0,
    sourceSkill: opts.sourceSkill || ('monster:' + m.type),
    tags: ['monster', opts.kind || 'attack'],
  };
  const res = dealDamage(world, m, target, packet);
  // 中毒（毒蛛 / 剧毒词缀）
  if (res.hit && m.poison && rng.chance(m.poison.chance || 0.3)) {
    applyPoison(world, m, target, m.poison.dps, m.poison.dur);
  }
  return res;
}

/**
 * 给目标施加中毒（持续伤害）。dot 不会被闪避。
 * @param {Object} world @param {Object} source @param {Object} target
 * @param {number} dps @param {number} dur
 */
export function applyPoison(world, source, target, dps, dur) {
  if (!target || target.dead) return;
  const sourceId = source ? source.id : 'env';
  applyBuff(world, target, {
    id: 'poison_' + sourceId,
    name: '中毒',
    text: `每秒受到 ${dps.toFixed(1)} 点混沌伤害`,
    type: 'debuff',
    dur,
    icon: '☠️',
    dot: { dps, element: 'chaos', source },
    onTick: (w, e, b, dt) => {
      if (e.dead) return;
      // 每秒结算（用累加器保证伤害总量准确）
      b._acc = (b._acc || 0) + dps * dt;
      if (b._acc >= 1) {
        const amt = Math.floor(b._acc);
        b._acc -= amt;
        dealDamage(w, b.dot.source || null, e, { chaos: amt, kind: 'dot', canCrit: false, sourceSkill: 'poison' });
      }
    },
  });
}

/**
 * 生成一枚怪物投射物。
 * @param {Object} world @param {Object} m
 * @param {{x:number,z:number}} from @param {{x:number,z:number}} to
 * @param {{speed?:number, damageMult?:number, pierce?:number, kind?:string, onHit?:Function}} opts
 */
export function spawnMonsterProjectile(world, m, from, to, opts = {}) {
  const d = normDir(to.x - from.x, to.z - from.z);
  const speed = (opts.speed || (m.template && m.template.projectileSpeed) || 14);
  const proj = {
    id: `p${++_projId}`,
    kind: 'monsterProjectile',
    owner: m,
    ownerId: m ? m.id : null,
    team: 1,
    x: from.x, z: from.z,
    vx: d.x * speed, vz: d.z * speed,
    speed,
    radius: 0.3,
    life: 3.2,
    pierce: opts.pierce || 0,
    damageMult: opts.damageMult || 1,
    skill: opts.kind || 'arrow',
    color: opts.color || (m && m.type === 'wraith' ? '#8ab4ff' : '#e8d8a0'),
    hitSet: new Set(),
    dead: false,
    t: 0,
  };
  if (!Array.isArray(world.projectiles)) world.projectiles = [];
  world.projectiles.push(proj);
  pushWorldEvent(world, 'projectile', { x: proj.x, z: proj.z, proj, color: proj.color, kind: proj.skill });
  return proj;
}
let _projId = 0;

/**
 * 更新投射物（怪物 → 玩家）。
 * 命中判定：与玩家距离 < proj.radius + player.radius。
 * @param {Object} world @param {number} dt
 */
export function updateProjectiles(world, dt) {
  if (!world || !Array.isArray(world.projectiles) || world.projectiles.length === 0) return;
  const player = world.player;
  const list = world.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p || p.dead) { list.splice(i, 1); continue; }
    p.t += dt;
    p.life -= dt;
    const nx = p.x + p.vx * dt;
    const nz = p.z + p.vz * dt;
    if (p.life <= 0 || (world.isWalkable && !world.isWalkable(nx, nz))) {
      p.dead = true;
      list.splice(i, 1);
      pushWorldEvent(world, 'projectileGone', { x: p.x, z: p.z, proj: p });
      continue;
    }
    p.x = nx;
    p.z = nz;
    if (!player || player.dead) continue;
    if (p.hitSet && p.hitSet.has(player.id)) continue;
    const rr = (p.radius || 0.3) + radiusOf(player);
    if (dist2(p.x, p.z, player.x, player.z) <= rr * rr) {
      if (p.hitSet) p.hitSet.add(player.id);
      const res = dealDamage(world, p.owner || null, player, {
        phys: ((p.owner && p.owner.stats ? (p.owner.stats.dmgMin + p.owner.stats.dmgMax) / 2 : 8) * (p.damageMult || 1)),
        canCrit: true,
        projectile: true,
        sourceSkill: 'projectile:' + (p.skill || 'arrow'),
        tags: ['projectile', 'monster'],
      });
      // [playtest 修复] dealDamage 里 `if (p.projectile) pushWorldEvent('projectileHit')` 已经推过一次，
      // 这里再推会让 UI 对一次命中处理两次（双倍飘字/双倍计数）。保留 combat 那份，这里改推 FX 专用事件。
      pushWorldEvent(world, 'projectileGone', {
        x: p.x, z: p.z, proj: p, projectile: p, target: player, amount: res.amount, crit: res.crit, hit: true,
      });
      if (p.pierce > 0) {
        p.pierce -= 1;
      } else {
        p.dead = true;
        list.splice(i, 1);
      }
    }
  }
}

/**
 * 添加地面效果（毒池/火焰符文等）。
 * 结构：{ id, kind:'poison'|'fire'|'frost', x, z, r, dps, dur, remaining, t, tick, owner, team, color }
 * @param {Object} world
 * @param {{kind?:string, x:number, z:number, r?:number, dps?:number, dur?:number, owner?:Object, team?:number, element?:string}} opts
 */
export function addGroundEffect(world, opts) {
  if (!world) return null;
  const ge = {
    id: `ge${++_geId}`,
    kind: opts.kind || 'fire',
    x: opts.x, z: opts.z,
    r: opts.r || 2.4,
    dps: opts.dps || 4,
    dur: opts.dur || 5,
    remaining: opts.dur || 5,
    tick: 0,
    tickRate: opts.tickRate || 0.5,
    element: opts.element || (opts.kind === 'poison' ? 'chaos' : opts.kind === 'frost' ? 'cold' : 'fire'),
    owner: opts.owner || null,
    team: typeof opts.team === 'number' ? opts.team : 1,
    color: opts.color || (opts.kind === 'poison' ? '#6fd03a' : opts.kind === 'frost' ? '#7fd0ff' : '#ff8a3a'),
    dead: false,
  };
  if (!Array.isArray(world.groundEffects)) world.groundEffects = [];
  world.groundEffects.push(ge);
  pushWorldEvent(world, 'ground', { x: ge.x, z: ge.z, effect: ge, kind: ge.kind, color: ge.color, r: ge.r, dur: ge.dur });
  return ge;
}
let _geId = 0;

/**
 * 更新地面效果：每 tickRate 秒对范围内敌对目标造成伤害。
 * @param {Object} world @param {number} dt
 */
export function updateGroundEffects(world, dt) {
  if (!world || !Array.isArray(world.groundEffects) || world.groundEffects.length === 0) return;
  const list = world.groundEffects;
  const player = world.player;
  for (let i = list.length - 1; i >= 0; i--) {
    const ge = list[i];
    if (!ge || ge.dead) { list.splice(i, 1); continue; }
    ge.remaining -= dt;
    ge.tick += dt;
    if (ge.remaining <= 0) {
      ge.dead = true;
      list.splice(i, 1);
      pushWorldEvent(world, 'groundGone', { x: ge.x, z: ge.z, effect: ge });
      continue;
    }
    if (ge.tick < ge.tickRate) continue;
    ge.tick -= ge.tickRate;
    const dmg = ge.dps * ge.tickRate;
    // 0 = 玩家阵营的地面效果（灼烧地面等）只伤害怪物；其余（怪物施放的毒池/火符）只伤害玩家
    if (ge.team === 0) {
      if (Array.isArray(world.monsters)) {
        for (const m of world.monsters) {
          if (!m || m.dead) continue;
          const rr = ge.r + radiusOf(m);
          if (dist2(ge.x, ge.z, m.x, m.z) <= rr * rr) {
            const packet = {};
            packet[ge.element] = dmg;
            packet.kind = 'dot';
            packet.canCrit = false;
            packet.sourceSkill = 'ground:' + ge.kind;
            dealDamage(world, ge.owner, m, packet);
          }
        }
      }
    } else if (player && !player.dead) {
      const rr = ge.r + radiusOf(player);
      if (dist2(ge.x, ge.z, player.x, player.z) <= rr * rr) {
        const packet = {};
        packet[ge.element] = dmg;
        packet.kind = 'dot';
        packet.canCrit = false;
        packet.sourceSkill = 'ground:' + ge.kind;
        dealDamage(world, ge.owner || null, player, packet);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/**
 * 取仇恨目标：玩家（若有召唤物仇恨可扩展）
 * 已死亡的玩家不再产生仇恨：否则怪物会一直对着尸体挥砍（渲染层看着像在攻击空气）。
 */
function acquireTarget(world, m) {
  const p = world.player;
  if (!p) return null;
  if (p.dead || p.alive === false) return null;
  return p;
}

/**
 * 切换渲染动画（只写数据，渲染层读）。
 */
function setAnim(m, state, dur) {
  if (!m.anim) m.anim = { state: 'idle', t: 0, dur: 0.3, dir: 0 };
  if (m.anim.state !== state) {
    m.anim.state = state;
    m.anim.t = dur || 0.3;
    m.anim.dur = dur || 0.3;
  }
}

/**
 * 让怪物朝某方向移动（遵守 isWalkable、与玩家的软碰撞）。
 * @param {Object} world @param {Object} m @param {number} dx @param {number} dz @param {number} speed @param {number} dt
 */
function moveMonster(world, m, dx, dz, speed, dt) {
  const d = normDir(dx, dz);
  if (d.len < 1e-6) return false;
  const vx = d.x * speed;
  const vz = d.z * speed;
  m.vx = vx;
  m.vz = vz;
  m.facing = Math.atan2(vx, vz);
  // [Lead 修复] 使用"碰撞圆"判定：怪物自身已经压到墙上时允许脱困（否则会永远卡死）；
  // 同时避免怪物整只压进墙里。
  // 注意：isWalkable 可能来自 dungeon（只要 x/z），也可能来自 app 的
  // `(x, z, r) => ...`（第三参是碰撞半径）—— 所以叠加判定只在它真的接受 3 个参数时传半径，
  // 否则多余参数会被 dungeon.circleWalkable 当成 "r" 用，导致怪物半身嵌进墙里。
  const acceptsRadius = typeof world.isWalkable === 'function' && world.isWalkable.length >= 3;
  const walkableAt = (x, z) => (acceptsRadius ? world.isWalkable(x, z, m.radius) : world.isWalkable(x, z));
  const step = (ox, oz) => {
    const nx = m.x + ox, nz = m.z + oz;
    if (typeof world.isWalkable !== 'function') return true;
    if (walkableAt(nx, nz)) return true;
    // 已经嵌墙：只要新位置不更糟（中心格可走）就允许移动
    if (!walkableAt(m.x, m.z) && walkableAt(nx, nz)) return true;
    return false;
  };
  const sd = dt || 1 / 60;
  const ox = vx * sd, oz = vz * sd;
  if (step(ox, oz)) { m.x += ox; m.z += oz; return true; }
  if (Math.abs(ox) > 1e-6 && step(ox, 0)) { m.x += ox; return true; }
  if (Math.abs(oz) > 1e-6 && step(0, oz)) { m.z += oz; return true; }
  const len = Math.hypot(ox, oz) || 1;
  const tx = -oz / len, tz = ox / len;
  const sign = m.__wallSign || 1;
  for (const s of [sign, -sign]) {
    const sx = tx * len * s, sz = tz * len * s;
    if (step(sx, sz)) { m.x += sx; m.z += sz; m.__wallSign = s; return true; }
  }
  return false;
}

/**
 * 击退/冲锋位移处理（kbTimer）。
 */
function applyKnockbackMotion(world, m, dt) {
  if (!(m.kbTimer > 0)) return false;
  m.kbTimer -= dt;
  if (m.kbTimer <= 0) { m.kbVX = 0; m.kbVZ = 0; return false; }
  moveEntity(world, m, m.kbVX * dt, m.kbVZ * dt);
  m.kbVX *= 0.86;
  m.kbVZ *= 0.86;
  return true;
}

/**
 * 更新所有怪物 AI。
 * @param {Object} world @param {number} dt
 */
export function updateMonsters(world, dt) {
  if (!world || !Array.isArray(world.monsters) || world.monsters.length === 0) return;
  const rng = rngOf(world);
  const list = world.monsters;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m) { list.splice(i, 1); continue; }
    if (m.dead) {
      // 死亡动画计时后从数组移除
      m.deadT = (m.deadT || 0) + dt;
      if (m.deadT > 1.4) {
        list.splice(i, 1);
        if (world.hash && typeof world.hash.remove === 'function') world.hash.remove(m);
        const ai = world.all ? world.all.indexOf(m) : -1;
        if (ai >= 0) world.all.splice(ai, 1);
        if (world.stats) world.stats.aliveCount = Math.max(0, (world.stats.aliveCount || 0) - 1);
        pushWorldEvent(world, 'despawn', { x: m.x, z: m.z, entity: m });
      }
      continue;
    }
    // 受击闪白衰减
    if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 4);
    if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt * 5);

    let moved = false;
    if (applyKnockbackMotion(world, m, dt)) moved = true;
    moved = updateMonsterAI(world, m, dt, rng) || moved;
    // [Lead 修复] AI 卡死兜底：追击速度>0 但连续 3 秒原地不动（被同伴挤住/寻路死角）→ 传送到玩家附近重新进场
    const p = world.player;
    if (p && !p.dead && m.ai && m.ai.state === 'chase' && m.ai.stuckT > 2.5) {
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d > 3) {
        const mdx = (m.x - p.x) / (d || 1), mdz = (m.z - p.z) / (d || 1);
        const ring = 3.2;
        for (let rr = ring; rr < ring + 2.5; rr += 0.5) {
          const nx = p.x + mdx * rr, nz = p.z + mdz * rr;
          if (world.isWalkable(nx, nz)) {
            m.x = nx;
            m.z = nz;
            break;
          }
        }
        m.ai.stuckT = 0;
        m.ai.t = 0;
        pushWorldEvent(world, 'spawn', { x: m.x, z: m.z, entity: m, respawn: true });
      }
    }

    // 渲染用速度平滑
    if (!moved) {
      m.vx *= 0.85;
      m.vz *= 0.85;
    }
    // [Lead 修复] 卡死检测：追击/冲锋状态长时间位移为 0 累积 stuckT
    const wasMoving = Math.abs(m.vx || 0) + Math.abs(m.vz || 0) > 0.05 || moved;
    m.ai.stuckT = wasMoving ? 0 : (m.ai.stuckT || 0) + dt;
    // [Lead 修复] 卡进墙体（碰撞圆压墙）也算卡死：长期无法寻回 → 把怪物挪到最近的合法地板
    // 同理：只有 isWalkable 接受半径时才传 m.radius（否则统一按 x/z 判定，绝不传 NaN/多余参数）
    const embedded = typeof world.isWalkable === 'function'
      && !(world.isWalkable.length >= 3 ? world.isWalkable(m.x, m.z, m.radius) : world.isWalkable(m.x, m.z));
    if (embedded) {
      m.ai.embedT = (m.ai.embedT || 0) + dt;
      if (m.ai.embedT > 0.6) {
        const d = world.dungeon;
        if (d && typeof d.findWalkableNear === 'function') {
          const p = d.findWalkableNear(m.x, m.z, 6);
          if (p) { m.x = p.x; m.z = p.z; }
        }
        m.ai.embedT = 0;
        m.ai.stuckT = 0;
      }
    } else {
      m.ai.embedT = 0;
    }
    // [Lead 修复] 远程「卡死」兜底：追击中长时间离玩家很远（寻路失败/BFS 绕不过来），
    // 每 6 秒把怪物挪到玩家周围 8~12 单位的可走点，避免整层怪卡在走廊另一端。
    if (m.ai.state === 'chase' && p && !p.dead) {
      const far = Math.hypot(p.x - m.x, p.z - m.z) > 12;
      if (far) m.ai.farT = (m.ai.farT || 0) + dt;
      else m.ai.farT = 0;
      if (m.ai.farT > 6) {
        m.ai.farT = 0;
        const spot = typeof world.randomSpawnPoint === 'function' ? world.randomSpawnPoint(8, 12) : null;
        if (spot) {
          m.x = spot.x;
          m.z = spot.z;
          pushWorldEvent(world, 'spawn', { x: m.x, z: m.z, entity: m, respawn: true });
        }
      }
    }
    m.attackAnim = Math.max(0, (m.attackAnim || 0) - dt * 3.2);
    if (m.anim && m.anim.t > 0) m.anim.t -= dt;
  }
}

/**
 * 单只怪物的 AI 状态机（在 updateMonsters 内部调用）。
 * @param {Object} world @param {Object} m @param {number} dt @param {Object} rng
 * @returns {boolean} 本帧是否移动了
 */
export function updateMonsterAI(world, m, dt, rng = rngOf(world)) {
  const ai = m.ai;
  const tpl = m.template || {};
  let moved = false;

  if (ai.state === 'dead') return false;

  // ---- 眩晕（契约 §3.6）----
  // 被控期间：不动（速度清零）、不攻击、不进冲锋蓄力、不自爆，连状态机都不推进。
  // 计时放在 AI 里而不是 updateCore：这样 direct 调用 updateMonsterAI 的测试/工具也能正常走完眩晕。
  if (updateStun(world, m, dt)) {
    m.vx = 0;
    m.vz = 0;
    m.kbTimer = 0;
    if (m.kbVX) m.kbVX = 0;
    if (m.kbVZ) m.kbVZ = 0;
    // 蓄力中的攻击/冲锋被打断：清掉计时，眩晕结束后从追击重新开始
    ai.windup = 0;
    if (ai.chargeDash) ai.chargeDash = 0;
    if (ai.state === 'charge' || ai.state === 'attack') {
      ai.state = 'chase';
      ai.isSlam = false;
    }
    setAnim(m, 'stun', 0.2);
    return false;
  }

  const target = acquireTarget(world, m);
  const speed = Math.max(0.6, (m.speed || 2.5) * (1 + (m.stats && m.stats.moveSpeedMult ? m.stats.moveSpeedMult : 0)));
  const aggroR = tpl.aggroRadius || 12;

  if (!target) {
    if (ai.state !== 'idle') { ai.state = 'idle'; setAnim(m, 'idle', 0.3); }
    return false;
  }
  // 攻击计时器：没有攻击时也在恢复（保证失焦后重新进入攻击不会卡冷却）
  if (m.attackTimer > 0) m.attackTimer = Math.max(0, m.attackTimer - dt);
  const d = dist(m.x, m.z, target.x, target.z);

  // 仇恨获取
  if (!m.aggro) {
    if (d < aggroR) m.aggro = true;
    else {
      ai.state = 'idle';
      setAnim(m, 'idle', 0.3);
      return false;
    }
  }

  const facingTarget = () => {
    const dd = normDir(target.x - m.x, target.z - m.z);
    if (dd.len > 0) m.facing = Math.atan2(dd.x, dd.z);
  };

  switch (ai.state) {
    case 'idle': {
      ai.state = 'chase';
      setAnim(m, 'walk', 0.2);
      return false;
    }
    case 'chase': {
      facingTarget();
      // 远程/幽魂保持距离
      if ((tpl.ai === 'ranged' || tpl.ai === 'wraith') && d < (tpl.keepAway || 6)) {
        const dd = normDir(m.x - target.x, m.z - target.z);
        m.vx = dd.x * speed * 0.8;
        m.vz = dd.z * speed * 0.8;
        moved = moveEntity(world, m, m.vx * dt, m.vz * dt);
        setAnim(m, 'walk', 0.2);
        break;
      }
      // 冲锋型：距离合适且冷却好了 → 蓄力
      if (tpl.ai === 'charger' && ai.chargeTimer <= 0 && d > 3 && d < (tpl.chargeRange || 6.5)) {
        ai.state = 'charge';
        ai.t = tpl.chargeWindup || 0.42;
        ai.windup = ai.t;
        ai.chargeDir = normDir(target.x - m.x, target.z - m.z);
        setAnim(m, 'charge', ai.t);
        break;
      }
      // Boss：近身 AOE 重击
      if (m.isBoss && ai.slamTimer <= 0 && d < (tpl.slamRadius || 5.2) * 0.9) {
        ai.state = 'attack';
        ai.isSlam = true;
        ai.t = tpl.slamWindup || 0.85;
        ai.windup = ai.t;
        setAnim(m, 'attack', ai.t);
        pushWorldEvent(world, 'telegraph', { x: m.x, z: m.z, entity: m, radius: tpl.slamRadius || 5.2, dur: ai.t, kind: 'slam' });
        break;
      }
      // 自爆尸：靠近就直接引爆
      if (tpl.ai === 'bomber' && d < (tpl.explodeRange || 1.9)) {
        ai.state = 'attack';
        ai.t = tpl.attackWindup || 0.55;
        ai.windup = ai.t;
        setAnim(m, 'attack', ai.t);
        break;
      }
      // 攻击距离内
      if (d <= (m.attackRange || 1.4) + radiusOf(target)) {
        if (m.attackTimer <= 0) {
          ai.state = 'attack';
          ai.t = tpl.attackWindup || 0.3;
          ai.windup = ai.t;
          ai.isSlam = false;
          setAnim(m, 'attack', ai.t + 0.15);
          m.attackAnim = 1;
        } else {
          // 原地待机等攻击间隔
          setAnim(m, 'idle', 0.2);
        }
        break;
      }
      // 追击
      const dd = normDir(target.x - m.x, target.z - m.z);
      m.vx = dd.x * speed;
      m.vz = dd.z * speed;
      moved = moveEntity(world, m, m.vx * dt, m.vz * dt);
      setAnim(m, 'walk', 0.2);
      break;
    }
    case 'charge': {
      ai.t -= dt;
      // 蓄力时锁定方向
      if (ai.t > 0) {
        m.facing = Math.atan2(ai.chargeDir.x, ai.chargeDir.z);
        setAnim(m, 'charge', ai.t);
        break;
      }
      // 开始冲锋：进入 recover 后由 chargeDash 计时驱动位移
      ai.state = 'recover';
      ai.t = 0.3;
      ai.chargeDash = 0.34;
      ai.chargeHit = false;
      ai.chargeTimer = tpl.chargeCooldown || 4.2;
      ai.chargeDirSaved = normDir(ai.chargeDir.x, ai.chargeDir.z);
      const cs = tpl.chargeSpeed || 13;
      m.vx = ai.chargeDirSaved.x * cs;
      m.vz = ai.chargeDirSaved.z * cs;
      moved = moveEntity(world, m, m.vx * dt, m.vz * dt);
      setAnim(m, 'dash', 0.34);
      m.attackAnim = 1;
      break;
    }
    case 'attack': {
      ai.t -= dt;
      m.facing = Math.atan2(target.x - m.x, target.z - m.z);
      if (ai.t <= 0) {
        if (ai.isSlam) {
          // Boss 重击：范围伤害
          ai.isSlam = false;
          const r = tpl.slamRadius || 5.2;
          pushWorldEvent(world, 'explosion', { x: m.x, z: m.z, r, radius: r, color: '#a04bff', kind: 'slam' });
          if (dist(m.x, m.z, target.x, target.z) <= r + radiusOf(target)) {
            // [playtest 修复] Boss 重击击退 9 → 4：原来一击把玩家推出 3-4 单位，
            // 玩家被推到刀锋外后追不上（Boss 半径大、攻击距离 2.9），实测有一次 Boss 战 120 秒打不掉 900 血。
            monsterAttack(world, m, target, { dmgMult: (tpl.slamDamageMult || 1.9), knockback: 4, sourceSkill: 'slam' });
          }
          applyGroundEffectFromBoss(world, m, r);
          ai.slamTimer = tpl.slamCooldown || 6.5;
          ai.state = 'recover';
          ai.t = 0.5;
        } else if (tpl.ai === 'bomber') {
          // 自爆（自身立即死亡，用 explosive 标记让掉落逻辑另行处理）
          explodeBomber(world, m, target);
          return moved;
        } else if (tpl.ai === 'ranged' || tpl.ai === 'wraith') {
          // 发射投射物
          spawnMonsterProjectile(world, m, { x: m.x, z: m.z }, { x: target.x, z: target.z }, {
            speed: tpl.projectileSpeed || 14,
            pierce: tpl.pierce || 0,
            damageMult: m.attackDamageMult || 1,
            kind: tpl.ai === 'wraith' ? 'wraithBolt' : 'arrow',
            color: tpl.ai === 'wraith' ? '#8ab4ff' : '#e8d8a0',
          });
          ai.state = 'recover';
          ai.t = Math.max(0.15, m.attackCooldown * 0.35);
        } else {
          // 近战命中
          // [playtest 修复] 普通近战不再击退玩家（heavy 从 4 → 2）：原来每一下都把玩家推离刀锋，
          // 加上 kb 会把玩家推进 ai.recover（中断攻击），玩家被多只怪围着时几乎打不出普攻。
          if (dist(m.x, m.z, target.x, target.z) <= (m.attackRange || 1.4) + radiusOf(target) + 0.4) {
            monsterAttack(world, m, target, { knockback: tpl.ai === 'heavy' ? 2 : 0, sourceSkill: 'melee' });
          }
          ai.state = 'recover';
          ai.t = Math.max(0.1, m.attackCooldown * 0.3);
        }
        m.attackTimer = m.attackCooldown / (1 + (m.stats && m.stats.attackSpeedMult ? m.stats.attackSpeedMult : 0));
      }
      break;
    }
    case 'recover': {
      ai.t -= dt;
      // 冲锋后的滑行
      if (ai.chargeDash > 0) {
        ai.chargeDash -= dt;
        const cd = ai.chargeDirSaved || ai.chargeDir;
        moved = moveEntity(world, m, cd.x * (tpl.chargeSpeed || 13) * dt, cd.z * (tpl.chargeSpeed || 13) * dt) || moved;
        if (dist(m.x, m.z, target.x, target.z) < m.radius + radiusOf(target) + 0.3 && !ai.chargeHit) {
          ai.chargeHit = true;
          // [playtest 修复] 冲撞击退 6 → 3（同上：过强的击退让近战玩家打不到怪）
          monsterAttack(world, m, target, { dmgMult: tpl.chargeDamageMult || 1.6, knockback: 3, sourceSkill: 'charge' });
        }
      }
      if (ai.t <= 0) {
        ai.state = 'chase';
        ai.chargeHit = false;
        setAnim(m, 'walk', 0.15);
      }
      break;
    }
    default: {
      ai.state = 'chase';
      break;
    }
  }
  // 计时器
  if (ai.chargeTimer > 0) ai.chargeTimer -= dt;
  if (ai.slamTimer > 0) ai.slamTimer -= dt;
  return moved;
}

/** Boss 重击后留下碎裂地面（火焰符文） */
function applyGroundEffectFromBoss(world, m, r) {
  if (!world || !m.isBoss) return;
  const rng = rngOf(world);
  const n = 2;
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = rng.range(0, r * 0.6);
    addGroundEffect(world, {
      kind: 'fire', x: m.x + Math.cos(a) * rr, z: m.z + Math.sin(a) * rr,
      r: 1.9, dps: 5 + m.level * 0.6, dur: 4, owner: m, team: 1,
    });
  }
}

/**
 * 自爆尸爆炸：范围伤害 + 自身死亡（由 combat.killEntity 处理经验/掉落）。
 * killEntity 从 world.__killEntity 动态取（避免 combat ↔ monsters 的静态循环依赖）。
 */
function explodeBomber(world, m, target) {
  const r = (m.template && m.template.explodeRadius) || 2.8;
  pushWorldEvent(world, 'explosion', { x: m.x, z: m.z, r, radius: r, color: '#ffb347', kind: 'bomber' });
  if (target && !target.dead && dist(m.x, m.z, target.x, target.z) <= r + radiusOf(target)) {
    monsterAttack(world, m, target, { dmgMult: 1.2, knockback: 8, sourceSkill: 'explode' });
  }
  m.exploded = true;
  const kill = (world && world.__killEntity) || null;
  if (kill) kill(world, m, world.player || null);
  else m.dead = true;
}

// ---------------------------------------------------------------------------
// 召唤物（战士图腾）
// ---------------------------------------------------------------------------

let _summonId = 0;

/**
 * 召唤一个图腾 / 召唤物。
 * 结构：{ id, kind:'summon', type:'totem', x, z, hp, maxHp, dur, radius, owner, team:0, visual }
 * @param {Object} world @param {Object} owner @param {number} x @param {number} z
 * @param {{type?:string, dur?:number, hp?:number, radius?:number}} [opts]
 */
export function spawnSummon(world, owner, x, z, opts = {}) {
  const type = opts.type || 'totem';
  const dur = opts.dur || 6;
  const s = {
    id: `s${++_summonId}`,
    kind: 'summon',
    team: 0,
    type,
    name: type === 'totem' ? '坚毅图腾' : '召唤物',
    x, z, vx: 0, vz: 0,
    radius: opts.radius || 0.5,
    hp: opts.hp || 60,
    maxHp: opts.hp || 60,
    dead: false,
    dur,
    remaining: dur,
    owner,
    ownerId: owner ? owner.id : null,
    level: owner ? owner.level : 1,
    height: 1.6,
    visual: { color: '#7fd68a', size: 0.8, shape: 'totem' },
    anim: { state: 'idle', t: 0, dur: 0.5, dir: 0 },
    auraRadius: opts.auraRadius || 5.5,
    stats: {},
    buffs: [],
  };
  if (!Array.isArray(world.summoned)) world.summoned = [];
  world.summoned.push(s);
  if (world.all) world.all.push(s);
  pushWorldEvent(world, 'summon', { x, z, entity: s, type });
  return s;
}

/**
 * 更新召唤物：寿命倒计时 + 光环效果（图腾：范围内回复法力）。
 * @param {Object} world @param {number} dt
 */
export function updateSummons(world, dt) {
  if (!world || !Array.isArray(world.summoned) || world.summoned.length === 0) return;
  const list = world.summoned;
  const player = world.player;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s) { list.splice(i, 1); continue; }
    s.remaining -= dt;
    if (s.dead || s.remaining <= 0) {
      s.dead = true;
      list.splice(i, 1);
      const ai = world.all ? world.all.indexOf(s) : -1;
      if (ai >= 0) world.all.splice(ai, 1);
      pushWorldEvent(world, 'summonGone', { x: s.x, z: s.z, entity: s });
      continue;
    }
    if (s.type === 'totem' && player && !player.dead) {
      const rr = (s.auraRadius || 5.5);
      if (dist2(s.x, s.z, player.x, player.z) <= rr * rr) {
        // 每秒回 3% 法力
        player.mp = Math.min(player.maxMp, player.mp + player.maxMp * 0.03 * dt);
        player.inTotemAura = true;
        // 图腾也会缓慢削弱周围怪物（象征性）
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 工具：范围查询
// ---------------------------------------------------------------------------

/**
 * 圆形范围查询（优先用 world.hash，回退数组遍历）。
 * @param {Object} world @param {number} x @param {number} z @param {number} r
 * @param {(e:Object)=>boolean} [filter]
 * @returns {Array<Object>}
 */
export function queryEnemies(world, x, z, r, filter) {
  if (!world) return [];
  const player = world.player;
  const baseFilter = (e) => e && !e.dead && e !== player && (e.kind === 'monster' || e.team === 1) && (!filter || filter(e));
  if (world.hash && typeof world.hash.queryCircle === 'function') {
    const out = world.hash.queryCircle(x, z, r, baseFilter);
    if (out && out.length) return out;
  }
  const out = [];
  const list = world.monsters || [];
  for (const m of list) {
    if (!baseFilter(m)) continue;
    if (dist2(x, z, m.x, m.z) <= r * r) out.push(m);
  }
  return out;
}

/**
 * 扇形判定：目标是否在玩家前方 arc（弧度）内。
 * @param {number} px @param {number} pz @param {number} facing @param {number} tx @param {number} tz @param {number} arc
 */
export function inArc(px, pz, facing, tx, tz, arc) {
  // facing 由 atan2(dx, dz) 得到；朝向向量 = (sin, cos)
  const fx = Math.sin(facing), fz = Math.cos(facing);
  const d = normDir(tx - px, tz - pz);
  if (d.len === 0) return true;
  const dot = fx * d.x + fz * d.z;
  const ang = Math.acos(clamp(dot, -1, 1));
  return ang <= arc / 2;
}

/** 重新导出，方便外部使用 */
export { refreshStats };