// @file src/items/unique.js
// 传奇（Unique）装备数据 + 传奇掉落判定。
//
// 【硬约束】纯数据 / 纯函数，不 import 浏览器 API / three / DOM。
//
// 传奇物品结构（UNIQUES 元素）：
// @typedef {Object} UniqueDef
// @property {string} id            传奇 id
// @property {string} name          传奇名字（中文）
// @property {string} baseId        对应 BASE_ITEMS 里的基底 id（决定槽位 / 图标 / 基础伤害）
// @property {number} levelReq      佩戴等级需求
// @property {string} uniqueAffixText 主附加属性文本（可以多行，用 \n 分隔）
// @property {Object<string, number>} stats 主附加属性数值（StatBlock 键 / 物品额外键）
// @property {string[]} [extraLines] 额外的中文属性行（纯展示，数值在 stats 里）
// @property {string} flavor        中文背景故事
// @property {string} icon          emoji 图标
// @property {{id:string, desc:string}} [legendaryEffect] 传奇效果（结构化，供 core 读取）
// @property {Object<string, number>} [effectStats] 传奇效果附带的具体数值
//
// 掉落：tryUnique(rng, level) 返回该等级可掉的传奇定义（按权重，等级越高越容易见到高阶传奇），
// 概率受「稀有度提升」加成影响，调用方（itemgen）已经掷到 unique 后调用即可。

import { getRNG } from './common.js';
import { BASE_BY_ID } from './bases.js';

/**
 * @typedef {Object} UniqueDef
 * @property {string} id
 * @property {string} name
 * @property {string} baseId
 * @property {number} levelReq
 * @property {string} uniqueAffixText
 * @property {Object<string, number>} stats
 * @property {string[]} [extraLines]
 * @property {string} flavor
 * @property {string} icon
 * @property {{id:string, desc:string}} [legendaryEffect]
 * @property {Object<string, number>} [effectStats]
 * @property {number} [dropWeight]
 */

