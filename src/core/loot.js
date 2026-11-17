// @file src/core/loot.js
// 掉落系统：装备掉落（world.items）、魂火拾取物（world.lootOrbs）、技能精炼石、拾取查询。
// 纯逻辑，不依赖 DOM / three。
//
// 【world.items 里混着两类东西】
//   1) 装备掉落 { id, x, z, item, ttl, born, rarity, ... }        —— 需要进背包
//   2) 技能精炼石 { kind:'skillOrb', amount, x, z, uid, ttl, ... } —— 不占背包格子，拾取即加到 inv.skillOrbs
//   两类都带 x/z/ttl，所以 ttl 清理、pickupNearest 的遍历逻辑可以共用；
//   区分方式统一用 `isSkillOrbDrop(d)`（约定：kind === 'skillOrb' 且没有 item 字段）。
//   装备掉落不要给它加 kind 字段，否则 app 会误以为是精炼石。
//
// 【优先使用 items 成员的生成器】
//   1) world.itemGen?.generateDrop({rng, level, rarity, slot}) —— 由 Lead 注入
//   2) 动态 import('../../src/items/itemgen.js')（可选，模块不存在时静默回退）
//   3) 内置最小掉落表 BASE_ITEM_TYPES
//
// 【物品实例结构（UI 依赖）】
//   {
//     id: string, name: 中文名, baseName: 基底名, slot: 'weapon'|'helmet'|'armor'|'gloves'|'boots'|'belt'|'amulet'|'ring',
//     rarity: 'normal'|'magic'|'rare'|'unique',   // 'legendary' 也可传入，会自动归一为 'unique'
//     rarityName: 中文稀有度, level: number, ilvl: number,
//     mods: [{ id?, text: 中文词缀文本, stats: { ...StatBlock 字段 }, tier? }],
//     stats: { 汇总后的属性 }, statsText?: string[],
//     icon?: string, color?: string
//   }

import { pushWorldEvent, rngOf } from './combat.js';

/**
 * 技能精炼石的掉落率（契约 §3.5）。按敌人稀有度区分：
 * 普通 6% / 魔法 12% / 稀有(精英) 35% / Boss 100%（一次给 3 个）。
 * 设计意图：精炼一次要 3-8 个石头，按 playtest 的 45-50 杀/分钟估算，
 * 普通怪每分钟约 3 个石头 → 一次精炼 1-3 分钟，正好是"打一层图就能点一下"的节奏。
 */
export const SKILL_ORB_DROP = Object.freeze({
  normal: 0.06,
  magic: 0.12,
  rare: 0.35,
  elite: 0.35,
  boss: 1,
});

/** Boss 一次掉几个（契约 §3.5：一次给 3 个） */
export const SKILL_ORB_BOSS_AMOUNT = 3;

/**
 * 传奇 / 暗金装备的独立掉落率（每次击杀额外掷一次，不占用普通装备掉落）。
 * 高阶内容（精英、Boss、深层地图）成长更快：等级越高，暗金越常见。
 * 数值为「每次击杀」的基础概率，实际还会叠加地图「物品数量」词缀。
 */
export const UNIQUE_DROP_RATE = Object.freeze({
  normal: Object.freeze({ base: 0.002, perLevel: 0.0001, max: 0.008 }),
  magic: Object.freeze({ base: 0.008, perLevel: 0.0002, max: 0.02 }),
  rare: Object.freeze({ base: 0.03, perLevel: 0.0006, max: 0.08 }),
  boss: Object.freeze({ base: 1, perLevel: 0, max: 1 }),
});

/**
 * 某种敌人 / 等级下的暗金掉落概率（0..1）。
 * @param {'normal'|'magic'|'rare'|'elite'|'boss'|'unique'} rarity
 * @param {number} [level=1]
 * @returns {number}
 */
export function uniqueDropChance(rarity, level = 1) {
  const key = rarity === 'elite' ? 'rare' : normalizeRarity(rarity);
  const cfg = UNIQUE_DROP_RATE[key] || UNIQUE_DROP_RATE.normal;
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  return Math.min(cfg.max, cfg.base + cfg.perLevel * (lv - 1));
}

/**
 * 稀有度中文名。
 * 注意：items 模块用 'unique' 表示传奇（POE 命名），本模块两种键都兼容，
 * finalizeItem 会把 'legendary' 归一成 'unique' 后再查表。
 */
export const RARITY_NAMES = Object.freeze({
  normal: '普通', magic: '魔法', rare: '稀有', unique: '传奇', legendary: '传奇',
});

/** 稀有度颜色（POE 官方配色：白 / 蓝 / 黄 / 橙） */
export const RARITY_COLORS = Object.freeze({
  normal: '#c8c8c8', magic: '#8888ff', rare: '#ffff77', unique: '#af6025', legendary: '#af6025',
});

/** 稀有度键别名归一：legendary → unique（与 items 模块一致） */
export function normalizeRarity(r) {
  return r === 'legendary' ? 'unique' : r;
}

/** 装备槽位 */
export const SLOTS = Object.freeze(['weapon', 'helmet', 'armor', 'gloves', 'boots', 'belt', 'amulet', 'ring']);

/** 槽位中文名 */
export const SLOT_NAMES = Object.freeze({
  weapon: '武器', helmet: '头盔', armor: '胸甲', gloves: '手套', boots: '鞋子', belt: '腰带', amulet: '项链', ring: '戒指',
});

