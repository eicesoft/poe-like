// @file src/items/bases.js
// 物品基底（Base Items）数据 + 槽位定义。
//
// 【硬约束】纯数据，不 import 浏览器 API / three / DOM。
//
// 每个基底的结构（BaseItem）：
//   id       基底 id（如 'eviscerating_axe'）
//   name     中文名（如「裂骨战斧」）
//   slot     槽位：weapon / helmet / body / gloves / boots / ring / amulet / belt / shield
//   tier     阶位 1..4（1 最低，4 最高；数值随阶位提高）
//   levelReq 佩戴等级需求
//   icon     emoji 图标
//   baseStats 基底自带的 StatBlock 数值（武器：dmgMin/dmgMax/critChance/attackSpeedMult…）
//   implicit  { text, stats } 基底固有词缀
//   element  （武器可选）'phys'|'fire'|'cold'|'lightning'|'chaos'
//   critBase 武器基础暴击率（= baseStats.critChance，便于快速读取）
//   aspd     武器每秒攻击次数（伤害计算用：DPS = 平均伤害 × aspd）
//   tags     'melee' / 'axe' / 'sword' / 'hammer' / 'twohand' / 'onehand' / 'caster'
//
// 武器伤害：baseStats.dmgMin/dmgMax 是「物品等级 1 时」的基准值，itemgen 会按物品等级做成长
// （见 itemgen.js 的 rollWeaponDamage），阶位越高成长越好。
//
// 槽位约定（装备槽位与基底 slot 不完全一样：戒指占 ring1 / ring2，盾牌占 offhand）：
//   weapon  → 主手武器
//   offhand → 副手（盾牌）
//   helmet / body / gloves / boots / ring1 / ring2 / amulet / belt

/**
 * @typedef {Object} BaseItem
 * @property {string} id
 * @property {string} name
 * @property {'weapon'|'helmet'|'body'|'gloves'|'boots'|'ring'|'amulet'|'belt'|'shield'} slot
 * @property {number} tier
 * @property {number} levelReq
 * @property {string} icon
 * @property {Object<string, number>} baseStats
 * @property {{text: string, stats: Object<string, number>}} implicit
 * @property {'phys'|'fire'|'cold'|'lightning'|'chaos'} [element]
 * @property {number} [critBase]
 * @property {number} [aspd]
 * @property {string[]} [tags]
 */

/**
 * 物品自身的 slot 类型（**这是 item.slot 的取值域**，共 9 种）。
 * 注意：`ring1` / `ring2` / `offhand` 是「装备格子（UI 槽位）」，不是物品 slot——
 * 物品只记 `ring`，由装备系统决定放进 ring1 还是 ring2；盾牌记 `shield`，装进 offhand。
 * @type {ReadonlyArray<string>}
 */
export const ITEM_SLOTS = Object.freeze([
  'weapon', 'shield', 'helmet', 'body', 'gloves', 'boots', 'ring', 'amulet', 'belt',
]);

/**
 * 装备格子（UI 按此顺序显示；Lead 的 src/game/inventory.js 使用同样的键）。
 * 每个格子能接受哪些物品 slot 由 SLOT_ACCEPTS 定义。
 * 兼容旧名：SLOTS 指向这里（UI 槽位），物品 slot 请用 ITEM_SLOTS。
 * @type {ReadonlyArray<string>}
 */
export const SLOTS = Object.freeze([
  'weapon', 'offhand', 'helmet', 'body', 'gloves', 'boots',
  'ring1', 'ring2', 'amulet', 'belt',
]);

/** 装备格子 → 中文名。 */
export const SLOT_NAMES = Object.freeze({
  weapon: '主手',
  offhand: '副手',
  helmet: '头盔',
  body: '胸甲',
  gloves: '手套',
  boots: '靴子',
  ring1: '戒指 I',
  ring2: '戒指 II',
  amulet: '项链',
  belt: '腰带',
});

/** 物品 slot 类型 → 中文名（item.slotName 的显示来源）。 */
export const ITEM_SLOT_NAMES = Object.freeze({
  weapon: '主手武器',
  shield: '盾牌',
  helmet: '头盔',
  body: '胸甲',
  gloves: '手套',
  boots: '靴子',
  ring: '戒指',
  amulet: '项链',
  belt: '腰带',
});

/** 装备格子 → 可接受的物品 slot 列表（与 Lead 的 inventory.js SLOT_ACCEPTS 一致）。 */
export const SLOT_ACCEPTS = Object.freeze({
  weapon: Object.freeze(['weapon']),
  offhand: Object.freeze(['shield', 'weapon']),
  helmet: Object.freeze(['helmet']),
  body: Object.freeze(['body']),
  gloves: Object.freeze(['gloves']),
  boots: Object.freeze(['boots']),
  ring1: Object.freeze(['ring']),
  ring2: Object.freeze(['ring']),
  amulet: Object.freeze(['amulet']),
  belt: Object.freeze(['belt']),
});

