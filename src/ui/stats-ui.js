// 属性面板（角色详细属性 + 来源拆解）
//
// 【契约】由 ui.openPanel('stats') 调用：调用方已经调了 ui.openModal('stats')，
// 本模块只负责填 #modal-title / #modal-body / #modal-foot（与 inventory-ui.js 同构）。
//
// 【数据源优先级（每一层都要判型兜底，面板永远不能抛异常）】
//   1. game.stats                     —— app.refreshPanel 的快照（可能与真实值有 0.1~1 秒延迟）
//   2. game.world.player.stats        —— core recalcStats 的真实结果（权威值，优先用它）
//   3. player.baseStats / talentStats / equipStats / skillStats / buffs —— 来源拆解
//   4. game.inv                       —— 天赋/技能点、精炼石、金币、已装备物品
//   5. items/talentTree.js 的 TALENTS —— 逐节点天赋明细
//
// 【拆解算法（为什么不是简单相加）】
//   核心的属性合成是 aggregateStats(layers)（src/core/stats.js）：
//     raw = Σ 各层同名键
//     result = clamp(raw, 区间) 且 **默认值只兜底一次**（DEFAULTS.critChance=0.05 / critMulti=1.5 …）；
//     另外还有两条跨字段规则：dmgMax ≥ dmgMin、元素抗性 ≤ maxResistance。
//   所以「裸属性 + 装备 + 天赋」的线性相加经常 ≠ 最终值（暴击率默认值、抗性上限、clamp）。
//   本面板的做法：
//     · 对每个属性，逐层算「边际贡献」：Σ(每一层单独叠加时给最终值带来的增量)，
//       —— dmg / 攻速 / 移速 / 暴击倍率 / 护甲这类线性属性上，它恰好等于各层数值本身；
//       —— 暴击率 / 抗性 / 闪避 / 格挡这类「带默认值或上限」的属性上，它能保证恒等式成立：
//            Σ(各来源) === 最终值（误差 ≤ 1e-6），这正是「基础 X + 装备 Y + … = 总计 V」要的语义。
//     · 「差值来源」= 最终值 − Σ(正来源)（可能为负）：默认值兜底 / 上限截断 / 数值向下取整。
//     · 来源缺失（层不存在）时该行标记「来源不全」，总计仍显示。
//   来源层：基础(baseStats) / 装备(equipStats) / 天赋(talentStats) / 技能(skillStats) / 增益(buffs)。

import { el, escapeHTML, rarityColor, itemTooltipHTML } from './dom.js';
import { EQUIP_SLOTS } from '../game/inventory.js';
import * as statsCore from '../core/stats.js';
import * as talentData from '../items/talentTree.js';
import { talentTreeFor } from '../items/talentTrees.js';
import * as progression from '../core/progression.js';
import * as combatCore from '../core/combat.js';

// ---------------------------------------------------------------------------
// 基础常量（与 core 保持一致：BASE_MOVE_SPEED / BASE_ATTACK_SPEED）
// ---------------------------------------------------------------------------
const BASE_MOVE_SPEED = 6.2;
const BASE_ATTACK_SPEED = 1.35;
/** 玩家槽位数（10） */
const SLOT_ORDER = ['helmet', 'amulet', 'body', 'weapon', 'offhand', 'gloves', 'belt', 'ring1', 'ring2', 'boots'];
/** 用于期望伤害展示的"参考敌人"原始物理伤害（armorReduction 需要一次命中伤害才能算减免） */
const REF_HIT_PHYS = 100;
const EPS = 1e-6;

/** 来源层定义（顺序即拆解展示顺序） */
const SOURCES = Object.freeze([
  { key: 'base', name: '基础', short: '基础' },
  { key: 'equip', name: '装备', short: '装备' },
  { key: 'talent', name: '天赋', short: '天赋' },
  { key: 'skill', name: '技能', short: '技能' },
  { key: 'buff', name: '增益', short: '增益' },
]);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
/** 有限数字兜底 */
function num(v, d = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}
/** 对象判型 */
function isObj(v) {
  return !!v && typeof v === 'object';
}
/** 分数 → 百分比文本（已含 %） */
function pctText(v, digits = 0) {
  const n = num(v) * 100;
  // -0 收敛成 0，避免面板上出现 "-0%"
  return (Object.is(n, -0) ? 0 : n).toFixed(digits) + '%';
}
/** 带符号的差值文本（用于拆解里的 +12 / -60） */
function signedText(v, digits = 0) {
  const n = num(v);
  const shown = Math.abs(n) < 0.5 * Math.pow(10, -digits) ? 0 : n;
  return (shown >= 0 ? '+' : '') + shown.toFixed(digits);
}
/** 固定位数（收敛长小数；把 -0 变成 0） */
function fixed(v, digits = 0) {
  const n = num(v);
  return (Object.is(n, -0) ? 0 : n).toFixed(digits);
}
/** 数组去重 + 过滤空 */
function uniq(arr) {
  const out = [];
  for (const x of arr || []) if (x && !out.includes(x)) out.push(x);
  return out;
}
/**
 * 安全执行：任何异常都返回 fallback（面板单行炫了也不能整个面板空白）
 * @template T
 * @param {() => T} fn @param {T} fallback
 * @returns {T}
 */
function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * 创建带文本的节点。
 * 不用 `el('span', {}, ['文本'])`：dom.el 的字符串子节点走 document.createTextNode，
 * 而 tools/check-standalone.mjs 的极简桩**没有** createTextNode —— 那样会让整行抛异常。
 * 这里优先用 textContent 赋值（所有桩都支持，且天然防 XSS）。
 * @param {string} tag @param {string} cls @param {string} text @param {Object} [extra]
 * @returns {Element}
 */
