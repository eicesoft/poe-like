// @file src/items/mageTalentTree.js
// 元素法师专属天赋树 —— 纯数据 + 纯函数（无 DOM / 无渲染依赖）。
//
// 设计目标：让法师的成长从「只有技能等级」变成「可以围绕火 / 冰 / 雷 / 共鸣
// 四个方向构筑」，并且每一条终局天赋都带来**看得见的战斗表现**（陨星、环绕法球、
// 反应回响、三相齐射、狂潮延长）。
//
// ── 布局 ────────────────────────────────────────────────────────────────────
//   · 中心：mage-start「元素之心」，默认点亮。
//   · 四条主干（每 90° 一条）：
//       烈焰 fire 90°（下） · 霜寒 frost 180°（左） · 雷霆 storm 270°（上） · 共鸣 arcane 0°（右）
//   · 半径阶梯：trunc 55 → hub 115 → stem1 175 → stem2 235 → stem3 285
//              → armL/armR 300（±22°）→ upL/upR 365（±22°）→ outerL/outerR 425（±22°）
//              → cap 425（正中）→ apex 480 → keystone 560
//   · 每条主干 14 个节点；四条主干之间各有 1 个内环接缝（r300）与 1 个外环接缝（r425）；
//     内圈 5 个传奇（其中 1 个是防御向的霜火壁垒）。
//     4 主干 × 14 + 8 接缝 + 5 传奇 + 1 起点 = **70 节点**，与战士树数量对齐。
//
// 每个节点除标准 StatBlock 字段外，还可以带 `mage*` 自定义字段；这些字段不会进入
// recalcStats（core 只认 STAT_KEYS），但会原样留在 player.talentStats 里，
// 由 core/mage.js 的 mageTalentMods() 读取。
//
// 自定义字段一览（core/mage.js 使用）：
//   mageReactionMult   元素反应伤害 +X
//   mageResonanceMult  共鸣获取 +X
//   mageMarkMax        元素印记上限 +N（整数）
//   mageAutoCastMult   自动循环 GCD 缩减 X（0.08 = -8%）
//   mageEmpoweredMult  3 层强化技能伤害 +X
//   mageShieldMult     冰霜屏障护盾 +X
//   mageNovaRadius     霜环半径 +X
//   mageNovaCdr        霜环冷却缩减 X
//   mageChainJumpBonus 雷链额外跳跃 +N
//   mageReactionEcho   反应回响：向周围额外弹射 N 个目标
//   mageUltDuration    元素狂潮持续 +N 秒
//   mageUltCdr         元素狂潮冷却缩减 X
//   mageMeteor         陨星等级 1~3（0 = 未解锁）
//   mageMeteorRate     陨星间隔缩减 X
//   mageOrbs           环绕法球数量 0~3
//   mageTrinity        每 N 次填充施法触发三相齐射（0 = 关闭）
//   mageUltKillExtend  元素狂潮期间每次击杀延长 N 秒
//   mageControlMult    眩晕时长 +X

/** 法师天赋树起点。 */
export const MAGE_START_NODE = 'mage-start';

/**
 * 四条主干。
 * @type {ReadonlyArray<{id:string,name:string,angle:number,color:string,desc:string}>}
 */
export const MAGE_BRANCHES = Object.freeze([
  Object.freeze({ id: 'fire', name: '烈焰', angle: 90, color: '#ff8a3d', desc: '火焰伤害、陨星与范围' }),
  Object.freeze({ id: 'frost', name: '霜寒', angle: 180, color: '#7dd3fc', desc: '冰霜伤害、控制与护盾' }),
  Object.freeze({ id: 'storm', name: '雷霆', angle: 270, color: '#fde047', desc: '闪电伤害、连锁与冷却' }),
  Object.freeze({ id: 'arcane', name: '共鸣', angle: 0, color: '#c084fc', desc: '共鸣、元素狂潮与自动循环' }),
]);

/** 半径阶梯。 */
export const MAGE_RING_RADII = Object.freeze({
  trunc: 55, hub: 115, stem1: 175, stem2: 235, stem3: 285,
  arm: 300, up: 365, outer: 425, cap: 425, apex: 480, keystone: 560, legendary: 205,
});

