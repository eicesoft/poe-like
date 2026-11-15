// 游戏应用层：把输入、核心逻辑、渲染、UI、存档串起来。
// 这是「可测试」的部分：不直接触碰 DOM（DOM 相关在 src/ui/main.js）。
import { createWorld, loadMap, isWalkable, randomSpawnPoint } from './world.js';
import { SpatialHash } from '../engine/spatial.js';
import {
  createInventory, equipStats, talentStats, equipItem, unequipItem, addToBag,
  nearestDrop, pickupDrop, bagFull, sortBag, sellItem, EQUIP_SLOTS, SLOT_ACCEPTS,
} from './inventory.js';
import { createPlayer, updateCore, createClassBaseStats } from '../core/index.js';
import { recalcStats, createBaseStats as coreBaseStats } from '../core/stats.js';
import { tryDash, tryBasicAttack, tryCast, releaseChannel, isChanneling } from '../core/skills.js';
import { lockMageTarget, setMagePreset, MAGE_PRESETS, isMage } from '../core/mage.js';
// [data-dev] core 端的「技能 mod 应用」还在 core-dev 手里，可能尚未导出（或者名字不同）。
// 用命名空间导入 + typeof 防御，保证本模块在 core 未就绪时依然能加载、跑测试。
import * as core from '../core/index.js';
import { grantXp, xpForLevel, xpProgress } from '../core/progression.js';
import { collectOrb } from '../core/loot.js';
import { talentTreeFor } from '../items/talentTrees.js';
import {
  SKILL_TREES, SKILL_IDS as TREE_SKILL_IDS, skillNodeById, skillEffectsForSkill,
  skillPointsSpent, canUpgradeSkillNode, skillNodeConflict,
} from '../items/skillTree.js';
import {
  SKILL_LEVEL_CAP, REFINE_MAX,
  refineCost, skillLevelFrom, canRefineSkill, refineSkill, respecCost, respecSkill,
  syncSkillInstances, skillLevelOf, skillRefineOf, skillRanksOf, countAllocatedNodes,
} from '../items/skillProgression.js';
import * as itemgen from '../items/itemgen.js';

/**
 * 技能点曲线：`= 等级` —— **每升 1 级 +1 点**（Lv.1 就有 1 点，Lv.10 = 10 点）。
 *
 * 【历史】原 `floor(level/2)`（10 分钟 Lv.10 只有 5 点，点不满一条分叉）→ `1 + floor(level/2)`；
 * Lead 最新口径：每级 +1 技能点、+2 天赋点（天赋点在 core/progression.js 的
 * TALENT_POINTS_PER_LEVEL）。这样 10 分钟短局能走通两条支线，不再卡在「点不起」。
 *
 * 单独抽成纯函数，app / save / UI / 测试必须共用同一口径（不要各写一份 Math.floor）。
 * @param {number} level 角色等级（<=0 / NaN 视为 0）
 * @returns {number} 技能点总量
 */
export function skillPointsForLevel(level) {
  const lv = Math.max(0, Math.floor(Number(level) || 0));
  return lv;
}

/**
 * 创建游戏应用（headless 可用）
 * @param {{seed?:number, tier?:number, newPlayer?:boolean, classId?:'warrior'|'mage'}} opts
 */
