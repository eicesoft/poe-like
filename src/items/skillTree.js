// @file src/items/skillTree.js
// 技能树数据（每个玩家技能一棵「分叉树」）+ 效果汇总。
//
// 【硬约束】纯数据 / 纯函数，不 import 浏览器 API / three / DOM —— 必须能在 Node 下跑。
//
// ─── 分叉拓扑（v2，见 docs/skill-upgrade-contract.md §3.1 / §3.2）─────────────
//
//          ┌─ L1 ── L2 ── L3(支线小) ── L4(分支专精)
//  ROOT ───┤                              (L4 / R4 互斥)
//          └─ R1 ── R2 ── R3(支线小) ── R4(分支专精)
//                                    └─ U (终极，要求 ROOT 点满 + L1..L4 或 R1..R4 全点亮；不互斥)
//
//   · ROOT：每个技能的核心节点（maxRank 3），与技能机制强相关。
//   · L1/R1 同属互斥组 'fork'；L2/R2 → 'tier2'；L3/R3 → 'tier3'；L4/R4 → 'forkFinal'。
//     互斥 = 同组只能选一个节点加点，选了就锁死另一条路（可用技能精炼石「重置天赋」改派）。
//   · U 是终极节点：requires = ROOT + L1..L4 + R1..R4，但判定是 **「或」**——
//     ROOT 点满 且（左链完整 或 右链完整）即可点亮（见 requiresSatisfied）。
//     U 本身也要求加点（cost 2），所以两条支线走通后都能拿到同一个收束点。
//   · 为什么要按层互斥？如果只互斥「专精」，玩家可以两边各点 1 级吃满收益，分叉就形同虚设。
//     逐层互斥让「左支 / 右支」成为真正的流派选择。
//
// ─── 节点字段 ────────────────────────────────────────────────────────────────
//   N(...) 产出：
//   { id, key, skillId, name, desc, cost, maxRank, branch, group, effects, requires, tier, row }
//   branch : 'core' | 'left' | 'right' | 'leftDeep' | 'rightDeep' | 'ultimate'（UI 布局用）
//   group  : 互斥组名（'' = 不互斥）
//   tier   : 1..6（ROOT/L1/R1/L2/R2/L3/R3/L4/R4/U 的层级，UI 可用 row 做纵向排布）
//   row    : UI 建议的行号（0 = ROOT，1 = L1/R1 … 5 = U）
//
// ─── 效果类型（effects[].type）—— 汇总规则见 skillEffectsForSkill ─────────────
//   damageMult      累加到 damageMult（1 + 总和；1.3 = +30% 伤害）
//   radiusMult      累加到 radiusMult
//   cooldownMult    累加后取 0.4 ~ 1.6 区间（负值 = 冷却增加）
//   aoeMult / critChance / critMulti / projectileSpeedMult / areaDamageMult / attackSpeedMult / lifeLeech
//                   直接累加到 stats 的同名键（= additive，可被 core 的 aggregateStats 叠加）
//   count           整数累加（额外数量）+ flags[key] = true
//   extra + key     机制开关 flags[key] = true，并把 value·rank 记进 extras[key]
//                   开关类 extra 同时贡献 extra 计数；数值类 extra 记进 stats[key]
//   stunDurMult / armorPerEnemyMult / armorDurMult   乘法系数，进 multiplierBonuses
//   armorFlat / *_Flat                              固定值，累加进 flatBonuses 且**直接加到 stats 同名键**
//
// skillEffectsForSkill(skillId, ranks) 返回：
//   {
//     damageMult, radiusMult, cooldownMult, count, extra,
//     stats: { ... },                 // 扁平数值（additive），例如 attackSpeedMult: 0.24
//     flags: { ... },                 // 机制开关
//     multiplierBonuses: { stunDurMult: 1.3, armorPerEnemyMult: 1.5, ... },  // 默认 1
//     flatBonuses: { armorFlat: 40, ... },                                    // 默认 0
//     extras: { ... },                // extra 类效果的累计值
//     ranks, nodes, groups
//   }
//
// 向后兼容：旧的 type（damageMult/radiusMult/cooldownMult/count/extra/aoeMult…）语义完全不变；
// 已有的导出名（SKILL_TREES / SKILL_IDS / SKILL_NODES / SKILL_NODE_BY_ID / skillNodeById /
// skillTreeOf / skillEffectsForSkill / skillPointsSpent / canUpgradeSkillNode）签名不变。

/**
 * @typedef {Object} SkillEffect
 * @property {string} type
 * @property {number} value 每档数值
 * @property {string} [key] 当 type 为 'extra' / 'count' 时的语义键，或统计键
 */

/**
 * @typedef {Object} SkillNode
 * @property {string} id            `${skillId}.${key}`
 * @property {string} key
 * @property {string} skillId
 * @property {string} name
 * @property {string} desc
 * @property {number} cost 花费的技能点（每档）
 * @property {number} maxRank 最大档位
 * @property {'core'|'left'|'right'|'leftDeep'|'rightDeep'|'ultimate'} branch
 * @property {string} group 互斥组名（'' = 不互斥）
 * @property {SkillEffect[]} effects
 * @property {string[]} requires 前置节点 id（需已点亮）
 * @property {number} tier
 * @property {number} row UI 建议行号
 */

/**
 * @typedef {Object} SkillTree
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {string} desc
 * @property {'fork'} shape 布局提示（v2 全部是分叉树）
 * @property {{left:string, right:string, root:string, ultimate:string}} branches 分支命名（UI 标签用）
 * @property {SkillNode[]} nodes
 */

/** 互斥组：一旦在组内选了节点，同组其它节点全部锁定（见 skillNodeConflict）。 */
export const MUTEX_GROUPS = Object.freeze({
  FORK: 'fork',
  TIER2: 'tier2',
  TIER3: 'tier3',
  FORK_FINAL: 'forkFinal',
});

/**
 * extra.key 里「数值型」的键：累加到 stats 而不是当开关（沿用旧语义）。
 * 注意：这是模块级 const，必须定义在首次被使用（skillEffectsForSkill 执行）之前，
 * 否则会命中 TDZ（Cannot access before initialization）。
 */
