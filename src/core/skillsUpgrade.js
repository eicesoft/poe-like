// @file src/core/skillsUpgrade.js
// 技能升级（技能等级 / 天赋聚合 / 精炼）在【核心层】的最终有效值计算。
// 纯逻辑，不依赖 DOM / three。
//
// 【为什么单独一个文件，而且不 import src/items/skillTree.js】
//   1. 核心层（src/core）必须是"自洽"的：没有 items 层时（headless 测试、纯核心打包）也要能算出
//      伤害/冷却/半径/护甲这些最终值。
//   2. 依赖方向只能 items → core：src/items/* 已经 import 了 core（例如 itemgen 用 STAT_KEYS）。
//      如果 core 反过来 import src/items/skillTree.js，就是**循环依赖**，ESM 下会表现为
//      "某个模块拿到 undefined 导出"这种极难排查的崩溃。
//   所以：天赋聚合结果由 app 层写好（player.skillMods[skillId]，结构见契约 §2.1），
//   本文件只负责"把天赋结果 + 技能等级 + 玩家属性 三样东西合成最终数值"。
//
// 【玩家上的相关字段（都可缺失）】
//   player.skillMods[skillId] = {
//     damageMult,                          // 天赋伤害倍率（1 = 不变），会被 floor 到 >= 0
//     radiusMult,                          // 天赋半径倍率（1 = 不变）
//     cooldownMult,                        // 天赋冷却倍率（0.9 = 冷却缩短 10%）
//     multiplierBonuses: {                 // 机制类乘法系数（默认 1）
//       stunDurMult, armorPerEnemyMult, armorDurMult, ...
//     },
//     flags: { shockwave, focusLeft, focusRight, ... },   // 机制开关
//     stats: { ... },                      // 天赋附带的属性（例如 attackSpeedMult）
//     ranks: { nodeId: rank }, nodes: [nodeId],
//   }
//   player.skills[skillId] = { refine: 0..4, level: 1..5 }   // 精炼等级 / 已同步的技能等级
//   player.skillBar[i]     = { id, level, ... }              // 技能实例（level 由 app 同步）
//
// 【技能等级语义（契约 §2.1）】
//   skillLevel = max(1, bar.level || 1) + floor(player.stats.skillLevelBonus || 0)
//   即：等级（天赋点 + 精炼 - 1，由 app 写入实例）+ 装备/天赋给的"技能等级 +N"再叠加。
//   上限 SKILL_LEVEL_CAP = 5（契约 §3.4）。注意"技能等级 +N"的加成也受这个上限约束，
//   避免装备堆出 9 级技能把数值表撑爆。

import { clamp } from './stats.js';

/** 技能等级上限（含天赋与装备加成），契约 §3.4 */
export const SKILL_LEVEL_CAP = 5;
/** 精炼等级上限（0..4），契约 §3.4 */
export const REFINE_MAX = 4;

/** 每技能等级的默认成长（技能定义里没写 cooldownMultLevel/radiusMultLevel/damageMultLevel 时用这些） */
export const LEVEL_GROWTH = Object.freeze({
  damageMultLevel: 0.08,     // 每级伤害 +8%
  cooldownMultLevel: 0.04,   // 每级冷却缩短 4%
  radiusMultLevel: 0.05,     // 每级半径 +5%
});

/** 等级带来的冷却缩减封顶（4 级 × 4% = 16%，再加天赋也不会超过 20%） */
export const LEVEL_CDR_CAP = 0.2;

/** 中性天赋聚合结果（player.skillMods 缺失时用；每次返回新对象，调用方可安全修改） */
export function neutralSkillMods() {
  return {
    damageMult: 1,
    radiusMult: 1,
    cooldownMult: 1,
    multiplierBonuses: {},
    flatBonuses: {},
    flags: {},
    stats: {},
    ranks: {},
    nodes: [],
  };
}

/**
 * 把任意来源（app 写入 / items 层 / 测试桩）的技能天赋聚合结果补齐成安全结构。
 * - 数字字段必须是有限数，否则退回中性值 1；
 * - flags / stats / ranks / multiplierBonuses 统一成普通对象；
 * - 传 null/undefined 返回中性值（核心**绝不**因为缺字段而崩）。
 * @param {Object|null|undefined} mods
 * @returns {Object}
 */