/** 基底 slot → 中文名（tooltip 上显示的种类名）。 */
export const BASE_SLOT_NAMES = Object.freeze({
  weapon: '武器',
  shield: '盾牌',
  helmet: '头盔',
  body: '胸甲',
  gloves: '手套',
  boots: '靴子',
  ring: '戒指',
  amulet: '项链',
  belt: '腰带',
});

/**
 * @typedef {Object} MakeBaseInput
 * @property {string} id
 * @property {string} name
 * @property {string} slot
 * @property {number} tier
 * @property {number} levelReq
 * @property {string} icon
 * @property {Object<string, number>} baseStats
 * @property {string} [implicitText]
 * @property {Object<string, number>} [implicitStats]
 * @property {string} [element]
 * @property {string[]} [tags]
 */

/**
 * 构造一个基底（自动补齐 implicit / critBase / aspd / tags）。
 * @param {MakeBaseInput} o
 * @returns {BaseItem}
 */
function B(o) {
  const implicitStats = o.implicitStats || { ...o.baseStats };
  const implicitText = o.implicitText || autoImplicitText(implicitStats);
  /** @type {BaseItem} */
  const base = {
    id: o.id,
    name: o.name,
    slot: /** @type {any} */ (o.slot),
    tier: o.tier,
    levelReq: o.levelReq,
    icon: o.icon,
    baseStats: { ...o.baseStats },
    implicit: { text: implicitText, stats: { ...implicitStats } },
    tags: Object.freeze(o.tags ? o.tags.slice() : ['melee']),
  };
  if (o.element) base.element = /** @type {any} */ (o.element);
  if (o.slot === 'weapon') {
    base.critBase = o.baseStats.critChance || 0.05;
    base.aspd = o.baseStats.attackSpeedMult ? 1 + o.baseStats.attackSpeedMult : 1;
  }
  return base;
}

/** 简单的中文隐式词缀文本生成（只用于武器攻击速度这类单键情况）。 */
function autoImplicitText(stats) {
  const parts = [];
  for (const k in stats) {
    const v = stats[k];
    if (typeof v !== 'number') continue;
    switch (k) {
      case 'attackSpeedMult': parts.push((v >= 0 ? '+' : '') + Math.round(v * 100) + '% 攻击速度'); break;
      case 'critChance': parts.push((v >= 0 ? '+' : '') + (Math.round(v * 1000) / 10) + '% 暴击率'); break;
      case 'armor': parts.push('+' + Math.round(v) + ' 护甲'); break;
      case 'evasion': parts.push('+' + (Math.round(v * 1000) / 10) + '% 闪避率'); break;
      case 'energyShield': parts.push('+' + Math.round(v) + ' 能量护盾'); break;
      case 'blockChance': parts.push('+' + (Math.round(v * 1000) / 10) + '% 格挡几率'); break;
      case 'moveSpeedMult': parts.push((v >= 0 ? '+' : '') + Math.round(v * 100) + '% 移动速度'); break;
      case 'life': parts.push('+' + Math.round(v) + ' 生命'); break;
      case 'mana': parts.push('+' + Math.round(v) + ' 法力'); break;
      case 'thorns': parts.push('反弹 ' + Math.round(v) + ' 点伤害'); break;
      case 'critMulti': parts.push('+' + Math.round(v * 100) + '% 暴击伤害加成'); break;
      case 'fireResist': parts.push('+' + Math.round(v * 100) + '% 火焰抗性'); break;
      case 'coldResist': parts.push('+' + Math.round(v * 100) + '% 冰霜抗性'); break;
      case 'lightningResist': parts.push('+' + Math.round(v * 100) + '% 闪电抗性'); break;
      case 'chaosResist': parts.push('+' + Math.round(v * 100) + '% 混沌抗性'); break;
      case 'lifeRegen': parts.push('每秒回复 ' + v + ' 点生命'); break;
      case 'lifeLeech': parts.push('攻击伤害的 ' + (Math.round(v * 1000) / 10) + '% 转化为生命'); break;
      case 'rarityBonus': parts.push('+' + Math.round(v * 100) + '% 物品稀有度'); break;
      case 'dmgMin': case 'dmgMax': case 'physAddedMin': case 'physAddedMax': break;
      default: parts.push('+' + v + ' ' + k);
    }
  }
  return parts.join('，') || '无';
}

