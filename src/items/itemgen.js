// @file src/items/itemgen.js
// 物品生成核心接口（core-dev 的 loot.js 与 Lead 的 inventory / UI 都依赖这里）。
//
// 【硬约束】纯逻辑，不 import 浏览器 API / three / DOM。
// 所有函数都是同步的，generateDrop 内部有 try/catch 兜底（任何异常都会返回一件合法的普通物品）。
//
// 导出：
//   generateItem({ rng, level, rarity, slot, baseId, forceUnique }) → 物品实例
//   generateDrop({ rng, level, rarity, slot, rarityBonus })        → 物品实例（core 的 loot 调用）
//   rerollItem(rng, item)                                          → 重掷词缀后的新物品
//   itemStatLines(item)                                            → [{ text, color }] / [{ line, color }]
//   itemScore(item)                                                → 战力估算（数字）
//   itemToTooltipHTML(item, compare)                               → 纯字符串 HTML（无 DOM）
//
// ──────────────── 物品实例结构 ────────────────
// {
//   uid, baseId, name, slot, slotName, baseSlot, baseName, typeName,
//   rarity, rarityName, color, itemLevel, levelReq, icon, tier,
//   dmgMin, dmgMax, damage: { min, max, avg, dps, element },   // 仅武器
//   stats: { ...合并后的数值 }（不含武器伤害键；武器伤害见 dmgMin/dmgMax）
//   implicit: { text, stats },
//   mods: [{ id, name, text, stats, tier, prefix }],
//   affixLines: [{ text, color }],   // 传奇说明行 + implicit + 词缀（UI 直接用）
//   unique, flavor?, influence?,     // 传奇才有的字段
//   legendaryEffect?, effectStats?   // 传奇效果
// }

import { getRNG, uid as makeUid, escapeHTML, fmt, STAT_KEYS } from './common.js';
import {
  BASE_ITEMS, BASE_BY_ID, SLOTS, SLOT_NAMES, SLOT_ACCEPTS, BASE_SLOT_NAMES, ITEM_SLOTS, ITEM_SLOT_NAMES,
  pickBase, basesForEquipSlot,
} from './bases.js';
import { rollAffixes, affixById } from './affixes.js';
import { RARITY, rollRarity, rarityName, rarityColor, rollAffixCount } from './rarity.js';
import { tryUnique, UNIQUES, UNIQUE_BY_ID } from './unique.js';

/**
 * 判断某个装备格子 / 物品 slot 是否能放下某基底（用于传奇与指定槽位冲突时的二次筛选）。
 * @param {string} slot 装备格子或物品 slot
 * @param {string} baseId 基底 id
 * @returns {boolean}
 */
function slotAccepts(slot, baseId) {
  const base = BASE_BY_ID[baseId];
  if (!base) return false;
  if (ITEM_SLOTS.includes(slot)) return base.slot === slot;
  const accepts = SLOT_ACCEPTS[slot];
  return !!accepts && accepts.includes(base.slot);
}

/** 武器伤害相关的键（由 itemgen 合成到 dmgMin / dmgMax / damage 上，不进入 stats）。 */
const WEAPON_DAMAGE_KEYS = new Set([
  'dmgMin', 'dmgMax', 'physAddedMin', 'physAddedMax', 'addedFireMin', 'addedFireMax',
  'addedColdMin', 'addedColdMax', 'addedLightningMin', 'addedLightningMax',
]);

/** 百分比显示用的键（tooltip 里显示为 +x%）。 */
const PERCENT_DISPLAY = new Set([
  'evasion', 'blockChance', 'attackSpeedMult', 'critChance', 'critMulti', 'moveSpeedMult',
  'physDamageMult', 'fireDamageMult', 'coldDamageMult', 'lightningDamageMult', 'chaosDamageMult',
  'aoeMult', 'lifeLeech', 'cdrMult', 'areaDamageMult', 'dotMult', 'projectileSpeedMult',
  'damageMult', 'damageTakenMult', 'maxResistance', 'fireResist', 'coldResist', 'lightningResist',
  'chaosResist', 'rarityBonus', 'xpBonus', 'quantityBonus', 'goldFind',
]);

