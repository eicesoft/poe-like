// @file src/items/affix_extra.js
// 词缀扩充池（补齐部位覆盖 + 提高同组词缀的多样性）。
//
// 说明：
//  - 这里的词缀与 affixes.js 的 PREFIXES / SUFFIXES 合并后使用，**不单独对外暴露**。
//  - 每一条都与已有词缀处于同一个 group，因此同组依然互斥（不会出现两条「攻击速度」）。
//  - 作用是：让每个部位在「生命 / 防御 / 元素伤害 / 暴击 / 攻速 / 掉宝」等主要 group 上都有词缀可出。
//
// 同样遵守：values [levelReq, 数值] 从弱到强；tiers[0] = T1 最强。

/** @typedef {import('./affixes.js').Affix} Affix */

/**
 * 批量定义词缀（内部表驱动）。
 * @param {'prefix'|'suffix'} kind
 * @param {Array<{id:string, name:string, group:string, slots:string[], values:Array<[number,number]>, text:(v:number)=>string, stats:(v:number)=>Object<string,number>}>} defs
 * @returns {Affix[]}
 */
function make(kind, defs) {
  return defs.map((d) => {
    const n = d.values.length;
    const tiers = d.values
      .map(([levelReq, v], i) => ({ tier: n - i, levelReq, text: d.text(v), stats: d.stats(v) }))
      .reverse();
    return Object.freeze({
      id: d.id,
      name: d.name,
      kind,
      group: d.group,
      slots: Object.freeze(d.slots.slice()),
      tiers: Object.freeze(tiers.map((t) => Object.freeze({ ...t, stats: Object.freeze({ ...t.stats }) }))),
    });
  });
}

const ALL = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'shield', 'ring', 'amulet', 'belt'];
const WEARABLE = ['helmet', 'body', 'gloves', 'boots', 'shield', 'belt'];
const JEWELRY = ['ring', 'amulet'];

const I = (v) => String(Math.round(v));
const SP = (v) => (v >= 0 ? '+' : '') + Math.round(v * 1000) / 10 + '%';

/**
 * 额外前缀。
 * @type {Affix[]}
 */