const NUMBERISH_EXTRA = new Set([
  'attackSpeedMult', 'lifeLeech', 'critChance', 'critMulti', 'areaDamageMult', 'projectileSpeedMult',
]);

/** 分支名（UI 展示） */
export const BRANCH_LABELS = Object.freeze({
  core: '核心',
  left: '左支',
  right: '右支',
  leftDeep: '左支专精',
  rightDeep: '右支专精',
  ultimate: '终极',
});

/** 互斥组 → 中文名（UI tooltip 用） */
export const GROUP_LABELS = Object.freeze({
  fork: '流派',
  tier2: '第二层',
  tier3: '第三层',
  forkFinal: '分支专精',
});

/**
 * 定义技能树节点（内部）。
 *
 * @param {string} skillId
 * @param {Object} def
 * @param {string} def.key 节点短 id（最终 id = skillId + '.' + key）
 * @param {string} def.name
 * @param {string} def.desc
 * @param {number} [def.cost=1]
 * @param {number} [def.maxRank=1]
 * @param {string} [def.branch='core']
 * @param {string} [def.group=''] 互斥组
 * @param {SkillEffect[]} [def.effects]
 * @param {string[]} [def.requires] 前置短 id 数组（自动加 skillId 前缀）
 * @param {number} [def.tier=1]
 * @param {number} [def.row] 缺省按 tier 推
 * @returns {SkillNode}
 */
function N(skillId, def) {
  return {
    id: `${skillId}.${def.key}`,
    key: def.key,
    skillId,
    name: def.name,
    desc: def.desc,
    cost: def.cost == null ? 1 : def.cost,
    maxRank: def.maxRank == null ? 1 : def.maxRank,
    branch: def.branch || 'core',
    group: def.group || '',
    effects: (def.effects || []).map((e) => ({ ...e })),
    requires: (def.requires || []).map((x) => (x.includes('.') ? x : `${skillId}.${x}`)),
    tier: def.tier || 1,
    row: def.row == null ? (def.tier || 1) - 1 : def.row,
  };
}

/**
 * 按「分叉模板」批量生成一棵树。
 *
 * 每个技能只有 5 个锚点节点（root / l1 / l2 / l3 / l4 / r1 / r2 / r3 / r4 / u 共 10 个），
 * 但左右支与终极的行文差别很大，所以这里只做「接线」，文案与数值由调用方传入。
 *
 * @param {string} skillId
 * @param {Object} spec
 * @param {Object} spec.root   ROOT（maxRank 3）
 * @param {Object[]} spec.left  [L1, L2, L3, L4]
 * @param {Object[]} spec.right [R1, R2, R3, R4]
 * @param {Object} spec.ultimate U
 * @returns {SkillNode[]}
 */
function buildForkTree(skillId, spec) {
  const [l1, l2, l3, l4] = spec.left;
  const [r1, r2, r3, r4] = spec.right;
  // 接线规则固定（契约 §3.2）：ROOT → L1/R1 → L2/R2 → L3/R3 → L4/R4 → U
  const nodes = [
    N(skillId, { ...spec.root, key: 'root', branch: 'core', group: '', tier: 1, row: 0 }),
    N(skillId, { ...l1, key: 'l1', branch: 'left', group: MUTEX_GROUPS.FORK, requires: ['root'], tier: 2, row: 1 }),
    N(skillId, { ...r1, key: 'r1', branch: 'right', group: MUTEX_GROUPS.FORK, requires: ['root'], tier: 2, row: 1 }),
    N(skillId, { ...l2, key: 'l2', branch: 'left', group: MUTEX_GROUPS.TIER2, requires: ['l1'], tier: 3, row: 2 }),
    N(skillId, { ...r2, key: 'r2', branch: 'right', group: MUTEX_GROUPS.TIER2, requires: ['r1'], tier: 3, row: 2 }),
    N(skillId, { ...l3, key: 'l3', branch: 'leftDeep', group: MUTEX_GROUPS.TIER3, requires: ['l2'], tier: 4, row: 3 }),
    N(skillId, { ...r3, key: 'r3', branch: 'rightDeep', group: MUTEX_GROUPS.TIER3, requires: ['r2'], tier: 4, row: 3 }),
    N(skillId, { ...l4, key: 'l4', branch: 'leftDeep', group: MUTEX_GROUPS.FORK_FINAL, requires: ['l3'], tier: 5, row: 4 }),
    N(skillId, { ...r4, key: 'r4', branch: 'rightDeep', group: MUTEX_GROUPS.FORK_FINAL, requires: ['r3'], tier: 5, row: 4 }),
    // 终极：只认「走通的那条支线」+ ROOT 点满；两条支线都能到，所以它不属于任何互斥组。
    N(skillId, {
      ...spec.ultimate,
      key: 'u',
      branch: 'ultimate',
      group: '',
      requires: ['l1', 'l2', 'l3', 'l4', 'r1', 'r2', 'r3', 'r4', 'root'],
      tier: 6,
      row: 5,
    }),
  ];
  return nodes;
}

/**
 * 全部技能树。键必须与 core 的技能 id 一致：
 *   stomp 战争践踏、whirlwind 旋风斩、warcry 战吼、bloodRage 血性狂暴、rally 坚毅图腾
 * @type {Record<string, SkillTree>}
 */