/** 显示用名字：统计键 → 中文。 */
const STAT_ZH = {
  life: '生命', lifeRegen: '生命回复', mana: '法力', manaRegen: '法力回复', energyShield: '能量护盾',
  armor: '护甲', evasion: '闪避率', blockChance: '格挡几率', attackSpeedMult: '攻击速度',
  critChance: '暴击率', critMulti: '暴击伤害加成', moveSpeedMult: '移动速度',
  physDamageMult: '物理伤害', fireDamageMult: '火焰伤害', coldDamageMult: '冰霜伤害',
  lightningDamageMult: '闪电伤害', chaosDamageMult: '混沌伤害', aoeMult: '范围效果',
  areaDamageMult: '范围伤害', dotMult: '持续伤害', skillLevelBonus: '技能等级',
  lifeLeech: '生命偷取', lifeOnHit: '击中回复', cdrMult: '冷却缩减', thorns: '荆棘反弹',
  projectileSpeedMult: '投射物速度', damageMult: '全局伤害', damageTakenMult: '承受伤害',
  maxResistance: '元素抗性上限', fireResist: '火焰抗性', coldResist: '冰霜抗性',
  lightningResist: '闪电抗性', chaosResist: '混沌抗性', rarityBonus: '物品稀有度',
  xpBonus: '获得经验', quantityBonus: '物品数量', goldFind: '硫磺碎片掉落',
};

/** 词缀颜色（POE 风格）：前缀偏蓝紫、后缀偏青绿、词缀行统一浅色。 */
const MOD_COLOR = '#8fa8ff';
const IMPLICIT_COLOR = '#a8a8d8';
const UNIQUE_LINE_COLOR = '#d0a060';

/**
 * 稀有度 → 名字颜色。
 * @param {string} rarity
 * @returns {string}
 */
function colorOf(rarity) {
  return rarityColor(rarity);
}

/**
 * 把数值映射成中文词缀文本（用于传奇 extraLines 之外、程序化合并的 stats）。
 * @param {string} key
 * @param {number} v
 * @returns {string}
 */
export function statLineText(key, v) {
  const name = STAT_ZH[key] || key;
  const sign = v >= 0 ? '+' : '';
  if (PERCENT_DISPLAY.has(key)) return `${sign}${Math.round(v * 1000) / 10}% ${name}`;
  if (key === 'lifeRegen' || key === 'manaRegen') return `每秒回复 ${Math.round(v * 10) / 10} 点${key === 'lifeRegen' ? '生命' : '法力'}`;
  if (key === 'thorns') return `反弹 ${Math.round(v)} 点伤害`;
  if (key === 'lifeLeech') return `攻击伤害的 ${Math.round(v * 1000) / 10}% 转化为生命`;
  if (key === 'lifeOnHit') return `击中时回复 ${Math.round(v)} 点生命`;
  return `${sign}${Math.round(v)} ${name}`;
}

/**
 * 把 stats 对象转成中文行（按 STAT_KEYS 的显示顺序 + 额外键）。
 * @param {Object<string, number>} stats
 * @returns {string[]}
 */
function statsToLines(stats) {
  if (!stats) return [];
  const out = [];
  const seen = new Set();
  const order = [...STAT_KEYS, 'rarityBonus', 'xpBonus', 'quantityBonus', 'goldFind'];
  for (const k of order) {
    const v = stats[k];
    if (typeof v !== 'number' || v === 0) continue;
    if (WEAPON_DAMAGE_KEYS.has(k)) continue;
    seen.add(k);
    out.push(statLineText(k, v));
  }
  for (const k in stats) {
    if (seen.has(k)) continue;
    const v = stats[k];
    if (typeof v !== 'number' || v === 0) continue;
    out.push(statLineText(k, v));
  }
  return out;
}

/**
 * 按物品等级与基底阶位掷武器基础伤害。
 *
 * 曲线：base × (1 + 0.11 × (level - 1)) × (1 + 0.06 × (tier - 1))
 * 让「裂骨战斧」这类高阶基底在 20 级时明显强于 1 级短剑，但不会离谱。
 * @param {{baseStats: Object<string, number>, tier: number}} base
 * @param {number} level 物品等级
 * @returns {{dmgMin: number, dmgMax: number}}
 */
export function rollWeaponDamage(base, level) {
  const lv = Math.max(1, level || 1);
  const tier = base.tier || 1;
  const scale = (1 + 0.11 * (lv - 1)) * (1 + 0.06 * (tier - 1));
  const lo = Math.max(1, Math.round((base.baseStats.dmgMin || 5) * scale));
  const hi = Math.max(lo + 1, Math.round((base.baseStats.dmgMax || 8) * scale));
  return { dmgMin: lo, dmgMax: hi };
}