let _itemId = 0;
/**
 * 生成短 id（与 RNG 无关，仅用于 UI/拾取去重；测试不依赖其具体值）。
 * @param {string} prefix
 */
export function nextId(prefix = 'it') {
  _itemId += 1;
  return `${prefix}_${_itemId.toString(36)}`;
}

/**
 * 内置最小掉落表：每个槽位若干基底。
 * stats 为 createBaseStats 相关字段的加成（会在 UI 里显示成中文）。
 */
export const BASE_ITEM_TYPES = Object.freeze([
  // 武器
  { id: 'rustyBlade', name: '锈蚀长剑', slot: 'weapon', icon: '🗡️', tier: 1, base: { dmgMin: 6, dmgMax: 11 } },
  { id: 'ironAxe', name: '铁质战斧', slot: 'weapon', icon: '🪓', tier: 1, base: { dmgMin: 8, dmgMax: 14, attackSpeedMult: -0.05 } },
  { id: 'boneHammer', name: '骨锤', slot: 'weapon', icon: '🔨', tier: 2, base: { dmgMin: 11, dmgMax: 19, attackSpeedMult: -0.1 } },
  { id: 'glyphSword', name: '符文长剑', slot: 'weapon', icon: '⚔️', tier: 3, base: { dmgMin: 15, dmgMax: 26, critChance: 0.03 } },
  // 防具
  { id: 'clothHood', name: '布质兜帽', slot: 'helmet', icon: '🎩', tier: 1, base: { armor: 8, mana: 6 } },
  { id: 'ironHelm', name: '铁盔', slot: 'helmet', icon: '⛑️', tier: 2, base: { armor: 22, life: 12 } },
  { id: 'leatherVest', name: '皮甲', slot: 'armor', icon: '🦺', tier: 1, base: { armor: 14, evasion: 0.02, life: 10 } },
  { id: 'plateArmor', name: '板甲', slot: 'armor', icon: '🛡️', tier: 3, base: { armor: 46, life: 26, moveSpeedMult: -0.05 } },
  { id: 'leatherGloves', name: '皮手套', slot: 'gloves', icon: '🧤', tier: 1, base: { attackSpeedMult: 0.03, armor: 5 } },
  { id: 'ironBoots', name: '铁靴', slot: 'boots', icon: '🥾', tier: 1, base: { armor: 9, moveSpeedMult: 0.04 } },
  { id: 'swiftBoots', name: '疾行靴', slot: 'boots', icon: '👟', tier: 2, base: { evasion: 0.03, moveSpeedMult: 0.07 } },
  { id: 'leatherBelt', name: '皮带', slot: 'belt', icon: '🎗️', tier: 1, base: { life: 12, lifeRegen: 0.4 } },
  { id: 'boneAmulet', name: '骨项链', slot: 'amulet', icon: '📿', tier: 2, base: { mana: 14, manaRegen: 1 } },
  { id: 'copperRing', name: '铜戒', slot: 'ring', icon: '💍', tier: 1, base: { fireResist: 0.05, life: 6 } },
]);

/**
 * 内置词缀池（按"前缀/后缀"混在一起，带 tier 权重）。
 * 每个词缀返回 { text, stats }。
 */
