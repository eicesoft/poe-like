// @file src/items/skillProgression.js
// 技能升级（技能精炼石）/ 重置天赋 的数据与纯函数。
//
// 【硬约束】纯数据 + 纯函数，不 import 浏览器 API / three / DOM —— 必须能在 Node 下跑。
// 这里**不依赖** src/game/*，只操作传入的 inv / player 对象，方便测试与 core 复用。
//
// ─── 技能等级公式（契约 §0 / §3.4）──────────────────────────────────────────
//   技能等级 = min(5, 1 + 天赋已投入点数 + 精炼等级)
//   · 天赋点数 = 该技能的「已点节点数」（不管每节点的档位，哪怕 ROOT 点到 3 档也只算 1 点）
//     —— 为什么按节点而不是按档位？因为「技能等级」是用来给整个技能上强度的，
//        按档位算会让 ROOT 这种 maxRank 3 的节点一个人吃掉 3 级，支线就没人点了。
//        档位本身已经通过 skillEffectsForSkill 提供了数值，两条曲线不重复计。
//   · 精炼 0..4（REFINE_MAX），天赋点 + 精炼互相叠加、共同封顶在 5 级。
//   · 满 5 级需要「4 个节点 + 1 次精炼」之类组合，所以两条成长路径都值得走。
//
// ─── 精炼石（inv.skillOrbs）─────────────────────────────────────────────────
//   掉落由 core 的 loot.js 产生（kind:'skillOrb'），app 的 updateAutoPickup 收进 inv.skillOrbs。
//   花费用 refineCost(level, refine)：1→2 需 3 个、2→3 需 4、3→4 需 6、4→5 需 8（共 21 个到满精炼）。
//
// ─── 重置天赋（respec）──────────────────────────────────────────────────────
//   花费 respecCost：2 + 已点节点数（技能精炼石）。
//   **返还所有技能点**，并**保留精炼等级**（精炼石是花在技能上的永久投资，重置的是天赋路线）。
//   精炼石本身不退还 —— 它已经变成技能等级了；退的是「技能点」。

import { skillTreeOf, skillPointsSpent, validateSkillRanks, resolveSkillNodeId } from './skillTree.js';

/** 技能等级上限（含天赋 + 精炼） */
export const SKILL_LEVEL_CAP = 5;
/** 精炼等级上限（0..4） */
export const REFINE_MAX = 4;
/** 单次精炼消耗的技能精炼石数量，下标 = 当前技能等级 - 1 */
export const REFINE_COSTS = Object.freeze([3, 4, 6, 8]);
/** 每个技能一个空精炼等级表（UI 初始化用） */
export const REFINE_INFO = Object.freeze({
  icon: '💠',
  name: '技能精炼石',
  desc: '击杀怪物获得，用于精炼技能（提升技能等级）。',
});

/**
 * 攻击某个精炼档位需要的精炼石数量。
 *
 * 【参数口径】level 是「要升到的目标技能等级」（2..5），refine 是「当前精炼等级」。
 * 两者写哪个都行，只要和目标等级一致：
 *   refineCost(2, 0) = refineCost(1, 0) = 3
 *   refineCost(3, 1) = refineCost(2, 1) = 4
 * 只给 level 时按「天赋点为 0、纯靠精炼」推导当前精炼 = level - 1（UI 常见用法）。
 *
 * @param {number} level 当前（或目标-1）技能等级
 * @param {number} [refine] 当前精炼等级（0..4），省略则按 level - 1
 * @returns {number} 0 = 已满，无法再精炼
 */
export function refineCost(level, refine) {
  let lv = Math.floor(Number(level) || 0);
  if (lv >= SKILL_LEVEL_CAP) return 0;
  const rf = refine == null
    ? Math.max(0, lv - 1)
    : Math.max(0, Math.min(REFINE_MAX - 1, Math.floor(Number(refine) || 0)));
  if (rf >= REFINE_MAX) return 0;
  return REFINE_COSTS[rf];
}

/**
 * 技能等级 = 1 + 天赋已点节点数 + 精炼等级，封顶 cap。
 *
 * @param {Record<string, number>} ranks 该技能的档位表 { nodeId|短名: rank }
 * @param {number} refine 精炼等级（0..4）
 * @param {number} [cap=SKILL_LEVEL_CAP]
 * @returns {number} 1..cap
 */
