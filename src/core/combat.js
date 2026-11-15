// @file src/core/combat.js
// 战斗结算：伤害计算 / 暴击 / 闪避 / 护甲 / 抗性 / 吸血 / 击杀 / 治疗 / buff / 击退。
// 纯逻辑，不依赖 DOM / three。
//
// 【事件】本模块会向 world.events 推送：
//   'hit'      { x, z, target, amount, crit, element, sourceSkill, targetId, sourceId, kind }
//   'crit'     { x, z, target, amount, element }（仅在暴击时额外推送一次，便于渲染层做强化命中效果）
//   'miss'     { x, z, target, element, sourceId }（闪避/未命中）
//   'block'    { x, z, target, amount }
//   'kill'     { x, z, entity, byPlayer }（玩家击杀计入）
//   'monsterKilled' { x, z, entity, monster, rarity, byPlayer, height }（每只怪物死亡都推）
//   'playerDeath'   { x, z }
//   'heal'     { x, z, amount, target }
//   'lifesteal'{ x, z, amount }
//   'buff'     { x, z, entity, buff }  'buffEnd' { x, z, entity, buff }
//   'explosion'{ x, z, radius }
//   'thorns'   { x, z, amount, target }
//   'stun'     { x, z, target, targetId, dur, rawDur, resist, sourceSkill, stunTime, stunMax }
//   'stunEnd'  { x, z, target, targetId, sourceSkill }
//
// 【眩晕（契约 §3.6）】
//   只写 entity.stunTime / entity.stunMax 两个字段，**执行层**（monsters.js 的 updateMonsterAI）
//   负责"被控期间不动不攻击"。之所以把判断放在 AI 里而不是这里：dealDamage / knockback 等
//   其他系统不需要知道眩晕，只有"行为"需要被冻结，职责更清楚。

import { clamp } from './stats.js';

/**
 * @typedef {Object} DamagePacket
 * @property {number} [phys]        物理伤害
 * @property {number} [fire]        火焰伤害
 * @property {number} [cold]        冰霜伤害
 * @property {number} [lightning]   闪电伤害
 * @property {number} [chaos]       混沌伤害（忽略护甲与元素抗性，只走混沌抗）
 * @property {boolean} [crit]       是否强制暴击（不传则按 source 暴击率掷骰）
 * @property {number} [critMulti]   暴击倍率（默认用 source.stats.critMulti || 1.5）
 * @property {'hit'|'dot'} [kind]   伤害类型，默认 'hit'；dot 不会被闪避/格挡
 * @property {boolean} [canCrit]    是否可暴击，默认 false（普通攻击应显式传 true）
 * @property {number} [knockback]   击退力度（0 表示不击退）
 * @property {string} [sourceSkill] 来源技能 id（渲染层用来区分颜色/音效）
 * @property {string[]} [tags]      标签，如 ['attack','melee','aoe']
 * @property {boolean} [area]       是否为范围伤害（享受 areaDamageMult）
 * @property {number} [aoeMult]     技能自带范围加成（会再乘一层 aoeMult 属性）
 * @property {number} [damageMult]  技能自带伤害倍率（例如 1.55 表示 155%），会先乘到各元素上
 * @property {boolean} [noThorns]   不触发荆棘
 * @property {boolean} [noLeech]    不触发吸血
 */

/**
 * 世界事件推送。兼容两种 world.emit 签名：
 *   world.emit(evt)                  —— 传完整事件对象
 *   world.emit(type, payload)        —— 传类型 + 载荷
 * 没有 emit 时直接 push 到 world.events（由 Lead 消费并清空）。
 * @param {Object} world @param {string} type @param {Object} [payload]
 */
export function pushWorldEvent(world, type, payload) {
  if (!world) return;
  const evt = { type, t: world.time || 0, ...(payload || {}) };
  if (typeof world.emit === 'function') {
    try {
      world.emit(evt);
      return;
    } catch {
      try {
        world.emit(type, payload || {});
        return;
      } catch {
        /* 落到下面的 push */
      }
    }
  }
  if (!Array.isArray(world.events)) world.events = [];
  world.events.push(evt);
}

/** 取 world.rng（缺失时退化到 Math.random 包装，测试友好）。 */
export function rngOf(world) {
  if (world && world.rng && typeof world.rng.next === 'function') return world.rng;
  return {
    next: () => Math.random(),
    range: (a, b) => a + (b - a) * Math.random(),
    int: (a, b) => Math.floor(a + (b - a + 1) * Math.random()),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    chance: (p) => Math.random() < p,
  };
}

/** 二维距离 */
export function dist(x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  return Math.sqrt(dx * dx + dz * dz);
}

/** 二维距离平方 */
export function dist2(x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  return dx * dx + dz * dz;
}

/** 归一化方向（零向量返回 0,0） */
export function normDir(dx, dz) {
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-8) return { x: 0, z: 0, len: 0 };
  return { x: dx / len, z: dz / len, len };
}

