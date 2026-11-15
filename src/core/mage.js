// @file src/core/mage.js
// 元素法师：半自动施法循环 / 火冰雷印记 / 元素反应 / 共鸣 / 元素狂潮。
// 纯逻辑，不依赖 DOM —— 可在 Node 下直接跑，也可被浏览器打包。
//
// 设计要点（对应《元素法师职业设计案》）：
//   · 玩家只负责走位、锁定目标、在共鸣满时手动放终极技；
//   · 三个填充技（火/冰/雷）与炎爆术由优先级引擎自动施放；
//   · 霜环 / 雷链 / 冰霜屏障是"自动循环专属"技能，不占技能栏；
//   · 每次命中叠 1 层对应印记（最多 3 层），命中带其它印记的敌人触发反应；
//   · 反应有 2.5 秒内置冷却，触发后获得 15 共鸣；满 3 层释放强化循环技额外获得 25 共鸣；
//   · 共鸣 100 后按 T（技能栏第 5 格）手动开启 8 秒元素狂潮。
//
// 技能栏（与游戏现有 Q/W/E/R/T 五格一一对应）：
//   Q 灼热飞弹 · W 寒冰箭 · E 电弧 · R 炎爆术 · T 元素狂潮
// 空格仍然是"闪现"（沿用游戏的 dash 机制，视觉与语义按法师改称）。

import { clamp } from './stats.js';
import {
  dealDamage, pushWorldEvent, rngOf, applyBuff, applyStun,
} from './combat.js';
import { queryEnemies } from './monsters.js';
import { SKILLS, skillLevelOf, tryCast } from './skills.js';

/** 法师技能栏的 5 个技能（顺序 = Q W E R T） */
export const MAGE_SKILL_IDS = Object.freeze([
  'mageFirebolt', 'mageIceShard', 'mageArc', 'magePyro', 'mageUltimate',
]);

/** 法师技能 id → 中文名（UI / 日志用） */
export const MAGE_SKILL_NAMES = Object.freeze({
  mageFirebolt: '灼热飞弹',
  mageIceShard: '寒冰箭',
  mageArc: '电弧',
  magePyro: '炎爆术',
  mageUltimate: '元素狂潮',
  mageNova: '霜环',
  mageChain: '雷链',
  mageBarrier: '冰霜屏障',
});

/** 三系元素的基础配色 / 名称 */
export const MAGE_ELEMENTS = Object.freeze({
  fire: { name: '火', color: '#ff8a3d', hue: 24, skillId: 'mageFirebolt' },
  cold: { name: '冰', color: '#7dd3fc', hue: 195, skillId: 'mageIceShard' },
  lightning: { name: '雷', color: '#fde047', hue: 55, skillId: 'mageArc' },
});

/** 三个填充技 id（按元素） */
export const MAGE_FILLER_IDS = Object.freeze({
  fire: 'mageFirebolt',
  cold: 'mageIceShard',
  lightning: 'mageArc',
});

/** 自动循环预设 */
export const MAGE_PRESETS = Object.freeze([
  { id: 'balanced', name: '均衡', desc: '先触发反应，再叠层；通用循环。' },
  { id: 'reaction', name: '反应流', desc: '优先选择能触发反应的元素。' },
  { id: 'accumulate', name: '蓄积流', desc: '同元素叠到 3 层再放强化循环技。' },
]);

const ELEMENTS = ['fire', 'cold', 'lightning'];
const PRESET_IDS = new Set(MAGE_PRESETS.map((p) => p.id));

/** 新建一份法师运行时状态（挂在 player.mage 上） */
export function createMageState() {
  return {
    resonance: 0,
    preset: 'balanced',
    autoTimer: 0,
    gcd: 0,
    targetId: null,
    lockId: null,
    nextSkillId: null,
    lastSkillId: null,
    ultTimer: 0,
    rotationIndex: 0,
    // 天赋解锁的自动系统（陨星 / 环绕法球）
    meteorTimer: 0,
    orbTimer: 0,
    fillerCount: 0,
    // 自动循环专属技能冷却（不放进 player.cooldowns，避免出现在技能栏外）
    cooldowns: { nova: 0, chain: 0, barrier: 0 },
  };
}

/** 确保 player.mage 存在（存档/旧对象兼容） */
export function ensureMageState(player) {
  if (!player || typeof player !== 'object') return null;
  if (!player.mage || typeof player.mage !== 'object') player.mage = createMageState();
  const m = player.mage;
  if (!Number.isFinite(m.resonance)) m.resonance = 0;
  if (!PRESET_IDS.has(m.preset)) m.preset = 'balanced';
  if (!Number.isFinite(m.autoTimer)) m.autoTimer = 0;
  if (!Number.isFinite(m.gcd)) m.gcd = 0;
  if (!Number.isFinite(m.ultTimer)) m.ultTimer = 0;
  if (!Number.isFinite(m.meteorTimer)) m.meteorTimer = 0;
  if (!Number.isFinite(m.orbTimer)) m.orbTimer = 0;
  if (!Number.isFinite(m.fillerCount)) m.fillerCount = 0;
  if (!m.cooldowns || typeof m.cooldowns !== 'object') m.cooldowns = { nova: 0, chain: 0, barrier: 0 };
  for (const k of ['nova', 'chain', 'barrier']) {
    if (!Number.isFinite(m.cooldowns[k])) m.cooldowns[k] = 0;
  }
  return m;
}

