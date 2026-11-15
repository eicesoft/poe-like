// @file src/items/affixes.js
// 物品词缀池（前缀 / 后缀）与词缀掷骰。
//
// 【硬约束】纯数据 / 纯函数，不 import 浏览器 API / three / DOM。
//
// ──────────────── 数据结构 ────────────────
// @typedef {Object} AffixTier
// @property {number} tier    阶位（**1 = 最强**，数字越大越弱）
// @property {number} levelReq 需要的最低物品等级（≤ 物品等级才可能掉落）
// @property {string} text    中文显示文本（如 "+34 护甲"）
// @property {Object<string,number>} stats 数值加成（StatBlock 键 / 物品额外键）
//
// @typedef {Object} Affix
// @property {string} id
// @property {string} name     中文词根（如「残暴之魂的」/「之怒」）
// @property {'prefix'|'suffix'} kind
// @property {string} group    同组互斥（如 'life' / 'resFire' / 'attackSpeed'）
// @property {string[]} slots  可出现的基底 slot
// @property {AffixTier[]} tiers  **从强到弱排列**（tiers[0] = T1 最强）；levelReq 单调递减
//
// 掷骰得到的实例（itemgen 写入 item.mods）：
//   { id, name, text, stats, tier, prefix }
//
// 百分比类词缀：attackSpeedMult: 0.08 表示 +8%，显示文本 "+8% 攻击速度"。
// 元素「附加伤害」用成对键 addedFireMin/addedFireMax（同理 Cold / Lightning / physAddedMin/Max）。

// [Lead 修复] 去掉对 common.js 的导入（避免循环依赖）；RNG 适配在本地实现，语义相同
import { RNG } from '../engine/rng.js';
/** 鸭子类型适配：RNG 实例 / 函数 / 种子数字 都能用 */
function getRNG(rng) {
  if (rng && typeof rng === 'object' && typeof rng.next === 'function' && typeof rng.int === 'function' && typeof rng.shuffle === 'function') return rng;
  if (rng && typeof rng === 'object' && typeof rng.next === 'function') {
    const r = { next: () => rng.next(), range: (a, b) => a + (b - a) * r.next(), int: (a, b) => Math.floor(r.range(a, b + 1)), pick: (arr) => arr[Math.floor(r.next() * arr.length)], chance: (p) => r.next() < p };
    return r;
  }
  if (typeof rng === 'function') return getRNG({ next: () => rng() });
  if (typeof rng === 'number') return new RNG(rng >>> 0);
  return new RNG((Math.floor(Math.random() * 0xffffffff) ^ (Date.now() & 0xffffffff)) >>> 0);
}

import * as extraAffixes from './affix_extra.js';

/** 抗性键。 */
export const RESIST_KEYS = Object.freeze(['fireResist', 'coldResist', 'lightningResist', 'chaosResist']);

/** 抗性键 → 中文名。 */
export const RESIST_NAMES = Object.freeze({
  fireResist: '火焰抗性',
  coldResist: '冰霜抗性',
  lightningResist: '闪电抗性',
  chaosResist: '混沌抗性',
});

/** 词缀分组常量（同组互斥）。 */
export const AFFIX_GROUPS = Object.freeze({
  LIFE: 'life', LIFE_REGEN: 'lifeRegen', MANA: 'mana', MANA_REGEN: 'manaRegen', ES: 'energyShield',
  ARMOR: 'armor', EVASION: 'evasion', BLOCK: 'blockChance',
  PHYS_PCT: 'physPct', ADD_PHYS: 'addPhys', ADD_FIRE: 'addFire', ADD_COLD: 'addCold', ADD_LIGHTNING: 'addLightning',
  FIRE_PCT: 'firePct', COLD_PCT: 'coldPct', LIGHTNING_PCT: 'lightningPct', CHAOS_PCT: 'chaosPct',
  ATTACK_SPEED: 'attackSpeed', CRIT_CHANCE: 'critChance', CRIT_MULTI: 'critMulti', MOVE_SPEED: 'moveSpeed',
  AOE: 'aoe', SKILL_LEVEL: 'skillLevel',
  RES_FIRE: 'resFire', RES_COLD: 'resCold', RES_LIGHTNING: 'resLightning', RES_CHAOS: 'resChaos', RES_ALL: 'resAll',
  LEECH: 'leech', CDR: 'cdr', AREA_DAMAGE: 'areaDamage', DOT: 'dot', THORNS: 'thorns',
  RARITY: 'rarity', XP: 'xp', LIFE_ON_HIT: 'lifeOnHit', QUANTITY: 'quantity', GOLD: 'gold',
  PROJECTILE_SPEED: 'projSpeed', GLOBAL_DAMAGE: 'globalDamage', MAX_RESIST: 'maxResist',
});

// ── 常用槽位集合 ──
const ALL = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'shield', 'ring', 'amulet', 'belt'];
const WEAPONISH = ['weapon', 'shield'];
const DEFENCE = ['helmet', 'body', 'gloves', 'boots', 'shield', 'belt'];
const ARMORISH = ['helmet', 'body', 'gloves', 'boots', 'shield'];
const JEWELRY = ['ring', 'amulet'];
const LOOT = ['ring', 'amulet', 'helmet', 'belt', 'gloves'];