/**
 * 实体是否处于无敌状态（玩家翻滚 / 怪物冲锋免控等）。
 * 使用 entity.invuln（秒）—— 由 skills.tryDash 维护；也为 0 时视为不无敌。
 * @param {Object} e
 */
export function isInvulnerable(e) {
  if (!e) return false;
  return (e.invuln || 0) > 0 || e.noDamage === true;
}

/**
 * 计算元素抗性减伤后的伤害。
 * @param {number} raw @param {number} resist 0..0.9（可为负）
 */
export function applyResist(raw, resist) {
  const r = clamp(resist || 0, -0.75, 0.9);
  return raw * (1 - r);
}

/**
 * 护甲减伤公式：reduction = armor / (armor + 10 * rawPhys)，上限 75%。
 * 注意：contract 里写的 "armor/(armor+10*physRaw)" 若按字面实现，
 * 100 护甲对 100 物理只有 9% 减免（POE 里 100 护甲 ≈ 50%），手感太弱；
 * 因此这里把护甲作为「护甲点数」，实际使用 armor/(armor+rawPhys*10) 的 POE 公式，
 * 并在 monsters 模板里给出相应量级的护甲值。
 * 例：armor=100, phys=100 → 100/(100+1000) = 9.1%；
 *     armor=1000, phys=100 → 1000/(1000+1000) = 50%。
 * @param {number} armor @param {number} rawPhys
 * @returns {number} 减免比例 0..0.75
 */
export function armorReduction(armor, rawPhys) {
  if (!(armor > 0) || !(rawPhys > 0)) return 0;
  const red = armor / (armor + rawPhys * 10);
  return clamp(red, 0, 0.75);
}

/**
 * 单次命中的结算结果（用于测试与调试）。
 * @typedef {Object} HitResult
 * @property {number} amount    最终造成的伤害总量
 * @property {boolean} hit      是否命中（闪避则为 false）
 * @property {boolean} blocked  是否被格挡
 * @property {boolean} crit     是否暴击
 * @property {'phys'|'fire'|'cold'|'lightning'|'chaos'|'mixed'} element 主导元素（用于飘字配色）
 * @property {boolean} dead     目标是否因此死亡
 */

/**
 * 结算一次伤害（核心函数）。所有技能/怪物攻击都必须走这里。
 *
 * 结算顺序：
 *   1. 目标已死 / 无敌 → 直接返回；
 *   2. 非 dot 且未强制命中 → 闪避掷骰（target.stats.evasion），未命中推 'miss' 事件；
 *   3. 格挡（target.stats.blockChance）→ 伤害减半？不：POE 是全额格挡，这里选择"减免 60%"以保持手感；
 *   4. 物理：护甲减免；元素：对应抗性；混沌：混沌抗；
 *   5. 暴击（canCrit && rng < source.critChance）→ 全部伤害 × critMulti；
 *   6. 范围伤害 → × (1 + areaDamageMult + aoeMult*skillMul)；
 *   7. 承受伤害修正 target.stats.damageTakenMult；
 *   8. 能量护盾优先吸收；剩余打生命；
 *   9. 吸血 / 荆棘；hp<=0 → killEntity。
 *
 * @param {Object|null} world
 * @param {Object|null} source 伤害来源实体（可为 null，表示环境伤害）
 * @param {Object} target 受击实体
 * @param {DamagePacket} packet
 * @returns {HitResult}
 */