const AFFIX_POOL = [
  { id: 'life', text: (v) => `+${v} 最大生命`, roll: (r, lv) => r.int(6 + lv * 2, 14 + lv * 5), apply: (v) => ({ life: v }) },
  { id: 'mana', text: (v) => `+${v} 最大法力`, roll: (r, lv) => r.int(4 + lv, 10 + lv * 3), apply: (v) => ({ mana: v }) },
  { id: 'manaRegen', text: (v) => `每秒回复 ${v.toFixed(1)} 法力`, roll: (r, lv) => Math.round(r.range(5, 15) + lv * 0.6) / 10, apply: (v) => ({ manaRegen: v }) },
  { id: 'lifeRegen', text: (v) => `每秒回复 ${v.toFixed(1)} 生命`, roll: (r, lv) => Math.round(r.range(2, 6) + lv * 0.25) / 10, apply: (v) => ({ lifeRegen: v }) },
  { id: 'armor', text: (v) => `+${v} 护甲`, roll: (r, lv) => r.int(8 + lv * 2, 20 + lv * 4), apply: (v) => ({ armor: v }) },
  { id: 'evasion', text: (v) => `+${(v * 100).toFixed(1)}% 闪避率`, roll: (r, lv) => Math.round(r.range(5, 20) + lv * 0.4) / 1000, apply: (v) => ({ evasion: v }) },
  { id: 'block', text: (v) => `+${(v * 100).toFixed(0)}% 格挡率`, roll: (r) => Math.round(r.range(20, 70)) / 1000, apply: (v) => ({ blockChance: v }) },
  { id: 'physPct', text: (v) => `+${(v * 100).toFixed(0)}% 物理伤害`, roll: (r) => Math.round(r.range(6, 18)) / 100, apply: (v) => ({ physDamageMult: v }) },
  { id: 'addFire', text: (v) => `附加 ${v} - ${v * 2} 火焰伤害`, roll: (r, lv) => r.int(1 + Math.floor(lv / 3), 3 + lv), apply: (v) => ({ addedFireMin: v, addedFireMax: v * 2 }) },
  { id: 'addCold', text: (v) => `附加 ${v} - ${v * 2} 冰霜伤害`, roll: (r, lv) => r.int(1 + Math.floor(lv / 3), 3 + lv), apply: (v) => ({ addedColdMin: v, addedColdMax: v * 2 }) },
  { id: 'addLight', text: (v) => `附加 ${v} - ${v * 3} 闪电伤害`, roll: (r, lv) => r.int(1 + Math.floor(lv / 4), 2 + lv), apply: (v) => ({ addedLightningMin: v, addedLightningMax: v * 3 }) },
  { id: 'atkSpeed', text: (v) => `+${(v * 100).toFixed(0)}% 攻击速度`, roll: (r) => Math.round(r.range(3, 11)) / 100, apply: (v) => ({ attackSpeedMult: v }) },
  { id: 'crit', text: (v) => `+${(v * 100).toFixed(1)}% 暴击率`, roll: (r) => Math.round(r.range(10, 60)) / 1000, apply: (v) => ({ critChance: v }) },
  { id: 'critMulti', text: (v) => `+${(v * 100).toFixed(0)}% 暴击伤害`, roll: (r) => Math.round(r.range(5, 25)) / 100, apply: (v) => ({ critMulti: v }) },
  { id: 'moveSpeed', text: (v) => `+${(v * 100).toFixed(0)}% 移动速度`, roll: (r) => Math.round(r.range(3, 10)) / 100, apply: (v) => ({ moveSpeedMult: v }) },
  { id: 'fireRes', text: (v) => `+${(v * 100).toFixed(0)}% 火焰抗性`, roll: (r) => Math.round(r.range(5, 20)) / 100, apply: (v) => ({ fireResist: v }) },
  { id: 'coldRes', text: (v) => `+${(v * 100).toFixed(0)}% 冰霜抗性`, roll: (r) => Math.round(r.range(5, 20)) / 100, apply: (v) => ({ coldResist: v }) },
  { id: 'lightRes', text: (v) => `+${(v * 100).toFixed(0)}% 闪电抗性`, roll: (r) => Math.round(r.range(5, 20)) / 100, apply: (v) => ({ lightningResist: v }) },
  { id: 'leech', text: (v) => `攻击伤害的 ${(v * 100).toFixed(1)}% 转化为生命`, roll: (r) => Math.round(r.range(15, 45)) / 1000, apply: (v) => ({ lifeLeech: v }) },
  { id: 'aoe', text: (v) => `+${(v * 100).toFixed(0)}% 范围效果`, roll: (r) => Math.round(r.range(4, 12)) / 100, apply: (v) => ({ aoeMult: v }) },
  { id: 'thorns', text: (v) => `受击时反弹 ${v} 点伤害`, roll: (r, lv) => r.int(2 + lv, 6 + lv * 2), apply: (v) => ({ thorns: v }) },
];

/** 神话级（传奇）专属词缀 */
const LEGENDARY_AFFIXES = [
  { id: 'lgAllDmg', text: '所有伤害提高 12%', stats: { damageMult: 0.12 } },
  { id: 'lgLife', text: '+15% 最大生命（近似折算）', stats: { life: 45 } },
  { id: 'lgCdr', text: '冷却缩减 8%', stats: { cdrMult: 0.08 } },
  { id: 'lgAoe', text: '范围伤害 +20%', stats: { areaDamageMult: 0.2 } },
  { id: 'lgLoh', text: '击中回复 3 生命', stats: { lifeOnHit: 3 } },
];

/** 词缀显示文本用中文数值格式化 */
function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * 生成一件内置物品（不依赖 items 模块）。
 * @param {Object} rng RNG 实例
 * @param {{level?:number, rarity?:'normal'|'magic'|'rare'|'unique'|'legendary', slot?:string}} [opts]
 * @returns {Object} 物品实例（结构见文件头）
 */
export function makeBuiltinItem(rng, opts = {}) {
  const r = rng || rngOf(null);
  const level = Math.max(1, Math.floor(opts.level || 1));
  const slot = opts.slot || r.pick(SLOTS);
  const pool = BASE_ITEM_TYPES.filter((b) => b.slot === slot);
  const base = pool.length ? r.pick(pool) : BASE_ITEM_TYPES[0];
  const rarity = normalizeRarity(opts.rarity || 'normal');
  /** @type {Array<{text:string, stats:Object}>} */
  const mods = [];
  const affixCount = rarity === 'magic' ? r.int(1, 2) : rarity === 'rare' ? r.int(3, 4) : rarity === 'unique' ? r.int(2, 3) : 0;
  const used = new Set();
  for (let i = 0; i < affixCount; i++) {
    let affix = null;
    for (let tries = 0; tries < 8; tries++) {
      const cand = r.pick(AFFIX_POOL);
      if (!used.has(cand.id)) { affix = cand; break; }
    }
    if (!affix) continue;
    used.add(affix.id);
    const v = affix.roll(r, level);
    mods.push({ id: affix.id, text: affix.text(v), stats: affix.apply(v) });
  }
  if (rarity === 'unique') {
    const lg = r.pick(LEGENDARY_AFFIXES);
    mods.push({ id: lg.id, text: lg.text, stats: { ...lg.stats } });
  }
  const item = finalizeItem({
    id: nextId('item'),
    baseName: base.name,
    name: base.name,
    slot,
    icon: base.icon,
    rarity,
    level,
    ilvl: level,
    mods,
    stats: sumStats([base.base, ...mods.map((m) => m.stats)]),
  });
  return item;
}