function textNode(tag, cls, text, extra) {
  const attrs = { class: cls };
  if (extra) for (const k in extra) attrs[k] = extra[k];
  const node = safe(() => el(tag, attrs), null);
  if (!node) return safe(() => el('span'), document.createElement('span'));
  const t = text == null ? '' : String(text);
  try {
    node.textContent = t;
  } catch {
    /* 极端桩：不写文本也不影响结构 */
  }
  return node;
}

// ---------------------------------------------------------------------------
// 数据收集：把 game 里散落的字段归一成一个「面板数据包」
// ---------------------------------------------------------------------------
/**
 * 一次性读出面板需要的全部数据（只读，绝不修改 game）
 * @param {Object} ui GameUI
 * @returns {{player:Object, stats:Object, gameStats:Object, layers:Object, inv:Object|null, missing:string[]}}
 */
export function collectStatsData(ui) {
  const game = (ui && ui.game) || {};
  const world = isObj(game.world) ? game.world : {};
  const player = isObj(world.player) ? world.player : {};
  const inv = isObj(game.inv) ? game.inv : null;
  const gameStats = isObj(game.stats) ? game.stats : {};

  // 权威属性层：core 的 recalcStats 把结果写在 player.stats；
  // 若 core 还没跑过（player.stats 缺失），用 aggregateStats 现场合成一次「只读预演」
  let stats = isObj(player.stats) ? player.stats : null;
  const layers = {
    base: isObj(player.baseStats) ? player.baseStats : null,
    equip: isObj(player.equipStats) ? player.equipStats : null,
    talent: isObj(player.talentStats) ? player.talentStats : null,
    skill: isObj(player.skillStats) ? player.skillStats : null,
    buff: null,
  };
  const missing = [];
  for (const s of SOURCES.slice(0, 4)) if (!isObj(layers[s.key])) missing.push(s.name);
  if (!stats) {
    // 预演：与 recalcStats 的合成顺序一致（base → talent → equip → skillStats 已并入 talent → buff）
    const agg = safe(() => statsCore.aggregateStats([layers.base, layers.talent, layers.equip, buffLayerOf(player)]), null);
    stats = isObj(agg) ? agg : {};
  }
  layers.buff = safe(() => buffLayerOf(player), null);
  return { game, world, player, inv, stats, gameStats, layers, missing };
}

/**
 * 从 player.buffs 汇总属性层（与 core 的 collectBuffStats 同口径，但自己做一份兜底，
 * 因为 core 版本可能随并行开发改名）。
 * @param {Object} player
 * @returns {Object<string, number>|null}
 */
function buffLayerOf(player) {
  const buffs = Array.isArray(player && player.buffs) ? player.buffs : [];
  const agg = {};
  let any = false;
  for (const b of buffs) {
    if (!isObj(b) || !isObj(b.stats)) continue;
    for (const k in b.stats) {
      const v = b.stats[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        agg[k] = (agg[k] || 0) + v;
        any = true;
      }
    }
  }
  return any ? agg : null;
}

/**
 * 单层贡献（含别名 resFire / resCold …，与 aggregateStats 一致）
 * @param {Object|null} layer @param {string} key
 * @returns {number}
 */
function layerValue(layer, key) {
  if (!isObj(layer)) return 0;
  const alias = RESIST_ALIASES[key];
  let v = typeof layer[key] === 'number' && Number.isFinite(layer[key]) ? layer[key] : 0;
  if (alias && typeof layer[alias] === 'number' && Number.isFinite(layer[alias])) v += layer[alias];
  return v;
}

/** 装备数据里的抗性别名（src/core/stats.js 的 aggregateStats 同样识别） */
const RESIST_ALIASES = Object.freeze({ fireResist: 'resFire', coldResist: 'resCold', lightningResist: 'resLightning', chaosResist: 'resChaos' });
/** 带默认值（不为 0）的字段：这些键的「基础」来源天然包含默认值，不能当作"某层缺失" */
const DEFAULT_KEYS = Object.freeze(statsCore.DEFAULTS || {});

/**
 * 某层对某属性的「直接数值」（不做边际推导），用于判定"这层到底给没给东西"。
 * @param {Object|null} layer @param {string} key @returns {number}
 */
function rawContribution(layer, key) {
  if (!isObj(layer)) return 0;
  let v = typeof layer[key] === 'number' && Number.isFinite(layer[key]) ? layer[key] : 0;
  const alias = RESIST_ALIASES[key];
  if (alias && typeof layer[alias] === 'number' && Number.isFinite(layer[alias])) v += layer[alias];
  return v;
}

/**
 * 用「边际贡献」把最终值拆到各来源层。
 *
 * 算法：以 base 层之外全部为空的合成结果为基准，然后逐层「单独叠加」看最终值涨了多少，
 * 就是该层的贡献；Σ贡献 + 差值(默认值兜底/上限截断) === 最终值。
 * @param {Object} layers  {base,equip,talent,skill,buff}
 * @param {string} key     StatBlock 键名
 * @param {number} finalV  最终值（player.stats[key]）
 * @returns {{parts:Array<{key:string,name:string,value:number,present:boolean}>, total:number, residual:number, missing:string[]}}
 */