/**
 * 合并若干 stats 对象（数值相加）。
 * @param {Array<Object<string, number>|null|undefined>} layers
 * @returns {Object<string, number>}
 */
export function mergeStats(layers) {
  /** @type {Object<string, number>} */
  const out = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const k in layer) {
      const v = layer[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      out[k] = (out[k] || 0) + v;
    }
  }
  // 取整 / 保留 3 位小数
  for (const k in out) {
    const v = out[k];
    out[k] = Math.abs(v) >= 5 ? Math.round(v) : Math.round(v * 1000) / 1000;
  }
  return out;
}

/**
 * 稀有物品的中文名前缀组合（POE 里是两段随机名，这里拼成「残暴之魂的护甲」这种感觉）。
 * @param {{next:()=>number, pick:(a:string[])=>string}} rng
 * @param {string} baseName
 * @returns {string}
 */
function rareName(rng, baseName) {
  const A = ['残暴', '深渊', '炽焰', '寒霜', '雷霆', '毁灭', '嗜血', '钢铁', '虚空', '黎明',
    '永夜', '战王', '斩魂', '怒火', '禁忌', '灼魂', '风暴', '碎石', '古神', '终末'];
  const B = ['之魂', '之影', '之契', '之怒', '之罪', '之誓', '之泣', '之刃', '之息', '之殇'];
  const C = ['护甲', '战装', '诡物', '遗物', '神兵', '圣契', '凶器', '信物'];
  const a = rng.pick(A);
  const b = rng.pick(B);
  const c = baseName ? baseName.slice(-2) : rng.pick(C);
  // 「残暴之魂」+「战斧」→ 残暴之魂的战斧
  const tail = c.length >= 2 ? c : rng.pick(C);
  return `${a}${b}的${tail}`;
}

/**
 * 魔法物品名字：前缀名 + 基底名 (+ 后缀名)。
 * @param {Array<{name:string, prefix:boolean}>} mods
 * @param {string} baseName
 * @returns {string}
 */
function magicName(mods, baseName) {
  const pre = mods.find((m) => m.prefix);
  const suf = mods.find((m) => !m.prefix);
  if (pre && suf) return `${pre.name}${baseName}${suf.name}`;
  if (pre) return `${pre.name}${baseName}`;
  if (suf) return `${baseName}${suf.name}`;
  return baseName;
}

/**
 * 生成物品实例（核心函数）。
 *
 * @param {Object} [opts]
 * @param {any} [opts.rng] 随机源（RNG 实例 / next 函数 / 种子）；缺省用随机种子
 * @param {number} [opts.level=1] 物品等级
 * @param {'normal'|'magic'|'rare'|'unique'|null} [opts.rarity=null] 稀有度；null 则按概率掷
 * @param {string|null} [opts.slot=null] 装备槽位（weapon/offhand/helmet/body/gloves/boots/ring1/ring2/amulet/belt）
 * @param {string|null} [opts.baseId=null] 指定基底 id（优先于 slot）
 * @param {boolean} [opts.forceUnique=false] 强制传奇（有等级合适的传奇时）
 * @param {string|null} [opts.uniqueId=null] 指定传奇 id（调试 / 商人用）
 * @param {number} [opts.rarityBonus=0] 稀有度提升（0.5 = +50%），影响 rarity 为 null 时的掷骰
 * @returns {Object} 物品实例
 */
