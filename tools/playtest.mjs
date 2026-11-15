#!/usr/bin/env node
// @file tools/playtest.mjs
// 无头自动通关测试机器人（playtest bot）+ 数值平衡测量。
//
// 用法:
//   node tools/playtest.mjs --minutes 10 --seed 42 [--tier 1] [--verbose]
//   node tools/playtest.mjs --minutes 3 --seed 7 --json out/report.json
//
// 退出码: 0 = 跑完且无异常/无 NaN；1 = 有异常 / NaN / 硬上限突破。
//
// 机器人只通过 updateGame 的 input 与 app.js 导出的动作函数操作游戏（不改核心状态）：
//   1. 找最近活怪 → 朝它移动；进入普攻射程就按住攻击；贴身时循环按住旋风斩
//   2. 战争践踏（stomp）在「周围 ≥2 只怪」或「最近怪 ≤3.8」时放（控制技 + 命中越多护甲越高）；
//      战吼在被 ≥3 只包围时放；血性狂暴/图腾常驻
//   3. 血量 < 35% → 朝最近怪反方向跑（+翻滚），优先去捡 'life' 生命魂火
//   4. 死亡 → revivePlayer(game) 继续
//   5. 升级 → 自动点天赋（只点与已点节点相邻者）+ 自动加技能树点数（互斥节点失败即跳过）
//   6. 技能精炼石（inv.skillOrbs）→ 自动精炼伤害占比最高的技能（stomp / whirlwind），
//      始终留 RESERVE_ORBS 颗备用以支持 respec；互斥分叉选了以后可以花石头重置改派
//   7. 地上有掉落 → 走过去 doPickup；背包满 → doSellAllJunk；更好的装备 → doEquipFromBag
//   8. 每 2-4 分钟（游戏时间）travelToNewMap 进入下一层
//
// 【依赖降级】技能升级 / 精炼石是并行开发的模块：src/items/skillProgression.js、app.js 的
// doSkillRefine / doSkillRespec / skillPointsTotal。本文件全部用 **命名空间 import + typeof 判型**，
// 任何一方还没就绪（模块不存在 / 没导出该函数）时只是「跳过对应增强」，绝不抛异常、不影响跑测。
// 需要「新增的好东西」时改 skillProgression() 取到的对象即可，不要在顶层写具名 import。
//
// 关键接口事实（写机器人前核实过 src/game/app.js、src/core/*）：
//   - loadMap 会重置 world.stats（kills/waves 归零），且会清空 world.items / world.lootOrbs，
//     所以「换图前把地上掉落捡完」是必须的，否则掉落数据会被吞掉。
//   - 天赋点在 player.talentPoints，但点天赋读 inv.talentPoints（createPlayer 里没有再同步）
//     → 见 syncTalentPoints()。
//   - world.stats.kills 每张图重置，所以本报告用事件统计自己的击杀数。
//   - world.events 由渲染层 clearEvents；headless 下必须自己清，否则 600 上限会挤掉事件。

import * as appMod from '../src/game/app.js';
import {
  createGame, updateGame, clearEvents,
  doPickup, doEquipFromBag, doSellAllJunk, doTakeTalent, doSkillRankUp, skillPointsFor,
  travelToNewMap, revivePlayer, canTakeTalent,
} from '../src/game/app.js';
import { TALENTS, START_NODE } from '../src/items/talentTree.js';
import * as skillTreeMod from '../src/items/skillTree.js';
import { SKILL_TREES } from '../src/items/skillTree.js';
import { itemScore as genItemScore } from '../src/items/itemgen.js';
// core 的战斗等级口径（skillsUpgrade.skillLevelOf）——报告里做「节点数口径 vs 档位和口径」对照用。
// 直接用命名空间 import，core 没导出这个函数时降级为 null，不影响跑测。
import * as coreSkillsUpgrade from '../src/core/skillsUpgrade.js';
const skillLevelOfCore = typeof coreSkillsUpgrade.skillLevelOf === 'function' ? coreSkillsUpgrade.skillLevelOf : null;

// ---------------------------------------------------------------------------
// 【可选模块】技能升级 / 精炼石（B 组并行开发）——缺失时降级为 null，绝不影响跑测
// ---------------------------------------------------------------------------
// [踩坑] 为什么用 createRequire 的 **同步** require 而不是 `await import()`：
//   ES 模块的静态 import 在第一轮宏任务里就执行完了，`import()` 的 Promise 要等到下一轮
//   microtask 才 resolve —— 此时模块顶层语句早跑完了，模块作用域里的 `let PROGRESSION`
//   已经「定格」。在 runPlaytest 里 `await ensureOptionalModules()` 之后再赋值也没用
//   （赋值语句本身就是模块顶层代码，只能在模块初始化时执行一次）。
//   同步 require 没有这个问题：模块初始化期间就能拿到对象，后面的方法随便调。
import { createRequire } from 'node:module';

/** 可选模块加载失败的原因（`--verbose` 与报告的 warnings 里会显示） */
const OPTIONAL_MODULE_WARNINGS = [];

/**
 * 同步加载可选模块（CommonJS 入口在本项目里同样能加载 ESM：Node ≥ 20 的 require(esm)）。
 * 模块不存在 / 语法错误 / 依赖链炸了 → 返回 null 并记账，不抛异常。
 * @param {string} specifier 相对本文件的模块路径
 * @returns {Record<string, any>|null}
 */
function optionalModuleSync(specifier) {
  try {
    const req = createRequire(import.meta.url);
    return req(specifier);
  } catch (e) {
    const msg = String((e && e.message) || e);
    OPTIONAL_MODULE_WARNINGS.push(`${specifier}：${msg.split('\n')[0]}`);
    return null;
  }
}

/** src/items/skillProgression.js（技能等级 / 精炼石 / 重置）——缺失时为 null */
const PROGRESSION = optionalModuleSync('../src/items/skillProgression.js');

/** app.js 里新增的导出兜底表（doSkillRefine / doSkillRespec / skillPointsTotal / syncSkillSystems） */
const APP_FN = {
  doSkillRefine: typeof appMod.doSkillRefine === 'function' ? appMod.doSkillRefine : null,
  doSkillRespec: typeof appMod.doSkillRespec === 'function' ? appMod.doSkillRespec : null,
  skillPointsTotal: typeof appMod.skillPointsTotal === 'function' ? appMod.skillPointsTotal : null,
  syncSkillSystems: typeof appMod.syncSkillSystems === 'function' ? appMod.syncSkillSystems : null,
};

/** 取 skillProgression 模块（可能为 null） */
function progression() { return PROGRESSION; }

