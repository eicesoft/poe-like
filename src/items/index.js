// @file src/items/index.js
// 物品 / 天赋 / 技能数据的统一出口。
//
// 其他模块推荐这样 import：
//   import { ITEM_SLOTS, SLOTS, SLOT_NAMES, generateItem, generateDrop, itemStatLines, itemToTooltipHTML, itemScore } from '../items/index.js';
//   import { TALENTS, talentById, START_NODE } from '../items/index.js';
//   import { SKILL_TREES, skillNodeById, skillEffectsForSkill } from '../items/index.js';
//
// 纯数据 + 纯函数，不依赖任何浏览器 API / three / DOM。

// ── 公共定义 / 工具 ──
export {
  STAT_KEYS, STAT_KEY_SET, EXTRA_STAT_KEYS, ITEM_STAT_KEYS, ITEM_STAT_KEY_SET,
  DMG_KEYS, DAMAGE_PAIRS, PERCENT_KEYS,
  fmt, fmtInt, fmtPct, fmtSigned, escapeHTML, getRNG, adaptRNG, seedFromString,
} from './common.js';

// ── 基底 / 槽位 ──
// ITEM_SLOTS 是 item.slot 的取值域（weapon/shield/helmet/body/gloves/boots/ring/amulet/belt）；
// SLOTS 是 UI 上的装备格子（含 offhand/ring1/ring2），两者不要混用。
export {
  BASE_ITEMS, BASE_BY_ID, ITEM_SLOTS, SLOTS, SLOT_NAMES, ITEM_SLOT_NAMES, SLOT_ACCEPTS, BASE_SLOT_NAMES,
  baseById, basesForSlot, basesForEquipSlot, basesForLevel, pickBase, elementColor,
} from './bases.js';

// ── 稀有度 ──
export {
  RARITY, RARITY_KEYS, RARITY_RANK, BASE_CHANCES,
  rollRarity, rarityName, rarityColor, rarityChances, rollAffixCount,
} from './rarity.js';

// ── 词缀 ──
export {
  PREFIXES, SUFFIXES, ALL_AFFIXES, AFFIX_BY_ID, AFFIX_GROUPS,
  RESIST_KEYS, RESIST_NAMES,
  affixById, bestTierForLevel, affixesForSlot, rollAffixes, statsToText,
} from './affixes.js';

// ── 传奇 ──
export { UNIQUES, UNIQUE_BY_ID, uniqueById, uniquesForLevel, tryUnique, validateUniques } from './unique.js';

// ── 物品生成（核心接口）──
export {
  generateItem, generateDrop, rerollItem, fallbackItem, preferredEquipSlot,
  itemStatLines, itemScore, itemToTooltipHTML,
  rollWeaponDamage, mergeStats, statLineText, basesFor,
} from './itemgen.js';

// ── 天赋树 ──
export {
  TALENTS, TALENT_BY_ID, TALENT_GRAPH, START_NODE, BRANCHES, RING_RADII, SPOKE_RADII,
  CENTER_RADII, KEYSTONE_RADIUS,
  talentById, neighborsOf, reachableFrom, canAllocate, aggregateTalentStats, talentStats, legendaryTraits,
} from './talentTree.js';

// ── 法师天赋树 ──
export {
  MAGE_TALENTS, MAGE_TALENT_BY_ID, MAGE_TALENT_GRAPH, MAGE_START_NODE, MAGE_BRANCHES, MAGE_RING_RADII,
  mageTalentById, mageReachableFrom, aggregateMageTalentStats, mageTalentStats,
} from './mageTalentTree.js';

// ── 天赋树选择器（按职业） ──
export { talentTreeFor, talentNodesOf, talentStartOf, WARRIOR_TALENT_TREE, MAGE_TALENT_TREE } from './talentTrees.js';

// ── 技能树（战士 5 + 法师 5） ──
export {
  SKILL_TREES, SKILL_IDS, SKILL_NODES, SKILL_NODE_BY_ID,
  skillNodeById, skillTreeOf, skillEffectsForSkill, skillPointsSpent, canUpgradeSkillNode,
} from './skillTree.js';

// ── 法师技能分叉树数据 ──
export { MAGE_SKILL_TREE_IDS, MAGE_SKILL_TREE_SPECS } from './mageSkillTrees.js';

import { itemScore, itemStatLines } from './itemgen.js';

/**
 * 物品战力比较：返回 { score, other, diff, better }。
 * UI 做「装备对比」时可直接用。
 * @param {Object} a 候选物品
 * @param {Object|null} b 当前装备
 * @returns {{score:number, other:number, diff:number, better:boolean}}
 */
export function compareItems(a, b) {
  const sa = itemScore(a);
  const sb = b ? itemScore(b) : 0;
  return { score: sa, other: sb, diff: sa - sb, better: sa > sb };
}

/**
 * 一件物品的完整摘要（调试 / 日志 / 战斗日志用）。
 * @param {Object} item
 * @returns {string}
 */
export function describeItem(item) {
  if (!item) return '';
  const lines = itemStatLines(item).map((l) => `  ${l.text}`);
  return [
    `[${item.rarityName}] ${item.name}（${item.typeName}，物品等级 ${item.itemLevel}）`,
    ...lines,
    `  战力：${itemScore(item)}`,
  ].join('\n');
}