/** 玩家是否是法师 */
export function isMage(player) {
  return !!player && player.type === 'mage';
}

/**
 * 法师天赋修正（读 player.talentStats 里的 mage* 自定义字段）。
 *
 * 这些键不会进入 core 的 StatBlock（STAT_KEYS 不认识它们），但 app 的
 * recalcPlayer 会把天赋树的全部 stats 原样聚合进 player.talentStats，
 * 所以这里可以零成本读取。所有值都做了范围保护，坏数据不会让循环崩。
 *
 * @param {Object} player
 * @returns {{
 *   reactionMult:number, resonanceMult:number, markMax:number, autoCast:number,
 *   empoweredMult:number, shieldMult:number, novaRadius:number, novaCdr:number,
 *   chainJumps:number, reactionEcho:number, ultDuration:number, ultCdr:number,
 *   meteor:number, meteorRate:number, orbs:number, trinity:number,
 *   ultKillExtend:number, controlMult:number
 * }}
 */
export function mageTalentMods(player) {
  const t = (player && player.talentStats) || {};
  const n = (k) => (Number.isFinite(t[k]) ? t[k] : 0);
  return {
    reactionMult: Math.max(0, n('mageReactionMult')),
    resonanceMult: Math.max(0, n('mageResonanceMult')),
    markMax: clamp(3 + Math.floor(n('mageMarkMax')), 3, 8),
    autoCast: clamp(1 - n('mageAutoCastMult'), 0.45, 1),
    empoweredMult: Math.max(0, n('mageEmpoweredMult')),
    shieldMult: Math.max(0, n('mageShieldMult')),
    novaRadius: Math.max(0, n('mageNovaRadius')),
    novaCdr: clamp(1 - n('mageNovaCdr'), 0.35, 1),
    chainJumps: clamp(Math.floor(n('mageChainJumpBonus')), 0, 6),
    reactionEcho: clamp(Math.floor(n('mageReactionEcho')), 0, 3),
    ultDuration: clamp(n('mageUltDuration'), 0, 12),
    ultCdr: clamp(1 - n('mageUltCdr'), 0.35, 1),
    meteor: clamp(Math.floor(n('mageMeteor')), 0, 3),
    meteorRate: clamp(1 - n('mageMeteorRate'), 0.25, 1),
    orbs: clamp(Math.floor(n('mageOrbs')), 0, 3),
    trinity: clamp(Math.floor(n('mageTrinity')), 0, 10),
    ultKillExtend: clamp(n('mageUltKillExtend'), 0, 2),
    controlMult: clamp(1 + n('mageControlMult'), 1, 2.5),
  };
}

/** 切换自动循环预设 */
export function setMagePreset(player, preset) {
  if (!isMage(player)) return null;
  const m = ensureMageState(player);
  if (PRESET_IDS.has(preset)) m.preset = preset;
  return m.preset;
}

/** 印记表（挂在怪物身上，不进入存档） */
function marksOf(target) {
  if (!target || typeof target !== 'object') return { fire: 0, cold: 0, lightning: 0 };
  if (!target.mageMarks || typeof target.mageMarks !== 'object') {
    target.mageMarks = { fire: 0, cold: 0, lightning: 0 };
  }
  for (const el of ELEMENTS) {
    if (!Number.isFinite(target.mageMarks[el])) target.mageMarks[el] = 0;
  }
  return target.mageMarks;
}

/** 共鸣：0..100 */
function addResonance(player, amount) {
  if (!isMage(player)) return 0;
  const m = ensureMageState(player);
  const mods = mageTalentMods(player);
  const gain = amount * (1 + mods.resonanceMult);
  m.resonance = clamp((m.resonance || 0) + gain, 0, 100);
  return m.resonance;
}

/** 技能等级带来的伤害成长（与 skillsUpgrade 的默认 +12%/级一致） */
function spellLevelMult(player, skillId) {
  const lv = Math.max(1, skillLevelOf(player, skillId) || 1);
  return 1 + 0.12 * (lv - 1);
}

/** 以玩家武器伤害为底，算一发法术的伤害（包含全局伤害与对应元素加成） */
function rollSpellBase(world, player, element, mult, skillId) {
  const s = player.stats || {};
  const rng = rngOf(world);
  const cap = element.charAt(0).toUpperCase() + element.slice(1);
  const addMin = Number.isFinite(s['added' + cap + 'Min']) ? s['added' + cap + 'Min'] : 0;
  const addMax = Number.isFinite(s['added' + cap + 'Max']) ? s['added' + cap + 'Max'] : addMin;
  const lo = (Number.isFinite(s.dmgMin) ? s.dmgMin : 8) + addMin;
  const hi = Math.max(lo, (Number.isFinite(s.dmgMax) ? s.dmgMax : lo - addMin) + addMax);
  const weapon = rng.range(lo, hi);
  const globalMult = (1 + (s.damageMult || 0)) * (1 + (s[element + 'DamageMult'] || 0));
  return weapon * mult * spellLevelMult(player, skillId) * globalMult;
}