// ---------------------------------------------------------------------------
// 武器（weapon）：dmgMin/dmgMax + 攻速 + 暴击。tier 越高数值越大，但攻速往往越慢（巨斧 vs 短剑）。
// ---------------------------------------------------------------------------
const WEAPONS = [
  B({ id: 'rusted_hatchet', name: '锈蚀短斧', slot: 'weapon', tier: 1, levelReq: 1, icon: '🪓',
    baseStats: { dmgMin: 7, dmgMax: 12, attackSpeedMult: 0.12, critChance: 0.05, critMulti: 1.1 },
    implicitText: '+12% 攻击速度', tags: ['melee', 'axe', 'onehand'] }),
  B({ id: 'short_sword', name: '短剑', slot: 'weapon', tier: 1, levelReq: 1, icon: '🗡️',
    baseStats: { dmgMin: 6, dmgMax: 10, attackSpeedMult: 0.16, critChance: 0.06, critMulti: 1.1 },
    implicitText: '+16% 攻击速度', tags: ['melee', 'sword', 'onehand'] }),
  B({ id: 'miner_pick', name: '矿工铁镐', slot: 'weapon', tier: 1, levelReq: 1, icon: '⛏️',
    baseStats: { dmgMin: 8, dmgMax: 14, attackSpeedMult: 0.02, critChance: 0.05, critMulti: 1.15 },
    implicitText: '+2% 攻击速度', tags: ['melee', 'hammer', 'onehand'] }),
  B({ id: 'iron_hatchet', name: '铁质手斧', slot: 'weapon', tier: 1, levelReq: 3, icon: '🪓',
    baseStats: { dmgMin: 9, dmgMax: 15, attackSpeedMult: 0.1, critChance: 0.05, critMulti: 1.1 },
    implicitText: '+10% 攻击速度', tags: ['melee', 'axe', 'onehand'] }),
  B({ id: 'long_sword', name: '长剑', slot: 'weapon', tier: 2, levelReq: 5, icon: '🗡️',
    baseStats: { dmgMin: 11, dmgMax: 19, attackSpeedMult: 0.05, critChance: 0.07, critMulti: 1.2 },
    implicitText: '+7% 暴击率', tags: ['melee', 'sword', 'onehand'] }),
  B({ id: 'bone_axe', name: '断骨巨斧', slot: 'weapon', tier: 2, levelReq: 8, icon: '🪓',
    baseStats: { dmgMin: 15, dmgMax: 28, attackSpeedMult: -0.1, critChance: 0.05, critMulti: 1.2 },
    implicitText: '10% 攻击速度降低', tags: ['melee', 'axe', 'twohand'] }),
  B({ id: 'war_hammer', name: '战锤', slot: 'weapon', tier: 2, levelReq: 10, icon: '🔨',
    baseStats: { dmgMin: 17, dmgMax: 30, attackSpeedMult: -0.15, critChance: 0.05, critMulti: 1.25 },
    implicitText: '15% 攻击速度降低', tags: ['melee', 'hammer', 'onehand'] }),
  B({ id: 'broad_sword', name: '阔剑', slot: 'weapon', tier: 3, levelReq: 13, icon: '⚔️',
    baseStats: { dmgMin: 20, dmgMax: 33, attackSpeedMult: 0.02, critChance: 0.08, critMulti: 1.25 },
    implicitText: '+8% 暴击率', tags: ['melee', 'sword', 'onehand'] }),
  B({ id: 'double_bladed_axe', name: '双刃长斧', slot: 'weapon', tier: 3, levelReq: 16, icon: '⚔️',
    baseStats: { dmgMin: 26, dmgMax: 44, attackSpeedMult: -0.12, critChance: 0.07, critMulti: 1.3 },
    implicitText: '+7% 暴击率', tags: ['melee', 'axe', 'twohand'] }),
  B({ id: 'eviscerating_axe', name: '裂骨战斧', slot: 'weapon', tier: 3, levelReq: 19, icon: '🪓',
    baseStats: { dmgMin: 29, dmgMax: 52, attackSpeedMult: -0.08, critChance: 0.06, critMulti: 1.35 },
    implicitText: '+35% 暴击伤害加成', tags: ['melee', 'axe', 'twohand'] }),
  B({ id: 'colossus_maul', name: '泰坦巨槌', slot: 'weapon', tier: 4, levelReq: 24, icon: '🔨',
    baseStats: { dmgMin: 36, dmgMax: 66, attackSpeedMult: -0.2, critChance: 0.05, critMulti: 1.4 },
    implicitText: '+40% 暴击伤害加成', tags: ['melee', 'hammer', 'twohand'] }),
  B({ id: 'reaver_greatsword', name: '掠魂巨剑', slot: 'weapon', tier: 4, levelReq: 30, icon: '⚔️',
    baseStats: { dmgMin: 44, dmgMax: 78, attackSpeedMult: 0.0, critChance: 0.1, critMulti: 1.45 },
    implicitText: '+10% 暴击率', tags: ['melee', 'sword', 'twohand'] }),
  B({ id: 'infernal_cleaver', name: '狱火劈刃', slot: 'weapon', tier: 4, levelReq: 34, icon: '🔥', element: 'fire',
    baseStats: { dmgMin: 40, dmgMax: 74, attackSpeedMult: -0.04, critChance: 0.07, critMulti: 1.4, physDamageMult: 0.1 },
    implicitText: '+10% 物理伤害', tags: ['melee', 'axe', 'twohand'] }),

  // ── 法师武器（caster）：伤害略低于同阶近战，但自带法力 / 元素伤害，直接放大法术循环 ──
  B({ id: 'apprentice_wand', name: '学徒魔杖', slot: 'weapon', tier: 1, levelReq: 1, icon: '🪄',
    baseStats: { dmgMin: 5, dmgMax: 9, attackSpeedMult: 0.18, critChance: 0.06, critMulti: 1.1, mana: 12, manaRegen: 0.4 },
    implicitText: '+12 法力，+18% 攻击速度', tags: ['caster', 'wand', 'onehand'] }),
  B({ id: 'runed_wand', name: '符文魔杖', slot: 'weapon', tier: 2, levelReq: 9, icon: '🪄', element: 'lightning',
    baseStats: { dmgMin: 12, dmgMax: 20, attackSpeedMult: 0.12, critChance: 0.06, critMulti: 1.2, mana: 22, manaRegen: 0.8, lightningDamageMult: 0.08 },
    implicitText: '+22 法力，+8% 闪电伤害', tags: ['caster', 'wand', 'onehand'] }),
  B({ id: 'frost_staff', name: '霜语法杖', slot: 'weapon', tier: 3, levelReq: 18, icon: '❄️', element: 'cold',
    baseStats: { dmgMin: 22, dmgMax: 38, attackSpeedMult: -0.02, critChance: 0.07, critMulti: 1.25, mana: 32, manaRegen: 1.2, coldDamageMult: 0.12 },
    implicitText: '+32 法力，+12% 冰霜伤害', tags: ['caster', 'staff', 'twohand'] }),
  B({ id: 'archmage_staff', name: '大法师法杖', slot: 'weapon', tier: 4, levelReq: 28, icon: '🔮', element: 'fire',
    baseStats: { dmgMin: 34, dmgMax: 60, attackSpeedMult: -0.06, critChance: 0.08, critMulti: 1.3, mana: 50, manaRegen: 1.8, damageMult: 0.1 },
    implicitText: '+50 法力，+10% 全局伤害', tags: ['caster', 'staff', 'twohand'] }),
];