const EXTRA_PREFIXES_TABLE = Object.freeze(make('prefix', [
  // ── 生命 / 防御 ──
  { id: 'p_titanic', name: '巨人般的', group: 'life', slots: WEARABLE,
    values: [[1, 22], [16, 38], [32, 60], [48, 82]],
    text: (v) => '+' + I(v) + ' 生命', stats: (v) => ({ life: v }) },
  { id: 'p_essence', name: '精髓的', group: 'energyShield', slots: WEARABLE,
    values: [[6, 11], [18, 24], [32, 44], [46, 66]],
    text: (v) => '+' + I(v) + ' 能量护盾', stats: (v) => ({ energyShield: v }) },
  { id: 'p_plating', name: '重装的', group: 'armor', slots: WEARABLE,
    values: [[2, 22], [14, 46], [28, 78], [42, 112]],
    text: (v) => '+' + I(v) + ' 护甲', stats: (v) => ({ armor: v }) },
  { id: 'p_scale', name: '龙鳞的', group: 'evasion', slots: ['helmet', 'body', 'gloves', 'boots'],
    values: [[6, 0.03], [18, 0.06], [32, 0.1], [46, 0.14]],
    text: (v) => SP(v) + ' 闪避率', stats: (v) => ({ evasion: v }) },
  { id: 'p_carapace', name: '甲壳的', group: 'thorns', slots: ['body', 'boots', 'gloves'],
    values: [[8, 8], [20, 20], [34, 36], [48, 50]],
    text: (v) => '反弹 ' + I(v) + ' 点伤害', stats: (v) => ({ thorns: v }) },
  { id: 'p_rune_ward', name: '符文守护的', group: 'blockChance', slots: ['shield', 'ring'],
    values: [[12, 0.025], [26, 0.05], [40, 0.075], [54, 0.1]],
    text: (v) => SP(v) + ' 格挡几率', stats: (v) => ({ blockChance: v }) },

  // ── 速度 / 暴击 ──
  { id: 'p_swiftness', name: '疾速的', group: 'attackSpeed', slots: ['weapon', 'gloves', 'ring'],
    values: [[2, 0.015], [14, 0.035], [28, 0.06], [42, 0.085], [56, 0.11]],
    text: (v) => SP(v) + ' 攻击速度', stats: (v) => ({ attackSpeedMult: v }) },
  { id: 'p_execution', name: '处决的', group: 'critChance', slots: ['gloves', 'belt', 'shield', 'helmet'],
    values: [[4, 0.015], [16, 0.025], [30, 0.04], [44, 0.055]],
    text: (v) => SP(v) + ' 暴击率', stats: (v) => ({ critChance: v }) },
  { id: 'p_ruin', name: '毁灭的', group: 'critMulti', slots: ['gloves', 'belt', 'shield', 'helmet'],
    values: [[10, 0.12], [22, 0.25], [36, 0.4], [50, 0.6]],
    text: (v) => SP(v) + ' 暴击伤害加成', stats: (v) => ({ critMulti: v }) },
  { id: 'p_blast', name: '爆裂的', group: 'aoe', slots: ['weapon', 'belt', 'gloves', 'helmet'],
    values: [[16, 0.035], [30, 0.06], [44, 0.085], [58, 0.11]],
    text: (v) => SP(v) + ' 范围效果', stats: (v) => ({ aoeMult: v }) },
  { id: 'p_prowess', name: '精熟的', group: 'skillLevel', slots: ['amulet', 'helmet', 'ring'],
    values: [[14, 1], [40, 1]],
    text: (v) => '+' + I(v) + ' 技能等级', stats: (v) => ({ skillLevelBonus: v }) },

  // ── 伤害 ──
  { id: 'p_venom', name: '毒噬的', group: 'chaosPct', slots: ['weapon', 'gloves', 'belt'],
    values: [[20, 0.12], [34, 0.24], [48, 0.36], [60, 0.5]],
    text: (v) => SP(v) + ' 混沌伤害', stats: (v) => ({ chaosDamageMult: v }) },
  { id: 'p_fury', name: '狂怒的', group: 'globalDamage', slots: ['weapon', 'gloves', 'helmet', 'boots'],
    values: [[10, 0.08], [26, 0.15], [42, 0.23], [58, 0.32]],
    text: (v) => SP(v) + ' 全局伤害', stats: (v) => ({ damageMult: v }) },
  { id: 'p_warlord', name: '战王的', group: 'heavyStrike', slots: ['helmet', 'body', 'shield', 'ring'],
    values: [[12, 0.08], [28, 0.16], [44, 0.26], [58, 0.36]],
    text: (v) => SP(v) + ' 近战伤害', stats: (v) => ({ damageMult: v }) },
  { id: 'p_quake', name: '震颤的', group: 'areaDamage', slots: ['belt', 'ring', 'amulet'],
    values: [[18, 0.1], [32, 0.18], [46, 0.28], [58, 0.4]],
    text: (v) => SP(v) + ' 范围伤害', stats: (v) => ({ areaDamageMult: v }) },
  { id: 'p_bloodlust', name: '嗜血的', group: 'leech', slots: ['weapon', 'gloves', 'ring'],
    values: [[12, 0.008], [28, 0.018], [44, 0.03], [58, 0.045]],
    text: (v) => '攻击伤害的 ' + Math.round(v * 1000) / 10 + '% 转化为生命', stats: (v) => ({ lifeLeech: v }) },

  // ── 资源 / 掉宝 ──
  { id: 'p_vigor', name: '旺盛的', group: 'lifeRegen', slots: ['body', 'belt', 'boots'],
    values: [[4, 2], [18, 4.5], [34, 8], [50, 12]],
    text: (v) => '每秒回复 ' + Math.round(v * 10) / 10 + ' 点生命', stats: (v) => ({ lifeRegen: v }) },
  { id: 'p_savant', name: '博学的', group: 'manaRegen', slots: ['helmet', 'ring', 'amulet'],
    values: [[6, 1.5], [20, 3.5], [36, 6], [52, 9]],
    text: (v) => '每秒回复 ' + Math.round(v * 10) / 10 + ' 点法力', stats: (v) => ({ manaRegen: v }) },
  { id: 'p_wisdom', name: '睿智的', group: 'mana', slots: ['helmet', 'amulet', 'ring'],
    values: [[1, 18], [14, 32], [30, 50], [46, 70]],
    text: (v) => '+' + I(v) + ' 法力', stats: (v) => ({ mana: v }) },
  { id: 'p_avarice', name: '守财的', group: 'rarity', slots: ['ring', 'amulet', 'belt', 'helmet'],
    values: [[1, 0.15], [18, 0.28], [36, 0.45], [52, 0.6]],
    text: (v) => SP(v) + ' 物品稀有度', stats: (v) => ({ rarityBonus: v }) },
  { id: 'p_scholar', name: '学者的', group: 'xp', slots: ['helmet', 'amulet', 'body'],
    values: [[1, 0.06], [22, 0.12], [44, 0.2]],
    text: (v) => SP(v) + ' 获得经验', stats: (v) => ({ xpBonus: v }) },
  { id: 'p_butcher', name: '屠夫的', group: 'quantity', slots: ['gloves', 'belt', 'amulet'],
    values: [[10, 0.08], [26, 0.15], [42, 0.24], [58, 0.34]],
    text: (v) => SP(v) + ' 物品数量', stats: (v) => ({ quantityBonus: v }) },
  { id: 'p_treasure', name: '寻宝的', group: 'gold', slots: ['ring', 'belt', 'amulet'],
    values: [[1, 0.12], [24, 0.22], [46, 0.32]],
    text: (v) => SP(v) + ' 硫磺碎片掉落', stats: (v) => ({ goldFind: v }) },
]));

