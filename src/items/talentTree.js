// @file src/items/talentTree.js
// POE 式天赋树 —— 纯数据 + 纯函数（无 DOM / 无 three / 无任何 import；渲染由 ui/talent-ui.js 负责）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 一、布局总览（坐标原点在中心，x 向右、y 向下；UI 可整体缩放 / 平移）
// ═══════════════════════════════════════════════════════════════════════════
//   · 中心：起点 start-warrior (0,0)，kind 'classStart'，默认点亮。
//
//   · 六条主干，每 60° 一条（BRANCHES.angle）：
//       战争 war 90° · 锻造 forge 30° · 烈焰 flame 330° · 疾风 gale 270° · 死亡 death 210° · 命运 fate 150°
//
//   · 半径阶梯（RING_RADII，一条主干从里到外）：
//       trunc 37（截断点，直接连起点）
//         → hub 72（每支主干的入口枢纽）
//           → stem1 122 → stem2 180（直线主干）
//             → armL / armR 290（内环带：在此处左右分叉，各弯 ±22°）
//               → upL / upR 372（中环带，继续沿 ±22° 向外）
//                 → cap 448（外环带，主干正中的收束点）
//                   → keystone 600（基石，只连 cap）
//     SPOKE_RADII = [122, 180] 是主干直线段用到的半径。
//
//   · 内环接缝节点（ring-in-*，半径 290，branch 'ring'）：落在相邻两条主干之间的 6 个 60° 缺口
//     （角度 60/0/-60/-120/-180/120），把相邻两条主干的 arm 连成"网格"，形成环形通路。
//
//   · 每条主干 10 个节点（trunc / hub / stem1 / stem2 / armL / armR / upL / upR / cap / keystone），
//     6 条主干 + 6 个内环接缝 + 3 个传奇 + 1 起点 = **70 节点**，与法师树数量对齐。
//
//   · 传奇节点（kind 'legendary'，branch 'legendary'）：lg-fate(120°,200) / lg-kenji(60°,172) /
//     lg-reap(0°,200)，挂在半径 110~175 的内圈区域，自动寻找最近的两个不同主干的节点连接，
//     作为「早期就能绕到的强力支线」。
//
//   · 每个节点：id / name / kind / x / y / angle / radius / branch / tier / desc / stats / neighbors，
//     notable / keystone / legendary 额外带 notable:{icon, trait}（图鉴 / 传奇词缀展示用）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 二、几何保证（tests 与 tools 脚本校验）
// ═══════════════════════════════════════════════════════════════════════════
//   · 普通边长度 ≤ 175 px（同半径接缝 / 传奇连线 / 主干链路都远小于此）
//   · keystone 边长度 ≤ 165 px
//   · 任意两条边不产生真正的交叉（只有共享端点的边不算交叉）
//   · 任意节点度数 ≤ 6
//   · 任意两个节点间距 ≥ 20 px
//   · 从 START_NODE 出发 BFS 可达全部节点（ensureConnected 兜底保证连通）
// ═══════════════════════════════════════════════════════════════════════════

/** 起点（战士）节点 id，默认已点亮。 */
export const START_NODE = 'start-warrior';

/**
 * 6 条主干。angle 为数学角度（0° = 正右方；y 轴向下时 90° 指向下方，即屏幕正下）。
 * @type {ReadonlyArray<{id:string,name:string,angle:number,color:string,desc:string,faction:string}>}
 */
export const BRANCHES = Object.freeze([
  Object.freeze({ id: 'war', name: '战争', angle: 90, color: '#d9534f', desc: '物理伤害与攻击速度', faction: '战争' }),
  Object.freeze({ id: 'forge', name: '锻造', angle: 30, color: '#c8854a', desc: '护甲与生命', faction: '巨力' }),
  Object.freeze({ id: 'flame', name: '烈焰', angle: 330, color: '#ff8a3c', desc: '火焰伤害与范围', faction: '烈焰' }),
  Object.freeze({ id: 'gale', name: '疾风', angle: 270, color: '#e0503c', desc: '暴击与攻击速度', faction: '狂怒' }),
  Object.freeze({ id: 'death', name: '死亡', angle: 210, color: '#9c6ad9', desc: '掉宝、经验与冷却', faction: '命运' }),
  Object.freeze({ id: 'fate', name: '命运', angle: 150, color: '#4aa3c8', desc: '闪避与生命回复', faction: '守护' }),
]);