// ---------------------------------------------------------------------------
// 头盔（helmet）：护甲 / 少量闪避，高阶给能量护盾。
// ---------------------------------------------------------------------------
const HELMETS = [
  B({ id: 'leather_cap', name: '皮革便帽', slot: 'helmet', tier: 1, levelReq: 1, icon: '🧢',
    baseStats: { armor: 8, evasion: 0.02 }, implicitText: '+8 护甲，+2% 闪避率' }),
  B({ id: 'iron_barbute', name: '铁面盔', slot: 'helmet', tier: 1, levelReq: 4, icon: '🪖',
    baseStats: { armor: 16 }, implicitText: '+16 护甲' }),
  B({ id: 'huaraches_hood', name: '骨链头巾', slot: 'helmet', tier: 2, levelReq: 9, icon: '🎓',
    baseStats: { armor: 22, evasion: 0.04 }, implicitText: '+22 护甲，+4% 闪避率' }),
  B({ id: 'spiked_helm', name: '尖刺战盔', slot: 'helmet', tier: 2, levelReq: 12, icon: '👺',
    baseStats: { armor: 30, thorns: 5 }, implicitText: '+30 护甲，反弹 5 点伤害' }),
  B({ id: 'crusader_helm', name: '圣战者头盔', slot: 'helmet', tier: 3, levelReq: 18, icon: '⛑️',
    baseStats: { armor: 48, energyShield: 8 }, implicitText: '+48 护甲，+8 能量护盾' }),
  B({ id: 'demon_horn_helm', name: '魔角盔', slot: 'helmet', tier: 3, levelReq: 22, icon: '😈',
    baseStats: { armor: 40, critChance: 0.02, thorns: 9 }, implicitText: '+40 护甲，+2% 暴击率' }),
  B({ id: 'titan_crown', name: '巨神之冠', slot: 'helmet', tier: 4, levelReq: 28, icon: '👑',
    baseStats: { armor: 78, energyShield: 20, life: 20 }, implicitText: '+78 护甲，+20 生命' }),
  B({ id: 'arcane_hood', name: '秘法兜帽', slot: 'helmet', tier: 3, levelReq: 17, icon: '🧙',
    baseStats: { armor: 12, energyShield: 40, mana: 22, manaRegen: 1 }, implicitText: '+40 能量护盾，+22 法力' }),
];