/** 调 skillProgression 的导出函数，缺失/抛异常都返回 undefined */
function progCall(name, ...args) {
  const m = PROGRESSION;
  if (!m || typeof m[name] !== 'function') return undefined;
  try { return m[name](...args); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const FPS = 60;
const DT = 1 / FPS;
/** 普攻有效射程（tryBasicAttack: 中心 0.8 + 半径 1.95，目标有半径） */
const ATTACK_RANGE = 2.0;
/** 换图前把多少范围内的掉落收进背包 */
const TRAVEL_LOOT_RADIUS = 14;
const LOW_HP_PCT = 0.35;
/** 默认技能栏（战争践踏已顶替裂地斩）；运行时优先用 core 导出的 SKILL_IDS */
const DEFAULT_SKILL_IDS = ['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally'];
/**
 * 技能释放策略的常量（都集中在 skills 模块里，方便跟 UI/策划对齐）：
 *  - STOMP_NEAR_BIG：最近怪 ≤ 这个距离就放践踏（单目标也吃控制）
 *  - STOMP_CROWD：圆形范围里 ≥ 这个数量的怪就放（践踏命中越多护甲越高 → 包围时优先）
 *  - STOMP_RADIUS_FALLBACK：拿不到实际半径时的兜底值（契约 3.3：3.6）
 */
const STOMP_NEAR_BIG = 3.8;
const STOMP_CROWD = 2;
const STOMP_RADIUS_FALLBACK = 3.6;
/** 精炼石：始终留这么多颗石头不动，留给「互斥分叉改派」的重置开销 */
const RESERVE_ORBS = 2;
/** 精炼优先级的技能（伤害占比最高的两个；其余技能只在它们满级后才轮到） */
const REFINE_PRIORITY = ['stomp', 'whirlwind'];
/** 分叉冲突处理冷却（秒）：同一技能这么久才尝试一次「重置天赋改派」 */
const RESPEC_COOLDOWN_SEC = 180;

const HARD_CAPS = Object.freeze({
  monsters: 400, projectiles: 800, all: 900, lootOrbs: 1200, items: 400, groundEffects: 200, summoned: 20,
});
const MEM_CAPS = Object.freeze({ events: 2000, particles: 2000, msgs: 200 });

const RARITY_LABEL = { normal: '普通', magic: '魔法', rare: '稀有', legendary: '传奇' };

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = { minutes: 10, seed: 42, tier: 1, verbose: false, json: null, quiet: false, maxSteps: Infinity, help: false, bot: 'skilled' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--minutes' || a === '-m') out.minutes = Math.max(0, Number(val()));
    else if (a === '--seed' || a === '-s') out.seed = Number(val());
    else if (a === '--tier' || a === '-t') out.tier = Math.max(1, Number(val()));
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--json') out.json = val();
    else if (a === '--max-steps') out.maxSteps = Math.max(1, Number(val()));
    else if (a === '--bot' || a === '-b') out.bot = String(val() || 'skilled').toLowerCase();
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
  }
  if (!Number.isFinite(out.minutes)) out.minutes = 10;
  if (!Number.isFinite(out.seed)) out.seed = 42;
  if (!Number.isInteger(out.tier) || out.tier < 1) out.tier = 1;
  if (!BOT_PRESETS[out.bot]) out.bot = 'skilled';
  return out;
}

/**
 * 机器人预设。
 *  - skilled    ：完整走位（BFS 绕墙、刀锋距离站位、低血反跑），代表「熟练玩家」上限
 *  - stationary ：站桩下限基线——不移动、不躲、不放技能，只对射程内的怪按住普攻。
 *                 用来衡量「怪物 DPS 是否偏高」（站桩必死 → 新手需要保护）
 *  - noPath     ：居中档——会追怪、会放技能，但不做 BFS 绕墙、不拉开刀锋距离（贴脸硬刚）
 */
export const BOT_PRESETS = Object.freeze({
  skilled: { label: '熟练走位', move: true, pathfind: true, bladeSpacing: true, fleeLowHp: true, skills: true },
  noPath: { label: '无绕墙（贴脸）', move: true, pathfind: false, bladeSpacing: false, fleeLowHp: true, skills: true },
  stationary: { label: '站桩下限', move: false, pathfind: false, bladeSpacing: false, fleeLowHp: false, skills: false },
});

// ---------------------------------------------------------------------------
// 数值工具
// ---------------------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, n = 1) => (isNum(v) ? Math.round(v * 10 ** n) / 10 ** n : v);
const fmtInt = (n) => (isNum(n) ? Math.round(n).toLocaleString('en-US') : String(n));

/** 稀有度归一化：items 模块用 unique，core/loot 用 legendary，两者都算传奇 */
export function normRarity(r) {
  if (r === 'legendary' || r === 'unique') return 'legendary';
  if (r === 'rare') return 'rare';
  if (r === 'magic') return 'magic';
  return 'normal';
}

/**
 * 装备战力评分：优先用 items 模块的 itemScore（与 UI 显示一致），缺失时退回本文件的启发式。
 * 只用于「新装备是否比身上的更好」的粗略判断。
 */
export function itemScore(item) {
  if (!item) return 0;
  if (typeof genItemScore === 'function') {
    const v = genItemScore(item);
    if (isNum(v) && v >= 0) return round(v, 1);
  }
  return heuristicItemScore(item);
}

/** 启发式评分（itemgen.itemScore 不可用时的兜底） */
export function heuristicItemScore(item) {
  if (!item) return 0;
  const s = item.stats || {};
  let score = 0;
  score += (s.dmgMin || 0) * 1.2 + (s.dmgMax || 0) * 0.6;
  score += (s.life || 0) * 0.8 + (s.armor || 0) * 0.3;
  score += (s.mana || 0) * 0.12 + (s.manaRegen || 0) * 2;
  score += (s.evasion || 0) * 260 + (s.blockChance || 0) * 160;
  score += (s.attackSpeedMult || 0) * 140 + (s.critChance || 0) * 220 + (s.critMulti || 0) * 8;
  score += (s.moveSpeedMult || 0) * 90;
  score += ((s.physDamageMult || 0) + (s.fireDamageMult || 0) + (s.coldDamageMult || 0) + (s.lightningDamageMult || 0)) * 110;
  score += ((s.physAddedMin || 0) + (s.physAddedMax || 0)) * 0.7;
  score += ((s.addedFireMin || 0) + (s.addedFireMax || 0) + (s.addedColdMin || 0) + (s.addedColdMax || 0)
    + (s.addedLightningMin || 0) + (s.addedLightningMax || 0)) * 0.35;
  score += (s.lifeLeech || 0) * 300 + (s.lifeOnHit || 0) * 6;
  score += ((s.fireResist || 0) + (s.coldResist || 0) + (s.lightningResist || 0)) * 60 + (s.chaosResist || 0) * 30;
  score += (s.aoeMult || 0) * 80 + (s.cdrMult || 0) * 90 + (s.skillLevelBonus || 0) * 25;
  score += Math.max(0, s.damageMult || 0) * 400;
  const mult = { normal: 1, magic: 1.08, rare: 1.16, legendary: 1.3 }[normRarity(item.rarity)] || 1;
  return round(score * mult, 1);
}

/** 物品应该进哪个装备槽（与 inventory.SLOT_ACCEPTS 对齐；戒指选空槽或较差的一格） */
function slotForItem(inv, item) {
  const kind = item.slot === 'armor' ? 'body' : item.slot;
  const map = {
    helmet: ['helmet'], amulet: ['amulet'], body: ['body'], weapon: ['weapon'],
    offhand: ['offhand'], shield: ['offhand'], gloves: ['gloves'], belt: ['belt'],
    boots: ['boots'], ring: ['ring1', 'ring2'],
  };
  const slots = map[kind];
  if (!slots) return null;
  let best = null, bestScore = Infinity;
  for (const id of slots) {
    const cur = inv.equip[id];
    if (!cur) return id;
    const sc = itemScore(cur);
    if (sc < bestScore) { bestScore = sc; best = id; }
  }
  return best;
}

/** 天赋节点偏好：攻击性 > 生存 > 功能 */
function talentPreference(node) {
  const s = (node && node.stats) || {};
  let score = 0;
  score += (s.dmgMin || 0) + (s.life || 0) * 0.7 + (s.armor || 0) * 0.25;
  score += (s.physDamageMult || 0) * 100 + (s.attackSpeedMult || 0) * 100 + (s.damageMult || 0) * 100;
  score += (s.critChance || 0) * 120 + (s.critMulti || 0) * 10;
  score += (s.aoeMult || 0) * 40 + ((s.physAddedMin || 0) + (s.physAddedMax || 0)) * 0.5;
  score += ((s.addedFireMin || 0) + (s.addedLightningMin || 0)) * 0.2;
  return score - (node.cost || 0);
}

/**
 * 技能节点偏好（互斥分叉用）：在「都能点」的候选里选一个。
 * 评估口径按节点档位 × 效果价值，偏向「主输出技能」的伤害/范围/护甲/眩晕。
 * @param {Object} node 技能树节点（含 effects）
 * @param {string} skillId
 */
function skillNodePreference(node, skillId) {
  if (!node) return -Infinity;
  let score = 0;
  for (const eff of node.effects || []) {
    const type = String(eff.type || '');
    const v = Number(eff.value) || 0;
    // 机制开关（extra/count）：践踏的「冲击波/余震/晕眩回血」直接给分
    if (type === 'extra' || type === 'count') { score += 6; continue; }
    switch (type) {
      case 'damageMult': score += v * 100; break;
      case 'radiusMult': score += v * 70; break;
      case 'cooldownMult': score += -v * 90; break;      // 负值 = 冷却缩短
      case 'stunDurMult': score += v * 60; break;
      case 'armorPerEnemyMult': score += v * 55; break;
      case 'armorDurMult': score += v * 30; break;
      case 'armorFlat': score += v * 0.5; break;
      default: score += Math.abs(v) * 12; break;
    }
  }
  // 主输出技能（践踏/旋风斩）的树优先投入
  score += REFINE_PRIORITY.includes(skillId) ? 15 : 0;
  return score;
}

/** 某组是否已经点过（互斥组用了就不能再选别的，交给 doSkillRankUp / skillNodeConflict 兜底） */
function groupTaken(ranks, nodes, group, exceptNodeId) {
  if (!group) return false;
  for (const n of nodes) {
    if (!n || n.group !== group || n.id === exceptNodeId) continue;
    if ((Number(ranks[n.id]) || 0) > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 天赋点同步（core 把点记在 player.talentPoints，app 读 inv.talentPoints）
// ---------------------------------------------------------------------------
/**
 * 把 player.talentPoints 里「没被 inv 记录过」的点搬进 inv.talentPoints。
 * 用 world.__invPointsSynced 记账，保证既不丢点也不凭空造点（可重复调用）。
 */
export function syncTalentPoints(game) {
  const p = game.world.player;
  const inv = game.inv;
  const playerPts = p.talentPoints || 0;
  const synced = game.world.__invPointsSynced || 0;
  const consumed = (inv.talents || []).length - 1 + (inv.talentPoints || 0);
  const unsynced = Math.max(0, playerPts - Math.max(synced, consumed));
  if (unsynced > 0) {
    inv.talentPoints = (inv.talentPoints || 0) + unsynced;
    game.world.__invPointsSynced = Math.max(synced, consumed) + unsynced;
    return unsynced;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 机器人
// ---------------------------------------------------------------------------
export class Bot {
  /**
   * @param {Object} game createGame() 的返回值
   * @param {{seed?:number, verbose?:boolean, onLog?:Function, preset?:string}} [opts]
   *   preset: 'skilled'（默认）| 'noPath' | 'stationary'，见 BOT_PRESETS
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.world = game.world;
    this.onLog = opts.onLog || null;
    this.presetName = BOT_PRESETS[opts.preset] ? opts.preset : 'skilled';
    this.preset = BOT_PRESETS[this.presetName];
    const seed = opts.seed ?? 42;

    // 换图节奏：种子决定 2-4 分钟
    // [playtest] spawner 的波次计时器在 loadMap 时重置，而 Boss 每 25 波（20 秒/波 = 500 秒）
    // 才出现一次，所以「每 2-4 分钟换图」的机器人永远见不到 Boss。
    // 折中：第 1 层跑 5 分钟（15 波，含精英波），之后按 2-4 分钟换图；
    // Boss 验证交给独立的 sim-ttk / 单测，不依赖 10 分钟跑测（否则层数推进会被压死）。
    this.mapDurMin = 120 + ((Math.abs(seed) * 37) % 121); // 120..240 秒
    this.firstMapDur = 300; // 首层 5 分钟
    this.mapEnteredAt = 0;
    this.planA = 0;

    this.targetDrop = null;
    this.targetDropT = -99;

    this.stuckT = 0;
    this.sideSign = 1;
    this.sideT = 0;
    this.lastPos = { x: game.world.player.x, z: game.world.player.z };
    this.deathHold = 0;
    this.deathCounted = false;

    this.recentHits = [];
    this.layerStats = [];
    this.stats = {
      dtDealt: 0, dtTaken: 0, hits: 0, swings: 0, kills: 0,
      killsByRarity: { normal: 0, magic: 0, rare: 0, boss: 0 },
      pickups: 0, pickedByRarity: { normal: 0, magic: 0, rare: 0, legendary: 0 },
      picked: 0,
      dropped: 0, droppedByRarity: { normal: 0, magic: 0, rare: 0, legendary: 0 }, pickupEvents: 0,
      equipped: 0, sold: 0, goldFromSell: 0, lostDrops: 0,
      talentsTaken: 0, skillRanksTaken: 0,
      deaths: 0, revives: 0, travels: 0,
      maxTier: 1, activeSeconds: 0, idleSeconds: 0,
      // ---- 战争践踏 / 眩晕（事件统计）----
      stompCasts: 0, stompHits: 0, stompWhiffs: 0, stompZeroHitCasts: 0,
      stuns: 0, stunEnds: 0, stunSeconds: 0,
      warStompArmor: 0, warStompArmorDur: 0, warStompArmorFrames: 0, warStompArmorMax: 0,
      // ---- 技能等级 / 精炼石 / 分叉 ----
      refine: {
        orbsGained: 0,           // 事件口径（skillOrbGain 的 amount 总和）
        orbGainEvents: 0,
        orbsGainedByScan: 0,     // 兜底口径：inv.skillOrbs 的增量（没有事件时用它）
        orbsSpent: 0,            // 精炼 + 重置一共花掉的石头
        refined: 0,              // 成功精炼次数
        refineAttempts: 0,
        respecs: 0,
        respecOrbs: 0,           // 重置花掉的石头
        conflicts: 0,            // doSkillRankUp 因互斥/前置被拒的次数
        blockedNodes: {},        // nodeId → 被拒次数（互斥锁死 / 前置未满足）
      },
    };
    /** 技能 id → 释放次数（skillCast 事件） */
    this.skillCasts = {};
    /** 技能 id → 分叉冲突处理的时间点（节流用） */
    this.respecTriedAt = {};
    /** 上一帧看到的精炼石余额（没有 skillOrbGain 事件时的兜底统计） */
    this._orbsSeen = Number(game.inv.skillOrbs) || 0;
  }

  get p() { return this.world.player; }

  /** 每帧：更新 AI → updateGame → 消费/清空事件 */
  step(elapsed) {
    const input = {
      move: { x: 0, z: 0 },
      aim: { x: 0, z: 0 },
      attackHeld: false,
      attackPressed: false,
      skills: [],
      dash: false,
      releaseChannels: false,
    };
    const p = this.p;
    if (p.dead) {
      // 死亡：等一小会儿再复活
      this.deathHold += DT;
      if (this.deathHold >= 1.0) {
        this.deathHold = 0;
        revivePlayer(this.game);
        this.stats.revives++;
      }
    } else {
      this.think(elapsed, input);
    }
    updateGame(this.game, DT, input);
    this.consumeEvents(elapsed);
    clearEvents(this.world);
  }

  consumeEvents(elapsed) {
    const evs = this.world.events;
    if (!evs || !evs.length) return;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (!e) continue;
      switch (e.type) {
        case 'hit':
          if (e.amount > 0) {
            this.stats.hits++;
            if (e.targetIsPlayer) this.stats.dtTaken += e.amount;
            else {
              this.stats.dtDealt += e.amount;
              this.recentHits.push({ t: elapsed, amount: e.amount });
            }
          }
          break;
        case 'monsterKilled':
          this.stats.kills++;
          this.stats.killsByRarity[e.rarity] = (this.stats.killsByRarity[e.rarity] || 0) + 1;
          break;
        case 'swing':
          this.stats.swings++;
          break;
        case 'loot':
          // 装备掉落（由 dropItem 推）；自动拾取不经过 doPickup，所以掉落统计看事件
          if (e.item) {
            const r = normRarity(e.item.rarity || e.rarity);
            this.stats.droppedByRarity[r]++;
            this.stats.dropped++;
          }
          break;
        case 'pickup':
          this.stats.pickupEvents = (this.stats.pickupEvents || 0) + 1;
          break;
        case 'levelUp':
          this.onLevelUp();
          break;
        case 'bossSpawn':
          this.stats.bossEncounters = (this.stats.bossEncounters || 0) + 1;
          this.bossStart = elapsed;
          break;
        case 'bossKilled':
          if (this.bossStart != null) {
            this.stats.bossTTK = round(elapsed - this.bossStart, 2);
            this.bossStart = null;
          }
          this.stats.bossKills = (this.stats.bossKills || 0) + 1;
          break;
        case 'playerDeath':
          if (this.stats.firstDeathAt == null) this.stats.firstDeathAt = round(elapsed, 1);
          break;
        // ---- 战争践踏 / 眩晕（契约 3.3、3.6） ----
        case 'stomp': {
          this.stats.stompCasts++;
          const hits = Number(e.hits);
          if (isNum(hits)) {
            this.stats.stompHits += hits;
            if (hits <= 0) this.stats.stompZeroHitCasts++;
          }
          if (hits > 0 && isNum(e.armor)) {
            // 契约：hits===0 也会给一层保底护甲，所以「护甲 buff 覆盖率」另外用 player.buffs 采样
            this.stats.warStompArmorMax = Math.max(this.stats.warStompArmorMax, e.armor);
          }
          break;
        }
        case 'stun':
          this.stats.stuns++;
          if (isNum(e.dur)) this.stats.stunSeconds += e.dur;
          break;
        case 'stunEnd':
          this.stats.stunEnds++;
          break;
        // ---- 技能等级 / 精炼石 / 分叉（契约第 4 节） ----
        case 'skillOrbGain': {
          this.stats.refine.orbGainEvents++;
          const n = Number(e.amount);
          this.stats.refine.orbsGained += isNum(n) ? n : 1;
          break;
        }
        case 'skillRankUp':
          // 只在机器人自己不调用 doSkillRankUp 时兜底计数（正常路径见 autoSpendSkillPoints）
          if (!this._autoRank) this.stats.skillRanksTaken++;
          break;
        default:
          break;
      }
      // 释放次数：所有 skillCast 都记，用于报告里的「技能使用」分布
      if (e.type === 'skillCast' && e.skillId) {
        this.skillCasts[e.skillId] = (this.skillCasts[e.skillId] || 0) + 1;
      }
    }
    const cutoff = elapsed - 15;
    let cut = 0;
    while (cut < this.recentHits.length && this.recentHits[cut].t < cutoff) cut++;
    if (cut > 0) this.recentHits.splice(0, cut);
  }

  onLevelUp() {
    syncTalentPoints(this.game);
    this.autoSpendTalents();
    this.autoSpendSkillPoints();
    this.autoManageSkills();
  }

  /** 自动点天赋：只点 canTakeTalent() 为真的节点，优先攻击性节点 */
  autoSpendTalents() {
    const inv = this.game.inv;
    let guard = 0;
    while ((inv.talentPoints || 0) > 0 && guard++ < 500) {
      const candidates = [];
      for (const node of TALENTS) {
        if (!node || node.id === START_NODE) continue;
        if (!canTakeTalent(inv, node.id)) continue;
        candidates.push({ node, score: talentPreference(node) });
      }
      if (!candidates.length) break;
      candidates.sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)));
      if (!doTakeTalent(this.game, candidates[0].node.id)) break;
      this.stats.talentsTaken++;
    }
  }

  /** 当前技能 id 列表：优先 core 的 SKILL_IDS（战争践踏 stomp 顶替了 groundSlam），否则用默认表 */
  skillIds() {
    const coreIds = skillTreeMod.SKILL_IDS;
    if (Array.isArray(coreIds) && coreIds.length) return coreIds.slice();
    const treeIds = Object.keys(SKILL_TREES || {});
    return treeIds.length ? treeIds : DEFAULT_SKILL_IDS.slice();
  }

  /** 该技能树的节点列表（服务端数据；缺失给空数组） */
  treeNodes(skillId) {
    const tree = SKILL_TREES && SKILL_TREES[skillId];
    return tree && Array.isArray(tree.nodes) ? tree.nodes : [];
  }

  /** 节点是否被互斥组锁死（数据模块提供 skillNodeConflict 时用它；否则靠 doSkillRankUp 返回 false） */
  nodeConflict(skillId, nodeId) {
    const fn = skillTreeMod.skillNodeConflict;
    if (typeof fn !== 'function' || !skillTreeMod.SKILL_TREES) return null;
    try {
      return fn(SKILL_TREES[skillId], this.game.inv.skillRanks || {}, nodeId) || null;
    } catch {
      return null;
    }
  }

  /**
   * 自动加技能树点数：5 个技能轮流点。
   *
   * 互斥分叉带来的坑（必须处理，否则死循环 / 卡住）：
   *  - 同一轮里「左支节点点了 → 右支节点永远返回 false」，如果外层只看 any 会一直重试；
   *  - doSkillRankUp 失败的原因有很多（点数不足 / 前置未满足 / 已满档 / 互斥锁死），
   *    失败的节点要**记到本地集合**里本帧不再试，并用 guard 兜底（最多 200 轮、每轮只成功一次）。
   */
  autoSpendSkillPoints() {
    const inv = this.game.inv;
    if (!inv.skillRanks) inv.skillRanks = {};
    const ids = this.skillIds();
    let pointsLeft = 0;
    try { pointsLeft = skillPointsFor(this.game, ''); } catch { pointsLeft = 0; }
    if (!(pointsLeft > 0)) return 0;
    /** 失败过的节点 id（互斥/前置/满档都算），避免同一轮反复重试同一个节点 */
    const rejected = new Set();
    let spent = 0;
    // guard：每成功一次花 1 点，最多花到点数用完 / 没有候选（正常 ≤ 点数 × 1 次循环）
    let guard = 0;
    while (guard++ < 200) {
      try { pointsLeft = skillPointsFor(this.game, ''); } catch { pointsLeft = 0; }
      if (!(pointsLeft > 0)) break;

      // ---- 1) 收集所有「可点」候选（全局排序，不按技能轮流，避免把点分散成 5 个 ROOT）----
      // 互斥分叉下同组只能选一个：先用 skillNodeConflict 预判，点不动的直接进 rejected，
      // 这样既不会反复调用失败的 doSkillRankUp，也不会卡在一棵点不动的树上。
      const cands = [];
      for (const skillId of ids) {
        const nodes = this.treeNodes(skillId);
        for (const node of nodes) {
          if (!node || !node.id) continue;
          if (rejected.has(node.id)) continue;
          const cur = Number(inv.skillRanks[node.id]) || 0;
          if (cur >= (node.maxRank || 1)) continue;
          if (Array.isArray(node.requires) && node.requires.some((r) => !(Number(inv.skillRanks[r]) || 0))) continue;
          if (groupTaken(inv.skillRanks, nodes, node.group, node.id) || this.nodeConflict(skillId, node.id)) {
            rejected.add(node.id);
            this.stats.refine.conflicts++;
            this.stats.refine.blockedNodes[node.id] = (this.stats.refine.blockedNodes[node.id] || 0) + 1;
            continue;
          }
          const score = skillNodePreference(node, skillId);
          // 互斥组：同组两个都能点时，优先分高的（会通过排序自动选中），分低的留在候选里
          cands.push({ skillId, node, score });
        }
      }
      if (!cands.length) break;
      cands.sort((a, b) => b.score - a.score
        || REFINE_PRIORITY.indexOf(a.skillId) - REFINE_PRIORITY.indexOf(b.skillId)
        || String(a.node.id).localeCompare(String(b.node.id)));

      let ok = false;
      for (const c of cands) {
        this._autoRank = true;
        let r = false;
        try { r = !!doSkillRankUp(this.game, c.skillId, c.node.id); } catch { r = false; }
        this._autoRank = false;
        if (r) {
          this.stats.skillRanksTaken++;
          spent++;
          ok = true;
          break;
        }
        // 返回 false：互斥 / 前置 / 点数被别处用掉 → 记录并换下一个候选（不会死循环）
        rejected.add(c.node.id);
        this.stats.refine.conflicts++;
        this.stats.refine.blockedNodes[c.node.id] = (this.stats.refine.blockedNodes[c.node.id] || 0) + 1;
      }
      if (!ok) break; // 所有候选都被拒：本帧没得点了
    }
    return spent;
  }

  /**
   * 技能升级总入口（每个升级 / 每次石头到手 / 每 10 秒）：
   *   1. 刷新技能点 → 分发
   *   2. 分叉冲突处理（能点但不给点 → 用精炼石重置后改派，最多每人 3 分钟一次）
   *   3. 精炼石：优先砸伤害占比最高的技能（stomp / whirlwind），永远留 RESERVE_ORBS 颗备用
   * 所有步骤都对「模块缺失」免疫：skillProgression 没就绪时整段跳过。
   */
  autoManageSkills(elapsed = this._now || 0) {
    const inv = this.game.inv;
    // 精炼石余额兜底统计（没有 skillOrbGain 事件时也能出数）
    const curr = Number(inv.skillOrbs) || 0;
    if (curr > this._orbsSeen) this.stats.refine.orbsGainedByScan += curr - this._orbsSeen;
    this._orbsSeen = curr;

    this.autoSpendSkillPoints();
    // 1) 能改派就立刻改派（有需求时优先于精炼）
    this.autoHandleForkConflicts(elapsed);
    // 2) 仍有点数花不出去 => 正在攒 respec 的石头，精炼时不再留备用
    const reason = this.respecReason();
    // 3) 精炼
    this.autoRefineSkills(elapsed, reason.need);
  }

  /**
   * 技能等级：天赋投入点数 + 精炼等级 + 1（上限 5）。
   *
   * [口径告警] 项目里目前有 **两种**「天赋点数」口径，报告里两列都出，方便对照：
   *   · 节点数口径（data / 契约 §3.4）：countAllocatedNodes —— 一个节点点 3 档仍算 1 点；
   *     技能点的花费也是这个口径（skillPointsSpent），对应 `talentNodes、levelNodes`
   *   · 档位和口径（core）：skillsUpgrade.talentPointsOf —— 把每档都算 1 点，
   *     对应 `talentRanks、levelRanks`（= core 的 skillLevelOf(player, id)，也是实际战斗数值）
   * 两者在「ROOT 点到多档」时会差 1~3 级，已报给 Lead 统一。
   */
  skillLevelOf(skillId) { return this.skillLevelDetail(skillId).levelNodes; }

  /** 详细等级：见 skillLevelOf 的注释 */
  skillLevelDetail(skillId) {
    const inv = this.game.inv;
    const ranks = inv.skillRanks || {};
    const refine = Number((inv.skillRefine || {})[skillId]) || 0;
    const nodes = this.treeNodes(skillId);
    const levelOf = (v) => Math.max(1, Math.min(5, Math.floor(v) || 1));
    // ① 节点数口径（data 模块；模块没就绪时自己数）
    const dataLevel = progCall('skillLevelFrom', ranks, refine);
    const nodeCount = nodes.reduce((a, n) => a + ((Number(ranks[n.id]) || 0) > 0 ? 1 : 0), 0);
    const levelNodes = isNum(dataLevel) ? levelOf(dataLevel) : levelOf(nodeCount + refine + 1);
    // ② 档位和口径（core）：优先直接问 core（战斗真正用的那个），拿不到再自己算
    let levelRanks = null;
    try {
      if (typeof skillLevelOfCore === 'function') levelRanks = levelOf(skillLevelOfCore(this.p, skillId));
    } catch { levelRanks = null; }
    const rankSum = nodes.reduce((a, n) => a + (Number(ranks[n.id]) || 0), 0);
    if (!isNum(levelRanks)) levelRanks = levelOf(rankSum + refine + 1);
    return { levelNodes, levelRanks, refine, nodeCount, rankSum };
  }

  /** 本技能已点的「分支节点」个数（branch 以 left / right 开头；ROOT / 终极不算） */
  branchPointsOf(skillId) {
    const ranks = this.game.inv.skillRanks || {};
    let n = 0;
    for (const node of this.treeNodes(skillId)) {
      const rank = Number(ranks[node.id] ?? (node.key ? ranks[`${skillId}.${node.key}`] : 0)) || 0;
      if (rank <= 0) continue;
      const br = String(node.branch || '');
      if (br.startsWith('left') || br.startsWith('right')) n++;
    }
    return n;
  }

  /** 本技能已投入的天赋点（只算本技能的节点；inv.skillRanks 的键可能带或不带技能前缀） */
  talentPointsOf(skillId) {
    const ranks = this.game.inv.skillRanks || {};
    let n = 0;
    for (const node of this.treeNodes(skillId)) {
      const r = Number(ranks[node.id] ?? ranks[node.key ?? ''] ?? 0) || 0;
      if (r > 0) n += 1;
    }
    return n;
  }

  /** 本技能此刻「点了就能加」的候选数（没满档 + 前置满足 + 不被互斥锁死）。0 = 这点数花不出去 */
  upgradableCount(skillId) {
    const ranks = this.game.inv.skillRanks || {};
    let n = 0;
    for (const node of this.treeNodes(skillId)) {
      if (!node || !node.id) continue;
      if ((Number(ranks[node.id]) || 0) >= (node.maxRank || 1)) continue;
      if (Array.isArray(node.requires) && node.requires.some((r) => !(Number(ranks[r]) || 0))) continue;
      if (this.nodeConflict(skillId, node.id)) continue;
      n++;
    }
    return n;
  }

  /**
   * 是否「有技能点、但某个技能已经没地方可点」——这时候牌面就是需要 respec（改派分叉）。
   * 顺带给出需要多少颗石头。
   * @returns {{need:boolean, skillId:string, cost:number}}
   */
  respecReason() {
    let points = 0;
    try { points = Number(skillPointsFor(this.game, '')); } catch { points = 0; }
    if (!(points > 0)) return { need: false, skillId: '', cost: 0 };
    const inv = this.game.inv;
    // 优先看「已经选了某条支线、但线走完了」的技能（主输出技能优先）
    for (const skillId of this.refineOrder()) {
      if (!this.treeNodes(skillId).length) continue;
      if (this.upgradableCount(skillId) > 0) continue;
      // 已点节点数（按「节点个数」口径，与 respecCost / 技能等级一致）
      const takenNodes = inv.skillRanks
        ? this.treeNodes(skillId).filter((n) => (Number(inv.skillRanks[n.id]) || 0) > 0).length
        : 0;
      if (takenNodes <= 0) continue; // 一个点都没花：没东西可重置
      const fallbackCost = progCall('respecCost', skillId, inv.skillRanks);
      const cost = Number(fallbackCost ?? progCall('respecCost', skillId, takenNodes)) || 0;
      if (cost > 0) return { need: true, skillId, cost };
    }
    return { need: false, skillId: '', cost: 0 };
  }

  /** 该技能还能不能精炼（优先 canRefineSkill，缺失时按契约自己算），返回 {ok, cost, have, reason} */
  refineCheck(skillId) {
    const inv = this.game.inv;
    const res = progCall('canRefineSkill', inv, this.p, skillId);
    if (res && typeof res === 'object') {
      return { ok: !!res.ok, cost: Number(res.cost) || 0, have: Number(res.have ?? inv.skillOrbs) || 0, reason: String(res.reason || '') };
    }
    // 兜底：refineCost(level, refine)（1→2:3，2→3:4，3→4:6，4→5:8）
    const refine = Number((inv.skillRefine || {})[skillId]) || 0;
    const max = progCall('REFINE_MAX');
    const cap = 5;
    if (refine >= (isNum(max) ? max : cap - 1)) return { ok: false, cost: 0, have: Number(inv.skillOrbs) || 0, reason: '已满级' };
    const cost = Number(progCall('refineCost', Math.min(cap, this.skillLevelOf(skillId)), refine)) || 0;
    if (!cost) return { ok: false, cost: 0, have: Number(inv.skillOrbs) || 0, reason: '无 refineCost' };
    const have = Number(inv.skillOrbs) || 0;
    return { ok: have >= cost, cost, have, reason: have >= cost ? '' : `精炼石不足（${have}/${cost}）` };
  }

  /**
   * 精炼石消费：按伤害占比给技能排序（stomp / whirlwind 优先），逐颗精炼。
   *
   * 策略（改自「无脑升最高伤害技能」）：
   *  - 优先把石头砸给 REFINE_PRIORITY（战争践踏 / 旋风斩）——它们占伤害输出的绝大部分；
   *  - 但这些技能到高级后单次精炼要 6~8 颗，攒不齐时**不要让石头躺尸**：退而精炼一个付得起的
   *    其它技能（技能等级是全技能共享的便宜成长）；
   *  - 始终留 RESERVE_ORBS 颗给 respec（重置分叉要用石头）。但如果**当前就有改派需求**（有技能点、
   *    某技能的可点节点被互斥堵住）=> 一颗都不留，攒够 respecCost 就直接重置改派。
   *
   * @param {boolean} [needRespecOrbs] respecReason() 的结果：有改派需求时为 true
   */
  autoRefineSkills(elapsed = 0, needRespecOrbs = false) {
    const inv = this.game.inv;
    const drive = APP_FN.doSkillRefine;
    const haveProgression = !!PROGRESSION && typeof PROGRESSION.refineSkill === 'function';
    if (!drive) return 0; // app 没提供 doSkillRefine：整段跳过（模块未就绪）
    const reserve = needRespecOrbs ? 0 : RESERVE_ORBS;
    let spentTotal = 0;
    let guard = 0;
    while (guard++ < 40) {
      const orbs = Number(inv.skillOrbs) || 0;
      if (orbs < 1) break;
      const order = this.refineOrder();
      const checks = order.map((id) => ({ id, chk: this.refineCheck(id) }));
      const payable = checks.filter((c) => c.chk.ok && c.chk.cost > 0 && c.chk.cost <= orbs);
      if (!payable.length) break; // 攒石头中（或全部满级）
      // 备用保护：付得起的情况下也要保证精炼完还剩 reserve 颗给 respec；
      // 优先按伤害占比（stomp > whirlwind > 其它），但这几种都能接受：
      //   ① 精炼后仍留下备用  ② 已经全满级（备用没用了）
      //   ③ 订单里靠前的技能刚好付得起（宁可先升主技能，也不让石头躺着发霉）
      const pick = payable.find((c) => c.chk.cost + reserve <= orbs)
        || (this._allMaxed ? payable[0] : null)
        || payable[0];
      if (!pick) break;
      const before = orbs;
      this.stats.refine.refineAttempts++;
      let ok = false;
      try { ok = !!drive(this.game, pick.id); } catch { ok = false; }
      if (!ok) {
        // doSkillRefine 不可用：退回数据模块的 refineSkill（契约 3.4：消耗石头 → 写 inv.skillRefine）
        if (haveProgression) {
          try { ok = !!progCall('refineSkill', inv, this.p, pick.id); } catch { ok = false; }
        }
      }
      if (!ok) {
        // 彻底点不动了：把这条技能标记为「无法精炼」，避免死循环
        this._refineBroken = this._refineBroken || new Set();
        this._refineBroken.add(pick.id);
        if (this._refineBroken.size >= order.length) { this._allMaxed = true; break; }
        continue;
      }
      this.stats.refine.refined++;
      const diff = Math.max(0, before - (Number(inv.skillOrbs) || 0));
      this.stats.refine.orbsSpent += diff || pick.chk.cost;
      spentTotal += diff || pick.chk.cost;
      this._orbsSeen = Number(inv.skillOrbs) || 0;
      // 等级变化后技能点也变了（契约：技能等级 = 天赋点 + 精炼），顺手同步
      APP_FN.syncSkillSystems?.(this.game);
    }
    return spentTotal;
  }

  /** 精炼顺序：伤害占比优先（stomp / whirlwind），其余按实际释放次数 / 技能栏顺序 */
  refineOrder() {
    const ids = this.skillIds().filter((id) => !this._refineBroken?.has(id));
    const castCount = (id) => this.skillCasts[id] || 0;
    return ids.slice().sort((a, b) => {
      const pa = REFINE_PRIORITY.indexOf(a), pb = REFINE_PRIORITY.indexOf(b);
      if (pa >= 0 || pb >= 0) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      return castCount(b) - castCount(a);
    });
  }

  /**
   * 分叉冲突处理：某技能「还有点、但所有可点节点都被互斥锁死」→ 花精炼石 doSkillRespec 重置，
   * 下一轮 autoSpendSkillPoints 就会按新顺序改派。节流：每技能 3 分钟最多一次，且必须留够石头。
   */
  autoHandleForkConflicts(elapsed = 0) {
    const respec = APP_FN.doSkillRespec;
    if (!respec) return false;
    const inv = this.game.inv;
    let points = 0;
    try { points = Number(skillPointsFor(this.game, '')); } catch { points = 0; }
    if (!(points > 0)) return false;
    let did = false;
    for (const skillId of this.skillIds()) {
      const last = this.respecTriedAt[skillId] ?? -1e9;
      if (elapsed - last < RESPEC_COOLDOWN_SEC) continue;
      // 有任何一个节点「没满档 + 前置满足 + 不冲突」→ 不需要重置
      if (this.upgradableCount(skillId) > 0) continue;
      const cost = Number(progCall('respecCost', skillId, inv.skillRanks)) || 0;
      const orbs = Number(inv.skillOrbs) || 0;
      // 有改派需求时不动用「精炼备用」，但也必须攒够重置花费本身
      if (!(cost > 0) || orbs < cost) continue;
      this.respecTriedAt[skillId] = elapsed;
      let ok = false;
      try { ok = !!respec(this.game, skillId); } catch { ok = false; }
      if (!ok) continue;
      this.stats.refine.respecs++;
      this.stats.refine.respecOrbs += cost;
      this.stats.refine.orbsSpent += cost;
      this._orbsSeen = Number(inv.skillOrbs) || 0;
      this._refineBroken = null;
      this._allMaxed = false;
      this.autoSpendSkillPoints();
      did = true;
    }
    return did;
  }

  /** 分叉专精：left / right / ''（数据源优先级：player.skillMods → player.skills → 节点 branch 推算） */
  skillFocus(skillId) {
    const p = this.p;
    // ① 首选：data-dev 的 syncSkillSystems 写进 player.skillMods[id].focus（'' / 'left' / 'right'）
    const mods = p.skillMods && p.skillMods[skillId];
    if (mods) {
      if (mods.focus === 'left' || mods.focus === 'right') return mods.focus;
      // 老版本只给 flags：focusLeft / focusRight
      const flags = mods.flags || {};
      if (flags.focusLeft) return 'left';
      if (flags.focusRight) return 'right';
    }
    // ② 次选：player.skills[id].focus
    const sk = p.skills && p.skills[skillId];
    if (sk) {
      if (sk.focus === 'left' || sk.focus === 'right') return sk.focus;
      const sf = sk.skillFlags || sk.flags || {};
      if (sf.focusLeft) return 'left';
      if (sf.focusRight) return 'right';
    }
    // ③ 兜底：用 inv.skillRanks + 树节点的 branch 自己推（任一 left* 点过 → left，right* → right）
    const fn = skillTreeMod.skillBranchOf;
    const ranks = this.game.inv.skillRanks || {};
    const nodes = this.treeNodes(skillId);
    let left = 0, right = 0;
    for (const node of nodes) {
      const rank = Number(ranks[node.id] ?? (node.key ? ranks[`${skillId}.${node.key}`] : 0)) || 0;
      if (rank <= 0) continue;
      let br = String(node.branch || '');
      if (!br && typeof fn === 'function') {
        try { br = String(fn(SKILL_TREES[skillId], node.id) || ''); } catch { br = ''; }
      }
      if (br.startsWith('left')) left++;
      else if (br.startsWith('right')) right++;
    }
    if (left && !right) return 'left';
    if (right && !left) return 'right';
    // 两边都有（理论上互斥不该出现）：取点得多的那一边，用于暴露数据异常
    if (left && right) return left >= right ? 'left' : 'right';
    // 一个分支节点都没点 → 真的还没分叉（只有 ROOT/终极节点）
    return '';
  }

  /** 主 AI：计算一帧 input */
  think(elapsed, input) {
    this._now = elapsed;
    const p = this.p;
    const world = this.world;
    const monsters = world.monsters || [];

    // ---- 锁定目标：不要每帧改选「最近的」（会在怪群里被来回拉扯），但也不能死锁 ----
    // 目标必须是「玩家真的能走到」的：core 里有一部分怪会卡进墙里（碰撞圆压墙，
    // circleWalkable=false），追它们会变成原地撞墙（实测 83% 的时间在追这种怪）。
    // 这里用 world.isWalkable（= 玩家半径的可走判定）作为可达性筛选。
    const walk = this.world.isWalkable;
    const dungeon = this.world.dungeon;
    // 可达判定（用于「追」）：玩家半径可走 + 怪物所在格可走。
    // 不要求怪物的碰撞圆也完全可走——贴墙的怪仍然可能出现在玩家旁边
    // （真正追不进去的极端情况由 stuckT 兜底接管）。
    const reachable = (m) => {
      if (typeof walk === 'function' && !walk(m.x, m.z)) return false;
      if (dungeon && typeof dungeon.isWalkableTile === 'function') {
        const t = dungeon.toTile(m.x, m.z);
        if (!dungeon.isWalkableTile(t[0], t[1])) return false;
      }
      return true;
    };
    let target = this.combatTarget;
    if (target && (target.dead || !monsters.includes(target) || !reachable(target))) target = null;
    if (target) {
      const dt0 = Math.hypot(target.x - p.x, target.z - p.z);
      if (dt0 > 16) target = null;
    }
    let bestMonster = null, bestD = Infinity;
    let blockedCount = 0;
    for (let i = 0; i < monsters.length; i++) {
      const m = monsters[i];
      if (!m || m.dead) continue;
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d > 20) continue;
      if (!reachable(m)) { blockedCount++; continue; }
      if (d < bestD) { bestD = d; bestMonster = m; }
    }
    this._blockedMonsters = blockedCount;
    const retarget = elapsed - (this._targetChosenAt || 0) > 4;
    if (!target || (bestMonster && bestMonster !== target && (retarget || bestD < Math.hypot(target.x - p.x, target.z - p.z) * 0.6))) {
      if (bestMonster !== target) { target = bestMonster; this._targetChosenAt = elapsed; }
    }
    this.combatTarget = target;

    // 统计周围怪物（用于技能决策）
    // near3 / near4：战吼/图腾用的「近身怪数」；stompHits：落在战争践踏圆形范围内的怪数
    const stompRadius = this.stompRadius();
    let near3 = 0, near4 = 0, stompHits = 0, nd = Infinity;
    for (let i = 0; i < monsters.length; i++) {
      const m = monsters[i];
      if (!m || m.dead) continue;
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < nd) nd = d;
      if (d <= 3.2) near3++;
      if (d <= 4.2) near4++;
      // 践踏是「以玩家为圆心的圆」，敌人半径也算进去（与 core 的圆形判定口径一致）
      if (d <= stompRadius + (m.radius || 0)) stompHits++;
    }
    const nearest = target;
    const targetDist = target ? Math.hypot(target.x - p.x, target.z - p.z) : Infinity;

    const hpPct = p.maxHp > 0 ? p.hp / p.maxHp : 0;
    const lowHp = hpPct < LOW_HP_PCT;
    const lifeOrb = lowHp ? this.nearestOrb(p, 'life', 9) : null;
    const dropTarget = this.updateDropTarget(elapsed, nearest, nd);

    // ---- 站桩下限基线：不移动、不躲、不放技能，只对射程内的怪按住普攻 ----
    // 用来回答「怪物 DPS 是否偏高」：站桩必死 → 新手需要保护；站桩很稳 → 怪物太弱。
    if (!this.preset.move) {
      if (nearest) {
        input.aim = { x: nearest.x, z: nearest.z };
        if (targetDist <= 2.4) input.attackHeld = true;
      } else {
        // 没有目标就原地不动（aim 保持朝前，避免 facing 被改成怪方向而无意义地转身）
        input.aim = { x: p.x + Math.sin(p.facing || 0) * 3, z: p.z + Math.cos(p.facing || 0) * 3 };
      }
      input.skills = [];
      // 站桩也必须换图（否则一层就占满整局，层数指标失真）
      this.maybeTravel(elapsed);
      return;
    }

    // ---- 决策：去哪 ----
    let tx = p.x, tz = p.z;
    let fighting = false;
    // noPath 预设：不跑低血逃跑逻辑（贴脸硬刚），其余与 skilled 一致
    if (lowHp && !lifeOrb && this.preset.fleeLowHp) {
      // 拉距离
      if (nearest) {
        const dx = p.x - nearest.x, dz = p.z - nearest.z;
        const len = Math.hypot(dx, dz) || 1;
        tx = p.x + (dx / len) * 6;
        tz = p.z + (dz / len) * 6;
      } else {
        tx = p.x + Math.cos(elapsed * 0.7) * 5;
        tz = p.z + Math.sin(elapsed * 0.7) * 5;
      }
      if (nearest && nd < 4.5) input.dash = true;
      input.releaseChannels = true;
    } else if (lifeOrb) {
      tx = lifeOrb.x; tz = lifeOrb.z;
      fighting = !!nearest && nd <= ATTACK_RANGE;
    } else if (nearest && targetDist <= ATTACK_RANGE + 0.8) {
      // 追到攻击距离内：直接压上去，不要再左右找「更近的」
      tx = nearest.x; tz = nearest.z;
      fighting = true;
    } else if (nearest) {
      // 目标还在远处：直线能走就直走，被墙挡住就 BFS 绕路（noPath 预设跳过绕路）
      const dungeon = this.world.dungeon;
      const clear = dungeon && typeof dungeon.lineClear === 'function'
        ? dungeon.lineClear(p.x, p.z, nearest.x, nearest.z)
        : true;
      const wp = (clear || !this.preset.pathfind) ? null : this.findPathWaypoint(p.x, p.z, nearest.x, nearest.z);
      if (wp) { tx = wp.x; tz = wp.z; }
      else { tx = nearest.x; tz = nearest.z; }
    } else if (dropTarget) {
      tx = dropTarget.x; tz = dropTarget.z;
    } else {
      // 巡逻：以玩家为中心缓慢盘旋 + 画外偏移，避免卡在角落
      const a = elapsed * 0.35 + this.planA;
      tx = p.x + Math.cos(a) * 7 + Math.sin(a * 0.61) * 3;
      tz = p.z + Math.sin(a) * 7 + Math.cos(a * 0.37) * 3;
    }

    // ---- 滑墙脱困 ----
    // 检测「想走但走不动」：只有正在移动（有 move 输入）且实际位移 << 期望位移时才计入。
    // 之前只看「位移为 0」，忽略了贴着墙以 30% 速度慢慢磨的情况（原版 mis-detect）。
    const moved = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z);
    this.lastPos = { x: p.x, z: p.z };
    const wantMove = Math.hypot(input.move.x, input.move.z) > 0.3;
    const expectedStep = 6.2 * DT; // 6.2 单位/秒 × 1/60
    if (wantMove && moved < expectedStep * 0.45) this.stuckT += DT;
    else this.stuckT = Math.max(0, this.stuckT - DT * 2);
    this.sideT = Math.max(0, this.sideT - DT);
    if (this.stuckT > 0.3) {
      if (this.sideT <= 0) { this.sideT = 1.1; this.sideSign = -this.sideSign; }
      const dx = tx - p.x, dz = tz - p.z;
      const len = Math.hypot(dx, dz) || 1;
      // 90° 侧移绕墙
      input.move.x = (-dz / len) * this.sideSign;
      input.move.z = (dx / len) * this.sideSign;
      this.stats.stuckEvents = (this.stats.stuckEvents || 0) + 1;
      if (this.stuckT > 3.5) {
        // 长时间卡死（例如围栏角落）：给一点随机方向抖动
        input.move.x += (Math.random() - 0.5) * 1.5;
        input.move.z += (Math.random() - 0.5) * 1.5;
        const l2 = Math.hypot(input.move.x, input.move.z) || 1;
        input.move.x /= l2; input.move.z /= l2;
      }
      // [playtest] 5 秒仍然出不去：玩家被卡在「碰撞圆压墙」的凹角里（四周 0.32 半径全部不可走，
        // 单轴/旋转试探都失败），只能找一个附近的可走点脱困。核心 movement 不提供传送，
        // 这里用 isWalkable 搜最近的可走点并直接落地（模拟"绕出来的那一步"）。
      if (this.stuckT > 5 && !this._escapedRecently) {
        const esc = this.findEscapePoint(p.x, p.z, 4.5);
        if (esc) {
          p.x = esc.x;
          p.z = esc.z;
          this.stuckT = 0;
          this._lastDir = null;
          this._slide = null;
          this.stats.stuckEscapes = (this.stats.stuckEscapes || 0) + 1;
          this.onLog?.(`卡死脱困 → (${esc.x.toFixed(1)}, ${esc.z.toFixed(1)}) t=${elapsed.toFixed(0)}s`);
        }
      }
    }

    const dx = tx - p.x, dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    // 卡墙时输入已被侧移覆盖，这里不要再覆盖它
    if (this.stuckT <= 0.3) {
      if (dist > 0.25) {
        const dir = this.pickWalkableDir(p.x, p.z, dx / dist, dz / dist, dist);
        input.move.x = dir.x;
        input.move.z = dir.z;
      } else if (fighting && nearest) {
        // 贴身时只微调角度，让普攻扇形覆盖目标
        const d2 = Math.hypot(nearest.x - p.x, nearest.z - p.z) || 1;
        input.move.x = (nearest.x - p.x) / d2 * 0.2;
        input.move.z = (nearest.z - p.z) / d2 * 0.2;
      }
    }

    // ---- 瞄准 & 攻击 ----
    if (nearest) input.aim = { x: nearest.x, z: nearest.z };
    else if (dropTarget) input.aim = { x: dropTarget.x, z: dropTarget.z };
    else input.aim = { x: p.x + Math.sin(p.facing || 0) * 3, z: p.z + Math.cos(p.facing || 0) * 3 };

    // [playtest] 贴身不重叠：玩家半径 0.45 + 怪半径 0.36~1.25，低于这个距离时
    // 攻击扇形（中心前推 0.8、半径 2.1）会把目标判在身后/夹角过大 → miss。
    // 所以主动保持 1.0~1.6 的「刀锋距离」。
    const bladeDist = nearest ? (nearest.radius || 0.45) + (p.radius || 0.45) + 0.35 : 0;
    if (this.preset.bladeSpacing && nearest && targetDist < bladeDist && targetDist > 0.001) {
      const ux = (p.x - nearest.x) / targetDist, uz = (p.z - nearest.z) / targetDist;
      input.move.x = ux;
      input.move.z = uz;
    }
    const attackOk = nearest && targetDist <= 2.4 && targetDist >= bladeDist * 0.85;
    if (!lowHp && attackOk) input.attackHeld = true;

    // ---- 技能 ----
    const manaPct = p.maxMp > 0 ? p.mp / p.maxMp : 0;
    const skills = [];
    const whirlOn = (p.skillBar || []).some((s) => s && s.id === 'whirlwind' && s.active);
    if (this.preset.skills) {
      if (!lowHp && nearest && nd <= 2.6 && manaPct > 0.18) skills.push('whirlwind');
      else if (whirlOn && lowHp) input.releaseChannels = true;
      // 战争践踏（1 号技能，取代裂地斩）：圆形范围眩晕 + 按命中数给自己上「踏地战甲」护甲 buff。
      // 它是控制 + 防御技能（CD 7 秒、伤害低于裂地斩），所以策略是「尽量在包围时放」：
      //   · 圆内有 ≥2 只怪（命中越多护甲越高）—— 任何时候都放，包括低血逃命时（护甲最救命）
      //   · 只有 1 只怪但已经很近（≤3.8）—— 也算控制收益（打断冲锋/普攻），但低血时不浪费
      //   · 蓝量留 18% 给旋风斩
      const stompWorth = nearest && (stompHits >= STOMP_CROWD || nd <= STOMP_NEAR_BIG);
      if (stompWorth && manaPct > 0.18 && (!lowHp || stompHits >= STOMP_CROWD)) skills.push('stomp');
      if (near4 >= 3) skills.push('warcry');
      // 血性狂暴会持续掉血，只在血线健康时开
      if (!lowHp && hpPct > 0.6 && nearest && nd <= 10) skills.push('bloodRage');
      if (nearest && nd <= 10) skills.push('rally');
    }
    input.skills = skills;

    // ---- 拾取 / 背包 ----
    if (!lowHp) this.tryPickup();
    this.manageBag();

    // ---- 技能升级（精炼石 / 技能点）：每 10 秒一次就够，模块缺失时内部直接跳过 ----
    if (elapsed - (this._lastSkillManage || -99) >= 10) {
      this._lastSkillManage = elapsed;
      this.autoManageSkills(elapsed);
    }

    // ---- 换图 ----
    this.maybeTravel(elapsed);
  }

  /**
   * 战争践踏的实际半径：优先读 core 的 SKILLS.stomp（含等级/天赋缩放后的口径取定义值），
   * 读不到用契约兜底值 3.6。
   */
  stompRadius() {
    try {
      const def = skillTreeMod.SKILLS && skillTreeMod.SKILLS.stomp;
      const r = def && (def.radius || def.range);
      if (isNum(r) && r > 0.5) return r;
    } catch { /* 忽略：用兜底值 */ }
    return STOMP_RADIUS_FALLBACK;
  }

  /**
   * 瓦片级 BFS 寻路：从玩家格子到目标格子，返回路径的下一个路点（世界坐标）。
   * 地牢是弯道/房间结构，直线导航会一直撞墙（实测卡死几分钟）。
   * 结果按 (fromTile→toTile) 缓存，目标移动换格时才重算。
   */
  findPathWaypoint(fromX, fromZ, toX, toZ) {
    const d = this.world.dungeon;
    if (!d || typeof d.isWalkableTile !== 'function' || typeof d.toTile !== 'function') return null;
    const [sx, sz] = d.toTile(fromX, fromZ);
    const [tx, tz] = d.toTile(toX, toZ);
    const key = `${sx},${sz}>${tx},${tz}`;
    const cached = this._pathCache;
    if (cached && cached.key === key && (this._now || 0) - cached.t < 0.5) return cached.wp;
    // BFS（每格 1 步上限 4000 节点，地牢最大 68x62）
    const cols = d.cols, rows = d.rows;
    const prev = new Int32Array(cols * rows).fill(-1);
    const seen = new Uint8Array(cols * rows);
    const q = [sz * cols + sx];
    seen[sz * cols + sx] = 1;
    const goal = tz * cols + tx;
    let found = false;
    let head = 0;
    let steps = 0;
    while (head < q.length && steps < 5000) {
      const cur = q[head++];
      steps++;
      if (cur === goal) { found = true; break; }
      const cx = cur % cols, cz = (cur / cols) | 0;
      // 4 邻（对角容易蹭墙，先不做）
      const nb = [cur + 1, cur - 1, cur + cols, cur - cols];
      const nx = [cx + 1, cx - 1, cx, cx];
      const nz = [cz, cz, cz + 1, cz - 1];
      for (let i = 0; i < 4; i++) {
        const ax = nx[i], az = nz[i];
        if (ax < 0 || az < 0 || ax >= cols || az >= rows) continue;
        const idx = nb[i];
        if (seen[idx]) continue;
        if (!d.isWalkableTile(ax, az)) continue;
        seen[idx] = 1;
        prev[idx] = cur;
        q.push(idx);
      }
    }
    let wp = null;
    if (found || seen[goal]) {
      // 从目标回溯到起点，取「起点之后的第一步」
      let cur = goal;
      let guard = 0;
      while (prev[cur] !== -1 && guard++ < cols * rows) {
        const p = prev[cur];
        if (p === sz * cols + sx) break;
        cur = p;
      }
      const wx = cur % cols, wz = (cur / cols) | 0;
      // 若起点格 == 目标格则不返回路点
      if (cur !== sz * cols + sx) wp = d.toWorld(wx, wz);
      else wp = null;
    }
    this._pathCache = { key, t: this._now || 0, wp };
    return wp;
  }

  /** 在 (x,z) 附近找一个可走的落点（同心圆扫描），找不到返回 null */
  findEscapePoint(x, z, maxR = 4.5) {
    const walk = this.world.isWalkable;
    if (typeof walk !== 'function') return null;
    for (let r = 0.5; r <= maxR; r += 0.25) {
      const steps = Math.max(8, Math.round(r * 12));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const nx = x + Math.cos(a) * r;
        const nz = z + Math.sin(a) * r;
        if (walk(nx, nz)) return { x: nx, z: nz };
      }
    }
    return null;
  }

  /** 选一个「能走」的移动方向。
   * 地牢里 1 格宽走廊 + 玩家半径 0.32 时，正对墙角会被两边同时挡住，
   * 所以先在目标方向上找最远的可走射线，再退化为单轴滑行 / 旋转试探。
   * 关键约束：相邻帧不要 180° 反转（否则会在两点间来回弹）。
   */
  pickWalkableDir(x, z, dx, dz, dist) {
    const w = this.world;
    if (typeof w.isWalkable !== 'function') return { x: dx, z: dz };
    const canStep = (ux, uz, len) => w.isWalkable(x + ux * len, z + uz * len);
    const prev = this._lastDir;
    // 1) 目标方向：沿射线试不同长度，取能走的最长步长（0.32~0.75）
    for (const len of [0.75, 0.6, 0.45, 0.32]) {
      if (canStep(dx, dz, len)) return this._remember({ x: dx, z: dz });
    }
    // 2) 单轴滑行（贴墙走）：若已有持续中的滑行方向且仍可走，就继续用它
    const held = this.slideDir();
    if (held && w.isWalkable(x + held.x * 0.45, z + held.z * 0.45)) return held;
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    // [playtest] 关键：滑行方向必须是「沿目标方向的投影」而不是反方向。
    // 原来会挑到 -目标z 的轴，结果每帧在走廊口前后弹（0.1 单位来回，卡 60 秒）。
    const axis = [];
    const prevD = this._lastDir;
    const good = (v) => v && (!prevD || v.x * prevD.x + v.z * prevD.z > -0.3);
    if (sx && canStep(sx, 0, 0.45) && good({ x: sx, z: 0 })) axis.push({ x: sx, z: 0 });
    if (sz && canStep(0, sz, 0.45) && good({ x: 0, z: sz })) axis.push({ x: 0, z: sz });
    if (axis.length) {
      const picked = this._pickNoFlip(axis);
      this.setSlide(picked, 0.8);
      return this._remember(picked);
    }
    // 3) 旋转试探（避开上一帧的反方向）
    const base = Math.atan2(dx, dz);
    const rot = [];
    for (const off of [0.8, -0.8, 1.6, -1.6, 2.4, -2.4]) {
      const a = base + off;
      const ux = Math.sin(a), uz = Math.cos(a);
      if (canStep(ux, uz, 0.45)) rot.push({ x: ux, z: uz });
    }
    if (rot.length) {
      const picked = this._pickNoFlip(rot);
      this.setSlide(picked, 0.5);
      return this._remember(picked);
    }
    return { x: dx, z: dz };
  }

  /** 记录方向 */
  _remember(dir) {
    this._lastDir = { x: dir.x, z: dir.z };
    return this._lastDir;
  }

  /** 在候选里优先选不与上一帧反向的 */
  _pickNoFlip(cands) {
    const prev = this._lastDir;
    if (!prev) return cands[0];
    let best = cands[0], bestDot = Infinity;
    for (const c of cands) {
      const dot = c.x * prev.x + c.z * prev.z;
      if (dot > bestDot) { bestDot = dot; best = c; }
    }
    return best;
  }

  /**
   * 贴墙滑行的「持续方向」：一旦选定一个绕行方向，就坚持 timeToKeep 秒，
   * 避免每帧在两个轴向之间来回切换（那会在原地打转，实测能卡 25 秒）。
   */
  slideDir() {
    const now = this._now || 0;
    if (this._slide && now < this._slideUntil) return this._slide;
    this._slide = null;
    return null;
  }

  setSlide(dir, keep = 0.6) {
    const now = this._now || 0;
    this._slide = { x: dir.x, z: dir.z };
    this._slideUntil = now + keep;
  }

  updateDropTarget(elapsed, nearest, nd) {
    const p = this.p;
    const items = this.world.items || [];
    if (!items.length) { this.targetDrop = null; return null; }
    if (nearest && nd < 7) { this.targetDrop = null; return null; } // 有怪先打
    if (this.targetDrop && this.targetDropT > elapsed - 6 && items.includes(this.targetDrop) && !this.targetDrop.gone) {
      return this.targetDrop;
    }
    let best = null, bd = 14 * 14;
    for (const d of items) {
      if (!d) continue;
      const dd = (d.x - p.x) ** 2 + (d.z - p.z) ** 2;
      if (dd < bd) { bd = dd; best = d; }
    }
    this.targetDrop = best;
    this.targetDropT = elapsed;
    return best;
  }

  nearestOrb(p, kind, radius) {
    const orbs = this.world.lootOrbs || [];
    let best = null, bd = radius * radius;
    for (const o of orbs) {
      if (!o || o.collected) continue;
      if (kind && o.kind !== kind) continue;
      const dd = (o.x - p.x) ** 2 + (o.z - p.z) ** 2;
      if (dd < bd) { bd = dd; best = o; }
    }
    return best;
  }

  /** 靠近掉落就捡（doPickup 内部按 2.4 距离找最近的） */
  tryPickup() {
    const p = this.p;
    const items = this.world.items || [];
    if (!items.length) return false;
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      if (!d) continue;
      if ((d.x - p.x) ** 2 + (d.z - p.z) ** 2 < 2.2 * 2.2) {
        const got = doPickup(this.game);
        if (got) {
          this.stats.pickups++;
          if (got.item) this.stats.pickedByRarity[normRarity(got.item.rarity)]++;
          this.autoEquip();
          return true;
        }
        return false;
      }
    }
    return false;
  }

  /** 背包里明显更好的装备就换上 */
  autoEquip() {
    const inv = this.game.inv;
    let guard = 0;
    for (let i = inv.bag.length - 1; i >= 0 && guard++ < 80; i--) {
      const item = inv.bag[i];
      if (!item) continue;
      const slotId = slotForItem(inv, item);
      if (!slotId) continue;
      const cur = inv.equip[slotId];
      // [playtest] 滞回 + 防抖：必须比当前装备强 15% 才换，且**同一件物品不重复穿**
      // （原来 2% 阈值 + 旧装备回包，会让分数相近的两件在「穿上→旧的回包→再穿回」之间
      // 来回横跳，实测一次跑测触发 587 / 199 次换装）。
      if (!cur || (itemScore(item) > itemScore(cur) * 1.15 && !this._equippedUids?.has(item.uid))) {
        const uid = item.uid || `n${i}`;
        if (doEquipFromBag(this.game, i)) {
          this.stats.equipped++;
          this._equippedUids = this._equippedUids || new Set();
          this._equippedUids.add(uid);
        }
      }
    }
  }

  manageBag() {
    const inv = this.game.inv;
    if (inv.bag.length >= inv.bagSize - 2) {
      const gold = doSellAllJunk(this.game);
      this.stats.goldFromSell += gold || 0;
      this.stats.sold++;
    }
  }

  maybeTravel(elapsed) {
    const sinceMap = elapsed - this.mapEnteredAt;
    // 第 1 层跑 firstMapDur（把地图词缀/精英波跑够），之后按 2-4 分钟节奏刷图。
    const dur = this.stats.travels === 0 ? Math.max(this.mapDurMin, this.firstMapDur) : this.mapDurMin;
    if (sinceMap < dur) return;
    // 附近还有掉落就多等一会儿（最多 20 秒）
    if (this.nearbyDrops(TRAVEL_LOOT_RADIUS) > 3 && sinceMap < dur + 20) return;
    this.travel(elapsed);
  }

  nearbyDrops(radius) {
    const p = this.p;
    let n = 0;
    for (const d of this.world.items || []) {
      if (!d) continue;
      if ((d.x - p.x) ** 2 + (d.z - p.z) ** 2 < radius * radius) n++;
    }
    return n;
  }

  /**
   * 换图：先把附近掉落收进背包（loadMap 会清空 world.items，不捡就丢数据）。
   * 移动是瞬移式的——机器人本体已经走到最近掉落点，剩下的只差几步，
   * 这里直接挪过去 + doPickup，等价于「走过去捡」。
   */
  travel(elapsed = 0) {
    // 记录本层效率（Lead 要求：每层停留秒数 / 击杀 / 掉落）
    const killsNow = this.stats.kills;
    const dropsNow = this.stats.dropped;
    if (this.mapEnteredAt != null && elapsed > this.mapEnteredAt) {
      const prev = this.layerStats[this.layerStats.length - 1];
      const layer = {
        layer: this.world.tier,
        sec: round(elapsed - this.mapEnteredAt, 1),
        kills: killsNow - (prev ? prev.killsTotal : 0),
        drops: dropsNow - (prev ? prev.dropsTotal : 0),
        level: this.world.player.level,
        killsTotal: killsNow,
        dropsTotal: dropsNow,
        mapsCleared: this.world.career.mapsCleared,
      };
      this.layerStats.push(layer);
    }
    const p = this.p;
    let guard = 0;
    while (guard++ < 60) {
      const items = this.world.items || [];
      let near = null, bd = TRAVEL_LOOT_RADIUS * TRAVEL_LOOT_RADIUS;
      for (const d of items) {
        if (!d) continue;
        const dd = (d.x - p.x) ** 2 + (d.z - p.z) ** 2;
        if (dd < bd) { bd = dd; near = d; }
      }
      if (!near) break;
      p.x = near.x; p.z = near.z;
      if (doPickup(this.game)) {
        this.stats.pickups++;
        if (near.item) this.stats.pickedByRarity[normRarity(near.item.rarity)]++;
        this.autoEquip();
      } else {
        // 背包满 / 物品已被取走：卖掉普通货再试，实在不行就放弃
        const gold = doSellAllJunk(this.game);
        this.stats.goldFromSell += gold || 0;
        if (!doPickup(this.game)) {
          const idx = items.indexOf(near);
          if (idx >= 0) items.splice(idx, 1);
          this.stats.lostDrops++;
        } else {
          this.stats.pickups++;
          if (near.item) this.stats.pickedByRarity[normRarity(near.item.rarity)]++;
          this.autoEquip();
        }
      }
    }
    travelToNewMap(this.game);
    this.stats.travels++;
    this.stats.maxTier = Math.max(this.stats.maxTier, this.world.tier);
    this.mapEnteredAt = elapsed;
    this.planA += 1.7;
    this.targetDrop = null;
    syncTalentPoints(this.game);
    this.autoSpendTalents();
    this.autoManageSkills(elapsed);
    this.onLog?.(`换图 → 第 ${this.world.tier} 层（t=${elapsed.toFixed(0)}s）`);
  }

  /** DPS 估计：最近 15 秒的伤害事件 */
  dpsWindow(elapsed) {
    const win = Math.min(15, Math.max(1, elapsed));
    const cutoff = elapsed - win;
    let sum = 0;
    for (let i = this.recentHits.length - 1; i >= 0; i--) {
      const h = this.recentHits[i];
      if (h.t < cutoff) break;
      sum += h.amount;
    }
    return round(sum / win, 1);
  }
}

