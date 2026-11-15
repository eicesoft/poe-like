// @file src/core/skills.js
// 玩家技能定义（数据 + 逻辑）：战争践踏 / 旋风斩 / 战吼 / 血性狂暴 / 坚毅图腾 / 翻滚(dash)。
// 纯逻辑，不依赖 DOM / three。
//
// 【技能对象结构】
//   {
//     id, name, desc, icon,
//     manaCost,        // 每次施放消耗法力
//     cooldown,        // 冷却（秒，1 级基础值；最终值还要乘 cdr / 天赋 / 等级缩减）
//     range,           // 施法/作用距离（没有 radius 时它就是作用半径）
//     radius,          // 作用半径（可选；warStomp 之类圆形 AOE 用）
//     castTime,        // 前摇（秒，0 = 瞬发）
//     kind,            // 'attack'|'spell'|'buff'|'move'|'summon'
//     channel,         // 是否按住持续施法（旋风斩）
//     manaPerSecond,   // 持续施法每秒耗蓝
//     damagePct,       // 1 级时的伤害倍率（1 = 100% 武器伤害）
//     damageMultLevel, // 每技能等级的伤害成长（默认 0.08）
//     cooldownMultLevel, // 每技能等级的冷却缩减（默认 0.04）
//     radiusMultLevel, // 每技能等级的半径成长（默认 0.05）
//     armorGain,       // 仅 stomp：{ flat, per, dur }
//     cast(world, player, aim),        // aim = { x, z } 鼠标世界坐标
//     update(world, player, dt),       // 持续施法时每帧调用
//     onEnd(world, player),            // 结束持续施法
//   }
//
// 【玩家技能实例（SkillInstance）】
//   player.skillBar 是长度 7 的数组，每格是
//   { id, level, refine, cd, active, tick, elapsed, holding, pendingCast, aim } —— 技能栏 UI 直接读这些字段。
//   level/refine 由 app 层（skillProgression.syncSkillInstances）同步进核心；
//   核心只读，缺省时一律按 1 级 / 0 精炼兜底（契约 §2.1：核心必须在缺省时能跑）。
//
// 【冷却】玩家 cooldowns 对象 skillId → 剩余秒（UI 进度环直接读）；
//   技能实例上的 cd 与 cooldowns 同步。
//
// 【技能等级 / 天赋】
//   最终数值（伤害/冷却/半径/护甲/眩晕）的计算全部集中到 ./skillsUpgrade.js ——
//   那里不依赖 items 层，避免 core ↔ items 的循环依赖。本文件只负责"读出来用"。

import { clamp } from './stats.js';
import { pushWorldEvent, normDir, dist2, applyBuff, applyStun } from './combat.js';
import { queryEnemies, spawnSummon, playerHit } from './monsters.js';
import {
  SKILL_LEVEL_CAP, REFINE_MAX,
  skillModsOf, skillLevelOf, refineLevelOf, multBonus, skillFlag, skillFocus,
  levelDmgScale, skillDamagePct, skillCooldownTotal, skillRadius,
  stompArmorFor, stompStunDuration, stompArmorDuration, refineCostOf, talentPointsOf,
  levelCooldownScale, levelRadiusScale,
  neutralSkillMods, normalizeSkillMods, skillInstanceOf, applySkillMods,
} from './skillsUpgrade.js';

// 本文件内部用到的纯函数再做一次 re-export，方便其它 core 模块 / 工具只 import skills.js 就能拿到。
export {
  SKILL_LEVEL_CAP, REFINE_MAX,
  skillModsOf, skillLevelOf, refineLevelOf, multBonus, skillFlag, skillFocus,
  levelDmgScale, skillDamagePct, skillCooldownTotal, skillRadius,
  stompArmorFor, stompStunDuration, stompArmorDuration, refineCostOf,
  neutralSkillMods, normalizeSkillMods, skillInstanceOf, talentPointsOf,
  levelCooldownScale, levelRadiusScale, refineCostOf as refineCost,
};

/** 基础移速（单位/秒） */
export const BASE_MOVE_SPEED = 6.2;
/** 玩家基础攻速（每秒攻击次数） */
export const BASE_ATTACK_SPEED = 1.35;
/** 翻滚位移距离 */
export const DASH_DISTANCE = 4.2;
/** 翻滚无敌时间 */
export const DASH_IFRAME = 0.18;
/** 翻滚冷却 */
export const DASH_COOLDOWN = 1.2;
/** 技能栏长度（UI 依赖） */
export const SKILL_BAR_SIZE = 7;

/** 技能 id → 中文名（UI 快捷） */
export const SKILL_NAMES = {
  stomp: '战争践踏',
  whirlwind: '旋风斩',
  warcry: '战吼',
  bloodRage: '血性狂暴',
  rally: '坚毅图腾',
  dash: '翻滚',
};

/**
 * 玩家默认技能栏的技能 id 列表（不含 dash，翻滚由空格触发）。
 * [playtest 修复] 任务书/测试工具需要这个导出，之前缺失；与 makeSkillBar 默认参数保持一致，
 * 新增技能时请同时更新这里。
 */
export const SKILL_IDS = Object.freeze(['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally']);

/**
 * 计算技能范围加成后的半径
 * @param {Object} player @param {number} r
 */
function scaledR(player, r) {
  const aoe = player && player.stats ? player.stats.aoeMult || 0 : 0;
  return r * (1 + clamp(aoe, -0.6, 3));
}