// ---------------------------------------------------------------------------
// 胸甲（body）：主力护甲位。
// ---------------------------------------------------------------------------
const BODIES = [
  B({ id: 'ragged_tunic', name: '破旧外衣', slot: 'body', tier: 1, levelReq: 1, icon: '👕',
    baseStats: { armor: 14 }, implicitText: '+14 护甲' }),
  B({ id: 'leather_vest', name: '硬皮背心', slot: 'body', tier: 1, levelReq: 3, icon: '👚',
    baseStats: { armor: 22, evasion: 0.03 }, implicitText: '+22 护甲，+3% 闪避率' }),
  B({ id: 'chain_coat', name: '锁子甲', slot: 'body', tier: 2, levelReq: 8, icon: '🥋',
    baseStats: { armor: 46 }, implicitText: '+46 护甲' }),
  B({ id: 'scale_vest', name: '鳞甲背心', slot: 'body', tier: 2, levelReq: 11, icon: '🧥',
    baseStats: { armor: 38, evasion: 0.05 }, implicitText: '+38 护甲，+5% 闪避率' }),
  B({ id: 'plate_armor', name: '板甲', slot: 'body', tier: 3, levelReq: 16, icon: '🛡️',
    baseStats: { armor: 86, moveSpeedMult: -0.04 }, implicitText: '+86 护甲，4% 移动速度降低' }),
  B({ id: 'battle_plate', name: '战纹重甲', slot: 'body', tier: 3, levelReq: 21, icon: '🥷',
    baseStats: { armor: 96, life: 18 }, implicitText: '+96 护甲，+18 生命' }),
  B({ id: 'dragon_scale', name: '龙鳞胸甲', slot: 'body', tier: 4, levelReq: 27, icon: '🐉',
    baseStats: { armor: 130, fireResist: 0.1 }, implicitText: '+130 护甲，+10% 火焰抗性' }),
  B({ id: 'warlord_plate', name: '战王铠甲', slot: 'body', tier: 4, levelReq: 33, icon: '🏛️',
    baseStats: { armor: 168, life: 30, energyShield: 16 }, implicitText: '+168 护甲，+30 生命' }),
  // ── 法师法袍：低护甲、高能量护盾 / 法力，给元素法师堆护盾与续航 ──
  B({ id: 'apprentice_robe', name: '学徒法袍', slot: 'body', tier: 1, levelReq: 1, icon: '🥼',
    baseStats: { armor: 4, energyShield: 16, mana: 12 }, implicitText: '+16 能量护盾，+12 法力' }),
  B({ id: 'archmage_robe', name: '大法师法袍', slot: 'body', tier: 4, levelReq: 28, icon: '🧥',
    baseStats: { armor: 18, energyShield: 100, mana: 45, manaRegen: 1.5 }, implicitText: '+100 能量护盾，+45 法力' }),
];

// ---------------------------------------------------------------------------
// 手套（gloves）：暴击 / 攻速 / 小护甲。
// ---------------------------------------------------------------------------
const GLOVES = [
  B({ id: 'work_gloves', name: '工匠手套', slot: 'gloves', tier: 1, levelReq: 1, icon: '🧤',
    baseStats: { armor: 5 }, implicitText: '+5 护甲' }),
  B({ id: 'spiked_gauntlets', name: '尖刺护手', slot: 'gloves', tier: 2, levelReq: 7, icon: '🥊',
    baseStats: { armor: 14, thorns: 6 }, implicitText: '+14 护甲，反弹 6 点伤害' }),
  B({ id: 'duelist_gloves', name: '决斗者手套', slot: 'gloves', tier: 2, levelReq: 12, icon: '🤺',
    baseStats: { armor: 10, critChance: 0.03 }, implicitText: '+3% 暴击率' }),
  B({ id: 'berserker_gauntlets', name: '狂战士护手', slot: 'gloves', tier: 3, levelReq: 19, icon: '💢',
    baseStats: { armor: 24, attackSpeedMult: 0.05 }, implicitText: '+5% 攻击速度' }),
  B({ id: 'executioner_grips', name: '处刑者之握', slot: 'gloves', tier: 4, levelReq: 26, icon: '🩸',
    baseStats: { armor: 34, critMulti: 0.15, attackSpeedMult: 0.04 }, implicitText: '+15% 暴击伤害加成' }),
  B({ id: 'silk_wraps', name: '秘丝手套', slot: 'gloves', tier: 2, levelReq: 10, icon: '🧤',
    baseStats: { armor: 6, energyShield: 18, mana: 15, cdrMult: 0.03 }, implicitText: '+18 能量护盾，+3% 冷却缩减' }),
];

