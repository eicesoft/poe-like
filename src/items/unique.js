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

  // ══════════════════════════════════════════════════════════════════════
  // 法师（暗金）
  // ══════════════════════════════════════════════════════════════════════
  {
    id: 'spark_of_the_apprentice',
    name: '学徒之火花',
    baseId: 'apprentice_wand',
    levelReq: 3,
    icon: '🪄',
    uniqueAffixText: '全局伤害 +8%，火焰 / 冰霜 / 闪电伤害 +10%，法力 +20',
    stats: {
      mana: 20, manaRegen: 1, damageMult: 0.08,
      fireDamageMult: 0.1, coldDamageMult: 0.1, lightningDamageMult: 0.1,
    },
    extraLines: ['+20 法力', '每秒回复 1 点法力', '+8% 全局伤害', '+10% 火焰 / 冰霜 / 闪电伤害'],
    legendaryEffect: { id: 'apprentice_spark', desc: '击杀敌人时回复 8% 最大法力，并短暂提高移动速度' },
    effectStats: { mana: 20, manaRegen: 1, damageMult: 0.08 },
    flavor: '每一位大法师的第一根法杖都烧焦过自己的眉毛。杖尖的火花不大，却足以点亮整条通往奥术的路。',
  },
  {
    id: 'stormcaller_wand',
    name: '唤雷魔杖',
    baseId: 'runed_wand',
    levelReq: 18,
    icon: '⚡',
    uniqueAffixText: '闪电伤害 +45%，附加 8 - 30 闪电伤害，冷却缩减 +10%',
    stats: {
      lightningDamageMult: 0.45, addedLightningMin: 8, addedLightningMax: 30,
      cdrMult: 0.1, critChance: 0.05, mana: 24,
    },
    extraLines: ['+45% 闪电伤害', '8 - 30 附加闪电伤害', '+10% 冷却缩减', '+5% 暴击率', '+24 法力'],
    legendaryEffect: { id: 'stormcaller', desc: '闪电技能有 20% 几率连锁到附近 2 名敌人，造成 50% 伤害' },
    effectStats: { lightningDamageMult: 0.45, addedLightningMin: 8, addedLightningMax: 30 },
    flavor: '杖身刻满了被雷劈过的符文。握紧它时，指尖会先于天空听见雷声。',
  },
  {
    id: 'glacial_requiem',
    name: '霜寂挽歌',
    baseId: 'frost_staff',
    levelReq: 22,
    icon: '❄️',
    uniqueAffixText: '冰霜伤害 +50%，附加 14 - 28 冰霜伤害，范围效果 +20%，技能等级 +1',
    stats: {
      coldDamageMult: 0.5, addedColdMin: 14, addedColdMax: 28,
      aoeMult: 0.2, mana: 30, manaRegen: 2, skillLevelBonus: 1,
    },
    extraLines: ['+50% 冰霜伤害', '14 - 28 附加冰霜伤害', '+20% 范围效果', '+1 技能等级', '+30 法力'],
    legendaryEffect: { id: 'glacial_requiem', desc: '冰霜技能命中的敌人移动速度降低 30%，持续 2 秒；对减速目标伤害提高 20%' },
    effectStats: { coldDamageMult: 0.5, aoeMult: 0.2, skillLevelBonus: 1 },
    flavor: '极北的吟游诗人用最后一口气唱完了挽歌，歌声冻成了这根法杖。挥动时仍能听见尾音。',
  },
  {
    id: 'emberheart_staff',
    name: '烬心法杖',
    baseId: 'archmage_staff',
    levelReq: 26,
    icon: '🔥',
    uniqueAffixText: '火焰伤害 +60%，全局伤害 +15%，附加 18 - 36 火焰伤害，技能等级 +1',
    stats: {
      fireDamageMult: 0.6, damageMult: 0.15, addedFireMin: 18, addedFireMax: 36,
      skillLevelBonus: 1, mana: 40,
    },
    extraLines: ['+60% 火焰伤害', '+15% 全局伤害', '18 - 36 附加火焰伤害', '+1 技能等级', '+40 法力'],
    legendaryEffect: { id: 'emberheart', desc: '火焰技能命中有 25% 几率引爆目标，对 3 范围内敌人造成一次火焰伤害' },
    effectStats: { fireDamageMult: 0.6, damageMult: 0.15, addedFireMin: 18, addedFireMax: 36 },
    flavor: '杖心的余烬从未熄灭。它不燃烧木柴，只燃烧持有者愿意献出的那部分耐心。',
  },

  // ── 法师防具 / 饰品（每个部位至少 2 件暗金，法师也能全身暗金）──
  {
    id: 'sanctum_aegis',
    name: '圣所庇护',
    baseId: 'kite_shield',
    levelReq: 24,
    icon: '🔷',
    uniqueAffixText: '能量护盾 +180，法力 +40，格挡几率 +12%，元素抗性 +12%',
    stats: {
      energyShield: 180, mana: 40, blockChance: 0.12,
      fireResist: 0.12, coldResist: 0.12, lightningResist: 0.12, damageMult: 0.08,
    },
    extraLines: ['+180 能量护盾', '+40 法力', '+12% 格挡几率', '+12% 火焰 / 冰霜 / 闪电抗性', '+8% 全局伤害'],
    legendaryEffect: { id: 'sanctum_aegis', desc: '格挡成功时回复 10% 最大法力，并使下一次法术伤害提高 30%' },
    effectStats: { energyShield: 180, blockChance: 0.12, mana: 40 },
    flavor: '它原本是某座奥术圣所的门。门被拆下来当盾牌后，里面的光仍然认得回家的路。',
  },
  {
    id: 'crown_of_the_archmage',
    name: '大法师之冠',
    baseId: 'arcane_hood',
    levelReq: 24,
    icon: '👑',
    uniqueAffixText: '能量护盾 +90，法力 +50，全局伤害 +15%，技能等级 +1',
    stats: {
      energyShield: 90, mana: 50, skillLevelBonus: 1, damageMult: 0.15, cdrMult: 0.08,
      fireResist: 0.1, coldResist: 0.1, lightningResist: 0.1,
    },
    extraLines: ['+90 能量护盾', '+50 法力', '+15% 全局伤害', '+1 技能等级', '+8% 冷却缩减', '+10% 元素抗性'],
    legendaryEffect: { id: 'archmage_crown', desc: '施放技能时回复 2% 最大法力；法力高于 80% 时元素伤害额外提高 15%' },
    effectStats: { energyShield: 90, mana: 50, skillLevelBonus: 1, damageMult: 0.15 },
    flavor: '冠冕内侧刻着历任主人的名字，最后一个名字尚未刻完——它还在等一位配得上的人。',
  },
  {
    id: 'robe_of_the_eternal_flux',
    name: '永流法袍',
    baseId: 'archmage_robe',
    levelReq: 27,
    icon: '🧥',
    uniqueAffixText: '能量护盾 +220，法力 +80，每秒回复 3 点法力，元素抗性 +12%',
    stats: {
      energyShield: 220, mana: 80, manaRegen: 3, damageMult: 0.12,
      fireResist: 0.12, coldResist: 0.12, lightningResist: 0.12,
    },
    extraLines: ['+220 能量护盾', '+80 法力', '每秒回复 3 点法力', '+12% 全局伤害', '+12% 火焰 / 冰霜 / 闪电抗性'],
    legendaryEffect: { id: 'eternal_flux', desc: '能量护盾被击碎时释放一次元素新星，对周围敌人造成火焰、冰霜与闪电伤害' },
    effectStats: { energyShield: 220, mana: 80, manaRegen: 3 },
    flavor: '布料里织着一条不会干涸的河流。穿上它的人说，连呼吸都带着潮汐的节奏。',
  },
  {
    id: 'handwraps_of_echoes',
    name: '回响之缚',
    baseId: 'silk_wraps',
    levelReq: 20,
    icon: '🧤',
    uniqueAffixText: '全局伤害 +15%，范围伤害 +25%，冷却缩减 +12%',
    stats: {
      damageMult: 0.15, areaDamageMult: 0.25, cdrMult: 0.12, mana: 30, manaRegen: 1.5,
    },
    extraLines: ['+15% 全局伤害', '+25% 范围伤害', '+12% 冷却缩减', '+30 法力', '每秒回复 1.5 点法力'],
    legendaryEffect: { id: 'echoing_handwraps', desc: '法术有 15% 几率在 1 秒后于目标处回响一次，造成 50% 伤害' },
    effectStats: { damageMult: 0.15, areaDamageMult: 0.25, cdrMult: 0.12 },
    flavor: '丝绸里封存着上一任主人最后一次施法的回声。它总比你的动作慢半拍，却从不缺席。',
  },
  {
    id: 'phasewalker_slippers',
    name: '相位行者便鞋',
    baseId: 'windrider_boots',
    levelReq: 22,
    icon: '👟',
    uniqueAffixText: '移动速度 +22%，冷却缩减 +10%，能量护盾 +60，冰霜抗性 +10%',
    stats: {
      moveSpeedMult: 0.22, cdrMult: 0.1, energyShield: 60, mana: 25, coldResist: 0.1,
    },
    extraLines: ['+22% 移动速度', '+10% 冷却缩减', '+60 能量护盾', '+25 法力', '+10% 冰霜抗性'],
    legendaryEffect: { id: 'phasewalker', desc: '位移后 2 秒内元素伤害提高 20%，并留下一条减速敌人的寒霜轨迹' },
    effectStats: { moveSpeedMult: 0.22, cdrMult: 0.1, energyShield: 60 },
    flavor: '穿上它的人偶尔会比自己的影子早到一步。影子从不抱怨，只是默默追赶。',
  },
  {
    id: 'band_of_resonance',
    name: '共鸣之环',
    baseId: 'diamond_ring',
    levelReq: 17,
    icon: '💠',
    uniqueAffixText: '火焰 / 冰霜 / 闪电伤害 +15%，全局伤害 +8%，法力 +25',
    stats: {
      mana: 25, manaRegen: 2, damageMult: 0.08,
      fireDamageMult: 0.15, coldDamageMult: 0.15, lightningDamageMult: 0.15,
    },
    extraLines: ['+15% 火焰 / 冰霜 / 闪电伤害', '+8% 全局伤害', '+25 法力', '每秒回复 2 点法力'],
    legendaryEffect: { id: 'band_of_resonance', desc: '元素反应额外产生 20 点共鸣，并使其伤害提高 25%' },
    effectStats: { damageMult: 0.08, mana: 25, manaRegen: 2 },
    flavor: '三种颜色的光在戒面里互相追逐，谁也不肯先熄灭。法师们把它叫作「小三相」。',
  },
  {
    id: 'pendant_of_the_threefold_path',
    name: '三相吊坠',
    baseId: 'amulet_of_war',
    levelReq: 21,
    icon: '🔱',
    uniqueAffixText: '技能等级 +2，全局伤害 +12%，三种元素伤害 +10%',
    stats: {
      skillLevelBonus: 2, mana: 35, manaRegen: 2.5, damageMult: 0.12, cdrMult: 0.08,
      fireDamageMult: 0.1, coldDamageMult: 0.1, lightningDamageMult: 0.1,
      fireResist: 0.08, coldResist: 0.08, lightningResist: 0.08,
    },
    extraLines: ['+2 技能等级', '+12% 全局伤害', '+10% 火焰 / 冰霜 / 闪电伤害', '+8% 冷却缩减', '+35 法力', '+8% 元素抗性'],
    legendaryEffect: { id: 'threefold_path', desc: '每次触发元素反应，使三种元素伤害在 6 秒内再提高 10%（可叠加 3 层）' },
    effectStats: { skillLevelBonus: 2, damageMult: 0.12, mana: 35 },
    flavor: '吊坠上的三道刻痕分别代表火、冰、雷。传说集齐三条路的人，能看见元素背后的同一张面孔。',
  },
  {
    id: 'sash_of_the_archon',
    name: '执政官腰带',
    baseId: 'silk_sash',
    levelReq: 19,
    icon: '🎗️',
    uniqueAffixText: '法力 +50，每秒回复 3 点法力，能量护盾 +80，冷却缩减 +10%',
    stats: {
      mana: 50, manaRegen: 3, energyShield: 80, cdrMult: 0.1, chaosResist: 0.1, damageMult: 0.1,
    },
    extraLines: ['+50 法力', '每秒回复 3 点法力', '+80 能量护盾', '+10% 冷却缩减', '+10% 混沌抗性', '+10% 全局伤害'],
    legendaryEffect: { id: 'archon_sash', desc: '施法有 10% 几率不消耗法力；法力全满时技能伤害提高 15%' },
    effectStats: { mana: 50, manaRegen: 3, energyShield: 80, cdrMult: 0.1 },
    flavor: '奥术执政官的腰带从不系紧。他们说，真正束缚一个人的从来不是带扣，而是对力量的渴望。',
  },
  {
    id: 'girdle_of_ruin',
    name: '毁灭腰带',
    baseId: 'girdle_of_power',
    levelReq: 26,
    icon: '💪',
    uniqueAffixText: '生命 +120，护甲 +70，物理伤害 +25%，攻击伤害的 2% 转化为生命',
    stats: {
      life: 120, armor: 70, physDamageMult: 0.25, lifeLeech: 0.02, lifeOnHit: 8,
    },
    extraLines: ['+120 生命', '+70 护甲', '+25% 物理伤害', '攻击伤害的 2% 转化为生命', '击中时回复 8 点生命'],
    legendaryEffect: { id: 'girdle_of_ruin', desc: '击杀敌人时回复 5% 最大生命，并在 3 秒内提高 15% 攻击速度' },
    effectStats: { life: 120, armor: 70, physDamageMult: 0.25, lifeLeech: 0.02 },
    flavor: '每一条裂缝都对应一场它没能阻止的屠杀。系上它的人，会把余生用来阻止下一场。',
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
 * 同时高阶传奇（levelReq 更高）带有额外权重，深层地图更容易见到成型向暗金。
 * 全部传奇都有一定基础权重，避免低等级只掉同一件。
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
    // 等级越接近当前物品等级越容易掉；同时按 levelReq 给高阶暗金一个额外权重，
    // 让深层地图更容易见到成型向的高阶暗金，而不是反复掉低级同一件。
    const highTier = 1 + Math.max(0, (u.levelReq || 1) - 1) / 50;
    return { weight: (u.dropWeight || 1) * (1 + 12 / (1 + gap)) * highTier, base: u };
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