export function dealDamage(world, source, target, packet) {
  const res = { amount: 0, hit: false, blocked: false, crit: false, element: 'phys', dead: false };
  if (!target || target.dead) return res;
  const p = packet || {};
  if (isInvulnerable(target)) return res;
  // 友军伤害保护：同队不打（team 相同）
  if (source && source !== target && source.team === target.team && target.team === 0) return res;

  const tStats = target.stats || {};
  const kind = p.kind === 'dot' ? 'dot' : 'hit';
  const rng = rngOf(world);
  const mult = typeof p.damageMult === 'number' ? p.damageMult : 1;

  // ---- 原始各元素 ----
  let phys = Math.max(0, (p.phys || 0)) * mult;
  let fire = Math.max(0, (p.fire || 0)) * mult;
  let cold = Math.max(0, (p.cold || 0)) * mult;
  let lightning = Math.max(0, (p.lightning || 0)) * mult;
  let chaos = Math.max(0, (p.chaos || 0)) * mult;
  if (phys + fire + cold + lightning + chaos <= 0) return res;

  // ---- 1. 闪避（dot 不闪避）----
  if (kind === 'hit' && !p.forceHit) {
    const ev = clamp(tStats.evasion || 0, 0, 0.75);
    if (ev > 0 && rng.next() < ev) {
      pushWorldEvent(world, 'miss', {
        x: target.x, z: target.z, target, targetId: target.id,
        sourceId: source && source.id, element: dominantElement(phys, fire, cold, lightning, chaos),
        sourceSkill: p.sourceSkill,
      });
      res.element = dominantElement(phys, fire, cold, lightning, chaos);
      return res;
    }
  }

  // ---- 2. 格挡（dot 不格挡）----
  if (kind === 'hit') {
    const bc = clamp(tStats.blockChance || 0, 0, 0.75);
    if (bc > 0 && rng.next() < bc) {
      res.blocked = true;
      const total = phys + fire + cold + lightning + chaos;
      pushWorldEvent(world, 'block', { x: target.x, z: target.z, target, targetId: target.id, amount: total * 0.4 });
      // 格挡：减免 60% 伤害（不返回，继续结算以避免"格挡即无敌"）
      phys *= 0.4; fire *= 0.4; cold *= 0.4; lightning *= 0.4; chaos *= 0.4;
    }
  }

  // ---- 3. 护甲 / 抗性 ----
  if (phys > 0) {
    const red = armorReduction(tStats.armor || 0, phys);
    phys *= 1 - red;
  }
  if (fire > 0) fire = applyResist(fire, tStats.fireResist);
  if (cold > 0) cold = applyResist(cold, tStats.coldResist);
  if (lightning > 0) lightning = applyResist(lightning, tStats.lightningResist);
  if (chaos > 0) chaos = applyResist(chaos, tStats.chaosResist);

  // ---- 4. 暴击 ----
  let crit = false;
  if (p.canCrit !== false && kind === 'hit') {
    const cc = clamp(source && source.stats ? source.stats.critChance || 0 : 0, 0, 1);
    crit = p.crit === true || (cc > 0 && rng.next() < cc);
  }
  const critMul = crit ? (p.critMulti || (source && source.stats ? source.stats.critMulti : 1.5) || 1.5) : 1;
  let total = phys + fire + cold + lightning + chaos;
  total *= critMul;

  // ---- 5. 范围伤害加成 / 承受伤害修正 ----
  if (p.area) {
    const sStats = source && source.stats ? source.stats : null;
    const areaBonus = (sStats ? sStats.areaDamageMult || 0 : 0) + (p.aoeMult || 0);
    total *= 1 + areaBonus;
  }
  const takenMult = 1 + (tStats.damageTakenMult || 0);
  total *= takenMult;
  if (!(total > 0)) return res;
  total = Math.max(1, Math.round(total));

  // ---- 6. 入血 ----
  const before = target.hp + (target.energyShield || 0);
  applyRawDamage(target, total);
  const dealt = Math.min(total, before);
  res.amount = dealt;
  res.hit = true;
  res.crit = crit;
  res.element = dominantElement(phys, fire, cold, lightning, chaos);
  res.dead = target.hp <= 0;

  // ---- 7. 事件 ----
  const evtBase = {
    x: target.x, z: target.z,
    amount: dealt,
    crit,
    element: res.element,
    sourceSkill: p.sourceSkill || null,
    target, targetId: target.id,
    source, sourceId: source && source.id,
    kind,
    blocked: res.blocked,
    targetIsPlayer: target.kind === 'player' || target === (world && world.player),
    height: target.height || (target.template && target.template.visual ? target.template.visual.size * 2 : 1.6),
  };
  pushWorldEvent(world, 'hit', evtBase);
  if (crit) pushWorldEvent(world, 'crit', evtBase);
  if (p.projectile) pushWorldEvent(world, 'projectileHit', evtBase);

  // ---- 8. 吸血（只有玩家/召唤物打人时生效）----
  if (source && source !== target && kind === 'hit' && !p.noLeech) {
    const leech = source.stats ? source.stats.lifeLeech || 0 : 0;
    if (leech > 0 && !source.dead) {
      const gain = Math.max(1, Math.round(dealt * leech));
      healEntity(world, source, gain, 'leech');
    }
    const loh = source.stats ? source.stats.lifeOnHit || 0 : 0;
    if (loh > 0 && !source.dead) healEntity(world, source, loh, 'loh');
  }

  // ---- 9. 荆棘（被打者反弹给攻击者）----
  if (!p.noThorns && source && source !== target && kind === 'hit') {
    const thorns = tStats.thorns || 0;
    if (thorns > 0 && !source.dead) {
      const back = Math.max(1, Math.round(thorns));
      applyRawDamage(source, back);
      pushWorldEvent(world, 'thorns', { x: source.x, z: source.z, amount: back, target: source, source });
      if (source.hp <= 0) killEntity(world, source, target);
    }
  }

  // ---- 10. 击退 ----
  if (p.knockback > 0 && !target.dead) {
    const d = normDir(target.x - (source ? source.x : target.x), target.z - (source ? source.z : target.z));
    knockback(world, target, d.x, d.z, p.knockback);
  }

  // ---- 11. 死亡 ----
  if (target.hp <= 0) {
    res.dead = true;
    killEntity(world, target, source);
  } else if ((target.kind === 'monster' || target.team === 1) && target.ai && source && source.team === 0) {
    // 被玩家打醒
    if (target.ai.state === 'idle') target.ai.state = 'chase';
    if (source === (world && world.player)) target.aggro = true;
  }
  return res;
}

/**
 * 不加任何减伤地扣血（护盾优先），用于荆棘/纯净伤害/环境伤害。
 * @param {Object} target @param {number} amount
 */