export function normalizeSkillMods(mods) {
  if (!mods || typeof mods !== 'object') return neutralSkillMods();
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const obj = (v) => (v && typeof v === 'object' ? v : {});
  return {
    ...mods,
    damageMult: num(mods.damageMult, 1),
    radiusMult: num(mods.radiusMult, 1),
    cooldownMult: num(mods.cooldownMult, 1),
    multiplierBonuses: obj(mods.multiplierBonuses),
    // 固定值加成（例如 armorFlat）：契约 §3.1 里 armorFlat 是"额外固定护甲（累加）"，
    // 它既不是乘法系数也不进 StatBlock，单独放在 flatBonuses 里最清晰。
    flatBonuses: obj(mods.flatBonuses),
    flags: obj(mods.flags),
    stats: obj(mods.stats),
    ranks: obj(mods.ranks),
    nodes: Array.isArray(mods.nodes) ? mods.nodes : [],
  };
}

/**
 * 取某个技能的天赋聚合结果。
 * 兼容两种写入方式：
 *   player.skillMods[skillId] = {...}      （契约写法）
 *   player.skillMods = (id) => {...}       （app 层的便捷函数写法，旧代码用过）
 * @param {Object|null} player
 * @param {string} skillId
 * @returns {Object} 已补齐的安全结构
 */
export function skillModsOf(player, skillId) {
  if (!player) return neutralSkillMods();
  const table = player.skillMods;
  if (typeof table === 'function') {
    try {
      return normalizeSkillMods(table(skillId));
    } catch {
      return neutralSkillMods();
    }
  }
  if (table && typeof table === 'object') return normalizeSkillMods(table[skillId]);
  return neutralSkillMods();
}