export const SKILL_TREES = {
  // ═══════════════════════════ 战争践踏 stomp ═══════════════════════════
  // 左支「震怒」：伤害 / 范围 / 余震，把践踏当爆发；右支「壁垒」：护甲 / 眩晕 / 免控，把践踏当防御。
  stomp: {
    id: 'stomp',
    name: '战争践踏',
    icon: '💥',
    desc: '砸地眩晕范围内敌人，并按命中人数获得持续护甲。',
    shape: 'fork',
    branches: { left: '震怒', right: '壁垒', root: '踏地', ultimate: '崩山' },
    nodes: buildForkTree('stomp', {
      root: {
        name: '踏地', desc: '每档：伤害 +10%、眩晕时长 +8%。', maxRank: 3,
        // 第 1 档给机制开关（冲击环），第 2/3 档只是数值成长 —— 让 ROOT 点满有「解锁感」。
        effects: [
          { type: 'damageMult', value: 0.1 },
          { type: 'stunDurMult', value: 0.08 },
          { type: 'extra', value: 1, key: 'shockwave', minRank: 1 },
        ],
      },
      left: [
        { name: '震怒', desc: '伤害 +18%。', effects: [{ type: 'damageMult', value: 0.18 }] },
        { name: '巨震', desc: '半径 +12%，伤害 +8%。', maxRank: 2, effects: [{ type: 'radiusMult', value: 0.12 }, { type: 'damageMult', value: 0.08 }] },
        { name: '余震', desc: '踏地带出第二圈余震，对边缘敌人再造成一次伤害。', effects: [{ type: 'extra', value: 1, key: 'aftershock' }, { type: 'damageMult', value: 0.1 }] },
        { name: '崩地·怒', desc: '专精（互斥）：伤害 +30%，余震伤害翻倍。', cost: 2, effects: [{ type: 'damageMult', value: 0.3 }, { type: 'extra', value: 1, key: 'focusLeft' }, { type: 'extra', value: 1, key: 'aftershockPower' }] },
      ],
      right: [
        { name: '壁垒', desc: '每名敌人提供的护甲 +20%，踏地护甲持续 +15%。', effects: [{ type: 'armorPerEnemyMult', value: 0.2 }, { type: 'armorDurMult', value: 0.15 }] },
        { name: '坚甲', desc: '踏地额外提供 20 点固定护甲。', maxRank: 2, effects: [{ type: 'armorFlat', value: 20 }] },
        { name: '震摄', desc: '眩晕时长 +15%；被眩晕的敌人再受践踏时额外破甲。', effects: [{ type: 'stunDurMult', value: 0.15 }, { type: 'extra', value: 1, key: 'armorOnHit' }] },
        { name: '崩地·壁', desc: '专精（互斥）：护甲随敌人数量再 +35%，眩晕时长 +10%，获得免控。', cost: 2, effects: [{ type: 'armorPerEnemyMult', value: 0.35 }, { type: 'stunDurMult', value: 0.1 }, { type: 'extra', value: 1, key: 'focusRight' }] },
      ],
      ultimate: {
        name: '崩山', desc: '终极：践踏范围 +35%，伤害 +25%，眩晕时长 +20%，并反射眩晕给攻击者。', cost: 2,
        effects: [
          { type: 'radiusMult', value: 0.35 },
          { type: 'damageMult', value: 0.25 },
          { type: 'stunDurMult', value: 0.2 },
          { type: 'extra', value: 1, key: 'earthSplit' },
        ],
      },
    }),
  },

  // ═══════════════════════════ 旋风斩 whirlwind ═══════════════════════════
  // 左支「疾刃」：攻速 / 冷却 / 流血；右支「风暴」：范围 / 吸怪 / 位移。
  whirlwind: {
    id: 'whirlwind',
    name: '旋风斩',
    icon: '🌀',
    desc: '按住持续旋转，对周围敌人造成连续多段伤害。',
    shape: 'fork',
    branches: { left: '疾刃', right: '风暴', root: '旋转', ultimate: '刀刃风暴' },
    nodes: buildForkTree('whirlwind', {
      root: {
        name: '旋转', desc: '每档：伤害 +10%，旋转更快（冷却 -4%）。', maxRank: 3,
        effects: [
          { type: 'damageMult', value: 0.1 },
          { type: 'cooldownMult', value: -0.04 },
        ],
      },
      left: [
        { name: '疾刃', desc: '伤害 +15%，冷却 -6%。', effects: [{ type: 'damageMult', value: 0.15 }, { type: 'cooldownMult', value: -0.06 }] },
        { name: '血刃', desc: '每档命中附带流血。', maxRank: 2, effects: [{ type: 'extra', value: 1, key: 'bleed' }, { type: 'damageMult', value: 0.06 }] },
        { name: '疾风', desc: '旋转更密：伤害 +10%，移速惩罚减少。', effects: [{ type: 'damageMult', value: 0.1 }, { type: 'extra', value: 1, key: 'mobile' }] },
        { name: '疾刃·极', desc: '专精（互斥）：伤害 +25%，流血强度 +50%。', cost: 2, effects: [{ type: 'damageMult', value: 0.25 }, { type: 'extra', value: 1, key: 'focusLeft' }, { type: 'extra', value: 0.5, key: 'bleedPower' }] },
      ],
      right: [
        { name: '风暴', desc: '半径 +20%。', effects: [{ type: 'radiusMult', value: 0.2 }] },
        { name: '涡流', desc: '把敌人拉向中心，半径 +10%。', effects: [{ type: 'extra', value: 1, key: 'vortex' }, { type: 'radiusMult', value: 0.1 }] },
        { name: '狂风', desc: '每档：范围伤害 +8%、命中回复 1% 生命。', maxRank: 2, effects: [{ type: 'aoeMult', value: 0.08 }, { type: 'extra', value: 0.01, key: 'lifeLeech' }] },
        { name: '风暴·眼', desc: '专精（互斥）：半径 +25%，吸附更强，每命中一名敌人回复生命。', cost: 2, effects: [{ type: 'radiusMult', value: 0.25 }, { type: 'extra', value: 1, key: 'focusRight' }, { type: 'extra', value: 1, key: 'lifeOnHit' }, { type: 'extra', value: 1, key: 'vortexPull' }] },
      ],
      ultimate: {
        name: '刀刃风暴', desc: '终极：半径 +30%，伤害 +20%，每秒自动释放一段额外斩击。', cost: 2,
        effects: [
          { type: 'radiusMult', value: 0.3 },
          { type: 'damageMult', value: 0.2 },
          { type: 'extra', value: 1, key: 'bladeStorm' },
        ],
      },
    }),
  },

  // ═══════════════════════════ 战吼 warcry ═══════════════════════════
  // 左支「怒吼」：伤害 / 恐吓 / 范围；右支「号令」：治疗 / 护甲 / 团队增益。
  warcry: {
    id: 'warcry',
    name: '战吼',
    icon: '📢',
    desc: '发出战吼，提升自身伤害并震慑、恐吓周围敌人。',
    shape: 'fork',
    branches: { left: '怒吼', right: '号令', root: '吼声', ultimate: '不屈威严' },
    nodes: buildForkTree('warcry', {
      root: {
        name: '吼声', desc: '每档：伤害 +8%，战吼增益时长 +0.4 秒。', maxRank: 3,
        effects: [
          { type: 'damageMult', value: 0.08 },
          { type: 'extra', value: 0.4, key: 'buffDur' },
        ],
      },
      left: [
        { name: '怒吼', desc: '伤害 +15%，半径 +15%。', effects: [{ type: 'damageMult', value: 0.15 }, { type: 'radiusMult', value: 0.15 }] },
        { name: '惊吓', desc: '让敌人短暂逃窜，减速更强。', effects: [{ type: 'extra', value: 1, key: 'fear' }, { type: 'extra', value: 0.1, key: 'slowPower' }] },
        { name: '震慑', desc: '被战吼命中的敌人受到眩晕。', effects: [{ type: 'extra', value: 1, key: 'stun' }, { type: 'stunDurMult', value: 0.2 }] },
        { name: '怒吼之巅', desc: '专精（互斥）：伤害 +30%，恐吓时长翻倍。', cost: 2, effects: [{ type: 'damageMult', value: 0.3 }, { type: 'extra', value: 1, key: 'focusLeft' }, { type: 'extra', value: 1, key: 'fearPower' }] },
      ],
      right: [
        { name: '号令', desc: '战吼立即回复 4% 最大生命，护甲 +10%。', effects: [{ type: 'extra', value: 0.04, key: 'healPct' }, { type: 'extra', value: 0.1, key: 'warcryArmor' }] },
        { name: '鼓舞', desc: '每档：战吼增益强度 +10%，护甲额外 +5%。', maxRank: 2, effects: [{ type: 'extra', value: 0.1, key: 'buffPower' }, { type: 'extra', value: 0.05, key: 'warcryArmor' }] },
        { name: '铁壁', desc: '固定护甲 +25，战吼护甲时长 +30%。', effects: [{ type: 'armorFlat', value: 25 }, { type: 'armorDurMult', value: 0.3 }] },
        { name: '号令·誓', desc: '专精（互斥）：治疗量翻倍，护甲 +25%，被战吼命中的敌人被眩晕。', cost: 2, effects: [{ type: 'extra', value: 1, key: 'focusRight' }, { type: 'extra', value: 0.04, key: 'healPct' }, { type: 'extra', value: 0.25, key: 'warcryArmor' }, { type: 'extra', value: 1, key: 'stun' }] },
      ],
      ultimate: {
        name: '不屈威严', desc: '终极：战吼半径 +30%，治疗 +4%，伤害 +20%，击杀时刷新战吼冷却。', cost: 2,
        effects: [
          { type: 'radiusMult', value: 0.3 },
          { type: 'extra', value: 0.04, key: 'healPct' },
          { type: 'damageMult', value: 0.2 },
          { type: 'extra', value: 1, key: 'cdOnKill' },
        ],
      },
    }),
  },

  // ═══════════════════════════ 血性狂暴 bloodRage ═══════════════════════════
  // 左支「沸腾」：爆发（攻速 / 暴击 / 伤害）；右支「汲取」：吸血 / 减伤 / 持续时间。
  bloodRage: {
    id: 'bloodRage',
    name: '血性狂暴',
    icon: '🩸',
    desc: '燃烧生命换取狂暴：提升攻速、暴击与伤害。',
    shape: 'fork',
    branches: { left: '沸腾', right: '汲取', root: '狂暴', ultimate: '浴血狂潮' },
    nodes: buildForkTree('bloodRage', {
      root: {
        name: '狂暴', desc: '每档：攻速 +8%，持续时间 +12%。', maxRank: 3,
        effects: [
          { type: 'extra', value: 0.08, key: 'attackSpeedMult' },
          { type: 'extra', value: 0.12, key: 'duration' },
        ],
      },
      left: [
        { name: '沸腾', desc: '每档攻速 +8%。', maxRank: 2, effects: [{ type: 'extra', value: 0.08, key: 'attackSpeedMult' }] },
        { name: '野蛮', desc: '暴击率 +6%，伤害 +10%。', maxRank: 2, effects: [{ type: 'critChance', value: 0.06 }, { type: 'damageMult', value: 0.1 }] },
        { name: '狂乱', desc: '暴击伤害 +20%。', effects: [{ type: 'critMulti', value: 0.2 }, { type: 'damageMult', value: 0.08 }] },
        { name: '沸腾之巅', desc: '专精（互斥）：伤害 +25%，攻速 +10%。', cost: 2, effects: [{ type: 'damageMult', value: 0.25 }, { type: 'extra', value: 0.1, key: 'attackSpeedMult' }, { type: 'extra', value: 1, key: 'focusLeft' }] },
      ],
      right: [
        { name: '汲取', desc: '狂暴期间获得生命偷取。', effects: [{ type: 'extra', value: 0.02, key: 'lifeLeech' }] },
        { name: '不屈', desc: '承受伤害 -10%，持续时间 +25%。', effects: [{ type: 'extra', value: 1, key: 'endure' }, { type: 'extra', value: 0.25, key: 'duration' }] },
        { name: '血偿', desc: '每档：生命偷取 +1%，击杀回复生命。', maxRank: 2, effects: [{ type: 'extra', value: 0.01, key: 'lifeLeech' }, { type: 'extra', value: 1, key: 'healOnKill' }] },
        { name: '汲取·恒', desc: '专精（互斥）：生命流失减半，减伤 +10%，生命偷取 +3%。', cost: 2, effects: [{ type: 'extra', value: 1, key: 'focusRight' }, { type: 'extra', value: 1, key: 'lessDrain' }, { type: 'extra', value: 1, key: 'endure' }, { type: 'extra', value: 0.03, key: 'lifeLeech' }] },
      ],
      ultimate: {
        name: '浴血狂潮', desc: '终极：攻速 +15%，伤害 +20%，狂暴期间击杀延长狂暴。', cost: 2,
        effects: [
          { type: 'extra', value: 0.15, key: 'attackSpeedMult' },
          { type: 'damageMult', value: 0.2 },
          { type: 'extra', value: 1, key: 'extendOnKill' },
        ],
      },
    }),
  },

  // ═══════════════════════════ 坚毅图腾 rally ═══════════════════════════
  // 左支「尖柱」：图腾增伤 / 陷阱；右支「圣域」：群体护甲 / 回蓝。
  rally: {
    id: 'rally',
    name: '坚毅图腾',
    icon: '🗿',
    desc: '召唤图腾，为周围友军提供护甲与生命/法力回复。',
    shape: 'fork',
    branches: { left: '尖柱', right: '圣域', root: '图腾', ultimate: '祖灵庇护' },
    nodes: buildForkTree('rally', {
      root: {
        name: '图腾', desc: '每档：图腾持续时间 +15%，作用半径 +5%。', maxRank: 3,
        effects: [
          { type: 'extra', value: 1, key: 'duration' },
          { type: 'radiusMult', value: 0.05 },
        ],
      },
      left: [
        { name: '尖柱', desc: '图腾附近敌人受到伤害。', effects: [{ type: 'damageMult', value: 0.15 }, { type: 'extra', value: 1, key: 'totemDamage' }] },
        { name: '穿刺', desc: '每档：伤害 +12%，图腾命中附带眩晕。', maxRank: 2, effects: [{ type: 'damageMult', value: 0.12 }, { type: 'extra', value: 1, key: 'totemStun' }] },
        { name: '共鸣', desc: '图腾半径内自身伤害 +15%。', effects: [{ type: 'damageMult', value: 0.15 }, { type: 'radiusMult', value: 0.1 }] },
        { name: '尖柱之誓', desc: '专精（互斥）：伤害 +30%，图腾攻击频率提升。', cost: 2, effects: [{ type: 'damageMult', value: 0.3 }, { type: 'extra', value: 1, key: 'focusLeft' }, { type: 'extra', value: 1, key: 'totemFrenzy' }] },
      ],
      right: [
        { name: '圣域', desc: '半径 +20%，每档群体护甲 +10%。', maxRank: 2, effects: [{ type: 'radiusMult', value: 0.2 }, { type: 'extra', value: 0.1, key: 'teamArmor' }] },
        { name: '回响', desc: '图腾额外回复法力。', effects: [{ type: 'extra', value: 0.01, key: 'mpPct' }, { type: 'extra', value: 1, key: 'manaRegen' }] },
        { name: '双生', desc: '同时放置 2 个图腾，冷却 -15%。', effects: [{ type: 'count', value: 1 }, { type: 'cooldownMult', value: -0.15 }] },
        { name: '圣域·恒', desc: '专精（互斥）：半径 +25%，群体护甲 +25%，法力回复翻倍。', cost: 2, effects: [{ type: 'radiusMult', value: 0.25 }, { type: 'extra', value: 0.25, key: 'teamArmor' }, { type: 'extra', value: 0.01, key: 'mpPct' }, { type: 'extra', value: 1, key: 'focusRight' }] },
      ],
      ultimate: {
        name: '祖灵庇护', desc: '终极：半径 +30%，群体护甲 +30%，图腾在场时自身每秒回复生命。', cost: 2,
        effects: [
          { type: 'radiusMult', value: 0.3 },
          { type: 'extra', value: 0.3, key: 'teamArmor' },
          { type: 'extra', value: 1, key: 'totemRegen' },
        ],
      },
    }),
  },
};

