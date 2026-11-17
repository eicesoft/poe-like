// 装备与背包：装备槽、统计聚合、拾取/穿戴/卸下、背包排序、存档。
// 物品实例由 src/items/itemgen.js 生成；这里只做玩家的"状态"操作。
import { STAT_KEYS } from '../core/stats.js';

export const EQUIP_SLOTS = [
  { id: 'helmet', name: '头盔' },
  { id: 'amulet', name: '项链' },
  { id: 'body', name: '护甲' },
  { id: 'weapon', name: '武器' },
  { id: 'offhand', name: '副手' },
  { id: 'gloves', name: '手套' },
  { id: 'belt', name: '腰带' },
  { id: 'ring1', name: '戒指 I' },
  { id: 'ring2', name: '戒指 II' },
  { id: 'boots', name: '靴子' },
];

/** 槽位 → 允许的物品 slot 类型（戒指可放两格，盾/双手武器放副手） */
export const SLOT_ACCEPTS = {
  helmet: ['helmet'],
  amulet: ['amulet'],
  body: ['body'],
  weapon: ['weapon'],
  offhand: ['shield', 'weapon'],
  gloves: ['gloves'],
  belt: ['belt'],
  ring1: ['ring'],
  ring2: ['ring'],
  boots: ['boots'],
};

export function createInventory() {
  return {
    equip: Object.fromEntries(EQUIP_SLOTS.map((s) => [s.id, null])),
    bag: [],
    bagSize: 60,
    /** 庇护所仓库（家）：与背包同样的装备实例，只是不随身携带 */
    stash: [],
    stashSize: 60,
    gold: 0,
    /** 未分配的天赋点 */
    talentPoints: 0,
    /** 技能树点数：total 为按等级换算的总点数，其余键为旧版遗留 */
    skillPoints: { total: 0 },
    /** 已点天赋节点 id 集合 */
    talents: ['start-warrior'],
    /** 技能树已点 rank：{nodeId: rank} */
    skillRanks: {},
    // ---- 技能升级（契约 §3.4）----
    /** 技能 id → 精炼等级 0..4（用技能精炼石升级） */
    skillRefine: {},
    /** 持有的技能精炼石数量（掉落 kind:'skillOrb' 的 amount 累加进来） */
    skillOrbs: 0,
  };
}

/** 统计物品提供的全部数值（含传奇说明） */
export function itemStats(item) {
  const out = {};
  if (!item) return out;
  if (item.stats) for (const k in item.stats) out[k] = (out[k] ?? 0) + (item.stats[k] || 0);
  if (item.mods) for (const m of item.mods) if (m.stats) for (const k in m.stats) out[k] = (out[k] ?? 0) + (m.stats[k] || 0);
  if (item.implicit?.stats) for (const k in item.implicit.stats) out[k] = (out[k] ?? 0) + (item.implicit.stats[k] || 0);
  // 武器基础伤害
  if (item.dmgMin != null && item.dmgMax != null) {
    out.dmgMin = (out.dmgMin ?? 0) + item.dmgMin;
    out.dmgMax = (out.dmgMax ?? 0) + item.dmgMax;
  }
  return out;
}

/** 计算所有已装备物品的合计统计 */
export function equipStats(inv) {
  const out = {};
  for (const id in inv.equip) {
    const it = inv.equip[id];
    if (!it) continue;
    const s = itemStats(it);
    for (const k in s) out[k] = (out[k] ?? 0) + s[k];
  }
  return out;
}

/** 天赋节点合计统计（talentNodes 为 {id: node} 或数组） */
export function talentStats(inv, talentNodes) {
  const out = {};
  for (const id of inv.talents) {
    const node = talentNodes[id];
    if (!node || !node.stats) continue;
    for (const k in node.stats) out[k] = (out[k] ?? 0) + node.stats[k];
  }
  return out;
}

let uidCounter = 0;
export function newItemUid() {
  uidCounter = (uidCounter + 1) % 1e9;
  return 'i' + Date.now().toString(36) + uidCounter.toString(36);
}