// ── 文本 / 数值小工具 ──
/** 取整 */
const I = (v) => String(Math.round(v));
/** 保留 1 位小数 */
const D1 = (v) => String(Math.round(v * 10) / 10);
/** 带符号百分比（0.08 → "+8%"，-0.1 → "-10%"） */
const SP = (v) => (v >= 0 ? '+' : '') + Math.round(v * 1000) / 10 + '%';
/** 单键 stats */
const s1 = (k) => (v) => ({ [k]: v });
/** 三键同值 stats（三抗） */
const s3 = (a, b, c) => (v) => ({ [a]: v, [b]: v, [c]: v });
/** 成对「附加伤害」stats：min = 0.42 × max（保证 min < max） */
const pairT = (kMin, kMax) => (v) => {
  const hi = Math.max(2, Math.round(v));
  return { [kMin]: Math.max(1, Math.round(v * 0.42)), [kMax]: hi };
};

/**
 * 定义一条词缀。
 * @param {'prefix'|'suffix'} kind
 * @param {string} id 唯一 id（前缀 p_ 开头，后缀 s_ 开头）
 * @param {string} name 中文词根
 * @param {string} group 互斥分组
 * @param {string[]} slots 可出现的基底 slot
 * @param {Array<[number, number]>} values [levelReq, 数值]，**从弱到强**（最后一项是最强档 → T1）
 * @param {(v:number)=>string} textOf
 * @param {(v:number)=>Object<string,number>} statsOf
 * @returns {Affix}
 */
function A(kind, id, name, group, slots, values, textOf, statsOf) {
  const n = values.length;
  /** @type {AffixTier[]} */
  const tiers = values
    .map(([levelReq, v], i) => ({ tier: n - i, levelReq, text: textOf(v), stats: statsOf(v) }))
    .reverse(); // → 从强到弱
  return Object.freeze({
    id, name, kind, group,
    slots: Object.freeze(slots.slice()),
    tiers: Object.freeze(tiers.map((t) => Object.freeze({
      tier: t.tier, levelReq: t.levelReq, text: t.text, stats: Object.freeze({ ...t.stats }),
    }))),
  });
}

/**
 * @typedef {Object} AffixTier
 * @property {number} tier
 * @property {number} levelReq
 * @property {string} text
 * @property {Object<string,number>} stats
 */

/**
 * @typedef {Object} Affix
 * @property {string} id
 * @property {string} name
 * @property {'prefix'|'suffix'} kind
 * @property {string} group
 * @property {string[]} slots
 * @property {AffixTier[]} tiers
 */