/** @type {UniqueDef[]} */
export const UNIQUES = [
  {
    id: 'abyssal_fang',
    name: '深渊之牙',
    baseId: 'eviscerating_axe',
    levelReq: 20,
    icon: '🦷',
    uniqueAffixText: '对精英与首领造成的伤害提升 30%',
    stats: { physDamageMult: 0.3, critChance: 0.05 },
    extraLines: ['+30% 物理伤害', '+5% 暴击率'],
    legendaryEffect: { id: 'elite_damage', desc: '对精英与首领造成的伤害提升 30%' },
    effectStats: { eliteDamageMult: 0.3 },
    flavor: '从深渊裂隙中拔出的獠牙，传说它曾咬穿一位堕天使的翅膀。持有者的刀锋总在猎物最脆弱处落下。',
  },
  {
    id: 'heart_of_the_colossus',
    name: '巨人之心',
    baseId: 'warlord_plate',
    levelReq: 26,
    icon: '❤️‍🔥',
    uniqueAffixText: '生命上限 +300，护甲 +200',
    stats: { life: 300, armor: 200, lifeRegen: 8 },
    extraLines: ['+300 生命', '+200 护甲', '每秒回复 8 点生命'],
    legendaryEffect: { id: 'colossus_heart', desc: '生命上限大幅提升，受到致命伤害时不会立即死亡（每 60 秒一次）' },
    effectStats: { life: 300, armor: 200, lifeRegen: 8 },
    flavor: '每一下搏动都让地面震颤。最后一个巨人把心脏留在此处，等待愿意背负它重量的身躯。',
  },
  {
    id: 'starfall_hood',
    name: '星陨兜帽',
    baseId: 'huaraches_hood',
    levelReq: 18,
    icon: '🌟',
    uniqueAffixText: '全局伤害 +25%，全元素抗性 +15%，物品稀有度 +80%',
    stats: { damageMult: 0.25, fireResist: 0.15, coldResist: 0.15, lightningResist: 0.15, rarityBonus: 0.8 },
    extraLines: ['+25% 全局伤害', '+15% 所有元素抗性', '+80% 物品稀有度'],
    legendaryEffect: { id: 'starfall', desc: '击杀敌人时，有 20% 几率降下流星，范围内造成火焰伤害' },
    effectStats: { rarityBonus: 0.8, damageMult: 0.25 },
    flavor: '陨星坠入庙顶的那一夜，织布者把星屑编进了兜帽的衬里。戴上它的人常说能听见夜空低语。',
  },
  {
    id: 'bloodrune_ring',
    name: '血魂指环',
    baseId: 'bloodstone_ring',
    levelReq: 16,
    icon: '🩸',
    uniqueAffixText: '攻击伤害的 4% 转化为生命，生命 +120',
    stats: { lifeLeech: 0.04, life: 120, lifeOnHit: 6 },
    extraLines: ['攻击伤害的 4% 转化为生命', '+120 生命', '击中时回复 6 点生命'],
    legendaryEffect: { id: 'blood_rune', desc: '生命偷取上限提高，且偷取时无视目标护甲' },
    effectStats: { lifeLeech: 0.04, lifeOnHit: 6 },
    flavor: '戒面上的符文是用某个疯王的手指血画的。它断断续续地搏动着，仿佛还记得原来的主人。',
  },
  {
    id: 'tempest_stride',
    name: '雷暴疾行靴',
    baseId: 'windrider_boots',
    levelReq: 20,
    icon: '⚡',
    uniqueAffixText: '移动速度 +30%，攻击速度 +15%，翻滚冷却 -20%',
    stats: { moveSpeedMult: 0.3, attackSpeedMult: 0.15, cdrMult: 0.2 },
    extraLines: ['+30% 移动速度', '+15% 攻击速度', '+20% 冷却缩减'],
    legendaryEffect: { id: 'tempest_stride', desc: '翻滚后 2 秒内攻击附带闪电伤害，并使周围敌人减速' },
    effectStats: { moveSpeedMult: 0.3, attackSpeedMult: 0.15, cdrMult: 0.2 },
    flavor: '穿上它的战士跑得比雷声更快。代价是，他们再也听不见自己身后的脚步。',
  },
  {
    id: 'sunfire_amulet',
    name: '烈阳护符',
    baseId: 'relic_of_flame',
    levelReq: 24,
    icon: '☀️',
    uniqueAffixText: '火焰伤害 +60%，范围效果 +25%，范围伤害 +40%',
    stats: { fireDamageMult: 0.6, aoeMult: 0.25, areaDamageMult: 0.4, addedFireMin: 12, addedFireMax: 30 },
    extraLines: ['+60% 火焰伤害', '+25% 范围效果', '+40% 范围伤害', '12 - 30 附加火焰伤害'],
    legendaryEffect: { id: 'sunfire', desc: '火焰技能灼烧地面 4 秒，持续造成燃烧伤害' },
    effectStats: { fireDamageMult: 0.6, aoeMult: 0.25 },
    flavor: '护符里囚着一缕未熄的日冕。胸前的温度永远比体温高一度，提醒佩戴者：火从不睡觉。',
  },
  {
    id: 'eternal_guardian',
    name: '永恒守护',
    baseId: 'aegis_of_war',
    levelReq: 28,
    icon: '🛡️',
    uniqueAffixText: '格挡几率 +25%，格挡时反弹 150 点伤害，护甲 +250',
    stats: { blockChance: 0.25, thorns: 150, armor: 250, energyShield: 120 },
    extraLines: ['+25% 格挡几率', '反弹 150 点伤害', '+250 护甲', '+120 能量护盾'],
    legendaryEffect: { id: 'eternal_guardian', desc: '格挡成功时，有 30% 几率释放冲击波，击退并眩晕周围敌人' },
    effectStats: { blockChance: 0.25, thorns: 150 },
    flavor: '最后一位守门人站了整整一千年，盾牌上的裂痕比他的骨骼还要多。他从未退过一步。',
  },
  {
    id: 'fortune_seeker',
    name: '寻宝者的贪婪',
    baseId: 'golden_ring',
    levelReq: 12,
    icon: '🪙',
    uniqueAffixText: '物品稀有度 +150%，物品数量 +60%，获得经验 +45%',
    stats: { rarityBonus: 1.5, quantityBonus: 0.6, xpBonus: 0.45, goldFind: 0.5 },
    extraLines: ['+150% 物品稀有度', '+60% 物品数量', '+45% 获得经验'],
    legendaryEffect: { id: 'fortune_seeker', desc: '每击杀一名精英，额外掉落一件魔法以上物品' },
    effectStats: { rarityBonus: 1.5, quantityBonus: 0.6 },
    flavor: '两枚戒指熔成一体那天，原本的主人笑得像疯了一样——他从此再没找到一个愿意和他分赃的同伴。',
  },
  {
    id: 'void_gauntlets',
    name: '虚空掠夺者',
    baseId: 'executioner_grips',
    levelReq: 22,
    icon: '🕳️',
    uniqueAffixText: '暴击率 +10%，暴击伤害 +80%，对生命值高于 50% 的敌人伤害提升 25%',
    stats: { critChance: 0.1, critMulti: 0.8, attackSpeedMult: 0.1 },
    extraLines: ['+10% 暴击率', '+80% 暴击伤害加成', '+10% 攻击速度'],
    legendaryEffect: { id: 'void_gauntlets', desc: '暴击时撕开虚空裂隙，对目标造成其最大生命 6% 的额外伤害' },
    effectStats: { critChance: 0.1, critMulti: 0.8 },
    flavor: '护手内侧缝满了细小的虚空丝线，据说每一条都连着一个被彻底抹去的名字。',
  },
  {
    id: 'wrath_of_the_berserker',
    name: '狂战士之怒',
    baseId: 'colossus_maul',
    levelReq: 30,
    icon: '💢',
    uniqueAffixText: '攻击速度 +30%，物理伤害 +90%，暴击伤害 +60%',
    stats: { attackSpeedMult: 0.3, physDamageMult: 0.9, critMulti: 0.6, damageTakenMult: 0.1 },
    extraLines: ['+30% 攻击速度', '+90% 物理伤害', '+60% 暴击伤害加成', '受到伤害提高 10%'],
    legendaryEffect: { id: 'berserker_wrath', desc: '生命低于 35% 时，攻击速度与物理伤害再提升 40%' },
    effectStats: { attackSpeedMult: 0.3, physDamageMult: 0.9 },
    flavor: '所有拿起它的人都变得更强，也变得更快地流血。锤柄上刻着一行小字：「痛，即是养料。」',
  },
];