export function decomposeStat(layers, key, finalV) {
  const total = num(finalV);
  const present = (k) => isObj(layers[k]);
  const aggOf = (list) => safe(() => statsCore.aggregateStats(list), null);
  const seeded = aggOf([layers.base]);
  const seed = seeded && typeof seeded[key] === 'number' ? seeded[key] : 0;
  const parts = [];
  for (const s of SOURCES) {
    if (s.key === 'base') {
      parts.push({ key: s.key, name: s.name, value: seed, present: present('base') });
      continue;
    }
    if (!present(s.key)) {
      parts.push({ key: s.key, name: s.name, value: 0, present: false });
      continue;
    }
    const withLayer = aggOf([layers.base, layers[s.key]]);
    const v = withLayer && typeof withLayer[key] === 'number' ? withLayer[key] - seed : 0;
    parts.push({ key: s.key, name: s.name, value: v, present: true });
  }
  const sum = parts.reduce((a, p) => a + p.value, 0);
  // 「来源不全」的判定：某一层整个不存在（engine 层字段还没接上）→ 一定要标；
  // 该属性在核心里有非 0 默认值（critChance 0.05 / critMulti 1.5 / maxResistance 0.75 …）时，
  // 该层没有直接数值（= 用了默认值）也标出来 —— 玩家看不清时宁可说"来源不全"，不能假装算全了。
  const hasDefault = typeof DEFAULT_KEYS[key] === 'number' && DEFAULT_KEYS[key] !== 0;
  const missing = [];
  for (const s of SOURCES.slice(0, 4)) {
    if (!present(s.key)) missing.push(s.name);
    else if (hasDefault && Math.abs(rawContribution(layers[s.key], key)) <= EPS) missing.push(s.name);
  }
  return { parts, total, residual: total - sum, missing };
}

// ---------------------------------------------------------------------------
// 属性定义：每一行 = 一个"可展开"的属性
//
//   key   : StatBlock 键名（拆解用）
//   final : 最终值（优先 player.stats，其次 game.stats 快照）
//   fmt   : 最终值展示
//   part  : 拆解项展示（默认用 fmt）
//   note  : 行下方的补充说明（换算 / 提示）
//   color : 'gold' | 'red' | ''（最终值高亮）
// ---------------------------------------------------------------------------
/**
 * @param {ReturnType<typeof collectStatsData>} d
 * @returns {Object} 分区数据
 */