/**
 * 技能等级（skillLevelBonus 会加等级，用于伤害成长）
 * 语义见契约 §2.1：max(1, bar.level || 1) + floor(stats.skillLevelBonus || 0)。
 * 注意：这是"旧工具函数"的保留签名；需要带封顶/天赋精炼的最终等级请用 skillLevelOf(player, skillId)。
 * @param {Object} bar SkillInstance
 * @param {Object} player
 */
function skillLevel(bar, player) {
  const bonus = player && player.stats ? player.stats.skillLevelBonus || 0 : 0;
  return Math.max(1, (bar && bar.level ? bar.level : 1) + Math.floor(bonus));
}

/**
 * 朝目标方向推一下（击退用）
 */
function facingDir(player, aim) {
  if (aim && (Math.abs(aim.x - player.x) > 0.01 || Math.abs(aim.z - player.z) > 0.01)) {
    return normDir(aim.x - player.x, aim.z - player.z);
  }
  return { x: Math.sin(player.facing || 0), z: Math.cos(player.facing || 0), len: 1 };
}

/** 施法时面向鼠标 */
function faceAim(player, aim) {
  if (!aim) return;
  const dx = aim.x - player.x, dz = aim.z - player.z;
  if (Math.abs(dx) > 0.05 || Math.abs(dz) > 0.05) player.facing = Math.atan2(dx, dz);
}

/** 施法时读取当前技能实例（用于等级/精炼相关的数值） */
function barOf(player, skillId, ctx) {
  if (ctx && ctx.bar) return ctx.bar;
  if (!player || !Array.isArray(player.skillBar)) return null;
  return player.skillBar.find((s) => s && s.id === skillId) || null;
}

/** @type {Record<string, Object>} */
export const SKILLS = {};

// ---------------------------------------------------------------------------
// 战争践踏 stomp（取代旧的「裂地斩 groundSlam」，契约 §3.3）
// ---------------------------------------------------------------------------
/** 踏地战甲：护甲 buff 的 id / 名称（渲染层读 buff.id === 'warStompArmor' 画金色辉光） */
export const STOMP_ARMOR_BUFF_ID = 'warStompArmor';
export const STOMP_ARMOR_BUFF_NAME = '踏地战甲';

SKILLS.stomp = {
  id: 'stomp',
  name: '战争践踏',
  desc: '以自身为圆心震踏地面（半径 3.6），对周围敌人造成 90% 武器伤害并眩晕 1.2 秒；'
    + '每命中一名敌人获得「踏地战甲」护甲，持续 4 秒（再次践踏刷新而不叠加）。',
  icon: '💥',
  manaCost: 14,
  cooldown: 7,
  range: 3.6,
  radius: 3.6,
  castTime: 0.3,
  kind: 'attack',
  channel: false,
  // 因为是控制技能，基础伤害低于旧的裂地斩（155%）
  damagePct: 0.9,
  damageMultLevel: 0.08,
  cooldownMultLevel: 0.04,
  radiusMultLevel: 0.05,
  /** 护甲增益：{ 基础, 每命中一名敌人, 持续秒 } —— 具体数值计算见 skillsUpgrade.stompArmorFor */
  armorGain: { flat: 18, per: 5, dur: 4 },
  /** 眩晕：基础 1.2 秒，每技能等级 +5%（控制升级后应该更"值钱"） */
  stunGain: { base: 1.2, perLevel: 0.05 },
  /**
   * @param {Object} world @param {Object} player @param {{x:number,z:number}} aim
   * @param {{bar?:Object}} [ctx]
   * @returns {number} 命中敌人数（0 也算施放成功 —— 保底护甲，技能永远有正向反馈）
   */
  cast(world, player, aim, ctx = {}) {
    faceAim(player, aim);
    const bar = barOf(player, 'stomp', ctx);
    const mods = skillModsOf(player, 'stomp');
    const radius = skillRadius(player, 'stomp', SKILLS.stomp);
    const dmgPct = skillDamagePct(player, 'stomp', SKILLS.stomp);
    const stunDur = stompStunDuration(player, SKILLS.stomp);
    const targets = queryEnemies(world, player.x, player.z, radius, null);
    let hits = 0;
    let stunned = 0;
    for (const t of targets) {
      // queryEnemies 已经按圆形筛过，这里再兜底一次半径判断（hash 的格子粒度可能偏大）
      if (dist2(player.x, player.z, t.x, t.z) > radius * radius) continue;
      playerHit(world, player, t, {
        dmgPct,
        area: true,
        sourceSkill: 'stomp',
        knockback: 3,
        tags: ['attack', 'melee', 'aoe', 'stomp', 'stun'],
      });
      hits++;
      // 眩晕放在伤害之后：目标若被一脚踩死，applyStun 会因为 dead 返回 false，不会推多余的 stun 事件
      if (applyStun(world, t, stunDur, 'stomp')) stunned++;
    }
    // ---- 踏地战甲：按命中数给护甲；hits === 0 也保底 armorGain.flat ----
    const armor = stompArmorFor(hits, mods, { def: SKILLS.stomp });
    const dur = stompArmorDuration(player, SKILLS.stomp);
    // stackMode: 'refresh' —— 再次施放覆盖并刷新时长，**不叠层**（契约 §3.3 / §3.7）
    applyBuff(world, player, {
      id: STOMP_ARMOR_BUFF_ID,
      name: STOMP_ARMOR_BUFF_NAME,
      text: hits > 0
        ? `护甲 +${armor}，持续 ${dur.toFixed(1)} 秒（命中 ${hits} 名敌人）`
        : `护甲 +${armor}，持续 ${dur.toFixed(1)} 秒`,
      type: 'buff',
      dur,
      icon: '🛡',
      stats: { armor },
      stackMode: 'refresh',
    });
    // 视觉：地面冲击环（渲染层按 r/radius 画实心冲击波，不要细环描边 —— 见契约 §6 硬约束）
    pushWorldEvent(world, 'stomp', {
      x: player.x, z: player.z, r: radius, radius,
      hits, stunned, armor, dur,
      level: skillLevelOf(player, 'stomp'),
      stunDur,
      color: '#ffb057', sourceSkill: 'stomp',
    });
    // 震屏（每次践踏都有，哪怕空放：手感反馈）
    pushWorldEvent(world, 'shake', { x: player.x, z: player.z, amount: 0.3 + Math.min(0.4, hits * 0.08) });
    player.attackAnim = 1;
    player.anim = { state: 'attack', t: 0.32, dur: 0.32, dir: player.facing };
    return hits;
  },
  update() {},
  onEnd() {},
};