export function generateItem({
  rng = null, level = 1, rarity = null, slot = null, baseId = null, forceUnique = false,
  uniqueId = null, rarityBonus = 0,
} = {}) {
  const r = getRNG(rng);
  const ilvl = Math.max(1, Math.floor(Number(level) || 1));

  // 1) 稀有度
  /** @type {string} */
  let rar = rarity && RARITY[rarity] ? rarity : rollRarity(r, 1 + Math.max(0, Number(rarityBonus) || 0));
  if (forceUnique || uniqueId) rar = 'unique';

  // 2) 基底
  //    slot 既可以传物品 slot（weapon / shield / ring …），也可以传装备格子（offhand / ring1 / ring2 …）；
  //    pickBase 内部只会从该类型允许的基底里挑，因此 slot:'ring' 一定产出戒指。
  /** @type {any} */
  let base = null;
  if (baseId && BASE_BY_ID[baseId]) base = BASE_BY_ID[baseId];
  else if (slot && (SLOT_ACCEPTS[slot] || ITEM_SLOTS.includes(slot))) base = pickBase(r, slot, ilvl);
  else base = BASE_BY_ID[BASE_ITEMS[Math.floor(r.next() * BASE_ITEMS.length)].id];

  // 3) 传奇：改用传奇专属基底（必须与指定槽位类型匹配，避免「指定 body 却掉出靴子」）
  /** @type {any} */
  let unique = null;
  if (rar === 'unique') {
    if (uniqueId && UNIQUE_BY_ID[uniqueId]) {
      unique = UNIQUE_BY_ID[uniqueId];
    } else if (slot) {
      // 指定了槽位：只在该槽位能放的传奇里抽；该槽位没有传奇定义时，退化为同类型的稀有物品
      const fits = UNIQUES.filter((u) => slotAccepts(slot, u.baseId));
      if (fits.length) unique = tryUnique(r, ilvl, (u) => slotAccepts(slot, u.baseId));
      else rar = 'rare';
    } else {
      unique = tryUnique(r, ilvl);
    }
    if (unique) base = BASE_BY_ID[unique.baseId] || base;
  }

  // 4) 武器伤害
  const isWeapon = base.slot === 'weapon';
  let dmgMin = 0;
  let dmgMax = 0;
  if (isWeapon) {
    const d = rollWeaponDamage(base, ilvl);
    dmgMin = d.dmgMin;
    dmgMax = d.dmgMax;
  }

  // 5) 词缀（传奇用固定 stats）
  /** @type {Array<{id:string,name:string,text:string,stats:Object<string, number>,tier:number,prefix:boolean}>} */
  const mods = unique ? [] : rollAffixes(r, ilvl, /** @type {any} */ (rar), base.slot, base);

  // 6) 合并 stats：基底 + 传奇 + 词缀（武器伤害单独算）
  /** @type {Object<string, number>} */
  let stats = mergeStats([
    baseStatsForItem(base),
    unique ? unique.stats : null,
    ...mods.map((m) => m.stats),
  ]);

  // 7) 武器伤害合成：物理% 放大基础伤害，附加伤害另计
  if (isWeapon) {
    stats = applyWeaponDamage(stats, rar);
  }

  // 8) 名字 & 稀有度元数据
  const lvReq = Math.max(1, base.levelReq || 1);
  /** @type {string} */
  let name;
  if (rar === 'unique' && unique) name = unique.name;
  else if (rar === 'rare') name = rareName(r, base.name);
  else if (rar === 'magic') name = magicName(mods, base.name);
  else name = base.name;

  const color = colorOf(rar);
  const item = {
    uid: makeUid('itm'),
    baseId: base.id,
    name,
    slot: equipSlotFor(base.slot),
    slotName: '',
    baseSlot: base.slot,
    baseName: base.name,
    typeName: BASE_SLOT_NAMES[base.slot] || base.slot,
    rarity: rar,
    rarityName: rarityName(rar),
    color,
    itemLevel: ilvl,
    levelReq: unique ? Math.max(lvReq, unique.levelReq || 1) : lvReq,
    icon: (unique && unique.icon) || base.icon,
    tier: base.tier,
    dmgMin: Math.round(dmgMin),
    dmgMax: Math.round(dmgMax),
    damage: isWeapon
      ? {
        min: Math.round(dmgMin),
        max: Math.round(dmgMax),
        avg: Math.round(((dmgMin + dmgMax) / 2) * 10) / 10,
        dps: Math.round((((dmgMin + dmgMax) / 2) * (base.aspd || 1)) * 10) / 10,
        element: base.element || 'phys',
      }
      : null,
    stats,
    implicit: { text: base.implicit.text, stats: { ...base.implicit.stats } },
    mods,
    affixLines: [],
    tags: base.tags ? base.tags.slice() : [],
    unique: null,
    influence: influenceFor(ilvl),
  };
  item.slotName = ITEM_SLOT_NAMES[item.slot] || SLOT_NAMES[item.slot] || item.typeName;

  if (unique) {
    item.unique = unique.id;
    item.name = unique.name;
    item.flavor = unique.flavor;
    item.uniqueAffixText = unique.uniqueAffixText;
    item.legendaryEffect = unique.legendaryEffect || null;
    item.effectStats = unique.effectStats || null;
    item.extraLines = (unique.extraLines || []).slice();
  }

  item.affixLines = buildAffixLines(item);
  return item;
}

/**
 * 物品 stats 使用的基底数值：武器的 dmgMin/dmgMax 已由 rollWeaponDamage 折算到 item.dmgMin/dmgMax，
 * 这里剔除它们，避免 Stats 里出现重复的武器伤害。
 * @param {{baseStats: Object<string, number>}} base
 * @returns {Object<string, number>}
 */