/**
 * 汇总属性对象（线性相加）
 * @param {Array<Object>} list
 */
function sumStats(list) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const s of list) {
    if (!s) continue;
    for (const k in s) {
      if (typeof s[k] === 'number') out[k] = (out[k] || 0) + s[k];
    }
  }
  return out;
}

/** 属性字段 → 中文名（UI 显示用） */
export const STAT_TEXT = Object.freeze({
  life: '最大生命', mana: '最大法力', manaRegen: '法力回复/秒', lifeRegen: '生命回复/秒',
  energyShield: '能量护盾', armor: '护甲', evasion: '闪避率', blockChance: '格挡率',
  dmgMin: '最小伤害', dmgMax: '最大伤害', attackSpeedMult: '攻击速度', critChance: '暴击率',
  critMulti: '暴击伤害', moveSpeedMult: '移动速度', physDamageMult: '物理伤害',
  addedFireMin: '附加火焰(下)', addedFireMax: '附加火焰(上)',
  addedColdMin: '附加冰霜(下)', addedColdMax: '附加冰霜(上)',
  addedLightningMin: '附加闪电(下)', addedLightningMax: '附加闪电(上)',
  fireResist: '火焰抗性', coldResist: '冰霜抗性', lightningResist: '闪电抗性', chaosResist: '混沌抗性',
  lifeLeech: '生命吸取', lifeOnHit: '击中回复', aoeMult: '范围效果', areaDamageMult: '范围伤害',
  cdrMult: '冷却缩减', thorns: '荆棘', damageMult: '所有伤害', dotMult: '持续伤害',
  projectileSpeedMult: '投射物速度', skillLevelBonus: '技能等级', maxResistance: '抗性上限',
  physAddedMin: '附加物理(下)', physAddedMax: '附加物理(上)',
  fireDamageMult: '火焰伤害', coldDamageMult: '冰霜伤害', lightningDamageMult: '闪电伤害', chaosDamageMult: '混沌伤害',
  damageTakenMult: '承受伤害',
});

/** 百分比类字段 */
const PCT_KEYS = new Set([
  'evasion', 'blockChance', 'attackSpeedMult', 'moveSpeedMult', 'physDamageMult', 'fireDamageMult',
  'coldDamageMult', 'lightningDamageMult', 'chaosDamageMult', 'critChance', 'critMulti', 'aoeMult',
  'cdrMult', 'lifeLeech', 'areaDamageMult', 'damageMult', 'damageTakenMult', 'dotMult',
  'fireResist', 'coldResist', 'lightningResist', 'chaosResist', 'maxResistance', 'projectileSpeedMult',
]);

/**
 * 把属性对象格式化为中文文本行（UI 显示）。会跳过 0 值。
 * @param {Record<string,number>} stats
 * @returns {string[]}
 */
export function statsToText(stats) {
  const lines = [];
  if (!stats) return lines;
  // 附加伤害合并显示
  const merge = [
    ['addedFireMin', 'addedFireMax', '附加火焰伤害'],
    ['addedColdMin', 'addedColdMax', '附加冰霜伤害'],
    ['addedLightningMin', 'addedLightningMax', '附加闪电伤害'],
    ['physAddedMin', 'physAddedMax', '附加物理伤害'],
  ];
  const handled = new Set();
  for (const [a, b, label] of merge) {
    if (stats[a] || stats[b]) {
      const lo = Math.round(stats[a] || 0);
      const hi = Math.round(stats[b] || lo);
      lines.push(`附加 ${lo} - ${hi} ${label.replace('附加', '')}`);
      handled.add(a); handled.add(b);
    }
  }
  for (const k of Object.keys(stats)) {
    if (handled.has(k)) continue;
    const v = stats[k];
    if (!v) continue;
    const name = STAT_TEXT[k] || k;
    if (PCT_KEYS.has(k)) lines.push(`${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}% ${name}`);
    else if (k === 'lifeRegen' || k === 'manaRegen') lines.push(`${v > 0 ? '+' : ''}${fmt(Math.round(v * 10) / 10)} ${name}`);
    else lines.push(`${v > 0 ? '+' : ''}${fmt(Math.round(v))} ${name}`);
  }
  return lines;
}

/**
 * 给物品补齐显示字段（rarityName / color / statsText / 稀有度前缀名）。
 * 所有物品（内置或来自 items 模块）都会经过这里，保证 UI 一定能显示。
 * @param {Object} item
 * @returns {Object} 同一个对象（就地补全）
 */