// ─────────────────────────────────────────────────────────────────────────────
// 前缀核心池：生命、防御、元素伤害、速度、暴击、范围、技能、掉宝
// ─────────────────────────────────────────────────────────────────────────────
/** @type {Affix[]} */
const PREFIXES_CORE = [
  // ---- 生命 / 生命回复 / 法力 ----
  A('prefix', 'p_life', '残暴之魂的', 'life', ALL,
    [[1, 24], [8, 34], [15, 44], [24, 56], [34, 72], [62, 89]],
    (v) => '+' + I(v) + ' 生命', s1('life')),
  A('prefix', 'p_life_2', '血族的', 'life', ALL,
    [[2, 16], [11, 22], [20, 30], [30, 40], [42, 52], [55, 64]],
    (v) => '+' + I(v) + ' 生命', s1('life')),
  A('prefix', 'p_life_regen', '新生的', 'lifeRegen', ALL,
    [[3, 2], [12, 3.2], [22, 4.8], [33, 6.6], [45, 9], [58, 12]],
    (v) => '每秒回复 ' + D1(v) + ' 点生命', s1('lifeRegen')),
  A('prefix', 'p_mana', '秘法的', 'mana', ALL,
    [[1, 17], [9, 27], [18, 37], [28, 49], [40, 63], [52, 79]],
    (v) => '+' + I(v) + ' 法力', s1('mana')),
  A('prefix', 'p_mana_regen', '源泉的', 'manaRegen', ALL,
    [[8, 2.1], [19, 3.4], [31, 5.1], [44, 6.9], [56, 9]],
    (v) => '每秒回复 ' + D1(v) + ' 点法力', s1('manaRegen')),
  A('prefix', 'p_energy_shield', '空灵的', 'energyShield', ['helmet', 'body', 'shield', 'ring', 'amulet'],
    [[5, 13], [14, 22], [25, 34], [37, 48], [49, 62], [60, 79]],
    (v) => '+' + I(v) + ' 能量护盾', s1('energyShield')),

  // ---- 防御 ----
  A('prefix', 'p_armor', '坚壁的', 'armor', DEFENCE,
    [[1, 26], [10, 40], [20, 58], [31, 76], [43, 98], [55, 124]],
    (v) => '+' + I(v) + ' 护甲', s1('armor')),
  A('prefix', 'p_evasion', '灵巧的', 'evasion', ['helmet', 'body', 'gloves', 'boots', 'shield', 'ring'],
    [[4, 0.04], [13, 0.065], [24, 0.09], [36, 0.12], [48, 0.15]],
    (v) => SP(v) + ' 闪避率', s1('evasion')),
  A('prefix', 'p_block', '守护的', 'blockChance', ['shield', 'ring', 'amulet'],
    [[10, 0.03], [22, 0.05], [34, 0.075], [46, 0.1]],
    (v) => SP(v) + ' 格挡几率', s1('blockChance')),
  A('prefix', 'p_thorns', '荆棘的', 'thorns', ['helmet', 'body', 'gloves', 'shield', 'belt'],
    [[6, 9], [17, 17], [29, 27], [41, 39], [54, 52]],
    (v) => '反弹 ' + I(v) + ' 点伤害', s1('thorns')),
  A('prefix', 'p_health', '强健的', 'health', ALL,
    [[1, 14], [14, 22], [28, 32], [44, 46], [58, 62]],
    (v) => '+' + I(v) + ' 最大生命', s1('life')),

  // ---- 元素 / 物理伤害 ----
  A('prefix', 'p_add_fire', '烈焰的', 'addFire', WEAPONISH,
    [[1, 4], [8, 7], [17, 10], [27, 14], [38, 18], [50, 23]],
    (v) => '1 - ' + I(v) + ' 附加火焰伤害', pairT('addedFireMin', 'addedFireMax')),
  A('prefix', 'p_add_cold', '冰封的', 'addCold', WEAPONISH,
    [[1, 3], [9, 5], [18, 8], [28, 11], [39, 15], [51, 19]],
    (v) => '1 - ' + I(v) + ' 附加冰霜伤害', pairT('addedColdMin', 'addedColdMax')),
  A('prefix', 'p_add_lightning', '雷霆的', 'addLightning', WEAPONISH,
    [[1, 2], [10, 4], [19, 6], [30, 9], [41, 12], [53, 15]],
    (v) => '1 - ' + I(v) + ' 附加闪电伤害', pairT('addedLightningMin', 'addedLightningMax')),
  A('prefix', 'p_add_phys', '撕裂的', 'addPhys', WEAPONISH,
    [[2, 5], [11, 8], [21, 13], [32, 18], [44, 24], [56, 31]],
    (v) => '1 - ' + I(v) + ' 附加物理伤害', pairT('physAddedMin', 'physAddedMax')),
  A('prefix', 'p_phys_pct', '战狂的', 'physPct', ['weapon', 'ring', 'amulet'],
    [[1, 0.11], [9, 0.19], [19, 0.29], [31, 0.4], [44, 0.52], [57, 0.65]],
    (v) => SP(v) + ' 物理伤害', s1('physDamageMult')),
  A('prefix', 'p_fire_pct', '余烬的', 'firePct', WEAPONISH,
    [[12, 0.18], [22, 0.29], [33, 0.42], [45, 0.55], [58, 0.7]],
    (v) => SP(v) + ' 火焰伤害', s1('fireDamageMult')),
  A('prefix', 'p_cold_pct', '寒霜的', 'coldPct', WEAPONISH,
    [[12, 0.18], [22, 0.29], [33, 0.42], [45, 0.55], [58, 0.7]],
    (v) => SP(v) + ' 冰霜伤害', s1('coldDamageMult')),
  A('prefix', 'p_lightning_pct', '雷鸣的', 'lightningPct', WEAPONISH,
    [[12, 0.18], [22, 0.29], [33, 0.42], [45, 0.55], [58, 0.7]],
    (v) => SP(v) + ' 闪电伤害', s1('lightningDamageMult')),
  A('prefix', 'p_chaos_pct', '腐蚀的', 'chaosPct', ['weapon', 'ring', 'amulet'],
    [[20, 0.15], [32, 0.26], [45, 0.38], [58, 0.5]],
    (v) => SP(v) + ' 混沌伤害', s1('chaosDamageMult')),
  A('prefix', 'p_global_dmg', '屠戮的', 'globalDamage', ['ring', 'amulet', 'gloves', 'belt'],
    [[18, 0.08], [30, 0.13], [42, 0.2], [55, 0.28]],
    (v) => SP(v) + ' 全局伤害', s1('damageMult')),
  A('prefix', 'p_heavy_strike', '重压的', 'heavyStrike', ['weapon', 'gloves', 'belt'],
    [[10, 0.12], [25, 0.2], [40, 0.3], [55, 0.42]],
    (v) => SP(v) + ' 近战伤害', s1('damageMult')),

  // ---- 速度 / 暴击 / 范围 / 技能 ----
  A('prefix', 'p_attack_speed', '迅捷的', 'attackSpeed', ['weapon', 'gloves', 'ring', 'amulet'],
    [[1, 0.02], [10, 0.04], [21, 0.06], [33, 0.08], [46, 0.1], [59, 0.12]],
    (v) => SP(v) + ' 攻击速度', s1('attackSpeedMult')),
  A('prefix', 'p_crit_chance', '致命的', 'critChance', ['weapon', 'gloves', 'ring', 'amulet'],
    [[2, 0.02], [12, 0.03], [24, 0.04], [37, 0.05], [50, 0.06]],
    (v) => SP(v) + ' 暴击率', s1('critChance')),
  A('prefix', 'p_crit_multi', '格杀的', 'critMulti', ['weapon', 'gloves', 'ring', 'amulet'],
    [[6, 0.16], [17, 0.28], [29, 0.42], [42, 0.55], [55, 0.7]],
    (v) => SP(v) + ' 暴击伤害加成', s1('critMulti')),
  A('prefix', 'p_aoe', '巨力的', 'aoe', ['weapon', 'shield', 'ring', 'amulet', 'belt'],
    [[16, 0.04], [28, 0.06], [40, 0.08], [53, 0.1]],
    (v) => SP(v) + ' 范围效果', s1('aoeMult')),
  A('prefix', 'p_skill_level', '通神的', 'skillLevel', ['ring', 'amulet', 'helmet'],
    [[12, 1], [36, 1]],
    (v) => '+' + I(v) + ' 技能等级', s1('skillLevelBonus')),
  A('prefix', 'p_area_damage', '崩裂的', 'areaDamage', ['weapon', 'shield', 'gloves'],
    [[14, 0.14], [26, 0.23], [39, 0.34], [52, 0.45]],
    (v) => SP(v) + ' 范围伤害', s1('areaDamageMult')),
  A('prefix', 'p_dot', '腐化的', 'dot', ['weapon', 'ring', 'amulet', 'gloves'],
    [[18, 0.13], [30, 0.23], [43, 0.34], [56, 0.45]],
    (v) => SP(v) + ' 持续伤害', s1('dotMult')),
  A('prefix', 'p_life_on_hit', '汲命的', 'lifeOnHit', ['weapon', 'ring', 'amulet', 'gloves', 'belt'],
    [[8, 4], [20, 7], [33, 11], [46, 14]],
    (v) => '击中时回复 ' + I(v) + ' 点生命', s1('lifeOnHit')),
  A('prefix', 'p_proj_speed', '疾射的', 'projSpeed', ['weapon', 'gloves', 'ring'],
    [[10, 0.15], [24, 0.26], [38, 0.38], [52, 0.5]],
    (v) => SP(v) + ' 投射物速度', s1('projectileSpeedMult')),

  // ---- 掉宝 / 经验 ----
  A('prefix', 'p_quantity', '丰收的', 'quantity', ['ring', 'amulet', 'helmet', 'belt'],
    [[1, 0.1], [16, 0.17], [32, 0.26], [48, 0.35]],
    (v) => SP(v) + ' 物品数量', s1('quantityBonus')),
  A('prefix', 'p_rarity', '贪婪的', 'rarity', LOOT,
    [[1, 0.18], [15, 0.3], [30, 0.45], [45, 0.6]],
    (v) => SP(v) + ' 物品稀有度', s1('rarityBonus')),
  A('prefix', 'p_xp', '求知的', 'xp', ['helmet', 'ring', 'amulet', 'body'],
    [[1, 0.08], [20, 0.14], [40, 0.22]],
    (v) => SP(v) + ' 获得经验', s1('xpBonus')),
];