function baseStatsForItem(base) {
  /** @type {Object<string, number>} */
  const out = {};
  for (const k in base.baseStats) {
    if (k === 'dmgMin' || k === 'dmgMax') continue;
    out[k] = base.baseStats[k];
  }
  return out;
}

/**
 * 武器伤害合成到 stats：物理% 放大基础伤害；附加伤害留在 stats 里由战斗读取。
 * 这里同时把结果写回（stats 不含 dmgMin/dmgMax，武器伤害由 item.dmgMin/dmgMax 表示）。
 * @param {Object<string, number>} stats
 * @param {string} rarity
 * @returns {Object<string, number>}
 */
function applyWeaponDamage(stats, rarity) {
  const physPct = 1 + (stats.physDamageMult || 0);
  // 武器自身 item.dmgMin/dmgMax 在 generateItem 里另算，这里只把「附加物理伤害」
  // 折算进 stats.physAdded，避免物理% 被重复计算。
  const pMin = stats.physAddedMin || 0;
  const pMax = stats.physAddedMax || 0;
  if (pMin || pMax) {
    stats.physAddedMin = Math.max(1, Math.round(pMin * physPct));
    stats.physAddedMax = Math.max(stats.physAddedMin + 1, Math.round(pMax * physPct));
  }
  void rarity;
  return stats;
}

/**
 * 基底 slot → 物品 slot。
 *
 * 重要约定（与 Lead 的 src/game/inventory.js 一致）：
 *   · 物品自身的 slot 是「物品类型」：weapon / shield / helmet / body / gloves / boots / ring / amulet / belt
 *   · 装备槽位（ring1 / ring2 / offhand …）只是 UI 上的格子，由 Lead 的 SLOT_ACCEPTS 决定：
 *     ring1/ring2 接受 slot === 'ring'，offhand 接受 slot === 'shield'（或 weapon）
 * 因此这里对戒指**不**再区分 ring1/ring2。
 * @param {string} baseSlot
 * @returns {string}
 */
function equipSlotFor(baseSlot) {
  return baseSlot;
}

/**
 * 按基底推断它会被放进哪个装备槽（仅供 UI 提示 / 掉落预览；戒指返回 ring1）。
 * @param {string} itemSlot
 * @returns {string}
 */
export function preferredEquipSlot(itemSlot) {
  if (itemSlot === 'shield') return 'offhand';
  if (itemSlot === 'ring') return 'ring1';
  return itemSlot;
}

/**
 * 物品影响（influence）：高物品等级的物品有一定几率带有「火焰 / 冰霜 / 闪电 / 混沌」影响，
 * 只影响 tooltip 的显示行与名字颜色，不改变数值（保持纯展示，方便后续扩展）。
 * @param {number} ilvl
 * @returns {{name:string, color:string}|null}
 */
function influenceFor(ilvl) {
  if (ilvl < 15) return null;
  // 用 ilvl 做确定性选择（不消耗 rng，保证同名物品一致）
  const list = [
    { name: '火焰使徒的印记', color: '#ff6b3a' }, { name: '寒霜使徒的印记', color: '#5ad2ff' },
    { name: '雷霆使徒的印记', color: '#ffe45c' }, { name: '暗影使徒的印记', color: '#b07bff' },
  ];
  if (ilvl < 25) return null;
  const idx = (ilvl * 7919) % 4;
  return (ilvl % 3 === 0) ? list[idx] : null;
}

/**
 * 生成物品的属性说明行（UI tooltip / 背包使用）。
 *
 * 返回 [{ text, color }]（同时每条也带 `line` 字段，兼容 [{ line, color }] 的写法）。
 * 顺序：传奇说明行 → 物理/元素伤害行（武器）→ implicit → 词缀 → 传奇效果 → 印记。
 *
 * @param {Object} item 物品实例
 * @returns {Array<{text:string, line:string, color:string}>}
 */
