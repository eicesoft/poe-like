// @file src/core/progression.js
// 经验与等级：xpForLevel / grantXp / 升级带来的属性成长与天赋点。
// 纯逻辑，不依赖 DOM / three。

import { clamp, createBaseStats } from './stats.js';
import { pushWorldEvent } from './combat.js';

/** 玩家等级上限 */
export const MAX_LEVEL = 60;

/**
 * 每升 1 级获得的天赋点（Lead 口径：每级 +2 天赋点、+1 技能点）。
 * 技能点的「每级 +1」在 src/game/app.js 的 skillPointsForLevel 里。
 */
export const TALENT_POINTS_PER_LEVEL = 2;

/**
 * 升到 level+1 所需经验（level 为当前等级）。
 * POE 手感：前期几刀一个怪，1 级 → 2 级大约 6~8 只小怪。
 * 曲线：base * level^1.55 * 难度系数（每 10 级再乘一次难度）。
 * @param {number} level 当前等级（>=1）
 * @returns {number} 所需经验（整数）
 */
export function xpForLevel(level) {
  const lv = Math.max(1, Math.floor(level));
  const base = 40;
  const curve = Math.pow(lv, 1.55);
  const tier = 1 + Math.floor((lv - 1) / 10) * 0.35; // 每 10 级额外提升难度
  return Math.round(base * curve * tier);
}

/**
 * 怪物经验值（按等级与稀有度）。
 * 普通怪 lv1 = 6，配合 xpForLevel(1)=40 → 前期 1 级升 2 级约 7 只小怪（POE 手感）。
 * 稀有度倍率：魔法 ×1.6，精英/稀有 ×4，Boss ×20。
 * @param {number} level @param {'normal'|'magic'|'rare'|'boss'} [rarity]
 * @param {number} [hpFactor] 模板血量系数（血厚的怪给更多经验）
 */
export function monsterXpValue(level, rarity = 'normal', hpFactor = 1) {
  const lv = Math.max(1, level);
  const mult = rarity === 'boss' ? 20 : rarity === 'rare' ? 4 : rarity === 'magic' ? 1.6 : 1;
  return Math.max(1, Math.round((4 + 2 * lv) * mult * clamp(hpFactor, 0.5, 3)));
}

/**
 * 给实体（通常是玩家）增加经验，处理连续升级。
 * 升级效果：
 *   - level + 1
 *   - 重新计算属性（recalcStats，keepRatioMode:'gap' → maxHp 增长量直接加到当前血量上）
 *   - 蓝量同步增长
 *   - 推 'levelUp' 事件 { level, unspentPoints, gainedPoints: +2 天赋点 }
 *   - 天赋点记在 entity.talentPoints / world.talentPoints
 * @param {Object} world
 * @param {Object} entity 获得经验的实体
 * @param {number} amount 经验值
 * @returns {number} 实际获得经验
 */
export function grantXp(world, entity, amount) {
  if (!entity || entity.dead || !(amount > 0)) return 0;
  if ((entity.kind && entity.kind !== 'player') || entity.team !== 0) {
    // 怪物没有经验
    return 0;
  }
  const before = entity.level;
  entity.xp = (entity.xp || 0) + amount;
  entity.xpGained = (entity.xpGained || 0) + amount;
  if (world && world.stats) world.stats.xpGained = (world.stats.xpGained || 0) + amount;

  let levelUps = 0;
  while (entity.level < MAX_LEVEL && entity.xp >= xpForLevel(entity.level)) {
    entity.xp -= xpForLevel(entity.level);
    entity.level += 1;
    levelUps++;
    // 升级：把等级成长写进 baseStats（baseStats 是"裸属性"，Lead 的 recalc 会在此基础上叠加天赋/装备）
    growBaseStats(entity, entity.level);
    const recalc = (world && world.__recalc) || defaultRecalc;
    recalc(world, entity, { keepRatioMode: 'gap' });
    entity.hp = Math.min(entity.maxHp, entity.hp); // maxHp 已增长，血量顺手补上增量
    entity.mp = Math.min(entity.maxMp, entity.mp);
    entity.talentPoints = (entity.talentPoints || 0) + TALENT_POINTS_PER_LEVEL;
    if (world) world.talentPoints = (world.talentPoints || 0) + TALENT_POINTS_PER_LEVEL;
    entity.unspentPoints = entity.talentPoints;
    // 升级顺带小幅回蓝
    entity.mp = Math.min(entity.maxMp, entity.mp + entity.maxMp * 0.25);
    pushWorldEvent(world, 'levelUp', {
      x: entity.x, z: entity.z,
      level: entity.level,
      unspentPoints: entity.talentPoints,
      gainedPoints: TALENT_POINTS_PER_LEVEL,
      entity,
      maxHp: entity.maxHp,
      maxMp: entity.maxMp,
    });
    if (world && world.stats) world.stats.maxLevel = Math.max(world.stats.maxLevel || 1, entity.level);
  }
  entity.levelsGained = (entity.levelsGained || 0) + levelUps;
  return amount;
}