function buildSections(d) {
  const { player, stats, gameStats } = d;
  const s = stats;
  const g = gameStats;
  const pick = (a, b) => (Number.isFinite(num(a, NaN)) ? a : b);

  // ---- 经验 ----
  const xp = safe(() => progression.xpProgress(player), null) || (isObj(g.xp) ? g.xp : null) || { level: player.level || 1, xp: player.xp || 0, xpMax: 40, pct: 0 };
  const level = Math.max(1, Math.floor(num(pick(player.level, g.level), 1)));

  // ---- 生命 / 法力：当前 / 最大 ----
  const maxHp = num(pick(player.maxHp, num(s.life, num(g.life, 0))), 0);
  const hp = num(player.hp, maxHp);
  const maxMp = num(pick(player.maxMp, num(s.mana, 0)), 0);
  const mp = num(player.mp, maxMp);
  const es = num(s.energyShield, 0);

  // ---- 攻速 / 移速：倍率型属性，展示同时给"加成值"和"实际值" ----
  const aps = BASE_ATTACK_SPEED * (1 + num(s.attackSpeedMult, 0));
  const moveSpeed = BASE_MOVE_SPEED * (1 + num(s.moveSpeedMult, 0));
  const weaponLo = num(s.dmgMin, 0);
  const weaponHi = num(s.dmgMax, 0);
  const weaponAvg = (weaponLo + weaponHi) / 2;

  // 护甲减伤：复用 core 的 armorReduction（对 100 原始物理伤害的参考换算），
  // 顺手统一「毛伤害」= 100×(1-减免) 吸收后的伤害提示
  const armorVal = num(s.armor, 0);
  const armorRed = safe(() => {
    const fn = statsCore.armorReduction || combatCore.armorReduction;
    return typeof fn === 'function' ? num(fn(armorVal, REF_HIT_PHYS), 0) : null;
  }, null);
  const maxRes = num(s.maxResistance, 0.75);

  // 命中/暴击/期望伤害（信息密度：POE 面板的核心数字）
  const critChance = num(s.critChance, 0);
  const critMulti = num(s.critMulti, 1.5);
  const dmgPerHit = weaponAvg * (1 + critChance * (critMulti - 1)) * (1 + num(s.damageMult, 0));
  const dpsEst = dmgPerHit * aps;

  const sections = [];

  // ============ 概要 ============
  sections.push({
    id: 'overview',
    title: '概要',
    icon: '❖',
    rows: [
      { k: 'level', label: '等级', text: 'Lv.' + level, sub: '经验 ' + pctText(xp.pct, 1), tone: 'gold' },
      {
        k: 'xp', label: '经验',
        text: `${Math.floor(num(xp.xp, 0))} / ${Math.floor(num(xp.xpMax, 1))}`,
        sub: pctText(xp.pct, 1) + (xp.isMax ? ' · 已满级' : ''),
        bar: { pct: num(xp.pct, 0), cls: 'xp' },
      },
      {
        k: 'life', label: '生命',
        text: `${Math.round(hp)} / ${Math.round(maxHp)}`,
        sub: `回复 ${fixed(num(s.lifeRegen, 0), 1)}/秒`,
        bar: { pct: maxHp > 0 ? hp / maxHp : 0, cls: 'hp' },
        decompose: { key: 'life', final: maxHp, fmt: (v) => fixed(v, 0) },
      },
      {
        k: 'mana', label: '法力',
        text: `${Math.round(mp)} / ${Math.round(maxMp)}`,
        sub: `回复 ${fixed(num(s.manaRegen, 0), 1)}/秒`,
        bar: { pct: maxMp > 0 ? mp / maxMp : 0, cls: 'mp' },
        decompose: { key: 'mana', final: maxMp, fmt: (v) => fixed(v, 0) },
      },
      es > 0 ? {
        k: 'es', label: '能量护盾',
        text: `${Math.round(num(player.energyShield, 0))} / ${Math.round(es)}`,
        sub: '先于生命承受伤害',
        bar: { pct: es > 0 ? num(player.energyShield, 0) / es : 0, cls: 'es' },
        decompose: { key: 'energyShield', final: es, fmt: (v) => fixed(v, 0) },
      } : null,
      {
        k: 'move',
        label: '移动速度',
        text: fixed(moveSpeed, 1) + ' 米/秒',
        sub: signedText(num(s.moveSpeedMult, 0) * 100, 0) + '% 加成',
        decompose: { key: 'moveSpeedMult', final: num(s.moveSpeedMult, 0), fmt: (v) => pctText(v, 0) },
      },
    ].filter(Boolean),
  });

  // ============ 攻击 ============
  sections.push({
    id: 'attack',
    title: '攻击',
    icon: '⚔',
    rows: [
      {
        k: 'dmg', label: '武器伤害',
        text: `${fixed(weaponLo, 0)} - ${fixed(weaponHi, 0)}`,
        sub: `平均 ${fixed(weaponAvg, 1)}`,
        tone: 'gold',
        decompose: { key: 'dmgMax', final: weaponHi, fmt: (v) => fixed(v, 1) },
      },
      (num(s.addedFireMax, 0) > 0 || num(s.addedColdMax, 0) > 0 || num(s.addedLightningMax, 0) > 0) ? {
        k: 'added',
        label: '附加元素伤害',
        text: [
          num(s.addedFireMax, 0) > 0 ? `火 ${fixed(num(s.addedFireMin, 0), 0)}-${fixed(num(s.addedFireMax, 0), 0)}` : '',
          num(s.addedColdMax, 0) > 0 ? `冰 ${fixed(num(s.addedColdMin, 0), 0)}-${fixed(num(s.addedColdMax, 0), 0)}` : '',
          num(s.addedLightningMax, 0) > 0 ? `雷 ${fixed(num(s.addedLightningMin, 0), 0)}-${fixed(num(s.addedLightningMax, 0), 0)}` : '',
        ].filter(Boolean).join(' · '),
        sub: '每次攻击附加',
      } : null,
      {
        k: 'aps', label: '攻击速度',
        text: fixed(aps, 2) + ' 次/秒',
        sub: signedText(num(s.attackSpeedMult, 0) * 100, 0) + '% 加成',
        decompose: { key: 'attackSpeedMult', final: num(s.attackSpeedMult, 0), fmt: (v) => pctText(v, 0) },
      },
      {
        k: 'crit', label: '暴击率',
        text: pctText(critChance, 1),
        sub: '更高为佳',
        tone: critChance >= 0.5 ? 'gold' : '',
        decompose: { key: 'critChance', final: critChance, fmt: (v) => pctText(v, 1) },
      },
      {
        k: 'critMulti', label: '暴击伤害',
        text: '×' + fixed(critMulti, 2),
        sub: signedText((critMulti - 1.5) * 100, 0) + '% 相对基础',
        decompose: { key: 'critMulti', final: critMulti, fmt: (v) => '×' + fixed(v, 2) },
      },
      {
        k: 'hitDmg', label: '单次伤害',
        text: fixed(dmgPerHit, 1),
        sub: `含暴击期望${num(s.damageMult, 0) ? ' · 全局 +' + pctText(num(s.damageMult, 0), 0) : ''}`,
      },
      { k: 'dps', label: '每秒伤害', text: fixed(dpsEst, 1), sub: '估算值（普攻）', tone: 'gold' },
      num(s.aoeMult, 0) !== 0 ? {
        k: 'aoe', label: '范围效果',
        text: signedText(num(s.aoeMult, 0) * 100, 0) + '%',
        sub: '技能作用半径',
      } : null,
      num(s.areaDamageMult, 0) !== 0 ? { k: 'areaDmg', label: '范围伤害', text: signedText(num(s.areaDamageMult, 0) * 100, 0) + '%', sub: 'AOE 技能额外增伤' } : null,
      num(s.physDamageMult, 0) !== 0 ? {
        k: 'physDmg', label: '物理伤害加成',
        text: signedText(num(s.physDamageMult, 0) * 100, 0) + '%',
        decompose: { key: 'physDamageMult', final: num(s.physDamageMult, 0), fmt: (v) => pctText(v, 0) },
      } : null,
      num(s.cdrMult, 0) !== 0 ? {
        k: 'cdr', label: '冷却缩减',
        text: pctText(num(s.cdrMult, 0), 1),
        sub: '技能冷却时间降低',
      } : null,
    ].filter(Boolean),
  });

  // ============ 防御 ============
  sections.push({
    id: 'defense',
    title: '防御',
    icon: '🛡',
    rows: [
      {
        k: 'armor', label: '护甲',
        text: fixed(armorVal, 0),
        sub: armorRed == null ? '对 100 伤害减伤 —（未换算）' : `对 ${REF_HIT_PHYS} 原始物理伤害减伤 ${pctText(armorRed, 1)}（上限 75%）`,
        tone: armorRed != null && armorRed >= 0.5 ? 'gold' : '',
        decompose: { key: 'armor', final: armorVal, fmt: (v) => fixed(v, 0) },
      },
      {
        k: 'evasion', label: '闪避率',
        text: pctText(num(s.evasion, 0), 1),
        sub: '直接作为被击闪避判定（上限 75%）',
        tone: num(s.evasion, 0) >= 0.5 ? 'gold' : '',
        decompose: { key: 'evasion', final: num(s.evasion, 0), fmt: (v) => pctText(v, 1) },
      },
      {
        k: 'block', label: '格挡几率',
        text: pctText(num(s.blockChance, 0), 1),
        sub: '格挡成功减免 60% 伤害',
        tone: num(s.blockChance, 0) >= 0.4 ? 'gold' : '',
        decompose: { key: 'blockChance', final: num(s.blockChance, 0), fmt: (v) => pctText(v, 1) },
      },
      {
        k: 'thorns', label: '荆棘伤害',
        text: fixed(num(s.thorns, 0), 0),
        sub: '受击反弹给攻击者',
        hideIfZero: true,
      },
      {
        k: 'taken', label: '承受伤害',
        text: signedText(num(s.damageTakenMult, 0) * 100, 0) + '%',
        sub: '负值更安全',
        tone: num(s.damageTakenMult, 0) > 0 ? 'red' : '',
        hideIfZero: true,
      },
    ].filter((r) => r && !(r.hideIfZero && num(parseRowValue(r), 0) === 0)),
  });

  // ============ 抗性 ============
  const resistRow = (label, key, val, tone) => {
    const v = num(val, 0);
    return {
      k: key,
      label,
      text: pctText(v, 0),
      sub: v < 0 ? '受到额外伤害' : `上限 ${pctText(maxRes, 0)}`,
      tone: v < 0 ? 'red' : v >= maxRes - EPS ? 'gold' : '',
      decompose: { key, final: v, fmt: (x) => pctText(x, 0) },
    };
  };
  sections.push({
    id: 'resist',
    title: '抗性',
    icon: '✦',
    rows: [
      resistRow('火焰抗性', 'fireResist', s.fireResist),
      resistRow('冰霜抗性', 'coldResist', s.coldResist),
      resistRow('闪电抗性', 'lightningResist', s.lightningResist),
      resistRow('混沌抗性', 'chaosResist', s.chaosResist),
    ],
    foot: `元素抗性上限 ${pctText(maxRes, 0)} · 金色 = 已满抗 · 红色 = 负抗`,
  });

  // ============ 资源（数值由 inv 提供，见 buildResourceRows）============
  // ============ 已装备 ============

  return sections;
}