export function finalizeItem(item) {
  if (!item) return item;
  if (!item.id) item.id = nextId('item');
  // 稀有度归一：兼容 items 模块的 'unique' 与旧写法的 'legendary'
  item.rarity = normalizeRarity(item.rarity || 'normal');
  item.rarityName = RARITY_NAMES[item.rarity] || item.rarity;
  item.color = item.color || RARITY_COLORS[item.rarity] || RARITY_COLORS.normal;
  if (!item.level) item.level = 1;
  if (!item.ilvl) item.ilvl = item.level;
  if (!Array.isArray(item.mods)) item.mods = [];
  item.mods = item.mods.map((m) => {
    if (!m || typeof m !== 'object') return { text: String(m), stats: {} };
    const stats = m.stats && typeof m.stats === 'object' ? m.stats : {};
    let text = m.text;
    if (!text) {
      const lines = statsToText(stats);
      text = lines.join('，') || '—';
    }
    return { ...m, stats, text };
  });
  if (!item.slot) item.slot = 'weapon';
  item.slotName = item.slotName || SLOT_NAMES[item.slot] || item.slot;
  if (!item.stats || typeof item.stats !== 'object') {
    item.stats = sumStats([item.base || {}, ...item.mods.map((m) => m.stats)]);
  }
  if (!item.icon) item.icon = '❔';
  if (!item.baseName) item.baseName = item.name || SLOT_NAMES[item.slot] || '未知物品';
  if (!item.name) item.name = item.baseName;
  item.displayName = item.displayName || item.name;
  item.statsText = Array.isArray(item.statsText) ? item.statsText : statsToText(item.stats);
  return item;
}

/** items 模块的动态导入缓存（避免每帧尝试） */
let _itemGenModule = undefined;

/**
 * 尝试拿到 items 模块的 generateDrop。返回 null 表示不可用（不抛错）。
 * @returns {Promise<Function|null>}
 */
async function loadItemsModule() {
  if (_itemGenModule !== undefined) return _itemGenModule;
  _itemGenModule = null;
  try {
    const mod = await import('../items/itemgen.js');
    if (mod && typeof mod.generateDrop === 'function') _itemGenModule = mod.generateDrop;
  } catch {
    _itemGenModule = null;
  }
  return _itemGenModule;
}

/**
 * 预加载 items 模块（可选，Lead 在启动时可 await）。失败静默。
 * @returns {Promise<boolean>}
 */
export async function primeItemGen() {
  return !!(await loadItemsModule());
}

/** 记录动态模块是否已尝试加载（避免每次调用都走 await） */
let _triedDynamic = false;

/**
 * 生成一件物品：优先 world.itemGen.generateDrop，其次已加载的 items 模块，最后内置表。
 * 注意：动态 import 是异步的，首次调用时若模块尚未加载会同步返回内置物品，
 * 之后（下一件掉落起）自动使用 items 模块。Lead 可在初始化时 await primeItemGen() 提前加载。
 *
 * @param {Object} world
 * @param {{level?:number, rarity?:string, slot?:string}} opts
 * @returns {Object} 已完成 finalizeItem 的物品实例
 */
export function generateItem(world, opts = {}) {
  const rng = (world && world.rng) || rngOf(null);
  const gen = world && world.itemGen && typeof world.itemGen.generateDrop === 'function' ? world.itemGen : null;
  if (gen) {
    try {
      const it = gen.generateDrop({ rng, level: opts.level || 1, rarity: opts.rarity || 'normal', slot: opts.slot });
      if (it) return finalizeItem(it);
    } catch {
      /* 回退内置表 */
    }
  }
  if (_itemGenModule) {
    try {
      const it = _itemGenModule({ rng, level: opts.level || 1, rarity: opts.rarity || 'normal', slot: opts.slot });
      if (it) return finalizeItem(it);
    } catch {
      /* 回退内置表 */
    }
  } else if (!_triedDynamic) {
    _triedDynamic = true;
    // 后台尝试加载，下一次掉落生效
    loadItemsModule();
  }
  return finalizeItem(makeBuiltinItem(rng, opts));
}

/**
 * 掷出物品稀有度（怪物稀有度 → 掉落物品稀有度）。
 * - 普通怪：2% 魔法，0.5% 稀有（契约规定，比 items 模块的全局表更"干净"）
 * - 魔法怪：12% 魔法，3% 稀有
 * - 精英(rare)：40% 魔法，8% 稀有 → 即精英必掉，且 48% 是魔法以上
 * - Boss：100% 稀有（另外单独生成传奇）
 * 返回 'normal'|'magic'|'rare'（传奇由 rollLoot 单独掷）。
 * @param {Object} rng @param {'normal'|'magic'|'rare'|'boss'} rarity
 * @param {number} [roll] 可注入的骰值（测试用）
 * @returns {'normal'|'magic'|'rare'}
 */
export function rollItemRarity(rng, rarity, roll) {
  const r = rng || rngOf(null);
  const enemy = normalizeRarity(rarity);
  const v = typeof roll === 'number' ? roll : r.next();
  if (enemy === 'boss') return 'rare';
  if (enemy === 'rare' || enemy === 'elite') {
    // [高阶掉落调整] 精英：稀有 8% → 9%，魔法 40% → 46%（普通 45%）
    if (v < 0.09) return 'rare';
    if (v < 0.55) return 'magic';
    return 'normal';
  }
  if (enemy === 'magic') {
    // [高阶掉落调整] 魔法怪：稀有 3% → 4%，魔法 12% → 16%
    if (v < 0.04) return 'rare';
    if (v < 0.20) return 'magic';
    return 'normal';
  }
  // [playtest 修复] 普通怪掉落率：原来 2.5% 魔法 + 0.5% 稀有，而 rollLoot 只在 roll !== 'normal'
  // 时才产出物品 → 实测每 100 杀只有 1 件掉落（目标 8-15 件/100 杀），玩家换装几乎停滞。
  // 现在 → 魔法 10% + 稀有 2.5%（合计 12.5%/杀）：playtest 实测 45-48 杀/分钟 → 约 5-6 件/分钟，
  // 加上精英必掉、Boss 掉落与地图「贪婪」词缀，整体落在「5-15 件/分钟」区间。
  if (v < 0.025) return 'rare';
  if (v < 0.125) return 'magic';
  return 'normal';
}