// ---------------------------------------------------------------------------
// 旋风斩 whirlwind
// ---------------------------------------------------------------------------
SKILLS.whirlwind = {
  id: 'whirlwind',
  name: '旋风斩',
  desc: '按住持续旋转，每 0.18 秒对周围 2.4 范围造成 62% 武器伤害。每秒消耗 6 点法力，可移动（移速 -25%）。',
  icon: '🌀',
  manaCost: 0,
  manaPerSecond: 6,
  cooldown: 0.6,
  range: 2.4,
  castTime: 0,
  kind: 'attack',
  channel: true,
  tickInterval: 0.18,
  damagePct: 0.66,
  radius: 2.4,
  moveSpeedPenalty: -0.25,
  damageMultLevel: 0.08,
  cooldownMultLevel: 0.04,
  radiusMultLevel: 0.05,
  /**
   * 开始持续施法
   * @param {Object} world @param {Object} player @param {{x:number,z:number}} aim @param {{bar?:Object}} ctx
   */
  cast(world, player, aim, ctx = {}) {
    if (aim) faceAim(player, aim);
    const bar = ctx.bar || barOf(player, 'whirlwind', ctx);
    if (bar) { bar.tick = 0; bar.elapsed = 0; }
    pushWorldEvent(world, 'skillCast', {
      x: player.x, z: player.z, skillId: 'whirlwind', name: '旋风斩', icon: '🌀', channel: true,
    });
    return true;
  },
  /**
   * 持续施法每帧调用
   * @param {Object} world @param {Object} player @param {number} dt @param {{bar?:Object, aim?:Object}} ctx
   */
  update(world, player, dt, ctx = {}) {
    const bar = ctx.bar;
    if (!bar) return false;
    const cost = SKILLS.whirlwind.manaPerSecond * dt;
    if (player.mp <= 0) return false; // 没蓝了，结束
    player.mp = Math.max(0, player.mp - cost);
    bar.elapsed += dt;
    bar.tick += dt;
    if (ctx.aim) faceAim(player, ctx.aim);
    // 旋转视觉（半径同样按等级/天赋成长，和实际命中半径保持一致，否则会出现"看着碰到却没伤害"）
    const spinR = skillRadius(player, 'whirlwind', SKILLS.whirlwind);
    pushWorldEvent(world, 'whirl', {
      x: player.x, z: player.z, dt, angle: bar.elapsed * 14, radius: spinR,
    });
    // 每 0.18 秒跳一次伤害（按剩余时间可多次触发，dt 固定 1/60）
    while (bar.tick >= SKILLS.whirlwind.tickInterval) {
      bar.tick -= SKILLS.whirlwind.tickInterval;
      const r = skillRadius(player, 'whirlwind', SKILLS.whirlwind);
      const dmgPct = skillDamagePct(player, 'whirlwind', SKILLS.whirlwind);
      const targets = queryEnemies(world, player.x, player.z, r, null);
      for (const t of targets) {
        if (dist2(player.x, player.z, t.x, t.z) > r * r) continue;
        playerHit(world, player, t, {
          dmgPct,
          area: true,
          sourceSkill: 'whirlwind',
          knockback: 0,
          tags: ['attack', 'melee', 'aoe', 'whirl'],
        });
      }
      pushWorldEvent(world, 'whirlTick', { x: player.x, z: player.z, r, radius: r, hits: targets.length });
    }
    // [Lead 修复] 旋风斩期间不要反复设置 attack 动画：
    //   · 会把 isWhirlState 打断（渲染层的旋风层时有时无）
    //   · 每 0.18s 重置一次会让玩家看起来像在抽帧挥砍
    // 现在改为标记 whirl 状态，由渲染层用持续的旋转姿态表现。
    player.attackAnim = 0;
    player.whirlspinning = true;
    if (player.anim) {
      player.anim.state = 'whirlwind';
      player.anim.t = 0.18;
      player.anim.dur = 0.18;
    }
    return true;
  },
  onEnd(world, player) {
    player.whirlspinning = false;
    if (player.anim && player.anim.state === 'whirlwind') player.anim.state = 'idle';
    pushWorldEvent(world, 'whirlEnd', { x: player.x, z: player.z });
  },
};