export function createGame(opts = {}) {
  const world = createWorld({ seed: opts.seed });
  world.itemGen = itemgen;

  // ---- 钩子：核心逻辑通过这些回调访问上层能力 ----
  // [playtest 修复] 原写法 `(x, z, r = 0) => ... Math.max(r, 0.32)`：core 的 updatePlayerMovement 用
  // world.isWalkable(nx, nz) 只传 2 个参数（index.js:247），r 会退化成 default 0... 但如果传入
  // undefined（显式 3 参调用）或 NaN，Math.max(NaN, 0.32) = NaN → 判定恒 false → 玩家完全不能移动。
  // 这里对 r 做有限数保护，并且默认值就用玩家半径，保证 2 参/3 参调用都安全。
  world.isWalkable = (x, z, r) => {
    const rad = Number.isFinite(r) && r > 0 ? r : 0.32;
    return isWalkable(world, x, z, Math.max(rad, 0.32));
  };
  world.randomSpawnPoint = (minD = 9, maxD = 16) => randomSpawnPoint(world, minD, maxD, world.rng);
  world.__recalc = (w, e, o) => recalcStats(w, e, o);
  world.__grantXp = (w, e, amount) => grantXp(w, e, amount);
  world.onMonsterKilled = (w, m) => {
    // 掉落由核心的 __coreRollLoot 负责；这里只做统计
    w.career.totalKills++;
  };
  world.skillMods = (skillId) => skillEffectsForSkill(skillId, game.inv.skillRanks);

  const inv = createInventory();
  // 技能升级系统的三块状态（契约 §3.4）。inventory.js 归 core-dev，字段在这里兜底，
  // 这样即使那边还没加上 createInventory 的初始化，本模块也不会读到 undefined。
  if (!inv.skillRanks || typeof inv.skillRanks !== 'object') inv.skillRanks = {};
  if (!inv.skillRefine || typeof inv.skillRefine !== 'object') inv.skillRefine = {};
  if (!Number.isFinite(inv.skillOrbs)) inv.skillOrbs = 0;
  const game = {
    world,
    inv,
    ui: null, // 由 UI 层注入
    talentTree: null, // 创建玩家后按职业填充（warrior / mage 各一棵）
    paused: false,
    slowMo: 0,
    stats: {}, // 面板显示用快照
    dirty: { inv: 0, talents: 0, hud: 0 },
    msgs: [],
    disposeCallbacks: [],
  };
  world.inventory = inv;

  // ---- 玩家 ----
  const player = createPlayer(world, { classId: opts.classId });
  world.player = player;
  if (player.type !== 'mage') {
    player.look = { armorColor: '#8a1f1f', weaponType: 'axe', cape: true };
  }

  // [Lead 修复] 之前 world.all.push(player) 发生在 loadMap 之前，而 loadMap 会清空 world.all，
  // 导致玩家永远不在 world.all 里（渲染层 z 排序/阴影只遍历 world.all → 玩家与部分实体不同步，
  // 传入 world.all 的哈希/查询也会漏掉玩家）。改为换图后再统一登记，并在 loadMap 里保证包含玩家。
  loadMap(world, { tier: opts.tier ?? 1 });
  player.x = world.dungeon.playerStart.x;
  player.z = world.dungeon.playerStart.z;

  // ---- 属性重算 ----
  /**
   * 当前职业的天赋树。读取玩家职业而不是缓存，保证读档换职业后立刻切树。
   * @returns {import('../items/talentTrees.js').WARRIOR_TALENT_TREE|import('../items/talentTrees.js').MAGE_TALENT_TREE}
   */
  function activeTalentTree() {
    return talentTreeFor(player.type);
  }

  function recalcPlayer() {
    const tree = activeTalentTree();
    game.talentTree = tree;
    // 旧存档 / 换职业后可能残留另一棵树的节点：起点不对就重置为该职业起点。
    // （旧版法师存档从来没有花过天赋点，所以重置不会吞掉玩家的点数。）
    if (!Array.isArray(inv.talents) || !inv.talents.includes(tree.start)) {
      inv.talents = [tree.start];
      if (typeof world.__syncTalentPoints === 'function') world.__syncTalentPoints();
    }
    player.talentStats = talentStats(inv, tree.byId);
    player.equipStats = equipStats(inv);
    // baseStats：以核心的等级成长为准，再叠加存储的"额外基础"（存档里的成长）
    const base = createBaseStatsFor(player.level);
    player.baseStats = base;
    // 技能升级系统（天赋 rank / 精炼 → player.skillMods + 技能实例等级）必须在属性重算之前，
    // 因为 syncSkillSystems 可能把天赋里的固定护甲（armorFlat）写进 player.skillStats。
    syncSkillSystems(game);
    world.__recalc(world, player);
    refreshPanel();
  }

  function createBaseStatsFor(level) {
    // 复用核心的成长公式（避免重复维护）；职业不同，生命/法力/武器伤害曲线不同。
    if (typeof createClassBaseStats === 'function') return createClassBaseStats(level, player.type);
    return coreBaseStats(level);
  }

  // 面板统计快照
  function refreshPanel() {
    const s = player.stats || {};
    game.stats = {
      level: player.level,
      life: Math.round(s.life || 0),
      armor: Math.round(s.armor || 0),
      evasion: s.evasion || 0,
      blockChance: s.blockChance || 0,
      dmg: `${Math.round(s.dmgMin || 0)}-${Math.round(s.dmgMax || 0)}`,
      aps: 1.35 * (1 + (s.attackSpeedMult || 0)),
      crit: s.critChance || 0,
      critMulti: s.critMulti || 1.5,
      moveSpeed: 6.2 * (1 + (s.moveSpeedMult || 0)),
      fire: s.fireResist || 0,
      cold: s.coldResist || 0,
      lightning: s.lightningResist || 0,
      chaos: s.chaosResist || 0,
      aoe: s.aoeMult || 0,
      lifeLeech: s.lifeLeech || 0,
      cdr: s.cdrMult || 0,
      xp: xpProgress(player),
    };
    game.dirty.hud++;
  }

  // ---- 初始装备 & 重算 ----
  player.level = 1;
  const initialTree = talentTreeFor(player.type);
  inv.talents = [initialTree.start];
  game.talentTree = initialTree;
  recalcPlayer();
  player.hp = player.maxHp;
  player.mp = player.maxMp;
  // 天赋点：core 的 grantXp 把点记在 player.talentPoints 上；这里做双向同步
  const syncTalentPoints = () => {
    const total = player.talentPoints || 0;
    const tree = talentTreeFor(player.type);
    const spent = inv.talents.filter((t) => t !== tree.start).length;
    inv.talentPoints = Math.max(0, total - spent);
    player.unspentPoints = inv.talentPoints;
    // 技能点：由等级换算总量，再减去已花的（见 skillPointsTotal / skillPointsFor）
    const pts = skillPointsTotal(game);
    inv.skillPoints = { ...(inv.skillPoints || {}), total: pts.total, spent: pts.spent, avail: pts.avail };
    if (pts.total > (world.talentPointsGranted || 0)) world.talentPointsGranted = pts.total;
  };
  world.__syncTalentPoints = syncTalentPoints;
  syncTalentPoints();
  // 送一把新手武器（普通品质）
  const starter = itemgen.generateItem({ rng: world.rng, level: 1, rarity: 'normal', slot: 'weapon' });
  if (starter) {
    starter.name = starter.name + '（新手）';
    equipItem(inv, starter);
  }

  game.recalcPlayer = recalcPlayer;

  return game;
}

/**
 * 主更新（headless 可用）：输入 → 核心 → 拾取/魂火 → 地图循环 → 面板。
 * @param {object} game
 * @param {number} dt
 * @param {object} input { move:{x,z}, aim:{x,z}, attackHeld, attackPressed, skills:[...], dash, pickup }
 */
export function updateGame(game, dt, input = {}) {
  const world = game.world;
  const p = world.player;
  if (world.paused || game.paused) return;
  if (!(dt > 0)) return;

  world.time += dt;
  world.career.playTime += dt;

  // [Lead 修复] 脱困：核心的移动只按"新位置是否完全可走"判定，玩家/怪物被挤到墙角
  // 时这一步永远失败（表现为"卡住不动"）。这里在每次更新前，若玩家已压墙就推到最近的合法位置。
  if (!p.dead) unstickPlayer(world, p);
  // [Lead 修复] 贴墙滑行：玩家正对墙时核心只会拒绝移动（完全不动）。这里把"与墙垂直"的
  // 分量缩放，让角色沿墙滑动（POE/暗黑的贴墙手感），并在完全卡住时给一个切向微移。
  if (!p.dead && input.move && (input.move.x || input.move.z)) {
    slideAlongWall(world, p, input.move);
  }

  // ---- 玩家输入 ----
  if (!p.dead) {
    const prevX = p.x, prevZ = p.z;
    if (input.move) {
      p.moveX = input.move.x;
      p.moveZ = input.move.z;
    }
    if (input.aim) {
      world.aim.x = input.aim.x;
      world.aim.z = input.aim.z;
      p.aim = { x: input.aim.x, z: input.aim.z };
      const dx = input.aim.x - p.x, dz = input.aim.z - p.z;
      const distAim = Math.hypot(dx, dz);
      // [Lead 修复] 原本仅在非攻击时朝向鼠标；导致按住左键时鼠标改变朝向也无效。
      // 现在：只要鼠标与角色的距离足够（> 0.6），就始终朝向鼠标（ARPG 的标准手感）。
      if (distAim > 0.6) p.facing = Math.atan2(dx, dz);
    }
    if (input.dash) tryDash(world, p);
    if (isMage(p)) {
      // 法师：左键 = 锁定目标（不是近战挥砍）。自动循环会优先集火锁定目标。
      if (input.attackPressed) lockMageTarget(world, p, input.aim || world.aim);
    } else if (input.attackHeld || input.attackPressed) {
      if (isChanneling(p)) releaseChannel(world, p);
      // [Lead 修复] 攻击前先朝向鼠标（tryBasicAttack 用 player.facing 判定扇形）
      const adx = (input.aim ? input.aim.x : world.aim.x) - p.x;
      const adz = (input.aim ? input.aim.z : world.aim.z) - p.z;
      if (Math.hypot(adx, adz) > 0.05) p.facing = Math.atan2(adx, adz);
      tryBasicAttack(world, p);
    }
    if (Array.isArray(input.skills)) {
      for (const s of input.skills) if (s) tryCast(world, p, s, world.aim);
    }
    // [Lead 修复] 松开持续施法：只有调用方明确要求（releaseChannels）且当前没有再按技能时才结束
    if (input.releaseChannels && !input.attackHeld) {
      if (isChanneling(p)) releaseChannel(world, p);
    }
    // 记录玩家是否处于旋风斩（渲染层据此画刀光）
    p.whirlspinning = isChanneling(p) && p.skillBar && p.skillBar.some((b) => b && b.id === 'whirlwind' && b.active);
  }

  // ---- 核心逻辑 ----
  updateCore(world, dt);

  // ---- 魂火拾取（吸附 + 自动拾取）----
  updateOrbs(game, dt);
  // ---- 装备光环拾取（所有稀有度靠近自动入包；背包满时留在原地）----
  updateAutoPickup(game);
  // ---- 装备光环吸附：掉落物在 3 单位内缓慢飘向玩家（拾取半径 1.6 才真正入包）----
  updateDropMagnet(game, dt);
  // ---- 自动换上更强的装备 ----
  if (!game.autoEquipDisabled) autoEquipBetter(game);
  // ---- 技能点：升级后技能栏光点需要立刻变化（不能只靠下一次 refreshPanel）----
  // 注意：syncTalentPoints 是 createGame 内部的闭包，updateGame 里拿不到，
  // 只能通过 world 上的钩子调用（createGame 里已挂好 world.__syncTalentPoints）。
  if (p.level !== game._lastSkillLevel) {
    game._lastSkillLevel = p.level;
    if (typeof world.__syncTalentPoints === 'function') world.__syncTalentPoints();
  }

  // ---- 重生 / 回城提示 ----
  if (p.dead && !world.over) {
    world.over = true;
    world.career.totalDeaths++;
    game.ui?.onDeath?.();
  }

  // ---- 面板节流 ----
  game.dirty.hud += dt;
  if (game.dirty.hud > 0.1) refreshPanelThrottled(game);
  if (world.__syncTalentPoints && game.dirty.hud === 0) world.__syncTalentPoints();

  // ---- 事件派发给 UI ----
  if (game.ui && typeof game.ui.onEvents === 'function' && world.events.length) {
    game.ui.onEvents(world.events);
  }
  // 事件由渲染层消费后再清空（主循环在 render 之后调用 clearEvents）
  return world;
}