export function skillLevelFrom(ranks, refine, cap = SKILL_LEVEL_CAP) {
  const r = Math.max(0, Math.floor(Number(refine) || 0));
  const nodes = countAllocatedNodes(ranks);
  const lv = 1 + nodes + Math.min(r, REFINE_MAX);
  return Math.max(1, Math.min(Math.floor(cap) || SKILL_LEVEL_CAP, lv));
}

/**
 * 已点节点数（每个节点只要 rank≥1 就算 1 点，不管点到第几档）。
 *
 * 同时兼容「短名」与「全名」两种键，并且**两种键混用时不会重复计数**：
 *   countAllocatedNodes({ 'stomp.root': 3, root: 1 }) === 1
 * 只统计技能树里真实存在的节点：老存档里已删除的节点（例如旧的 groundSlam.*）不计入，
 * 避免技能等级虚高。传入 skillId 时只统计该技能。
 *
 * @param {Record<string, number>} ranks
 * @param {string} [skillId] 指定技能时只统计该技能的节点
 * @returns {number}
 */
export function countAllocatedNodes(ranks, skillId) {
  if (!ranks || typeof ranks !== 'object') return 0;
  /** @type {Set<string>} */
  const seen = new Set();
  for (const k in ranks) {
    const v = Number(ranks[k]);
    if (!Number.isFinite(v) || v <= 0) continue;
    // 键可能是短名（'root'）也可能是全名（'stomp.root'）：统一用 skillTree 的解析入口，
    // 不要自己 split('.')（早期版本这样写，传入全名时查到的是 'stomp.stomp.root' → 数出 0）。
    let sid = skillId;
    let node = null;
    if (sid) {
      node = resolveSkillNodeId(sid, k);
      if (!node) {
        // 该技能树里查不到，但可能是别的技能的全名 → 跳过（指定了 skillId 就只认本技能）
        continue;
      }
    } else {
      // 没指定技能：全名先按前缀定技能，短名无法确定归属 → 忽略（调用方应传 skillId）
      if (!k.includes('.')) continue;
      sid = k.slice(0, k.indexOf('.'));
      node = resolveSkillNodeId(sid, k);
      if (!node) continue;
    }
    if (node.skillId !== sid) continue;
    seen.add(node.id);
  }
  return seen.size;
}

/**
 * 取某技能的精炼等级（缺省 0，并裁剪到 0..REFINE_MAX）。
 * @returns {number} 永远是纯数字 —— 内部计算与兼容旧调用都用它。
 *   需要「是否已满级/该怎么显示」请用 refineDisplayState()。
 */
export function skillRefineOf(inv, skillId) {
  const r = inv && inv.skillRefine ? Number(inv.skillRefine[skillId]) : 0;
  if (!Number.isFinite(r)) return 0;
  return Math.max(0, Math.min(REFINE_MAX, Math.floor(r)));
}

/**
 * 精炼条该**怎么显示**（UI 专用，数据 + 文案都给好，UI 不用自己推）。
 *
 * 解决的问题：技能等级可能是靠「天赋点」顶到 5 级的，此时精炼还是 0/4。
 * 如果 UI 照常显示「精炼 0/4」+ 灰按钮，玩家会以为「精炼坏了」。
 * 这里给出 capped=true 与一段人话 label，UI 直接渲染成「已满级」即可。
 *
 * @param {Object} inv
 * @param {string} skillId
 * @returns {{
 *   refine:number, max:number, level:number, levelCap:number,
 *   capped:boolean,               // 技能等级已到上限 5（精炼已无意义）
 *   cappedBy:'talent'|'refine'|'',// 满级来源：天赋顶满 / 精炼 4 级
 *   nextCost:number|null,         // 再精炼一次要几颗；null = 不可精炼（满级）
 *   label:string,                 // 直接显示在精炼条右侧的人话，例如 '已满级（天赋顶满）'
 *   pips:string                   // '0/4' / '4/4' —— 满级时 UI 可改用 label 覆盖
 * }}
 */