/** 对单个目标打一发元素伤害；命中后叠印记并处理元素狂潮的溅射 */
function dealSpell(world, player, target, element, mult, skillId, opts = {}) {
  if (!target || target.dead) return null;
  const base = rollSpellBase(world, player, element, mult, skillId);
  const packet = {
    [element]: base,
    canCrit: opts.canCrit !== false,
    area: !!opts.area,
    aoeMult: opts.area ? ((player.stats && player.stats.aoeMult) || 0) : 0,
    sourceSkill: skillId,
    tags: ['spell', element, skillId],
  };
  const res = dealDamage(world, player, target, packet);
  if (res.hit) {
    addMark(world, player, target, element);
    // 天赋「永动狂潮」：元素狂潮期间每次击杀延长爆发窗口
    if (res.dead && isUltActive(player)) {
      const mods = mageTalentMods(player);
      if (mods.ultKillExtend > 0) {
        const m = ensureMageState(player);
        m.ultTimer = Math.min(14, m.ultTimer + mods.ultKillExtend);
      }
    }
    if (!opts.noUltSplash && isUltActive(player)) {
      // 元素狂潮：每次施法附带一次小范围爆炸
      const splashTargets = queryEnemies(world, target.x, target.z, 2.2, null);
      for (const t of splashTargets) {
        if (!t || t === target || t.dead) continue;
        dealDamage(world, player, t, {
          [element]: base * 0.45,
          canCrit: false,
          area: true,
          sourceSkill: skillId,
          tags: ['spell', element, 'ultSplash'],
        });
      }
      pushWorldEvent(world, 'skillCast', {
        x: target.x, z: target.z, skillId: 'fireNova', radius: 2.2,
        hue: MAGE_ELEMENTS[element] ? MAGE_ELEMENTS[element].hue : 30,
        sourceSkill: skillId, ultSplash: true,
      });
    }
  }
  return res;
}

/** 是否处于元素狂潮 */
function isUltActive(player) {
  return isMage(player) && player.mage && player.mage.ultTimer > 0;
}

/** 触发一次元素反应：消耗对方 1 层印记，造成额外效果并给 15 共鸣 */
function triggerReaction(world, player, target, element, other) {
  if (!target || target.dead) return;
  const mods = mageTalentMods(player);
  const pair = [element, other].sort().join('+');
  const s = player.stats || {};
  const rng = rngOf(world);
  const lo = Number.isFinite(s.dmgMin) ? s.dmgMin : 10;
  const hi = Math.max(lo, Number.isFinite(s.dmgMax) ? s.dmgMax : lo);
  const weapon = rng.range(lo, hi);
  const globalMult = (1 + (s.damageMult || 0)) * (1 + mods.reactionMult);
  // 反应的基础系数沿用旧版 1.4，但补上「全局伤害 × 对应元素加成 × 天赋反应加成」，
  // 这样烈焰 / 雷霆支线的元素伤害天赋也会放大反应，而不是只影响填充技。
  const baseFor = (el) => weapon * 1.4 * spellLevelMult(player, MAGE_FILLER_IDS[el] || 'mageFirebolt')
    * globalMult * (1 + (s[el + 'DamageMult'] || 0));
  let name = '元素反应';
  let hue = 30;
  if (pair === 'cold+fire') {
    name = '熔解';
    hue = 24;
    dealDamage(world, player, target, {
      fire: baseFor('fire'), canCrit: false, sourceSkill: 'mageReaction', tags: ['spell', 'fire', 'reaction'],
    });
  } else if (pair === 'fire+lightning') {
    name = '超载';
    hue = 48;
    const base = baseFor('fire');
    const around = queryEnemies(world, target.x, target.z, 2.6, null);
    for (const t of around) {
      if (!t || t.dead) continue;
      dealDamage(world, player, t, {
        fire: base * (t === target ? 1 : 0.7),
        canCrit: false, area: true, sourceSkill: 'mageReaction',
        tags: ['spell', 'fire', 'lightning', 'reaction'],
      });
    }
    pushWorldEvent(world, 'skillCast', {
      x: target.x, z: target.z, skillId: 'fireNova', radius: 2.6, hue,
      sourceSkill: 'mageReaction',
    });
  } else {
    // cold + lightning = 等离子：短暂眩晕 + 雷电伤害
    name = '等离子';
    hue = 200;
    dealDamage(world, player, target, {
      lightning: baseFor('lightning'), canCrit: false, sourceSkill: 'mageReaction',
      tags: ['spell', 'lightning', 'reaction'],
    });
    applyStun(world, target, 0.8 * mods.controlMult, 'mageReaction');
  }
  addResonance(player, 15);
  pushWorldEvent(world, 'mageReaction', {
    x: target.x, z: target.z, name, pair, hue,
    marks: { ...marksOf(target) },
    sourceSkill: 'mageReaction',
  });
  // 天赋「反应回响」：向附近 3.2 范围弹射同色电光（不递归叠印记/反应）
  if (mods.reactionEcho > 0 && !target.dead) {
    const echoElement = pair === 'cold+fire' ? 'fire' : (pair === 'fire+lightning' ? 'lightning' : 'lightning');
    const echoBase = baseFor(echoElement);
    const limit = Math.min(3, mods.reactionEcho * 2 + 1);
    const around = queryEnemies(world, target.x, target.z, 3.2, null);
    let n = 0;
    for (const t of around) {
      if (!t || t.dead || t === target) continue;
      if (n >= limit) break;
      dealDamage(world, player, t, {
        [echoElement]: echoBase * 0.5,
        canCrit: false, area: true, sourceSkill: 'mageReaction',
        tags: ['spell', echoElement, 'reactionEcho'],
      });
      pushWorldEvent(world, 'mageReactionEcho', {
        x: t.x, z: t.z, fromX: target.x, fromZ: target.z,
        element: echoElement, hue: echoElement === 'lightning' ? 55 : echoElement === 'cold' ? 195 : 24,
        sourceSkill: 'mageReaction',
      });
      n++;
    }
  }
}