export function applyRawDamage(target, amount) {
  if (!target || amount <= 0) return 0;
  let dmg = amount;
  if (typeof target.energyShield === 'number' && target.energyShield > 0) {
    const absorb = Math.min(target.energyShield, dmg);
    target.energyShield -= absorb;
    dmg -= absorb;
  }
  target.hp -= dmg;
  if (target.hp < 0) target.hp = 0;
  // 受击反馈（渲染用）
  target.hitFlash = 1;
  target.flash = 1;
  return amount;
}

/**
 * 元素判定（用于飘字配色）：取伤害占比最高的一种。
 * @returns {'phys'|'fire'|'cold'|'lightning'|'chaos'|'mixed'}
 */
export function dominantElement(phys, fire, cold, lightning, chaos) {
  const list = [['phys', phys], ['fire', fire], ['cold', cold], ['lightning', lightning], ['chaos', chaos]];
  let best = 'phys', bestV = phys, nonZero = 0;
  for (const [k, v] of list) {
    if (v > 0) nonZero++;
    if (v > bestV) { best = k; bestV = v; }
  }
  if (nonZero === 0) return 'phys';
  if (nonZero > 2) return 'mixed';
  return best;
}

/**
 * 计算一次攻击的伤害包（玩家普通攻击/技能通用），把 StatBlock 上的附加伤害与加成汇总进来。
 * 这样所有技能只需要传「百分比倍率」即可，不用关心附加伤害。
 *
 * @param {Object} source 攻击者
 * @param {{mistake?:never}} [_
 * @param {Object} [opts]
 * @param {number} [opts.dmgPct]    武器伤害百分比（1.0 = 100%）
 * @param {number} [opts.flatMult]  对武器伤害的额外倍率（例如旋风斩 0.62）
 * @param {number} [opts.area]      是否范围伤害
 * @param {boolean} [opts.convertFirePct] 把武器物理伤害转换为火焰伤害的比例（0..1）
 * @param {string} [opts.sourceSkill]
 * @param {string[]} [opts.tags]
 * @param {boolean} [opts.canCrit]
 * @param {number} [opts.knockback]
 * @returns {DamagePacket}
 */
export function buildAttackPacket(source, opts = {}) {
  const s = (source && source.stats) || {};
  const rngV = (source && source._hitRngNext) || Math.random;
  const baseMin = s.dmgMin || 0;
  const baseMax = s.dmgMax || 0;
  const roll = baseMin + (baseMax - baseMin) * Math.random();
  const wRoll = Math.max(0, roll);
  const extraRoll = (min, max) => (max > 0 || min > 0 ? (min || 0) + Math.max(0, (max || 0) - (min || 0)) * Math.random() : 0);
  const pct = typeof opts.dmgPct === 'number' ? opts.dmgPct : 1;
  const flat = typeof opts.flatMult === 'number' ? opts.flatMult : 1;
  const k = pct * flat;
  const conv = clamp(opts.convertFirePct || 0, 0, 1);

  const physRaw = (wRoll * (1 - conv) + extraRoll(s.physAddedMin, s.physAddedMax)) * (1 + (s.physDamageMult || 0));
  const fireRaw = (wRoll * conv + extraRoll(s.addedFireMin, s.addedFireMax)) * (1 + (s.fireDamageMult || 0));
  const coldRaw = extraRoll(s.addedColdMin, s.addedColdMax) * (1 + (s.coldDamageMult || 0));
  const lightRaw = extraRoll(s.addedLightningMin, s.addedLightningMax) * (1 + (s.lightningDamageMult || 0));
  const dmgMult = (1 + (s.damageMult || 0)) * k;

  return {
    phys: physRaw,
    fire: fireRaw,
    cold: coldRaw,
    lightning: lightRaw,
    chaos: 0,
    damageMult: dmgMult,
    canCrit: opts.canCrit !== false,
    area: !!opts.area,
    aoeMult: opts.aoeMult || 0,
    knockback: opts.knockback || 0,
    sourceSkill: opts.sourceSkill,
    tags: opts.tags || ['attack'],
  };
}

/**
 * 击杀实体。
 * - 玩家死亡：推 'playerDeath'，设置 world.over（若 world 存在），world.busy 不变。
 * - 怪物死亡：推 'monsterKilled'；若最后一名击杀者是玩家 → 推 'kill' 并记 stats.kills、给经验、掉落。
 * - 召唤物死亡：推 'summonKilled'。
 *
 * 【参数顺序】`killEntity(world, 被杀者, 凶手)`。战斗/npc 代码看到的都是
 * `killEntity(world, target, source)`，与 dealDamage(world, source, target) 的顺序**相反**。
 *
 * 这个顺序极易写反（写反时"玩家"变成被杀者：玩家直接 dead、怪物不掉落，且不报任何错）。
 * 因此这里做了兼容兜底：如果 active 参数 `entity` 其实就是 world.player、而 killer 是别的实体，
 * 自动对调并继续 —— 反正"玩家击杀了自己"没有任何合法业务语义，对调只会让写反的调用变正确。
 *
 * @param {Object} world @param {Object} entity 被击杀的实体 @param {Object|null} killer 凶手（可为 null = 环境伤害）
 * @returns {void}
 */