const ARM_BEND = 22;

/** @type {any[]} */
const NODES = [];
/** @type {Map<string, Set<string>>} */
const ADJ = new Map();
/** @type {Map<string, any>} */
const BY_ID = new Map();

/** 对齐 2.5 网格。 */
function snap(v) {
  return Math.round(v / 2.5) * 2.5;
}

/** 极坐标 → 直角坐标。 */
function polar(angleDeg, r) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

/**
 * 创建并登记一个节点。
 * @param {{id:string,name:string,kind:string,angle:number,r:number,branch:string,tier?:number,desc:string,stats?:Object,notable?:Object}} def
 */
function node(def) {
  const p = polar(def.angle, def.r);
  const n = {
    id: def.id,
    name: def.name,
    kind: def.kind,
    x: snap(p.x),
    y: snap(p.y),
    angle: Math.round(def.angle * 10) / 10,
    radius: Math.round(def.r),
    branch: def.branch,
    tier: def.tier || 0,
    desc: def.desc,
    stats: { ...(def.stats || {}) },
    neighbors: [],
  };
  if (def.notable) n.notable = { ...def.notable };
  NODES.push(n);
  ADJ.set(n.id, new Set());
  BY_ID.set(n.id, n);
  return n;
}

/** 双向连边。 */
function link(a, b) {
  if (!a || !b || a === b) return;
  const sa = ADJ.get(a);
  const sb = ADJ.get(b);
  if (!sa || !sb) return;
  sa.add(b);
  sb.add(a);
}

/**
 * 定义一条法师主干。
 * @param {string} branchId
 * @param {{trunc:any,hub:any,stem1:any,stem2:any,stem3:any,armL:any,armR:any,
 *          upL:any,upR:any,outerL:any,outerR:any,cap:any,apex:any,keystone:any}} def
 */