/** 从一行里取一个粗粒度数值（仅用于 hideIfZero 判定） */
function parseRowValue(row) {
  const m = String(row && row.text ? row.text : '').match(/-?[\d.]+/);
  return m ? Number(m[0]) : 0;
}

/**
 * 资源行（天赋点 / 技能点 / 精炼石 / 金币 / 背包）
 * @param {ReturnType<typeof collectStatsData>} d
 * @returns {Array<Object>}
 */
function buildResourceRows(d) {
  const { inv, player } = d;
  const rows = [];
  if (!inv) {
    return [{ k: 'noinv', label: '资源', text: '—', sub: '背包数据不可用' }];
  }
  const unspent = Math.max(0, Math.floor(num(inv.talentPoints, num(player.unspentPoints, 0))));
  const tree = talentTreeFor(player && player.type);
  const spentTalents = Array.isArray(inv.talents) ? inv.talents.filter((t) => t && t !== tree.start).length : 0;
  rows.push({
    k: 'talentPts', label: '天赋点',
    text: String(unspent),
    sub: `已投入 ${spentTalents} 点`,
    tone: unspent > 0 ? 'gold' : '',
  });
  const sp = isObj(inv.skillPoints) ? inv.skillPoints : {};
  const spTotal = Math.floor(num(sp.total, 0));
  const spSpent = Math.floor(num(sp.spent, sumSkillRanks(inv)));
  const spAvail = Number.isFinite(num(sp.avail, NaN)) ? Math.max(0, Math.floor(num(sp.avail, 0))) : Math.max(0, spTotal - spSpent);
  rows.push({
    k: 'skillPts', label: '技能点',
    text: `${spAvail} / ${spTotal}`,
    sub: `已投入 ${spSpent} 点`,
    tone: spAvail > 0 ? 'gold' : '',
  });
  const orbs = Math.max(0, Math.floor(num(inv.skillOrbs, 0)));
  rows.push({ k: 'orbs', label: '技能精炼石', text: '◆ ' + orbs, sub: '用于精炼技能 / 重置天赋', tone: orbs > 0 ? 'gold' : '' });
  const gold = Math.max(0, Math.floor(num(inv.gold, 0)));
  rows.push({ k: 'gold', label: '金币', text: String(gold), sub: '出售装备获得' });
  const bagLen = Array.isArray(inv.bag) ? inv.bag.length : 0;
  const bagSize = Math.max(bagLen, Math.floor(num(inv.bagSize, 60)));
  rows.push({ k: 'bag', label: '背包', text: `${bagLen} / ${bagSize}`, sub: bagLen >= bagSize ? '已满' : '', tone: bagLen >= bagSize ? 'red' : '' });
  return rows;
}

/** inv.skillRanks 的档位总和（skillPoints.spent 缺失时兜底） */
function sumSkillRanks(inv) {
  let n = 0;
  const ranks = inv && isObj(inv.skillRanks) ? inv.skillRanks : {};
  for (const k in ranks) n += Math.max(0, Math.floor(num(ranks[k], 0)));
  return n;
}

/**
 * 天赋投入明细（按主干分组，最多展示 12 条 —— 面板不是天赋树，只给"我点了什么"）
 * @param {ReturnType<typeof collectStatsData>} d
 * @returns {{groups:Array<{name:string, items:Array<{name:string,kind:string}>}>, total:number, more:number}}
 */
