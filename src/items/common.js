// @file src/items/common.js
// 物品系统的公共定义与纯工具函数。
//
// 【硬约束】纯数据 / 纯函数，不 import 任何浏览器 API、three、DOM。
// 本文件只依赖 src/engine/rng.js（纯 JS 的确定性随机数）。
//
// 内容：
//   1. STAT_KEYS / ITEM_STAT_KEYS —— StatBlock 统计键（与 src/core/stats.js 完全一致）
//   2. DMG_KEYS / DAMAGE_PAIRS —— 武器伤害相关的键（由 itemgen 特殊处理）
//   3. fmt / fmtInt / fmtPct —— 中文数值显示（"+34 护甲"、"+8% 攻击速度"）
//   4. getRNG —— rng 鸭子类型适配（RNG 实例 / 纯函数 / 种子数字 / 缺省）

import { RNG, hashString } from '../engine/rng.js';

/**
 * StatBlock 的全部统计键（顺序即 UI 显示顺序），与 `src/core/stats.js` 的 `STAT_KEYS` 一致。
 * 物品词缀 / 天赋节点 / 技能树效果里出现的数值键都必须是这里的成员。
 * @type {ReadonlyArray<string>}
 */
export const STAT_KEYS = Object.freeze([
  'life', 'lifeRegen',
  'mana', 'manaRegen',
  'energyShield',
  'armor', 'evasion', 'blockChance',
  'dmgMin', 'dmgMax',
  'attackSpeedMult', 'critChance', 'critMulti', 'moveSpeedMult',
  'physDamageMult', 'physAddedMin', 'physAddedMax',
  'fireDamageMult', 'coldDamageMult', 'lightningDamageMult', 'chaosDamageMult',
  'addedFireMin', 'addedFireMax', 'addedColdMin', 'addedColdMax',
  'addedLightningMin', 'addedLightningMax',
  'aoeMult', 'skillLevelBonus',
  'lifeLeech', 'lifeOnHit', 'cdrMult', 'areaDamageMult', 'dotMult',
  'thorns', 'projectileSpeedMult',
  'damageMult', 'damageTakenMult',
  'maxResistance',
  'fireResist', 'coldResist', 'lightningResist', 'chaosResist',
]);

/** StatBlock 键的 Set 形式（测试 / 校验用）。 */
export const STAT_KEY_SET = new Set(STAT_KEYS);

/**
 * 「额外」统计键：不在 StatBlock 里，但物品 / 天赋可以提供，由 Lead 的玩家逻辑读取。
 * @type {ReadonlyArray<string>}
 */
export const EXTRA_STAT_KEYS = Object.freeze([
  'rarityBonus', // 掉落稀有度加成（POE 的 item rarity）
  'xpBonus',     // 经验加成
  'quantityBonus', // 掉落数量加成
  'goldFind',    // 金币 / 硫磺碎片获取加成
]);

/** 物品 / 天赋 / 技能允许出现的全部数值键。 */
export const ITEM_STAT_KEYS = Object.freeze([...STAT_KEYS, ...EXTRA_STAT_KEYS]);

/** 物品键集合（测试用）。 */
export const ITEM_STAT_KEY_SET = new Set(ITEM_STAT_KEYS);

/**
 * 武器伤害键：这些键不会进入 `item.stats`，而是由 itemgen 合成到
 * `item.dmgMin / item.dmgMax / item.damage` 上。
 * @type {ReadonlyArray<string>}
 */
export const DMG_KEYS = Object.freeze(['dmgMin', 'dmgMax', 'physAddedMin', 'physAddedMax']);

/** 元素 / 物理「附加伤害」的成对键：min 与 max 必须同时出现。 */
export const DAMAGE_PAIRS = Object.freeze([
  ['physAddedMin', 'physAddedMax'],
  ['addedFireMin', 'addedFireMax'],
  ['addedColdMin', 'addedColdMax'],
  ['addedLightningMin', 'addedLightningMax'],
]);

/**
 * 百分比类统计键（显示为 `+8%`）。其余键显示为普通数值（显示为 `+34`）。
 * @type {ReadonlySet<string>}
 */
export const PERCENT_KEYS = new Set([
  'evasion', 'blockChance', 'attackSpeedMult', 'critChance', 'critMulti',
  'moveSpeedMult', 'physDamageMult', 'fireDamageMult', 'coldDamageMult',
  'lightningDamageMult', 'chaosDamageMult', 'aoeMult', 'lifeLeech',
  'cdrMult', 'areaDamageMult', 'dotMult', 'projectileSpeedMult',
  'damageMult', 'damageTakenMult', 'maxResistance',
  'fireResist', 'coldResist', 'lightningResist', 'chaosResist',
  'rarityBonus', 'xpBonus', 'quantityBonus', 'goldFind',
]);

/** 抗性键（装备面板 / tooltip 分组用）。 */
export const RESIST_KEYS = Object.freeze(['fireResist', 'coldResist', 'lightningResist', 'chaosResist']);

