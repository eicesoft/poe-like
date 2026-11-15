// @file src/core/stats.js
// 属性系统：StatBlock 定义、属性层合并（aggregateStats）与最终属性重算（recalcStats）。
// 纯逻辑，不依赖任何 DOM / three。
//
// 【属性分层约定】
//   base layer    ← createBaseStats(level)（等级成长 + 默认值）
//   talent layer  ← entity.talentStats（天赋贡献，Lead 写入）
//   equip layer   ← entity.equipStats（装备贡献，Lead/inventory 写入）
//   buff layer    ← 由 collectBuffStats(entity) 从 entity.buffs 里汇总（每个 buff 可带 stats 字段）
//   怪物词缀层     ← 由 collectMonsterModStats(entity) 从 entity.mods 里汇总
//
// 所有层都是「扁平对象」，键必须是 STAT_KEYS 里的字段；未写出的键按 0 处理
// （除了那些「默认值不为 0」的字段，见 DEFAULTS）。

/**
 * @typedef {Object} StatBlock
 * @property {number} life            最大生命值
 * @property {number} lifeRegen       每秒生命回复
 * @property {number} mana            最大法力值
 * @property {number} manaRegen       每秒法力回复
 * @property {number} energyShield    能量护盾（先于生命承受伤害）
 * @property {number} armor           护甲（减物理伤害）
 * @property {number} evasion         闪避率 0..0.75
 * @property {number} blockChance     格挡率 0..0.75
 * @property {number} dmgMin          武器基础伤害下限
 * @property {number} dmgMax          武器基础伤害上限
 * @property {number} attackSpeedMult 攻速加成（0.1 = +10%）
 * @property {number} critChance      暴击率 0..1
 * @property {number} critMulti       暴击伤害倍率（默认 1.5）
 * @property {number} moveSpeedMult   移动速度加成（基础 6.2 单位/秒）
 * @property {number} physDamageMult  物理伤害加成
 * @property {number} physAddedMin    附加物理伤害下限
 * @property {number} physAddedMax    附加物理伤害上限
 * @property {number} fireDamageMult  火焰伤害加成
 * @property {number} coldDamageMult  冰霜伤害加成
 * @property {number} lightningDamageMult 闪电伤害加成
 * @property {number} chaosDamageMult 混沌伤害加成
 * @property {number} addedFireMin    附加火焰伤害下限
 * @property {number} addedFireMax    附加火焰伤害上限
 * @property {number} addedColdMin    附加冰霜伤害下限
 * @property {number} addedColdMax    附加冰霜伤害上限
 * @property {number} addedLightningMin 附加闪电伤害下限
 * @property {number} addedLightningMax 附加闪电伤害上限
 * @property {number} aoeMult           范围效果加成
 * @property {number} skillLevelBonus   技能等级加成
 * @property {number} lifeLeech         生命吸取（命中回复占伤害比例）
 * @property {number} lifeOnHit         击中回复生命
 * @property {number} cdrMult           冷却缩减 0..0.6
 * @property {number} areaDamageMult    范围伤害加成
 * @property {number} dotMult           持续伤害加成
 * @property {number} thorns            荆棘伤害（受击反弹）
 * @property {number} projectileSpeedMult 投射物速度加成
 * @property {number} damageMult        全局伤害加成（技能自带的 buff 用它，如战吼 +15%）
 * @property {number} damageTakenMult   承受伤害加成（怪物词缀「狂暴」用它）
 * @property {number} maxResistance     元素抗性上限
 * @property {number} fireResist        火焰抗性 0..maxResistance
 * @property {number} coldResist        冰霜抗性
 * @property {number} lightningResist   闪电抗性
 * @property {number} chaosResist       混沌抗性
 */