// ---------------------------------------------------------------------------
// 战吼 warcry
// ---------------------------------------------------------------------------
SKILLS.warcry = {
  id: 'warcry',
  name: '战吼',
  desc: '震退周围 4.2 范围内敌人并造成少量伤害；自身 3 秒内伤害 +15%。',
  icon: '📢',
  manaCost: 20,
  cooldown: 8,
  range: 4.2,
  castTime: 0,
  kind: 'spell',
  channel: false,
  damagePct: 0.55,
  damageMultLevel: 0.08,
  cooldownMultLevel: 0.04,
  radiusMultLevel: 0.05,
  /**
   * @param {Object} world @param {Object} player @param {any} aim @param {{bar?:Object}} ctx
   */
  cast(world, player, aim, ctx = {}) {
    const mods = skillModsOf(player, 'warcry');
    const r = skillRadius(player, 'warcry', SKILLS.warcry);
    const dmgPct = skillDamagePct(player, 'warcry', SKILLS.warcry);
    const targets = queryEnemies(world, player.x, player.z, r, null);
    let hits = 0;
    for (const t of targets) {
      playerHit(world, player, t, {
        dmgPct,
        area: true,
        sourceSkill: 'warcry',
        knockback: 13,
        tags: ['spell', 'aoe', 'shout'],
      });
      // 减速 35% 持续 2.4 秒
      applyBuff(world, t, {
        id: 'warcrySlow',
        name: '惊惧',
        text: '移动速度 -35%，持续 2.4 秒',
        type: 'debuff',
        dur: 2.4,
        icon: '😱',
        stats: { moveSpeedMult: -0.35 },
      });
      // 天赋「震慑」：战吼命中即眩晕（数值同样吃 stunDurMult）
      if (skillFlag(mods, 'stun') || skillFlag(mods, 'warcryStun')) {
        applyStun(world, t, 0.8 * multBonus(mods, 'stunDurMult'), 'warcry');
      }
      hits++;
    }
    // 天赋「震怒」分支可能是伤害，也可能是护甲；这里只处理"伤害 +15% 基础"，天赋通过 damageMult 叠加
    const dmgBuff = 0.15 * (mods.damageMult || 1);
    applyBuff(world, player, {
      id: 'warcryBuff',
      name: '战吼',
      text: `伤害 +${Math.round(dmgBuff * 100)}%，持续 3 秒`,
      type: 'buff',
      dur: 3,
      icon: '🔥',
      stats: { damageMult: dmgBuff },
    });
    player.anim = { state: 'cast', t: 0.4, dur: 0.4, dir: player.facing };
    pushWorldEvent(world, 'warcry', {
      x: player.x, z: player.z, r, radius: r, hits,
      color: '#ff7a3d', level: skillLevelOf(player, 'warcry'),
    });
    pushWorldEvent(world, 'shake', { x: player.x, z: player.z, amount: 0.5 });
    return hits;
  },
  update() {},
  onEnd() {},
};

// ---------------------------------------------------------------------------
// 血性狂暴 bloodRage
// ---------------------------------------------------------------------------
SKILLS.bloodRage = {
  id: 'bloodRage',
  name: '血性狂暴',
  desc: '6 秒内攻速 +20%、暴击率 +10%、移速 +8%，但每秒流失 1.5% 最大生命。',
  icon: '🩸',
  manaCost: 0,
  cooldown: 12,
  range: 0,
  castTime: 0,
  kind: 'buff',
  channel: false,
  dur: 6,
  lifeDrainPct: 0.015,
  /**
   * @param {Object} world @param {Object} player
   */
  cast(world, player) {
    applyBuff(world, player, {
      id: 'bloodRage',
      name: '血性狂暴',
      text: '攻速 +20%，暴击 +10%，移速 +8%；每秒流失 1.5% 生命',
      type: 'buff',
      dur: SKILLS.bloodRage.dur,
      icon: '🩸',
      stats: { attackSpeedMult: 0.2, critChance: 0.1, moveSpeedMult: 0.08 },
      onTick: (w, e, b, dt) => {
        if (e.dead) return;
        const drain = e.maxHp * SKILLS.bloodRage.lifeDrainPct * dt;
        b._acc = (b._acc || 0) + drain;
        if (b._acc >= 1) {
          const amt = Math.floor(b._acc);
          b._acc -= amt;
          if (e.hp > amt) {
            e.hp -= amt;
            if (w) pushWorldEvent(w, 'drain', { x: e.x, z: e.z, amount: amt, target: e, sourceSkill: 'bloodRage' });
          }
        }
      },
    });
    player.anim = { state: 'cast', t: 0.35, dur: 0.35, dir: player.facing };
    pushWorldEvent(world, 'buffCast', { x: player.x, z: player.z, skillId: 'bloodRage', name: '血性狂暴', color: '#c2283a' });
    return true;
  },
  update() {},
  onEnd() {},
};