/**
 * 给目标叠 1 层元素印记，并在反应冷却允许时触发反应。
 * @returns {boolean} 是否触发了反应
 */
function addMark(world, player, target, element) {
  if (!target || target.dead || !MAGE_ELEMENTS[element]) return false;
  const marks = marksOf(target);
  let reacted = false;
  if (!(target.mageReactionCd > 0)) {
    for (const other of ELEMENTS) {
      if (other === element || !(marks[other] > 0)) continue;
      marks[other] = Math.max(0, marks[other] - 1);
      target.mageReactionCd = 2.5;
      triggerReaction(world, player, target, element, other);
      reacted = true;
      break;
    }
  }
  if (!target.dead) {
    const max = mageTalentMods(player).markMax;
    marks[element] = Math.min(max, (marks[element] || 0) + 1);
  }
  return reacted;
}

/** 找一个离 aim 最近的目标（用于锁定 / 手动施法） */
function nearestToPoint(world, x, z, radius) {
  const list = queryEnemies(world, x, z, radius, null);
  let best = null;
  let bestD = Infinity;
  for (const t of list) {
    if (!t || t.dead) continue;
    const d = (t.x - x) ** 2 + (t.z - z) ** 2;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/** 自动循环选目标：手动锁定优先，其次保持当前目标（避免伤害被"最近目标"稀释），最后选最近 */
export function mageTarget(world, player) {
  if (!isMage(player) || !world) return null;
  const m = ensureMageState(player);
  const monsters = Array.isArray(world.monsters) ? world.monsters : [];
  const byId = (id) => monsters.find((t) => t && !t.dead && (t.id === id || t === id)) || null;

  if (m.lockId) {
    const locked = byId(m.lockId);
    if (locked && Math.hypot(locked.x - player.x, locked.z - player.z) <= 15) return locked;
    m.lockId = null;
  }
  if (m.targetId) {
    const cur = byId(m.targetId);
    if (cur && Math.hypot(cur.x - player.x, cur.z - player.z) <= 14) return cur;
  }
  let best = null;
  let bestD = Infinity;
  for (const t of monsters) {
    if (!t || t.dead) continue;
    const d = (t.x - player.x) ** 2 + (t.z - player.z) ** 2;
    if (d <= 12 * 12 && d < bestD) { bestD = d; best = t; }
  }
  m.targetId = best ? best.id : null;
  return best;
}

/**
 * 鼠标左键锁定（法师的普攻键被改成"锁定目标"）。
 * 点在敌人身上 = 锁定；点空 = 解除锁定，交回自动选最近目标。
 */
export function lockMageTarget(world, player, aim) {
  if (!isMage(player) || !world || !aim) return null;
  const m = ensureMageState(player);
  const t = nearestToPoint(world, aim.x, aim.z, 1.8);
  m.lockId = t ? t.id : null;
  m.targetId = t ? t.id : m.targetId;
  if (t) {
    pushWorldEvent(world, 'mageLock', { x: t.x, z: t.z, targetId: t.id, target: t });
  }
  return t;
}

/** 手动施法/自动施法共用的目标选择：优先已锁定，其次鼠标附近，最后自动目标 */
function spellTarget(world, player, aim, range = 12) {
  if (!isMage(player)) return null;
  const m = ensureMageState(player);
  if (m.lockId) {
    const locked = (world.monsters || []).find((x) => x && x.id === m.lockId && !x.dead);
    if (locked) return locked;
    m.lockId = null;
  }
  if (aim) {
    const t = nearestToPoint(world, aim.x, aim.z, 1.6);
    if (t && Math.hypot(t.x - player.x, t.z - player.z) <= range) return t;
  }
  return mageTarget(world, player);
}

/** 填充技：单体元素伤害 */
function castBolt(world, player, element, aim) {
  const target = spellTarget(world, player, aim, 12);
  if (!target) return false;
  const def = MAGE_ELEMENTS[element];
  const skillId = def.skillId;
  dealSpell(world, player, target, element, 1.15, skillId);
  pushWorldEvent(world, 'skillCast', {
    x: target.x, z: target.z, skillId, radius: 0.8, hue: def.hue,
    fromX: player.x, fromZ: player.z, element,
    sourceSkill: skillId,
  });
  return true;
}

/** 炎爆术：目标周围 AoE；目标带 3 层火印记时强化并消耗印记 */
function castPyro(world, player, aim) {
  const target = spellTarget(world, player, aim, 12);
  if (!target) return false;
  const mods = mageTalentMods(player);
  const marks = marksOf(target);
  const empowered = (marks.fire || 0) >= mods.markMax;
  if (empowered) marks.fire = 0;
  const radius = 3.0 * (1 + (player.stats ? player.stats.aoeMult || 0 : 0));
  const targets = queryEnemies(world, target.x, target.z, radius, null);
  const mult = (empowered ? 1.9 : 1.25) * (empowered ? 1 + mods.empoweredMult : 1);
  for (const t of targets) {
    if (!t || t.dead) continue;
    dealSpell(world, player, t, 'fire', mult, 'magePyro', { area: true });
  }
  if (empowered) {
    if (!target.dead) applyStun(world, target, 1.0 * mods.controlMult, 'magePyro');
    addResonance(player, 25);
  }
  pushWorldEvent(world, 'skillCast', {
    x: target.x, z: target.z, skillId: 'fireNova', radius,
    hue: empowered ? 38 : 24, empowered, sourceSkill: 'magePyro',
    fromX: player.x, fromZ: player.z,
  });
  return true;
}

/** 霜环：以自身为圆心的冰霜 AOE + 短控；有目标带 3 层冰印记时强化 */
function castNova(world, player) {
  const mods = mageTalentMods(player);
  const baseRadius = 4.2 * (1 + mods.novaRadius);
  const around = queryEnemies(world, player.x, player.z, baseRadius, null);
  if (!around.length) return false;
  let empowered = false;
  for (const t of around) {
    const marks = marksOf(t);
    if ((marks.cold || 0) >= mods.markMax) { empowered = true; marks.cold = 0; }
  }
  const radius = baseRadius * (empowered ? 1.45 : 1);
  const targets = queryEnemies(world, player.x, player.z, radius, null);
  const mult = (empowered ? 1.45 : 1.0) * (empowered ? 1 + mods.empoweredMult : 1);
  for (const t of targets) {
    if (!t || t.dead) continue;
    dealSpell(world, player, t, 'cold', mult, 'mageNova', { area: true });
    if (!t.dead) applyStun(world, t, (empowered ? 1.1 : 0.7) * mods.controlMult, 'mageNova');
  }
  if (empowered) addResonance(player, 25);
  pushWorldEvent(world, 'skillCast', {
    x: player.x, z: player.z, skillId: 'iceNova', radius,
    hue: empowered ? 190 : 200, empowered, sourceSkill: 'mageNova',
  });
  return true;
}

/** 雷链：在目标之间跳跃；目标带 3 层雷印记时强化 */
function castChain(world, player, aim) {
  const first = spellTarget(world, player, aim, 12);
  if (!first) return false;
  const mods = mageTalentMods(player);
  const marks = marksOf(first);
  const empowered = (marks.lightning || 0) >= mods.markMax;
  if (empowered) marks.lightning = 0;
  const maxJumps = (empowered ? 5 : 3) + mods.chainJumps;
  const mult = (empowered ? 1.35 : 1.1) * (empowered ? 1 + mods.empoweredMult : 1);
  const hit = new Set([first]);
  let current = first;
  dealSpell(world, player, current, 'lightning', mult, 'mageChain');
  for (let i = 0; i < maxJumps; i++) {
    let next = null;
    let bestD = Infinity;
    for (const t of world.monsters || []) {
      if (!t || t.dead || hit.has(t)) continue;
      const d = (t.x - current.x) ** 2 + (t.z - current.z) ** 2;
      if (d <= 5 * 5 && d < bestD) { bestD = d; next = t; }
    }
    if (!next) break;
    hit.add(next);
    current = next;
    dealSpell(world, player, current, 'lightning', mult * (1 - 0.12 * (i + 1)), 'mageChain');
  }
  if (empowered) addResonance(player, 25);
  pushWorldEvent(world, 'skillCast', {
    x: first.x, z: first.z, skillId: 'chainLightning', radius: 1.2,
    hue: 55, jumps: hit.size, empowered, sourceSkill: 'mageChain',
    fromX: player.x, fromZ: player.z,
  });
  return true;
}

/** 冰霜屏障：自动触发的护盾（生命低于 45% 时优先） */
function castBarrier(world, player) {
  const mods = mageTalentMods(player);
  const amount = Math.max(1, Math.round((player.maxHp || 1) * 0.35 * (1 + mods.shieldMult)));
  applyBuff(world, player, {
    id: 'mageBarrier',
    name: '冰霜屏障',
    text: `吸收 ${amount} 点伤害，持续 6 秒`,
    type: 'buff',
    dur: 6,
    icon: '🧊',
    stats: { energyShield: amount },
  });
  // applyBuff 只会把护盾上限提高；直接把当前护盾补到上限，让屏障立刻生效。
  player.energyShield = Math.max(player.energyShield || 0, amount);
  pushWorldEvent(world, 'skillCast', {
    x: player.x, z: player.z, skillId: 'mageBarrier', radius: 1.6,
    hue: 195, shield: amount, sourceSkill: 'mageBarrier',
  });
  return true;
}

/** 陨星间隔：等级越高越短，再乘天赋的间隔缩减。 */
function meteorInterval(mods) {
  const base = 9 - 2.2 * Math.max(0, mods.meteor - 1);
  return Math.max(2.5, base * mods.meteorRate);
}

/** 天火陨星：天赋解锁后周期性轰击当前目标，落地是范围火焰 + 短晕。 */
function castMeteor(world, player, target) {
  if (!target || target.dead) return false;
  const mods = mageTalentMods(player);
  const aoe = (player.stats && player.stats.aoeMult) || 0;
  const radius = 2.6 * (1 + aoe) * (1 + 0.15 * Math.max(0, mods.meteor - 1));
  const mult = 1.4 + 0.35 * Math.max(0, mods.meteor - 1);
  const targets = queryEnemies(world, target.x, target.z, radius, null);
  for (const t of targets) {
    if (!t || t.dead) continue;
    dealSpell(world, player, t, 'fire', mult, 'mageMeteor', { area: true });
  }
  if (!target.dead) applyStun(world, target, 0.5 * mods.controlMult, 'mageMeteor');
  pushWorldEvent(world, 'mageMeteor', {
    x: target.x, z: target.z, radius, hue: 24, level: mods.meteor,
    fromX: player.x, fromZ: player.z, sourceSkill: 'mageMeteor',
  });
  return true;
}

/** 环形法球：围绕玩家旋转的元素球，按数量轮转火/冰/雷自动轰击目标。 */
function fireOrbs(world, player, target) {
  if (!target || target.dead) return false;
  const mods = mageTalentMods(player);
  if (mods.orbs <= 0) return false;
  let fired = false;
  for (let i = 0; i < mods.orbs; i++) {
    const el = ELEMENTS[i % ELEMENTS.length];
    const def = MAGE_ELEMENTS[el];
    dealSpell(world, player, target, el, 0.55, MAGE_FILLER_IDS[el], { noUltSplash: true });
    pushWorldEvent(world, 'mageOrb', {
      x: target.x, z: target.z, fromX: player.x, fromZ: player.z,
      element: el, hue: def.hue, index: i,
      sourceSkill: 'mageOrb',
    });
    fired = true;
    if (target.dead) break;
  }
  return fired;
}

/** 三相归一：每 N 次填充施法，额外轰出另外两系（50% 伤害），三色弹道同帧出现。 */
function castTrinity(world, player, target, primaryElement) {
  if (!target || target.dead) return false;
  const others = ELEMENTS.filter((el) => el !== primaryElement);
  for (const el of others) {
    dealSpell(world, player, target, el, 0.5, MAGE_FILLER_IDS[el], { noUltSplash: true });
  }
  pushWorldEvent(world, 'mageTrinity', {
    x: target.x, z: target.z, fromX: player.x, fromZ: player.z,
    elements: others.slice(), primary: primaryElement, hue: 280,
    sourceSkill: 'mageTrinity',
  });
  return true;
}

/** 开启元素狂潮（共鸣 100，按 T） */
export function activateMageUltimate(world, player) {
  if (!isMage(player) || player.dead) return false;
  const m = ensureMageState(player);
  if (m.ultTimer > 0 || m.resonance < 100) return false;
  const mods = mageTalentMods(player);
  const duration = 8 + mods.ultDuration;
  m.resonance = 0;
  m.ultTimer = duration;
  m.gcd = 0;
  applyBuff(world, player, {
    id: 'mageUltimate',
    name: '元素狂潮',
    text: '冷却减半、法力免费，每次施法附带额外爆炸',
    type: 'buff',
    dur: duration,
    icon: '🌌',
  });
  // 防止在持续期间重复触发（T 的冷却环也会显示）
  player.cooldowns.mageUltimate = Math.max(4, 9 * mods.ultCdr);
  pushWorldEvent(world, 'skillCast', {
    x: player.x, z: player.z, skillId: 'mageUltimate', radius: 4,
    hue: 280, sourceSkill: 'mageUltimate', duration,
  });
  return true;
}

/** 元素狂潮结束：以自身为圆心的一次大爆发 */
function endMageUltimate(world, player) {
  const m = ensureMageState(player);
  m.ultTimer = 0;
  const targets = queryEnemies(world, player.x, player.z, 4.6, null);
  for (const t of targets) {
    if (!t || t.dead) continue;
    dealSpell(world, player, t, 'fire', 1.6, 'mageUltimate', { area: true, noUltSplash: true });
  }
  pushWorldEvent(world, 'skillCast', {
    x: player.x, z: player.z, skillId: 'iceNova', radius: 5.2,
    hue: 280, ultimateEnd: true, sourceSkill: 'mageUltimate',
  });
}

/** 自动施法是否可用（冷却 + 蓝量） */
function ready(player, skillId) {
  const def = SKILLS[skillId];
  if (!def) return false;
  if (player.cooldowns && player.cooldowns[skillId] > 0) return false;
  if ((def.manaCost || 0) > (player.mp || 0)) return false;
  return true;
}

/** 元素狂潮期间：退还蓝耗 + 冷却减半（tryCast 已经扣过蓝/设过冷却） */
function applyUltCastBonus(player, skillId) {
  if (!isUltActive(player)) return;
  const def = SKILLS[skillId];
  if (!def) return;
  if (def.manaCost > 0) player.mp = Math.min(player.maxMp, player.mp + def.manaCost);
  if (player.cooldowns && player.cooldowns[skillId] > 0) {
    player.cooldowns[skillId] *= 0.5;
    const inst = Array.isArray(player.skillBar) ? player.skillBar.find((s) => s && s.id === skillId) : null;
    if (inst) inst.cd = player.cooldowns[skillId];
  }
}

/** 自动选择填充技（预设只影响优先级，不影响可用性） */
function chooseFiller(world, player, target) {
  const m = ensureMageState(player);
  const marks = marksOf(target);
  const opts = ELEMENTS.map((el) => ({ el, id: MAGE_FILLER_IDS[el] })).filter((o) => ready(player, o.id));
  if (!opts.length) return null;
  const has = (id) => opts.some((o) => o.id === id);

  if (m.preset === 'reaction') {
    const prefer = [];
    if (marks.cold > 0) prefer.push('fire');
    if (marks.fire > 0) prefer.push('cold', 'lightning');
    if (marks.lightning > 0) prefer.push('fire', 'cold');
    for (const el of prefer) if (has(MAGE_FILLER_IDS[el])) return MAGE_FILLER_IDS[el];
  }
  if (m.preset === 'accumulate') {
    const max = mageTalentMods(player).markMax;
    let best = null;
    let bestN = 0;
    for (const el of ELEMENTS) {
      const n = marks[el] || 0;
      if (n > 0 && n < max && n > bestN && has(MAGE_FILLER_IDS[el])) { best = el; bestN = n; }
    }
    if (best) return MAGE_FILLER_IDS[best];
  }
  // 均衡：按火→冰→雷轮转，只挑当前可用的
  for (let i = 0; i < ELEMENTS.length; i++) {
    const idx = (m.rotationIndex + i) % ELEMENTS.length;
    const el = ELEMENTS[idx];
    if (has(MAGE_FILLER_IDS[el])) {
      m.rotationIndex = (idx + 1) % ELEMENTS.length;
      return MAGE_FILLER_IDS[el];
    }
  }
  return opts[0] ? opts[0].id : null;
}

/** 填充技 id → 元素。 */
function elementOfFiller(skillId) {
  for (const el of ELEMENTS) if (MAGE_FILLER_IDS[el] === skillId) return el;
  return 'fire';
}

/** 自动循环单步（0.1 秒评估一次） */
export function updateMage(world, player, dt) {
  if (!isMage(player) || !world || player.dead) return;
  const m = ensureMageState(player);
  const mods = mageTalentMods(player);
  const step = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
  const gcd = 0.75 * mods.autoCast;

  // 计时器
  if (m.gcd > 0) m.gcd = Math.max(0, m.gcd - step);
  if (m.autoTimer > 0) m.autoTimer -= step;
  for (const k of ['nova', 'chain', 'barrier']) {
    if (m.cooldowns[k] > 0) m.cooldowns[k] = Math.max(0, m.cooldowns[k] - step);
  }
  for (const mon of world.monsters || []) {
    if (mon && mon.mageReactionCd > 0) mon.mageReactionCd = Math.max(0, mon.mageReactionCd - step);
  }
  if (m.ultTimer > 0) {
    m.ultTimer = Math.max(0, m.ultTimer - step);
    if (m.ultTimer <= 0) endMageUltimate(world, player);
  }

  // 天赋自动系统：陨星 / 环形法球（不受 GCD 限制，是"被动触发"）
  if (mods.meteor > 0) {
    m.meteorTimer = Math.max(0, m.meteorTimer - step);
    if (m.meteorTimer <= 0) {
      const t = mageTarget(world, player);
      if (t && castMeteor(world, player, t)) m.meteorTimer = meteorInterval(mods);
      else m.meteorTimer = 0.5;
    }
  }
  if (mods.orbs > 0) {
    m.orbTimer = Math.max(0, m.orbTimer - step);
    if (m.orbTimer <= 0) {
      const t = mageTarget(world, player);
      if (t && fireOrbs(world, player, t)) m.orbTimer = 2.5;
      else m.orbTimer = 0.5;
    }
  }

  if (m.autoTimer > 0 || m.gcd > 0 || player.castLock > 0) return;
  m.autoTimer = 0.1;

  // 1) 低血量屏障（不需要目标）
  if (player.hp / Math.max(1, player.maxHp) < 0.45 && m.cooldowns.barrier <= 0 && (player.mp || 0) >= 6) {
    m.nextSkillId = 'mageBarrier';
    if (castBarrier(world, player)) {
      m.cooldowns.barrier = 22;
      m.gcd = gcd;
      m.lastSkillId = 'mageBarrier';
      return;
    }
  }

  const target = mageTarget(world, player);
  if (!target) { m.nextSkillId = null; return; }
  const marks = marksOf(target);
  const nearPlayer = queryEnemies(world, player.x, player.z, 4.2 * (1 + mods.novaRadius), null).length;
  const nearTarget = queryEnemies(world, target.x, target.z, 4.0, null).length;

  // 2) 身边至少 2 个敌人 → 霜环
  if (nearPlayer >= 2 && m.cooldowns.nova <= 0 && (player.mp || 0) >= 12) {
    m.nextSkillId = 'mageNova';
    if (castNova(world, player)) {
      m.cooldowns.nova = 12 * mods.novaCdr;
      m.gcd = gcd;
      m.lastSkillId = 'mageNova';
      return;
    }
  }

  // 3) 目标满层火 → 强化炎爆
  if ((marks.fire || 0) >= mods.markMax && ready(player, 'magePyro')) {
    m.nextSkillId = 'magePyro';
    if (tryMageCast(world, player, 'magePyro', target)) {
      m.gcd = gcd;
      m.lastSkillId = 'magePyro';
      return;
    }
  }

  // 4) 目标至少 2 层雷且周围有 2 个以上敌人 → 雷链
  if ((marks.lightning || 0) >= 2 && nearTarget >= 2 && m.cooldowns.chain <= 0 && (player.mp || 0) >= 16) {
    m.nextSkillId = 'mageChain';
    if (castChain(world, player, { x: target.x, z: target.z })) {
      m.cooldowns.chain = 9;
      m.gcd = gcd;
      m.lastSkillId = 'mageChain';
      return;
    }
  }

  // 5) 目标至少 2 层火且周围有 3 个以上敌人 → 炎爆
  if ((marks.fire || 0) >= 2 && nearTarget >= 3 && ready(player, 'magePyro')) {
    m.nextSkillId = 'magePyro';
    if (tryMageCast(world, player, 'magePyro', target)) {
      m.gcd = gcd;
      m.lastSkillId = 'magePyro';
      return;
    }
  }

  // 6) 填充技，保证循环不断档
  const filler = chooseFiller(world, player, target);
  if (filler && tryMageCast(world, player, filler, target)) {
    m.nextSkillId = filler;
    m.gcd = gcd;
    m.lastSkillId = filler;
    m.fillerCount++;
    // 天赋「三相归一」：每 N 次填充施法，额外轰出另外两系
    if (mods.trinity > 0 && m.fillerCount % mods.trinity === 0) {
      castTrinity(world, player, target, elementOfFiller(filler));
    }
    return;
  }
  m.nextSkillId = filler || null;
}

/** 通过标准 tryCast 链路施放技能，并套用元素狂潮的减耗/减 CD */
function tryMageCast(world, player, skillId, target) {
  const m = ensureMageState(player);
  m.nextSkillId = skillId;
  const ok = tryCastMage(world, player, skillId, target);
  if (ok) applyUltCastBonus(player, skillId);
  return ok;
}

function tryCastMage(world, player, skillId, target) {
  return tryCast(world, player, skillId, target ? { x: target.x, z: target.z } : player.aim);
}

// ---------------------------------------------------------------------------
// 法师技能定义：注册进 core 的 SKILLS 表（技能栏 / tryCast / UI 共用）
// ---------------------------------------------------------------------------

/** 元素狂潮的 T 键技能定义 */
SKILLS.mageFirebolt = {
  id: 'mageFirebolt',
  name: '灼热飞弹',
  desc: '自动循环的火系填充技：造成火焰伤害并叠加 1 层火印记。',
  icon: '🔥',
  manaCost: 4,
  cooldown: 1.1,
  range: 12,
  radius: 0.8,
  castTime: 0,
  kind: 'spell',
  channel: false,
  damagePct: 1.15,
  cast(world, player, aim) { return castBolt(world, player, 'fire', aim); },
  update() {},
  onEnd() {},
};

SKILLS.mageIceShard = {
  id: 'mageIceShard',
  name: '寒冰箭',
  desc: '自动循环的冰系填充技：造成冰霜伤害并叠加 1 层冰印记。',
  icon: '❄️',
  manaCost: 4,
  cooldown: 1.1,
  range: 12,
  radius: 0.8,
  castTime: 0,
  kind: 'spell',
  channel: false,
  damagePct: 1.15,
  cast(world, player, aim) { return castBolt(world, player, 'cold', aim); },
  update() {},
  onEnd() {},
};

SKILLS.mageArc = {
  id: 'mageArc',
  name: '电弧',
  desc: '自动循环的雷系填充技：造成闪电伤害并叠加 1 层雷印记。',
  icon: '⚡',
  manaCost: 3,
  cooldown: 1.0,
  range: 12,
  radius: 0.8,
  castTime: 0,
  kind: 'spell',
  channel: false,
  damagePct: 1.05,
  cast(world, player, aim) { return castBolt(world, player, 'lightning', aim); },
  update() {},
  onEnd() {},
};

SKILLS.magePyro = {
  id: 'magePyro',
  name: '炎爆术',
  desc: '在目标处引爆火焰（半径 3）。目标带 3 层火印记时强化：伤害、眩晕，并消耗印记。',
  icon: '💥',
  manaCost: 18,
  cooldown: 7.5,
  range: 12,
  radius: 3,
  castTime: 0.16,
  kind: 'spell',
  channel: false,
  damagePct: 1.25,
  cast(world, player, aim) { return castPyro(world, player, aim); },
  update() {},
  onEnd() {},
};

SKILLS.mageUltimate = {
  id: 'mageUltimate',
  name: '元素狂潮',
  desc: '共鸣 100 时手动开启：8 秒内冷却减半、法力免费，每次施法附带额外爆炸；结束时造成一次大范围爆发。',
  icon: '🌌',
  manaCost: 0,
  cooldown: 1,
  range: 5,
  radius: 4,
  castTime: 0,
  kind: 'buff',
  channel: false,
  damagePct: 1,
  cast(world, player) { return activateMageUltimate(world, player); },
  update() {},
  onEnd() {},
};

// 自动循环专属技能（不注册进 SKILLS，避免进入技能栏/技能面板）
export const MAGE_INTERNAL_COOLDOWNS = Object.freeze({ nova: 12, chain: 9, barrier: 22 });

// 给 UI / 测试用的只读便捷入口
export const MAGE_LOOK = Object.freeze({
  armorColor: '#3a2b63',
  trimColor: '#9ad8ff',
  weaponType: 'staff',
  cape: true,
});