// ---------------------------------------------------------------------------
// 靴子（boots）：移速（隐式）。
// ---------------------------------------------------------------------------
const BOOTS = [
  B({ id: 'worn_boots', name: '磨损皮靴', slot: 'boots', tier: 1, levelReq: 1, icon: '🥾',
    baseStats: { armor: 4, moveSpeedMult: 0.04 }, implicitText: '+4% 移动速度' }),
  B({ id: 'assassin_greaves', name: '刺客护踝', slot: 'boots', tier: 2, levelReq: 6, icon: '👢',
    baseStats: { armor: 10, evasion: 0.03, moveSpeedMult: 0.08 }, implicitText: '+8% 移动速度' }),
  B({ id: 'iron_plated_boots', name: '覆铁战靴', slot: 'boots', tier: 2, levelReq: 13, icon: '👞',
    baseStats: { armor: 28, moveSpeedMult: 0.06 }, implicitText: '+6% 移动速度' }),
  B({ id: 'windrider_boots', name: '疾风行者长靴', slot: 'boots', tier: 3, levelReq: 20, icon: '🌪️',
    baseStats: { armor: 18, evasion: 0.06, moveSpeedMult: 0.12 }, implicitText: '+12% 移动速度' }),
  B({ id: 'colossus_greaves', name: '泰坦胫甲', slot: 'boots', tier: 4, levelReq: 28, icon: '🦿',
    baseStats: { armor: 46, life: 15, moveSpeedMult: 0.08 }, implicitText: '+8% 移动速度' }),
];

// ---------------------------------------------------------------------------
// 盾牌（shield，占据 offhand）：格挡。
// ---------------------------------------------------------------------------
const SHIELDS = [
  B({ id: 'wooden_buckler', name: '木制小圆盾', slot: 'shield', tier: 1, levelReq: 1, icon: '🛡️',
    baseStats: { armor: 12, blockChance: 0.12 }, implicitText: '+12% 格挡几率' }),
  B({ id: 'iron_round_shield', name: '铁制圆盾', slot: 'shield', tier: 2, levelReq: 8, icon: '🛡️',
    baseStats: { armor: 30, blockChance: 0.15 }, implicitText: '+15% 格挡几率' }),
  B({ id: 'tower_shield', name: '塔盾', slot: 'shield', tier: 3, levelReq: 15, icon: '🚧',
    baseStats: { armor: 62, blockChance: 0.18, moveSpeedMult: -0.03 }, implicitText: '+18% 格挡几率' }),
  B({ id: 'kite_shield', name: '鸢形战盾', slot: 'shield', tier: 3, levelReq: 22, icon: '⛨',
    baseStats: { armor: 70, evasion: 0.04, blockChance: 0.2 }, implicitText: '+20% 格挡几率' }),
  B({ id: 'aegis_of_war', name: '战神圣盾', slot: 'shield', tier: 4, levelReq: 30, icon: '🔰',
    baseStats: { armor: 110, life: 20, blockChance: 0.24 }, implicitText: '+24% 格挡几率' }),
];

// ---------------------------------------------------------------------------
// 戒指（ring，可戴 ring1 / ring2 两枚）。
// ---------------------------------------------------------------------------
const RINGS = [
  B({ id: 'iron_band', name: '铁质戒指', slot: 'ring', tier: 1, levelReq: 1, icon: '💍',
    baseStats: { life: 8 }, implicitText: '+8 生命' }),
  B({ id: 'copper_ring', name: '铜制戒指', slot: 'ring', tier: 1, levelReq: 3, icon: '💍',
    baseStats: { mana: 10 }, implicitText: '+10 法力' }),
  B({ id: 'sapphire_ring', name: '蓝宝石戒指', slot: 'ring', tier: 2, levelReq: 8, icon: '💠',
    baseStats: { coldResist: 0.1 }, implicitText: '+10% 冰霜抗性' }),
  B({ id: 'ruby_ring', name: '红宝石戒指', slot: 'ring', tier: 2, levelReq: 8, icon: '❤️',
    baseStats: { fireResist: 0.1 }, implicitText: '+10% 火焰抗性' }),
  B({ id: 'topaz_ring', name: '黄玉戒指', slot: 'ring', tier: 2, levelReq: 10, icon: '💛',
    baseStats: { lightningResist: 0.1 }, implicitText: '+10% 闪电抗性' }),
  B({ id: 'diamond_ring', name: '钻石戒指', slot: 'ring', tier: 3, levelReq: 17, icon: '💎',
    baseStats: { critChance: 0.03 }, implicitText: '+3% 暴击率' }),
  B({ id: 'bloodstone_ring', name: '血石戒指', slot: 'ring', tier: 3, levelReq: 21, icon: '🩸',
    baseStats: { life: 22, lifeLeech: 0.01 }, implicitText: '+22 生命' }),
  B({ id: 'golden_ring', name: '黄金戒指', slot: 'ring', tier: 4, levelReq: 29, icon: '🏅',
    baseStats: { rarityBonus: 0.15 }, implicitText: '+15% 物品稀有度' }),
];