// ---------------------------------------------------------------------------
// 坚毅图腾 rally
// ---------------------------------------------------------------------------
SKILLS.rally = {
  id: 'rally',
  name: '坚毅图腾',
  desc: '召唤图腾 6 秒，范围内每秒回复 3% 法力，并提升自身 8% 护甲。',
  icon: '🗿',
  manaCost: 15,
  cooldown: 10,
  range: 1.6,
  castTime: 0.2,
  kind: 'summon',
  channel: false,
  dur: 6,
  /**
   * @param {Object} world @param {Object} player @param {{x:number,z:number}} aim
   */
  cast(world, player, aim) {
    // 图腾放在玩家面前一点点
    const dir = facingDir(player, aim);
    let x = player.x + dir.x * 1.2;
    let z = player.z + dir.z * 1.2;
    // 天赋「双生」：同时放 2 个图腾（第二个放在侧后方，避免叠在同一个点）
    const count = skillFlag(skillModsOf(player, 'rally'), 'two') ? 2 : 1;
    // 同名图腾只保留 1 个：移除旧的（按天赋数量会都清掉，再一起放）
    if (Array.isArray(world.summoned)) {
      for (let i = world.summoned.length - 1; i >= 0; i--) {
        const s = world.summoned[i];
        if (s && s.type === 'totem' && s.owner === player) {
          s.remaining = 0;
          s.dead = true;
          world.summoned.splice(i, 1);
        }
      }
    }
    const totems = [];
    for (let i = 0; i < count; i++) {
      const a = player.facing + (i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * (Math.PI * 0.6) * Math.ceil(i / 2));
      let tx = player.x + Math.sin(a) * 1.2;
      let tz = player.z + Math.cos(a) * 1.2;
      if (world && world.isWalkable && !world.isWalkable(tx, tz)) { tx = player.x; tz = player.z; }
      totems.push(spawnSummon(world, player, tx, tz, { type: 'totem', dur: SKILLS.rally.dur, hp: 80 }));
    }
    x = totems[0].x;
    z = totems[0].z;
    const totem = totems[0];
    pushWorldEvent(world, 'skillCast', {
      x, z, skillId: 'rally', name: '坚毅图腾', icon: '🗿', entity: totem,
      count: totems.length, totems,
    });
    player.anim = { state: 'cast', t: 0.3, dur: 0.3, dir: player.facing };
    return totem;
  },
  update() {},
  onEnd() {},
};

// ---------------------------------------------------------------------------
// 翻滚 dash（不在技能栏，空格触发）
// ---------------------------------------------------------------------------
SKILLS.dash = {
  id: 'dash',
  name: '翻滚',
  desc: '朝移动方向（无移动则朝面向）翻滚 4.2 单位，0.18 秒内无敌。冷却 1.2 秒。',
  icon: '💨',
  manaCost: 0,
  cooldown: DASH_COOLDOWN,
  range: DASH_DISTANCE,
  castTime: 0,
  kind: 'move',
  channel: false,
  iframe: DASH_IFRAME,
  cast() {},
  update() {},
  onEnd() {},
};

/**
 * 翻滚：朝当前移动方向瞬移 DASH_DISTANCE，过程中不被阻挡则停在最后一格。
 * Lead 的输入层在按下空格时调用本函数。
 * @param {Object} world @param {Object} player
 * @returns {boolean} 是否成功
 */
export function tryDash(world, player) {
  if (!world || !player || player.dead) return false;
  if ((player.cooldowns && player.cooldowns.dash > 0) || (player.dashCooldown > 0)) return false;
  if (player.isDashing) return false;
  let dirX = player.moveX || 0;
  let dirZ = player.moveZ || 0;
  const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (len < 0.01) {
    dirX = Math.sin(player.facing || 0);
    dirZ = Math.cos(player.facing || 0);
  } else {
    dirX /= len;
    dirZ /= len;
  }
  const startX = player.x;
  const startZ = player.z;
  const steps = 24;
  const stepLen = DASH_DISTANCE / steps;
  let moved = 0;
  for (let i = 0; i < steps; i++) {
    const nx = player.x + dirX * stepLen;
    const nz = player.z + dirZ * stepLen;
    if (world.isWalkable && !world.isWalkable(nx, nz)) break;
    player.x = nx;
    player.z = nz;
    moved += stepLen;
  }
  // 翻滚后朝向
  if (moved > 0) player.facing = Math.atan2(dirX, dirZ);
  // 无敌
  player.invuln = Math.max(player.invuln || 0, DASH_IFRAME);
  player.isDashing = true;
  player.dashTimer = DASH_IFRAME;
  // 冷却
  if (!player.cooldowns) player.cooldowns = {};
  player.cooldowns.dash = DASH_COOLDOWN * (1 - clamp(player.stats ? player.stats.cdrMult || 0 : 0, 0, 0.6));
  player.pendingDashCd = player.cooldowns.dash;
  player.vx = dirX * 20;
  player.vz = dirZ * 20;
  player.anim = { state: 'dash', t: 0.24, dur: 0.24, dir: player.facing };
  pushWorldEvent(world, 'dash', {
    x: startX, z: startZ, toX: player.x, toZ: player.z,
    dirX, dirZ, distance: moved, iframe: DASH_IFRAME,
  });
  return true;
}

/**
 * 玩家普通攻击（左键）：攻速由 stats.attackSpeedMult 决定，暴击可见。
 * 前向扇形 1.9 范围，100% 武器伤害 + 37% 攻速加成的基础挥砍。
 * @param {Object} world @param {Object} player
 * @returns {number} 命中数量
 */