export function refineDisplayState(inv, skillId) {
  const refine = skillRefineOf(inv, skillId);
  const level = skillLevelOf(inv, skillId);
  const talentPoints = countAllocatedNodes(skillRanksOf(inv, skillId), skillId);
  const capped = level >= SKILL_LEVEL_CAP;
  let cappedBy = '';
  if (capped) cappedBy = refine >= REFINE_MAX ? 'refine' : 'talent';
  else if (refine >= REFINE_MAX) cappedBy = 'refine';
  const nextCost = capped || refine >= REFINE_MAX ? null : refineCost(level, refine) || null;
  let label;
  if (!capped && refine < REFINE_MAX) label = `精炼 ${refine}/${REFINE_MAX}`;
  else if (capped && cappedBy === 'talent') label = `已满级（天赋 ${talentPoints} 点顶满）`;
  else if (refine >= REFINE_MAX && capped) label = `已满级（精炼 ${REFINE_MAX}/${REFINE_MAX}）`;
  else label = `精炼已满（${refine}/${REFINE_MAX}）`;
  return {
    refine, max: REFINE_MAX, level, levelCap: SKILL_LEVEL_CAP,
    capped, cappedBy, nextCost, label, pips: `${refine}/${REFINE_MAX}`,
  };
}

/** 取某技能的档位表（只含该技能的节点，丢失时返回 {}）。 */
export function skillRanksOf(inv, skillId) {
  const out = {};
  if (!inv || !inv.skillRanks) return out;
  const prefix = skillId + '.';
  for (const k in inv.skillRanks) {
    if (k.startsWith(prefix)) out[k] = inv.skillRanks[k];
  }
  // 兼容短名写法（历史数据 / 手工测试）：{ stomp: { root: 2 } } 或 { root: 2 } 的扁平数据
  if (!Object.keys(out).length) {
    for (const k in inv.skillRanks) {
      if (!k.includes('.')) out[`${prefix}${k}`] = inv.skillRanks[k];
    }
  }
  return out;
}

/**
 * 当前技能等级（天赋 + 精炼）。
 * @param {Object} inv
 * @param {string} skillId
 * @returns {number}
 */
export function skillLevelOf(inv, skillId) {
  return skillLevelFrom(skillRanksOf(inv, skillId), skillRefineOf(inv, skillId));
}

/**
 * 能否精炼：等级未满 + 精炼未满 + 石头够。
 *
 * 【返回字段】
 *   ok            能否精炼（只有这一项为 true 时 app 才会真扣石头）
 *   reason        给玩家看的**人话**原因（UI 直接塞进 tooltip / 日志，不要塞英文码）
 *   cost          本次精炼要花几颗石头（不可精炼时是「如果能精炼会花多少」，满级为 0）
 *   have          当前拥有的精炼石
 *   capped        技能等级已顶到上限 5（无论是靠天赋还是靠精炼）→ UI 应把精炼条显示成
 *                 「已满级」而不是「精炼 0/4」；否则玩家会困惑「有 4 格却一格都点不了」
 *   cappedBy      满级的原因：'talent'（天赋点顶满，精炼没用了）| 'refine'（精炼已 4 级）| ''
 *   level/refine  当前技能等级 / 精炼等级，UI 省一次重复计算
 *
 * @param {Object} inv 背包（读 inv.skillOrbs / inv.skillRanks / inv.skillRefine）
 * @param {Object} player 玩家（只读，用于确认技能在技能栏里；可为 null）
 * @param {string} skillId
 * @returns {{ok:boolean, reason:string, cost:number, have:number,
 *   capped:boolean, cappedBy:'talent'|'refine'|'', level:number, refine:number}}
 */