function refreshPanelThrottled(game) {
  const p = game.world.player;
  const s = p.stats || {};
  game.stats.level = p.level;
  game.stats.life = Math.round(s.life || 0);
  game.stats.armor = Math.round(s.armor || 0);
  game.stats.evasion = s.evasion || 0;
  game.stats.blockChance = s.blockChance || 0;
  game.stats.dmg = `${Math.round(s.dmgMin || 0)}-${Math.round(s.dmgMax || 0)}`;
  game.stats.aps = 1.35 * (1 + (s.attackSpeedMult || 0));
  game.stats.crit = s.critChance || 0;
  game.stats.critMulti = s.critMulti || 1.5;
  game.stats.moveSpeed = 6.2 * (1 + (s.moveSpeedMult || 0));
  game.stats.fire = s.fireResist || 0;
  game.stats.cold = s.coldResist || 0;
  game.stats.lightning = s.lightningResist || 0;
  game.stats.chaos = s.chaosResist || 0;
  game.stats.aoe = s.aoeMult || 0;
  game.stats.lifeLeech = s.lifeLeech || 0;
  game.stats.cdr = s.cdrMult || 0;
  game.stats.xp = xpProgress(p);
  game.dirty.hud = 0;
}

/** 自动拾取光环：靠近的装备自动收入背包（普通/魔法/稀有/传奇都收；背包满时留在原地） */
export function updateAutoPickup(game) {
  const world = game.world;
  const p = world.player;
  if (p.dead) return;
  if (!Array.isArray(world.items)) world.items = [];
  for (let i = world.items.length - 1; i >= 0; i--) {
    const d = world.items[i];
    if (!d) continue;
    const d2 = (d.x - p.x) ** 2 + (d.z - p.z) ** 2;
    if (d2 > ORB_PICKUP_RADIUS * ORB_PICKUP_RADIUS) continue;
    // 技能精炼石（core 的 loot.js 产出 { kind:'skillOrb', amount, x, z }）：
    // 不占背包格，直接进 inv.skillOrbs，所以放在 bagFull 判定之前。
    if (d.kind === 'skillOrb') {
      collectSkillOrb(game, d, i);
      continue;
    }
    if (d2 > PICKUP_RADIUS * PICKUP_RADIUS) continue;
    if (!d.item) continue; // 既不是精炼石也不是装备（未知掉落类型）→ 不动它
    if (bagFull(game.inv)) break;
    const rarity = d.item.rarity;
    if (!pickupDrop(world, game.inv, d)) continue;
    // 黄/橙装也自动拾取后，必须明确告诉玩家「已经进包了」，否则容易以为掉了却没捡到
    if (rarity === 'rare' || rarity === 'unique' || rarity === 'legendary') {
      game.ui?.toast?.(`自动拾取 ${d.item.name}（${RARITY_LABEL[rarity] || '装备'}）`, d.item.color || '#ddd');
    }
    game.ui?.onInventoryChange?.();
  }
}

/**
 * 捡起一颗技能精炼石：inv.skillOrbs += amount，移除掉落，推 skillOrbGain 事件。
 * @param {Object} game
 * @param {Object} drop world.items 里的 { kind:'skillOrb', amount, x, z }
 * @param {number} [idx] 已知下标（不传则 findIndex）
 * @returns {boolean}
 */
export function collectSkillOrb(game, drop, idx) {
  const world = game.world;
  const inv = game.inv;
  if (!drop || drop.kind !== 'skillOrb') return false;
  const amount = Math.max(1, Math.floor(Number(drop.amount) || 1));
  inv.skillOrbs = Math.max(0, Math.floor(Number(inv.skillOrbs) || 0)) + amount;
  const i = Number.isInteger(idx) && idx >= 0 ? idx : world.items.indexOf(drop);
  if (i >= 0 && world.items[i] === drop) world.items.splice(i, 1);
  else {
    const j = world.items.indexOf(drop);
    if (j >= 0) world.items.splice(j, 1);
  }
  pushGameEvent(game, 'skillOrbGain', {
    x: drop.x, z: drop.z,
    amount,
    total: inv.skillOrbs,
    name: '技能精炼石',
    icon: '💠',
  });
  game.ui?.onInventoryChange?.();
  return true;
}

/**
 * 掉落吸附：3 单位内的掉落物朝玩家飘（精炼石更快），让自动拾取不会「差一点点够不着」。
 * 纯表现 + 手感，不影响数据结构；world.items 里只改 x/z。
 * @param {Object} game
 * @param {number} dt
 */
