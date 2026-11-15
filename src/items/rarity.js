// @file src/items/rarity.js
// 稀有度定义与掉落稀有度掷骰。POE 官方配色。
//
// 【硬约束】纯数据 / 纯函数，不 import 浏览器 API / three / DOM。

/**
 * @typedef {'normal'|'magic'|'rare'|'unique'} RarityKey
 */

/**
 * @typedef {Object} RarityDef
 * @property {string} name     中文名
 * @property {string} color    POE 配色（用于名字 / 边框）
 * @property {string} bg       提示框背景色（半透明）
 * @property {string} border   提示框边框色
 * @property {number} pickWeight 掉落权重（普通 720 / 魔法 250 / 稀有 29 / 传奇 1）
 * @property {number} scoreMult  战力估算倍率（itemScore 用）
 * @property {string} desc     一句话说明
 */

/**
 * 稀有度表。颜色严格用 POE 官方配色：
 *   normal #c8c8c8 / magic #8888ff / rare #ffff77 / unique #af6025
 * @type {Record<RarityKey, RarityDef>}
 */
export const RARITY = Object.freeze({
  normal: Object.freeze({
    name: '普通', color: '#c8c8c8', bg: 'rgba(12,12,14,0.94)', border: '#3a3a42',
    pickWeight: 720, scoreMult: 1.0, affixRange: Object.freeze([0, 0]),
    desc: '没有词缀的白板装备',
  }),
  magic: Object.freeze({
    name: '魔法', color: '#8888ff', bg: 'rgba(12,12,22,0.94)', border: '#2c2c66',
    pickWeight: 250, scoreMult: 1.15, affixRange: Object.freeze([1, 2]),
    desc: '带有 1-2 条词缀的蓝装',
  }),
  rare: Object.freeze({
    name: '稀有', color: '#ffff77', bg: 'rgba(20,18,8,0.94)', border: '#5c5426',
    pickWeight: 29, scoreMult: 1.35, affixRange: Object.freeze([4, 6]),
    desc: '带有 4-6 条词缀的黄装',
  }),
  unique: Object.freeze({
    name: '传奇', color: '#af6025', bg: 'rgba(20,12,6,0.95)', border: '#5c3418',
    pickWeight: 1, scoreMult: 1.9, affixRange: Object.freeze([0, 0]),
    desc: '拥有独立名字与传奇效果的橙装',
  }),
});

/** 稀有度键（按稀有度从低到高）。 */
export const RARITY_KEYS = Object.freeze(/** @type {RarityKey[]} */ (['normal', 'magic', 'rare', 'unique']));

/** 稀有度排序（用于比较，越大越稀有）。 */
export const RARITY_RANK = Object.freeze({ normal: 0, magic: 1, rare: 2, unique: 3 });

/**
 * 取稀有度中文名（未知键返回「普通」）。
 * @param {string} rarity
 * @returns {string}
 */
export function rarityName(rarity) {
  const r = RARITY[/** @type {RarityKey} */ (rarity)];
  return r ? r.name : '普通';
}

/**
 * 取稀有度颜色（未知键返回普通色）。
 * @param {string} rarity
 * @returns {string}
 */
export function rarityColor(rarity) {
  const r = RARITY[/** @type {RarityKey} */ (rarity)];
  return r ? r.color : '#c8c8c8';
}

/** 默认掉落概率（普通 71% / 魔法 22% / 稀有 6.4% / 传奇 0.6%）。 */
export const BASE_CHANCES = Object.freeze({ normal: 0.71, magic: 0.22, rare: 0.064, unique: 0.006 });

/**
 * 掷一次掉落稀有度。
 *
 * §baseChance§ 支持两种写法（都向后兼容）：
 *   1. 数字：额外的「稀有度提升倍率」（1 = 无提升，1.5 = +50% 掉宝率）。
 *      魔法/稀有/传奇的概率按 (1 + bonus) 提升，普通相应减少（归一化后仍然总和为 1）。
 *   2. 对象：完整覆盖概率表，如 { normal:0.6, magic:0.3, rare:0.09, unique:0.01 }；
 *      也可再加一个 `bonus` 字段表示额外提升倍率。
 *
 * @param {{next:()=>number}} rng
 * @param {number|{normal?:number,magic?:number,rare?:number,unique?:number,bonus?:number}} [baseChance=1]
 * @returns {'normal'|'magic'|'rare'|'unique'}
 */
export function rollRarity(rng, baseChance = 1) {
  let table;
  let bonus = 0;
  if (typeof baseChance === 'number' && Number.isFinite(baseChance)) {
    bonus = Math.max(0, baseChance - 1);
    table = { ...BASE_CHANCES };
  } else if (baseChance && typeof baseChance === 'object') {
    table = {
      normal: num(baseChance.normal, BASE_CHANCES.normal),
      magic: num(baseChance.magic, BASE_CHANCES.magic),
      rare: num(baseChance.rare, BASE_CHANCES.rare),
      unique: num(baseChance.unique, BASE_CHANCES.unique),
    };
    bonus = Math.max(0, num(baseChance.bonus, 0));
  } else {
    table = { ...BASE_CHANCES };
  }
  // 掉宝率提升：稀有上限按 1 + bonus，同时把提升的部分转成魔法
  const mag = table.magic * (1 + bonus);
  const rar = table.rare * (1 + bonus);
  const unq = table.unique * (1 + bonus);
  const nm = Math.max(0, table.normal - (mag - table.magic) - (rar - table.rare) - (unq - table.unique));
  const total = nm + mag + rar + unq;
  if (!(total > 0)) return 'normal';
  let x = rng.next() * total;
  x -= nm;
  if (x < 0) return 'normal';
  x -= mag;
  if (x < 0) return 'magic';
  x -= rar;
  if (x < 0) return 'rare';
  return 'unique';
}
/** @param {any} v @param {number} d */
function num(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * 实际概率表（给 UI 的「掉落率说明」用）。
 * @param {number|Object} [bonus=1]
 * @returns {{normal:number, magic:number, rare:number, unique:number}}
 */
export function rarityChances(bonus = 1) {
  const b = Math.max(0, (typeof bonus === 'number' ? bonus : 1) - 1);
  const mag = BASE_CHANCES.magic * (1 + b);
  const rar = BASE_CHANCES.rare * (1 + b);
  const unq = BASE_CHANCES.unique * (1 + b);
  const nm = Math.max(0, BASE_CHANCES.normal - (mag - BASE_CHANCES.magic) - (rar - BASE_CHANCES.rare) - (unq - BASE_CHANCES.unique));
  const t = nm + mag + rar + unq;
  return { normal: nm / t, magic: mag / t, rare: rar / t, unique: unq / t };
}

/**
 * 词缀数量：普通 0；魔法 1-2（50/50）；稀有 4-6。
 * 传奇物品的词缀由 unique.js 固定定义，这里返回 0。
 * @param {{next:()=>number, pick?:(a:any[])=>any}} rng
 * @param {string} rarity
 * @returns {number}
 */
export function rollAffixCount(rng, rarity) {
  switch (rarity) {
    case 'magic':
      return rng.next() < 0.5 ? 1 : 2;
    case 'rare':
      return 4 + Math.floor(rng.next() * 3); // 4 / 5 / 6
    default:
      return 0;
  }
}