/** 半径阶梯（见文件头布局说明）。 */
export const RING_RADII = Object.freeze({
  trunc: 37, hub: 72, stem1: 122, stem2: 180, inner: 290, mid: 372, outer: 448,
});

/** 主干直线段使用的半径（stem1 / stem2）。 */
export const SPOKE_RADII = Object.freeze([122, 180]);

/** 中心区半径。 */
export const CENTER_RADII = Object.freeze({ trunc: 37 });

/** 基石半径。 */
export const KEYSTONE_RADIUS = 600;

/** 是否生成"截断点"（trunc）：起点 → trunc → hub 的短链路。 */
const TRUNC = true;
/** 截断点名字（按主干 id）。 */
const TRUNC_NAMES = { war: '武勇', forge: '体魄', flame: '火种', gale: '锐气', death: '机敏', fate: '坚忍' };
/** 截断点属性（按主干 id）。 */
const TRUNC_STATS = {
  war: { desc: '物理伤害 +4%', stats: { physDamageMult: 0.04 } },
  forge: { desc: '生命 +20', stats: { life: 20 } },
  flame: { desc: '火焰伤害 +4%', stats: { fireDamageMult: 0.04 } },
  gale: { desc: '暴击率 +1%', stats: { critChance: 0.01 } },
  death: { desc: '物品稀有度 +5%', stats: { rarityBonus: 0.05 } },
  fate: { desc: '闪避率 +1.5%', stats: { evasion: 0.015 } },
};
/** 主干左右分叉的角度（度）。 */
const ARM_BEND = 22;
/** hub 节点相对主干角度的偏移（度）。 */
const HUB_OFFSET = 0;

/** @type {any[]} */
const NODES = [];
/** 邻接表（建树时维护，最后一次性写进每个节点的 neighbors）。 */
const ADJ = new Map();

/**
 * 坐标对齐到 2.5 的网格，方便 UI 命中测试与肉眼检查。
 * @param {number} v
 * @returns {number}
 */
function snap(v) {
  return Math.round(v / 2.5) * 2.5;
}

/**
 * 极坐标 → 直角坐标（未取整）。
 * @param {number} angleDeg
 * @param {number} r
 * @returns {{x:number, y:number}}
 */
function polar(angleDeg, r) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

/**
 * 创建一个天赋节点并登记进邻接表。
 * @param {{id:string,name:string,kind:string,angle:number,r:number,branch:string,tier?:number,desc:string,stats?:Object<string,number>,notable?:Object}} def
 * @returns {any}
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
  return n;
}

/**
 * 双向连接两个节点（忽略自连与不存在的 id）。
 * @param {string} a @param {string} b
 */
function link(a, b) {
  if (a === b) return;
  const sa = ADJ.get(a);
  const sb = ADJ.get(b);
  if (!sa || !sb) return;
  sa.add(b);
  sb.add(a);
}

/** id → 节点（建树期间使用，最终导出为冻结对象）。 */
const BY_ID = new Map();

/**
 * 定义一条主干：hub → 2 段直线主干 → 内环带分叉 → 中环带 → cap → keystone。
 * @param {string} branchId
 * @param {{hub:any, stem1:any, stem2:any, armL:any, armR:any,
 *          upL:any, upR:any, cap:any, keystone:any}} def
 */