export function updateDropMagnet(game, dt) {
  const world = game.world;
  const p = world.player;
  if (!p || p.dead || !Array.isArray(world.items)) return;
  for (const d of world.items) {
    if (!d) continue;
    const dx = p.x - d.x, dz = p.z - d.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4 || dist > DROP_MAGNET_RADIUS) continue;
    const speed = (d.kind === 'skillOrb' ? 16 : 9) * (1 - dist / DROP_MAGNET_RADIUS) * dt;
    d.x += (dx / dist) * Math.min(speed, dist);
    d.z += (dz / dist) * Math.min(speed, dist);
  }
}

/** 光环拾取半径（背包物品） */
const PICKUP_RADIUS = 1.6;
/** 精炼石拾取半径：比装备大一圈，避免玩家为了捡石头专门走位 */
const ORB_PICKUP_RADIUS = 1.6;
/** 掉落吸附半径 */
const DROP_MAGNET_RADIUS = 3;

/**
 * 自动换装只处理普通/魔法。
 * 稀有/传奇必须留在背包里让玩家自己比较——否则「按 F 拾取 → 下一帧被自动穿上」，
 * 玩家打开背包永远看不到黄/橙装备，会误以为掉落丢了。
 */
const AUTO_EQUIP_RARITIES = new Set(['normal', 'magic']);

/** 如果背包里有比当前装备更强的同部位普通/魔法物品，自动换上（可关闭） */
export function autoEquipBetter(game) {
  const inv = game.inv;
  if (!inv.bag.length) return;
  let changed = false;
  for (let i = inv.bag.length - 1; i >= 0; i--) {
    const item = inv.bag[i];
    if (!item) continue;
    if (!AUTO_EQUIP_RARITIES.has(item.rarity)) continue; // 稀有/传奇：留在背包
    const slotDef = EQUIP_SLOTS.find((s) => SLOT_ACCEPTS[s.id].includes(item.slot));
    if (!slotDef) continue;
    const cur = inv.equip[slotDef.id];
    const newScore = itemgen.itemScore ? itemgen.itemScore(item) : 0;
    const curScore = cur && itemgen.itemScore ? itemgen.itemScore(cur) : -1;
    if (newScore > curScore * 1.02) {
      // equipItem 内部已把被替换的旧装备放回背包；这里再 addToBag 会多出一份重复的旧装备。
      equipItem(inv, item);
      changed = true;
      game.ui?.toast?.(`自动装备 ${item.name}`, item.color || '#ddd');
    }
  }
  if (changed) {
    game.recalcPlayer();
    game.ui?.onInventoryChange?.();
  }
}

/** 拾取/吸附半径常量见文件上方（updateAutoPickup 附近） */

function updateOrbs(game, dt) {
  const world = game.world;
  const p = world.player;
  for (let i = world.lootOrbs.length - 1; i >= 0; i--) {
    const o = world.lootOrbs[i];
    if (o.collected) { world.lootOrbs.splice(i, 1); continue; }
    const dx = p.x - o.x, dz = p.z - o.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 9) {
      // 吸附
      const d = Math.sqrt(d2) || 1;
      const pull = Math.min(1, (3.4 - Math.min(d, 3.4)) / 3.4);
      o.x += (dx / d) * dt * (6 + 14 * pull);
      o.z += (dz / d) * dt * (6 + 14 * pull);
    }
    if (!p.dead && d2 < 0.55 * 0.55) {
      collectOrb(world, p, o);
      world.lootOrbs.splice(i, 1);
    }
  }
}

/**
 * 贴墙滑行：给定期望移动方向，若斜前方被墙挡住，就去掉垂直于墙的分量、只保留切向分量。
 * 这样玩家顶住墙走路时不会"看起来完全卡死"。
 * @param {Object} world
 * @param {Object} p 玩家
 * @param {{x:number,z:number}} move 期望方向（会被就地修改为实际方向）
 */
export function slideAlongWall(world, p, move) {
  const d = world.dungeon;
  if (!d || typeof d.circleWalkable !== 'function') return;
  const r = Math.max(0.3, p.radius ?? 0.45);
  const len = Math.hypot(move.x, move.z);
  if (!(len > 1e-4)) return;
  const probe = 0.28; // 探测距离（世界单位）
  const ux = move.x / len, uz = move.z / len;
  const blocked = (dx, dz) => !d.circleWalkable(p.x + dx * probe, p.z + dz * probe, r);
  if (!blocked(ux, uz)) return; // 前方通畅，保持原方向
  // 两个切向候选
  const tx = -uz, tz = ux;
  const okPos = !blocked(tx, tz), okNeg = !blocked(-tx, -tz);
  if (okPos && okNeg) return; // 两侧都通：让核心自己做轴向滑动
  if (okPos) { move.x = tx * len; move.z = tz * len; return; }
  if (okNeg) { move.x = -tx * len; move.z = -tz * len; return; }
  // 三个方向全堵：尝试 45° 偏移
  for (const s of [1, -1]) {
    const ax = (ux + tx * s) * 0.7071, az = (uz + tz * s) * 0.7071;
    if (!blocked(ax, az)) { move.x = ax * len; move.z = az * len; return; }
  }
  // 全堵：保持方向（由 unstickPlayer 兜底）
}

/** 清理事件（渲染与 UI 消费之后调用） */
export function clearEvents(world) {
  world.events.length = 0;
}

/**
 * 脱困：如果玩家/实体的碰撞圆压在墙里，就沿"最近可走方向"推出来。
 * 原因：core 的移动只接受"新位置完全可走"，一旦嵌进墙里，所有方向的移动都会被拒绝，
 * 表现为"人物卡住不动"（视觉上像是消失/卡死）。这里每个逻辑帧做一次轻量修正。
 * @param {Object} world
 * @param {Object} p 玩家实体
 * @returns {boolean} 是否发生了修正
 */