export function tryBasicAttack(world, player) {
  if (!world || !player || player.dead) return 0;
  if ((player.attackTimer || 0) > 0) return 0;
  const s = player.stats || {};
  const rate = BASE_ATTACK_SPEED * (1 + (s.attackSpeedMult || 0));
  player.attackTimer = 1 / Math.max(0.3, rate);
  player.attackAnim = 1;
  if (player.anim) { player.anim.state = 'attack'; player.anim.t = 0.22; player.anim.dur = 0.22; }
  // [playtest 修复] 半径 1.95 → 2.1：POE 里近战挥砍必须几乎必中，原来 1.95 + 0.8 前推的命中区
  // 对 1.25 半径的 Boss 经常差一点，导致贴身 miss。
  const r = scaledR(player, 2.1);
  const cx = player.x + Math.sin(player.facing) * 0.8;
  const cz = player.z + Math.cos(player.facing) * 0.8;
  const targets = queryEnemies(world, cx, cz, r, null);
  let hits = 0;
  for (const t of targets) {
    const d = normDir(t.x - player.x, t.z - player.z);
    const fx = Math.sin(player.facing), fz = Math.cos(player.facing);
    const dot = fx * d.x + fz * d.z;
    // [playtest 修复] 扇形半角 0.42π（75.6°）→ 0.55π（99°）：贴身时朝向偏一点就打不中，手感太差
    if (Math.acos(clamp(dot, -1, 1)) > Math.PI * 0.55) continue;
    playerHit(world, player, t, { dmgPct: 1, sourceSkill: 'basicAttack', knockback: 2, tags: ['attack', 'melee'] });
    hits++;
  }
  pushWorldEvent(world, 'swing', { x: player.x, z: player.z, facing: player.facing, r, hits });
  return hits;
}

/**
 * 持续施法是否被允许继续（蓝量检查）。由 tickSkills 使用。
 */
function canContinueChannel(world, player, bar) {
  const def = SKILLS[bar.id];
  if (!def || !def.channel) return false;
  if (player.dead) return false;
  if (def.manaPerSecond) {
    if (player.mp <= 0) return false;
  }
  return true;
}

/**
 * 每帧更新技能：冷却倒计时、持续施法（旋风斩按住）、攻速计时、翻滚无敌计时。
 * @param {Object} world @param {Object} player @param {number} dt
 */
export function tickSkills(world, player, dt) {
  if (!player) return;
  if (!player.cooldowns) player.cooldowns = {};
  // ---- 冷却（player.cooldowns 是权威值，UI 直接读它）----
  for (const k in player.cooldowns) {
    if (player.cooldowns[k] > 0) player.cooldowns[k] = Math.max(0, player.cooldowns[k] - dt);
  }
  if (player.dashTimer > 0) {
    player.dashTimer = Math.max(0, player.dashTimer - dt);
    if (player.dashTimer <= 0) player.isDashing = false;
  }
  if (player.invuln > 0) player.invuln = Math.max(0, player.invuln - dt);
  if (player.attackTimer > 0) player.attackTimer = Math.max(0, player.attackTimer - dt);
  if (player.attackAnim > 0) player.attackAnim = Math.max(0, player.attackAnim - dt * 4.5);
  if (player.hitFlash > 0) player.hitFlash = Math.max(0, player.hitFlash - dt * 4);
  if (player.flash > 0) player.flash = Math.max(0, player.flash - dt * 3);
  if (player.castLock > 0) player.castLock = Math.max(0, player.castLock - dt);
  if (player.anim && player.anim.t > 0) player.anim.t = Math.max(0, player.anim.t - dt);

  // ---- 技能栏实例 ----
  const bar = player.skillBar;
  if (!Array.isArray(bar)) return;
  for (const inst of bar) {
    if (!inst || !inst.id || !SKILLS[inst.id]) continue;
    const def = SKILLS[inst.id];
    // 技能实例的 cd 与 cooldowns 保持同步（同一帧内不要出现两个不同的值）
    inst.cd = player.cooldowns[inst.id] || 0;
    if (!inst.active) continue;
    // 持续施法：按住才继续
    if (def.channel) {
      // 只有"按住"（releaseChannel 未调用）才继续；Lead 松开鼠标时调用 releaseChannel
      const wantHold = inst.holding !== false;
      const ok = canContinueChannel(world, player, inst) && wantHold;
      if (!ok) {
        endChannel(world, player, inst);
        continue;
      }
      const cont = def.update(world, player, dt, { bar: inst, aim: player.aim });
      if (cont === false) {
        endChannel(world, player, inst);
      }
    } else if (typeof def.update === 'function') {
      def.update(world, player, dt, { bar: inst, aim: player.aim });
      if (inst.castTimeLeft !== undefined) {
        inst.castTimeLeft -= dt;
        if (inst.castTimeLeft <= 0) {
          inst.active = false;
          delete inst.castTimeLeft;
          if (typeof def.onEnd === 'function') def.onEnd(world, player, inst);
        }
      }
    }
  }
}

/**
 * 结束持续施法。
 * @param {Object} world @param {Object} player @param {Object} inst
 */
export function endChannel(world, player, inst) {
  if (!inst || !inst.active) return;
  inst.active = false;
  inst.holding = false;
  inst.tick = 0;
  inst.elapsed = 0;
  const def = SKILLS[inst.id];
  if (def && typeof def.onEnd === 'function') def.onEnd(world, player, inst);
  // 持续技能结束时进入短冷却（已套用等级/天赋/冷却缩减）
  const cdTotal = skillCooldownTotal(player, inst.id, def);
  if (def && cdTotal > 0) {
    player.cooldowns[inst.id] = cdTotal;
    inst.cd = cdTotal;
  }
}

/**
 * 尝试施放技能：检查死亡/冷却/蓝量/前摇锁，成功则消耗并触发事件。
 * @param {Object} world @param {Object} player @param {string} skillId
 * @param {{x:number,z:number}} [aim] 鼠标世界坐标
 * @returns {boolean} 是否成功施放（或成功开始持续施法）
 */