/**
 * 额外后缀。
 * @type {Affix[]}
 */
const EXTRA_SUFFIXES_TABLE = Object.freeze(make('suffix', [
  // ── 抗性 ──
  { id: 's_flameward', name: '之抗火', group: 'resFire', slots: ['helmet', 'shield', 'body'],
    values: [[1, 0.12], [12, 0.2], [26, 0.3], [40, 0.4], [56, 0.48]],
    text: (v) => SP(v) + ' 火焰抗性', stats: (v) => ({ fireResist: v }) },
  { id: 's_frostward', name: '之抗霜', group: 'resCold', slots: ['helmet', 'shield', 'body'],
    values: [[1, 0.12], [12, 0.2], [26, 0.3], [40, 0.4], [56, 0.48]],
    text: (v) => SP(v) + ' 冰霜抗性', stats: (v) => ({ coldResist: v }) },
  { id: 's_stormward', name: '之抗雷', group: 'resLightning', slots: ['helmet', 'shield', 'body'],
    values: [[1, 0.12], [12, 0.2], [26, 0.3], [40, 0.4], [56, 0.48]],
    text: (v) => SP(v) + ' 闪电抗性', stats: (v) => ({ lightningResist: v }) },
  { id: 's_venomward', name: '之抗毒', group: 'resChaos', slots: ['weapon', 'body', 'belt', 'boots'],
    values: [[16, 0.06], [30, 0.12], [44, 0.19], [58, 0.26]],
    text: (v) => SP(v) + ' 混沌抗性', stats: (v) => ({ chaosResist: v }) },
  { id: 's_elemental', name: '之元素', group: 'resAll', slots: ['amulet', 'belt', 'ring', 'weapon', 'gloves'],
    values: [[16, 0.04], [30, 0.08], [44, 0.12], [58, 0.16]],
    text: (v) => SP(v) + ' 所有元素抗性', stats: (v) => ({ fireResist: v, coldResist: v, lightningResist: v }) },
  { id: 's_devotion', name: '之虔诚', group: 'maxResist', slots: ['shield', 'amulet', 'helmet', 'body'],
    values: [[38, 0.02], [54, 0.03]],
    text: (v) => SP(v) + ' 各元素抗性上限', stats: (v) => ({ maxResistance: v }) },

  // ── 速度 / 暴击 ──
  { id: 's_haste', name: '之迅', group: 'attackSpeed', slots: ['weapon', 'gloves', 'ring', 'helmet'],
    values: [[1, 0.012], [16, 0.03], [32, 0.05], [48, 0.07], [60, 0.085]],
    text: (v) => SP(v) + ' 攻击速度', stats: (v) => ({ attackSpeedMult: v }) },
  { id: 's_precision', name: '之敏锐', group: 'critChance', slots: ['weapon', 'gloves', 'helmet', 'shield'],
    values: [[4, 0.01], [18, 0.02], [34, 0.032], [50, 0.044]],
    text: (v) => SP(v) + ' 暴击率', stats: (v) => ({ critChance: v }) },
  { id: 's_slayer', name: '之斩', group: 'critMulti', slots: ['weapon', 'gloves', 'belt', 'shield', 'helmet'],
    values: [[10, 0.1], [24, 0.22], [40, 0.36], [56, 0.5]],
    text: (v) => SP(v) + ' 暴击伤害加成', stats: (v) => ({ critMulti: v }) },
  { id: 's_dash', name: '之风', group: 'moveSpeed', slots: ['boots', 'amulet', 'helmet', 'body'],
    values: [[1, 0.02], [16, 0.04], [32, 0.065], [48, 0.09]],
    text: (v) => SP(v) + ' 移动速度', stats: (v) => ({ moveSpeedMult: v }) },

  // ── 伤害 ──
  { id: 's_might', name: '之力', group: 'physPct', slots: ['weapon', 'amulet', 'gloves'],
    values: [[8, 0.1], [24, 0.22], [40, 0.36], [56, 0.5]],
    text: (v) => SP(v) + ' 物理伤害', stats: (v) => ({ physDamageMult: v }) },
  { id: 's_ember', name: '之烬', group: 'firePct', slots: ['weapon', 'amulet', 'ring', 'gloves'],
    values: [[6, 0.1], [22, 0.2], [38, 0.32], [54, 0.45]],
    text: (v) => SP(v) + ' 火焰伤害', stats: (v) => ({ fireDamageMult: v }) },
  { id: 's_hoarfrost', name: '之寒', group: 'coldPct', slots: ['weapon', 'amulet', 'ring', 'gloves'],
    values: [[6, 0.1], [22, 0.2], [38, 0.32], [54, 0.45]],
    text: (v) => SP(v) + ' 冰霜伤害', stats: (v) => ({ coldDamageMult: v }) },
  { id: 's_tempest', name: '之风暴', group: 'lightningPct', slots: ['weapon', 'amulet', 'ring', 'gloves'],
    values: [[6, 0.1], [22, 0.2], [38, 0.32], [54, 0.45]],
    text: (v) => SP(v) + ' 闪电伤害', stats: (v) => ({ lightningDamageMult: v }) },
  { id: 's_plague', name: '之枯萎', group: 'dot', slots: ['weapon', 'gloves', 'ring'],
    values: [[18, 0.1], [32, 0.18], [46, 0.28], [58, 0.4]],
    text: (v) => SP(v) + ' 持续伤害', stats: (v) => ({ dotMult: v }) },

  // ── 防御 ──
  { id: 's_bulwark', name: '之壁垒', group: 'armor', slots: ['body', 'shield', 'helmet', 'boots'],
    values: [[4, 28], [18, 55], [34, 84], [50, 116]],
    text: (v) => '+' + I(v) + ' 护甲', stats: (v) => ({ armor: v }) },
  { id: 's_shadow', name: '之影', group: 'evasion', slots: ['body', 'gloves', 'boots', 'helmet'],
    values: [[4, 0.025], [18, 0.05], [34, 0.085], [50, 0.12]],
    text: (v) => SP(v) + ' 闪避率', stats: (v) => ({ evasion: v }) },
  { id: 's_parry', name: '之御', group: 'blockChance', slots: ['shield', 'ring', 'helmet'],
    values: [[12, 0.02], [28, 0.04], [44, 0.065], [58, 0.09]],
    text: (v) => SP(v) + ' 格挡几率', stats: (v) => ({ blockChance: v }) },
  { id: 's_revenge', name: '之反击', group: 'thorns', slots: ['body', 'shield', 'gloves'],
    values: [[8, 10], [24, 22], [40, 36], [56, 48]],
    text: (v) => '反弹 ' + I(v) + ' 点伤害', stats: (v) => ({ thorns: v }) },
  { id: 's_barrier', name: '之护幕', group: 'energyShield', slots: ['body', 'shield', 'helmet'],
    values: [[8, 14], [22, 30], [38, 50], [54, 68]],
    text: (v) => '+' + I(v) + ' 能量护盾', stats: (v) => ({ energyShield: v }) },

  // ── 生命 / 资源 ──
  { id: 's_fortitude', name: '之坚', group: 'life', slots: ['body', 'helmet', 'shield', 'boots', 'gloves'],
    values: [[1, 16], [14, 30], [30, 48], [46, 66], [58, 76]],
    text: (v) => '+' + I(v) + ' 生命', stats: (v) => ({ life: v }) },
  { id: 's_vitality', name: '之元气', group: 'lifeRegen', slots: ['body', 'belt', 'boots'],
    values: [[6, 2.5], [20, 5.5], [36, 9], [52, 13]],
    text: (v) => '每秒回复 ' + Math.round(v * 10) / 10 + ' 点生命', stats: (v) => ({ lifeRegen: v }) },
  { id: 's_mind', name: '之智', group: 'mana', slots: ['helmet', 'amulet', 'ring'],
    values: [[2, 22], [16, 36], [32, 54], [48, 72]],
    text: (v) => '+' + I(v) + ' 法力', stats: (v) => ({ mana: v }) },
  { id: 's_vampire', name: '之吸魂', group: 'leech', slots: ['weapon', 'gloves', 'ring', 'helmet'],
    values: [[12, 0.007], [30, 0.016], [46, 0.028], [58, 0.04]],
    text: (v) => '攻击伤害的 ' + Math.round(v * 1000) / 10 + '% 转化为生命', stats: (v) => ({ lifeLeech: v }) },
  { id: 's_thirst', name: '之渴', group: 'lifeOnHit', slots: ['weapon', 'ring', 'gloves'],
    values: [[8, 3], [22, 7], [38, 12], [54, 16]],
    text: (v) => '击中时回复 ' + I(v) + ' 点生命', stats: (v) => ({ lifeOnHit: v }) },

  // ── 冷却 / 范围 / 技能 ──
  { id: 's_time', name: '之时序', group: 'cdr', slots: ['helmet', 'belt', 'ring', 'amulet', 'gloves'],
    values: [[14, 0.03], [30, 0.07], [46, 0.12], [58, 0.16]],
    text: (v) => SP(v) + ' 冷却缩减', stats: (v) => ({ cdrMult: v }) },
  { id: 's_amplify', name: '之amplify', group: 'aoe', slots: ['weapon', 'shield', 'gloves', 'helmet'],
    values: [[14, 0.03], [30, 0.06], [46, 0.09], [58, 0.12]],
    text: (v) => SP(v) + ' 范围效果', stats: (v) => ({ aoeMult: v }) },
  { id: 's_impact', name: '之冲击', group: 'areaDamage', slots: ['weapon', 'gloves', 'belt', 'shield'],
    values: [[20, 0.1], [34, 0.18], [48, 0.28], [58, 0.36]],
    text: (v) => SP(v) + ' 范围伤害', stats: (v) => ({ areaDamageMult: v }) },
  { id: 's_swift_bolt', name: '之疾矢', group: 'projSpeed', slots: ['weapon', 'gloves', 'helmet'],
    values: [[10, 0.1], [26, 0.22], [42, 0.36], [56, 0.48]],
    text: (v) => SP(v) + ' 投射物速度', stats: (v) => ({ projectileSpeedMult: v }) },

  // ── 掉宝 / 经验 ──
  { id: 's_fortune', name: '之财富', group: 'rarity', slots: ['ring', 'amulet', 'belt', 'helmet'],
    values: [[1, 0.1], [20, 0.22], [38, 0.36], [54, 0.48]],
    text: (v) => SP(v) + ' 物品稀有度', stats: (v) => ({ rarityBonus: v }) },
  { id: 's_greed', name: '之囤积', group: 'quantity', slots: ['ring', 'belt', 'amulet', 'gloves'],
    values: [[10, 0.06], [26, 0.13], [42, 0.21], [58, 0.3]],
    text: (v) => SP(v) + ' 物品数量', stats: (v) => ({ quantityBonus: v }) },
  { id: 's_insight', name: '之领悟', group: 'xp', slots: ['amulet', 'helmet', 'body', 'ring'],
    values: [[1, 0.05], [24, 0.11], [46, 0.18]],
    text: (v) => SP(v) + ' 获得经验', stats: (v) => ({ xpBonus: v }) },
  { id: 's_bounty', name: '之赏金', group: 'gold', slots: ['ring', 'belt', 'gloves', 'helmet'],
    values: [[1, 0.1], [26, 0.2], [48, 0.32]],
    text: (v) => SP(v) + ' 硫磺碎片掉落', stats: (v) => ({ goldFind: v }) },
]));

export const EXTRA_PREFIXES = EXTRA_PREFIXES_TABLE;
export const EXTRA_SUFFIXES = EXTRA_SUFFIXES_TABLE;