function buildTalentBreakdown(d) {
  const inv = d.inv;
  const tree = talentTreeFor(d.player && d.player.type);
  const all = isObj(tree.byId) ? tree.byId : {};
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const byId = {};
  for (const n of nodes) if (n && n.id) byId[n.id] = n;
  const start = tree.start || talentData.START_NODE || 'start-warrior';
  const picked = Array.isArray(inv && inv.talents) ? inv.talents.filter((id) => id && id !== start) : [];
  const branchNames = {};
  for (const b of Array.isArray(tree.branches) ? tree.branches : []) branchNames[b.id] = b.name;
  /** @type {Record<string, Array<Object>>} */
  const groups = {};
  const order = [];
  for (const id of picked) {
    const node = byId[id] || all[id];
    const b = node && node.branch ? node.branch : 'other';
    const bname = b === 'ring' ? '环上节点' : b === 'keystone' ? '基石' : branchNames[b] || '其它';
    if (!groups[bname]) { groups[bname] = []; order.push(bname); }
    groups[bname].push({ name: node && node.name ? node.name : id, kind: node && node.kind ? node.kind : 'minor' });
  }
  const MAX = 12;
  let count = 0;
  const out = [];
  for (const gname of order) {
    const items = [];
    for (const it of groups[gname]) {
      if (count >= MAX) break;
      items.push(it);
      count++;
    }
    if (items.length) out.push({ name: gname, items });
  }
  return { groups: out, total: picked.length, more: Math.max(0, picked.length - count) };
}

/**
 * 已装备物品（含槽位空占位）
 * @param {ReturnType<typeof collectStatsData>} d
 */
function buildEquipped(d) {
  const inv = d.inv;
  const equip = inv && isObj(inv.equip) ? inv.equip : {};
  const defs = Array.isArray(EQUIP_SLOTS) ? EQUIP_SLOTS : [];
  const out = [];
  for (const id of SLOT_ORDER) {
    const def = defs.find((s) => s && s.id === id);
    out.push({ id, name: def ? def.name : id, item: equip[id] || null });
  }
  // 后端若新增槽位（EQUIP_SLOTS 变长），也一并展示，避免面板漏掉
  for (const def of defs) if (def && def.id && !SLOT_ORDER.includes(def.id)) out.push({ id: def.id, name: def.name || def.id, item: equip[def.id] || null });
  return out;
}

// ---------------------------------------------------------------------------
// DOM 构建
// ---------------------------------------------------------------------------
/**
 * 分区卡片
 * @param {string} title
 * @param {string} icon
 * @param {string} id
 * @param {Element[]} children
 * @returns {Element}
 */
function section(title, icon, id, children) {
  const card = el('section', { class: 'stp-card', 'data-section': id });
  card.appendChild(el('h4', { class: 'stp-card-title', html: `<i>${escapeHTML(icon || '◆')}</i><span>${escapeHTML(title)}</span><b></b>` }));
  // 注意：children 可能是带 null 的数组（不要直接传，UI 只需要元素节点）
  const bodyEl = el('div', { class: 'stp-card-body' });
  for (const c of children || []) if (c) bodyEl.appendChild(c);
  card.appendChild(bodyEl);
  return card;
}

/**
 * 一行属性。若带 decompose，则整行可点击展开拆解（按钮语义，便于键盘/测试）。
 * @param {Object} row  {label,text,sub,tone,bar,decompose}
 * @param {ReturnType<typeof collectStatsData>} d
 * @param {Object} ctx { ui, expanded:Set }
 * @returns {Element}
 */
function statRow(row, d, ctx) {
  const wrap = el('div', { class: 'stp-row-wrap' });
  const inner = el('div', { class: 'stp-row' + (row.tone ? ' tone-' + row.tone : '') + (row.decompose ? ' has-src' : '') });
  inner.appendChild(textNode('span', 'stp-label', row.label));
  const val = el('b', { class: 'stp-value', text: row.text });
  inner.appendChild(val);
  if (row.decompose) inner.appendChild(el('i', { class: 'stp-caret', text: '▾', 'aria-hidden': 'true' }));
  wrap.appendChild(inner);
  if (row.sub) wrap.appendChild(el('div', { class: 'stp-sub', text: row.sub }));
  if (row.bar) {
    const bar = el('div', { class: 'stp-bar ' + (row.bar.cls || '') });
    const fill = el('i');
    // 宽度用 style.width：DOM 桩里 style 是普通对象，写属性即可
    fill.style.width = Math.round(Math.max(0, Math.min(1, num(row.bar.pct, 0))) * 1000) / 10 + '%';
    bar.appendChild(fill);
    wrap.appendChild(bar);
  }
  if (!row.decompose) return wrap;

  // ---- 拆解明细 ----
  const box = el('div', { class: 'stp-src' });
  const dc = safe(() => decomposeStat(d.layers, row.decompose.key, row.decompose.final), null);
  box.innerHTML = dc ? srcHTML(dc, row.decompose.fmt) : `<div class="stp-src-empty">${escapeHTML('拆解数据不可用')}</div>`;
  box.className = 'stp-src' + (ctx.expanded.has(row.k) ? ' open' : '');
  wrap.appendChild(box);
  inner.classList.toggle('open', ctx.expanded.has(row.k));
  inner.addEventListener('click', () => {
    const open = box.classList.toggle('open');
    inner.classList.toggle('open', open);
    if (open) ctx.expanded.add(row.k);
    else ctx.expanded.delete(row.k);
  });
  return wrap;
}

/**
 * 拆解明细 HTML：「基础 120 + 装备 40 + 天赋 60 + 技能 20 = 总计 240」
 * @param {{parts:Array, total:number, residual:number, missing:string[]}} dc
 * @param {(v:number)=>string} fmt
 */