export function killEntity(world, entity, killer) {
  // ---- 参数顺序兜底（见上方注释）----
  const wPlayer = world && world.player;
  if (entity && wPlayer && entity === wPlayer && killer && killer !== wPlayer && !killer.dead) {
    const swapped = entity;
    entity = killer;
    killer = swapped;
  }
  if (!entity || entity.dead) return;
  entity.dead = true;
  entity.hp = 0;
  entity.vx = 0;
  entity.vz = 0;
  entity.flash = 1;
  entity.hitFlash = 1;
  if (entity.anim) { entity.anim.state = 'dead'; entity.anim.t = 1.2; entity.anim.dur = 1.2; }
  if (entity.ai) { entity.ai.state = 'dead'; entity.ai.t = 0; }
  const player = world && world.player;
  const byPlayer = !!killer && killer === player;

  // [回归修复] 注意：`killer === world.player` 只能说明"是谁杀的"，**不能**说明"被杀的是玩家"！
  // 玩家击杀怪物时 killer 恰好就是 world.player；如果拿 byPlayer 去分支，会把怪物当成玩家死亡
  // 处理（推 playerDeath、跳过掉落）。这里只看实体本身。
  if (entity.kind === 'player') {
    entity.dead = true;
    entity.alive = false;
    entity.hp = 0;
    pushWorldEvent(world, 'playerDeath', { x: entity.x, z: entity.z, entity });
    return;
  }

  if (entity.kind === 'summon') {
    pushWorldEvent(world, 'summonKilled', { x: entity.x, z: entity.z, entity });
    return;
  }

  // ---- 怪物 ----
  const isMonster = entity.kind === 'monster' || entity.team === 1;
  if (!isMonster) return;
  const wstats = world && world.stats ? world.stats : null;
  if (wstats) {
    wstats.kills = (wstats.kills || 0) + 1;
    if (entity.elite || entity.rarity === 'rare') wstats.elitesKilled = (wstats.elitesKilled || 0) + 1;
    if (entity.rarity === 'boss') {
      wstats.bossKilled = (wstats.bossKilled || 0) + 1;
      wstats.bossAlive = false;
    }
  }
  // 经验（只有玩家在场上才给）
  if (byPlayer || (killer && killer.kind === 'summon')) {
    // 延迟导入避免循环依赖：progression 依赖 combat 的事件推送，这里用世界上的句柄
    const grant = world && world.__grantXp;
    if (grant && player) grant(world, player, entity.xp || 0);
    else if (player) player.pendingXp = (player.pendingXp || 0) + (entity.xp || 0);
  }
  pushWorldEvent(world, 'kill', { x: entity.x, z: entity.z, entity, byPlayer });
  pushWorldEvent(world, 'monsterKilled', {
    x: entity.x, z: entity.z, entity, monster: entity,
    name: entity.name, rarity: entity.rarity, elite: !!entity.elite, byPlayer,
    height: entity.height || 1.6, xp: entity.xp || 0, level: entity.level,
  });
  if (entity.rarity === 'boss') {
    pushWorldEvent(world, 'bossKilled', { x: entity.x, z: entity.z, entity, name: entity.name });
  }
  // 掉落：
  //   __coreRollLoot 是核心自己的掉落实现（一定有）；
  //   __rollLoot 可能被 Lead 覆盖成"只做统计"的版本，那种情况下两者不是同一个函数，
  //   仍然两者都调用，保证掉落与统计都生效。
  if (world) {
    const core = typeof world.__coreRollLoot === 'function' ? world.__coreRollLoot : null;
    const ext = typeof world.__rollLoot === 'function' && world.__rollLoot !== core ? world.__rollLoot : null;
    try {
      if (core) core(world, entity);
      if (ext) ext(world, entity);
      if (!core && !ext) {
        // 两个钩子都没有（极少见）：至少推一个事件，保证渲染层有反馈
        pushWorldEvent(world, 'loot', { x: entity.x, z: entity.z, monster: entity, skipped: true });
      }
    } catch (err) {
      // 掉落失败不能影响主循环
      if (typeof console !== 'undefined' && console.warn) console.warn('[core] 掉落失败：', err && err.message);
    }
  }
}

/**
 * 治疗实体。
 * @param {Object} world @param {Object} entity @param {number} amount
 * @param {'spell'|'leech'|'loh'|'regen'|'orb'} [kind]
 * @returns {number} 实际治疗量
 */