// ─────────────────────────────────────────────────────────────────────────────
// 后缀核心池：抗性、速度、暴击、生命、防御、元素伤害、冷却、掉宝
// ─────────────────────────────────────────────────────────────────────────────
/** @type {Affix[]} */
const SUFFIXES_CORE = [
  // ---- 抗性 ----
  A('suffix', 's_res_fire', '之火', 'resFire', ALL,
    [[1, 0.1], [10, 0.16], [20, 0.22], [32, 0.29], [45, 0.36], [58, 0.45]],
    (v) => SP(v) + ' 火焰抗性', s1('fireResist')),
  A('suffix', 's_res_cold', '之霜', 'resCold', ALL,
    [[1, 0.1], [10, 0.16], [20, 0.22], [32, 0.29], [45, 0.36], [58, 0.45]],
    (v) => SP(v) + ' 冰霜抗性', s1('coldResist')),
  A('suffix', 's_res_lightning', '之雷', 'resLightning', ALL,
    [[1, 0.1], [10, 0.16], [20, 0.22], [32, 0.29], [45, 0.36], [58, 0.45]],
    (v) => SP(v) + ' 闪电抗性', s1('lightningResist')),
  A('suffix', 's_res_chaos', '之毒', 'resChaos', DEFENCE,
    [[12, 0.08], [24, 0.13], [38, 0.19], [52, 0.25]],
    (v) => SP(v) + ' 混沌抗性', s1('chaosResist')),
  A('suffix', 's_res_all', '之龙鳞', 'resAll', ALL,
    [[18, 0.04], [30, 0.07], [44, 0.11], [57, 0.15]],
    (v) => SP(v) + ' 所有元素抗性', s3('fireResist', 'coldResist', 'lightningResist')),
  A('suffix', 's_res_all_2', '之守护', 'resAll', ['ring', 'amulet', 'belt', 'shield'],
    [[10, 0.04], [25, 0.07], [42, 0.1]],
    (v) => SP(v) + ' 所有元素抗性', s3('fireResist', 'coldResist', 'lightningResist')),
  A('suffix', 's_warding', '之结界', 'resAll', ['shield', 'helmet', 'body'],
    [[20, 0.05], [36, 0.09], [52, 0.13]],
    (v) => SP(v) + ' 所有元素抗性', s3('fireResist', 'coldResist', 'lightningResist')),
  A('suffix', 's_max_resist', '之熔铸', 'maxResist', ['shield', 'ring', 'amulet'],
    [[40, 0.02], [55, 0.03]],
    (v) => SP(v) + ' 各元素抗性上限', s1('maxResistance')),

  // ---- 速度 / 暴击 ----
  A('suffix', 's_attack_speed', '之疾风', 'attackSpeed', ['weapon', 'gloves', 'ring', 'amulet'],
    [[1, 0.015], [11, 0.03], [22, 0.045], [34, 0.06], [47, 0.075], [60, 0.09]],
    (v) => SP(v) + ' 攻击速度', s1('attackSpeedMult')),
  A('suffix', 's_crit_chance', '之精准', 'critChance', ['weapon', 'gloves', 'ring', 'amulet'],
    [[3, 0.013], [14, 0.021], [26, 0.029], [39, 0.037], [52, 0.045]],
    (v) => SP(v) + ' 暴击率', s1('critChance')),
  A('suffix', 's_crit_multi', '之残杀', 'critMulti', ['weapon', 'gloves', 'ring', 'amulet'],
    [[8, 0.11], [19, 0.2], [31, 0.3], [44, 0.4], [57, 0.5]],
    (v) => SP(v) + ' 暴击伤害加成', s1('critMulti')),
  A('suffix', 's_move_speed', '之疾行', 'moveSpeed', ['boots', 'belt', 'ring'],
    [[1, 0.025], [12, 0.045], [25, 0.065], [38, 0.085], [52, 0.1]],
    (v) => SP(v) + ' 移动速度', s1('moveSpeedMult')),

  // ---- 生命 / 法力 / 回复 / 偷取 ----
  A('suffix', 's_life', '之生机', 'life', ALL,
    [[1, 18], [9, 28], [19, 39], [30, 51], [43, 64], [56, 79]],
    (v) => '+' + I(v) + ' 生命', s1('life')),
  A('suffix', 's_life_regen', '之回春', 'lifeRegen', ALL,
    [[4, 3], [15, 5.4], [27, 8.1], [40, 11.4], [54, 15]],
    (v) => '每秒回复 ' + D1(v) + ' 点生命', s1('lifeRegen')),
  A('suffix', 's_mana', '之心智', 'mana', ALL,
    [[2, 20], [12, 30], [23, 42], [35, 55], [48, 69]],
    (v) => '+' + I(v) + ' 法力', s1('mana')),
  A('suffix', 's_energy_shield', '之壁障', 'energyShield', ['helmet', 'body', 'shield', 'ring', 'amulet'],
    [[6, 15], [16, 27], [28, 40], [41, 54], [54, 69]],
    (v) => '+' + I(v) + ' 能量护盾', s1('energyShield')),
  A('suffix', 's_leech', '之饿', 'leech', ['weapon', 'ring', 'amulet', 'gloves'],
    [[10, 0.01], [24, 0.02], [40, 0.03], [55, 0.04]],
    (v) => '攻击伤害的 ' + D1(v * 1000) + '% 转化为生命', s1('lifeLeech')),

  // ---- 防御 ----
  A('suffix', 's_armor', '之堡垒', 'armor', DEFENCE,
    [[2, 31], [11, 48], [22, 66], [34, 86], [47, 108]],
    (v) => '+' + I(v) + ' 护甲', s1('armor')),
  A('suffix', 's_evasion', '之阴影', 'evasion', ['helmet', 'body', 'gloves', 'boots', 'shield', 'ring'],
    [[5, 0.03], [16, 0.05], [28, 0.075], [41, 0.1], [55, 0.13]],
    (v) => SP(v) + ' 闪避率', s1('evasion')),
  A('suffix', 's_block', '之铁壁', 'blockChance', ['shield', 'ring', 'amulet'],
    [[12, 0.025], [25, 0.045], [38, 0.065], [52, 0.09]],
    (v) => SP(v) + ' 格挡几率', s1('blockChance')),
  A('suffix', 's_thorns', '之报复', 'thorns', ['helmet', 'body', 'gloves', 'shield', 'belt'],
    [[8, 12], [20, 22], [33, 33], [47, 44]],
    (v) => '反弹 ' + I(v) + ' 点伤害', s1('thorns')),

  // ---- 元素伤害 ----
  A('suffix', 's_fire_dmg', '之焚', 'firePct', ['weapon', 'ring', 'amulet'],
    [[10, 0.1], [22, 0.19], [35, 0.3], [48, 0.42], [60, 0.55]],
    (v) => SP(v) + ' 火焰伤害', s1('fireDamageMult')),
  A('suffix', 's_cold_dmg', '之冰', 'coldPct', ['weapon', 'ring', 'amulet'],
    [[10, 0.1], [22, 0.19], [35, 0.3], [48, 0.42], [60, 0.55]],
    (v) => SP(v) + ' 冰霜伤害', s1('coldDamageMult')),
  A('suffix', 's_lightning_dmg', '之闪', 'lightningPct', ['weapon', 'ring', 'amulet'],
    [[10, 0.1], [22, 0.19], [35, 0.3], [48, 0.42], [60, 0.55]],
    (v) => SP(v) + ' 闪电伤害', s1('lightningDamageMult')),
  A('suffix', 's_chaos_dmg', '之瘟疫', 'chaosPct', ['weapon', 'ring', 'amulet'],
    [[22, 0.1], [38, 0.2], [55, 0.3]],
    (v) => SP(v) + ' 混沌伤害', s1('chaosDamageMult')),

  // ---- 附加元素伤害 ----
  A('suffix', 's_add_fire', '之炽焰', 'addFire', WEAPONISH,
    [[10, 5], [22, 8], [35, 13], [48, 17]],
    (v) => '1 - ' + I(v) + ' 附加火焰伤害', pairT('addedFireMin', 'addedFireMax')),
  A('suffix', 's_add_cold', '之凛冬', 'addCold', WEAPONISH,
    [[10, 4], [22, 7], [35, 10], [48, 14]],
    (v) => '1 - ' + I(v) + ' 附加冰霜伤害', pairT('addedColdMin', 'addedColdMax')),
  A('suffix', 's_add_lightning', '之奔雷', 'addLightning', WEAPONISH,
    [[10, 3], [22, 5], [35, 8], [48, 11]],
    (v) => '1 - ' + I(v) + ' 附加闪电伤害', pairT('addedLightningMin', 'addedLightningMax')),

  // ---- 冷却 / 范围 / 技能 ----
  A('suffix', 's_cdr', '之命运', 'cdr', ['ring', 'amulet', 'belt', 'helmet', 'weapon'],
    [[14, 0.04], [28, 0.08], [42, 0.12], [56, 0.16]],
    (v) => SP(v) + ' 冷却缩减', s1('cdrMult')),
  A('suffix', 's_aoe', '之扩散', 'aoe', ['weapon', 'shield', 'ring', 'amulet'],
    [[14, 0.045], [26, 0.07], [39, 0.095], [52, 0.12]],
    (v) => SP(v) + ' 范围效果', s1('aoeMult')),
  A('suffix', 's_area_damage', '之轰击', 'areaDamage', ['weapon', 'gloves', 'ring'],
    [[20, 0.1], [33, 0.17], [46, 0.26], [58, 0.35]],
    (v) => SP(v) + ' 范围伤害', s1('areaDamageMult')),

  // ---- 掉宝 / 经验 ----
  A('suffix', 's_rarity', '之拾荒者', 'rarity', LOOT,
    [[1, 0.13], [18, 0.23], [34, 0.34], [50, 0.45]],
    (v) => SP(v) + ' 物品稀有度', s1('rarityBonus')),
  A('suffix', 's_xp', '之求道', 'xp', ['ring', 'amulet', 'helmet', 'body'],
    [[1, 0.06], [20, 0.11], [40, 0.18]],
    (v) => SP(v) + ' 获得经验', s1('xpBonus')),
  A('suffix', 's_quantity', '之掠夺', 'quantity', ['ring', 'amulet', 'belt', 'gloves'],
    [[12, 0.08], [28, 0.14], [45, 0.22]],
    (v) => SP(v) + ' 物品数量', s1('quantityBonus')),
  A('suffix', 's_gold', '之贪婪', 'gold', ['ring', 'amulet', 'belt'],
    [[1, 0.12], [22, 0.2], [44, 0.3]],
    (v) => SP(v) + ' 硫磺碎片掉落', s1('goldFind')),
];