/** 技能 id 列表。 */
export const SKILL_IDS = Object.freeze(Object.keys(SKILL_TREES));

/**
 * 拍平所有技能节点（含 skillId）。
 * @returns {Array<SkillNode & {skillId:string}>}
 */
function allNodes() {
  /** @type {Array<SkillNode & {skillId:string}>} */
  const out = [];
  for (const sid of SKILL_IDS) {
    for (const n of SKILL_TREES[sid].nodes) out.push({ ...n, skillId: sid });
  }
  return out;
}

/** 全部技能节点（含 skillId）。 */
export const SKILL_NODES = Object.freeze(allNodes().map((n) => Object.freeze(n)));

/** 技能节点 id → 节点。 */
export const SKILL_NODE_BY_ID = Object.freeze(
  SKILL_NODES.reduce((m, n) => { m[n.id] = n; return m; }, /** @type {Record<string, SkillNode & {skillId:string}>} */ ({})),
);

/**
 * 按 id 取技能树节点（如 'stomp.l4'）。
 * @param {string} id
 * @returns {(SkillNode & {skillId:string})|undefined}
 */
export function skillNodeById(id) {
  return SKILL_NODE_BY_ID[id];
}

/**
 * 取某技能的树（不存在时返回一个空树，避免 UI 崩溃）。
 * @param {string} skillId
 * @returns {SkillTree}
 */
