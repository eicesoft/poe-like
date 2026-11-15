// 存档：localStorage（浏览器）/ 无副作用（Node）。只存"需要持久化"的状态。
import { EQUIP_SLOTS, createInventory } from './inventory.js';

export const SAVE_KEY = 'poe-like-save-v1';

/**
 * 从世界与背包构造可序列化的存档对象。
 *
 * 技能升级系统（契约 §3.4）在 inv 里新增三块状态：
 *   · skillRanks  —— 技能天赋档位 { 'stomp.root': 3, ... }
 *   · skillRefine —— 技能精炼等级 { stomp: 2, ... }（0..4）
 *   · skillOrbs   —— 技能精炼石数量（未花掉的）
 * 这三块都在 inv 里，**不升 version**：老存档（version 1 但没有这些字段）照样能读，
 * 读档时用 readSkillOrbs / normalizeSkillSaveState 兜底成空表 / 0，不会报错。
 */
import { applyPlayerClass } from '../core/index.js';

export function makeSave(world, inv, extra = {}) {
  const p = world.player;
  return {
    version: 1,
    ts: Date.now(),
    world: {
      tier: world.tier,
      career: world.career,
      seed: world.seed,
    },
    player: {
      name: p.name,
      classId: p.type === 'mage' ? 'mage' : 'warrior',
      level: p.level,
      xp: p.xp,
      xpNext: p.xpNext,
      hp: p.hp,
      mp: p.mp,
      baseStats: p.baseStats,
      look: p.look,
      // 法师的成长状态：预设与共鸣（冷却/印记是运行时数据，不入档）
      mage: p.type === 'mage' && p.mage
        ? { preset: p.mage.preset, resonance: p.mage.resonance }
        : undefined,
    },
    inv: {
      equip: inv.equip,
      bag: inv.bag,
      gold: inv.gold,
      talentPoints: inv.talentPoints,
      skillPoints: inv.skillPoints,
      talents: inv.talents,
      skillRanks: inv.skillRanks || {},
      // 以下三项是本轮新增（老存档里没有 → 读取时兜底）
      skillRefine: inv.skillRefine || {},
      skillOrbs: Math.max(0, Math.floor(Number(inv.skillOrbs) || 0)),
    },
    ...extra,
  };
}

/**
 * 老存档兼容：把缺失/损坏的技能升级字段补成安全默认值。
 * 返回**新对象**（不改就地），调用方把它写回 inv 即可。
 *
 * @param {Object|null|undefined} inv 存档里的 inv（或任意疑似 inv）
 * @returns {{skillRanks:Object<string,number>, skillRefine:Object<string,number>, skillOrbs:number}}
 */
export function normalizeSkillSaveState(inv) {
  const src = inv && typeof inv === 'object' ? inv : {};
  /** @type {Object<string,number>} */
  const skillRanks = {};
  const rawRanks = src.skillRanks;
  if (rawRanks && typeof rawRanks === 'object') {
    for (const k in rawRanks) {
      const v = Math.floor(Number(rawRanks[k]));
      if (Number.isFinite(v) && v > 0) skillRanks[k] = v;
    }
  }
  /** @type {Object<string,number>} */
  const skillRefine = {};
  const rawRefine = src.skillRefine;
  if (rawRefine && typeof rawRefine === 'object') {
    for (const k in rawRefine) {
      const v = Math.floor(Number(rawRefine[k]));
      if (Number.isFinite(v) && v > 0) skillRefine[k] = v;
    }
  }
  const orbs = Math.floor(Number(src.skillOrbs));
  return { skillRanks, skillRefine, skillOrbs: Number.isFinite(orbs) && orbs > 0 ? orbs : 0 };
}

/**
 * 便捷读取：存档里的技能精炼石数量（缺失 → 0）。
 * @param {Object|null|undefined} data loadGame() 的返回值
 * @returns {number}
 */
export function readSkillOrbs(data) {
  return normalizeSkillSaveState(data && data.inv).skillOrbs;
}

export function hasStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

export function saveGame(world, inv, extra) {
  if (!hasStorage()) return false;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(makeSave(world, inv, extra)));
    return true;
  } catch {
    return false;
  }
}

export function loadGame() {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !data.player || !data.inv) return null;
    // 兼容 v1 早期存档：技能升级字段缺失时补默认值，并且把数据本身也清洗一遍
    // （非对象 / NaN / 负数直接丢弃，免得后面 doSkillRankUp 在脏数据上算出错等级）
    Object.assign(data.inv, normalizeSkillSaveState(data.inv));
    return data;
  } catch {
    return null;
  }
}