/** 读乘法系数（multiplierBonuses 里没写 = 1；写了非法值也回退 1） */
export function multBonus(mods, key) {
  const src = mods && mods.multiplierBonuses;
  const v = src && typeof src === 'object' ? src[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 1;
}

/** 读机制开关（flags 里 truthy 即开启） */
export function skillFlag(mods, key) {
  const src = mods && mods.flags;
  if (!src || typeof src !== 'object') return false;
  return !!src[key];
}

/**
 * 分支专精：'left' | 'right' | ''（契约 §2.3 的 focus 字段）。
 *
 * 读取优先级（两条路都要认，否则 app / data 层写哪个字段都能让 UI 显示空）：
 *   1. flags.focusRight / flags.focusLeft（契约 §2.3 明确写的就是这一对）；
 *   2. mods.focus（B 的 skillEffectsForSkill 汇总出的当前分支，'left' / 'right' / ''）。
 * 两者都在时以 flags 为准（它有显式开关语义，例如"分支专精节点"）。
 */
export function skillFocus(mods) {
  if (skillFlag(mods, 'focusRight')) return 'right';
  if (skillFlag(mods, 'focusLeft')) return 'left';
  const f = mods && typeof mods.focus === 'string' ? mods.focus : '';
  if (f === 'left' || f === 'right') return f;
  return '';
}

/**
 * 天赋点数（该技能树里**已点亮的节点数**，不含精炼）。
 *
 * 【口径】按「节点数」而不是「档位之和」—— 每个 rank > 0 的节点只算 1 点。
 * 为什么必须这样：契约 §3.4 的 skillLevelFrom、data 层 countAllocatedNodes、
 * skillPointsSpent 与技能面板全都按节点数算。如果这里按档位和算，
 * `{stomp.root:3, stomp.l1:1}` 会得到 4（core 显示 Lv.5）而面板是 3（Lv.3），
 * 面板与实际战斗的等级就对不上了，玩家会被误导。
 *
 * 用来推导"只靠天赋能到几级"：技能等级 = min(cap, 天赋点 + 精炼 + 1)。
 * @param {Object|null} mods 已 normalize 的天赋聚合结果
 * @returns {number}
 */
export function talentPointsOf(mods) {
  const ranks = mods && mods.ranks;
  if (!ranks || typeof ranks !== 'object') return 0;
  let n = 0;
  for (const k in ranks) {
    const v = Number(ranks[k]);
    if (Number.isFinite(v) && v > 0) n += 1;
  }
  return n;
}

/**
 * 技能实例（技能栏格子）。
 * @param {Object|null} player @param {string} skillId
 * @returns {Object|null}
 */
export function skillInstanceOf(player, skillId) {
  if (!player || !Array.isArray(player.skillBar)) return null;
  for (const inst of player.skillBar) {
    if (inst && inst.id === skillId) return inst;
  }
  return null;
}

/**
 * 精炼等级（0..4）。
 * 优先读 player.skills[skillId].refine（app 写入的权威值），其次读技能实例上的 refine。
 * @param {Object|null} player @param {string} skillId
 * @returns {number}
 */
export function refineLevelOf(player, skillId) {
  const skills = player && player.skills;
  const rec = skills && typeof skills === 'object' ? skills[skillId] : null;
  let r = rec && typeof rec.refine === 'number' ? rec.refine : NaN;
  if (!Number.isFinite(r)) {
    const inst = skillInstanceOf(player, skillId);
    r = inst && typeof inst.refine === 'number' ? inst.refine : 0;
  }
  return clamp(Math.floor(r || 0), 0, REFINE_MAX);
}

/**
 * 玩家有没有接上技能系统（app 写入的 player.skills / player.skillMods）。
 * 老存档、纯核心调用方、UI 单测里这两块都可能没有 —— 这种情况下等级只能取实例 level。
 * @param {Object|null} player @param {string} [skillId]
 */
function hasSkillSystems(player, skillId) {
  if (!player) return false;
  const skills = player.skills;
  if (skills && typeof skills === 'object' && skillId && skills[skillId] && typeof skills[skillId] === 'object') return true;
  const table = player.skillMods;
  if (typeof table === 'function') return true;
  if (table && typeof table === 'object' && skillId && table[skillId] && typeof table[skillId] === 'object') return true;
  return false;
}

/**
 * 技能等级（>=1 的整数，上限 SKILL_LEVEL_CAP）。
 *
 * 等级 = 天赋点 + 精炼 + 1（契约 §3.4：两者叠加），再叠加装备/天赋的 skillLevelBonus，最后封顶。
 *
 * 计算优先级：
 *   1. 玩家接了技能系统（有 player.skills[skillId] 或 player.skillMods[skillId]）
 *      → min(cap, 天赋点 + 精炼 + 1 + skillLevelBonus)：这是唯一"天赋与精炼完全一致"的真值来源；
 *   2. 否则用技能实例 level + skillLevelBonus（老存档 / 没接技能系统的调用方，契约 §2.1 的兼容语义）；
 *   3. 都没有 → 1（核心兜底）。
 *
 * 为什么 (1) 必须优先：天赋点与精炼是**叠加**的。如果只读实例 level，在"天赋刚点、
 * 实例还没同步"的那一帧里，施法伤害与面板显示会算出不同的等级。
 *
 * @param {Object|null} player
 * @param {string} skillId
 * @returns {number}
 */
export function skillLevelOf(player, skillId) {
  const bonus = player && player.stats && Number.isFinite(player.stats.skillLevelBonus)
    ? Math.floor(player.stats.skillLevelBonus)
    : 0;
  let base;
  if (hasSkillSystems(player, skillId)) {
    const mods = skillModsOf(player, skillId);
    base = talentPointsOf(mods) + refineLevelOf(player, skillId) + 1;
  } else {
    const inst = skillInstanceOf(player, skillId);
    base = inst && Number.isFinite(inst.level) ? inst.level : 1;
  }
  return clamp(Math.max(1, Math.floor(base)) + bonus, 1, SKILL_LEVEL_CAP);
}

/** 兼容旧工具/旧测试的 (bar, player) 参数顺序 —— 和 skills.js 私有实现语义一致。 */
export function skillLevel(bar, player) {
  const bonus = player && player.stats ? player.stats.skillLevelBonus || 0 : 0;
  return Math.max(1, (bar && bar.level ? bar.level : 1) + Math.floor(bonus));
}

/**
 * 伤害倍率随技能等级的成长：每级 +damageMultLevel（默认 8%）。
 * @param {number} lvl 技能等级（>=1） @param {number} [base=1] 1 级时的倍率
 * @param {number} [perLevel] 每级加成（不传用 0.08）
 * @returns {number}
 */
export function levelDmgScale(lvl, base = 1, perLevel = LEVEL_GROWTH.damageMultLevel) {
  return base * (1 + perLevel * (Math.max(1, lvl) - 1));
}

/**
 * 等级带来的冷却缩减（0..0.2）与对应的冷却倍率。
 * 技能定义里可以写 cooldownMultLevel 覆盖默认 4%。
 * @param {number} lvl @param {Object} [def]
 * @returns {{cdr:number, mult:number}}
 */
export function levelCooldownScale(lvl, def) {
  const per = def && Number.isFinite(def.cooldownMultLevel) ? def.cooldownMultLevel : LEVEL_GROWTH.cooldownMultLevel;
  const cdr = clamp(per * (Math.max(1, lvl) - 1), 0, LEVEL_CDR_CAP);
  return { cdr, mult: 1 - cdr };
}

/**
 * 等级带来的半径成长倍率（1 级 = 1，每级 +radiusMultLevel，默认 5%）。
 * @param {number} lvl @param {Object} [def]
 * @returns {number}
 */
export function levelRadiusScale(lvl, def) {
  const per = def && Number.isFinite(def.radiusMultLevel) ? def.radiusMultLevel : LEVEL_GROWTH.radiusMultLevel;
  return 1 + per * (Math.max(1, lvl) - 1);
}

/** 技能定义上的某个"基础值"：优先数值字段，其次 range（施法距离），最后 def[key]。 */
function baseField(def, key) {
  if (!def) return 0;
  if (typeof def[key] === 'number') return def[key];
  if (key === 'radius' && typeof def.range === 'number') return def.range;
  return 0;
}

/**
 * 技能最终冷却（秒）：base × 冷却缩减 × 天赋 cooldownMult × 等级冷却成长。
 * 公式：`def.cooldown * (1 - cdr) * mods.cooldownMult * levelCooldownScale`
 *
 * 【等级口径】一律走 skillLevelOf(player, skillId)（天赋 + 精炼 + 装备加成，封顶 5），
 * **不要**再用只读 skillBar[i].level 的旧 skillLevel()：天赋精炼还没同步到实例的那一帧里，
 * 实例 level 会是旧值，导致"面板 Lv5 / 实战仍按 Lv1 冷却"。
 * @param {Object|null} player @param {string} skillId @param {Object|null} def 技能定义
 * @returns {number}
 */
export function skillCooldownTotal(player, skillId, def) {
  const d = def || null;
  const base = d && typeof d.cooldown === 'number' ? d.cooldown : 0;
  if (!(base > 0)) return 0;
  const lvl = skillLevelOf(player, skillId);
  const stats = player && player.stats ? player.stats : {};
  const cdr = clamp(stats.cdrMult || 0, 0, 0.6);
  const mods = skillModsOf(player, skillId);
  const lv = levelCooldownScale(lvl, d);
  return base * (1 - cdr) * mods.cooldownMult * lv.mult;
}

/**
 * 技能最终半径/距离：base × (1 + aoeMult) × 天赋 radiusMult × 等级半径成长。
 * 公式：`base * (1 + clamp(aoeMult, -0.6, 3)) * mods.radiusMult * levelRadiusScale`
 * 等级口径同 skillCooldownTotal：统一 skillLevelOf。
 * @param {Object|null} player @param {string} skillId @param {Object|null} def
 * @param {number} [base] 不传则取 def.radius（其次 def.range）
 * @returns {number}
 */
export function skillRadius(player, skillId, def, base) {
  const d = def || null;
  const b = typeof base === 'number' ? base : baseField(d, 'radius');
  const stats = player && player.stats ? player.stats : {};
  const aoe = clamp(stats.aoeMult || 0, -0.6, 3);
  const mods = skillModsOf(player, skillId);
  const lvl = skillLevelOf(player, skillId);
  return b * (1 + aoe) * mods.radiusMult * levelRadiusScale(lvl, d);
}

/**
 * 技能最终伤害倍率（1 = 100% 武器伤害）。
 * 公式：`levelDmgScale(lvl, base, def.damageMultLevel) * mods.damageMult`
 * 等级口径同 skillCooldownTotal：统一 skillLevelOf。
 * @param {Object|null} player @param {string} skillId @param {Object|null} def
 * @param {number} [base] 不传则取 def.damagePct（其次 1）
 * @returns {number}
 */
export function skillDamagePct(player, skillId, def, base) {
  const d = def || null;
  const b = typeof base === 'number' ? base : (d && typeof d.damagePct === 'number' ? d.damagePct : 1);
  const lvl = skillLevelOf(player, skillId);
  const per = d && Number.isFinite(d.damageMultLevel) ? d.damageMultLevel : LEVEL_GROWTH.damageMultLevel;
  const mods = skillModsOf(player, skillId);
  return levelDmgScale(lvl, b, per) * mods.damageMult;
}

/**
 * 战争践踏「踏地战甲」的护甲值。
 *
 * 契约 §3.3：`armor = (base + per*hits) * armorPerEnemyMult + armorFlat`
 *   - base / per 默认取 `def.armorGain`（18 / 5）；
 *   - armorPerEnemyMult 来自天赋 multiplierBonuses；
 *   - armorFlat 来自天赋 flatBonuses.armorFlat（B 的 skillEffectsForSkill 汇总的固定值），
 *     其次 multiplierBonuses.armorFlat，其次 mods.stats.armorFlat（三条路都认，避免字段名细微差异导致天赋失效）；
 *   - hits === 0 时也只剩 base（保底护甲，技能永远有正向反馈）。
 * 返回整数（直接写进 buff.stats.armor，UI 也直接显示）。
 *
 * @param {number} hits 命中敌人数（负数按 0）
 * @param {Object|null} mods 该技能的天赋聚合结果（可传未 normalize 的）
 * @param {{flat?:number, per?:number, def?:Object}} [opts]
 * @returns {number}
 */
export function stompArmorFor(hits, mods, opts = {}) {
  const m = normalizeSkillMods(mods);
  const def = (opts && opts.def) || null;
  const gain = def && def.armorGain ? def.armorGain : null;
  const base = typeof (opts && opts.flat) === 'number' ? opts.flat
    : gain && Number.isFinite(gain.flat) ? gain.flat : 18;
  const per = typeof (opts && opts.per) === 'number' ? opts.per
    : gain && Number.isFinite(gain.per) ? gain.per : 5;
  const n = Math.max(0, Math.floor(Number(hits) || 0));
  const perEnemy = multBonus(m, 'armorPerEnemyMult');
  const flatBonus = m.flatBonuses && Number.isFinite(m.flatBonuses.armorFlat) ? m.flatBonuses.armorFlat : 0;
  const flat = flatBonus
    + (Number.isFinite(m.multiplierBonuses.armorFlat) ? m.multiplierBonuses.armorFlat : 0)
    + (m.stats && Number.isFinite(m.stats.armorFlat) ? m.stats.armorFlat : 0);
  const armor = (base + per * n) * perEnemy + flat;
  return Math.max(0, Math.round(armor));
}

/**
 * 战争践踏的眩晕时长（秒）：base × 等级成长 × 天赋 stunDurMult。
 * 时长也吃技能等级：每级 +5%（控制技能升级后应该更"值钱"）。
 * @param {Object|null} player @param {Object} def @param {number} [base]
 * @returns {number}
 */
export function stompStunDuration(player, def, base) {
  const d = def || null;
  const g = d && d.stunGain ? d.stunGain : null;
  const b = typeof base === 'number' ? base : g && Number.isFinite(g.base) ? g.base : 1.2;
  const perLevel = g && Number.isFinite(g.perLevel) ? g.perLevel : 0.05;
  const lvl = skillLevelOf(player, 'stomp');
  const mods = skillModsOf(player, 'stomp');
  return b * (1 + perLevel * (lvl - 1)) * multBonus(mods, 'stunDurMult');
}

/**
 * 战争践踏的护甲持续时长（秒）：base × 等级成长 × 天赋 armorDurMult。
 * @param {Object|null} player @param {Object} def @param {number} [base]
 * @returns {number}
 */
export function stompArmorDuration(player, def, base) {
  const d = def || null;
  const g = d && d.armorGain ? d.armorGain : null;
  const b = typeof base === 'number' ? base : g && Number.isFinite(g.dur) ? g.dur : 4;
  const lvl = skillLevelOf(player, 'stomp');
  const mods = skillModsOf(player, 'stomp');
  return b * (1 + 0.05 * (lvl - 1)) * multBonus(mods, 'armorDurMult');
}

/** 精炼升级花费（件精炼石）：1→2:3, 2→3:4, 3→4:6, 4→5:8；已满级返回 null。
 * 公式：refine 0..3 依次 3 / 4 / 6 / 8。
 * @param {number} refine 当前精炼等级 0..4
 * @returns {number|null}
 */
export function refineCostOf(refine) {
  const r = Math.floor(Number(refine) || 0);
  const table = [3, 4, 6, 8];
  if (r < 0 || r >= REFINE_MAX) return null;
  return table[r];
}

/** 技能等级是否还能靠（天赋+精炼）继续提升（受 SKILL_LEVEL_CAP 限制） */
export function canGainLevel(refine, talentPoints, cap = SKILL_LEVEL_CAP) {
  const next = Math.min(cap, Math.max(0, talentPoints) + Math.max(0, refine) + 1 + 1);
  const cur = Math.min(cap, Math.max(0, talentPoints) + Math.max(0, refine) + 1);
  return next > cur;
}

/**
 * 把技能定义 + 天赋聚合 + 技能等级 合成为"最终有效值"（契约 §2.3 / §3.3）。
 *
 * 这是**唯一**的合成入口：UI 的 skills.skillDisplayInfo 和战斗里的施法都走它，
 * 保证"面板上写 7.0 秒冷却"和"实际冷却 7.0 秒"永远是同一个数（踩过坑：两边各算一次，
 * 加了等级缩减后就会出现面板 5.0s / 实际 4.6s 的对不上）。
 *
 * @param {Object|null} def 技能定义（SKILLS[id]）
 * @param {Object|null} mods 天赋聚合结果（可未 normalize）
 * @param {number} [lvl=1] 技能等级（1..SKILL_LEVEL_CAP）
 * @param {{stats?:Object, skillId?:string}} [opts]
 *   stats：玩家属性（读 cdrMult / aoeMult），不传视为全 0
 * @returns {{
 *   level:number, manaCost:number, cooldown:number, range:number, radius:number,
 *   damagePct:number, castTime:number, aoeMult:number, cdrMult:number,
 *   radiusMult:number, damageMult:number,
 *   stunDuration:number, armorGain:number, armorDuration:number,
 *   flags:Object, focus:'left'|'right'|'', mods:Object
 * }}
 */
export function applySkillMods(def, mods, lvl = 1, opts = {}) {
  const d = def || {};
  const m = normalizeSkillMods(mods);
  const stats = (opts && opts.stats) || {};
  const level = clamp(Math.max(1, Math.floor(Number(lvl) || 1)), 1, SKILL_LEVEL_CAP);
  const aoeMult = clamp(stats.aoeMult || 0, -0.6, 3);
  const cdrMult = clamp(stats.cdrMult || 0, 0, 0.6);
  const cdLevel = levelCooldownScale(level, d);
  const radiusLevel = levelRadiusScale(level, d);
  const baseRadius = baseField(d, 'radius');
  const baseRange = typeof d.range === 'number' ? d.range : baseRadius;
  const perLevelDmg = Number.isFinite(d.damageMultLevel) ? d.damageMultLevel : LEVEL_GROWTH.damageMultLevel;
  // 天賦的 radiusMult 整体乘在"aoe + 等级成长"之上
  const radiusMult = (1 + aoeMult) * m.radiusMult * radiusLevel;
  const cooldown = typeof d.cooldown === 'number' && d.cooldown > 0
    ? d.cooldown * (1 - cdrMult) * m.cooldownMult * cdLevel.mult
    : 0;
  return {
    level,
    manaCost: typeof d.manaCost === 'number' ? d.manaCost : 0,
    cooldown,
    range: baseRange * radiusMult,
    radius: baseRadius * radiusMult,
    damagePct: levelDmgScale(level, typeof d.damagePct === 'number' ? d.damagePct : 1, perLevelDmg) * m.damageMult,
    castTime: typeof d.castTime === 'number' ? d.castTime : 0,
    aoeMult,
    cdrMult,
    radiusMult,
    damageMult: m.damageMult,
    // 践踏专属机制值（其它技能为 0）
    stunDuration: stompStunDurationOf(d, m, level),
    armorGain: stompArmorFor(0, m, { def: d }),
    armorDuration: stompArmorDurationOf(d, m, level),
    flags: m.flags,
    focus: skillFocus(m),
    mods: m,
  };
}

/** applySkillMods 内部用：按"已解析的等级"算眩晕时长（不依赖 player） */
function stompStunDurationOf(def, mods, lvl) {
  const g = def && def.stunGain ? def.stunGain : null;
  const base = g && Number.isFinite(g.base) ? g.base : 1.2;
  const perLevel = g && Number.isFinite(g.perLevel) ? g.perLevel : 0.05;
  return base * (1 + perLevel * (Math.max(1, lvl) - 1)) * multBonus(mods, 'stunDurMult');
}

/** applySkillMods 内部用：按"已解析的等级"算护甲持续时长 */
function stompArmorDurationOf(def, mods, lvl) {
  const g = def && def.armorGain ? def.armorGain : null;
  const base = g && Number.isFinite(g.dur) ? g.dur : 4;
  return base * (1 + 0.05 * (Math.max(1, lvl) - 1)) * multBonus(mods, 'armorDurMult');
}