/** 全部前缀（核心池 + 扩充池，≥ 40 条）。 @type {ReadonlyArray<Affix>} */
/** @type {ReadonlyArray<Affix>} */
export const PREFIXES = Object.freeze([...PREFIXES_CORE, ...extraAffixes.EXTRA_PREFIXES]);

/** 全部后缀（核心池 + 扩充池，≥ 40 条）。 @type {ReadonlyArray<Affix>} */
/** @type {ReadonlyArray<Affix>} */
export const SUFFIXES = Object.freeze([...SUFFIXES_CORE, ...extraAffixes.EXTRA_SUFFIXES]);

/** 全部词缀（前缀 + 后缀，含扩充池）。 @type {ReadonlyArray<Affix>} */
export const ALL_AFFIXES = Object.freeze([...PREFIXES, ...SUFFIXES]);

/** 词缀 id → 词缀。 */
export const AFFIX_BY_ID = Object.freeze(
  ALL_AFFIXES.reduce((m, a) => { m[a.id] = a; return m; }, /** @type {Record<string, Affix>} */ ({})),
);

/**
 * 按 id 取词缀。
 * @param {string} id
 * @returns {Affix|undefined}
 */
export function affixById(id) {
  return AFFIX_BY_ID[id];
}

/**
 * 取某词缀在某物品等级下能出的最强档位（tiers 从强到弱，第一个 levelReq 满足的即最强）。
 * @param {Affix} affix
 * @param {number} level 物品等级
 * @returns {AffixTier|null}
 */