/** StatBlock 的全部字段名（顺序即 UI 显示顺序）。 */
export const STAT_KEYS = Object.freeze([
  'life', 'lifeRegen',
  'mana', 'manaRegen',
  'energyShield',
  'armor', 'evasion', 'blockChance',
  'dmgMin', 'dmgMax',
  'attackSpeedMult', 'critChance', 'critMulti', 'moveSpeedMult',
  'physDamageMult', 'physAddedMin', 'physAddedMax',
  'fireDamageMult', 'coldDamageMult', 'lightningDamageMult', 'chaosDamageMult',
  'addedFireMin', 'addedFireMax', 'addedColdMin', 'addedColdMax',
  'addedLightningMin', 'addedLightningMax',
  'aoeMult', 'skillLevelBonus',
  'lifeLeech', 'lifeOnHit', 'cdrMult', 'areaDamageMult', 'dotMult',
  'thorns', 'projectileSpeedMult',
  'damageMult', 'damageTakenMult',
  'maxResistance',
  'fireResist', 'coldResist', 'lightningResist', 'chaosResist',
]);

/**
 * 默认值（"额外加成"类字段默认 0；下面这些是有语义的默认值）。
 * 注意 `fireResist` 等抗性默认 0，`critMulti` 默认 1.5，`maxResistance` 默认 0.75，
 * 而怪物 / 玩家在 createBaseStats 里填写基础生命/法力。
 */
export const DEFAULTS = Object.freeze({
  life: 0, lifeRegen: 0, mana: 0, manaRegen: 0, energyShield: 0,
  armor: 0, evasion: 0, blockChance: 0,
  dmgMin: 0, dmgMax: 0,
  attackSpeedMult: 0, critChance: 0.05, critMulti: 1.5, moveSpeedMult: 0,
  physDamageMult: 0, physAddedMin: 0, physAddedMax: 0,
  fireDamageMult: 0, coldDamageMult: 0, lightningDamageMult: 0, chaosDamageMult: 0,
  addedFireMin: 0, addedFireMax: 0, addedColdMin: 0, addedColdMax: 0,
  addedLightningMin: 0, addedLightningMax: 0,
  aoeMult: 0, skillLevelBonus: 0,
  lifeLeech: 0, lifeOnHit: 0, cdrMult: 0, areaDamageMult: 0, dotMult: 0,
  thorns: 0, projectileSpeedMult: 0,
  damageMult: 0, damageTakenMult: 0,
  maxResistance: 0.75,
  fireResist: 0, coldResist: 0, lightningResist: 0, chaosResist: 0,
});

/** 各字段的 clamp 区间白名单。未列出的字段只做 min 0 保护（允许负的「降低」修正）。 */
const RANGES = Object.freeze({
  evasion: [0, 0.75],
  blockChance: [0, 0.75],
  critChance: [0, 1],
  critMulti: [1, 5],
  lifeLeech: [0, 0.25],
  cdrMult: [0, 0.6],
  maxResistance: [0, 0.9],
  aoeMult: [-0.9, 5],
  skillLevelBonus: [0, 40],
  // 抗性在 aggregate 里不 clamp 到 0，因为怪物可能带负抗（易伤）；上限在 recalc 时按 maxResistance 处理
});

/** @param {number} v @param {number} a @param {number} b */
export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** 允许为负的字段（"降低"类修饰）。其余字段聚合后 < 0 时归零。 */
const ALLOW_NEGATIVE = new Set([
  'moveSpeedMult', 'attackSpeedMult', 'aoeMult', 'areaDamageMult', 'dotMult',
  'fireResist', 'coldResist', 'lightningResist', 'chaosResist',
  'damageMult', 'damageTakenMult', 'skillLevelBonus',
]);

/** @param {Record<string, number>} o @param {string} k @param {number} v */
function addKey(o, k, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  o[k] = (o[k] || 0) + v;
}

/**
 * 合并多个属性层（线性相加）。
 * - 每一层可以是任意键值对对象；只有 STAT_KEYS 中存在的键会被读取（其他键忽略）。
 *   例外：也读取别名 `resFire/resCold/resLightning/resChaos`（装备数据常见写法）。
 * - null/undefined 层会被跳过。
 * - **默认值只生效一次**：所有层的对应值相加后，再与 DEFAULTS 取 max。
 *   （因此 {critChance:0.05} + {critChance:0.05} = 0.1，而不是 0.05+0.1）
 * - clamp 规则见 RANGES / ALLOW_NEGATIVE；结果里所有 STAT_KEYS 字段都会出现。
 *
 * @param {Array<Partial<StatBlock>|null|undefined>} layers
 * @param {Partial<StatBlock>} [baseDefaults] 覆盖默认值（如怪物基础暴击/暴伤）
 * @returns {StatBlock}
 */