// ---------------------------------------------------------------------------
// 项链（amulet）：技能等级 / 全局伤害类。
// ---------------------------------------------------------------------------
const AMULETS = [
  B({ id: 'bone_amulet', name: '骨制项链', slot: 'amulet', tier: 1, levelReq: 1, icon: '📿',
    baseStats: { life: 10 }, implicitText: '+10 生命' }),
  B({ id: 'silver_amulet', name: '银质护符', slot: 'amulet', tier: 2, levelReq: 9, icon: '🔗',
    baseStats: { manaRegen: 1.5 }, implicitText: '每秒回复 1.5 点法力' }),
  B({ id: 'amulet_of_war', name: '战争之誓护符', slot: 'amulet', tier: 3, levelReq: 18, icon: '🏵️',
    baseStats: { skillLevelBonus: 1, aoeMult: 0.05 }, implicitText: '+1 技能等级' }),
  B({ id: 'relic_of_flame', name: '烈焰圣物', slot: 'amulet', tier: 3, levelReq: 24, icon: '🔥',
    baseStats: { fireDamageMult: 0.15 }, implicitText: '+15% 火焰伤害' }),
  B({ id: 'talisman_of_ruin', name: '毁灭护符', slot: 'amulet', tier: 4, levelReq: 31, icon: '☠️',
    baseStats: { critMulti: 0.2, skillLevelBonus: 1 }, implicitText: '+20% 暴击伤害加成' }),
];

// ---------------------------------------------------------------------------
// 腰带（belt）：生命 / 药剂相关，用 life / lifeRegen / chaosResist 表示。
// ---------------------------------------------------------------------------
const BELTS = [
  B({ id: 'leather_belt', name: '皮革腰带', slot: 'belt', tier: 1, levelReq: 1, icon: '🎗️',
    baseStats: { life: 10 }, implicitText: '+10 生命' }),
  B({ id: 'heavy_belt', name: '重型腰带', slot: 'belt', tier: 2, levelReq: 8, icon: '🎗️',
    baseStats: { armor: 14, life: 20 }, implicitText: '+20 生命' }),
  B({ id: 'studded_belt', name: '镶钉腰带', slot: 'belt', tier: 2, levelReq: 12, icon: '🎗️',
    baseStats: { chaosResist: 0.08 }, implicitText: '+8% 混沌抗性' }),
  B({ id: 'warriors_wrap', name: '战神缠带', slot: 'belt', tier: 3, levelReq: 19, icon: '🥋',
    baseStats: { life: 34, lifeRegen: 1.5 }, implicitText: '+34 生命，每秒回复 1.5 点生命' }),
  B({ id: 'girdle_of_power', name: '伟力巨带', slot: 'belt', tier: 4, levelReq: 28, icon: '💪',
    baseStats: { life: 52, armor: 30, lifeLeech: 0.01 }, implicitText: '+52 生命' }),
  B({ id: 'silk_sash', name: '秘丝腰带', slot: 'belt', tier: 3, levelReq: 18, icon: '🎗️',
    baseStats: { energyShield: 30, mana: 25, manaRegen: 1, chaosResist: 0.05 }, implicitText: '+30 能量护盾，+25 法力' }),
];

/**
 * 全部基底物品（70 个：17 把武器 + 53 件防具 / 饰品）。**这是唯一的权威数据源**，itemgen / UI 都从这里查。
 * @type {ReadonlyArray<BaseItem>}
 */
export const BASE_ITEMS = Object.freeze([
  ...WEAPONS, ...HELMETS, ...BODIES, ...GLOVES, ...BOOTS, ...SHIELDS, ...RINGS, ...AMULETS, ...BELTS,
].map((b) => Object.freeze(b)));