export function itemStatLines(item) {
  /** @type {Array<{text:string, line:string, color:string}>} */
  const out = [];
  if (!item || typeof item !== 'object') return out;
  const push = (text, color) => out.push({ text, line: text, color });

  // 武器伤害行
  if (item.damage && item.dmgMax > 0) {
    const el = item.damage.element;
    const elColor = el === 'fire' ? '#ff7a3c' : el === 'cold' ? '#7fd4ff' : el === 'lightning' ? '#ffe45c' : '#e0e0e0';
    push(`物理/元素伤害: ${Math.round(item.dmgMin)} - ${Math.round(item.dmgMax)}`, elColor);
    push(`每秒伤害: ${fmt(item.damage.dps)}`, '#c8c8c8');
  }

  // 传奇说明行
  if (item.unique && item.extraLines) for (const l of item.extraLines) push(l, UNIQUE_LINE_COLOR);

  // implicit
  if (item.implicit && item.implicit.text) push(item.implicit.text, IMPLICIT_COLOR);

  // 词缀
  for (const m of item.mods || []) push(m.text, MOD_COLOR);

  // 传奇效果
  if (item.legendaryEffect && item.legendaryEffect.desc) push(`传奇效果：${item.legendaryEffect.desc}`, '#ff9c4a');

  // 影响印记
  if (item.influence && item.influence.name) push(`★ ${item.influence.name}`, item.influence.color);

  // 普通物品（无词缀）时，把基底自带的非武器属性也显示出来，避免 tooltip 太空
  if (!item.mods || item.mods.length === 0) {
    const lines = statsToLines(item.stats);
    for (const l of lines) push(l, '#a8a8a8');
  }
  return out;
}

/**
 * 生成 affixLines（背包 / 掉落地面上直接显示的行）。
 * @param {Object} item 物品实例
 * @returns {Array<{text:string, color:string}>}
 */
function buildAffixLines(item) {
  /** @type {Array<{text:string, color:string}>} */
  const lines = [];
  if (item.unique) {
    for (const l of item.extraLines || []) lines.push({ text: l, color: UNIQUE_LINE_COLOR });
    if (item.legendaryEffect && item.legendaryEffect.desc) {
      lines.push({ text: `传奇效果：${item.legendaryEffect.desc}`, color: '#ff9c4a' });
    }
  } else {
    if (item.implicit && item.implicit.text) lines.push({ text: item.implicit.text, color: IMPLICIT_COLOR });
    for (const m of item.mods || []) lines.push({ text: m.text, color: MOD_COLOR });
  }
  return lines;
}

/**
 * 物品战力估算（用于 UI 对比 / 怪物掉落权重）。
 *
 * - 武器：DPS 按较大权重计入
 * - 防具：护甲 / 闪避 / 生命 等按系数计入
 * - 加成百分比按各自权重计入
 *
 * @param {Object} item 物品实例
 * @returns {number} 战力分数（约 0 ~ 数千）
 */
export function itemScore(item) {
  if (!item || typeof item !== 'object') return 0;
  let s = 0;
  if (item.damage && item.damage.dps > 0) s += item.damage.dps * 2.4;
  else if (item.dmgMax > 0) s += ((item.dmgMin + item.dmgMax) / 2) * 2.4;
  const st = item.stats || {};
  const W = {
    life: 0.55, lifeRegen: 2.2, mana: 0.15, manaRegen: 1.5, energyShield: 0.5,
    armor: 0.14, evasion: 70, blockChance: 90, thorns: 0.35,
    attackSpeedMult: 55, critChance: 130, critMulti: 40, moveSpeedMult: 90,
    physDamageMult: 42, fireDamageMult: 42, coldDamageMult: 42, lightningDamageMult: 42,
    chaosDamageMult: 42, aoeMult: 50, areaDamageMult: 36, dotMult: 30,
    skillLevelBonus: 45, lifeLeech: 150, lifeOnHit: 1.2, cdrMult: 60,
    projectileSpeedMult: 6, damageMult: 45, maxResistance: 90,
    fireResist: 32, coldResist: 32, lightningResist: 32, chaosResist: 26,
    rarityBonus: 18, xpBonus: 16, quantityBonus: 16, goldFind: 6,
    addedFireMin: 0, addedFireMax: 1.6, addedColdMin: 0, addedColdMax: 1.6,
    addedLightningMin: 0, addedLightningMax: 1.6, physAddedMin: 0, physAddedMax: 1.9,
  };
  for (const k in st) {
    const v = st[k];
    if (typeof v !== 'number' || v === 0) continue;
    const w = W[/** @type {keyof typeof W} */ (k)];
    if (typeof w === 'number') s += v * w;
    else s += Math.abs(v) * 0.1;
  }
  const rar = RARITY[/** @type {any} */ (item.rarity)];
  const mult = rar ? rar.scoreMult : 1;
  const uniqBonus = item.legendaryEffect ? 1.15 : 1;
  return Math.round(s * mult * uniqBonus);
}