function defineBranch(branchId, def) {
  const br = MAGE_BRANCHES.find((b) => b.id === branchId);
  if (!br) throw new Error(`unknown mage branch: ${branchId}`);
  const A = br.angle;
  const R = MAGE_RING_RADII;
  const plan = [
    ['trunc', A, R.trunc, 1, def.trunc],
    ['hub', A, R.hub, 1, def.hub],
    ['stem1', A, R.stem1, 2, def.stem1],
    ['stem2', A, R.stem2, 2, def.stem2],
    ['stem3', A, R.stem3, 3, def.stem3],
    ['armL', A - ARM_BEND, R.arm, 3, def.armL],
    ['armR', A + ARM_BEND, R.arm, 3, def.armR],
    ['upL', A - ARM_BEND, R.up, 4, def.upL],
    ['upR', A + ARM_BEND, R.up, 4, def.upR],
    ['outerL', A - ARM_BEND, R.outer, 4, def.outerL],
    ['outerR', A + ARM_BEND, R.outer, 4, def.outerR],
    ['cap', A, R.cap, 4, def.cap],
    ['apex', A, R.apex, 5, def.apex],
  ];
  for (const [suffix, angle, r, tier, nd] of plan) {
    if (!nd) throw new Error(`${branchId}.${suffix} missing`);
    node({
      id: `m-${branchId}-${suffix}`,
      name: nd.name,
      kind: nd.kind || 'minor',
      angle,
      r,
      branch: branchId,
      tier,
      desc: nd.desc,
      stats: nd.stats,
      notable: nd.notable,
    });
  }
  const P = (s) => `m-${branchId}-${s}`;
  for (const [a, b] of [
    ['trunc', 'hub'], ['hub', 'stem1'], ['stem1', 'stem2'], ['stem2', 'stem3'],
    ['stem3', 'armL'], ['stem3', 'armR'],
    ['armL', 'upL'], ['armR', 'upR'], ['upL', 'outerL'], ['upR', 'outerR'],
    ['outerL', 'cap'], ['outerR', 'cap'], ['cap', 'apex'], ['apex', 'keystone'],
  ]) link(P(a), P(b));

  const ks = def.keystone;
  node({
    id: `m-ks-${branchId}`,
    name: ks.name,
    kind: 'keystone',
    angle: A,
    r: R.keystone,
    branch: 'keystone',
    tier: 6,
    desc: ks.desc,
    stats: ks.stats,
    notable: ks.notable,
  });
  link(P('apex'), `m-ks-${branchId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 四条主干内容
// ─────────────────────────────────────────────────────────────────────────────

// 烈焰（90°）：火焰伤害 / 范围 / 陨星 / 反应
defineBranch('fire', {
  trunc: { name: '火种', desc: '火焰伤害 +6%', stats: { fireDamageMult: 0.06 } },
  hub: { name: '引燃', desc: '火焰伤害 +8%', stats: { fireDamageMult: 0.08 } },
  stem1: { name: '爆燃', desc: '范围效果 +6%', stats: { aoeMult: 0.06 } },
  stem2: {
    name: '焚心', kind: 'notable',
    desc: '火焰伤害 +14%\n元素反应伤害 +10%',
    stats: { fireDamageMult: 0.14, mageReactionMult: 0.1 },
    notable: { icon: '🔥', trait: '反应强化：熔解 / 超载的额外伤害同时提高 10%' },
  },
  stem3: { name: '燎原', desc: '火焰伤害 +10%\n范围效果 +4%', stats: { fireDamageMult: 0.1, aoeMult: 0.04 } },
  armL: { name: '余烬', desc: '附加火焰伤害 2-4', stats: { addedFireMin: 2, addedFireMax: 4 } },
  armR: {
    name: '灰烬回响',
    desc: '火焰伤害 +10%\n元素反应伤害 +8%',
    stats: { fireDamageMult: 0.1, mageReactionMult: 0.08 },
  },
  upL: { name: '烈焰行者', desc: '火焰伤害 +8%\n移动速度 +3%', stats: { fireDamageMult: 0.08, moveSpeedMult: 0.03 } },
  upR: { name: '熔火', desc: '火焰伤害 +8%\n范围效果 +5%', stats: { fireDamageMult: 0.08, aoeMult: 0.05 } },
  outerL: { name: '炽焰壁垒', desc: '火焰抗性 +8%\n能量护盾 +30', stats: { fireResist: 0.08, energyShield: 30 } },
  outerR: { name: '焚天', desc: '火焰伤害 +10%\n持续伤害 +8%', stats: { fireDamageMult: 0.1, dotMult: 0.08 } },
  cap: {
    name: '陨星之契', kind: 'notable',
    desc: '解锁「天火陨星」：周期性轰击锁定目标\n火焰伤害 +10%',
    stats: { mageMeteor: 1, fireDamageMult: 0.1 },
    notable: { icon: '☄', trait: '天火陨星：每 9 秒（天赋可加快）在目标处砸下一颗陨星，造成范围火焰伤害并击晕' },
  },
  apex: {
    name: '星火燎原', kind: 'notable',
    desc: '陨星间隔 -10%\n火焰伤害 +12%，范围效果 +6%',
    stats: { mageMeteorRate: 0.1, fireDamageMult: 0.12, aoeMult: 0.06 },
    notable: { icon: '🌋', trait: '陨星冷却更短；配合「天火降世」可以形成连续落星' },
  },
  keystone: {
    name: '天火降世',
    desc: '陨星等级 +2，陨星间隔 -35%，火焰伤害 +30%\n【代价】冰霜与闪电伤害 -12%',
    stats: {
      mageMeteor: 2, mageMeteorRate: 0.35, fireDamageMult: 0.3,
      coldDamageMult: -0.12, lightningDamageMult: -0.12,
    },
    notable: { icon: '🌠', trait: '陨星风暴：陨星更频繁、更大、更痛，落地时炸出熔岩裂纹' },
  },
});

// 霜寒（180°）：冰霜 / 控制 / 护盾 / 霜环
defineBranch('frost', {
  trunc: { name: '寒霜', desc: '冰霜伤害 +6%', stats: { coldDamageMult: 0.06 } },
  hub: { name: '凛冬', desc: '冰霜伤害 +8%', stats: { coldDamageMult: 0.08 } },
  stem1: { name: '冰晶', desc: '范围效果 +6%', stats: { aoeMult: 0.06 } },
  stem2: {
    name: '永冻', kind: 'notable',
    desc: '冰霜伤害 +14%\n眩晕时长 +20%',
    stats: { coldDamageMult: 0.14, mageControlMult: 0.2 },
    notable: { icon: '❄', trait: '控制强化：霜环、等离子与陨星的眩晕时间延长 20%' },
  },
  stem3: { name: '霜华', desc: '冰霜伤害 +10%\n眩晕时长 +10%', stats: { coldDamageMult: 0.1, mageControlMult: 0.1 } },
  armL: {
    name: '霜甲',
    desc: '冰霜屏障护盾 +20%\n能量护盾 +15',
    stats: { mageShieldMult: 0.2, energyShield: 15 },
  },
  armR: { name: '碎冰', desc: '冰霜伤害 +10%', stats: { coldDamageMult: 0.1 } },
  upL: { name: '冰盾', desc: '冰霜屏障护盾 +15%\n能量护盾 +30', stats: { mageShieldMult: 0.15, energyShield: 30 } },
  upR: { name: '寒流', desc: '冰霜伤害 +8%\n范围效果 +5%', stats: { coldDamageMult: 0.08, aoeMult: 0.05 } },
  outerL: { name: '极寒', desc: '冰霜伤害 +10%\n眩晕时长 +15%', stats: { coldDamageMult: 0.1, mageControlMult: 0.15 } },
  outerR: { name: '冰凌', desc: '冰霜伤害 +8%\n能量护盾 +25', stats: { coldDamageMult: 0.08, energyShield: 25 } },
  cap: {
    name: '霜环专精', kind: 'notable',
    desc: '霜环半径 +25%，冷却 -20%\n冰霜伤害 +8%',
    stats: { mageNovaRadius: 0.25, mageNovaCdr: 0.2, coldDamageMult: 0.08 },
    notable: { icon: '🌨', trait: '霜环扩张：以自身为圆心的冰环更大、更频繁，强化时冻结更久' },
  },
  apex: {
    name: '永冬', kind: 'notable',
    desc: '冰霜伤害 +12%，护盾 +15%\n能量护盾 +30',
    stats: { coldDamageMult: 0.12, mageShieldMult: 0.15, energyShield: 30 },
    notable: { icon: '🧊', trait: '第二层生命：屏障更厚，护盾与生命值形成双重缓冲' },
  },
  keystone: {
    name: '绝对零度',
    desc: '冰霜伤害 +35%，眩晕时长 +30%，护盾 +25%\n【代价】火焰与闪电伤害 -10%',
    stats: {
      coldDamageMult: 0.35, mageControlMult: 0.3, mageShieldMult: 0.25,
      fireDamageMult: -0.1, lightningDamageMult: -0.1,
    },
    notable: { icon: '🧊', trait: '绝对零度：霜环落地时整片地面结霜，被冻住的敌人更久不能动' },
  },
});

// 雷霆（270°）：闪电 / 连锁 / 冷却 / 移速
defineBranch('storm', {
  trunc: { name: '电弧', desc: '闪电伤害 +6%', stats: { lightningDamageMult: 0.06 } },
  hub: { name: '迅雷', desc: '冷却缩减 +4%', stats: { cdrMult: 0.04 } },
  stem1: { name: '导电', desc: '闪电伤害 +8%', stats: { lightningDamageMult: 0.08 } },
  stem2: {
    name: '连锁主宰', kind: 'notable',
    desc: '闪电伤害 +12%\n雷链额外跳跃 +1',
    stats: { lightningDamageMult: 0.12, mageChainJumpBonus: 1 },
    notable: { icon: '⚡', trait: '雷链多跳一次；强化时跳得更远，链上每只怪都带闪电残光' },
  },
  stem3: { name: '高压', desc: '闪电伤害 +10%\n冷却缩减 +3%', stats: { lightningDamageMult: 0.1, cdrMult: 0.03 } },
  armL: { name: '疾步', desc: '移动速度 +6%', stats: { moveSpeedMult: 0.06 } },
  armR: {
    name: '过载',
    desc: '元素反应伤害 +10%\n闪电伤害 +6%',
    stats: { mageReactionMult: 0.1, lightningDamageMult: 0.06 },
  },
  upL: { name: '雷行', desc: '移动速度 +5%\n闪电伤害 +6%', stats: { moveSpeedMult: 0.05, lightningDamageMult: 0.06 } },
  upR: { name: '静电', desc: '闪电伤害 +8%\n元素反应伤害 +6%', stats: { lightningDamageMult: 0.08, mageReactionMult: 0.06 } },
  outerL: { name: '电能', desc: '闪电伤害 +10%\n冷却缩减 +3%', stats: { lightningDamageMult: 0.1, cdrMult: 0.03 } },
  outerR: { name: '疾雷', desc: '闪电伤害 +8%\n移动速度 +4%', stats: { lightningDamageMult: 0.08, moveSpeedMult: 0.04 } },
  cap: {
    name: '万雷天降', kind: 'notable',
    desc: '雷链额外跳跃 +1\n闪电伤害 +15%',
    stats: { mageChainJumpBonus: 1, lightningDamageMult: 0.15 },
    notable: { icon: '🌩', trait: '雷链最多再跳两次，配合回响可以把整群怪串成一条电蛇' },
  },
  apex: {
    name: '雷池', kind: 'notable',
    desc: '元素反应伤害 +10%\n闪电伤害 +12%，冷却缩减 +4%',
    stats: { mageReactionMult: 0.1, lightningDamageMult: 0.12, cdrMult: 0.04 },
    notable: { icon: '⚡', trait: '反应更痛、技能转得更快；连锁与回响同时受益' },
  },
  keystone: {
    name: '雷神之怒',
    desc: '闪电伤害 +35%，雷链额外跳跃 +2\n元素反应会向周围回响\n【代价】冰霜抗性 -15%',
    stats: {
      lightningDamageMult: 0.35, mageChainJumpBonus: 2, mageReactionEcho: 1,
      coldResist: -0.15,
    },
    notable: { icon: '⛈', trait: '雷霆回响：每次元素反应都会向周围弹射电光，命中附近敌人' },
  },
});

// 共鸣（0°）：共鸣 / 狂潮 / 自动循环 / 强化
defineBranch('arcane', {
  trunc: { name: '灵光', desc: '共鸣获取 +10%', stats: { mageResonanceMult: 0.1 } },
  hub: { name: '法力涌流', desc: '每秒法力回复 +2', stats: { manaRegen: 2 } },
  stem1: { name: '循环加速', desc: '自动施法间隔 -8%', stats: { mageAutoCastMult: 0.08 } },
  stem2: {
    name: '三相共鸣', kind: 'notable',
    desc: '印记上限 +1\n共鸣获取 +10%',
    stats: { mageMarkMax: 1, mageResonanceMult: 0.1 },
    notable: { icon: '🔮', trait: '印记上限从 3 层提升到 4 层：强化炎爆 / 霜环 / 雷链需要更多铺垫，但爆发更高' },
  },
  stem3: { name: '奥术洪流', desc: '元素伤害 +3%\n范围效果 +5%', stats: { fireDamageMult: 0.03, coldDamageMult: 0.03, lightningDamageMult: 0.03, aoeMult: 0.05 } },
  armL: {
    name: '强化专精',
    desc: '强化技能伤害 +15%',
    stats: { mageEmpoweredMult: 0.15 },
  },
  armR: {
    name: '狂潮余韵',
    desc: '元素狂潮持续 +2 秒',
    stats: { mageUltDuration: 2 },
  },
  upL: {
    name: '奥术护体',
    desc: '生命 +60\n能量护盾 +25',
    stats: { life: 60, energyShield: 25 },
  },
  upR: {
    name: '回响',
    desc: '共鸣获取 +10%\n自动施法间隔 -5%',
    stats: { mageResonanceMult: 0.1, mageAutoCastMult: 0.05 },
  },
  outerL: {
    name: '共鸣涌动',
    desc: '共鸣获取 +15%\n元素狂潮持续 +1 秒',
    stats: { mageResonanceMult: 0.15, mageUltDuration: 1 },
  },
  outerR: {
    name: '秘能',
    desc: '每秒法力回复 +2\n冷却缩减 +4%',
    stats: { manaRegen: 2, cdrMult: 0.04 },
  },
  cap: {
    name: '元素领主', kind: 'notable',
    desc: '元素反应伤害 +20%\n共鸣获取 +15%',
    stats: { mageReactionMult: 0.2, mageResonanceMult: 0.15 },
    notable: { icon: '👑', trait: '反应与共鸣双强化：更频繁地进入元素狂潮' },
  },
  apex: {
    name: '元素统御', kind: 'notable',
    desc: '元素反应伤害 +10%，共鸣获取 +10%\n元素狂潮冷却 -10%',
    stats: { mageReactionMult: 0.1, mageResonanceMult: 0.1, mageUltCdr: 0.1 },
    notable: { icon: '🌌', trait: '终极技能转得更快；配合「永动狂潮」几乎无缝循环' },
  },
  keystone: {
    name: '永动狂潮',
    desc: '元素狂潮持续 +4 秒，冷却 -30%，自动施法间隔 -12%\n【代价】火焰 / 冰霜 / 闪电抗性 -8%',
    stats: {
      mageUltDuration: 4, mageUltCdr: 0.3, mageAutoCastMult: 0.12,
      fireResist: -0.08, coldResist: -0.08, lightningResist: -0.08,
    },
    notable: { icon: '🌌', trait: '狂潮永动：元素狂潮期间每次击杀都会延长 0.5 秒，清群时几乎停不下来' },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 起点：与四条主干相连
// ─────────────────────────────────────────────────────────────────────────────
const start = node({
  id: MAGE_START_NODE,
  name: '元素之心',
  kind: 'classStart',
  angle: 0,
  r: 0,
  branch: 'center',
  tier: 0,
  desc: '元素法师的起点，默认点亮。火 / 冰 / 雷 / 共鸣四条主干从这里延伸。',
  stats: {},
});
for (const n of NODES.slice()) {
  if (n.id.endsWith('-trunc')) link(start.id, n.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 环形接缝：四条主干之间的 90° 缺口各 1 个内环（r300）+ 1 个外环（r425），
// 让玩家可以在相邻元素之间横跳，而不是只能沿一条主干走到黑。
// ─────────────────────────────────────────────────────────────────────────────
const MAGE_GAPS = [45, 135, 225, 315];

/** 角度差归一化到 [0, 180]。 */
function angleGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/**
 * 环形接缝节点：与同半径、角距在 [minDiff, maxDiff] 内的已有节点相连。
 * 法师的 arm/outer 都在主干 ±22°，而缺口在 45°，所以接缝与两侧节点各差 23°。
 */
function ringJoint(id, name, angle, r, desc, stats, tier, maxDiff, minDiff) {
  const self = node({ id, name, kind: 'minor', angle, r, branch: 'ring', tier, desc, stats });
  for (const other of NODES.slice()) {
    if (other === self) continue;
    if (Math.round(other.radius) !== Math.round(r)) continue;
    if (other.kind === 'classStart' || other.kind === 'keystone') continue;
    const d = angleGap(other.angle, self.angle);
    if (d >= minDiff - 1e-9 && d <= maxDiff + 1e-9) link(self.id, other.id);
  }
  return self;
}

const INNER_JOINTS = [
  { id: 'm-ring-in-45', gap: 0, name: '灼能', desc: '火焰伤害 +6%\n闪电伤害 +3%', stats: { fireDamageMult: 0.06, lightningDamageMult: 0.03 } },
  { id: 'm-ring-in-135', gap: 1, name: '蒸汽', desc: '火焰伤害 +6%\n冰霜伤害 +6%', stats: { fireDamageMult: 0.06, coldDamageMult: 0.06 } },
  { id: 'm-ring-in-225', gap: 2, name: '冰雷', desc: '冰霜伤害 +6%\n闪电伤害 +6%', stats: { coldDamageMult: 0.06, lightningDamageMult: 0.06 } },
  { id: 'm-ring-in-315', gap: 3, name: '雷心', desc: '闪电伤害 +6%\n共鸣获取 +5%', stats: { lightningDamageMult: 0.06, mageResonanceMult: 0.05 } },
];
for (const j of INNER_JOINTS) {
  ringJoint(j.id, j.name, MAGE_GAPS[j.gap], MAGE_RING_RADII.arm, j.desc, j.stats, 3, 24, 22);
}

const OUTER_JOINTS = [
  { id: 'm-ring-out-45', gap: 0, name: '奥火壁垒', desc: '火焰抗性 +4%\n闪电抗性 +4%，能量护盾 +20', stats: { fireResist: 0.04, lightningResist: 0.04, energyShield: 20 } },
  { id: 'm-ring-out-135', gap: 1, name: '温差', desc: '火焰抗性 +4%\n冰霜抗性 +4%，能量护盾 +20', stats: { fireResist: 0.04, coldResist: 0.04, energyShield: 20 } },
  { id: 'm-ring-out-225', gap: 2, name: '暴风眼', desc: '冰霜抗性 +4%\n闪电抗性 +4%，能量护盾 +20', stats: { coldResist: 0.04, lightningResist: 0.04, energyShield: 20 } },
  { id: 'm-ring-out-315', gap: 3, name: '雷灵', desc: '闪电抗性 +4%\n每秒法力回复 +1，能量护盾 +20', stats: { lightningResist: 0.04, manaRegen: 1, energyShield: 20 } },
];
for (const j of OUTER_JOINTS) {
  ringJoint(j.id, j.name, MAGE_GAPS[j.gap], MAGE_RING_RADII.outer, j.desc, j.stats, 4, 24, 22);
}

// ─────────────────────────────────────────────────────────────────────────────
// 内圈传奇：挂在两条主干之间，作为早期就能绕到的强力支线
// ─────────────────────────────────────────────────────────────────────────────
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 传奇节点：自动连到距离最近的两个不同主干的普通节点。
 */
function legendary(id, name, angle, r, desc, stats, notable) {
  const self = node({
    id, name, kind: 'legendary', angle, r, branch: 'legendary', tier: 2, desc, stats, notable,
  });
  const cands = NODES.filter((n) => n !== self && n.kind !== 'classStart' && n.kind !== 'legendary'
    && n.branch !== 'keystone' && ADJ.has(n.id));
  const sorted = cands.slice().sort((a, b) => dist(a, self) - dist(b, self));
  const first = sorted.find((n) => {
    const d = dist(n, self);
    return d >= 90 && d <= 170;
  }) || sorted[0] || null;
  if (first) link(self.id, first.id);
  const second = sorted.find((n) => n !== first && n.branch !== (first && first.branch)
    && !ADJ.get(self.id).has(n.id) && (() => {
      const d = dist(n, self);
      return d >= 80 && d <= 190;
    })()) || null;
  if (second) link(self.id, second.id);
  return self;
}

legendary('m-lg-orbit', '环形法球', 45, MAGE_RING_RADII.legendary,
  '环绕法球 +1：每 2.5 秒自动轰击附近敌人\n闪电伤害 +5%',
  { mageOrbs: 1, lightningDamageMult: 0.05 },
  { icon: '🛰', trait: '元素法球绕身旋转，自动向最近敌人发射对应元素弹（可叠 3 颗）' });

legendary('m-lg-trinity', '三相归一', 135, MAGE_RING_RADII.legendary,
  '每 3 次填充施法，同时释放另外两系法术（50% 伤害）\n元素伤害 +4%',
  { mageTrinity: 3, fireDamageMult: 0.04, coldDamageMult: 0.04, lightningDamageMult: 0.04 },
  { icon: '🔱', trait: '三相齐射：火 / 冰 / 雷同帧轰出，画面会被三色弹道填满' });

legendary('m-lg-echo', '元素回响', 225, MAGE_RING_RADII.legendary,
  '元素反应向周围 3.2 范围回响\n元素反应伤害 +10%',
  { mageReactionEcho: 1, mageReactionMult: 0.1 },
  { icon: '♾', trait: '反应回响：熔解 / 超载 / 等离子会向附近敌人弹射一道同色电光' });

legendary('m-lg-core', '共鸣核心', 315, MAGE_RING_RADII.legendary,
  '共鸣获取 +25%\n元素狂潮期间击杀延长 0.4 秒',
  { mageResonanceMult: 0.25, mageUltKillExtend: 0.4 },
  { icon: '💠', trait: '共鸣核心：反应来得更快，狂潮开得更勤，清群时越打越久' });

legendary('m-lg-bulwark', '霜火壁垒', 225, 140,
  '冰霜屏障护盾 +20%，能量护盾 +60，生命 +120\n火焰 / 冰霜抗性 +6%',
  { mageShieldMult: 0.2, energyShield: 60, life: 120, fireResist: 0.06, coldResist: 0.06 },
  { icon: '🛡', trait: '防御向传奇：屏障与能量护盾同时变厚，法师也能站桩吃一轮爆发' });

// ─────────────────────────────────────────────────────────────────────────────
// 收尾：连通性兜底、写 neighbors、导出
// ─────────────────────────────────────────────────────────────────────────────
function bfs(from) {
  const seen = new Set([from]);
  const q = [from];
  while (q.length) {
    const id = q.shift();
    for (const nb of ADJ.get(id) || []) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      q.push(nb);
    }
  }
  return seen;
}

function ensureConnected() {
  for (let guard = 0; guard < 8; guard++) {
    const seen = bfs(MAGE_START_NODE);
    const missing = NODES.filter((n) => !seen.has(n.id));
    if (!missing.length) return;
    for (const n of missing) {
      let best = null;
      let bestD = Infinity;
      for (const id of seen) {
        const m = BY_ID.get(id);
        if (!m) continue;
        const d = (m.x - n.x) ** 2 + (m.y - n.y) ** 2;
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best) link(n.id, best.id);
    }
  }
}
ensureConnected();

for (const n of NODES) {
  n.neighbors = Array.from(ADJ.get(n.id) || []).sort();
  Object.freeze(n.stats);
  Object.freeze(n.neighbors);
  if (n.notable) Object.freeze(n.notable);
  Object.freeze(n);
}

/** 全部法师天赋节点。 */
export const MAGE_TALENTS = Object.freeze(NODES.slice());

/** 法师天赋 id → 节点。 */
export const MAGE_TALENT_BY_ID = Object.freeze(
  Object.assign(Object.create(null), ...MAGE_TALENTS.map((n) => ({ [n.id]: n }))),
);

/** 法师天赋邻接表。 */
export const MAGE_TALENT_GRAPH = Object.freeze(
  Object.assign(Object.create(null), ...MAGE_TALENTS.map((n) => ({ [n.id]: n.neighbors }))),
);

/**
 * 按 id 取法师天赋节点。
 * @param {string} id
 */
export function mageTalentById(id) {
  return (id && MAGE_TALENT_BY_ID[id]) || null;
}

/**
 * 从起点出发的可达集合。
 * @param {string} [from=MAGE_START_NODE]
 */
export function mageReachableFrom(from = MAGE_START_NODE) {
  return bfs(from);
}

/**
 * 汇总已点亮法师天赋的 stats（数值相加；包含 mage* 自定义字段）。
 * @param {Iterable<string>} ids
 * @returns {Object<string, number>}
 */
export function aggregateMageTalentStats(ids) {
  const out = {};
  if (!ids) return out;
  for (const id of ids) {
    const n = MAGE_TALENT_BY_ID[id];
    if (!n || !n.stats) continue;
    for (const k in n.stats) {
      const v = n.stats[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      out[k] = (out[k] || 0) + v;
    }
  }
  return out;
}

/** 法师天赋树统计（测试 / 调试用）。 */
export function mageTalentStats() {
  const byKind = {};
  const byBranch = {};
  let degree = 0;
  for (const n of MAGE_TALENTS) {
    byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    byBranch[n.branch] = (byBranch[n.branch] || 0) + 1;
    degree += n.neighbors.length;
  }
  return { total: MAGE_TALENTS.length, byKind, byBranch, edges: degree / 2 };
}

export default {
  MAGE_TALENTS,
  MAGE_TALENT_BY_ID,
  MAGE_START_NODE,
  MAGE_BRANCHES,
  mageTalentById,
  mageReachableFrom,
  aggregateMageTalentStats,
  mageTalentStats,
};