export function canRefineSkill(inv, player, skillId) {
  const have = Math.max(0, Math.floor(Number(inv && inv.skillOrbs) || 0));
  const refine = skillRefineOf(inv, skillId);
  const level = skillLevelOf(inv, skillId);
  /** 统一的失败返回：所有分支都带齐字段，UI 不用判 undefined */
  const no = (reason, cost, extra = {}) => ({
    ok: false, reason, cost, have, capped: false, cappedBy: '', level, refine, ...extra,
  });

  if (!skillTreeOf(skillId).nodes.length && !(player && hasSkill(player, skillId))) {
    return no('技能不存在', 0);
  }
  // 1) 精炼已经 4 级：格子确实点完了，文案说清楚
  if (refine >= REFINE_MAX) {
    return no(
      `精炼已满（${REFINE_MAX}/${REFINE_MAX}），技能等级 Lv.${level}/${SKILL_LEVEL_CAP}`,
      0,
      { capped: level >= SKILL_LEVEL_CAP, cappedBy: 'refine' },
    );
  }
  // 2) 等级已封顶但精炼还有空位（典型：天赋点满 Lv.5，精炼条却显示 0/4）
  //    这是最容易被玩家误解的态：必须明确告诉玩家「不用再精炼了」，而不是含糊的「技能等级已满」
  if (level >= SKILL_LEVEL_CAP) {
    const talentPoints = countAllocatedNodes(skillRanksOf(inv, skillId), skillId);
    const why = talentPoints >= SKILL_LEVEL_CAP - 1
      ? `天赋已把技能顶满 Lv.${SKILL_LEVEL_CAP}，暂不需精炼`
      : `技能已达 Lv.${SKILL_LEVEL_CAP} 上限（天赋 ${talentPoints} 点 + 精炼 ${refine} 级），暂不需精炼`;
    return no(`已满级（${why}）`, 0, { capped: true, cappedBy: 'talent' });
  }
  // 3) 正常路径：石头够不够
  const cost = refineCost(level, refine);
  if (cost <= 0) {
    // 兜底：refineCost 返回 0 说明没有下一档（理论上被上面两条拦住，防御性保留）
    return no(`已满级（Lv.${SKILL_LEVEL_CAP} 为上限）`, 0, { capped: true, cappedBy: 'refine' });
  }
  if (have < cost) {
    return no(`精炼石不足（需要 ${cost} 颗，现有 ${have} 颗）`, cost);
  }
  return { ok: true, reason: '', cost, have, capped: false, cappedBy: '', level, refine };
}

/**
 * 精炼技能：消耗石头 → inv.skillRefine[skillId] += 1，并把等级写回技能栏实例。
 * 调用方（app）负责 recalcPlayer + 推事件。
 *
 * @param {Object} inv
 * @param {Object} player
 * @param {string} skillId
 * @returns {boolean} 是否成功
 */
export function refineSkill(inv, player, skillId) {
  const chk = canRefineSkill(inv, player, skillId);
  if (!chk.ok) return false;
  inv.skillOrbs = Math.max(0, Math.floor(Number(inv.skillOrbs) || 0) - chk.cost);
  if (!inv.skillRefine || typeof inv.skillRefine !== 'object') inv.skillRefine = {};
  inv.skillRefine[skillId] = skillRefineOf(inv, skillId) + 1;
  syncSkillInstances(inv, player);
  return true;
}

/**
 * 重置单个技能的天赋树需要多少精炼石：2 + 已点**节点数**。
 *
 * 【口径】按「点过的节点个数」而不是「档位之和」——一个节点点 3 档仍算 1 点。
 * 这样重置换一条路线时的成本只跟「换了多少个节点」有关，不会因为 ROOT 点到 3 档就翻倍
 * （技能等级 skillLevelFrom 用的是同一口径，两处保持一致）。
 *
 * 【第 2 个参数接受三种写法，方便各层调用】
 *   respecCost(skillId)                       → 只给技能 id：返回**基础花费 2**
 *   respecCost(skillId, ranks)                → 2 + 该技能已点节点数（其它技能的不算）
 *   respecCost(skillId, inv)                  → 同样算出 2 + 节点数（自动取 inv.skillRanks）
 *
 * 「只给 skillId 返回 2」是刻意的：纯函数不能偷偷读全局状态（否则同一份代码在不同调用点
 * 会得到不同结果，且无法测试）。需要真实价格时由调用方把 inv / ranks 传进来 ——
 * app 的 doSkillRespec 与 UI 的 respecButton 都是这么做的。
 *
 * @param {string} skillId
 * @param {Record<string,number>|Object|number} [ranksOrInv] 档位表 / inv / 已点节点数
 * @returns {number}
 */
export function respecCost(skillId, ranksOrInv) {
  if (typeof ranksOrInv === 'number') return 2 + Math.max(0, Math.floor(ranksOrInv));
  const src = ranksOrInv && typeof ranksOrInv === 'object' ? ranksOrInv : {};
  // 传的是 inv（{ skillRanks: {...} }）→ 取 skillRanks；传的是纯档位表 → 直接用
  const table = src.skillRanks && typeof src.skillRanks === 'object' ? src.skillRanks : src;
  return 2 + countAllocatedNodes(table, skillId);
}