export function unstickPlayer(world, p) {
  const d = world.dungeon;
  if (!d || typeof d.circleWalkable !== 'function') return false;
  const r = Math.max(0.3, p.radius ?? 0.45);
  if (d.circleWalkable(p.x, p.z, r)) return false;
  // 由内向外按 8 个方向逐步搜索最近的合法点
  for (let dist = 0.12; dist <= 1.6; dist += 0.12) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const nx = p.x + Math.cos(a) * dist;
      const nz = p.z + Math.sin(a) * dist;
      if (d.circleWalkable(nx, nz, r)) {
        p.x = nx;
        p.z = nz;
        p.vx = 0;
        p.vz = 0;
        return true;
      }
    }
  }
  // 半径内找不到：扩大到瓦片级搜索（地图很大时也只需 ~百万次格判定，且只发生在真的嵌墙时）
  for (let rad = 2; rad <= 24; rad++) {
    const [cx0, cz0] = typeof d.toTile === 'function' ? d.toTile(p.x, p.z) : [Math.floor(p.x), Math.floor(p.z)];
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
        const cx = cx0 + dx, cz = cz0 + dz;
        if (d.get(cx, cz) === 1) continue;
        const c = typeof d.toWorld === 'function' ? d.toWorld(cx, cz) : { x: cx + 0.5, z: cz + 0.5 };
        if (d.circleWalkable(c.x, c.z, r)) {
          p.x = c.x;
          p.z = c.z;
          p.vx = 0;
          p.vz = 0;
          return true;
        }
      }
    }
  }
  // 实在找不到：退回到地图上最近的合法瓦片中心
  const near = typeof d.findWalkableNear === 'function' ? d.findWalkableNear(p.x, p.z, 40) : null;
  if (near) {
    p.x = near.x;
    p.z = near.z;
    p.vx = 0;
    p.vz = 0;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 玩法动作（UI 按钮 / 快捷键调用；全部可 headless 测试）
// ---------------------------------------------------------------------------

/** 拾取时用于日志的稀有度中文名 */
const RARITY_LABEL = { normal: '普通', magic: '魔法', rare: '稀有', unique: '传奇', legendary: '传奇' };

/**
 * 拾取身边最近的掉落 -> 背包
 *
 * 只处理「装备类」掉落（d.item 存在）。技能精炼石（kind==='skillOrb'）不占背包格，
 * 由 updateAutoPickup 的自动吸附路径收进 inv.skillOrbs —— 这里必须显式跳过：
 * nearestDrop 会返回 world.items 里的任何元素，如果不加这道判断，
 * pickupDrop 会把一颗没有 .item 的精炼石当成「拾取成功」（addToBag 被 undefined 挡掉，
 * 但掉落物已经从世界里移除），表现为「按 R 捡了东西但背包没变、石头也消失了」。
 *
 * 注意：装备靠近后会被 updateAutoPickup 自动收入背包；F 仍保留为手动补拾
 * （例如背包刚腾出空位、或掉落还在吸附途中），成功拾取时必须给一条日志反馈，
 * 否则「按了 F、背包里却找不到」的错觉会一直存在。
 */
export function doPickup(game) {
  const world = game.world;
  const p = world.player;
  const drop = nearestDrop(world, p.x, p.z, 2.4);
  if (!drop) {
    game.ui?.toast?.('附近没有可拾取的物品');
    return null;
  }
  // 精炼石：顺手捡（走到 2.4 内按 R 也算拾取），走同一套入库逻辑，避免它卡在包里捡不了
  if (drop.kind === 'skillOrb') {
    collectSkillOrb(game, drop);
    return drop;
  }
  if (!drop.item) {
    // 未知掉落类型：不碰它，避免「假拾取」
    game.ui?.toast?.('附近没有可拾取的物品');
    return null;
  }
  if (bagFull(game.inv)) {
    game.ui?.toast?.('背包已满');
    return null;
  }
  pickupDrop(world, game.inv, drop);
  const it = drop.item;
  game.ui?.toast?.(`拾取 ${it.name}（${RARITY_LABEL[it.rarity] || '装备'}）`, it.color || '#ddd');
  game.ui?.onInventoryChange?.();
  return drop;
}

/** 装备背包里的物品（idx 为背包下标） */
export function doEquipFromBag(game, idx) {
  const item = game.inv.bag[idx];
  if (!item) return false;
  const prev = equipItem(game.inv, item);
  if (!prev && !game.inv.equip[findSlotFor(game.inv, item)]) {
    game.ui?.toast?.('无法装备该物品');
    return false;
  }
  // 被替换的旧装备由 equipItem 自己放回背包；这里再 addToBag 会复制一份（背包重复）。
  game.recalcPlayer();
  game.ui?.onInventoryChange?.();
  game.ui?.toast?.(`已装备 ${item.name}`, item.color);
  return true;
}

function findSlotFor(inv, item) {
  return EQUIP_SLOTS.find((s) => SLOT_ACCEPTS[s.id].includes(item.slot))?.id;
}

/** 卸下某槽装备 */
export function doUnequip(game, slotId) {
  if (!unequipItem(game.inv, slotId)) {
    game.ui?.toast?.('背包已满，无法卸下');
    return false;
  }
  game.recalcPlayer();
  game.ui?.onInventoryChange?.();
  return true;
}

/** 出售背包物品 */
export function doSell(game, idx) {
  const item = game.inv.bag[idx];
  if (!item) return 0;
  const gold = sellItem(game.inv, item);
  game.inv.bag.splice(idx, 1);
  game.ui?.onInventoryChange?.();
  game.ui?.toast?.(`出售获得 ${gold} 金币`);
  return gold;
}

/** 一键分解所有普通/魔法物品 */
export function doSellAllJunk(game) {
  let total = 0, n = 0;
  for (let i = game.inv.bag.length - 1; i >= 0; i--) {
    const it = game.inv.bag[i];
    if (it.rarity === 'normal' || it.rarity === 'magic') {
      total += sellItem(game.inv, it);
      game.inv.bag.splice(i, 1);
      n++;
    }
  }
  game.ui?.onInventoryChange?.();
  game.ui?.toast?.(`分解 ${n} 件，获得 ${total} 金币`);
  return total;
}

/**
 * 切换法师自动循环预设（均衡/反应流/蓄积流）。
 * UI 的预设按钮与快捷键都走这里；战士调用返回 null。
 * @param {Object} game
 * @param {'balanced'|'reaction'|'accumulate'} preset
 * @returns {string|null}
 */
export function doSetMagePreset(game, preset) {
  const p = game && game.world && game.world.player;
  if (!isMage(p)) return null;
  const next = setMagePreset(p, preset);
  if (!next) return null;
  const def = MAGE_PRESETS.find((x) => x.id === next);
  game.ui?.toast?.(`循环预设：${def ? def.name : next}`, '#c8a25a');
  return next;
}

/** 天赋节点是否可点（相邻已点 + 有点数）。classId 决定使用哪棵树。 */
export function canTakeTalent(inv, nodeId, classId = 'warrior') {
  if (!nodeId) return false;
  const tree = talentTreeFor(classId);
  if (nodeId === tree.start) return false;
  if (inv.talents.includes(nodeId)) return false;
  const node = tree.byIdOf(nodeId);
  if (!node) return false;
  if (inv.talentPoints <= 0) return false;
  return node.neighbors?.some((n) => inv.talents.includes(n));
}

/** 点亮天赋 */
export function doTakeTalent(game, nodeId) {
  const player = game && game.world && game.world.player;
  const classId = player ? player.type : 'warrior';
  if (!canTakeTalent(game.inv, nodeId, classId)) return false;
  game.inv.talents.push(nodeId);
  game.inv.talentPoints--;
  game.recalcPlayer();
  game.ui?.onTalentsChange?.();
  return true;
}

/** 撤回天赋（只能撤"末端"节点），返还 1 点 */
export function doRefundTalent(game, nodeId) {
  const inv = game.inv;
  const player = game && game.world && game.world.player;
  const tree = talentTreeFor(player ? player.type : 'warrior');
  const i = inv.talents.indexOf(nodeId);
  if (i < 0 || nodeId === tree.start) return false;
  // 若还有已点节点依赖它，不能撤（起点是永久点亮，不算依赖）
  const dependents = tree.nodes.filter((t) => t.id !== tree.start && inv.talents.includes(t.id) && (t.neighbors?.includes(nodeId)));
  // 只有当它是连接路径的末端（没有已点节点把路径延伸出去）才允许——简化：至少有一个已点邻居
  if (dependents.length > 0) return false;
  inv.talents.splice(i, 1);
  inv.talentPoints++;
  game.recalcPlayer();
  game.ui?.onTalentsChange?.();
  return true;
}

/**
 * 技能树：给技能加 1 点。
 *
 * 校验顺序（每一关失败都直接 false，不产生任何副作用）：
 *   1. 技能树 / 节点存在
 *   2. 满档
 *   3. 前置（requires；终极节点是「ROOT 点满 + 左链或右链走通」）
 *   4. 互斥（同 group 已点过别的节点；终极节点不在任何 group 里，所以两条支线都能点它）
 *   5. 可用技能点（cost 可能是 2）
 *
 * 成功后：写 rank → 同步实例等级 → recalcPlayer → 推 'skillRankUp' 事件。
 *
 * @param {Object} game
 * @param {string} skillId
 * @param {string} nodeId 短名（'l1'）或全名（'stomp.l1'）
 * @returns {boolean}
 */
export function doSkillRankUp(game, skillId, nodeId) {
  const inv = game.inv;
  const world = game.world;
  const tree = SKILL_TREES[skillId];
  if (!tree) return false;
  const node = tree.nodes.find((n) => n.id === nodeId || n.key === nodeId || n.id === `${skillId}.${nodeId}`);
  if (!node) return false;
  if (!inv.skillRanks || typeof inv.skillRanks !== 'object') inv.skillRanks = {};
  const cur = Number(inv.skillRanks[node.id]) || 0;
  const max = node.maxRank || 1;
  if (cur >= max) return false;
  // 前置 + 互斥 + 超档：直接用数据层的统一校验，避免 app / UI / core 三处各写一份规则
  const check = canUpgradeSkillNode(skillId, node.id, inv.skillRanks);
  if (!check.ok) return false;
  const cost = Math.max(1, Math.floor(Number(node.cost) || 1));
  if (skillPointsFor(game, skillId) < cost) return false;
  inv.skillRanks[node.id] = cur + 1;
  // 技能等级 = 天赋点 + 精炼，写在 player.skills / skillBar[i].level 上（core 的 skillLevel() 读它）
  syncSkillSystems(game);
  game.recalcPlayer();
  const level = skillLevelOf(inv, skillId);
  pushGameEvent(game, 'skillRankUp', {
    x: world.player?.x, z: world.player?.z,
    skillId,
    name: tree.name,
    nodeId: node.id,
    nodeName: node.name,
    rank: cur + 1,
    maxRank: max,
    level,
    focus: skillFocusOf(skillId, inv.skillRanks),
  });
  game.ui?.onSkillsChange?.();
  return true;
}

/**
 * 精炼技能（消耗技能精炼石，技能等级 +1，上限 5）。
 * 石头数量在 inv.skillOrbs（由击杀掉落 → updateAutoPickup 自动收入）。
 *
 * @param {Object} game
 * @param {string} skillId
 * @returns {boolean}
 */
export function doSkillRefine(game, skillId) {
  const inv = game.inv;
  const world = game.world;
  const tree = SKILL_TREES[skillId];
  if (!tree) return false;
  const before = { level: skillLevelOf(inv, skillId), refine: skillRefineOf(inv, skillId) };
  const cost = canRefineSkill(inv, world.player, skillId).cost;
  if (!refineSkill(inv, world.player, skillId)) {
    const why = canRefineSkill(inv, world.player, skillId).reason;
    if (why) game.ui?.toast?.(why);
    return false;
  }
  game.recalcPlayer();
  pushGameEvent(game, 'skillRefine', {
    x: world.player?.x, z: world.player?.z,
    skillId,
    name: tree.name,
    level: skillLevelOf(inv, skillId),
    refine: skillRefineOf(inv, skillId),
    prevLevel: before.level,
    prevRefine: before.refine,
    cost,
    orbs: inv.skillOrbs,
  });
  game.ui?.onSkillsChange?.();
  return true;
}

/**
 * 重置单个技能的天赋路线（消耗技能精炼石）。
 * 退还该技能全部技能点（技能点是全局共享池，rank 清空即视为退还），**保留精炼等级**。
 *
 * @param {Object} game
 * @param {string} skillId
 * @returns {boolean}
 */
export function doSkillRespec(game, skillId) {
  const inv = game.inv;
  const world = game.world;
  const tree = SKILL_TREES[skillId];
  if (!tree) return false;
  const ranks = skillRanksOf(inv, skillId);
  const nodes = countAllocatedNodes(ranks, skillId);
  if (nodes <= 0) {
    game.ui?.toast?.('该技能还没有投入天赋点');
    return false;
  }
  const refunded = skillPointsSpent(skillId, ranks);
  const cost = respecCost(skillId, ranks);
  if (!respecSkill(inv, world.player, skillId)) {
    game.ui?.toast?.(`技能精炼石不足（重置需要 ${cost}，拥有 ${Math.floor(inv.skillOrbs) || 0}）`);
    return false;
  }
  game.recalcPlayer();
  pushGameEvent(game, 'skillRespec', {
    x: world.player?.x, z: world.player?.z,
    skillId,
    name: tree.name,
    refunded,
    refundedPoints: refunded,
    cost,
    orbs: inv.skillOrbs,
  });
  game.ui?.onSkillsChange?.();
  return true;
}

/**
 * 重算技能系统的派生数据（recalcPlayer 里调用）：
 *   · player.skillMods[skillId] = skillEffectsForSkill(...)（天赋聚合，core 用 skillModsOf 读）
 *   · player.skills[skillId] = { level, refine }（精炼权威值，core 用 refineLevelOf 读）
 *   · skillBar[i].level / .refine
 *   · player.skillStats：天赋里的 fixed 加值（armorFlat），交给 core 的属性聚合
 *
 * 【与 core 的交界（重要）】有效值计算在 core 的 skillsUpgrade.js：
 *   skillLevelOf(player) = 天赋点数 + 精炼 + 1（**它自己会再加一遍精炼**）。
 *   所以这里写出去的 skills[].level 必须**扣掉精炼**（= 1 + 天赋点数），
 *   否则精炼等级会被重复计算（天赋 2 点 + 精炼 2 = 5，再 +2 直接封顶，精炼等于没意义）。
 *   skillBar[i].level 是 core 旧路径（skillInstance.level + skillLevelBonus）读的值，仍然是完整技能等级。
 *   精炼等级不要在 recalc 里从零写：doSkillRefine 会先把 inv.skillRefine +1 再由 recalc 写回 player.skills，
 *   这里两个方向都算一次，保证「先精炼后 recalc」与「直接 recalc」结果一致。
 *
 * core 若导出 applySkillMods，会用它的 applySkillMods(def, mods, level, {stats}) 预演一次最终数值
 * 存进 player.skillValues（供 UI / 调试读），不改变 core 的任何状态。
 *
 * @param {Object} game
 * @returns {void}
 */
export function syncSkillSystems(game) {
  const inv = game.inv;
  const player = game.world?.player;
  if (!player) return;
  if (!player.skillMods || typeof player.skillMods !== 'object') player.skillMods = {};
  if (!player.skills || typeof player.skills !== 'object') player.skills = {};
  if (!player.skillValues || typeof player.skillValues !== 'object') player.skillValues = {};
  // 技能 id 取「技能树 ∪ 技能栏 ∪ 技能定义」，保证 core 换了技能 id（groundSlam → stomp）时两边都覆盖到
  const ids = new Set([...(TREE_SKILL_IDS || [])]);
  if (Array.isArray(player.skillBar)) for (const b of player.skillBar) if (b && b.id) ids.add(b.id);
  if (typeof core.SKILLS === 'object' && core.SKILLS) for (const k in core.SKILLS) ids.add(k);
  // 技能栏实例等级 = 天赋 + 精炼（玩家看到的「Lv.X」）
  syncSkillInstances(inv, player);
  /** @type {Object<string, number>} */
  const mergedStats = {};
  for (const sid of ids) {
    const ranks = skillRanksOf(inv, sid);
    const effects = skillEffectsForSkill(sid, ranks);
    const level = skillLevelOf(inv, sid);
    const refine = skillRefineOf(inv, sid);
    const talentPoints = countAllocatedNodes(ranks, sid);
    const focus = skillFocusOf(sid, ranks);
    // 【focus / flags 的语义（Lead 拍板，契约 §3.2.1）】
    //   · focus —— 当前分支：点了 L1 就是 'left'，点了 R1 就是 'right'（首次选支即确定）。
    //   · flags.focusLeft / flags.focusRight —— **由当前分支推出，与 focus 同步置位**
    //     （首次选支 L1/R1 就置位，不等专精）。这样 core 的 skillFocus(mods) 与 UI 读到的
    //     永远是同一个方向；没选支时两个 flag 都不存在（undefined，而不是 false）。
    //   · 未选中的那一支 key **必须不存在**（不能写 false）：测试与 core 的 skillFlag() 都按
    //     「truthy 才开启」判断，写 false 虽然语义等价但会让 assert(strictEqual(undefined)) 失败；
    //     这里先删掉 effects.flags 里可能残留的两个 key，保证只有选中那支存在。
    const flags = { ...effects.flags };
    delete flags.focusLeft;
    delete flags.focusRight;
    if (focus === 'left') flags.focusLeft = true;
    if (focus === 'right') flags.focusRight = true;
    player.skillMods[sid] = { ...effects, flags, focus };
    // player.skills[sid].level 写「完整技能等级」（1 + 天赋点 + 精炼）。
    // 为什么这里不再额外扣精炼：core 的 skillLevelOf 只有在 player.skills[sid] **缺少 level 字段**时
    // 才走「talentPoints + refine + 1」分支；带了 level 就直接用它（再叠加 stats.skillLevelBonus）。
    // 所以补上完整 level 既满足「精炼立刻生效」，也保证 skillLevelBonus 不会被精炼重复计一遍。
    const prev = player.skills[sid] && typeof player.skills[sid] === 'object' ? player.skills[sid] : {};
    player.skills[sid] = {
      ...prev,
      level,
      refine,
      talentPoints,
      focus,
    };
    for (const k in effects.stats) mergedStats[k] = (mergedStats[k] || 0) + effects.stats[k];
    // 只读预演：用 core 的唯一合成入口算一遍最终数值（没有该导出时跳过）
    const def = typeof core.SKILLS === 'object' && core.SKILLS ? core.SKILLS[sid] : null;
    if (def && typeof core.applySkillMods === 'function') {
      try {
        player.skillValues[sid] = core.applySkillMods(def, effects, level, { stats: player.stats || {}, skillId: sid });
      } catch {
        delete player.skillValues[sid];
      }
    }
  }
  // 技能栏上已不在技能定义里的 id 保留原值；技能定义里的 id 也要有 skills 记录（core 的 refineLevelOf 兜底 0）
  player.skillStats = mergedStats;
  // 天赋里的固定护甲（armorFlat，来自「坚甲 / 铁壁」这类节点）应该算进角色面板。
  // core 的 recalcStats 只合并 baseStats / talentStats / equipStats / buffs，
  // 所以把它并进 talentStats 的副本里（不污染天赋树自身的数据，每帧重建）。
  if (mergedStats.armorFlat) {
    player.talentStats = { ...(player.talentStats || {}), armorFlat: (player.talentStats?.armorFlat || 0) + mergedStats.armorFlat };
  }
  player.skillArmorFlat = mergedStats.armorFlat || 0;
  const pts = skillPointsTotal(game);
  player.skillPoints = pts;
  inv.skillPoints = { ...(inv.skillPoints || {}), total: pts.total, spent: pts.spent, avail: pts.avail };
}

/**
 * 技能点总量（按等级换算）与已花点数。
 * @param {Object} game
 * @returns {{total:number, spent:number, avail:number}}
 */
export function skillPointsTotal(game) {
  const levels = skillPointsForLevel(game.world?.player?.level || 1);
  // 基线：老版本把「技能点总量」存在 inv.skillPoints.total，读档时可能比等级换算值更大
  // （例如后来调低了公式）。取二者较大值，避免玩家已花的点突然变成负数。
  const baseline = Math.max(0, Math.floor(Number(game.inv?.skillPoints?.total) || 0));
  const total = Math.max(levels, baseline);
  const spent = totalSpentSkillPoints(game.inv);
  return { total, spent, avail: Math.max(0, total - spent) };
}

/** 全部技能树已花点数（按 cost × rank 统计，和 skillPointsSpent 同口径） */
function totalSpentSkillPoints(inv) {
  if (!inv || !inv.skillRanks) return 0;
  let spent = 0;
  for (const sid of Object.keys(SKILL_TREES)) spent += skillPointsSpent(sid, skillRanksOf(inv, sid));
  return spent;
}

/**
 * 某技能可用的技能点。
 * 技能点是全技能共享池（契约 §4 保留这个签名）；skillId 参数目前只影响「技能是否存在」的判断，
 * 保留它是为了兼容旧调用方（playtest 工具按技能循环调用）。
 * @param {Object} game
 * @param {string} [_skillId]
 * @returns {number}
 */
export function skillPointsFor(game, _skillId) {
  return skillPointsTotal(game).avail;
}

/**
 * 某技能当前的分支：'left' | 'right' | ''。
 *
 * 判定顺序（宽松 → 严格）：
 *   1. 点了 L4 / R4（分支专精）→ 就是那一支
 *   2. 否则看第一层的「流派」选择：点了 L1 → left，点了 R1 → right
 *      （契约 §3.2 里 fork 组是逐层互斥的，L1/R1 一选就锁死了整条路线，
 *       所以「先点 R1」就足以确定这个技能的流派；UI 也要在玩家刚做选择时就能显示分支）
 *   3. 还没选 → ''
 *
 * @param {string} skillId
 * @param {Record<string, number>} ranks 档位表（全名或短名均可）
 * @returns {'left'|'right'|''}
 */
export function skillFocusOf(skillId, ranks) {
  const tree = SKILL_TREES[skillId];
  if (!tree || !ranks) return '';
  const has = (key) => {
    const node = tree.nodes.find((n) => n.key === key);
    return !!node && (Number(ranks[node.id]) || Number(ranks[key]) || 0) > 0;
  };
  if (has('l4')) return 'left';
  if (has('r4')) return 'right';
  if (has('l1')) return 'left';
  if (has('r1')) return 'right';
  return '';
}

/**
 * 统一的事件推送：优先走 world.emit（world.js 里实现，带 600 条上限），
 * 没有 emit 就退回 world.events.push（headless 测试里可能只有数组）。
 * @param {Object} game
 * @param {string} type
 * @param {Object} [payload]
 */
export function pushGameEvent(game, type, payload = {}) {
  const world = game.world;
  if (!world) return;
  const evt = { type, t: world.time || 0, ...payload };
  try {
    if (typeof world.emit === 'function') {
      // world.emit 判断的是「第一个参数是否对象」来决定 payload 是否生效
      world.emit({ type, ...payload });
      return;
    }
  } catch {
    /* 落到下面的 push */
  }
  if (!Array.isArray(world.events)) world.events = [];
  world.events.push(evt);
  if (world.events.length > 600) world.events.splice(0, world.events.length - 600);
}

/** 重开一张新地图（回城/新图循环） */
export function travelToNewMap(game, tierDelta = 0) {
  const world = game.world;
  const p = world.player;
  // 换图前：把地上剩下的稀有/传奇掉落收进背包（POE 里玩家自己去捡；这里救急防止数据丢失）
  for (let i = world.items.length - 1; i >= 0; i--) {
    const d = world.items[i];
    if (!d || !d.item) continue;
    if (addToBag(game.inv, d.item)) {
      world.items.splice(i, 1);
    } else {
      // 背包满：折算成金币
      const v = Math.round(8 * (d.item.itemLevel || 1) * ({ rare: 6, unique: 20, magic: 2, normal: 1 }[d.item.rarity] ?? 1));
      game.inv.gold += v;
      world.items.splice(i, 1);
    }
  }
  for (const o of world.lootOrbs) if (o && o.kind === 'gold') game.inv.gold += o.value || 0;
  world.career.mapsCleared++;
  world.career.bestTier = Math.max(world.career.bestTier, world.tier);
  const tier = Math.max(1, world.tier + 1 + tierDelta);
  if (!p.dead) {
    // 回城恢复
    p.hp = p.maxHp;
    p.mp = p.maxMp;
  }
  loadMap(world, { tier });
  game.recalcPlayer();
  game.ui?.onInventoryChange?.();
  game.ui?.onMapChange?.();
  return world.map;
}

/** 玩家死亡后复活（原地半血，惩罚：损失经验） */
export function revivePlayer(game) {
  const world = game.world;
  const p = world.player;
  p.dead = false;
  p.alive = true;
  p.hp = p.maxHp * 0.5;
  p.mp = p.maxMp;
  p.spawnGrace = 2.5;
  world.over = false;
  // [Lead 修复] 复活必须清掉所有"卡死状态"：否则上一轮死亡时的施法锁/翻滚/受击动画
  // 会让角色复活后无法移动、也打不出伤害（表现为"人还在但不动、怪也不掉血"）。
  p.castLock = 0;
  p.isDashing = false;
  p.dashTimer = 0;
  p.invuln = 0;
  p.attackTimer = 0;
  p.channelHold = false;
  p.moveX = 0;
  p.moveZ = 0;
  p.vx = 0;
  p.vz = 0;
  p.knockback = null;
  if (typeof p.kbVX === 'number') { p.kbVX = 0; p.kbVZ = 0; p.kbTimer = 0; }
  p.buffs = [];
  p.anim = { state: 'idle', t: 0.3, dur: 0.3, dir: p.facing || 0 };
  p.attackAnim = 0;
  p.hitFlash = 0;
  if (typeof p.energyShield === 'number' && p.stats) p.energyShield = p.stats.energyShield || 0;
  if (Array.isArray(p.skillBar)) {
    for (const inst of p.skillBar) {
      if (!inst) continue;
      inst.active = false;
      inst.holding = false;
      inst.tick = 0;
      inst.elapsed = 0;
      delete inst.castTimeLeft;
    }
  }
  // 死亡惩罚：失去 10% 当前等级经验
  p.xp = Math.max(0, (p.xp || 0) - Math.floor(xpForLevel(p.level) * 0.1));
  // [Lead 修复] 角色必须站在"碰撞圆完全可走"的位置：死亡时可能被打退到墙角/半嵌墙里，
  // 此时任何移动都会被 isWalkable 拒绝（表现为"人活着但完全不动"）。
  if (!world.isWalkable(p.x, p.z, p.radius ?? 0.45)) {
    const near = world.dungeon && typeof world.dungeon.findWalkableNear === 'function'
      ? world.dungeon.findWalkableNear(p.x, p.z, 12)
      : world.randomSpawnPoint(0, 6);
    if (near) { p.x = near.x; p.z = near.z; }
  }
  // 清场（避免复活瞬间被围殴）：把 9 单位内的怪物挪到远处并重置其 AI
  for (const m of world.monsters) if (m && !m.dead) {
    const d = Math.hypot(m.x - p.x, m.z - p.z);
    if (d < 9) {
      const sp = world.randomSpawnPoint(13, 19);
      m.x = sp.x;
      m.z = sp.z;
      m.vx = 0;
      m.vz = 0;
      if (m.ai) {
        m.ai.state = 'chase';
        m.ai.t = 0;
        m.ai.cooldown = 0.5;
        m.ai.stuckT = 0;
        m.ai.farT = 0;
      }
      m.attackTimer = 0.6;
    }
  }
  game.ui?.onRespawn?.();
}

/** 清理事件队列（渲染完再清） */
export { loadMap, SpatialHash };