export function healEntity(world, entity, amount, kind = 'spell') {
  if (!entity || entity.dead || !(amount > 0)) return 0;
  const before = entity.hp;
  entity.hp = Math.min(entity.maxHp, entity.hp + amount);
  const healed = entity.hp - before;
  if (healed > 0 && kind !== 'leech' && kind !== 'regen') {
    pushWorldEvent(world, 'heal', { x: entity.x, z: entity.z, amount: Math.round(healed), target: entity, kind });
  } else if (healed > 0 && kind === 'leech') {
    // 吸血不刷屏，由 hit 事件组合表现
    entity.lastLeech = healed;
  }
  return healed;
}

/**
 * 施加/刷新 buff。
 * buff 结构：
 * {
 *   id: string,            // 唯一键，同 id 会替换（刷新时长）
 *   name: string,          // 中文名（UI）
 *   text?: string,         // 描述
 *   type: 'buff'|'debuff',
 *   dur: number,           // 总时长（秒）
 *   remaining?: number,    // 剩余（不传 = dur）
 *   stats?: Partial<StatBlock>, // 属性修正（recalcStats 会汇总）
 *   icon?: string,
 *   stack?: number,        // 当前层数
 *   stackMode?: 'refresh'|'stack'|'ignore',  // 同名 buff 的叠加语义，见下
 *   maxStacks?: number,    // stackMode==='stack' 时的层数上限（默认 99）
 *   onApply?(world, e, buff), onTick?(world, e, buff, dt), onExpire?(world, e, buff)
 * }
 *
 * 【stackMode（契约 §3.7）】同名 buff（id 相同）再次施加时：
 *   - 'refresh'（默认，与旧行为完全一致）：整体替换成新的 buff，时长回到满。
 *     「踏地战甲」用这个：踩到 3 个人再踩 1 个人，护甲按最新一次算，**不叠层**。
 *   - 'stack'：保留原对象，层数 +1（封顶 maxStacks），remaining 取两者更大值；
 *     新 buff 的 stats 按层数线性放大（因为属性层只能读到一份 stats）。
 *   - 'ignore'：已有同名 buff 时什么都不做（返回已有的那个）。
 *
 * 说明：带 stats 的 buff 会触发 recalcStats（属性变化），无 stats 的 buff 不重算，节省开销。
 *
 * @param {Object} world @param {Object} entity @param {Object} buff
 * @returns {Object} 实际挂在 entity 上的 buff 对象（副本）
 */
export function applyBuff(world, entity, buff) {
  if (!entity || !buff || !buff.id) return null;
  if (entity.dead) return null;
  if (!Array.isArray(entity.buffs)) entity.buffs = [];
  const b = { ...buff };
  if (typeof b.dur !== 'number' || b.dur <= 0) b.dur = 1;
  b.remaining = typeof b.remaining === 'number' ? b.remaining : b.dur;
  if (!b.type) b.type = 'buff';
  const mode = b.stackMode === 'stack' || b.stackMode === 'ignore' ? b.stackMode : 'refresh';
  const idx = entity.buffs.findIndex((x) => x.id === b.id);
  for (const [k, v] of Object.entries(b.stats || {})) {
    // 属性层直接写进 stats（aggregate 会重新收集）
    if (typeof v === 'number') b.stats[k] = v;
  }
  if (idx >= 0 && mode !== 'refresh') {
    const cur = entity.buffs[idx];
    // 1) 不叠层：保持原样
    if (mode === 'ignore' || !cur) return cur || b;
    // 2) 叠层：层数 +1，时长取更长者
    const cap = Number.isFinite(b.maxStacks) && b.maxStacks > 0 ? b.maxStacks : 99;
    const stacks = Math.min(cap, Math.max(1, Math.floor(cur.stack || 1)) + 1);
    cur.stack = stacks;
    cur.remaining = Math.max(cur.remaining || 0, b.remaining);
    cur.dur = Math.max(cur.dur || 0, b.dur);
    if (b.stats && cur.stats) {
      // 把"单层数值 × N"重新写回（属性层只认一份 stats，所以按层数放大）
      for (const k in cur.stats) {
        if (typeof cur.stats[k] === 'number') cur.stats[k] = (b.stats[k] || 0) * stacks;
      }
    }
    if (world && world.__recalc && cur.stats) world.__recalc(world, entity);
    else if (entity.kind === 'player' && cur.stats) entity.needsRecalc = true;
    pushWorldEvent(world, 'buff', { x: entity.x, z: entity.z, entity, buff: cur, name: cur.name, stack: stacks });
    return cur;
  }
  // 默认 / refresh：整体替换，时长回满（旧 buff 对象直接丢弃 —— 这也是"刷新不叠层"的实现）
  if (idx >= 0) entity.buffs[idx] = b;
  else entity.buffs.push(b);
  if (b.onApply) b.onApply(world, entity, b);
  if (b.stats) {
    const recalc = world && world.__recalc;
    if (recalc) recalc(world, entity);
    else if (entity.kind === 'player') entity.needsRecalc = true;
  }
  pushWorldEvent(world, 'buff', { x: entity.x, z: entity.z, entity, buff: b, name: b.name });
  return b;
}

/**
 * 控制强度是否还是有效的（避免 0.0001 秒的残留让怪"卡住一帧"日志也抖）。
 * @param {Object} e
 */