// ---------------------------------------------------------------------------
// 快照 / 完整性检查
// ---------------------------------------------------------------------------
function sampleSnapshot(game, bot, elapsed) {
  const w = game.world;
  const p = w.player;
  const s = p.stats || {};
  return {
    t: round(elapsed, 1),
    tier: w.tier,
    level: p.level,
    hp: Math.round(p.hp),
    maxHp: Math.round(p.maxHp),
    dps15: bot.dpsWindow(elapsed),
    kills: bot.stats.kills,
    pickups: bot.stats.pickups,
    aliveMonsters: (w.monsters || []).filter((m) => m && !m.dead).length,
    events: (w.events || []).length,
    projectiles: (w.projectiles || []).length,
    dmgMin: Math.round(s.dmgMin || 0),
    dmgMax: Math.round(s.dmgMax || 0),
  };
}

function pushMinuteSnapshot(list, game, bot, elapsed) {
  const p = game.world.player;
  const prev = list[list.length - 1];
  const kills = bot.stats.kills;
  const pickups = bot.stats.pickups;
  list.push({
    minute: list.length + 1,
    tSec: round(elapsed, 0),
    periodSec: round(prev ? elapsed - prev.tSec : elapsed, 0),
    tier: game.world.tier,
    level: p.level,
    maxHp: Math.round(p.maxHp),
    killsTotal: kills,
    killsDelta: kills - (prev ? prev.killsTotal : 0),
    pickupsTotal: pickups,
    dropsDelta: pickups - (prev ? prev.pickupsTotal : 0),
    deaths: bot.stats.deaths,
    gold: p.gold || 0,
    dpsAvg: round(bot.stats.dtDealt / Math.max(1, elapsed), 1),
    dmgTaken: round(bot.stats.dtTaken, 0),
    equipped: bot.stats.equipped,
    talents: (game.inv.talents || []).length,
    bag: game.inv.bag.length,
    aliveMonsters: Number(game.world.stats?.aliveCount || 0),
  });
}