function srcHTML(dc, fmt) {
  const f = typeof fmt === 'function' ? fmt : (v) => fixed(v, 0);
  const parts = dc.parts || [];
  const visible = parts.filter((p) => p.key === 'base' || p.present || Math.abs(p.value) > EPS);
  const segs = visible.map((p) => {
    const zero = Math.abs(p.value) <= EPS;
    const sign = p.value < -EPS ? '−' : '+';
    const valCls = zero ? 'zero' : p.value < 0 ? 'neg' : 'pos';
    const missCls = p.present ? '' : ' miss';
    const label = p.key === 'base' ? '基础' : p.name;
    return `<span class="stp-seg${missCls}"><em>${escapeHTML(label)}</em>`
      + (p.key === 'base'
        ? `<b class="${valCls}">${escapeHTML(f(p.value))}</b>`
        : `<b class="${valCls}"><i class="stp-op">${sign}</i>${escapeHTML(f(Math.abs(p.value)))}</b>`)
      + '</span>';
  });
  let html = `<div class="stp-src-line">${segs.join('')}<span class="stp-eq">=</span>`
    + `<span class="stp-seg stp-total"><em>总计</em><b>${escapeHTML(f(dc.total))}</b></span></div>`;
  if (Math.abs(dc.residual) > 1e-3) {
    // 差值不是"来源"，而是 clamp / 默认值兜底 / 上限截断造成的
    html += `<div class="stp-src-note">${escapeHTML('差值 ')}<b class="${dc.residual < 0 ? 'neg' : 'pos'}">${escapeHTML(signedText(dc.residual, 1))}</b>${escapeHTML('（默认值兜底 / 上限截断）')}</div>`;
  }
  if (dc.missing && dc.missing.length) {
    html += `<div class="stp-src-note warn">⚠ 来源不全：缺少 ${escapeHTML(dc.missing.join('、'))} 层</div>`;
  }
  return html;
}

/**
 * 资源 / 天赋明细块
 * @param {ReturnType<typeof collectStatsData>} d
 */
function resourceBlocks(d) {
  const out = [];
  const body = el('div', { class: 'stp-res' });
  for (const r of buildResourceRows(d)) {
    const line = el('div', { class: 'stp-row stp-res-row' + (r.tone ? ' tone-' + r.tone : '') });
    line.appendChild(textNode('span', 'stp-label', r.label));
    line.appendChild(el('b', { class: 'stp-value', text: r.text }));
    body.appendChild(line);
    if (r.sub) body.appendChild(el('div', { class: 'stp-sub', text: r.sub }));
  }
  out.push(body);
  const tb = safe(() => buildTalentBreakdown(d), { groups: [], total: 0, more: 0 });
  if (tb.total > 0) {
    const box = el('div', { class: 'stp-talents' });
    const chips = [];
    for (const g of tb.groups) {
      const row = el('div', { class: 'stp-tgroup' });
      row.appendChild(el('span', { class: 'stp-tgroup-name', text: g.name }));
      for (const it of g.items) {
        const kindCls = it.kind === 'keystone' ? ' ks' : it.kind === 'notable' ? ' notable' : '';
        row.appendChild(el('span', { class: 'stp-tchip' + kindCls, text: it.name }));
      }
      chips.push(row);
    }
    if (tb.more > 0) chips.push(el('div', { class: 'stp-sub', text: `还有 ${tb.more} 个天赋未展开` }));
    box.appendChild(el('div', { class: 'stp-block-title', text: `天赋投入 · ${tb.total} 点` }));
    for (const c of chips) box.appendChild(c);
    out.push(box);
  }
  return out;
}

/**
 * 已装备：10 个槽位小卡片（图标 + 名称，稀有度着色，悬停出完整 tooltip）
 * @param {ReturnType<typeof collectStatsData>} d
 * @param {Object} ui
 */
function equippedBlock(d, ui) {
  const wrap = el('div', { class: 'stp-equip' });
  for (const slot of safe(() => buildEquipped(d), [])) {
    const item = slot.item;
    const color = item ? rarityColor(item.rarity) : '';
    const cell = el('div', { class: 'stp-slot' + (item ? ' filled' : ''), 'data-slot': slot.id });
    if (item) cell.style.borderColor = color + '77';
    cell.appendChild(el('span', { class: 'stp-slot-tag', text: slot.name }));
    if (item) {
      cell.appendChild(el('span', { class: 'stp-slot-icon', text: String(item.icon || '◆') })).style.color = color;
      const name = el('span', { class: 'stp-slot-name', text: String(item.name || '未知物品') });
      name.style.color = color;
      cell.appendChild(name);
      // 悬停 tooltip：复用 inventory-ui 的 itemTooltipHTML（同一套样式）
      const show = (ev) => {
        const x = num(ev && ev.clientX, 0);
        const y = num(ev && ev.clientY, 0);
        safe(() => ui.showTooltip(itemTooltipHTML(item), x, y), null);
      };
      cell.addEventListener('mouseenter', show);
      cell.addEventListener('mousemove', show);
      cell.addEventListener('mouseleave', () => safe(() => ui.hideTooltip(), null));
    } else {
      cell.appendChild(el('span', { class: 'stp-slot-empty', text: '空' }));
    }
    wrap.appendChild(cell);
  }
  return wrap;
}

/**
 * 面板底部：操作按钮（关闭）
 * @param {Object} ui
 */