/**
 * 生成 tooltip HTML（纯字符串，不依赖 DOM；直接给 innerHTML 用）。
 *
 * 安全：所有字段都经过 escapeHTML 转义，因此即使数据被篡改成含 `<script>` 的文本也不会注入。
 * 传入 compare 时追加一段「对比目标」的摘要（战力差值）。
 *
 * @param {Object} item 物品实例
 * @param {Object|null} [compare=null] 对比物品（一般是当前装备）
 * @returns {string} HTML 字符串
 */
export function itemToTooltipHTML(item, compare = null) {
  if (!item || typeof item !== 'object') return '';
  const esc = escapeHTML;
  const color = colorOf(item.rarity);
  const rar = RARITY[/** @type {any} */ (item.rarity)] || RARITY.normal;
  const h = [];
  h.push(`<div class="item-tip" style="--tip-color:${esc(color)};border:1px solid ${esc(rar.border)};background:${esc(rar.bg)};padding:10px 12px;border-radius:6px;font-family:inherit;line-height:1.55;min-width:240px;max-width:360px;color:#d8d8d8">`);
  // 头部：名字 + 稀有度
  h.push(`<div class="tip-name" style="color:${esc(color)};font-size:15px;font-weight:700;letter-spacing:.5px">${esc(item.name)}</div>`);
  h.push(`<div class="tip-type" style="color:#8c8c96;font-size:12px">${esc(item.rarityName)} · ${esc(item.typeName)}${item.baseName && item.baseName !== item.name ? ' · ' + esc(item.baseName) : ''}</div>`);

  // 武器伤害
  if (item.damage && item.dmgMax > 0) {
    const el = item.damage.element;
    const elColor = el === 'fire' ? '#ff7a3c' : el === 'cold' ? '#7fd4ff' : el === 'lightning' ? '#ffe45c' : '#e8e8e8';
    h.push(`<div style="color:${elColor};font-size:13px">伤害 ${Math.round(item.dmgMin)} - ${Math.round(item.dmgMax)}</div>`);
    h.push(`<div style="color:#9a9aa4;font-size:12px">每秒伤害 ${fmt(item.damage.dps)}</div>`);
  }

  // 属性行
  const lines = itemStatLines(item);
  if (lines.length) {
    h.push('<div style="height:1px;background:#33333a;margin:6px 0"></div>');
    for (const l of lines) {
      h.push(`<div class="tip-line" style="color:${esc(l.color)};font-size:13px">${esc(l.text)}</div>`);
    }
  }

  // 传说背景
  if (item.flavor) {
    h.push('<div style="height:1px;background:#33333a;margin:6px 0"></div>');
    h.push(`<div class="tip-flavor" style="color:#9c8a70;font-style:italic;font-size:12px;line-height:1.5">${esc(item.flavor)}</div>`);
  }

  // 等级 / 需求 / 印记
  h.push('<div style="height:1px;background:#33333a;margin:6px 0"></div>');
  h.push(`<div style="color:#7a7a86;font-size:11px">物品等级 ${esc(item.itemLevel)} · 需求等级 ${esc(item.levelReq)}${item.tier ? ' · T' + esc(item.tier) : ''}</div>`);
  if (item.influence && item.influence.name) {
    h.push(`<div style="color:${esc(item.influence.color)};font-size:11px">★ ${esc(item.influence.name)}</div>`);
  }

  // 对比
  if (compare) {
    const d = itemScore(item) - itemScore(compare);
    const c = d > 0 ? '#5be07a' : d < 0 ? '#ff6b6b' : '#9a9aa4';
    h.push(`<div class="tip-compare" style="margin-top:6px;color:${c};font-size:12px">对比当前装备战力：${d > 0 ? '+' : ''}${d}（${d > 0 ? '提升' : d < 0 ? '下降' : '持平'}）</div>`);
  }

  // 战力 / uid
  h.push(`<div style="color:#5a5a64;font-size:11px;margin-top:4px">战力 ${itemScore(item)}</div>`);
  h.push('</div>');
  return h.join('');
}

/**
 * 掉落入口（core 的 loot.js 调用）。
 *
 * 约定：{ rng, level, rarity, slot, rarityBonus }，全部可选；**绝不抛异常**。
 *
 * @param {Object} [opts]
 * @param {any} [opts.rng]
 * @param {number} [opts.level=1]
 * @param {'normal'|'magic'|'rare'|'unique'|null} [opts.rarity=null]
 * @param {string|null} [opts.slot=null]
 * @param {number} [opts.rarityBonus=0]
 * @returns {Object} 物品实例
 */