export function aggregateStats(layers, baseDefaults) {
  const defaults = baseDefaults ? { ...DEFAULTS, ...baseDefaults } : DEFAULTS;
  /** @type {any} */
  const raw = {};
  for (const k of STAT_KEYS) raw[k] = 0;
  if (layers) {
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer || typeof layer !== 'object') continue;
      for (const k of STAT_KEYS) {
        const v = layer[k];
        if (typeof v === 'number') addKey(raw, k, v);
      }
      // 别名（装备成员可能写 resFire 等）
      const aliases = { resFire: 'fireResist', resCold: 'coldResist', resLightning: 'lightningResist', resChaos: 'chaosResist' };
      for (const a in aliases) {
        const v = layer[a];
        if (typeof v === 'number') addKey(raw, aliases[a], v);
      }
    }
  }
  /** @type {any} */
  const out = {};
  for (const k of STAT_KEYS) {
    let v = raw[k];
    if (!Number.isFinite(v)) v = 0;
    // 默认值只在"总量"上兜底一次（负默认值不参与兜底，否则会挡住"降低"类修饰）
    if (defaults[k] > 0 && v < defaults[k]) v = defaults[k];
    if (!ALLOW_NEGATIVE.has(k) && v < 0) v = 0;
    const range = RANGES[k];
    if (range) v = clamp(v, range[0], range[1]);
    out[k] = v;
  }
  // dmgMin 不能高于 dmgMax
  if (out.dmgMax < out.dmgMin) out.dmgMax = out.dmgMin;
  // 抗性上限由 maxResistance 决定（负抗允许）
  out.fireResist = Math.min(out.fireResist, out.maxResistance);
  out.coldResist = Math.min(out.coldResist, out.maxResistance);
  out.lightningResist = Math.min(out.lightningResist, out.maxResistance);
  // 混沌抗性单独上限（POE 里混沌抗上限更低），这里沿用 maxResistance 但不超过 0.75
  out.chaosResist = Math.min(out.chaosResist, Math.min(out.maxResistance, 0.75));
  return /** @type {StatBlock} */ (out);
}

/**
 * 生成某一等级的"裸属性"（玩家）。
 * 数值曲线：生命 = 120 + 18*(lv-1) + 二次项；法力 = 60 + 6*(lv-1)。
 * 初始裸武器伤害 12-22（createPlayer 会写入 baseStats，升级时轻微成长）。
 * @param {number} level
 * @returns {StatBlock}
 */
export function createBaseStats(level = 1) {
  const lv = Math.max(1, Math.floor(level));
  const n = lv - 1;
  return /** @type {StatBlock} */ (aggregateStats([{
    life: 120 + 18 * n + 2.0 * n * n,
    lifeRegen: 0.6 + 0.08 * n,
    mana: 60 + 6 * n,
    manaRegen: 4.5 + 0.35 * n,
    energyShield: 0,
    armor: 0,
    evasion: 0,
    blockChance: 0,
    dmgMin: 12,
    dmgMax: 22,
    attackSpeedMult: 0,
    critChance: 0.05,
    critMulti: 1.5,
    moveSpeedMult: 0,
  }]));
}

/** 怪物基础暴击 / 暴伤 */
export const MONSTER_CRIT = Object.freeze({ critChance: 0.05, critMulti: 1.5 });

/**
 * 生成怪物某一等级的基础属性（在模板的 hp/damage/speed 之上做等级缩放）。
 * 这里只产出 StatBlock，怪物模板相关的速度/攻速由 monsters.js 用于移动逻辑。
 * @param {number} level @param {{hp:number, damage:number, armor?:number, resists?:Object}} template
 * @param {Partial<StatBlock>} [baseDefaults] 覆盖默认值（怪物模板可带更高的暴击/暴伤）
 * @returns {StatBlock}
 */