export function tryCast(world, player, skillId, aim) {
  if (!world || !player || player.dead) return false;
  const def = SKILLS[skillId];
  if (!def) return false;
  if (skillId === 'dash') return tryDash(world, player);
  if (!player.cooldowns) player.cooldowns = {};
  if ((player.cooldowns[skillId] || 0) > 0) return false;
  if (player.castLock > 0) return false;
  if (!Array.isArray(player.skillBar)) player.skillBar = [];
  const inst = player.skillBar.find((s) => s && s.id === skillId) || null;
  if (!inst) return false; // 技能必须在技能栏里

  const manaCost = def.manaCost || 0;
  if (manaCost > 0 && player.mp < manaCost) {
    pushWorldEvent(world, 'noMana', { x: player.x, z: player.z, skillId, need: manaCost, have: player.mp });
    return false;
  }
  // 持续施法：已经在持续中就刷新按住状态
  if (def.channel) {
    if (inst.active) { inst.holding = true; return true; }
    if (inst.cd > 0) return false;
    if (player.mp <= 0 && (def.manaPerSecond || 0) > 0) {
      pushWorldEvent(world, 'noMana', { x: player.x, z: player.z, skillId, need: 1, have: player.mp });
      return false;
    }
    if (aim) player.aim = { x: aim.x, z: aim.z };
    inst.active = true;
    inst.holding = true;
    inst.tick = 0;
    inst.elapsed = 0;
    player.channelHold = true;
    if (typeof def.cast === 'function') def.cast(world, player, aim, { bar: inst });
    return true;
  }
  if (player.mp < manaCost) return false;
  // 消耗
  player.mp = Math.max(0, player.mp - manaCost);
  // 冷却 = 基础 × (1 - cdr) × 天赋 cooldownMult × 等级冷却成长（见 skillsUpgrade.skillCooldownTotal）
  const cd = skillCooldownTotal(player, skillId, def);
  player.cooldowns[skillId] = cd;
  inst.cd = cd;
  // 前摇
  if (def.castTime > 0) {
    player.castLock = def.castTime;
    if (player.anim) { player.anim.state = 'cast'; player.anim.t = def.castTime; player.anim.dur = def.castTime; }
  }
  const result = typeof def.cast === 'function' ? def.cast(world, player, aim, { bar: inst }) : false;
  if (result === false) {
    // 施法失败：退还
    player.mp = Math.min(player.maxMp, player.mp + manaCost);
    player.cooldowns[skillId] = 0;
    inst.cd = 0;
    return false;
  }
  pushWorldEvent(world, 'skillCast', {
    x: player.x, z: player.z,
    skillId,
    name: def.name,
    icon: def.icon,
    kind: def.kind,
    manaCost,
    cooldown: cd,
  });
  return true;
}

/**
 * 创建一个技能实例（技能栏格子）。
 * @param {string} id @param {number} [level]
 * @returns {Object} SkillInstance
 */
export function makeSkillInstance(id, level = 1) {
  const def = SKILLS[id];
  return {
    id,
    level,
    // 精炼等级由 app 层同步（契约 §2.1：核心兜底 0）
    refine: 0,
    cd: 0,
    active: false,
    holding: false,
    tick: 0,
    elapsed: 0,
    name: def ? def.name : id,
    icon: def ? def.icon : '?',
    desc: def ? def.desc : '',
    kind: def ? def.kind : '',
  };
}

/**
 * 按技能栏顺序初始化（createPlayer 用）。
 * [契约 v1] 1 号技能从「裂地斩 groundSlam」换成「战争践踏 stomp」，顺序与 SKILL_IDS 保持一致。
 * @param {string[]} ids
 * @returns {Array<Object|null>}
 */
export function makeSkillBar(ids = ['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally']) {
  /** @type {Array<Object|null>} */
  const bar = new Array(SKILL_BAR_SIZE).fill(null);
  for (let i = 0; i < ids.length && i < SKILL_BAR_SIZE; i++) {
    if (ids[i]) bar[i] = makeSkillInstance(ids[i], 1);
  }
  return bar;
}

/**
 * 松开持续施法（Lead 在松开鼠标/按键时调用）。
 * 若不调用，旋风斩会一直持续到蓝量耗尽。
 * @param {Object} world @param {Object} player @param {string} [skillId] 不传则结束所有持续施法
 */
export function releaseChannel(world, player, skillId) {
  if (!player || !Array.isArray(player.skillBar)) return;
  player.channelHold = false;
  for (const inst of player.skillBar) {
    if (!inst || !inst.active) continue;
    if (skillId && inst.id !== skillId) continue;
    inst.holding = false;
    endChannel(world, player, inst);
  }
}

/** 当前是否正在持续施法（渲染层据此切换动画） */
export function isChanneling(player) {
  if (!player || !Array.isArray(player.skillBar)) return false;
  return player.skillBar.some((s) => s && s.active && SKILLS[s.id] && SKILLS[s.id].channel);
}

/** 供 UI：技能冷却百分比（0 = 就绪，1 = 刚进入冷却）。
 * 分母用**最终**冷却（已套用 cdr/天赋/等级），否则升级后冷却环会在 0 之前就空了。 */
export function cooldownPct(player, skillId) {
  const cd = (player && player.cooldowns && player.cooldowns[skillId]) || 0;
  const def = SKILLS[skillId];
  if (!cd || !def) return 0;
  const total = skillCooldownTotal(player, skillId, def);
  if (!(total > 0)) return 0;
  return clamp(cd / total, 0, 1);
}

/** 供 UI：技能是否可施放（蓝量/冷却） */
export function canCastSkill(player, skillId) {
  const def = SKILLS[skillId];
  if (!def || !player || player.dead) return false;
  if ((player.cooldowns && player.cooldowns[skillId]) > 0) return false;
  if ((def.manaCost || 0) > player.mp) return false;
  return true;
}