export function skillTreeOf(skillId) {
  const t = SKILL_TREES[skillId];
  if (t) return t;
  return {
    id: skillId, name: skillId, icon: '❔', desc: '', shape: 'fork',
    branches: { left: '左支', right: '右支', root: '核心', ultimate: '终极' },
    nodes: [],
  };
}

/**
 * 把「短名 / 全名」解析成全局唯一的节点 id。
 *
 * **全局统一入口**：skillNodeConflict / validateSkillRanks / skillEffectsForSkill / skillBranchOf
 * 以及 skillProgression 里的所有 rank 统计都必须走这里，否则就会出现
 * 「'stomp.root' 被拼成 'stomp.stomp.root' 永远查不到」这类 bug（踩过）。
 *
 * @param {string} skillId
 * @param {string} key 短名（'root'）或全名（'stomp.root'）
 * @returns {(SkillNode & {skillId:string})|undefined}
 */
export function resolveSkillNodeId(skillId, key) {
  if (!key || typeof key !== 'string') return undefined;
  // 1) 先按全名直查（'stomp.root' / 'whirlwind.l1'）
  if (SKILL_NODE_BY_ID[key]) return SKILL_NODE_BY_ID[key];
  // 2) 再按「本技能短名」拼一次（'root' → 'stomp.root'）
  const withPrefix = `${skillId}.${key}`;
  if (SKILL_NODE_BY_ID[withPrefix]) return SKILL_NODE_BY_ID[withPrefix];
  return undefined;
}