function isStunned(e) {
  return !!e && ((e.stunTime || 0) > 1e-4);
}

/**
 * 施加眩晕（契约 §3.6）。
 *
 * - `entity.stunTime = max(entity.stunTime || 0, dur)`：**不叠加时长，只延长到更长的那个**，
 *   这样连续践踏不会把 Boss 永久锁住（防无限连控），同时"再补一脚"仍能续控。
 * - Boss/精英有抗性：`dur *= 1 - clamp(entity.stunResist ?? 默认值, 0, 0.9)`。
 *   默认值按类型取：Boss 0.6（只剩 40% 时长）、elite 0.25、其余 0。
 *   **显式写过 stunResist（包括 0）就尊重调用方** —— 有些精英模板想给"完全免疫"，
 *   不能因为它是 elite 就强行套 0.25。
 * - 推 'stun' 事件（带 target.stunTime / stunMax 供渲染层画星星）。
 * - 被控期间不动/不攻击/不冲锋/不爆炸由 monsters.js 的 updateMonsterAI 保证。
 *
 * @param {Object} world @param {Object} entity @param {number} dur 秒
 * @param {string} [sourceSkill] 来源技能 id（渲染层配色 / 提示用）
 * @returns {boolean} 是否真的挂上了眩晕（0 时长 / 死亡 / 免疫 返回 false）
 */
export function applyStun(world, entity, dur, sourceSkill) {
  if (!entity || entity.dead) return false;
  const raw = Number(dur);
  if (!(raw > 0)) return false;
  let resist = entity.stunResist;
  if (typeof resist !== 'number' || !Number.isFinite(resist)) {
    resist = entity.isBoss || entity.rarity === 'boss' ? 0.6 : entity.elite || entity.rarity === 'rare' ? 0.25 : 0;
  }
  resist = clamp(resist, 0, 0.9);
  const finalDur = raw * (1 - resist);
  if (!(finalDur > 0)) return false;
  const was = isStunned(entity);
  entity.stunTime = Math.max(entity.stunTime || 0, finalDur);
  // stunMax：本次施法的**有效**时长，渲染层按 stunTime/stunMax 画"星星衰减"
  entity.stunMax = Math.max(finalDur, entity.stunTime);
  entity.stunSource = sourceSkill || entity.stunSource || null;
  entity.stunResistApplied = resist;
  // 被控时清掉正在蓄力的攻击/冲锋位移，避免眩晕结束后"补一发"（手感上更符合"被打断"）
  if (entity.ai) {
    entity.ai.windup = 0;
    // 只有"前摇"被打断；Boss 重击（slam）保留原逻辑，避免出现"重击前摇永久卡住"的边界情况
    if (entity.ai.state === 'attack' && !entity.ai.isSlam) entity.ai.state = 'chase';
  }
  entity.vx = 0;
  entity.vz = 0;
  pushWorldEvent(world, 'stun', {
    x: entity.x, z: entity.z,
    target: entity, targetId: entity.id,
    dur: finalDur, rawDur: raw, resist,
    sourceSkill: sourceSkill || null,
    stunTime: entity.stunTime, stunMax: entity.stunMax,
    boss: !!(entity.isBoss || entity.rarity === 'boss'),
    elite: !!entity.elite,
    restun: was,
  });
  return true;
}

/**
 * 每帧推进眩晕计时（由 updateCore 对玩家/怪物调用，或由 AI 内部调用）。
 * stunTime 归零时推 'stunEnd'，并清掉 stunMax（渲染层据此停止画星星）。
 * @param {Object} world @param {Object} entity @param {number} dt
 * @returns {boolean} 推进后是否仍在眩晕中
 */
export function updateStun(world, entity, dt) {
  if (!entity) return false;
  if (!((entity.stunTime || 0) > 0)) return false;
  entity.stunTime -= dt;
  if (entity.stunTime <= 1e-4) {
    const srcSkill = entity.stunSource || null;
    entity.stunTime = 0;
    entity.stunMax = 0;
    entity.stunSource = null;
    pushWorldEvent(world, 'stunEnd', {
      x: entity.x, z: entity.z,
      target: entity, targetId: entity.id,
      sourceSkill: srcSkill,
    });
    return false;
  }
  return true;
}

/** 实体当前是否处于眩晕中（渲染层 / AI / 测试共用） */
export function isStunnedEntity(entity) {
  return isStunned(entity);
}

/**
 * 移除 buff。
 * @param {Object} world @param {Object} entity @param {string} id
 * @returns {boolean} 是否移除了
 */
export function removeBuff(world, entity, id) {
  if (!entity || !Array.isArray(entity.buffs)) return false;
  const idx = entity.buffs.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  const b = entity.buffs[idx];
  entity.buffs.splice(idx, 1);
  if (b.onExpire) b.onExpire(world, entity, b);
  if (b.stats) {
    if (world && world.__recalc) world.__recalc(world, entity);
    else if (entity.kind === 'player') entity.needsRecalc = true;
  }
  pushWorldEvent(world, 'buffEnd', { x: entity.x, z: entity.z, entity, buff: b, name: b.name });
  return true;
}