/** 传奇 id → 定义。 */
export const UNIQUE_BY_ID = Object.freeze(
  UNIQUES.reduce((m, u) => { m[u.id] = u; return m; }, /** @type {Record<string, UniqueDef>} */ ({})),
);

/**
 * 按 id 取传奇定义。
 * @param {string} id
 * @returns {UniqueDef|undefined}
 */
export function uniqueById(id) {
  return UNIQUE_BY_ID[id];
}

/**
 * 某等级可掉落的传奇（levelReq 允许略高于物品等级：≤ level + 3，保证低等级也有机会）。
 * @param {number} level
 * @returns {UniqueDef[]}
 */
export function uniquesForLevel(level) {
  const lv = Math.max(1, level || 1);
  const pool = UNIQUES.filter((u) => u.levelReq <= lv + 3);
  return pool.length ? pool : UNIQUES.filter((u) => u.levelReq <= 12);
}

/**
 * 掷一件传奇定义。
 *
 * 权重规则：等级需求越接近当前等级 / 物品等级，权重越高（更容易掉当前可用的传奇）；
 * 同时全部传奇都有一定基础权重，避免低等级只掉同一件。
 *
 * §filter§ 可选，用于把传奇限定在某类槽位（generateItem 指定 slot 时使用）：
 *   传入 (uniqueDef) => boolean，只有返回 true 的传奇参与抽取。
 *
 * @param {{next:()=>number, weighted?:(a:any[])=>any, pick?:(a:any[])=>any}|number|Function} rng
 * @param {number} [level=1] 人物 / 物品等级
 * @param {((u:UniqueDef)=>boolean)|null} [filter=null] 额外筛选（可选）
 * @returns {UniqueDef} 永远返回一个有效传奇（不返回 null）
 */
export function tryUnique(rng, level = 1, filter = null) {
  const r = getRNG(rng);
  const lv = Math.max(1, level || 1);
  let pool = uniquesForLevel(lv);
  if (typeof filter === 'function') {
    const filtered = pool.filter((u) => filter(u));
    // 该槽位在这个等级没有传奇时，放宽等级限制再试一次，实在没有就退回全池
    pool = filtered.length ? filtered : UNIQUES.filter((u) => filter(u));
    if (!pool.length) pool = uniquesForLevel(lv);
  }
  if (!pool.length) return UNIQUES[0];
  const weighted = pool.map((u) => {
    const gap = Math.abs(lv - u.levelReq);
    return { weight: (u.dropWeight || 1) * (1 + 12 / (1 + gap)), base: u };
  });
  return /** @type {UniqueDef} */ (r.weighted(weighted)).base;
}

/**
 * 校验传奇定义引用的基底是否都存在（测试用）。
 * @returns {string[]} 缺失基底 id 列表
 */
export function validateUniques() {
  return UNIQUES.map((u) => u.baseId).filter((b) => !BASE_BY_ID[b]);
}