export function bestTierForLevel(affix, level) {
  for (const t of affix.tiers) if (t.levelReq <= level) return t;
  return null;
}

/**
 * 某基底 slot、某物品等级下可用的词缀列表。
 * @param {'prefix'|'suffix'} kind
 * @param {string} slot 基底 slot（weapon/helmet/…）
 * @param {number} level 物品等级
 * @returns {Array<{affix:Affix, tier:AffixTier}>}
 */
export function affixesForSlot(kind, slot, level) {
  const pool = kind === 'prefix' ? PREFIXES : SUFFIXES;
  /** @type {Array<{affix:Affix, tier:AffixTier}>} */
  const out = [];
  for (const a of pool) {
    if (!a.slots.includes(slot)) continue;
    const t = bestTierForLevel(a, level);
    if (t) out.push({ affix: a, tier: t });
  }
  return out;
}

/**
 * 保证 min/max 成对合法（min ≥ 1，max ≥ min + 1，均为整数）。
 * @param {Object<string,number>} o @param {string} kMin @param {string} kMax
 */
function fixPair(o, kMin, kMax) {
  o[kMin] = Math.max(1, Math.round(o[kMin]));
  o[kMax] = Math.max(o[kMin] + 1, Math.round(o[kMax]));
}

/**
 * 给档位数值加 ±12% 浮动，让同档词缀不完全一样。
 * @param {Object<string, number>} stats
 * @param {{next:()=>number}} rng
 * @returns {Object<string, number>}
 */