/** 查询 buff */
export function hasBuff(entity, id) {
  return !!entity && Array.isArray(entity.buffs) && entity.buffs.some((b) => b.id === id);
}

/**
 * 更新 buff：倒计时、onTick、到期移除。由 index.updateCore 在每帧最先调用。
 * @param {Object} world @param {Object} entity @param {number} dt
 */
export function updateBuffs(world, entity, dt) {
  if (!entity || !Array.isArray(entity.buffs) || entity.buffs.length === 0) return;
  for (let i = entity.buffs.length - 1; i >= 0; i--) {
    const b = entity.buffs[i];
    if (!b) continue;
    b.remaining -= dt;
    if (typeof b.onTick === 'function') b.onTick(world, entity, b, dt);
    if (entity.dead) return;
    if (b.remaining <= 0) {
      entity.buffs.splice(i, 1);
      if (b.onExpire) b.onExpire(world, entity, b);
      if (b.stats) {
        if (world && world.__recalc) world.__recalc(world, entity);
        else if (entity.kind === 'player') entity.needsRecalc = true;
      }
      pushWorldEvent(world, 'buffEnd', { x: entity.x, z: entity.z, entity, buff: b, name: b.name });
    }
  }
}

/**
 * 取实体的碰撞半径（未显式设置时按玩家 0.45 / 怪物 0.5 兜底）。
 * @param {Object} e
 * @returns {number}
 */
export function radiusOf(e) {
  if (!e) return 0;
  if (typeof e.radius === 'number' && e.radius > 0) return e.radius;
  if (e.kind === 'player') return 0.45;
  if (e.template && typeof e.template.radius === 'number') return e.template.radius;
  return 0.5;
}

/**
 * 击退（平滑，给速度而不是瞬移；遵守 isWalkable）。
 * @param {Object} world @param {Object} entity @param {number} dirX @param {number} dirZ
 * @param {number} force 力度（单位：初速度 单位/秒）
 */
export function knockback(world, entity, dirX, dirZ, force) {
  if (!entity || entity.dead || !(force > 0)) return;
  if (entity.immuneKnockback) return;
  const d = normDir(dirX, dirZ);
  if (d.len === 0) return;
  // Boss 击退抗性
  const resist = entity.knockbackResist || 0;
  const f = force * (1 - clamp(resist, 0, 0.95));
  entity.kbTimer = 0.2;
  entity.kbVX = d.x * f;
  entity.kbVZ = d.z * f;
  // 立即施加一小段位移让手感更"脆"
  const step = Math.min(0.35, f * 0.05);
  const nx = entity.x + d.x * step;
  const nz = entity.z + d.z * step;
  if (!world || !world.isWalkable || world.isWalkable(nx, nz)) {
    entity.x = nx;
    entity.z = nz;
  }
  if (entity.ai) entity.ai.state = entity.ai.state === 'charge' ? entity.ai.state : 'recover';
}

/**
 * 把实体从一个点"平滑移动"，遵守 isWalkable（轴向分步，允许贴墙滑行）。
 * @param {Object} world @param {Object} entity @param {number} dx @param {number} dz
 * @returns {boolean} 是否移动成功
 */
export function moveEntity(world, entity, dx, dz) {
  if (!entity || entity.dead) return false;
  let moved = false;
  // [Lead 修复] 绕行：直线被墙挡住时，沿墙切向滑动（以前只做轴向滑行，正对墙时会完全卡死）
  const ok = (x, z) => !world || typeof world.isWalkable !== 'function' || world.isWalkable(x, z);
  const nx = entity.x + dx;
  const nz = entity.z + dz;
  if (ok(nx, nz)) { entity.x = nx; entity.z = nz; return true; }
  if (Math.abs(dx) > 1e-6 && ok(nx, entity.z)) { entity.x = nx; moved = true; }
  if (Math.abs(dz) > 1e-6 && ok(entity.x, nz)) { entity.z = nz; moved = true; }
  if (!moved && typeof world?.isWalkable === 'function') {
    // 沿墙切向（垂直方向）尝试滑行
    const len = Math.hypot(dx, dz) || 1;
    const tx = -dz / len, tz = dx / len;
    const sign = (entity.__wallSign || 1);
    for (const s of [sign, -sign]) {
      const sx = entity.x + tx * len * s;
      const sz = entity.z + tz * len * s;
      if (ok(sx, sz)) {
        entity.x = sx;
        entity.z = sz;
        entity.__wallSign = s;
        return true;
      }
    }
    // 两个切向都走不了 → 换一个 45° 偏移方向再试（贴凹角脱困）
    for (const s of [sign, -sign]) {
      const ax = (dx + tx * len * s) * 0.7071;
      const az = (dz + tz * len * s) * 0.7071;
      if (ok(entity.x + ax, entity.z + az)) {
        entity.x += ax;
        entity.z += az;
        return true;
      }
    }
  }
  return moved;
}