/** 基底 id → 基底（O(1) 查询）。 */
export const BASE_BY_ID = Object.freeze(
  BASE_ITEMS.reduce((m, b) => { m[b.id] = b; return m; }, /** @type {Record<string, BaseItem>} */ ({})),
);

/**
 * 按 id 取基底。
 * @param {string} id
 * @returns {BaseItem|undefined}
 */
export function baseById(id) {
  return BASE_BY_ID[id];
}

/**
 * 某基底 slot 的全部基底（如 'ring' → 8 枚戒指）。
 * @param {string} slot
 * @returns {BaseItem[]}
 */
export function basesForSlot(slot) {
  return BASE_ITEMS.filter((b) => b.slot === slot);
}

/**
 * 装备槽位 → 该槽位可接受的基底数组。
 * @param {string} equipSlot weapon / offhand / helmet / ...
 * @returns {BaseItem[]}
 */
export function basesForEquipSlot(equipSlot) {
  const accepts = SLOT_ACCEPTS[equipSlot];
  if (!accepts) return [];
  return BASE_ITEMS.filter((b) => accepts.includes(b.slot));
}

/**
 * 某等级的角色能出的基底列表（levelReq <= level）。
 * @param {string} slot 基底 slot
 * @param {number} level
 * @returns {BaseItem[]}
 */
export function basesForLevel(slot, level) {
  const arr = basesForSlot(slot).filter((b) => b.levelReq <= Math.max(1, level));
  return arr.length ? arr : basesForSlot(slot).slice(0, 1);
}

/**
 * 在某个装备格子上、按物品等级加权随机挑一个基底（高阶基底权重低，呈现「珍稀感」）。
 *
 * · equipSlot 可以是装备格子（weapon / offhand / ring1 / ring2 …），
 *   也可以是物品 slot 本身（weapon / shield / ring / amulet …，直接按该类型过滤）。
 * · 只会在**该槽位允许的基底**里挑，绝不会串到别的类型（例如 slot:'ring' 必定是戒指）。
 * · 物品等级不够时，退化为该槽位里等级需求最低的基底（同一类型内），仍然保证类型正确。
 *
 * @param {import('../engine/rng.js').RNG} rng
 * @param {string} equipSlot
 * @param {number} level
 * @returns {BaseItem}
 */
export function pickBase(rng, equipSlot, level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  // 物品 slot 直接当过滤条件（如 'ring'、'shield'）；否则按装备格子取可接受类型
  const accepts = ITEM_SLOTS.includes(equipSlot) ? [equipSlot] : SLOT_ACCEPTS[equipSlot];
  const pool = accepts ? BASE_ITEMS.filter((b) => accepts.includes(b.slot)) : BASE_ITEMS.slice();
  if (pool.length === 0) return BASE_ITEMS[0];

  let cands = pool.filter((b) => b.levelReq <= lv);
  if (cands.length === 0) {
    // 等级不够：退化为该槽位中等级需求最低的那些（仍限定同一类型）
    const minReq = pool.reduce((m, b) => (b.levelReq < m ? b.levelReq : m), Infinity);
    cands = pool.filter((b) => b.levelReq === minReq);
  }
  // 权重：阶位越低越常见；等级越接近基底需求，越容易出高阶。
  // [掉落调整] 高阶基底（T3/T4）的等级成长从固定 0.15/级 提高为「阶位越高成长越快」，
  // 并给 T3/T4 额外 50% 权重：深层地图里高阶基底明显更常见，而不是永远被 T1 压住。
  // 副手（offhand）里盾牌占 85%，双手武器只占 15%，符合「盾战」为主的观感。
  const offhandMixed = equipSlot === 'offhand' && cands.some((b) => b.slot === 'shield') && cands.some((b) => b.slot === 'weapon');
  const weighted = cands.map((b) => {
    const gap = Math.max(0, lv - b.levelReq);
    const highTier = b.tier >= 3 ? 1.5 : 1;
    let w = (5 - b.tier) * highTier + gap * (0.12 + 0.08 * (b.tier - 1));
    if (offhandMixed) w *= b.slot === 'shield' ? 0.85 : 0.15;
    return { weight: w, base: b };
  });
  return /** @type {BaseItem} */ (rng.weighted(weighted)).base;
}

/**
 * 武器伤害的元素颜色（供 UI 显示 DPS 行）。
 * @param {string} [element]
 * @returns {string}
 */
export function elementColor(element) {
  switch (element) {
    case 'fire': return '#ff7a3c';
    case 'cold': return '#7fd4ff';
    case 'lightning': return '#ffe45c';
    case 'chaos': return '#c67bff';
    default: return '#e8e8e8';
  }
}