function rollValues(stats, rng) {
  /** @type {Object<string, number>} */
  const out = {};
  for (const k in stats) {
    const v = stats[k];
    if (typeof v !== 'number') continue;
    let nv = v * (0.88 + rng.next() * 0.24);
    if (v >= 5 && Number.isInteger(v)) nv = Math.max(1, Math.round(nv));
    else nv = Math.round(nv * 1000) / 1000;
    out[k] = nv;
  }
  for (const [kMin, kMax] of [['addedFireMin', 'addedFireMax'], ['addedColdMin', 'addedColdMax'],
    ['addedLightningMin', 'addedLightningMax'], ['physAddedMin', 'physAddedMax']]) {
    if (kMin in out && kMax in out) fixPair(out, kMin, kMax);
  }
  return out;
}

/**
 * 把 stats 对象渲染成中文显示文本（与词缀 tier.text 使用同一套格式规则）。
 * 成对伤害键会合并成「4 - 10 附加火焰伤害」。
 * @param {Object<string, number>} stats
 * @returns {string}
 */
export function statsToText(stats) {
  const parts = [];
  const pct = (x) => (x >= 0 ? '+' : '') + String(Math.round(x * 1000) / 10) + '%';
  const numS = (x) => (x >= 0 ? '+' : '') + String(Math.round(x));
  for (const k in stats) {
    const v = stats[k];
    if (typeof v !== 'number') continue;
    switch (k) {
      case 'life': parts.push(numS(v) + ' 生命'); break;
      case 'lifeRegen': parts.push('每秒回复 ' + Math.round(v * 10) / 10 + ' 点生命'); break;
      case 'mana': parts.push(numS(v) + ' 法力'); break;
      case 'manaRegen': parts.push('每秒回复 ' + Math.round(v * 10) / 10 + ' 点法力'); break;
      case 'energyShield': parts.push(numS(v) + ' 能量护盾'); break;
      case 'armor': parts.push(numS(v) + ' 护甲'); break;
      case 'evasion': parts.push(pct(v) + ' 闪避率'); break;
      case 'blockChance': parts.push(pct(v) + ' 格挡几率'); break;
      case 'thorns': parts.push('反弹 ' + Math.round(v) + ' 点伤害'); break;
      case 'maxResistance': parts.push(pct(v) + ' 各元素抗性上限'); break;
      case 'fireResist': parts.push(pct(v) + ' 火焰抗性'); break;
      case 'coldResist': parts.push(pct(v) + ' 冰霜抗性'); break;
      case 'lightningResist': parts.push(pct(v) + ' 闪电抗性'); break;
      case 'chaosResist': parts.push(pct(v) + ' 混沌抗性'); break;
      case 'attackSpeedMult': parts.push(pct(v) + ' 攻击速度'); break;
      case 'critChance': parts.push(pct(v) + ' 暴击率'); break;
      case 'critMulti': parts.push(pct(v) + ' 暴击伤害加成'); break;
      case 'moveSpeedMult': parts.push(pct(v) + ' 移动速度'); break;
      case 'physDamageMult': parts.push(pct(v) + ' 物理伤害'); break;
      case 'fireDamageMult': parts.push(pct(v) + ' 火焰伤害'); break;
      case 'coldDamageMult': parts.push(pct(v) + ' 冰霜伤害'); break;
      case 'lightningDamageMult': parts.push(pct(v) + ' 闪电伤害'); break;
      case 'chaosDamageMult': parts.push(pct(v) + ' 混沌伤害'); break;
      case 'aoeMult': parts.push(pct(v) + ' 范围效果'); break;
      case 'areaDamageMult': parts.push(pct(v) + ' 范围伤害'); break;
      case 'dotMult': parts.push(pct(v) + ' 持续伤害'); break;
      case 'skillLevelBonus': parts.push(numS(v) + ' 技能等级'); break;
      case 'lifeLeech': parts.push('攻击伤害的 ' + Math.round(v * 1000) / 10 + '% 转化为生命'); break;
      case 'lifeOnHit': parts.push('击中时回复 ' + Math.round(v) + ' 点生命'); break;
      case 'cdrMult': parts.push(pct(v) + ' 冷却缩减'); break;
      case 'projectileSpeedMult': parts.push(pct(v) + ' 投射物速度'); break;
      case 'damageMult': parts.push(pct(v) + ' 全局伤害'); break;
      case 'rarityBonus': parts.push(pct(v) + ' 物品稀有度'); break;
      case 'xpBonus': parts.push(pct(v) + ' 获得经验'); break;
      case 'quantityBonus': parts.push(pct(v) + ' 物品数量'); break;
      case 'goldFind': parts.push(pct(v) + ' 硫磺碎片掉落'); break;
      case 'addedFireMin': pairText(parts, stats, 'addedFireMin', 'addedFireMax', '火焰'); break;
      case 'addedColdMin': pairText(parts, stats, 'addedColdMin', 'addedColdMax', '冰霜'); break;
      case 'addedLightningMin': pairText(parts, stats, 'addedLightningMin', 'addedLightningMax', '闪电'); break;
      case 'physAddedMin': pairText(parts, stats, 'physAddedMin', 'physAddedMax', '物理'); break;
      default: break;
    }
  }
  return parts.join('，');
}

