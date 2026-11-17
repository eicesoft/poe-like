// 庇护所（家）：交互点、商人库存、赌徒玩法。
//
// 家是一张 tier 0 的安全地图（dungeon.generateHomeDungeon），没有怪物与地图词缀。
// 这里只放**纯逻辑**：交互点数据 / 商店 / 赌博 / 购买校验；UI 在 src/ui/home-ui.js。
import { addToBag, bagFull, sellPrice, stashSizeOf } from './inventory.js';
import { generateItem } from '../items/itemgen.js';
import { RNG } from '../engine/rng.js';

/** 仓库格的展示上限（与 inventory.stashSize 保持一致） */
export const HOME_STASH_SIZE = 60;

/** 赌徒基础费用：等级越高，赌注越大（但产出物等也跟随等级） */
export function gambleCost(player) {
  const lv = Math.max(1, Math.floor(Number(player && player.level) || 1));
  return Math.round(40 + lv * 25);
}

/**
 * 把地牢里的 homeSpots 转成可渲染 / 可交互的对象。
 * @param {import('./dungeon.js').Dungeon|null} dungeon
 * @returns {Array<{id:string,kind:string,name:string,icon:string,color:string,tip:string,x:number,z:number,range:number}>}
 */
export function createHomeInteractables(dungeon) {
  const spots = dungeon && dungeon.homeSpots;
  if (!spots) return [];
  const defs = [
    {
      id: 'home-stash', kind: 'stash', name: '仓库', icon: '📦', color: '#d8b56a',
      tip: '存入 / 取出装备', spot: spots.stash, range: 2.5,
    },
    {
      id: 'home-merchant', kind: 'merchant', name: '商人', icon: '🪙', color: '#7fd4ff',
      tip: '购买 / 出售装备', spot: spots.merchant, range: 2.5,
    },
    {
      id: 'home-gambler', kind: 'gambler', name: '赌徒', icon: '🎲', color: '#c9a0ff',
      tip: '用金币赌一件装备', spot: spots.gambler, range: 2.5,
    },
    {
      id: 'home-portal', kind: 'portal', name: '战斗之门', icon: '🌀', color: '#ff9a3c',
      tip: '开启战斗地图', spot: spots.portal, range: 3.2,
    },
  ];
  return defs.map((def) => ({
    id: def.id,
    kind: def.kind,
    name: def.name,
    icon: def.icon,
    color: def.color,
    tip: def.tip,
    x: def.spot.x,
    z: def.spot.z,
    range: def.range,
  }));
}

/**
 * 找玩家附近最近的交互点（家地图专用）。
 * @param {object} world
 * @param {number} x
 * @param {number} z
 * @param {number} [radius] 统一搜索半径（交互点自己的 range 仍会参与判定）
 * @returns {object|null}
 */
export function nearestHomeInteractable(world, x, z, radius = 3.2) {
  const list = world && world.interactables;
  if (!Array.isArray(list) || !list.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const it of list) {
    if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.z)) continue;
    const reach = Math.min(radius, Number.isFinite(it.range) ? it.range : radius);
    const d = Math.hypot(it.x - x, it.z - z);
    if (d <= reach && d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

/**
 * 生成商人库存（每次回家刷新一次；买走后该项消失）。
 * 物品等级跟随玩家等级，稀有度混合：普通 / 魔法 / 稀有。
 * @param {object} world
 * @returns {Array<object>}
 */
export function restockMerchant(world) {
  const p = (world && world.player) || {};
  const level = Math.max(1, Math.floor(Number(p.level) || 1));
  const seed = ((world && world.seed) || 1) >>> 0;
  const restock = Math.max(1, Number(world && world.homeRestock) || 1);
  // 每次回城换一批货（同一趟内买空后再次调用仍用同一批种子，不会“无限重掷”）
  const rng = new RNG((seed ^ 0x5f3759df ^ Math.imul(restock, 0x9e3779b1)) >>> 0);
  const slots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'belt', 'ring', 'amulet'];
  const rarities = ['magic', 'magic', 'rare', 'normal', 'magic', 'rare', 'magic', 'rare'];
  const items = [];
  for (let i = 0; i < slots.length; i++) {
    const item = generateItem({
      rng,
      level: Math.max(1, level + (i % 3) - 1),
      rarity: rarities[i],
      slot: slots[i],
    });
    if (item) items.push(item);
  }
  if (world) world.homeStock = items;
  return items;
}

/** 取商人库存（没有就现生成一份） */
export function merchantStock(world) {
  if (!world) return [];
  if (!Array.isArray(world.homeStock) || !world.homeStock.length) return restockMerchant(world);
  return world.homeStock;
}

/** 商人售价：比卖给商人贵得多，但仍是早期可负担的成长途径。 */
export function merchantPrice(item) {
  if (!item) return 0;
  return Math.max(25, Math.round(sellPrice(item) * 3.5 + 10));
}

/**
 * 购买商人库存中的第 index 件。
 * @returns {{ok:boolean, reason?:string, item?:object, price?:number}}
 */
export function buyMerchantItem(game, index) {
  const world = game && game.world;
  const inv = game && game.inv;
  const stock = merchantStock(world);
  const item = stock[index];
  if (!item) return { ok: false, reason: 'missing' };
  const price = merchantPrice(item);
  if ((inv.gold || 0) < price) return { ok: false, reason: 'gold', item, price };
  if (bagFull(inv)) return { ok: false, reason: 'bag', item, price };
  inv.gold -= price;
  addToBag(inv, item);
  stock.splice(index, 1);
  return { ok: true, item, price };
}

/**
 * 赌徒：支付金币，按概率翻出装备。
 * 结果：
 *   · 45% 什么也没有
 *   · 33% 魔法
 *   · 16% 稀有
 *   ·  6% 传奇（unique 档）
 * 背包满 / 金币不足时**不扣钱**。
 * @returns {{ok:boolean, reason?:string, cost:number, item?:object|null, rarity?:string|null}}
 */
export function gamble(game) {
  const world = game && game.world;
  const inv = game && game.inv;
  const p = (world && world.player) || {};
  const cost = gambleCost(p);
  if ((inv.gold || 0) < cost) return { ok: false, reason: 'gold', cost };
  if (bagFull(inv)) return { ok: false, reason: 'bag', cost };

  inv.gold -= cost;
  const rng = world.rng || new RNG(((world.seed || 1) ^ 0x9e3779b9) >>> 0);
  const roll = rng.next();
  let rarity = null;
  if (roll >= 0.45) {
    rarity = roll < 0.78 ? 'magic' : roll < 0.94 ? 'rare' : 'unique';
  }
  if (!rarity) return { ok: true, cost, item: null, rarity: null };

  const item = generateItem({
    rng,
    level: Math.max(1, Math.floor(Number(p.level) || 1)),
    rarity,
    // 赌徒的稀有度再小幅上浮，让“赌”有明确的正期望感
    rarityBonus: 0.15,
  });
  if (!item) return { ok: true, cost, item: null, rarity: null };
  addToBag(inv, item);
  return { ok: true, cost, item, rarity };
}

/** 仓库剩余格数（UI 用） */
export function stashFreeSlots(inv) {
  return Math.max(0, stashSizeOf(inv) - ((inv && inv.stash && inv.stash.length) || 0));
}