export function createMonsterStats(level, template, baseDefaults) {
  const lv = Math.max(1, Math.floor(level));
  const hpScale = 1 + 0.55 * (lv - 1) + 0.045 * (lv - 1) * (lv - 1);
  // [Lead 平衡] 0.28 → 0.22：6 只小怪围殴 1 级玩家 3.6 秒即死，新手期太硬；降低成长斜率后 lv1 不变，lv10+ 温和很多
  const dmgScale = 1 + 0.22 * (lv - 1);
  const r = template.resists || {};
  const base = baseDefaults ? { ...DEFAULTS, ...baseDefaults } : DEFAULTS;
  const naturalCrit = clamp(base.critChance + (MONSTER_CRIT.critChance - DEFAULTS.critChance), 0, 1);
  return /** @type {StatBlock} */ (aggregateStats([{
    life: template.hp * hpScale,
    mana: 0,
    armor: template.armor || 0,
// [Lead 平衡] 数值区间收窄（0.8~1.2 → 0.85~1.15），降低单次伤害方差
    dmgMin: template.damage * 0.85 * dmgScale,
    dmgMax: template.damage * 1.15 * dmgScale,
    critChance: naturalCrit,
    critMulti: base.critMulti,
    fireResist: r.fire || 0,
    coldResist: r.cold || 0,
    lightningResist: r.lightning || 0,
    chaosResist: r.chaos || 0,
  }], base));
}

/**
 * 从实体身上提取基础默认值（暴击率/暴伤/抗性上限）。
 * entity.baseDefaults 可由 Lead / 内部写入，例如 { critChance: 0.05, critMulti: 1.5 }。
 * @param {Object} entity
 */
export function baseDefaultsOf(entity) {
  if (entity && entity.baseDefaults && typeof entity.baseDefaults === 'object') return entity.baseDefaults;
  return undefined;
}

/**
 * 从 entity.buffs 汇总属性修正层。
 * buff 结构见 combat.js applyBuff：{ stats?: Partial<StatBlock> }
 * 另外支持 buff.mods 是「加成百分比」的写法：{ more?: {attackSpeedMult:0.2} } 与 stats 合并处理
 * （这里只做线性相加，more 语义由调用方拆成 stats 数值后写入，保持简单）。
 * @param {Object} entity
 * @returns {Partial<StatBlock>|null}
 */
export function collectBuffStats(entity) {
  if (!entity || !Array.isArray(entity.buffs) || entity.buffs.length === 0) return null;
  /** @type {any} */
  const agg = {};
  let any = false;
  for (const b of entity.buffs) {
    if (!b || !b.stats) continue;
    for (const k of STAT_KEYS) {
      const v = b.stats[k];
      if (typeof v === 'number') { agg[k] = (agg[k] || 0) + v; any = true; }
    }
  }
  return any ? agg : null;
}

/**
 * 从怪物词缀汇总属性修正层（mods 里带 stats 字段）。
 * @param {Object} entity
 * @returns {Partial<StatBlock>|null}
 */
export function collectMonsterModStats(entity) {
  if (!entity || !Array.isArray(entity.mods) || entity.mods.length === 0) return null;
  /** @type {any} */
  const agg = {};
  let any = false;
  for (const m of entity.mods) {
    if (!m || !m.stats) continue;
    for (const k of STAT_KEYS) {
      const v = m.stats[k];
      if (typeof v === 'number') { agg[k] = (agg[k] || 0) + v; any = true; }
    }
  }
  return any ? agg : null;
}

/**
 * 重算实体最终属性并同步 maxHp / maxMp。
 *
 * - 玩家：aggregate(createBaseStats(level) ⊕ talentStats ⊕ equipStats ⊕ buff层)
 *   若 entity.baseStats 存在（Lead 的 recalc 写入的"裸属性"），则用它代替 createBaseStats(level)。
 * - 怪物：aggregate(createMonsterStats(level, template) ⊕ 词缀层 ⊕ buff层)；
 *   若 entity.baseStats 已存在则直接用它。
 * - 当前 hp / mp 按比例保留（比例法，换装时血量不会突变）。
 *   例外：entity.hp 为 0 或 dead 时保持 0；`opts.refill` 为 true 时回满。
 * - 升级时请用 progression.grantXp（它会调用本函数并额外按增长量加血 —— 见 opts.onLevel）。
 *
 * @param {Object} world 世界对象（可为 null，本函数不依赖 world，保留是为了接口一致）
 * @param {Object} entity 实体
 * @param {{refill?:boolean, keepRatioMode?:'ratio'|'gap'}} [opts]
 *   keepRatioMode: 'ratio'（默认，按比例）| 'gap'（保持当前缺失量不变 → 升级时效果等同于"加增长量")
 * @returns {StatBlock} 重算后的最终属性
 */