/**
 * 成对伤害文本。
 * @param {string[]} parts @param {Object<string,number>} stats @param {string} kMin @param {string} kMax @param {string} label
 */
function pairText(parts, stats, kMin, kMax, label) {
  if (typeof stats[kMax] !== 'number') return;
  parts.push(Math.round(stats[kMin]) + ' - ' + Math.round(stats[kMax]) + ' 附加' + label + '伤害');
}

/**
 * 按稀有度掷词缀。
 *
 * 规则：
 *  - normal：0 条
 *  - magic ：1-2 条（各 50%）；2 条时 1 前缀 + 1 后缀
 *  - rare  ：4-6 条，前缀 2-3 条 + 后缀 2-3 条
 *  - unique：0 条（传奇词缀由 unique.js 固定给出）
 *  - 同一 group 不重复（前缀与后缀之间也互斥）
 *  - 词缀档位的 levelReq 必须 ≤ 物品等级
 *
 * @param {{next:()=>number, range?:(a:number,b:number)=>number, int?:(a:number,b:number)=>number, pick?:(a:any[])=>any, weighted?:(a:any[])=>any, shuffle?:(a:any[])=>any}|number|Function} rng
 *   可以是 RNG 实例、"只有 next()" 的对象、随机函数，或数字种子。
 * @param {number} level 物品等级
 * @param {'normal'|'magic'|'rare'|'unique'} rarity
 * @param {string} slot 基底 slot（weapon/helmet/…）
 * @param {{slot?:string}} [base] 基底对象（可选；提供时优先使用 base.slot）
 * @returns {Array<{id:string, name:string, text:string, stats:Object<string,number>, tier:number, prefix:boolean}>}
 */
export function rollAffixes(rng, level, rarity, slot, base) {
  const r = getRNG(rng);
  const lv = Math.max(1, Math.floor(level || 1));
  const useSlot = base && base.slot ? base.slot : slot;
  if (!useSlot) return [];
  if (rarity !== 'magic' && rarity !== 'rare') return [];

  const prePools = affixesForSlot('prefix', useSlot, lv);
  const sufPools = affixesForSlot('suffix', useSlot, lv);

  // 数量：前缀 / 后缀各要几条
  let nPre = 0;
  let nSuf = 0;
  if (rarity === 'magic') {
    if (r.next() < 0.5) {
      if (r.next() < 0.5) nPre = 1; else nSuf = 1;
    } else {
      nPre = 1; nSuf = 1;
    }
  } else {
    // rare：总 4..6，先定前缀数（2..3），其余给后缀（两边都 ≥ 2 且 ≤ 3）
    const total = 4 + Math.floor(r.next() * 3);
    let pre = 2 + Math.floor(r.next() * 2);
    if (total - pre > 3) pre = total - 3;
    if (total - pre < 2) pre = total - 2;
    nPre = pre;
    nSuf = total - pre;
  }

  /**
   * @type {Array<{id:string,name:string,text:string,stats:Object<string,number>,tier:number,prefix:boolean}>}
   */
  const out = [];
  /** @type {Set<string>} */
  const usedGroups = new Set();

  /**
   * 从池子里挑 n 条（跳过已用 group）。
   * @param {Array<{affix:Affix, tier:AffixTier}>} pool
   * @param {number} count
   */
  const takeFrom = (pool, count) => {
    for (let i = 0; i < count; i++) {
      const avail = pool.filter((p) => !usedGroups.has(p.affix.group));
      if (avail.length === 0) break;
      // 越强的档位越稀有：T1 权重最低
      const w = avail.map((p) => ({ weight: 1 / (0.35 + p.tier.tier), item: p }));
      const picked = /** @type {{item:{affix:Affix, tier:AffixTier}}} */ (r.weighted(w)).item;
      usedGroups.add(picked.affix.group);
      const stats = rollValues(picked.tier.stats, r);
      out.push({
        id: picked.affix.id,
        name: picked.affix.name,
        text: statsToText(stats),
        stats,
        tier: picked.tier.tier,
        prefix: picked.affix.kind === 'prefix',
      });
    }
  };

  // 交错地挑，避免前缀全在数组前面（显示时再统一排序）
  const maxRounds = Math.max(nPre, nSuf);
  for (let i = 0; i < maxRounds; i++) {
    if (i < nPre) takeFrom(prePools, 1);
    if (i < nSuf) takeFrom(sufPools, 1);
  }
  return out;
}

export default { PREFIXES, SUFFIXES, rollAffixes, RESIST_KEYS, RESIST_NAMES };