/**
 * 生成一个装备掉落并加入 world.items。
 * @param {Object} world
 * @param {number} x @param {number} z
 * @param {{level?:number, rarity?:string, slot?:string, item?:Object}} opts
 * @returns {Object} 掉落对象 {id,x,z,item,ttl,born,rarity,...}
 */
export function dropItem(world, x, z, opts = {}) {
  const rng = (world && world.rng) || rngOf(null);
  const level = opts.level || (world && world.map && world.map.level) || 1;
  const item = opts.item || generateItem(world, { level, rarity: opts.rarity || 'normal', slot: opts.slot });
  const r = 0.4;
  const drop = {
    id: nextId('drop'),
    x: x + rng.range(-r, r),
    z: z + rng.range(-r, r),
    item,
    ttl: 120,
    born: (world && world.time) || 0,
    rarity: item.rarity,
    // 渲染层可用：颜色 / 图标 / 名称
    color: item.color,
    icon: item.icon,
    name: item.name,
  };
  if (world && Array.isArray(world.items)) world.items.push(drop);
  pushWorldEvent(world, 'loot', { x: drop.x, z: drop.z, item, drop, rarity: item.rarity });
  return drop;
}

/**
 * 〔技能精炼石掉落（契约 §3.5）〕
 *
 * 往 world.items push `{ kind:'skillOrb', amount, x, z, uid, ... }`，与装备掉落同一个数组：
 *   - 由 app 的 updateAutoPickup 在 1.6 半径内吸附拾取 → inv.skillOrbs += amount 并移除；
 *   - ttl 进游戏后 180 秒消失（比装备的 120 秒长：精炼石是技能升级的唯一来源，丢了很挫败）。
 * uid 复用本模块 nextId('orb_drop') 的写法，保证全局唯一、与装备/魂火不冲突。
 *
 * 【为什么只看 entity.rarity，不看 'elite'】契约给的是"普通/魔法/稀有/Boss"四档；
 * 精英在核心里的 rarity 就是 'rare'（elite 只是它的布尔标记），所以 rare 档同时覆盖两者。
 *
 * @param {Object} world @param {Object} entity 被杀死的怪物
 * @returns {Object|null} 掉了就返回掉落对象，没掉返回 null
 */
export function rollSkillOrbDrop(world, entity) {
  if (!world || !entity) return null;
  const rng = (world && world.rng) || rngOf(null);
  const isBoss = entity.rarity === 'boss' || entity.isBoss === true;
  const rarity = isBoss ? 'boss' : entity.rarity === 'rare' || entity.elite
    ? 'rare' : entity.rarity === 'magic' ? 'magic' : 'normal';
  const chance = SKILL_ORB_DROP[rarity] != null ? SKILL_ORB_DROP[rarity] : SKILL_ORB_DROP.normal;
  const roll = rng.next();
  if (!(roll < chance)) {
    // 没掉也要把骰值推出去，便于 playtest 工具验证"实际掉落率 = 配置值"
    pushWorldEvent(world, 'skillOrbRoll', { x: entity.x, z: entity.z, rarity, chance, roll, dropped: false });
    return null;
  }
  const amount = isBoss ? SKILL_ORB_BOSS_AMOUNT : 1;
  return dropSkillOrb(world, entity.x, entity.z, amount, rarity);
}

/**
 * 直接掉一包技能精炼石（Boss / 活动奖励也可以调用）。
 * @param {Object} world @param {number} x @param {number} z @param {number} [amount=1]
 * @param {string} [rarity] 来源稀有度（渲染层按它决定光效颜色）
 * @returns {Object|null}
 */
export function dropSkillOrb(world, x, z, amount = 1, rarity = 'normal') {
  if (!world) return null;
  const rng = (world && world.rng) || rngOf(null);
  const amt = Math.max(1, Math.floor(amount) || 1);
  if (!Array.isArray(world.items)) world.items = [];
  const drop = {
    kind: 'skillOrb',
    id: nextId('orb_drop'),
    uid: nextId('orb_drop'),
    amount: amt,
    x: x + rng.range(-0.9, 0.9),
    z: z + rng.range(-0.9, 0.9),
    ttl: 180,
    born: (world && world.time) || 0,
    fromRarity: rarity,
    // 渲染层可用：颜色 / 图标 / 名称（技能精炼石是紫色菱形）
    color: '#c58bff',
    icon: '💎',
    name: '技能精炼石',
    rarity: 'magic',
  };
  world.items.push(drop);
  pushWorldEvent(world, 'skillOrbDrop', {
    x: drop.x, z: drop.z, drop, amount: amt, rarity: drop.rarity, fromRarity: rarity, color: drop.color,
  });
  return drop;
}

/**
 * 判断 world.items 里的一个元素是不是技能精炼石（装备掉落没有 kind 字段）。
 * @param {Object} d
 * @returns {boolean}
 */