/**
 * 把「短名 / 全名」+ 档位规范化成 { 全 id: rank }，并裁剪到 [0, maxRank]。
 * @param {string} skillId
 * @param {Record<string, number>} [ranks]
 * @returns {Record<string, number>}
 */
function normalizeRanks(skillId, ranks = {}) {
  /** @type {Record<string, number>} */
  const applied = {};
  if (!ranks || typeof ranks !== 'object') return applied;
  for (const k in ranks) {
    const v = Number(ranks[k]);
    if (!Number.isFinite(v) || v <= 0) continue;
    const node = resolveSkillNodeId(skillId, k);
    if (!node || node.skillId !== skillId) continue;
    // 同一节点可能有短名与全名两份记录，取最大值（'root': 1 + 'stomp.root': 3 应为 3）
    const r = Math.min(Math.floor(v), node.maxRank);
    applied[node.id] = Math.max(applied[node.id] || 0, r);
  }
  return applied;
}

/**
 * 互斥检查：若已在同组点过**别的**节点，返回冲突信息。
 *
 * @param {string|SkillTree} skillTree 技能 id 或树对象
 * @param {Record<string, number>} ranks { nodeId|短名: rank }
 * @param {string} nodeId 要检查的节点（短名或全名）
 * @returns {null | {group:string, takenNodeId:string, takenName:string}}
 */
export function skillNodeConflict(skillTree, ranks, nodeId) {
  const tree = typeof skillTree === 'string' ? skillTreeOf(skillTree) : (skillTree || skillTreeOf(''));
  const skillId = tree.id;
  const node = resolveSkillNodeId(skillId, nodeId);
  if (!node || !node.group) return null;
  const applied = normalizeRanks(skillId, ranks || {});
  for (const other of tree.nodes || []) {
    if (other.id === node.id) continue;
    if (other.group !== node.group) continue;
    if ((applied[other.id] || 0) > 0) return { group: node.group, takenNodeId: other.id, takenName: other.name };
  }
  return null;
}

/**
 * 节点所属分支（'left' | 'right' | 'core' | 'leftDeep' | 'rightDeep' | 'ultimate'）。
 * 不存在的节点返回 'core'（UI 兜底，不抛异常）。
 * @param {string|SkillTree} skillTree 技能 id 或树对象
 * @param {string} nodeId
 * @returns {string}
 */
export function skillBranchOf(skillTree, nodeId) {
  const tree = typeof skillTree === 'string' ? skillTreeOf(skillTree) : (skillTree || null);
  const skillId = tree && tree.id;
  const node = skillId ? resolveSkillNodeId(skillId, nodeId) : SKILL_NODE_BY_ID[nodeId];
  return node ? node.branch || 'core' : 'core';
}

/**
 * 某个节点是否「已点亮」（rank ≥ 1）。
 * U 节点要求 ROOT +（L1..L4 **或** R1..R4）全部点亮，是「或」逻辑，
 * 所以它的 requires 列表（L1..L4 + R1..R4 + ROOT）不能按「与」来判定。
 * @param {SkillNode} node
 * @param {Record<string,number>} applied 已规范化的档位（全 id）
 */
function requiresSatisfied(node, applied) {
  if (!node.requires.length) return true;
  if (node.key === 'u') {
    const rootId = `${node.skillId}.root`;
    if ((applied[rootId] || 0) <= 0) return false;
    const chain = (p) => [1, 2, 3, 4].every((i) => (applied[`${node.skillId}.${p}${i}`] || 0) > 0);
    return chain('l') || chain('r');
  }
  return node.requires.every((r) => (applied[r] || 0) > 0);
}

/**
 * 前置（requires）满足情况。
 * @param {string} skillId
 * @param {SkillNode} node
 * @param {Record<string,number>} ranks 原始 ranks（支持短名）
 * @returns {{ok:boolean, missing:string[]}}
 */
function missingRequires(skillId, node, ranks) {
  const applied = normalizeRanks(skillId, ranks);
  const missing = node.requires.filter((r) => (applied[r] || 0) <= 0);
  if (node.key === 'u') {
    const rootId = `${skillId}.root`;
    const chain = (p) => [1, 2, 3, 4].every((i) => (applied[`${skillId}.${p}${i}`] || 0) > 0);
    const ok = (applied[rootId] || 0) > 0 && (chain('l') || chain('r'));
    if (ok) return { ok: true, missing: [] };
    // 给出有用的缺失列表：ROOT 缺失 + 「缺得少的那条链」
    const out = (applied[rootId] || 0) > 0 ? [] : [rootId];
    const l = [1, 2, 3, 4].map((i) => `${skillId}.l${i}`).filter((id) => (applied[id] || 0) <= 0);
    const r = [1, 2, 3, 4].map((i) => `${skillId}.r${i}`).filter((id) => (applied[id] || 0) <= 0);
    return { ok: false, missing: [...out, ...(l.length <= r.length ? l : r)] };
  }
  return { ok: missing.length === 0, missing };
}