export function generateDrop({ rng = null, level = 1, rarity = null, slot = null, rarityBonus = 0 } = {}) {
  try {
    const ilvl = Math.max(1, Math.floor(Number(level) || 1));
    const eqSlot = slot && (SLOT_ACCEPTS[slot] || ITEM_SLOTS.includes(slot)) ? slot : pickDropSlot(getRNG(rng));
    return generateItem({ rng: rng || undefined, level: ilvl, rarity: rarity || null, slot: eqSlot, rarityBonus });
  } catch (err) {
    // 兜底：一件合法的普通物品（不使用任何随机数，保证一定能构造）
    return fallbackItem();
  }
}

/**
 * 兜底物品（generateDrop 异常时使用）。
 * @returns {Object}
 */
export function fallbackItem() {
  const base = BASE_ITEMS[0];
  const item = {
    uid: makeUid('itm'),
    baseId: base.id,
    name: base.name,
    slot: equipSlotFor(base.slot),
    slotName: ITEM_SLOT_NAMES[base.slot] || '主手武器',
    baseSlot: base.slot,
    baseName: base.name,
    typeName: BASE_SLOT_NAMES[base.slot] || '武器',
    rarity: 'normal',
    rarityName: '普通',
    color: '#c8c8c8',
    itemLevel: 1,
    levelReq: base.levelReq,
    icon: base.icon,
    tier: base.tier,
    dmgMin: base.baseStats.dmgMin,
    dmgMax: base.baseStats.dmgMax,
    damage: {
      min: base.baseStats.dmgMin, max: base.baseStats.dmgMax,
      avg: (base.baseStats.dmgMin + base.baseStats.dmgMax) / 2,
      dps: ((base.baseStats.dmgMin + base.baseStats.dmgMax) / 2) * (base.aspd || 1),
      element: base.element || 'phys',
    },
    stats: { ...base.baseStats },
    implicit: { text: base.implicit.text, stats: { ...base.implicit.stats } },
    mods: [],
    affixLines: [{ text: base.implicit.text, color: IMPLICIT_COLOR }],
    tags: base.tags ? base.tags.slice() : [],
    unique: null,
    influence: null,
  };
  return item;
}

/**
 * 随机装备槽位（掉落用；offhand 权重低一些）。
 * @param {{next:()=>number}} rng
 * @returns {string}
 */
function pickDropSlot(rng) {
  const table = [
    { weight: 14, slot: 'weapon' }, { weight: 5, slot: 'offhand' },
    { weight: 12, slot: 'helmet' }, { weight: 12, slot: 'body' },
    { weight: 12, slot: 'gloves' }, { weight: 12, slot: 'boots' },
    { weight: 10, slot: 'ring1' }, { weight: 8, slot: 'amulet' }, { weight: 8, slot: 'belt' },
  ];
  const total = table.reduce((a, t) => a + t.weight, 0);
  let x = rng.next() * total;
  for (const t of table) {
    x -= t.weight;
    if (x <= 0) return t.slot;
  }
  return 'weapon';
}

/**
 * 重掷物品（货币系统：所有词缀重掷，稀有度不变；传奇不重掷）。
 *
 * @param {any} rng 随机源
 * @param {Object} item 原物品（不会被修改）
 * @returns {Object} 新物品实例（新 uid）
 */
export function rerollItem(rng, item) {
  if (!item || typeof item !== 'object') return generateItem({ rng, level: 1 });
  if (item.rarity === 'unique') {
    const copy = JSON.parse(JSON.stringify(item));
    copy.uid = makeUid('itm');
    return copy;
  }
  const r = getRNG(rng);
  const base = BASE_BY_ID[item.baseId] || BASE_ITEMS[0];
  const eqSlot = item.baseSlot || item.slot || equipSlotFor(base.slot);
  const next = generateItem({ rng: r, level: item.itemLevel || 1, rarity: item.rarity || 'normal', slot: eqSlot, baseId: base.id });
  // 重掷保留原 uid？按 POE 习惯物品还是同一件，保留 uid 便于 UI 定位；此处给新 uid 更安全，
  // 但保留 originalUid 方便查找
  next.originalUid = item.uid;
  return next;
}

/**
 * 按装备槽位获取候选基底列表（UI 的「重新锻造」/筛选用）。
 * @param {string} slot
 * @returns {import('./bases.js').BaseItem[]}
 */
export function basesFor(slot) {
  return basesForEquipSlot(slot);
}

export { affixById };