export function isSkillOrbDrop(d) {
  return !!d && d.kind === 'skillOrb' && !d.item;
}

/**
 * 怪物死亡掉落。稀有度规则见 rollItemRarity。
 * 返回生成的掉落物数组（也用于测试）。注意：技能精炼石不在返回值里（它是独立奖励通道），
 * 但仍然会写进 world.items。
 * @param {Object} world @param {Object} monster
 * @returns {Array<Object>}
 */
export function rollLoot(world, monster) {
  const out = [];
  if (!world || !monster) return out;
  const rng = (world && world.rng) || rngOf(null);
  const lvl = monster.level || (world.map && (world.map.level || world.map.tier)) || 1;
  const rarity = normalizeRarity(monster.rarity || 'normal');

  // 技能精炼石：所有怪物都掷一次（Boss 必掉 3 个），与下面的装备掉落互不影响
  rollSkillOrbDrop(world, monster);

  if (rarity === 'boss') {
    // Boss：必掉 2 稀有 + 1 必定暗金（另有 35% 几率再掉一件暗金）+ 一堆魂火
    for (let i = 0; i < 2; i++) out.push(dropItem(world, monster.x, monster.z, { level: lvl, rarity: 'rare' }));
    out.push(dropItem(world, monster.x, monster.z, { level: lvl, rarity: 'unique' }));
    if (rng.chance(0.35)) out.push(dropItem(world, monster.x, monster.z, { level: lvl, rarity: 'unique' }));
    dropOrbs(world, monster.x, monster.z, 'gold', 12);
    dropOrbs(world, monster.x, monster.z, 'xp', 6);
    dropOrbs(world, monster.x, monster.z, 'orb', 4);
    return out;
  }

  const enemy = rarity === 'rare' || monster.elite ? 'rare' : rarity === 'magic' ? 'magic' : 'normal';
  const roll = rollItemRarity(rng, enemy);
  // 地图词缀 itemQuantity（+物品数量）会额外给一次掉落机会
  const iq = readItemQuantity(world);
  if (enemy === 'rare') {
    // 精英必掉 1 件：稀有度按 rollItemRarity 分布（9% 稀有 / 46% 魔法 / 其余普通）
    out.push(dropItem(world, monster.x, monster.z, { level: lvl, rarity: roll }));
  } else if (roll !== 'normal') {
    out.push(dropItem(world, monster.x, monster.z, { level: lvl, rarity: roll }));
  } else if (iq > 0 && rng.chance(Math.min(0.5, iq * 0.15))) {
    out.push(dropItem(world, monster.x, monster.z, { level: lvl, rarity: rollItemRarity(rng, enemy) }));
  }
  if (iq > 0 && rng.chance(Math.min(0.35, iq * 0.1))) {
    out.push(dropItem(world, monster.x, monster.z, { level: lvl, rarity: 'magic' }));
  }

  // 暗金独立掉落：与上面的普通装备掉落互不影响；精英 / 高等级地图概率更高，
  // 地图「物品数量」词缀也会按比例放大暗金机会（上限 15%）。
  const uniqueChance = Math.min(0.15, uniqueDropChance(enemy, lvl) * (1 + Math.max(0, iq)));
  if (uniqueChance > 0 && rng.chance(uniqueChance)) {
    out.push(dropItem(world, monster.x, monster.z, { level: lvl, rarity: 'unique' }));
  }

  // 魂火（经验/金钱）
  const goldCount = rarity === 'rare' ? rng.int(2, 4) : rarity === 'magic' ? rng.int(1, 2) : rng.chance(0.55) ? 1 : 0;
  if (goldCount) dropOrbs(world, monster.x, monster.z, 'gold', goldCount);
  if (rarity === 'rare' || (monster.elite && enemy === 'rare')) dropOrbs(world, monster.x, monster.z, 'life', rng.int(1, 2));
  if (rarity === 'magic' && rng.chance(0.3)) dropOrbs(world, monster.x, monster.z, 'orb', 1);
  return out;
}

/**
 * 读取地图词缀的物品数量加成（world.mapMods.itemQuantity，0.8 = +80%）。
 * @param {Object} world
 * @returns {number}
 */