/**
 * 汇总某个技能在给定档位下的全部效果。
 *
 * §ranks§ 是 { nodeId: rank }，也可以传 { 短名: rank }（自动补 skillId 前缀）。
 * 未点（rank ≤ 0）或超出 maxRank 的档位会被裁剪；前置未满足的节点不会生效。
 *
 * **互斥**：同组第二个被点的节点会被自动忽略（只认第一个），
 * 这与 app 层 doSkillRankUp 的校验一致，保证「坏存档 / 手工写数据」不会让两条支线同时生效。
 *
 * @param {string} skillId
 * @param {Record<string, number>} [ranks={}]
 * @returns {{damageMult:number, radiusMult:number, cooldownMult:number, count:number, extra:number,
 *   stats:Object<string,number>, flags:Object<string,boolean>,
 *   multiplierBonuses:Object<string,number>, flatBonuses:Object<string,number>, extras:Object<string,number>,
 *   ranks:Object<string,number>, nodes:string[], groups:Object<string,string>}}
 */
export function skillEffectsForSkill(skillId, ranks = {}) {
  const tree = skillTreeOf(skillId);
  const applied = normalizeRanks(skillId, ranks);

  // 互斥：按树顺序扫描，组被占用后同组其它节点直接剔除（只认第一个）
  /** @type {Record<string,string>} */
  const groups = {};
  for (const node of tree.nodes) {
    if (!node.group || !(applied[node.id] > 0)) continue;
    if (groups[node.group]) { delete applied[node.id]; continue; }
    groups[node.group] = node.id;
  }

  let damageMult = 1;
  let radiusMult = 1;
  let cooldownMult = 1;
  let count = 0;
  let extra = 0;
  /** @type {Object<string, number>} */
  const stats = {};
  /** @type {Object<string, boolean>} */
  const flags = {};
  /** 乘法系数（默认 1） */
  /** @type {Object<string, number>} */
  const multiplierBonuses = {};
  /** 固定值 */
  /** @type {Object<string, number>} */
  const flatBonuses = {};
  /** extra 类累计值 */
  /** @type {Object<string, number>} */
  const extras = {};
  const MUL_TYPES = new Set(['stunDurMult', 'armorPerEnemyMult', 'armorDurMult']);
  const FLAT_TYPES = new Set(['armorFlat']);

  // 前置校验：只有「已分配档位」且「前置也生效」的节点才计入。
  // 用不动点迭代：先认为所有已分配节点生效，再反复剔除前置不满足的（处理前置被裁剪的链式情况）。
  /** @type {Set<string>} */
  const activeSet = new Set(tree.nodes.map((n) => n.id).filter((id) => (applied[id] || 0) > 0));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...activeSet]) {
      const n = SKILL_NODE_BY_ID[id];
      if (!n) { activeSet.delete(id); changed = true; continue; }
      if (!requiresSatisfied(n, applied)) {
        activeSet.delete(id);
        changed = true;
      }
    }
  }
  const finalNodes = tree.nodes.map((n) => n.id).filter((id) => activeSet.has(id));

  // 汇总
  for (const node of tree.nodes) {
    if (!activeSet.has(node.id)) continue;
    const rank = applied[node.id] || 0;
    for (const eff of node.effects) {
      // minRank：节点点满 N 档才解锁的机制开关（例如 ROOT 的冲击环）
      if (eff.minRank && rank < eff.minRank) continue;
      const total = (eff.value || 0) * rank;
      switch (eff.type) {
        case 'damageMult': damageMult += total; break;
        case 'radiusMult': radiusMult += total; break;
        case 'cooldownMult': cooldownMult += total; break;
        case 'count': count += Math.round(total); if (eff.key) flags[eff.key] = true; break;
        case 'extra':
          if (eff.key) {
            // 数值型 extra 也记进 extras（core 端可以读原始强度，例如 healPct 0.04 + 0.04），
            // 但只把「非数值型」的键当机制开关，避免 flags 里塞一堆数字。
            if (Number.isFinite(total) && total !== 0) {
              extras[eff.key] = (extras[eff.key] || 0) + total;
            }
            if (!NUMBERISH_EXTRA.has(eff.key)) {
              flags[eff.key] = true;
              extra += Math.abs(total) || 1;
            } else {
              stats[eff.key] = (stats[eff.key] || 0) + total;
            }
          } else {
            extra += Math.abs(total) || 1;
          }
          break;
        case 'aoeMult': case 'projectileSpeedMult': case 'critChance': case 'critMulti':
        case 'areaDamageMult': case 'attackSpeedMult': case 'lifeLeech':
          stats[eff.type] = (stats[eff.type] || 0) + total;
          break;
        default:
          if (MUL_TYPES.has(eff.type)) {
            multiplierBonuses[eff.type] = (multiplierBonuses[eff.type] || 1) + total;
          } else if (FLAT_TYPES.has(eff.type)) {
            flatBonuses[eff.type] = (flatBonuses[eff.type] || 0) + total;
            // 同时写进 stats 同名键：armorFlat 对 recalc 来说就是一个固定护甲加值
            stats[eff.type] = (stats[eff.type] || 0) + total;
          } else {
            stats[eff.type] = (stats[eff.type] || 0) + total;
          }
          break;
      }
    }
  }

  // 冷却缩减区间 0.4 ~ 1.6（避免 0 冷却或冷却无限增长）
  cooldownMult = Math.max(0.4, Math.min(1.6, Math.round(cooldownMult * 1000) / 1000));

  // multiplierBonuses 里「没出现 = 1」会让 core 端读法变复杂，这里显式补齐 4 个常用键（值都是 1 = 中性）
  const mulOut = {
    stunDurMult: round3(multiplierBonuses.stunDurMult || 1),
    armorPerEnemyMult: round3(multiplierBonuses.armorPerEnemyMult || 1),
    armorDurMult: round3(multiplierBonuses.armorDurMult || 1),
  };

  return {
    damageMult: round3(damageMult),
    radiusMult: round3(radiusMult),
    cooldownMult,
    count,
    extra,
    stats,
    flags,
    multiplierBonuses: mulOut,
    flatBonuses,
    extras,
    ranks: { ...applied },
    nodes: finalNodes,
    groups,
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * 技能树里已花费的技能点总数（未满足前置的节点也算，因为玩家确实付了点）。
 * @param {string} skillId
 * @param {Record<string, number>} ranks
 * @returns {number}
 */
export function skillPointsSpent(skillId, ranks = {}) {
  const tree = skillTreeOf(skillId);
  const applied = normalizeRanks(skillId, ranks);
  let total = 0;
  for (const node of tree.nodes) {
    const r = applied[node.id] || 0;
    if (r > 0) total += node.cost * r;
  }
  return total;
}

/**
 * 判断某技能节点能否继续加点（不含「技能点够不够」——那是 app 层的事）。
 *
 * 返回的 reason 是给 UI 直接展示的中文原因，ok=false 时 UI 可以把节点画成 locked。
 *
 * @param {string} skillId
 * @param {string} nodeId
 * @param {Record<string, number>} ranks
 * @returns {{ok:boolean, reason:string}}
 */
export function canUpgradeSkillNode(skillId, nodeId, ranks = {}) {
  const node = resolveSkillNodeId(skillId, nodeId);
  if (!node) return { ok: false, reason: '节点不存在' };
  if (node.skillId !== skillId) return { ok: false, reason: '节点不属于该技能' };
  const applied = normalizeRanks(skillId, ranks);
  const cur = applied[node.id] || 0;
  if (cur >= node.maxRank) return { ok: false, reason: '已满档' };
  const req = missingRequires(skillId, node, ranks);
  if (!req.ok) return { ok: false, reason: '需要先点亮前置节点' };
  const conflict = skillNodeConflict(skillId, ranks, node.id);
  if (conflict) return { ok: false, reason: `已选择「${conflict.takenName}」，不能改点这条支线` };
  return { ok: true, reason: '' };
}

/**
 * 全量校验一副 ranks（互斥 / 前置 / 超档）。
 *
 * 用途：① 读档时清洗脏数据；② 测试；③ UI 提示。**不做点数校验**（点数属于 app 层）。
 *
 * @param {string} skillId
 * @param {Record<string, number>} ranks
 * @returns {{ok:boolean, reason:string, fixedRanks:Object<string,number>, problems:string[]}}
 *   fixedRanks 是一个「清洗后」的合法副本（去掉冲突组里的第二个节点与前置缺失的节点）。
 */
export function validateSkillRanks(skillId, ranks) {
  const tree = skillTreeOf(skillId);
  if (!tree.nodes.length) return { ok: false, reason: '技能不存在', fixedRanks: {}, problems: ['unknown-skill'] };
  /** @type {string[]} */
  const problems = [];
  const applied = normalizeRanks(skillId, ranks || {});

  // 1) 超档 / 未知节点：normalizeRanks 已把档位裁剪过，但这里要**记录**下来让调用方知道。
  //    注意必须用 resolveSkillNodeId 解析（短名与全名都能认），
  //    早期版本直接写 SKILL_NODE_BY_ID[`${skillId}.${k}`]，遇到全名 key 会拼成
  //    'stomp.stomp.root' 永远查不到 → 把所有正常节点误判成 unknown-node。
  if (ranks && typeof ranks === 'object') {
    for (const k in ranks) {
      const v = Number(ranks[k]);
      if (!Number.isFinite(v) || v <= 0) continue;
      const node = resolveSkillNodeId(skillId, k);
      if (!node) { problems.push(`unknown-node:${k}`); continue; }
      if (node.skillId !== skillId) { problems.push(`foreign-node:${k}`); continue; }
      if (Math.floor(v) > node.maxRank) problems.push(`over-max:${node.id}`);
    }
  }

  // 2) 互斥：保留树顺序里的第一个，剔除同组后续
  /** @type {Record<string,string>} */
  const groupOwner = {};
  for (const node of tree.nodes) {
    if (!node.group || (applied[node.id] || 0) <= 0) continue;
    if (groupOwner[node.group]) {
      problems.push(`mutex:${node.id}`);
      delete applied[node.id];
    } else {
      groupOwner[node.group] = node.id;
    }
  }

  // 3) 前置：不动点剔除
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of tree.nodes) {
      if ((applied[node.id] || 0) <= 0) continue;
      if (!requiresSatisfied(node, applied)) {
        problems.push(`requires:${node.id}`);
        delete applied[node.id];
        changed = true;
      }
    }
  }

  if (problems.length) return { ok: false, reason: `存在 ${problems.length} 处非法加点`, fixedRanks: applied, problems };
  return { ok: true, reason: '', fixedRanks: applied, problems: [] };
}