export function recalcStats(world, entity, opts = {}) {
  if (!entity || typeof entity !== 'object') return createBaseStats(1);
  const level = Math.max(1, Math.floor(entity.level || 1));
  /** @type {Array<any>} */
  const layers = [];

  if (entity.baseStats && typeof entity.baseStats === 'object') {
    layers.push(entity.baseStats);
  } else if (entity.kind === 'monster' || (entity.team === 1 && !entity.kind)) {
    layers.push(createMonsterStats(level, entity.template || { hp: 40, damage: 8 }));
  } else {
    layers.push(createBaseStats(level));
  }
  if (entity.talentStats) layers.push(entity.talentStats);
  if (entity.equipStats) layers.push(entity.equipStats);
  const modStats = collectMonsterModStats(entity);
  if (modStats) layers.push(modStats);
  const buffStats = collectBuffStats(entity);
  if (buffStats) layers.push(buffStats);

  const stats = aggregateStats(layers, baseDefaultsOf(entity));
  entity.stats = stats;

  const oldMaxHp = entity.maxHp || 0;
  const oldMaxMp = entity.maxMp || 0;
  const oldHp = typeof entity.hp === 'number' ? entity.hp : stats.life;
  const oldMp = typeof entity.mp === 'number' ? entity.mp : stats.mana;
  /** 首次重算（没有旧上限）：直接满血 */
  const neverInit = oldMaxHp <= 0;

  entity.maxHp = stats.life;
  entity.maxMp = stats.mana;
  entity.manaRegen = stats.manaRegen;
  entity.esRegen = Math.max(0.5, stats.energyShield * 0.1);

  if (opts.refill) {
    entity.hp = entity.maxHp;
    entity.mp = entity.maxMp;
  } else if (entity.dead) {
    entity.hp = 0;
  } else if (neverInit) {
    // 首次初始化（或曾被清零）：直接满血
    entity.hp = entity.maxHp;
  } else if (opts.keepRatioMode === 'gap') {
    // 升级用：maxHp 增长多少就给多少血（保持当前缺失量），若上限下降则按比例收敛
    if (entity.maxHp >= oldMaxHp) {
      entity.hp = clamp(oldHp + (entity.maxHp - oldMaxHp), 0, entity.maxHp);
    } else {
      const ratio = clamp(oldHp / oldMaxHp, 0, 1);
      entity.hp = clamp(entity.maxHp * ratio, 0, entity.maxHp);
    }
  } else {
    // 换装/加天赋：按比例保留当前生命
    const ratio = clamp(oldHp / oldMaxHp, 0, 1);
    entity.hp = clamp(entity.maxHp * ratio, 0, entity.maxHp);
  }
  entity.hp = Math.min(entity.hp, entity.maxHp);

  if (oldMaxMp > 0) {
    const ratio = clamp(oldMp / oldMaxMp, 0, 1);
    entity.mp = clamp(entity.maxMp * ratio, 0, entity.maxMp);
  } else {
    entity.mp = clamp(oldMp, 0, entity.maxMp);
  }
  entity.mp = Math.min(entity.mp, entity.maxMp);

  // 护盾：如果当前护盾超过新上限，截断（满护盾时顺带上调）
  if (typeof entity.energyShield === 'number') {
    const prevMax = entity._maxEs || 0;
    if (prevMax > 0 && entity.energyShield >= prevMax - 1e-6) entity.energyShield = stats.energyShield;
    entity.energyShield = Math.min(entity.energyShield, stats.energyShield);
  }
  entity._maxEs = stats.energyShield;
  return stats;
}

/**
 * 便捷：把「装备 + 天赋」重算成 baseStats 之外的最终属性（供 Lead 直接调用）。
 * 等价于 recalcStats。
 * @param {Object} world @param {Object} entity
 * @returns {StatBlock}
 */
export function refreshStats(world, entity) {
  return recalcStats(world, entity);
}