/**
 * 供 UI：某个技能的**最终有效值**（契约 §2.3）。
 *
 * 【硬约束】必须能在没有 world 的情况下调用：只读 player 上的字段
 *   （player.skillBar / player.skills / player.skillMods / player.stats）。
 * 所有字段都做过缺省兜底，UI 在存档损坏 / 老存档（没有 skillMods）时也不会崩。
 *
 * @param {Object|null} player
 * @param {string} skillId
 * @returns {{
 *   id:string, name:string, icon:string, desc:string, kind:string,
 *   level:number, levelCap:number, refine:number,
 *   manaCost:number, cooldown:number,
 *   range:number, radius:number,
 *   damagePct:number,
 *   focus:'left'|'right'|'',
 *   stunDuration:number, armorGain:number, armorDuration:number,
 *   refines:Array<{key:string,name:string,desc:string,refine:number,max:number,cost:number|null,level:number}>
 * }}
 */
export function skillDisplayInfo(player, skillId) {
  const def = SKILLS[skillId] || null;
  const mods = skillModsOf(player, skillId);
  const refine = refineLevelOf(player, skillId);
  const level = skillLevelOf(player, skillId);
  const baseRange = def ? (typeof def.radius === 'number' ? def.radius : def.range || 0) : 0;
  // 施法距离（range）与作用半径（radius）分开给 UI：
  //   瞬发圆形技能两者相同；图腾这类 range 是"放置距离"，radius 兜底用 range。
  const range = def ? skillRadius(player, skillId, def, typeof def.range === 'number' ? def.range : baseRange) : 0;
  const radius = def ? skillRadius(player, skillId, def, baseRange) : 0;
  const isStomp = skillId === 'stomp';
  const maxRefineCost = refineCostOf(refine);
  return {
    id: skillId,
    name: def ? def.name : SKILL_NAMES[skillId] || skillId,
    icon: def ? def.icon : '❔',
    desc: def ? def.desc : '',
    kind: def && def.kind ? def.kind : '',
    level,
    levelCap: SKILL_LEVEL_CAP,
    refine,
    manaCost: def && typeof def.manaCost === 'number' ? def.manaCost : 0,
    cooldown: def ? Math.round(skillCooldownTotal(player, skillId, def) * 1000) / 1000 : 0,
    range: Math.round(range * 100) / 100,
    radius: Math.round(radius * 100) / 100,
    damagePct: def ? Math.round(skillDamagePct(player, skillId, def) * 1000) / 1000 : 1,
    focus: skillFocus(mods),
    // 只有践踏有"眩晕/护甲"这两个机制值；其它技能给 0，UI 可以直接按 >0 决定是否显示
    stunDuration: isStomp && def ? Math.round(stompStunDuration(player, def) * 100) / 100 : 0,
    armorGain: isStomp && def ? stompArmorFor(0, mods, { def }) : 0,
    armorDuration: isStomp && def ? Math.round(stompArmorDuration(player, def) * 100) / 100 : 0,
    // 精炼条：4 格，第 i 格表示"再花 cost 个精炼石能到 i+1 精炼"
    refines: Array.from({ length: REFINE_MAX }, (_, i) => {
      const cost = refineCostOf(i);
      return {
        key: `${skillId}.refine${i + 1}`,
        name: `精炼 ${i + 1}`,
        desc: `技能等级 +1（当前 ${level}/${SKILL_LEVEL_CAP}）`,
        refine: i,
        max: REFINE_MAX,
        cost,
        leveled: refine > i,
        next: refine === i,
      };
    }),
    nextRefineCost: maxRefineCost,
    talentPoints: talentPointsOf(mods),
  };
}

/**
 * UI 冷却环用：技能最终冷却总时长（秒，已套用 cdr / 天赋 / 等级）。
 * @param {Object|null} player @param {string} skillId
 * @returns {number}
 */
export function skillCooldown(player, skillId) {
  return skillCooldownTotal(player, skillId, SKILLS[skillId]);
}

/**
 * 下一次精炼（升技能等级）需要多少精炼石；已满级 / 已到等级上限返回 null。
 * 注意：这里不读 inv（核心不认识背包），只读 player 上的精炼等级；
 * 余额判断由 app 层的 canRefineSkill 做。
 * @param {Object|null} player @param {string} skillId
 * @returns {number|null}
 */
export function nextRefineCost(player, skillId) {
  const refine = refineLevelOf(player, skillId);
  if (refine >= REFINE_MAX) return null;
  const mods = skillModsOf(player, skillId);
  const bonus = player && player.stats && Number.isFinite(player.stats.skillLevelBonus)
    ? Math.floor(player.stats.skillLevelBonus) : 0;
  // 天赋点已经把这个技能顶到上限时，再精炼也拿不到等级 —— 返回 null，避免"白花石头"。
  // 注意：精炼本身没满（< REFINE_MAX）时仍然返回价格，即使等级暂时被 5 级上限吃掉
  // （重置天赋后这些精炼等级会立刻变成实打实的等级，UI 需要能继续精炼）。
  const after = Math.min(SKILL_LEVEL_CAP, talentPointsOf(mods) + refine + 2 + bonus);
  const before = Math.min(SKILL_LEVEL_CAP, talentPointsOf(mods) + refine + 1 + bonus);
  if (talentPointsOf(mods) > 0 && after <= before) return null;
  return refineCostOf(refine);
}