/** 把物品放进背包，返回是否成功 */
export function addToBag(inv, item) {
  if (inv.bag.length >= inv.bagSize) return false;
  if (!item.uid) item.uid = newItemUid();
  inv.bag.push(item);
  return true;
}

/** 仓库容量（旧存档没有 stashSize 时的兜底）。 */
export function stashSizeOf(inv) {
  const n = Number(inv && inv.stashSize);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

/**
 * 背包 → 仓库。成功返回物品，失败返回 null。
 * 失败原因：下标无效 / 仓库已满。
 */
export function depositToStash(inv, bagIndex) {
  if (!inv || !Array.isArray(inv.bag)) return null;
  if (!Array.isArray(inv.stash)) inv.stash = [];
  const item = inv.bag[bagIndex];
  if (!item) return null;
  if (inv.stash.length >= stashSizeOf(inv)) return null;
  inv.bag.splice(bagIndex, 1);
  inv.stash.push(item);
  return item;
}

/**
 * 仓库 → 背包。成功返回物品，失败返回 null。
 * 失败原因：下标无效 / 背包已满。
 */
export function withdrawFromStash(inv, stashIndex) {
  if (!inv || !Array.isArray(inv.stash)) return null;
  const item = inv.stash[stashIndex];
  if (!item) return null;
  if (inv.bag.length >= inv.bagSize) return null;
  inv.stash.splice(stashIndex, 1);
  inv.bag.push(item);
  return item;
}

// 全局不变量守护：任何时刻 equip 槽位集合必须保持 10 个键（防止某处误用 Object.fromEntries/删除键导致槽位丢失）
export function checkInvariant(inv) {
  for (const s of EQUIP_SLOTS) if (!(s.id in inv.equip)) return false;
  return true;
}

/** 选择装备槽：主槽（与物品 slot 同名）→ 空槽 → 主槽替换 */
export function selectEquipSlot(inv, item) {
  if (!item) return null;
  if (!EQUIP_SLOTS.some((s) => SLOT_ACCEPTS[s.id].includes(item.slot))) return null;
  const primary = EQUIP_SLOTS.find((s) => s.id === item.slot) || EQUIP_SLOTS.find((s) => SLOT_ACCEPTS[s.id].includes(item.slot));
  const primaryId = primary ? primary.id : null;
  // 主槽空 → 放主槽
  if (primaryId && !inv.equip[primaryId]) return primaryId;
  // 否则找任意空槽（weapon→offhand、ring→ring2）
  for (const s of EQUIP_SLOTS) {
    if (SLOT_ACCEPTS[s.id].includes(item.slot) && !inv.equip[s.id]) return s.id;
  }
  // 都满：替换主槽
  return primaryId;
}

/**
 * 返回物品应当放入的装备槽 id；优先空槽（戒指有 ring1/ring2），没有空槽时返回主槽。
 * @param {{equip:Object}} inv 背包状态
 * @param {Object} item
 */
export function slotForItem(inv, item) {
  if (!item) return null;
  const empty = EQUIP_SLOTS.find((s) => SLOT_ACCEPTS[s.id].includes(item.slot) && !inv.equip[s.id]);
  if (empty) return empty.id;
  const any = EQUIP_SLOTS.find((s) => SLOT_ACCEPTS[s.id].includes(item.slot));
  return any ? any.id : null;
}

/**
 * 装备：把 item 放到对应槽（优先空槽；戒指优先 ring1/ring2；武器会先尝试 weapon，再尝试 offhand）。
 * 返回被替换的物品（没有则 null）。被替换的旧装备自动回到背包。
 * 传入 slotId 可强制指定槽位。
 */
export function equipItem(inv, item, slotId = null) {
  if (!item) return null;
  let target = slotId;
  if (!target || !SLOT_ACCEPTS[target] || !SLOT_ACCEPTS[target].includes(item.slot)) target = selectEquipSlot(inv, item);
  if (!target) return null;
  if (!(target in inv.equip)) return null;
  const prev = inv.equip[target] || null;
  if (prev === item) return null;
  const idx = inv.bag.indexOf(item);
  if (idx >= 0) inv.bag.splice(idx, 1);
  inv.equip[target] = item;
  if (prev && !inv.bag.includes(prev)) inv.bag.push(prev);
  return prev;
}

/** 调试用：与 equipItem 完全一致的槽位选择结果 */
export function debugEquipTarget(inv, item) {
  if (!item || !EQUIP_SLOTS.some((s) => SLOT_ACCEPTS[s.id].includes(item.slot))) return null;
  const primary = EQUIP_SLOTS.find((s) => s.id === item.slot) || EQUIP_SLOTS.find((s) => SLOT_ACCEPTS[s.id].includes(item.slot));
  const primaryId = primary ? primary.id : null;
  let t = primaryId && !inv.equip[primaryId] ? primaryId : null;
  if (!t) {
    const empty = EQUIP_SLOTS.find((s) => SLOT_ACCEPTS[s.id].includes(item.slot) && !inv.equip[s.id]);
    t = empty ? empty.id : null;
  }
  return t || primaryId;
}

/** 卸下装备到背包 */
export function unequipItem(inv, slotId) {
  const it = inv.equip[slotId];
  if (!it) return false;
  if (inv.bag.length >= inv.bagSize) return false;
  inv.equip[slotId] = null;
  inv.bag.push(it);
  return true;
}

/** 出售价格（纯函数，不改金币；稀有度/物等决定） */
export function sellPrice(item) {
  if (!item) return 0;
  const value = 5 * (item.itemLevel || 1) * ({ normal: 1, magic: 2.5, rare: 8, unique: 30 }[item.rarity] ?? 1);
  return Math.round(value);
}

/** 出售物品获得金币 */
export function sellItem(inv, item) {
  const value = sellPrice(item);
  inv.gold += value;
  return value;
}

/** 自动拾取：把世界里的掉落物收进背包。
 * 技能精炼石（kind:'skillOrb'，契约 §3.5）不是装备：直接累加到 inv.skillOrbs，不占背包格子。
 * 这样即使背包满了、或者调用方忘了先判断，也不会把精炼石当成装备塞进 bag（那会污染 UI 的物品格）。 */
export function pickupDrop(world, inv, drop) {
  if (drop && drop.kind === 'skillOrb' && !drop.item) {
    inv.skillOrbs = (inv.skillOrbs || 0) + (drop.amount || 1);
    const idx = world.items.indexOf(drop);
    if (idx >= 0) world.items.splice(idx, 1);
    world.emit?.('skillOrbPick', { x: drop.x, z: drop.z, amount: drop.amount || 1, total: inv.skillOrbs });
    return true;
  }
  const item = drop.item;
  if (!addToBag(inv, item)) return false;
  const idx = world.items.indexOf(drop);
  if (idx >= 0) world.items.splice(idx, 1);
  world.emit?.('pickup', { x: drop.x, z: drop.z, item });
  return true;
}

/** 最近的可拾取物（只找装备：world.items 里可能混着技能精炼石，它们由精炼石拾取逻辑处理） */
export function nearestDrop(world, x, z, radius = 2.2) {
  let best = null;
  let bestD = radius * radius;
  for (const d of world.items) {
    if (!d || d.kind === 'skillOrb') continue;
    const dd = (d.x - x) ** 2 + (d.z - z) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  return best;
}

export function bagFull(inv) {
  return inv.bag.length >= inv.bagSize;
}

/** 排序背包：稀有度 > 等级 > 名字 */
const RARITY_ORDER = { unique: 4, rare: 3, magic: 2, normal: 1 };
export function sortBag(inv, mode = 'rarity') {
  inv.bag.sort((a, b) => {
    if (mode === 'rarity') {
      const r = (RARITY_ORDER[b.rarity] ?? 0) - (RARITY_ORDER[a.rarity] ?? 0);
      if (r) return r;
      return (b.itemLevel ?? 0) - (a.itemLevel ?? 0);
    }
    if (mode === 'slot') return String(a.slot).localeCompare(String(b.slot)) || ((b.itemLevel ?? 0) - (a.itemLevel ?? 0));
    return 0;
  });
}

/** 在 STAT_KEYS 里补齐缺省值，避免 NaN */
export function normalizeStats(stats) {
  const out = {};
  for (const k of STAT_KEYS) out[k] = stats[k] ?? 0;
  return out;
}