export function readItemQuantity(world) {
  const src = world && (world.mapMods || (world.map && world.map.mapMods));
  if (!src || typeof src !== 'object') return 0;
  const v = src.itemQuantity;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 掉落"魂火"拾取物（world.lootOrbs 由 Lead 管理，但这里负责写入与事件）。
 * kind: 'gold' 金钱 | 'xp' 经验 | 'life' 回血 | 'orb' 回蓝
 * 拾取物结构 {id, kind, x, z, value, ttl, born, color, size}
 * @param {Object} world @param {number} x @param {number} z @param {string} kind @param {number} [count]
 * @returns {Array<Object>}
 */
export function dropOrbs(world, x, z, kind = 'gold', count = 1) {
  const out = [];
  if (!world) return out;
  const rng = (world && world.rng) || rngOf(null);
  if (!Array.isArray(world.lootOrbs)) world.lootOrbs = [];
  const meta = ORB_META[kind] || ORB_META.gold;
  const lvl = (world.map && world.map.level) || 1;
  for (let i = 0; i < count; i++) {
    const orb = {
      id: nextId('orb'),
      kind,
      x: x + rng.range(-1.1, 1.1),
      z: z + rng.range(-1.1, 1.1),
      value: kind === 'xp' ? Math.max(1, Math.round(3 + lvl * 1.5)) : meta.value(lvl, rng),
      ttl: 60,
      born: (world && world.time) || 0,
      color: meta.color,
      size: meta.size,
      name: meta.name,
    };
    world.lootOrbs.push(orb);
    out.push(orb);
  }
  pushWorldEvent(world, 'orb', { x, z, kind, count, color: meta.color });
  return out;
}

/** 魂火类型元数据 */
const ORB_META = Object.freeze({
  gold: { color: '#ffd34d', size: 0.35, name: '金币', value: (lvl, r) => r.int(2, 5) + Math.floor(lvl * 0.8) },
  xp: { color: '#8be8ff', size: 0.4, name: '经验魂火', value: (lvl) => Math.max(1, Math.round(3 + lvl * 1.5)) },
  life: { color: '#ff5a5a', size: 0.45, name: '生命魂火', value: (lvl, r) => r.int(10, 18) + lvl * 3 },
  orb: { color: '#5a8bff', size: 0.45, name: '法力魂火', value: (lvl, r) => r.int(8, 14) + lvl * 2 },
});

/**
 * 拾取一个魂火（把效果应用到玩家）。
 * @param {Object} world @param {Object} player @param {Object} orb
 * @returns {boolean}
 */
export function collectOrb(world, player, orb) {
  if (!orb || !player || player.dead) return false;
  if (orb.collected) return false;
  orb.collected = true;
  if (orb.kind === 'gold') player.gold = (player.gold || 0) + orb.value;
  else if (orb.kind === 'xp') {
    if (world && typeof world.__grantXp === 'function') world.__grantXp(world, player, orb.value);
    else player.xp = (player.xp || 0) + orb.value;
  } else if (orb.kind === 'life') {
    player.hp = Math.min(player.maxHp, player.hp + orb.value);
    pushWorldEvent(world, 'heal', { x: player.x, z: player.z, amount: orb.value, target: player, kind: 'orb' });
  } else if (orb.kind === 'orb' || orb.kind === 'mana') {
    player.mp = Math.min(player.maxMp, player.mp + orb.value);
  }
  pushWorldEvent(world, 'orbPick', { x: orb.x, z: orb.z, kind: orb.kind, value: orb.value, orb });
  return true;
}

/**
 * 拾取最近的可拾取物（魂火或装备掉落），返回该对象但不移除。
 * 装备掉落对象形如 { id, x, z, item, ttl, born }；魂火形如 { id, kind, x, z, value }。
 * 技能精炼石形如 { kind:'skillOrb', amount, x, z, uid }，返回 type: 'skillOrb'。
 * 用 kind 字段区分：魂火有 kind，装备掉落没有（用 item 判断）。
 * @param {Object} world @param {Object} player
 * @param {number} [radius=1.6]
 * @returns {{type:'item'|'orb'|'skillOrb', drop:Object, dist:number}|null}
 */
export function pickupNearest(world, player, radius = 1.6) {
  if (!world || !player) return null;
  let best = null;
  let bestD = radius * radius;
  const consider = (list, type) => {
    if (!Array.isArray(list)) return;
    for (const o of list) {
      if (!o || o.collected || o.removed) continue;
      const dx = o.x - player.x, dz = o.z - player.z;
      const d = dx * dx + dz * dz;
      if (d <= bestD) { bestD = d; best = { type, drop: o, dist: Math.sqrt(d) }; }
    }
  };
  consider(world.lootOrbs, 'orb');
  // 技能精炼石不是"装备"，但核心的通用拾取查询也应该能看见它（type: 'skillOrb'）。
  // 装备掉落保持 type: 'item'，老调用方零改动。
  consider(Array.isArray(world.items) ? world.items.filter(isSkillOrbDrop) : [], 'skillOrb');
  consider(Array.isArray(world.items) ? world.items.filter((d) => d && !isSkillOrbDrop(d)) : [], 'item');
  return best;
}

/**
 * 清理过期的拾取物（ttl）。由 updateCore 调用。
 * @param {Object} world @param {number} dt
 */
export function updateLootTtl(world, dt) {
  if (!world) return;
  if (Array.isArray(world.items)) {
    for (let i = world.items.length - 1; i >= 0; i--) {
      const d = world.items[i];
      if (!d) { world.items.splice(i, 1); continue; }
      d.ttl -= dt;
      if (d.ttl <= 0) {
        d.removed = true;
        world.items.splice(i, 1);
        pushWorldEvent(world, 'lootGone', { x: d.x, z: d.z, drop: d });
      }
    }
  }
  if (Array.isArray(world.lootOrbs)) {
    for (let i = world.lootOrbs.length - 1; i >= 0; i--) {
      const o = world.lootOrbs[i];
      if (!o) { world.lootOrbs.splice(i, 1); continue; }
      o.ttl -= dt;
      if (o.ttl <= 0) {
        o.removed = true;
        world.lootOrbs.splice(i, 1);
      }
    }
  }
}

/** 注册到 world 上的钩子（index.createWorldHooks 会用） */
export function installLootHooks(world) {
  if (!world) return;
  world.__rollLoot = rollLoot;
}