/** 抗性键 → 中文名。 */
export const RESIST_NAMES = Object.freeze({
  fireResist: '火焰抗性',
  coldResist: '冰霜抗性',
  lightningResist: '闪电抗性',
  chaosResist: '混沌抗性',
});

/**
 * 带小数的中文数字（保留 1 位小数，去掉多余的 .0）。
 * @param {number} v
 * @returns {string}
 */
export function fmt(v) {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * 四舍五入到整数并转字符串。
 * @param {number} v
 * @returns {string}
 */
export function fmtInt(v) {
  return String(Math.round(Number.isFinite(v) ? v : 0));
}

/**
 * 把小数转成百分比字符串：0.08 → "8"、0.065 → "6.5"、1.5 → "150"。
 * @param {number} v
 * @returns {string}
 */
export function fmtPct(v) {
  if (!Number.isFinite(v)) return '0';
  const p = v * 100;
  const r = Math.round(p * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/**
 * 带符号的中文数值：fmtSigned(34) → "+34"；fmtSigned(-20) → "-20"；fmtSigned(0) → "0"。
 * @param {number} v @param {(v:number)=>string} [fn]
 * @returns {string}
 */
export function fmtSigned(v, fn = fmt) {
  const s = fn(v);
  return v > 0 ? `+${s}` : s;
}

/**
 * 文本转义（只用于我们自己的数据，但 tooltip 会被 innerHTML 使用，仍然做一层防御）。
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 生成短唯一 id（不依赖全局计数器也能在进程内唯一：时间 + 自增 + 随机）。
 * 纯函数式实现（不读 DOM），Node / 浏览器都能用。
 * @param {string} [prefix]
 * @returns {string}
 */
export function uid(prefix = 'itm') {
  _uidCounter = (_uidCounter + 1) % 0xffffff;
  const t = Date.now().toString(36).slice(-6);
  const r = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}_${t}${_uidCounter.toString(36)}${r}`;
}
let _uidCounter = 0;

/**
 * rng 鸭子类型适配：返回一个具备 next/range/int/pick/chance/weighted/shuffle 的对象。
 *
 * 支持的入参：
 *   - RNG 实例（src/engine/rng.js）→ 原样返回
 *   - 函数（等价于 next()）
 *   - 数字（当作种子，内部新建 RNG）
 *   - null / undefined → 内部新建一个随机种子的 RNG
 *
 * @param {any} rng
 * @returns {{next:()=>number, range:(a:number,b:number)=>number, int:(a:number,b:number)=>number,
 *   pick:<T>(a:T[])=>T, chance:(p:number)=>boolean, weighted:(a:any[])=>any, shuffle:<T>(a:T[])=>T[]}}
 */
export function getRNG(rng) {
  if (rng && typeof rng === 'object' && typeof rng.next === 'function' && typeof rng.int === 'function') {
    if (typeof rng.weighted === 'function' && typeof rng.shuffle === 'function') return rng;
    return adaptRNG(rng);
  }
  if (typeof rng === 'function') return adaptRNG({ next: rng });
  if (typeof rng === 'number') return new RNG(rng >>> 0);
  return new RNG((Math.floor(Math.random() * 0xffffffff) ^ (Date.now() & 0xffffffff)) >>> 0);
}

/**
 * 把「只有 next()」的对象包装成完整 RNG 接口（不修改原对象）。
 * @param {{next:()=>number, int?:(a:number,b:number)=>number}} src
 * @returns {{next:()=>number, range:(a:number,b:number)=>number, int:(a:number,b:number)=>number,
 *   pick:<T>(a:T[])=>T, chance:(p:number)=>boolean, weighted:(a:any[])=>any, shuffle:<T>(a:T[])=>T[]}}
 */
export function adaptRNG(src) {
  const r = {
    next: () => src.next(),
    range: (a, b) => a + (b - a) * r.next(),
    int: (a, b) => Math.floor(r.range(a, b + 1)),
    pick: (arr) => arr[Math.min(arr.length - 1, Math.floor(r.next() * arr.length))],
    chance: (p) => r.next() < p,
    /**
     * 加权抽样：数组元素可以是数字权重，也可以是 { weight, ... } 对象。
     * @param {any[]} items
     */
    weighted: (items) => {
      let total = 0;
      for (const it of items) total += typeof it === 'number' ? it : (it.weight || 0);
      let x = r.next() * total;
      for (let i = 0; i < items.length; i++) {
        const w = typeof items[i] === 'number' ? items[i] : (items[i].weight || 0);
        x -= w;
        if (x <= 0) return typeof items[i] === 'number' ? i : items[i];
      }
      const last = items[items.length - 1];
      return typeof last === 'number' ? items.length - 1 : last;
    },
    /**
     * 洗牌（不修改原数组）。
     * @template T @param {T[]} arr @returns {T[]}
     */
    shuffle: (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(r.next() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    },
  };
  return r;
}

/**
 * 由任意字符串派生一个确定性种子。
 * @param {string} s
 * @returns {number}
 */
export function seedFromString(s) {
  return hashString(String(s));
}

export { RNG, hashString };