/**
 * 技能树上「最大可点档位」总数（用于 UI 进度条 / 平衡检查）。
 * @param {string} skillId
 * @returns {number}
 */
export function skillTreeMaxPoints(skillId) {
  const tree = skillTreeOf(skillId);
  let total = 0;
  for (const node of tree.nodes) total += node.cost * node.maxRank;
  return total;
}

/**
 * 某技能的一条完整分支链（UI 画「左支/右支」用）：返回 { left, right } 的节点数组（含 ROOT 之后的 L1..L4）。
 * @param {string} skillId
 * @returns {{root:SkillNode|null, left:SkillNode[], right:SkillNode[], ultimate:SkillNode|null}}
 */
export function skillBranchesOf(skillId) {
  const tree = skillTreeOf(skillId);
  const pick = (key) => tree.nodes.find((n) => n.key === key) || null;
  return {
    root: pick('root'),
    left: ['l1', 'l2', 'l3', 'l4'].map(pick).filter(Boolean),
    right: ['r1', 'r2', 'r3', 'r4'].map(pick).filter(Boolean),
    ultimate: pick('u'),
  };
}

export default {
  SKILL_TREES, SKILL_IDS, SKILL_NODES, SKILL_NODE_BY_ID, MUTEX_GROUPS, BRANCH_LABELS, GROUP_LABELS,
  skillNodeById, skillEffectsForSkill, skillTreeOf, skillNodeConflict, skillBranchOf,
  validateSkillRanks, skillPointsSpent, canUpgradeSkillNode, skillTreeMaxPoints, skillBranchesOf,
};