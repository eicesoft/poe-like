// @file src/items/talentTrees.js
// 天赋树选择器：根据职业返回对应的天赋树数据。
//
// 游戏里同时存在两棵树（各 70 节点，数量与构筑深度对齐）：
//   · 战士 —— items/talentTree.js 的 6 主干 + 内环网络
//   · 法师 —— items/mageTalentTree.js 的 4 主干 + 内外环网络
//
// app / UI / 存档都通过本模块取「当前职业的树」，避免每处各写一遍 if (mage)。

import {
  TALENTS, TALENT_BY_ID, START_NODE, BRANCHES,
  talentById, reachableFrom,
} from './talentTree.js';
import {
  MAGE_TALENTS, MAGE_TALENT_BY_ID, MAGE_START_NODE, MAGE_BRANCHES,
  mageTalentById, mageReachableFrom,
} from './mageTalentTree.js';

/** 战士天赋树（默认）。 */
export const WARRIOR_TALENT_TREE = Object.freeze({
  id: 'warrior',
  nodes: TALENTS,
  byId: TALENT_BY_ID,
  start: START_NODE,
  branches: BRANCHES,
  title: '天赋树',
  byIdOf: talentById,
  reachable: reachableFrom,
});

/** 法师天赋树。 */
export const MAGE_TALENT_TREE = Object.freeze({
  id: 'mage',
  nodes: MAGE_TALENTS,
  byId: MAGE_TALENT_BY_ID,
  start: MAGE_START_NODE,
  branches: MAGE_BRANCHES,
  title: '天赋树 · 元素法师',
  byIdOf: mageTalentById,
  reachable: mageReachableFrom,
});

/**
 * 按职业取天赋树。
 * @param {'warrior'|'mage'|string} [classId]
 * @returns {typeof WARRIOR_TALENT_TREE | typeof MAGE_TALENT_TREE}
 */
export function talentTreeFor(classId) {
  return classId === 'mage' ? MAGE_TALENT_TREE : WARRIOR_TALENT_TREE;
}

/**
 * 取一个玩家/职业对应的节点字典 { id: node }。
 * @param {'warrior'|'mage'|string} [classId]
 */
export function talentNodesOf(classId) {
  return talentTreeFor(classId).byId;
}

/**
 * 取一个玩家/职业对应的起点 id。
 * @param {'warrior'|'mage'|string} [classId]
 */
export function talentStartOf(classId) {
  return talentTreeFor(classId).start;
}

export default { talentTreeFor, talentNodesOf, talentStartOf, WARRIOR_TALENT_TREE, MAGE_TALENT_TREE };