/**
 * 重置单个技能的天赋树：
 *   · 消耗 respecCost(skillId, ranks) 个精炼石（石头不够 → false，什么都不改）
 *   · 清空该技能的全部 rank（技能点自然回到「未分配」池）
 *   · 保留精炼等级（精炼石已经变成技能等级，不退还）
 *
 * @param {Object} inv
 * @param {Object} player
 * @param {string} skillId
 * @returns {boolean}
 */
export function respecSkill(inv, player, skillId) {
  if (!inv || typeof inv !== 'object') return false;
  const ranks = skillRanksOf(inv, skillId);
  const nodes = countAllocatedNodes(ranks, skillId);
  if (nodes <= 0) return false; // 没点过：无需重置（不白花石头）
  const cost = respecCost(skillId, ranks);
  const have = Math.max(0, Math.floor(Number(inv.skillOrbs) || 0));
  if (have < cost) return false;
  inv.skillOrbs = have - cost;
  const prefix = skillId + '.';
  for (const k of Object.keys(inv.skillRanks || {})) {
    if (k.startsWith(prefix)) delete inv.skillRanks[k];
  }
  syncSkillInstances(inv, player);
  return true;
}

/**
 * 把「技能等级 / 精炼等级」写回 player.skillBar[i].level / .refine，
 * 并顺带写 player.skills[skillId] = { level, refine, talentPoints, total }。
 *
 * 【level 的口径：完整技能等级】= 1 + 天赋节点数 + 精炼。
 * 为什么这里不扣掉精炼：本模块必须能独立使用（UI / 测试 / 存档修复都会直接调它），
 * 「扣精炼」是 core 的 skillsUpgrade.skillLevelOf 的特殊读法造成的，属于 app 层与 core 的衔接细节，
 * 由 app 的 syncSkillSystems 统一处理（它写 player.skills 时把 level 扣成 1+天赋点）。
 * 单独调用本函数的人拿到的 level 也是正确的人类可读等级。
 *
 * @param {Object} inv
 * @param {Object} player
 * @returns {void}
 */
export function syncSkillInstances(inv, player) {
  if (!player || !Array.isArray(player.skillBar)) return;
  if (!player.skills || typeof player.skills !== 'object') player.skills = {};
  for (const inst of player.skillBar) {
    if (!inst || !inst.id) continue;
    const level = skillLevelOf(inv, inst.id);
    const refine = skillRefineOf(inv, inst.id);
    const talentPoints = countAllocatedNodes(skillRanksOf(inv, inst.id), inst.id);
    inst.level = level;
    inst.refine = refine;
    const prev = player.skills[inst.id];
    player.skills[inst.id] = {
      ...(prev && typeof prev === 'object' ? prev : {}),
      level, refine, talentPoints, total: level,
    };
  }
}

/**
 * 某技能还能点多少点（技能树总点数 - 已花点数）。UI 进度条用。
 * @param {Object} inv
 * @param {string} skillId
 * @returns {{spent:number, total:number}}
 */
export function skillPointUsage(inv, skillId) {
  const tree = skillTreeOf(skillId);
  let total = 0;
  for (const n of tree.nodes) total += n.cost * n.maxRank;
  return { spent: skillPointsSpent(skillId, skillRanksOf(inv, skillId)), total };
}

/**
 * 清洗一副 ranks（互斥/前置/超档全量校验），返回修复后的副本。
 * 存档读取 / app 初始化时用。
 * @param {string} skillId
 * @param {Record<string,number>} ranks
 * @returns {Record<string,number>}
 */
export function sanitizeSkillRanks(skillId, ranks) {
  const res = validateSkillRanks(skillId, ranks || {});
  return res.fixedRanks;
}

function hasSkill(player, skillId) {
  const bar = player && player.skillBar;
  return Array.isArray(bar) && bar.some((b) => b && b.id === skillId);
}

/** 该技能已点节点数（供 UI 快速读取）。 */
export { countAllocatedNodes as skillNodeCount };

export default {
  SKILL_LEVEL_CAP, REFINE_MAX, REFINE_COSTS,
  refineCost, skillLevelFrom, canRefineSkill, refineSkill, respecCost, respecSkill,
  syncSkillInstances, skillLevelOf, skillRefineOf, refineDisplayState, skillRanksOf, countAllocatedNodes,
};