export function clearSave() {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 读档：把 loadGame() 的结果合并进**已经创建好**的 game 对象
// ---------------------------------------------------------------------------
// 为什么是「合并」而不是「用存档重新 createGame」：
//   · createGame 里已经有闭包（recalcPlayer / syncTalentPoints / world.isWalkable / skillMods…）
//     指向具体的 world / inv / player 对象，整体替换引用会让这些闭包指向旧对象（角色变得不会动/不算属性）；
//   · inv 同时被 game.inv 与 world.inventory 指向，只能**逐字段赋值**，不能替换引用。
// 所以 applySave 只做数据搬运 + 重算，返回是否成功。
// ---------------------------------------------------------------------------

/** 有限数字校验：非法值返回 fallback */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 把存档数据合并回已创建的 game（src/game/save.js 只在追加新导出时改动，不改既有函数语义）。
 *
 * 恢复范围：
 *   player —— level / xp / xpNext / hp / mp / gold / talentPoints / look（位置、技能栏、冷却等运行时状态不动）
 *   inv    —— 逐字段覆盖：equip（逐槽）/ bag / gold / talentPoints / skillPoints / talents /
 *             skillRanks / skillRefine / skillOrbs
 *   world  —— tier（存档层数）+ career（刷图统计）
 * 然后 game.recalcPlayer?.() 重算属性、world.__syncTalentPoints?.() 同步天赋点。
 *
 * @param {object} game createGame() 的返回值
 * @param {object} data loadGame() 的返回值（也接受 makeSave 的直接产物）
 * @returns {boolean} 成功返回 true；脏数据 / 参数不对返回 false（调用方应退回全新游戏）
 */
export function applySave(game, data) {
  if (!game || !game.world || !game.inv) return false;
  // 脏数据直接拒绝：validateSave 非空一律不合并（半截存档比没有存档更危险）
  if (validateSave(data).length) return false;
  const world = game.world;
  const p = world.player;
  const inv = game.inv;
  if (!p || typeof p !== 'object') return false;
  const sp = data.player || {};
  const si = data.inv || {};

  try {
    // ---- 1) 职业：老存档没有 classId，按战士处理；职业不同时重建技能栏与法师状态 ----
    const saveClass = sp.classId === 'mage' ? 'mage' : 'warrior';
    if (p.type !== saveClass && typeof applyPlayerClass === 'function') {
      applyPlayerClass(p, saveClass);
    }
    // ---- 2) 玩家 ----
    p.level = Math.max(1, Math.floor(num(sp.level, 1)));
    p.xp = Math.max(0, num(sp.xp, 0));
    p.xpNext = Math.max(0, num(sp.xpNext, p.xpNext || 0));
    p.hp = Math.max(0, num(sp.hp, p.hp || 0));
    p.mp = Math.max(0, num(sp.mp, p.mp || 0));
    if (typeof sp.name === 'string' && sp.name) p.name = sp.name;
    if (sp.look && typeof sp.look === 'object') p.look = { ...sp.look };
    // 法师状态：只恢复非运行时字段
    if (saveClass === 'mage' && p.mage && sp.mage && typeof sp.mage === 'object') {
      if (typeof sp.mage.preset === 'string') p.mage.preset = sp.mage.preset;
      if (Number.isFinite(Number(sp.mage.resonance))) {
        p.mage.resonance = Math.max(0, Math.min(100, Number(sp.mage.resonance)));
      }
    }
    // 天赋点总量（core 的 grantXp 把总点数记在 player.talentPoints 上）
    if (sp.talentPoints != null) p.talentPoints = Math.max(0, Math.floor(num(sp.talentPoints, 0)));
    if (sp.baseStats && typeof sp.baseStats === 'object') p.baseStats = { ...sp.baseStats };

    // ---- 2) 背包/装备：逐字段赋值（不能替换 inv 引用）----
    const defaults = createInventory();
    // 2.1 装备槽：逐槽覆盖；存档里缺的槽位一律视为空
    if (!inv.equip || typeof inv.equip !== 'object') inv.equip = { ...defaults.equip };
    // 先把所有槽位清空再按存档填：createGame 送的新手武器只该出现在**新游戏**里。
    // （注意顺序：清空必须在 recalcPlayer 之前，否则装备统计还会把新手武器算进去。）
    for (const slot of EQUIP_SLOTS) {
      inv.equip[slot.id] = si.equip && si.equip[slot.id] ? si.equip[slot.id] : null;
    }
    // 2.2 背包：整体换数组内容（items 都是纯数据）
    const bag = Array.isArray(si.bag) ? si.bag.filter((it) => it && typeof it === 'object') : [];
    if (Array.isArray(inv.bag)) {
      inv.bag.length = 0;
      for (const it of bag) inv.bag.push(it);
    } else inv.bag = bag.slice();
    // 2.3 货币 / 点数 / 天赋
    inv.gold = Math.max(0, num(si.gold, 0));
    inv.talentPoints = Math.max(0, Math.floor(num(si.talentPoints, 0)));
    if (Array.isArray(si.talents) && si.talents.length) inv.talents = si.talents.slice();
    else if (!Array.isArray(inv.talents) || !inv.talents.length) inv.talents = defaults.talents.slice();
    if (si.skillPoints && typeof si.skillPoints === 'object') inv.skillPoints = { ...si.skillPoints };
    // 2.4 技能升级三件套（缺失字段已在 loadGame 里用 normalizeSkillSaveState 兜底过，这里再兜一次）
    const sk = normalizeSkillSaveState(si);
    inv.skillRanks = sk.skillRanks;
    inv.skillRefine = sk.skillRefine;
    inv.skillOrbs = sk.skillOrbs;

    // ---- 3) 世界：层数 + 刷图统计 ----
    const tier = Math.floor(num(data.world && data.world.tier, world.tier || 1));
    if (tier >= 1) {
      world.tier = tier;
      world.loadMapRequest = true; // 提示调用方：需要 loadMap 到该层
    }
    if (data.world && data.world.career && typeof data.world.career === 'object') {
      const c = data.world.career;
      if (world.career) for (const k in c) if (Number.isFinite(Number(c[k]))) world.career[k] = Number(c[k]);
    }

    // ---- 4) 重算（属性 / 天赋点 / 技能点）----
    if (typeof game.recalcPlayer === 'function') game.recalcPlayer();
    if (typeof world.__syncTalentPoints === 'function') world.__syncTalentPoints();
    // 【必须最后再写一次 hp/mp】recalcStats 会按"缺失量"补血（升级语义：上限涨多少就给多少血），
    // 所以 recalc 之后血量已经被抬高了。当前生命/法力是玩家状态，**不属于属性**，
    // 必须在重算之后再落一次，才能还原玩家"半血"的存档状态。
    p.hp = Math.max(0, num(sp.hp, p.hp));
    p.mp = Math.max(0, num(sp.mp, p.mp));
    // 重算后 maxHp/maxMp 才是"当前等级的"，这时再把血量夹进合法区间
    const maxHp = num(p.maxHp, 0), maxMp = num(p.maxMp, 0);
    if (maxHp > 0) p.hp = Math.max(1, Math.min(p.hp, maxHp));
    if (maxMp > 0) p.mp = Math.max(0, Math.min(p.mp, maxMp));
    if (typeof p.dead === 'boolean' && p.dead) {
      // 存档里可能是死亡瞬间：读档不该让玩家卡在尸体状态
      p.dead = false;
      p.alive = true;
      if (maxHp > 0) p.hp = maxHp * 0.5;
    }
    if (typeof game._lastSkillLevel === 'number') game._lastSkillLevel = p.level;
    return true;
  } catch {
    return false;
  }
}

/**
 * 存档摘要（开始界面 #profile-info 用）。纯展示，不修改任何数据。
 * @param {object|null} data loadGame() 的返回值
 * @returns {null|{level:number,tier:number,gold:number,playTime:number,ts:number,dead:boolean}}
 */
export function getSaveSummary(data) {
  if (!data || validateSave(data).length) return null;
  const p = data.player || {};
  const career = (data.world && data.world.career) || {};
  return {
    level: Math.max(1, Math.floor(num(p.level, 1))),
    classId: p.type === 'mage' ? 'mage' : 'warrior',
    tier: Math.max(1, Math.floor(num(data.world && data.world.tier, 1))),
    gold: Math.max(0, Math.floor(num(data.inv && data.inv.gold, 0))),
    playTime: Math.max(0, num(career.playTime, 0)),
    ts: Math.max(0, num(data.ts, 0)),
    dead: !!p.dead,
  };
}

/** 秒数 → 「1小时23分」/「12分34秒」/「45秒」 */
export function formatPlayTime(sec) {
  const s = Math.max(0, Math.floor(num(sec, 0)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${r} 秒`;
  return `${r} 秒`;
}

/** 时间戳 → 「3 分钟前」/「2024-05-01 12:00」 */
export function formatSaveAge(ts, now = Date.now()) {
  const t = num(ts, 0);
  if (t <= 0) return '';
  const d = Math.max(0, now - t);
  if (d < 60 * 1000) return '刚刚';
  if (d < 3600 * 1000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 24 * 3600 * 1000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 7 * 24 * 3600 * 1000) return `${Math.floor(d / 86400000)} 天前`;
  try {
    const dt = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  } catch {
    return '';
  }
}

/** 校验存档结构（测试用） */
export function validateSave(data) {
  if (!data || typeof data !== 'object') return ['empty'];
  const errs = [];
  if (data.version !== 1) errs.push('version');
  if (!data.player || typeof data.player.level !== 'number') errs.push('player');
  if (!data.inv || !data.inv.equip || !Array.isArray(data.inv.bag)) errs.push('inv');
  if (data.inv?.equip) {
    for (const s of EQUIP_SLOTS) if (!(s.id in data.inv.equip)) errs.push('slot:' + s.id);
  }
  // 技能升级字段：**缺失不算错误**（version 1 兼容），只校验存在时的类型
  const inv = data.inv;
  if (inv) {
    if (inv.skillRanks != null && typeof inv.skillRanks !== 'object') errs.push('skillRanks');
    if (inv.skillRefine != null && typeof inv.skillRefine !== 'object') errs.push('skillRefine');
    if (inv.skillOrbs != null && (typeof inv.skillOrbs !== 'number' || !Number.isFinite(inv.skillOrbs) || inv.skillOrbs < 0)) {
      errs.push('skillOrbs');
    }
  }
  return errs;
}