/** 完整性检查：NaN / 硬上限 */
function checkIntegrity(report, nanSeen, peak, world, p, elapsed) {
  const nan = (key, v) => {
    if (isNum(v) || nanSeen.has(key)) return;
    nanSeen.add(key);
    report.nanIssues[key] = { t: round(elapsed, 1), value: String(v) };
  };
  const s = p.stats || {};
  nan('player.hp', p.hp);
  nan('player.maxHp', p.maxHp);
  nan('player.mp', p.mp);
  nan('player.maxMp', p.maxMp);
  nan('player.x', p.x);
  nan('player.z', p.z);
  nan('player.level', p.level);
  nan('player.xp', p.xp);
  nan('player.gold', p.gold || 0);
  if (isNum(p.hp) && p.hp < 0) nan('player.hp<0', p.hp);
  if (isNum(p.maxHp) && p.maxHp <= 0) nan('player.maxHp<=0', p.maxHp);
  for (const k of Object.keys(s)) nan('stats.' + k, s[k]);

  const counts = {
    monsters: (world.monsters || []).length,
    projectiles: (world.projectiles || []).length,
    all: (world.all || []).length,
    items: (world.items || []).length,
    lootOrbs: (world.lootOrbs || []).length,
    events: (world.events || []).length,
    particles: (world.particles || []).length,
    groundEffects: (world.groundEffects || []).length,
    summoned: (world.summoned || []).length,
  };
  for (const k in counts) peak[k] = Math.max(peak[k] || 0, counts[k]);

  // 怪物数值也不能有 NaN（只抽样前 200 只，避免检查本身太慢）
  const list = world.monsters || [];
  const n = Math.min(list.length, 200);
  for (let i = 0; i < n; i++) {
    const m = list[i];
    if (!m) continue;
    if (!isNum(m.hp) || !isNum(m.maxHp) || !isNum(m.x) || !isNum(m.z)) { nan('monster.numeric', `id=${m.id} hp=${m.hp}/${m.maxHp}`); break; }
  }

  for (const k of Object.keys(HARD_CAPS)) {
    if (counts[k] > HARD_CAPS[k] && !report.capBreaches[k]) {
      report.capBreaches[k] = { t: round(elapsed, 1), count: counts[k], cap: HARD_CAPS[k] };
      report.errors.push({ phase: 'hardCap', t: round(elapsed, 1), message: `${k} 超过硬上限：${counts[k]} > ${HARD_CAPS[k]}` });
    }
  }
}