function defineBranch(branchId, def) {
  const br = BRANCHES.find((b) => b.id === branchId);
  if (!br) throw new Error(`unknown branch: ${branchId}`);
  const A = br.angle;
  const R = RING_RADII;
  /** @type {Array<[string, number, number, number, any]>} */
  const plan = [
    ['stem1', A, R.stem1, 1, def.stem1],
    ['stem2', A, R.stem2, 2, def.stem2],
    ['armL', A - ARM_BEND, R.inner, 3, def.armL],
    ['armR', A + ARM_BEND, R.inner, 3, def.armR],
    ['upL', A - ARM_BEND, R.mid, 4, def.upL],
    ['upR', A + ARM_BEND, R.mid, 4, def.upR],
    ['cap', A, R.outer, 4, def.cap],
  ];
  for (const [suffix, angle, r, tier, nd] of plan) {
    if (!nd) throw new Error(`${branchId}.${suffix} missing`);
    node({
      id: `${branchId}-${suffix}`,
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
  const P = (s) => `${branchId}-${s}`;
  const EDGES = [
    ['stem1', 'stem2'], ['stem2', 'armL'], ['stem2', 'armR'],
    ['armL', 'upL'], ['armR', 'upR'], ['upL', 'cap'], ['upR', 'cap'],
  ];
  for (const [a, b] of EDGES) link(P(a), P(b));

  // hub
  const hub = def.hub;
  node({
    id: P('hub'), name: hub.name, kind: 'minor', angle: A + HUB_OFFSET, r: R.hub,
    branch: branchId, tier: 1, desc: hub.desc, stats: hub.stats, notable: hub.notable,
  });
  link(P('hub'), P('stem1'));

  // trunc
  if (TRUNC) {
    const t = TRUNC_STATS[branchId];
    node({
      id: P('trunc'), name: TRUNC_NAMES[branchId], kind: 'minor', angle: A, r: R.trunc,
      branch: branchId, tier: 1, desc: t.desc, stats: t.stats,
    });
    link(P('trunc'), P('hub'));
  }

  // keystone
  const ks = def.keystone;
  node({
    id: `ks-${branchId}`, name: ks.name, kind: 'keystone', angle: A, r: KEYSTONE_RADIUS,
    branch: 'keystone', tier: 5, desc: ks.desc, stats: ks.stats, notable: ks.notable,
  });
  link(P('cap'), `ks-${branchId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 主干内容（顺序：战争 / 锻造 / 烈焰 / 疾风 / 死亡 / 命运）
// ─────────────────────────────────────────────────────────────────────────────

// 战争（90°）：物理伤害 / 攻击速度 / 范围
defineBranch('war', {
  hub: { name: '磨刀石', desc: '物理伤害 +5%', stats: { physDamageMult: 0.05 } },
  stem1: { name: '刀锋', desc: '物理伤害 +5%', stats: { physDamageMult: 0.05 } },
  stem2: { name: '挥砍', desc: '攻击速度 +3%', stats: { attackSpeedMult: 0.03 } },
  armL: { name: '战争狂热', kind: 'notable', desc: '物理伤害 +12%', stats: { physDamageMult: 0.12 } },
  armR: { name: '横扫千军', desc: '范围效果 +6%', stats: { aoeMult: 0.06 } },
  upL: { name: '血战', desc: '物理伤害 +7%', stats: { physDamageMult: 0.07 } },
  upR: { name: '杀伐', desc: '范围伤害 +8%', stats: { areaDamageMult: 0.08 } },
  cap: { name: '末日裁决', kind: 'notable', desc: '全局伤害 +10%，物理伤害 +8%', stats: { damageMult: 0.1, physDamageMult: 0.08 } },
  keystone: {
    name: '不朽战神',
    desc: '物理伤害 +30%，技能等级 +1\n【代价】攻击速度 -8%',
    stats: { physDamageMult: 0.3, skillLevelBonus: 1, attackSpeedMult: -0.08 },
    notable: { icon: '⚔', trait: '技能等级 +1：所有主动技能视为提升 1 级（伤害与效果同时成长）' },
  },
});

// 锻造（30°）：护甲 / 生命
defineBranch('forge', {
  hub: { name: '铁壁', desc: '护甲 +30', stats: { armor: 30 } },
  stem1: { name: '壮硕', desc: '生命 +25', stats: { life: 25 } },
  stem2: { name: '石肤', desc: '护甲 +50', stats: { armor: 50 } },
  armL: { name: '重甲', desc: '护甲 +80', stats: { armor: 80 } },
  armR: { name: '钢铁之躯', kind: 'notable', desc: '护甲 +100', stats: { armor: 100 } },
  upL: { name: '锻骨', desc: '生命 +70', stats: { life: 70 } },
  upR: { name: '铁衣', desc: '护甲 +120', stats: { armor: 120 } },
  cap: { name: '不灭壁垒', kind: 'notable', desc: '护甲 +350，格挡几率 +5%', stats: { armor: 350, blockChance: 0.05 } },
  keystone: {
    name: '不灭长城',
    desc: '生命 +20%，护甲 +400，格挡几率 +12%\n【代价】移动速度 -12%',
    stats: { life: 420, armor: 400, blockChance: 0.12, moveSpeedMult: -0.12 },
    notable: { icon: '🛡', trait: '格挡几率大幅提升（与装备叠加，上限 75%）：挡下攻击时只受少量伤害' },
  },
});

// 烈焰（330°）：火焰伤害 / 范围
defineBranch('flame', {
  hub: { name: '火花', desc: '火焰伤害 +6%', stats: { fireDamageMult: 0.06 } },
  stem1: { name: '引燃', desc: '持续伤害 +6%', stats: { dotMult: 0.06 } },
  stem2: { name: '炽热', desc: '火焰伤害 +8%', stats: { fireDamageMult: 0.08 } },
  armL: { name: '火山', desc: '范围效果 +6%', stats: { aoeMult: 0.06 } },
  armR: { name: '陨火', desc: '火焰伤害 +10%', stats: { fireDamageMult: 0.1 } },
  upL: { name: '余烬', desc: '火焰伤害 +9%', stats: { fireDamageMult: 0.09 } },
  upR: { name: '灼烧', desc: '持续伤害 +8%', stats: { dotMult: 0.08 } },
  cap: { name: '焚世之火', kind: 'notable', desc: '火焰伤害 +15%，范围效果 +10%', stats: { fireDamageMult: 0.15, aoeMult: 0.1 } },
  keystone: {
    name: '焚世',
    desc: '火焰伤害 +40%，范围效果 +15%，持续伤害 +20%\n【代价】火焰抗性 -20%',
    stats: { fireDamageMult: 0.4, aoeMult: 0.15, dotMult: 0.2, fireResist: -0.2 },
    notable: { icon: '🔥', trait: '范围效果大幅提升：火焰技能判定范围同时扩大（可继续叠加范围词缀）' },
  },
});

// 疾风（270°）：暴击 / 攻击速度
defineBranch('gale', {
  hub: { name: '怒气', desc: '攻击速度 +3%', stats: { attackSpeedMult: 0.03 } },
  stem1: { name: '精准', desc: '暴击率 +2%', stats: { critChance: 0.02 } },
  stem2: { name: '嗜血', desc: '暴击伤害 +10%', stats: { critMulti: 0.1 } },
  armL: { name: '嗜杀', desc: '暴击伤害 +15%', stats: { critMulti: 0.15 } },
  armR: { name: '血怒', desc: '攻击速度 +5%', stats: { attackSpeedMult: 0.05 } },
  upL: { name: '疾锋', desc: '攻击速度 +4%', stats: { attackSpeedMult: 0.04 } },
  upR: { name: '锐利', desc: '暴击率 +3%', stats: { critChance: 0.03 } },
  cap: { name: '无尽愤怒', kind: 'notable', desc: '暴击率 +6%，攻击速度 +6%', stats: { critChance: 0.06, attackSpeedMult: 0.06 } },
  keystone: {
    name: '无限狂怒',
    desc: '攻击速度 +22%，暴击伤害 +40%\n【代价】闪避率 -10%',
    stats: { attackSpeedMult: 0.22, critMulti: 0.4, evasion: -0.1 },
    notable: { icon: '⚡', trait: '攻速越高暴击价值越大：配合「暴击回血」类词缀收益翻倍' },
  },
});

// 死亡（210°）：掉宝 / 经验 / 冷却
defineBranch('death', {
  hub: { name: '幸运', desc: '物品稀有度 +8%', stats: { rarityBonus: 0.08 } },
  stem1: { name: '敏锐', desc: '冷却缩减 +2%', stats: { cdrMult: 0.02 } },
  stem2: { name: '拾荒者', desc: '物品数量 +6%', stats: { quantityBonus: 0.06 } },
  armL: { name: '时之沙', desc: '冷却缩减 +3%', stats: { cdrMult: 0.03 } },
  armR: { name: '幸运符', desc: '物品数量 +10%', stats: { quantityBonus: 0.1 } },
  upL: { name: '祭品', desc: '物品稀有度 +12%', stats: { rarityBonus: 0.12 } },
  upR: { name: '冥思', desc: '冷却缩减 +3%', stats: { cdrMult: 0.03 } },
  cap: { name: '时运主宰', kind: 'notable', desc: '物品稀有度 +30%，冷却缩减 +8%', stats: { rarityBonus: 0.3, cdrMult: 0.08 } },
  keystone: {
    name: '命运的赌徒',
    desc: '物品稀有度 +60%，物品数量 +20%，获得经验 +30%\n【代价】生命 -10%',
    stats: { rarityBonus: 0.6, quantityBonus: 0.2, xpBonus: 0.3, life: -70 },
    notable: { icon: '🎲', trait: '赌博：押注每一次掉落 —— 稀有度越高，传奇出现概率越高' },
  },
});

// 命运（150°）：闪避 / 生命回复 / 格挡
defineBranch('fate', {
  hub: { name: '轻功', desc: '闪避率 +2%', stats: { evasion: 0.02 } },
  stem1: { name: '韧性', desc: '每秒回复 1 点生命', stats: { lifeRegen: 1 } },
  stem2: { name: '疾影', desc: '闪避率 +3%', stats: { evasion: 0.03 } },
  armL: { name: '回春', desc: '每秒回复 1.5 点生命', stats: { lifeRegen: 1.5 } },
  armR: { name: '迅捷', desc: '移动速度 +4%', stats: { moveSpeedMult: 0.04 } },
  upL: { name: '守序', desc: '每秒回复生命 +1.5', stats: { lifeRegen: 1.5 } },
  upR: { name: '清风', desc: '闪避率 +4%', stats: { evasion: 0.04 } },
  cap: { name: '永恒守护', kind: 'notable', desc: '格挡几率 +8%，每秒回复 3 点生命', stats: { blockChance: 0.08, lifeRegen: 3 } },
  keystone: {
    name: '不动如山',
    desc: '格挡几率 +15%，生命每秒回复 +4\n【代价】移动速度 -12%',
    stats: { blockChance: 0.15, lifeRegen: 4, moveSpeedMult: -0.12 },
    notable: { icon: '🗿', trait: '站着不动反而更强：高格挡 + 高回复，适合顶着怪输出' },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 起点：与每条主干的 trunc 节点相连
// ─────────────────────────────────────────────────────────────────────────────
const startNode = node({
  id: START_NODE,
  name: '战士 · 起点',
  kind: 'classStart',
  angle: 0,
  r: 0,
  branch: 'center',
  tier: 0,
  desc: '战士的起点，默认点亮。所有天赋都从这里向外延伸。',
  stats: {},
});
for (const n of NODES.slice()) {
  if (n.id.endsWith('-trunc')) link(startNode.id, n.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 环形接缝节点
// ─────────────────────────────────────────────────────────────────────────────
/** 两条相邻主干之间的 6 个缺口（度）：90→30 是 60°，30→330 是 0°…… */
const GAPS = [60, 0, -60, -120, -180, 120];

/**
 * 角度差归一化到 [0, 360)。
 * @param {number} a @param {number} b
 */
function angleGap(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 360) d = 0;
  return Math.min(d, 360 - d);
}

/**
 * 创建一个"环形接缝"节点：与同半径、角距在 [minDiff, maxDiff] 内的所有已有节点相连。
 * @param {string} id @param {string} name @param {number} angle @param {number} r
 * @param {string} desc @param {Object<string,number>} stats @param {number} tier
 * @param {number} maxDiff @param {number} minDiff
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

// 内环接缝（半径 290）：缺口正中，连上相邻两条主干的 arm 系列
const INNER_JOINTS = [
  { id: 'ring-in-0', gap: 0, name: '战阵', desc: '护甲 +40', stats: { armor: 40 } },
  { id: 'ring-in-1', gap: 1, name: '淬火', desc: '火焰抗性 +6%', stats: { fireResist: 0.06 } },
  { id: 'ring-in-2', gap: 2, name: '炼狱', desc: '持续伤害 +6%', stats: { dotMult: 0.06 } },
  { id: 'ring-in-3', gap: 3, name: '疾行', desc: '移动速度 +5%', stats: { moveSpeedMult: 0.05 } },
  { id: 'ring-in-4', gap: 4, name: '守望', desc: '每秒回复生命 +1', stats: { lifeRegen: 1 } },
  { id: 'ring-in-5', gap: 5, name: '远见', desc: '获得经验 +10%', stats: { xpBonus: 0.1 } },
];
for (const j of INNER_JOINTS) {
  ringJoint(j.id, j.name, GAPS[j.gap], RING_RADII.inner, j.desc, j.stats, 3, 7.5, 6.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// 传奇节点
// ─────────────────────────────────────────────────────────────────────────────
/** 两点距离。 */
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 传奇节点：按距离自动挂到最近的两个不同主干的节点上。
 * @param {string} id @param {string} name @param {number} angle @param {number} r
 * @param {string} desc @param {Object<string,number>} stats @param {{icon:string,trait:string}} notable
 * @param {string|null} linkTo
 */
function legendary(id, name, angle, r, desc, stats, notable, linkTo) {
  const self = node({ id, name, kind: 'legendary', angle, r, branch: 'legendary', tier: 2, desc, stats, notable });
  if (linkTo) link(self.id, linkTo);
  /** @type {any[]} */
  const cands = NODES.filter((n) => n !== self && ADJ.has(n.id) && n.kind !== 'classStart' && n.kind !== 'legendary');
  const sorted = cands.slice().sort((a, b) => dist(a, self) - dist(b, self));
  const first = sorted.find((n) => { const d = dist(n, self); return d >= 110 && d <= 150; }) || null;
  if (first) link(self.id, first.id);
  const second = sorted.find((n) => n !== first && (n.branch !== (first && first.branch)) && !ADJ.get(self.id).has(n.id)
    && (() => { const d = dist(n, self); return d >= 100 && d <= 175; })()) || null;
  if (second) link(self.id, second.id);
  return self;
}

legendary('lg-fate', '天命之瞳', 120, 200,
  '物品稀有度 +35%，获得经验 +25%\n【机制】幸运暴击：暴击判定取两次中较好的一次',
  { rarityBonus: 0.35, xpBonus: 0.25, critChance: 0.03 },
  { icon: '👁', trait: '幸运暴击：每次命中掷两次暴击判定，取更有利的一次（实际暴击率明显提高）' }, null);
legendary('lg-kenji', '血契之躯', 60, 172,
  '生命 +12%，生命偷取 +4%，每秒回复 +2\n【机制】鲜血回响：生命偷取全额生效，输出即回复',
  { life: 260, lifeLeech: 0.04, lifeRegen: 2 },
  { icon: '🩸', trait: '鲜血回响：生命偷取 +4%（全额作用于每一次伤害），越打越血厚' }, null);
legendary('lg-reap', '收割者', 0, 200,
  '暴击伤害 +45%，暴击率 +6%\n【机制】暴击引爆：暴击时对周围造成 60% 的范围爆炸',
  { critMulti: 0.45, critChance: 0.06, areaDamageMult: 0.1 },
  { icon: '💀', trait: '暴击引爆：暴击命中时有概率对周围敌人造成额外范围伤害（配合范围词缀极强）' }, null);

// ─────────────────────────────────────────────────────────────────────────────
// 收尾：id 索引、连通性兜底、写 neighbors、导出
// ─────────────────────────────────────────────────────────────────────────────
for (const n of NODES) BY_ID.set(n.id, n);

/** 从起点 BFS 的可达集合。 */
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

/** 连通性兜底：孤立 / 断开的节点连到最近的已连通节点（正常构建时不会触发）。 */
function ensureConnected() {
  for (let guard = 0; guard < 8; guard++) {
    const seen = bfs(START_NODE);
    const missing = NODES.filter((n) => !seen.has(n.id));
    if (missing.length === 0) return;
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

// 写入 neighbors（按 id 排序，保证确定性）
for (const n of NODES) {
  n.neighbors = Array.from(ADJ.get(n.id) || []).sort();
  Object.freeze(n.stats);
  Object.freeze(n.neighbors);
  if (n.notable) Object.freeze(n.notable);
  Object.freeze(n);
}

/** 全部天赋节点（冻结，按建树顺序）。 */
export const TALENTS = Object.freeze(NODES.slice());

/** 天赋 id → 节点。 */
export const TALENT_BY_ID = Object.freeze(Object.assign(Object.create(null), ...TALENTS.map((n) => ({ [n.id]: n }))));

/** 邻接表（id → 已排序的邻居 id 数组），冻结。 */
export const TALENT_GRAPH = Object.freeze(Object.assign(Object.create(null), ...TALENTS.map((n) => ({ [n.id]: n.neighbors }))));

/**
 * 按 id 取天赋节点。
 * @param {string} id
 * @returns {any|null}
 */
export function talentById(id) {
  return (id && TALENT_BY_ID[id]) || null;
}

/**
 * 邻居节点对象数组。
 * @param {string} id
 * @returns {any[]}
 */
export function neighborsOf(id) {
  const n = TALENT_BY_ID[id];
  if (!n) return [];
  return n.neighbors.map((x) => TALENT_BY_ID[x]).filter(Boolean);
}

/**
 * 从某个节点出发的可达节点集合（BFS）。
 * @param {string} [from=START_NODE]
 * @returns {Set<string>}
 */
export function reachableFrom(from = START_NODE) {
  return bfs(from);
}

/**
 * 能否加点：节点存在、不是起点、且至少有一个相邻节点已点亮。
 * @param {string} id
 * @param {Set<string>|string[]} allocated
 * @returns {boolean}
 */
export function canAllocate(id, allocated) {
  const n = TALENT_BY_ID[id];
  if (!n || !allocated) return false;
  const has = allocated instanceof Set ? (x) => allocated.has(x) : (x) => allocated.indexOf(x) >= 0;
  if (id === START_NODE) return false;
  return n.neighbors.some((nb) => has(nb));
}

/**
 * 汇总已点亮天赋的 stats（数值相加）。
 * @param {Iterable<string>} ids
 * @returns {Object<string, number>}
 */
export function aggregateTalentStats(ids) {
  const out = {};
  if (!ids) return out;
  for (const id of ids) {
    const n = TALENT_BY_ID[id];
    if (!n || !n.stats) continue;
    for (const k in n.stats) {
      const v = n.stats[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      out[k] = (out[k] || 0) + v;
    }
  }
  return out;
}

/**
 * 已点亮节点里的传奇 / 基石特性（图鉴面板用）。
 * @param {Iterable<string>} ids
 * @returns {Array<{id:string,name:string,icon:string,trait:string}>}
 */
export function legendaryTraits(ids) {
  const out = [];
  if (!ids) return out;
  for (const id of ids) {
    const n = TALENT_BY_ID[id];
    if (!n || !n.notable) continue;
    if (n.kind !== 'legendary' && n.kind !== 'keystone') continue;
    out.push({ id: n.id, name: n.name, icon: n.notable.icon || '', trait: n.notable.trait || '' });
  }
  return out;
}

/**
 * 天赋树统计。
 * @returns {{total:number, byKind:Object<string,number>, byBranch:Object<string,number>, edges:number}}
 */
export function talentStats() {
  const byKind = {};
  const byBranch = {};
  let degree = 0;
  for (const n of TALENTS) {
    byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    byBranch[n.branch] = (byBranch[n.branch] || 0) + 1;
    degree += n.neighbors.length;
  }
  return { total: TALENTS.length, byKind, byBranch, edges: degree / 2 };
}

export default {
  TALENTS, START_NODE, talentById, canAllocate, aggregateTalentStats, neighborsOf, reachableFrom, talentStats, legendaryTraits,
};