function fillFooter(ui) {
  const foot = ui.el && ui.el.modalFoot;
  if (!foot) return;
  foot.innerHTML = '';
  const close = () => {
    if (typeof ui.closeModals === 'function') ui.closeModals();
  };
  const btn = el('button', { class: 'btn-mini stp-close', text: '关闭 (E / Esc)', onclick: close });
  foot.appendChild(btn);
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------
/**
 * 打开「属性面板」。调用方（ui.openPanel('stats')）已经调了 ui.openModal('stats')。
 * @param {Object} ui GameUI 实例
 * @param {{expanded?:string[]}} [opts] 测试 / 外部指定默认展开项
 * @returns {void}
 */
export function openStats(ui, opts = {}) {
  try {
    if (!ui || !ui.el || !ui.el.modalBody || !ui.el.modalTitle) return;
    const title = ui.el.modalTitle;
    title.textContent = '属性面板';

    const body = ui.el.modalBody;
    body.innerHTML = '';
    const prev = ui.__statsExpanded;
    const expanded = new Set(Array.isArray(opts.expanded) ? opts.expanded : prev instanceof Set ? prev : []);
    ui.__statsExpanded = expanded;

    const d = safe(() => collectStatsData(ui), null);
    if (!d) {
      body.appendChild(el('div', { class: 'stp-empty', text: '角色数据不可用' }));
      return;
    }

    const wrap = el('div', { class: 'stp-wrap' });
    // ---- 头部：角色身份（头像 + 名字 + 等级 + 经验）+ 一句话提示 ----
    // 【合并】原 HUD 左上角角色卡的等级/经验信息现在并进属性面板头部，HUD 只留战斗数值。
    const head = el('div', { class: 'stp-head' });
    const pName = d.player && d.player.name ? String(d.player.name) : '流浪战士';
    const pLevel = Math.max(1, Math.floor(num(d.player.level, 1)));
    const xpInfo = safe(() => progression.xpProgress(d.player), null);
    const xpFrac = xpInfo && Number.isFinite(Number(xpInfo.pct))
      ? Math.max(0, Math.min(1, Number(xpInfo.pct)))
      : 0;

    const ident = el('div', { class: 'stp-ident' });
    ident.appendChild(el('div', { class: 'stp-avatar', text: '战' }));
    const identText = el('div', { class: 'stp-ident-text' });
    identText.appendChild(el('div', { class: 'stp-head-name', html: `<b>${escapeHTML(pName)}</b><span>Lv.${escapeHTML(String(pLevel))} · 战士</span>` }));
    const xpBar = el('div', { class: 'stp-xp', title: `经验 ${Math.round(xpFrac * 100)}%` });
    const xpFill = el('i');
    xpFill.style.width = (xpFrac * 100).toFixed(1) + '%';
    xpBar.appendChild(xpFill);
    identText.appendChild(xpBar);
    ident.appendChild(identText);

    head.appendChild(ident);
    head.appendChild(el('div', { class: 'stp-hint', text: '点击带 ▾ 的属性行展开来源拆解 · 悬停装备查看完整词缀' }));
    wrap.appendChild(head);

    const sections = safe(() => buildSections(d), []);
    const ctx = { ui, expanded };
    // 布局：左列（概要 + 攻击 + 防御） / 右列（抗性 + 资源 + 已装备），两列都在 1280×720 内不溢出
    const colL = el('div', { class: 'stp-col' });
    const colR = el('div', { class: 'stp-col' });
    for (const sec of sections) {
      const card = el('section', { class: 'stp-card', 'data-section': sec.id });
      card.appendChild(el('h4', { class: 'stp-card-title', html: `<i>${escapeHTML(sec.icon || '◆')}</i><span>${escapeHTML(sec.title)}</span><b></b>` }));
      const bodyEl = el('div', { class: 'stp-card-body' });
      for (const row of sec.rows || []) {
        const node = safe(() => statRow(row, d, ctx), null);
        if (node) bodyEl.appendChild(node);
      }
      if (sec.foot) bodyEl.appendChild(el('div', { class: 'stp-foot-note', text: sec.foot }));
      card.appendChild(bodyEl);
      (sec.id === 'overview' || sec.id === 'attack' || sec.id === 'defense' ? colL : colR).appendChild(card);
    }
    // 资源分区
    const resCard = el('section', { class: 'stp-card', 'data-section': 'resource' });
    resCard.appendChild(el('h4', { class: 'stp-card-title', html: '<i>◈</i><span>资源</span><b></b>' }));
    const resBody = el('div', { class: 'stp-card-body' });
    for (const node of safe(() => resourceBlocks(d), [])) resBody.appendChild(node);
    resCard.appendChild(resBody);
    colR.appendChild(resCard);

    // 已装备分区（整宽）
    const eqCard = el('section', { class: 'stp-card', 'data-section': 'equipped' });
    eqCard.appendChild(el('h4', { class: 'stp-card-title', html: '<i>⬢</i><span>已装备</span><b></b>' }));
    const eqBody = el('div', { class: 'stp-card-body' });
    const eq = safe(() => equippedBlock(d, ui), null);
    if (eq) eqBody.appendChild(eq);
    eqCard.appendChild(eqBody);

    wrap.appendChild(colL);
    wrap.appendChild(colR);
    wrap.appendChild(eqCard);
    // 来源缺失提示（并行开发期 app/core 字段可能还没齐）
    if (d.missing && d.missing.length) {
      wrap.appendChild(el('div', { class: 'stp-missing', text: '⚠ 部分来源层缺失（' + d.missing.join('、') + '），拆解仅供参考' }));
    }
    body.appendChild(wrap);

    fillFooter(ui);
  } catch (e) {
    // 面板整体兜底：任何异常都不能冒泡到游戏主循环
    try {
      const body = ui && ui.el && ui.el.modalBody;
      if (body) {
        body.innerHTML = '';
        body.appendChild(el('div', { class: 'stp-empty', text: '属性面板加载失败：' + String((e && e.message) || e) }));
      }
    } catch {
      /* 连兜底都失败就静默 */
    }
  }
}

export default { openStats, collectStatsData, decomposeStat };