/**
 * 把等级成长写入 entity.baseStats（裸属性）。
 * 只覆盖「等级带来的固定成长」字段，保留装备/天赋以外的初始武器伤害设定：
 *   life / lifeRegen / mana / manaRegen 用 createBaseStats(level) 的值；
 *   dmgMin / dmgMax 按每级 +1.6 / +2.4 成长（与 createPlayer 的初始武器一致）。
 * 若 entity.baseStats 不存在则直接新建。
 * @param {Object} entity @param {number} level
 * @returns {Object} entity.baseStats
 */
export function growBaseStats(entity, level) {
  if (!entity) return null;
  const lv = Math.max(1, Math.floor(level));
  const g = createBaseStats(lv);
  if (!entity.baseStats || typeof entity.baseStats !== 'object') entity.baseStats = {};
  const b = entity.baseStats;
  b.life = g.life;
  b.lifeRegen = g.lifeRegen;
  b.mana = g.mana;
  b.manaRegen = g.manaRegen;
  b.dmgMin = 12 + 1.6 * (lv - 1);
  b.dmgMax = 22 + 2.4 * (lv - 1);
  return b;
}

/**
 * 兜底属性重算（无 world.__recalc 时）：把 baseStats 视为"裸属性"。
 * baseStats.life 加在等级成长之上（这样升级不会丢掉装备/天赋的生命加成）。
 * @param {Object} world @param {Object} entity @param {Object} opts
 */
function defaultRecalc(world, entity, opts) {
  entity.needsRecalc = true;
  const lv = Math.max(1, entity.level);
  const targetLife = entity.baseStats && typeof entity.baseStats.life === 'number'
    ? entity.baseStats.life
    : createBaseStats(lv).life;
  const delta = targetLife - entity.maxHp;
  entity.maxHp = targetLife;
  entity.hp = Math.min(entity.maxHp, entity.hp + Math.max(0, delta));
  entity.mp = Math.min(entity.maxMp, entity.mp);
  void world; void opts;
}

/**
 * 当前等级到下一级还差多少经验 / 进度（供 UI 经验条）。
 * @param {Object} entity
 * @returns {{level:number, xp:number, xpMax:number, pct:number, isMax:boolean}}
 */
export function xpProgress(entity) {
  const level = (entity && entity.level) || 1;
  const xp = (entity && entity.xp) || 0;
  const xpMax = xpForLevel(level);
  const isMax = level >= MAX_LEVEL;
  return { level, xp, xpMax, pct: isMax ? 1 : clamp(xp / xpMax, 0, 1), isMax };
}

/**
 * 计算一张地图（等级 lv）击杀一只普通怪应给的 XP 倍率，
 * 用于地图难度提示（Lead 可在 UI 显示）。
 */
export function mapXpMultiplier(mapLevel) {
  return 1 + 0.06 * Math.max(0, mapLevel - 1);
}