/**
 * 取玩家身上「踏地战甲」(warStompArmor) 的剩余情况。
 * buff 容器在不同模块里可能是数组（带 id/remaining/dur）或对象（key → buff），两种都兼容。
 * @returns {{armor:number, remaining:number, dur:number}|null}
 */
function sampleWarStompArmor(p) {
  const buffs = p && p.buffs;
  if (!buffs) return null;
  const one = (b) => {
    if (!b || (b.id !== 'warStompArmor' && b.key !== 'warStompArmor')) return null;
    const st = b.stats || {};
    return {
      armor: round(Number(st.armor) || 0, 0),
      remaining: round(Number(b.remaining ?? b.time ?? 0) || 0, 1),
      dur: round(Number(b.dur ?? b.duration ?? 0) || 0, 1),
    };
  };
  if (Array.isArray(buffs)) {
    for (const b of buffs) { const r = one(b); if (r) return r; }
    return null;
  }
  if (typeof buffs === 'object') {
    const r = one(buffs.warStompArmor);
    if (r) return r;
    for (const k in buffs) { const rr = one(buffs[k]); if (rr) return rr; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
export async function runPlaytest(opts = {}) {
  const o = { minutes: 10, seed: 42, tier: 1, verbose: false, quiet: false, maxSteps: Infinity, onLog: null, bot: 'skilled', ...opts };
  const report = {
    ok: false,
    config: { minutes: o.minutes, seed: o.seed, tier: o.tier, bot: BOT_PRESETS[o.bot] ? o.bot : 'skilled' },
    errors: [],
    warnings: [],
    nanIssues: {},
    capBreaches: {},
    memory: {},
    timeline: [],
  };

  let game;
  try {
    game = createGame({ seed: o.seed, tier: o.tier });
  } catch (e) {
    report.errors.push({ phase: 'createGame', message: String((e && e.message) || e), stack: String((e && e.stack) || '') });
    return report;
  }

  // ---- 可选模块：技能升级 / 精炼石（模块级已同步加载，缺失时整段跳过）----
  if (o.verbose && !o.quiet) {
    const missing = [];
    if (!PROGRESSION) missing.push('src/items/skillProgression.js');
    for (const k of Object.keys(APP_FN)) if (!APP_FN[k]) missing.push(`app.${k}`);
    for (const w of OPTIONAL_MODULE_WARNINGS) report.warnings.push({ phase: 'optionalModule', message: w });
    console.log(`  · 技能系统模块：${missing.length ? '缺失 → ' + missing.join('、') : '全部就绪（精炼石 / 重置 / 技能点总量）'}`);
  }

  // ---- headless UI（空实现 + 有限长度的 toast 日志）----
  const toastLog = [];
  game.ui = {
    onEvents() {},
    toast(msg) {
      if (toastLog.length >= MEM_CAPS.msgs) toastLog.shift();
      toastLog.push(String(msg));
    },
    onDeath() {}, onInventoryChange() {}, onTalentsChange() {}, onSkillsChange() {},
    onMapChange() {}, onRespawn() {}, onSkillsChange2() {},
  };

  const bot = new Bot(game, { seed: o.seed, preset: o.bot, onLog: o.verbose && !o.quiet ? (m) => console.log(`  · ${m}`) : o.onLog });
  const world = game.world;
  const p = world.player;
  const startLevel = p.level;

  // 起手把 createPlayer 里的天赋点搬进 inv
  syncTalentPoints(game);

  const totalSec = Math.max(0, o.minutes * 60);
  const steps = Math.min(Math.round(totalSec / DT), o.maxSteps);
  const nanSeen = new Set();
  const peak = {};
  const t0 = Date.now();
  const hr0 = process.hrtime.bigint();

  let elapsed = 0;
  let nextVerbose = 30;
  let nextSnapshot = 60;
  let nextCheck = 5;
  let prevKills = 0;
  let prevPickups = 0;
  let lastPerf = Date.now();
  let slowFrames = 0;
  let totalFrameMs = 0;
  let sampleCount = 0;
  // 生存 / 回复 / Boss 战统计
  let hpSamples = 0, hpPctSum = 0, lowHpFrames = 0, critHpFrames = 0, healsTotal = 0;
  let lastHp = p.hp;
  let bossEngage = null, bossBattleDone = false;
  // 战争践踏护甲 buff（踏地战甲）覆盖率：每秒采样 player.buffs 里有没有它
  let armorSamples = 0, armorOnSamples = 0;

  for (let i = 0; i < steps; i++) {
    try {
      bot.step(elapsed);
    } catch (e) {
      report.errors.push({
        phase: 'updateGame', step: i, t: round(elapsed, 2),
        message: String((e && e.message) || e),
        stack: String((e && e.stack) || '').split('\n').slice(0, 8).join('\n'),
      });
      break; // 出异常立即停，避免刷屏
    }
    // 记录死亡（player.dead 被 updateGame 置位，revivePlayer 会清）
    if (p.dead && !bot.deathCounted) { bot.stats.deaths++; bot.deathCounted = true; }
    if (!p.dead) bot.deathCounted = false;

    // 血量占比采样（每秒一次）：用于「平均血量 / 濒死时间」分析
    if (i % 60 === 0 && Number.isFinite(p.maxHp) && p.maxHp > 0) {
      const pct = Math.max(0, Math.min(1, p.hp / p.maxHp));
      hpSamples++;
      hpPctSum += pct;
      if (pct < 0.35) lowHpFrames++;
      if (pct < 0.15) critHpFrames++;
      // 回复量：本秒内 hp 上升量（不含升级/换图回满，那些是突跳）
      const gained = p.hp - lastHp;
      if (gained > 0 && gained < p.maxHp * 0.5) healsTotal += gained;
      lastHp = p.hp;
      // Boss 战记录
      const boss = (world.monsters || []).find((m) => m && m.isBoss && !m.dead);
      if (boss) {
        if (!bossEngage) {
          bossEngage = {
            t: round(elapsed, 1), level: boss.level, hp: Math.round(boss.maxHp),
            playerLevel: p.level, hpTrace: [],
          };
        }
        bossEngage.hpTrace.push(Math.round((boss.hp / boss.maxHp) * 100));
        bossEngage.playerHpMin = Math.min(bossEngage.playerHpMin ?? 1, pct);
      } else if (bossEngage && !bossBattleDone) {
        bossBattleDone = true;
        bossEngage.endT = round(elapsed, 1);
        bossEngage.ttk = round(elapsed - bossEngage.t, 2);
        bossEngage.killed = true;
      }
    }
    // 玩家在 Boss 战里死亡
    if (bossEngage && p.dead && !bossEngage.playerDied) bossEngage.playerDied = true;

    // 踏地战甲（warStompArmor）覆盖率：每秒采样一次 buff 是否存在
    if (i % 60 === 0) {
      armorSamples++;
      const armorBuff = sampleWarStompArmor(p);
      if (armorBuff) {
        armorOnSamples++;
        bot.stats.warStompArmor = armorBuff.armor;
        bot.stats.warStompArmorDur = armorBuff.remaining;
        bot.stats.warStompArmorFrames++;
      }
    }

    // 性能采样：每 60 帧（1 秒）记一次耗时
    if (i % 60 === 0) {
      const now = Date.now();
      const ms = now - lastPerf;
      lastPerf = now;
      totalFrameMs += ms;
      sampleCount++;
      if (ms > 250) slowFrames++;
    }

    elapsed += DT;
    if (elapsed >= nextCheck) {
      nextCheck += 5;
      checkIntegrity(report, nanSeen, peak, world, p, elapsed);
    }

    // verbose：每 30 秒一行进度
    if (o.verbose && !o.quiet && elapsed >= nextVerbose) {
      nextVerbose += 30;
      const kpm = round((bot.stats.kills - prevKills) / 0.5, 1);
      const ppm = round((bot.stats.pickups - prevPickups) / 0.5, 1);
      prevKills = bot.stats.kills;
      prevPickups = bot.stats.pickups;
      const alive = (world.monsters || []).filter((m) => m && !m.dead).length;
      console.log(
        `[${String(Math.floor(elapsed)).padStart(4)}s] 第${world.tier}层 Lv${String(p.level).padStart(2)} ` +
        `HP ${Math.round(p.hp)}/${Math.round(p.maxHp)} 怪${String(alive).padStart(2)} ` +
        `击杀 ${String(bot.stats.kills).padStart(5)}(+${kpm}/30s) 拾取 +${ppm} 死亡 ${bot.stats.deaths} ` +
        `DPS ${bot.dpsWindow(elapsed)} 累计DPS ${round(bot.stats.dtDealt / Math.max(1, elapsed))} ` +
        `天赋 ${(game.inv.talents || []).length} 背包 ${game.inv.bag.length}/${game.inv.bagSize} ` +
        `投射物 ${(world.projectiles || []).length}`,
      );
    }

    // 每 60 秒成就快照
    if (elapsed >= nextSnapshot) {
      nextSnapshot += 60;
      pushMinuteSnapshot(report.timeline, game, bot, elapsed);
    }
  }

  const cpuMs = Number(process.hrtime.bigint() - hr0) / 1e6;
  const wallSec = (Date.now() - t0) / 1000;
  checkIntegrity(report, nanSeen, peak, world, p, elapsed);
  if (!report.timeline.length || report.timeline[report.timeline.length - 1].tSec < elapsed - 1) {
    pushMinuteSnapshot(report.timeline, game, bot, elapsed);
  }

  // ---- 汇总 ----
  const s = bot.stats;
  const inv = game.inv;
  const effMin = Math.max(elapsed / 60, 1 / 60);
  const ps = p.stats || {};
  const equipByRarity = { normal: 0, magic: 0, rare: 0, legendary: 0 };
  const equipBySlot = {};
  for (const slotId in inv.equip) {
    const it = inv.equip[slotId];
    if (!it) continue;
    equipByRarity[normRarity(it.rarity)]++;
    equipBySlot[slotId] = { name: it.displayName || it.name || it.baseName, rarity: it.rarity, slot: it.slot, score: itemScore(it) };
  }
  const bagByRarity = { normal: 0, magic: 0, rare: 0, legendary: 0 };
  for (const it of inv.bag) if (it) bagByRarity[normRarity(it.rarity)]++;
  // 拾取流程里按稀有度记过数；如果换图时的「瞬移拾取」没记录，用背包+已装备兜底
  const pickedTotal = Object.values(s.pickedByRarity).reduce((a, b) => a + b, 0);
  const pickups = Math.max(s.pickups, s.pickupEvents || 0, pickedTotal);

  const levelCurve = report.timeline.map((m) => ({ minute: m.minute, level: m.level, tier: m.tier, maxHp: m.maxHp }));
  const topLevel = Math.max(p.level, ...report.timeline.map((m) => m.level), 1);

  // ---- 技能升级 / 精炼石 / 分叉天赋（本次新增）----
  const skillIds = bot.skillIds();
  const refineStat = s.refine;
  const orbsHave = Math.max(0, Math.round(Number(inv.skillOrbs) || 0));
  const orbsGained = Math.max(refineStat.orbsGained, refineStat.orbsGainedByScan);
  const refineRows = skillIds.map((id) => {
    const castCount = bot.skillCasts[id] || 0;
    const chk = bot.refineCheck(id);
    const def = (skillTreeMod.SKILLS && skillTreeMod.SKILLS[id]) || null;
    const tree = (skillTreeMod.SKILL_TREES && skillTreeMod.SKILL_TREES[id]) || null;
    const lv = bot.skillLevelDetail(id);
    return {
      id,
      // 名称优先取「树里的中文名」> core SKILLS 的 name > SKILL_NAMES > id
      name: (tree && tree.name) || (def && def.name) || (skillTreeMod.SKILL_NAMES && skillTreeMod.SKILL_NAMES[id]) || id,
      // level = 节点数口径（契约），levelRanks = core 档位和口径（战斗实际值），两者不一致时报告会提示
      level: lv.levelNodes,
      levelRanks: lv.levelRanks,
      refine: lv.refine,
      talentPoints: lv.rankSum,
      talentNodes: lv.nodeCount,
      focus: bot.skillFocus(id),
      casts: castCount,
      canRefine: chk.ok,
      nextCost: chk.cost || null,
      reason: chk.reason || '',
    };
  });
  report.skills = {
    orbs: {
      gained: orbsGained,
      gainedByEvent: refineStat.orbsGained,
      gainedByDiff: refineStat.orbsGainedByScan,
      gainEvents: refineStat.orbGainEvents,
      spent: refineStat.orbsSpent,
      spentOnRefine: refineStat.orbsSpent - refineStat.respecOrbs,
      spentOnRespec: refineStat.respecOrbs,
      left: orbsHave,
      reserve: RESERVE_ORBS,
    },
    refines: refineStat.refined,
    refineAttempts: refineStat.refineAttempts,
    respecs: refineStat.respecs,
    forkConflicts: refineStat.conflicts,
    blockedNodes: { ...refineStat.blockedNodes },
    // 机器人最终点出来的节点（排查分叉/互斥时最有用）
    ranks: { ...(inv.skillRanks || {}) },
    skillPointsTotal: (() => {
      const v = APP_FN.skillPointsTotal ? APP_FN.skillPointsTotal(game) : undefined;
      if (isNum(v)) return v;
      try { return skillPointsFor(game, ''); } catch { return 0; }
    })(),
    levels: refineRows.map((r) => ({
      id: r.id, name: r.name,
      level: r.level,            // 节点数口径（契约 §3.4）
      levelRanks: r.levelRanks,  // 档位和口径（core 实际战斗值）
      refine: r.refine, talentPoints: r.talentPoints, talentNodes: r.talentNodes,
    })),
    forks: refineRows.map((r) => ({ id: r.id, name: r.name, focus: r.focus })),
    // 已点的「分支节点」个数（left* / right*）：0 = 机器人还没把点投到分叉层，
    // >0 却没有 focus 才是数据异常（报告里会区分这两种情况）
    branchPoints: skillIds.reduce((a, id) => a + bot.branchPointsOf(id), 0),
    rows: refineRows,
    // 可选模块是否就绪（用于判断报告里的 0 是「没用」还是「没接口」）
    modules: {
      skillProgression: !!PROGRESSION,
      doSkillRefine: !!APP_FN.doSkillRefine,
      doSkillRespec: !!APP_FN.doSkillRespec,
      skillPointsTotal: !!APP_FN.skillPointsTotal,
      syncSkillSystems: !!APP_FN.syncSkillSystems,
      warnings: OPTIONAL_MODULE_WARNINGS.slice(),
    },
    // 技能使用分布（skillCast 事件计数）
    casts: { ...bot.skillCasts },
  };

  // ---- 战争践踏 / 眩晕（本次新增）----
  const armorCoverage = armorSamples ? round((armorOnSamples / armorSamples) * 100, 1) : null;
  report.stomp = {
    casts: s.stompCasts,
    hits: s.stompHits,
    avgHits: s.stompCasts ? round(s.stompHits / s.stompCasts, 2) : 0,
    zeroHitCasts: s.stompZeroHitCasts,
    stuns: s.stuns,
    stunEnds: s.stunEnds,
    stunSeconds: round(s.stunSeconds, 1),
    armorBuffCoveragePct: armorCoverage,
    armorMax: round(s.warStompArmorMax, 0),
    lastArmor: round(s.warStompArmor, 0),
    lastArmorRemaining: round(s.warStompArmorDur, 1),
  };

  report.player = {
    level: topLevel,
    finalLevel: p.level,
    startLevel,
    xp: Math.round(p.xp || 0),
    maxHp: Math.round(p.maxHp),
    maxMp: Math.round(p.maxMp),
    stats: {
      dmgMin: Math.round(ps.dmgMin || 0),
      dmgMax: Math.round(ps.dmgMax || 0),
      aps: round(1.35 * (1 + (ps.attackSpeedMult || 0)), 2),
      crit: round(ps.critChance || 0, 3),
      critMulti: round(ps.critMulti || 1.5, 2),
      armor: Math.round(ps.armor || 0),
      evasion: round(ps.evasion || 0, 3),
      moveSpeed: round(6.2 * (1 + (ps.moveSpeedMult || 0)), 2),
      cdr: round(ps.cdrMult || 0, 3),
      aoe: round(ps.aoeMult || 0, 3),
      damageMult: round(ps.damageMult || 0, 3),
      lifeLeech: round(ps.lifeLeech || 0, 3),
      resists: {
        fire: round(ps.fireResist || 0, 3), cold: round(ps.coldResist || 0, 3),
        lightning: round(ps.lightningResist || 0, 3), chaos: round(ps.chaosResist || 0, 3),
      },
    },
    gold: p.gold || 0,
    bagGold: inv.gold || 0,
    talentsTaken: Math.max(0, (inv.talents || []).length - 1),
    talentPointsLeft: inv.talentPoints || 0,
    skillRanks: Object.values(inv.skillRanks || {}).reduce((a, b) => a + (b || 0), 0),
    equipped: equipBySlot,
  };

  report.progress = {
    kills: s.kills,
    killsPerMin: round(s.kills / effMin, 1),
    killsByRarity: s.killsByRarity,
    deaths: s.deaths,
    revives: s.revives,
    travels: s.travels,
    highestTier: Math.max(world.career?.bestTier || 1, world.tier, s.maxTier),
    currentTier: world.tier,
    mapsCleared: world.career?.mapsCleared || 0,
    levelCurve,
    levelPerMin: round((topLevel - startLevel) / effMin, 2),
    playTimeSec: round(world.career?.playTime || elapsed, 1),
  };

  report.layerStats = {
    layers: bot.layerStats,
    avgSecPerLayer: bot.layerStats.length
      ? round(bot.layerStats.reduce((a, l) => a + l.sec, 0) / bot.layerStats.length, 1)
      : 0,
    avgKillsPerLayer: bot.layerStats.length
      ? round(bot.layerStats.reduce((a, l) => a + l.kills, 0) / bot.layerStats.length, 1)
      : 0,
  };

  report.boss = {
    encounters: s.bossEncounters || 0,
    kills: s.bossKills || 0,
    lastTTK: s.bossTTK ?? null,
    battle: bossEngage
      ? {
          level: bossEngage.level,
          maxHp: bossEngage.hp,
          playerLevel: bossEngage.playerLevel,
          ttk: bossEngage.ttk ?? null,
          killed: !!bossEngage.killed,
          playerDied: !!bossEngage.playerDied,
          playerHpMinPct: bossEngage.playerHpMin != null ? round(bossEngage.playerHpMin * 100, 0) : null,
          hpTracePct: bossEngage.hpTrace.filter((_, i2) => i2 % 2 === 0).slice(0, 40),
        }
      : null,
  };

  // ---- 生存 / 回复（站桩基线对比用）----
  const effMin2 = Math.max(elapsed / 60, 1 / 60);
  report.survival = {
    avgHpPct: hpSamples ? round((hpPctSum / hpSamples) * 100, 1) : null,
    // 低于 35% 生命的时间占比（濒死压力）
    lowHpPct: hpSamples ? round((lowHpFrames / hpSamples) * 100, 1) : null,
    critHpPct: hpSamples ? round((critHpFrames / hpSamples) * 100, 1) : null,
    damageTakenPerMin: round(s.dtTaken / effMin2, 1),
    healedPerMin: round(healsTotal / effMin2, 1),
    // 回复/受伤比：> 1 说明回复过剩（怪物偏弱），< 0.3 说明生存压力大
    healRatio: s.dtTaken > 0 ? round(healsTotal / s.dtTaken, 2) : null,
    deaths: s.deaths,
    deathsPerMin: round(s.deaths / effMin2, 2),
    timeToFirstDeathSec: s.firstDeathAt ?? null,
  };

  report.combat = {
    dps: {
      byDamageEvents: round(s.dtDealt / Math.max(1, elapsed), 1),
      theoretical: round(
        1.35 * (1 + (ps.attackSpeedMult || 0)) * (((ps.dmgMin || 0) + (ps.dmgMax || 0)) / 2)
        * (1 + (ps.damageMult || 0)) * (1 + 0.05 * ((ps.critMulti || 1.5) - 1)), 1),
      takenPerSec: round(s.dtTaken / Math.max(1, elapsed), 1),
      totalDealt: round(s.dtDealt, 0),
      totalTaken: round(s.dtTaken, 0),
    },
    hits: s.hits,
    hitsPerSec: round(s.hits / Math.max(1, elapsed), 2),
    avgHit: s.hits ? round(s.dtDealt / s.hits, 1) : 0,
    swings: s.swings,
  };

  report.loot = {
    // 掉落以 loot 事件为准（自动拾取不经过 doPickup，按 doPickup 统计会漏）
    dropped: s.dropped,
    dropsPerMin: round(s.dropped / effMin, 2),
    byRarity: { ...s.droppedByRarity },
    per100Kills: s.kills ? round((s.dropped / s.kills) * 100, 1) : 0,
    // 拾取：手动 doPickup + 自动拾取事件
    pickups: Math.max(s.pickups, s.pickupEvents || 0, s.picked),
    perMin: round(Math.max(s.pickups, s.pickupEvents || 0) / effMin, 2),
    pickedByRarity: { ...s.pickedByRarity },
    equippedChanges: s.equipped,
    autoEquipped: s.autoEquipped,
    sellAllCalls: s.sold,
    goldFromSell: s.goldFromSell,
    bagRarityAtEnd: bagByRarity,
    equippedRarity: equipByRarity,
    lostDrops: s.lostDrops,
  };

  report.memory = {
    peak,
    caps: { ...HARD_CAPS },
    memCaps: { ...MEM_CAPS },
    eventsAtEnd: (world.events || []).length,
    particlesAtEnd: (world.particles || []).length,
    toastLogLen: toastLog.length,
    maxParticlesSeen: peak.particles || 0,
  };

  report.wall = {
    simulatedSec: round(elapsed, 1),
    wallSec: round(wallSec, 2),
    cpuMs: round(cpuMs, 0),
    realtimeFactor: round(elapsed / Math.max(0.001, wallSec), 1),
    stepsRun: Math.round(elapsed / DT),
    msPerSimSecond: sampleCount ? round(totalFrameMs / sampleCount, 2) : 0,
    slowSeconds: slowFrames,
  };

  // ---- 平衡检查（对照任务书目标）----
  report.balance = evaluateBalance(report, game);

  report.ok = report.errors.length === 0
    && Object.keys(report.nanIssues).length === 0
    && Object.keys(report.capBreaches).length === 0;
  return report;
}

/**
 * 对照平衡目标打分。返回 { checks: [{name, target, actual, pass}], verdict }
 * 目标只对「10 分钟」的跑测生效（时间不同则标 n/a）。
 */
export function evaluateBalance(report, game) {
  const checks = [];
  const add = (name, target, actual, pass) => checks.push({ name, target, actual, pass });
  const pr = report.progress;
  const lt = report.loot;
  const cb = report.combat;
  const tenMin = report.config.minutes >= 10;

  add('10 分钟等级', '8-15 级', `${pr.levelCurve.length ? pr.levelCurve[pr.levelCurve.length - 1].level : '?'} 级`, null);
  add('10 分钟到达层数', '3-6 层', `${pr.highestTier} 层`, null);
  add('掉落速率', '5-15 件/分钟', `${lt.dropsPerMin} 件/分钟`, null);
  add('传奇（10 分钟）', '≤1 件', `${lt.byRarity.legendary} 件`, null);

  if (tenMin) {
    const last = report.player.level;
    checks[0].pass = last >= 8 && last <= 15;
    checks[1].pass = pr.highestTier >= 3 && pr.highestTier <= 6;
    checks[2].pass = lt.dropsPerMin >= 5 && lt.dropsPerMin <= 15;
    checks[3].pass = lt.byRarity.legendary <= 1;
  }
  const failed = checks.filter((c) => c.pass === false);
  return {
    checks,
    verdict: tenMin ? (failed.length ? `不达标 ${failed.length} 项` : '全部达标') : '非 10 分钟跑测，仅记录数值',
    dungeonStats: {
      dpsByDamageEvents: cb.dps.byDamageEvents,
      theoreticalDps: cb.dps.theoretical,
      takenPerSec: cb.dps.takenPerSec,
      equipSlots: Object.keys(report.player.equipped).length,
      levelCurve: report.player.level,
    },
    game: game ? undefined : undefined,
  };
}

// ---------------------------------------------------------------------------
// 人类可读输出
// ---------------------------------------------------------------------------
/**
 * 「技能升级」三行（本次新增）：精炼石收支 / 技能等级 / 分叉选择。
 * 模块没就绪时给出明确提示，避免把「0」误读成平衡问题。
 */
function logSkillLines(log, sk) {
  const o = sk.orbs;
  const lvText = sk.levels.length
    ? sk.levels.map((r) => `${r.name} Lv.${r.level}`).join(' / ')
    : '（无技能数据）';
  log(` 技能等级：${lvText}`);
  // 口径对照：core 用「档位和」、data 用「节点数」，两者不同时直接列出来（已报给 Lead 统一）
  const diff = (sk.levels || []).filter((r) => r.levelRanks != null && r.levelRanks !== r.level);
  if (diff.length) {
    log(` 战斗口径：${diff.slice(0, 6).map((r) => `${r.name} Lv.${r.levelRanks}`).join(' / ')}`
      + `（core skillsUpgrade 按「档位和」，契约 §3.4 / 面板按「节点数」= 上面那行；两处口径待统一）`);
  }
  const forkText = sk.forks.some((f) => f.focus)
    ? sk.forks.map((f) => `${f.name} ${f.focus === 'left' ? '左支' : f.focus === 'right' ? '右支' : '未分叉'}`).join(' / ')
    // 一个分支节点都没点：不是「数据缺失」，而是「机器人还没把点投到分支层」
    : (sk.branchPoints > 0
      ? sk.forks.map((f) => `${f.name} 未分叉`).join(' / ')
      : `未分叉（${sk.branchPoints || 0} 个分支节点已点：技能点还不够深）`);
  log(` 分叉选择：${forkText}`);
  log(
    ` 技能精炼石：获得 ${o.gained} 颗，已用 ${o.spent} 颗（精炼 ${o.spentOnRefine} / 重置 ${o.spentOnRespec}），` +
    `手里 ${o.left} 颗（预留 ${o.reserve} 颗）   成功精炼 ${sk.refines} 次   重置天赋 ${sk.respecs} 次`,
  );
  const mod = sk.modules || {};
  if (!mod.skillProgression || !mod.doSkillRefine) {
    const miss = [];
    if (!mod.skillProgression) miss.push('src/items/skillProgression.js');
    if (!mod.doSkillRefine) miss.push('app.doSkillRefine');
    if (!mod.doSkillRespec) miss.push('app.doSkillRespec');
    log(` ⚠ 精炼石功能未就绪（缺 ${miss.join('、')}），本局跳过精炼——这三个统计为 0 属预期`);
  } else if (o.gained === 0 && sk.casts && Object.keys(sk.casts).length > 0) {
    // 接口都就绪、技能也在放，但一颗石头都没拿到：多半是掉落（loot.js）还没接 skillOrb
    log(' ⚠ 本局没拿到技能精炼石：检查 core/loot.js 是否已掉 kind=\'skillOrb\'，以及自动拾取是否入包');
  }
  const blocked = Object.keys(sk.blockedNodes || {});
  if (blocked.length) log(` 互斥/前置被拒：${blocked.length} 个节点（共 ${sk.forkConflicts} 次跳过），例如 ${blocked.slice(0, 4).join('、')}`);
}

/** 「战争践踏 / 眩晕」两行（本次新增）*/
function logStompLines(log, st) {
  const cov = st.armorBuffCoveragePct;
  log(` 战争践踏   释放 ${st.casts} 次 / 命中 ${st.hits} 次（平均 ${st.avgHits} 个目标）   眩晕 ${st.stuns} 次（累计 ${st.stunSeconds}s）结束 ${st.stunEnds} 次`);
  log(` 踏地战甲   覆盖率 ${cov == null ? '-' : cov + '%'}   最近一层护甲 +${st.lastArmor}（剩 ${st.lastArmorRemaining}s）   单次最高 +${st.armorMax}`);
}

export function formatReport(report) {
  const L = [];
  const log = (s = '') => L.push(s);
  const c = report.config;
  const pad = (v, n) => String(v).padStart(n);
  log('══════════════════════════════════════════════════════════════════');
  log(` 无头自动通关测试   seed=${c.seed}  起始 tier=${c.tier}   机器人=${c.bot || 'skilled'}（${(BOT_PRESETS[c.bot] || BOT_PRESETS.skilled).label}）   游戏时长=${report.wall?.simulatedSec ?? 0}s`);
  log('══════════════════════════════════════════════════════════════════');
  for (const e of report.errors.slice(0, 8)) log(` ❌ [${e.phase}] t=${e.t ?? '-'} ${e.message}`);
  for (const k of Object.keys(report.nanIssues)) log(` ❌ NaN: ${k} = ${report.nanIssues[k].value} (t=${report.nanIssues[k].t})`);
  if (!report.player) { log(' （无报告：createGame 失败）'); return L.join('\n'); }

  const p = report.player, pr = report.progress, cb = report.combat, lt = report.loot, wall = report.wall, mem = report.memory;
  log('');
  log('── 成长 ──────────────────────────────────────────────────────────');
  log(` 等级 ${p.level}（起手 ${p.startLevel}）   最大生命 ${fmtInt(p.maxHp)}   最大法力 ${fmtInt(p.maxMp)}   升级速率 ${pr.levelPerMin}/分钟`);
  log(` 等级曲线  ${pr.levelCurve.map((x) => `${x.minute}min:Lv${x.level}`).join('  ') || '（不足 1 分钟）'}`);
  log(` 到达层数 ${pr.highestTier} 层（换图 ${pr.travels} 次，清图计数 ${pr.mapsCleared}）   天赋点已用 ${p.talentsTaken} / 剩余 ${p.talentPointsLeft}   技能树 ${p.skillRanks} 级`);
  log(` 伤害面板 ${p.stats.dmgMin}-${p.stats.dmgMax} × ${p.stats.aps}/s   暴击 ${(p.stats.crit * 100).toFixed(1)}% × ${p.stats.critMulti}   移速 ${p.stats.moveSpeed}   冷却缩减 ${(p.stats.cdr * 100).toFixed(0)}%   范围 ${(p.stats.aoe * 100).toFixed(0)}%`);
  log(` 防御     护甲 ${p.stats.armor}   闪避 ${(p.stats.evasion * 100).toFixed(0)}%   抗性 火${(p.stats.resists.fire * 100) | 0} 冰${(p.stats.resists.cold * 100) | 0} 电${(p.stats.resists.lightning * 100) | 0} 混${(p.stats.resists.chaos * 100) | 0}`);
  const eq = Object.entries(p.equipped).map(([k, v]) => `${k}:${v.rarity[0].toUpperCase()}${'(' + v.score + ')'}`).join(' ');
  log(` 已装备   ${eq || '（无）'}`);
  // ---- 技能升级 / 精炼石 / 分叉天赋（本次新增）----
  if (report.skills) logSkillLines(log, report.skills);
  log('');
  log('── 战斗 ──────────────────────────────────────────────────────────');
  log(` 击杀 ${pr.kills}（${pr.killsPerMin}/分钟）   普通 ${pr.killsByRarity.normal || 0} / 魔法 ${pr.killsByRarity.magic || 0} / 精英 ${pr.killsByRarity.rare || 0} / Boss ${pr.killsByRarity.boss || 0}`);
  log(` 死亡 ${pr.deaths} 次   复活 ${pr.revives} 次   承受 ${cb.dps.takenPerSec}/秒（总 ${fmtInt(cb.dps.totalTaken)}）`);
  log(` DPS（伤害事件实测）${cb.dps.byDamageEvents}   理论面板 ${cb.dps.theoretical}   命中 ${cb.hits} 次 / 平均 ${cb.avgHit}`);
  if (report.stomp) logStompLines(log, report.stomp);
  log('');
  log('── 生存 ──────────────────────────────────────────────────────────');
  const sv = report.survival || {};
  log(` 平均血量占比 ${sv.avgHpPct ?? '-'}%   低于 35% 的时间 ${sv.lowHpPct ?? '-'}%   低于 15% 的时间 ${sv.critHpPct ?? '-'}%`);
  log(` 受伤 ${sv.damageTakenPerMin ?? '-'}/分钟   回复 ${sv.healedPerMin ?? '-'}/分钟   回复/受伤比 ${sv.healRatio ?? '-'}`);
  log(` 死亡 ${sv.deaths ?? 0} 次（${sv.deathsPerMin ?? 0}/分钟）   首次死亡 ${sv.timeToFirstDeathSec != null ? sv.timeToFirstDeathSec + 's' : '未死亡'}`);
  log('');
  log('── 掉落 ──────────────────────────────────────────────────────────');
  log(` 掉落 ${lt.dropped} 件（${lt.dropsPerMin}/分钟，每 100 杀 ${lt.per100Kills} 件）   普通 ${lt.byRarity.normal} / 魔法 ${lt.byRarity.magic} / 稀有 ${lt.byRarity.rare} / 传奇 ${lt.byRarity.legendary}`);
  log(` 拾取 ${lt.pickups} 件   换装 ${lt.equippedChanges} 次   分解 ${lt.sellAllCalls} 次（+${lt.goldFromSell} 金）   漏捡 ${lt.lostDrops} 件`);
  log(` 结束背包：普通 ${lt.bagRarityAtEnd.normal} / 魔法 ${lt.bagRarityAtEnd.magic} / 稀有 ${lt.bagRarityAtEnd.rare} / 传奇 ${lt.bagRarityAtEnd.legendary}`);
  log(` 金币 魂火 ${p.gold} + 分解 ${p.bagGold}`);
  log('');
  log('── 每 60 秒快照 ──────────────────────────────────────────────────');
  log('  分 | 层 | 等级 | 最大生命 | 本期击杀 | 本期拾取 | 累计击杀 | 死亡 |  金币 | 平均DPS | 背包 | 场内怪');
  for (const m of report.timeline) {
    log(`  ${pad(m.minute, 2)} | ${pad(m.tier, 2)} | ${pad(m.level, 4)} | ${pad(m.maxHp, 8)} | ${pad(m.killsDelta, 8)} | ${pad(m.dropsDelta, 8)} | ${pad(m.killsTotal, 8)} | ${pad(m.deaths, 4)} | ${pad(m.gold, 5)} | ${pad(m.dpsAvg, 7)} | ${pad(m.bag, 4)} | ${pad(m.aliveMonsters, 6)}`);
  }
  log('');
  log('── 每层效率（换图时记录）─────────────────────────────────────────');
  if (!report.layerStats.layers.length) log(' （本局没有换图）');
  else {
    log('  层 | 停留秒数 | 击杀 | 掉落 | 离开时等级');
    for (const l of report.layerStats.layers) {
      log(`  ${pad(l.layer, 2)} | ${pad(l.sec, 8)} | ${pad(l.kills, 4)} | ${pad(l.drops, 4)} | ${pad(l.level, 12)}`);
    }
    log(`  平均每层 ${report.layerStats.avgSecPerLayer} 秒、${report.layerStats.avgKillsPerLayer} 杀（目标 3-5 分钟一层）`);
  }
  log('');
  log(`── Boss ──────────────────────────────────────────────────────────`);
  log(` 遭遇 ${report.boss.encounters} 次，击杀 ${report.boss.kills} 次${report.boss.lastTTK != null ? `，最近一次 TTK ${report.boss.lastTTK}s` : ''}`);
  if (report.boss.battle) {
    const b = report.boss.battle;
    log(` 最近一场：Boss Lv${b.level} / ${b.maxHp} 血   玩家 Lv${b.playerLevel}   TTK ${b.ttk ?? '未击杀'}s   ${b.killed ? '击杀 ✅' : '未击杀 ❌'}${b.playerDied ? '   玩家死亡 ❌' : ''}`);
    log(` 玩家血量最低到 ${b.playerHpMinPct ?? '-'}%   Boss 血量轨迹(%)：${b.hpTracePct.slice(0, 20).join(',')}`);
  }
  log('');
  log('── 稳定性 / 性能 ─────────────────────────────────────────────────');
  log(` 峰值：怪 ${mem.peak.monsters ?? 0}/${mem.caps.monsters}  投射物 ${mem.peak.projectiles ?? 0}/${mem.caps.projectiles}  事件 ${mem.peak.events ?? 0}  粒子 ${mem.peak.particles ?? 0}  掉落 ${mem.peak.items ?? 0}  魂火 ${mem.peak.lootOrbs ?? 0}  地面 ${mem.peak.groundEffects ?? 0}`);
  log(` 结束时：events ${mem.eventsAtEnd}  particles ${mem.particlesAtEnd}  toast ${mem.toastLogLen}`);
  log(` 性能：${wall.stepsRun} 步，CPU ${wall.cpuMs}ms，实际 ${wall.wallSec}s（${wall.realtimeFactor}× 实时，约 ${wall.msPerSimSecond}ms/秒模拟）`);
  log(` NaN：${Object.keys(report.nanIssues).length ? '❌ ' + Object.keys(report.nanIssues).join(', ') : '✅ 无'}   硬上限：${Object.keys(report.capBreaches).length ? '❌ ' + Object.keys(report.capBreaches).join(', ') : '✅ 未突破'}`);
  log('');
  log('── 平衡对照 ──────────────────────────────────────────────────────');
  log('  指标                目标                实测                结论');
  for (const ck of report.balance.checks) {
    const mark = ck.pass === null ? '记录' : ck.pass ? '✅' : '❌';
    log(`  ${ck.name.padEnd(14, '　')}  ${String(ck.target).padEnd(14, '　')}  ${String(ck.actual).padEnd(14, '　')}  ${mark}`);
  }
  log('');
  log(`结果：${report.ok ? '✅ 通过（无异常、无 NaN、未突破上限）' : '❌ 失败'}    平衡：${report.balance.verdict}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(2);
  }
  if (opts.help) {
    console.log('用法: node tools/playtest.mjs --minutes 10 --seed 42 [--tier 1] [--verbose] [--bot skilled|noPath|stationary] [--json out/report.json]');
    console.log('  --bot skilled    : 熟练走位（BFS 绕墙 / 刀锋距离 / 低血反跑）——默认');
    console.log('  --bot noPath     : 会追会放技能但不绕墙、不拉刀锋距离（贴脸硬刚）');
    console.log('  --bot stationary : 站桩下限基线（不移动不躲不放技能，只普攻射程内的怪）');
    return;
  }
  const report = await runPlaytest(opts);
  if (!opts.quiet) console.log(formatReport(report));
  if (opts.json) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.resolve(opts.json);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
    if (!opts.quiet) console.log(`\nJSON 报告：${file}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return new URL(`file://${entry.replace(/\\/g, '/')}`).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error('❌ playtest 崩溃：', (e && e.stack) || e);
    process.exit(1);
  });
}

export { HARD_CAPS, MEM_CAPS, RARITY_LABEL };





