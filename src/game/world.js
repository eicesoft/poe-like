// 世界构建：把地牢、核心系统、装备、地图词缀/怪物缩放全部组装在一起。
// 同时承担 POE 的「刷图循环」：死亡/回城 → 生成新随机地图（词缀更强、怪物更高级）。
import { generateDungeon, generateHomeDungeon, rollMapMods, mapNameFor, MAP_MODS, MAP_THEMES } from './dungeon.js';
import { createHomeInteractables } from './home.js';
import { RNG, hashString } from '../engine/rng.js';
import { SpatialHash } from '../engine/spatial.js';

/**
 * 创建游戏世界（不启动主循环）。所有字段都是纯数据，可序列化部分见 save.js。
 * @param {object} opts { seed, tier, playerLevel, save, systems }
 */
export function createWorld(opts = {}) {
  const seed = (opts.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
  const world = {
    seed,
    rng: new RNG(seed),
    time: 0,
    events: [],
    // 集合
    monsters: [],
    projectiles: [],
    groundEffects: [],
    summoned: [],
    items: [],
    lootOrbs: [],
    particles: [],
    all: [],
    hash: new SpatialHash(2),
    // 玩家与地图
    player: null,
    dungeon: null,
    map: null,
    interactables: [],
    homeStock: null,
    /** 商人补货次数：每次回家 +1，让库存随回城次数变化（避免每次回城都是同一批货） */
    homeRestock: 0,
    /** 从家的战斗之门进入时使用的层数（离开战斗地图时记住，回城后可以继续） */
    homeNextTier: 1,
    tier: opts.tier ?? 0,
    // 图层统计
    career: { mapsCleared: 0, totalKills: 0, totalDeaths: 0, playTime: 0, bestTier: 1, totalGold: 0 },
    // 输入/相机目标
    cameraTarget: { x: 0, z: 0 },
    aim: { x: 0, z: 1 },
    paused: false,
    over: false,
    cleared: false,
    busy: 0,
    mapMods: {}, // 汇总后的地图词缀数值
  };
  world.emit = (typeOrEvt, payload = {}) => {
    // 兼容两种调用：emit('hit', {...}) 或 emit({type:'hit', ...})
    const evt = typeof typeOrEvt === 'string' ? { ...payload, type: typeOrEvt } : { ...typeOrEvt };
    world.events.push(evt);
    if (world.events.length > 600) world.events.splice(0, world.events.length - 600);
  };
  return world;
}

/** 汇总地图词缀数值 { monsterSpeed: 0.25, itemQuantity: 0.8, ... } */
export function aggregateMapMods(mods) {
  const out = {};
  for (const m of mods) {
    if (m.type === 'vision') {
      out.vision = (out.vision ?? 0) + m.value;
      continue;
    }
    out[m.type] = (out[m.type] ?? 0) + m.value;
  }
  return out;
}

/**
 * 生成一张地图并把玩家放到入口。
 * tier 0（或 home:true）= 庇护所：安全大厅 + 仓库/商人/赌徒/战斗之门，不刷怪、不掷词缀。
 * tier ≥ 1 = 战斗地图。
 * @param {object} world
 * @param {{tier?:number, seed?:number|null, dungeon?:object|null, roomies?:any, home?:boolean|null}} [opts]
 */
export function loadMap(world, { tier = world.tier, seed = null, dungeon = null, roomies = null, home = null } = {}) {
  const isHome = home === true || (home !== false && Number(tier) <= 0);
  const tierNum = isHome ? 0 : Math.max(1, Math.floor(Number(tier) || 1));
  // [Lead 修复] 地图等级不再固定取"加载瞬间的玩家等级"（会导致 Boss 永远是 lv1），
  // 而是随层数提高，并给一点成长跟随：level = max(tier*2, 玩家等级-1)
  const level = isHome ? 1 : Math.max(tierNum * 2, (world.player ? world.player.level : 1) - 1);
  const s = (seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
  const mapRng = new RNG(hashString('map' + s) ^ (tierNum * 2654435761 >>> 0));
  world.seed = s;
  world.tier = tierNum;
  const mods = isHome ? [] : rollMapMods(mapRng, tierNum * 2 + 2);
  const d = dungeon ?? (isHome
    ? generateHomeDungeon({ seed: s })
    : generateDungeon({ seed: s, level: tierNum * 2 + level * 0.5, size: tierNum <= 2 ? 'small' : tierNum <= 5 ? 'medium' : 'large' }));
  world.dungeon = d;
  world.map = {
    id: s,
    tier: tierNum,
    level,
    name: isHome ? '庇护所' : mapNameFor(d.theme, tierNum),
    theme: d.theme,
    mods: mods.map((m) => ({ id: m.id, name: m.name, text: m.text, type: m.type, value: m.value })),
    isBoss: false,
    isHome,
  };
  world.mapMods = isHome ? {} : aggregateMapMods(world.map.mods);
  // 家的交互点：仓库 / 商人 / 赌徒 / 战斗之门（战斗地图清空）
  world.interactables = isHome ? createHomeInteractables(d) : [];
  // 每次回家都刷新商人库存（补货游标 +1，货品与上次不同）
  if (isHome) {
    world.homeStock = null;
    world.homeRestock = (Number(world.homeRestock) || 0) + 1;
  }
  world.cleared = false;
  world.over = false;
  world.busy = 0;

  // 清理场上所有动态对象
  world.monsters.length = 0;
  world.projectiles.length = 0;
  world.groundEffects.length = 0;
  world.summoned.length = 0;
  world.items.length = 0;
  world.lootOrbs.length = 0;
  world.particles.length = 0;
  world.all.length = 0;

  // 起点与玩家位置
  const start = d.playerStart ?? { x: d.cols / 2, z: d.rows / 2 };
  if (world.player) {
    world.player.x = start.x;
    world.player.z = start.z;
    world.player.vx = 0;
    world.player.vz = 0;
    world.player.dead = false;
    world.player.alive = true;
    world.player.hp = world.player.maxHp;
    world.player.mp = world.player.maxMp;
    world.player.cooldowns = {};
    world.player.buffs = [];
    world.player.spawnGrace = 1.5;
    // [Lead 修复] world.all 清空后必须重新登记玩家（渲染层 z 排序、阴影、调试与部分查询都依赖它）
    if (!world.all.includes(world.player)) world.all.unshift(world.player);
    if (world.hash && typeof world.hash.insert === 'function') world.hash.insert(world.player);
  }

  world.stats = {
    kills: 0,
    waves: 0,
    waveActive: false,
    spawnTimer: 1.2,
    aliveCount: 0,
    elitesKilled: 0,
    bossKilled: 0,
    bossAlive: false,
    eliteWaveTimer: 15,
    bossWaveTimer: 25,
    startTime: world.time,
    killsForNextWave: 0,
  };
  // [Lead 修复] 刷怪器内部有"本刷怪器是否已初始化"的懒加载标记；
  // 换图时必须让它重新初始化（否则新地图沿用旧地图的波次/计时/存活上限 → 新图不刷怪或刷怪节奏错乱）。
  world.stats.spawnerReady = false;
  world.emit('mapLoaded', { name: world.map.name, tier: tierNum, level: world.map.level, isHome });
  return world;
}

/** 让核心系统把地图词缀作用到怪物上（由 combat/monsters 查询） */
export function mapMod(world, type) {
  return world.mapMods?.[type] ?? 0;
}

/** 判断世界坐标是否可走（考虑玩家半径） */
export function isWalkable(world, x, z, r = 0) {
  const d = world.dungeon;
  if (!d) return false;
  return d.circleWalkable(x, z, r);
}

/** 在玩家附近找一个合法的刷怪点 */
export function randomSpawnPoint(world, minDist = 9, maxDist = 16, rng = world.rng) {
  const d = world.dungeon;
  const p = world.player;
  const R = p ? p.radius ?? 0.45 : 0.45;
  // [大地图修复] 旧实现是"全图随机抽地板 → 再筛距离 9~17"。
  // 地图放大到 100x100 之后命中环形的概率只剩 ~5%，大量尝试失败后会退化成"随便找个地板"，
  // 怪会被刷到很远的地方。改为直接在玩家周围环形采样，成功率高、也天然保持刷怪节奏。
  if (d && p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
    const lo = Math.max(1, minDist);
    const hi = Math.max(lo + 1, maxDist);
    for (let i = 0; i < 80; i++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = Math.sqrt(rng.next()) * (hi - lo) + lo; // 环形内按面积均匀
      const x = p.x + Math.cos(a) * rr;
      const z = p.z + Math.sin(a) * rr;
      const [cx, cz] = d.toTile(x, z);
      if (!d.isWalkableTile(cx, cz)) continue;
      if (!d.circleWalkable(x, z, R * 0.8)) continue;
      return { x, z };
    }
  }
  // [Lead 修复] 除了"离玩家够远"，还要求怪物中心离墙面 >= 0.7：否则只在 1 格宽的走廊里刷怪时，
  // 怪物会一出生就贴着墙（渲染上被墙体侧面遮住，看起来像"卡在墙里/消失了"）。
  const okWall = (x, z) => {
    const [cx, cz] = d.toTile(x, z);
    const ts = d.tileSize || 1;
    const fx = (x - cx * ts) / ts, fz = (z - cz * ts) / ts;
    if (fx < 0.3 || fx > 0.7 || fz < 0.3 || fz > 0.7) return false;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!d.isWalkableTile(cx + ox, cz + oz)) return false;
    return true;
  };
  for (let i = 0; i < 80; i++) {
    const pick = pickFloorTile(d, rng);
    if (!pick) continue;
    const w = d.toWorld(pick[0], pick[1]);
    const dd = p ? Math.hypot(w.x - p.x, w.z - p.z) : 999;
    if (dd < minDist || dd > maxDist) continue;
    if (okWall(w.x, w.z)) return w;
  }
  // 退而求其次：任意地板（至少保证碰撞圆可走、离玩家够远）
  for (let i = 0; i < 40; i++) {
    const any = pickFloorTile(d, rng);
    if (!any) break;
    const w = d.toWorld(any[0], any[1]);
    const dd = p ? Math.hypot(w.x - p.x, w.z - p.z) : 999;
    if (dd >= minDist && dd <= maxDist && d.circleWalkable(w.x, w.z, R)) return w;
  }
  const any = pickFloorTile(d, rng);
  return any ? d.toWorld(any[0], any[1]) : { x: (p ? p.x : 0) + 5, z: p ? p.z : 0 };
}

let floorCache = null;
function pickFloorTile(d, rng) {
  if (floorCache && floorCache.d === d) {
    return floorCache.list[Math.floor(rng.next() * floorCache.list.length)];
  }
  const list = [];
  d.forEachFloor((cx, cz) => list.push([cx, cz]));
  // 缓存窗口：同一次生成/重建期间复用（上限 600，字节数很小）
  if (!floorCache || floorCache.cacheStamp !== d.__stamp) {
    floorCache = { d, list, cacheStamp: d.__stamp };
  }
  return list[Math.floor(rng.next() * list.length)];
}

/** 收集所有地图主题与词缀（UI 用） */
export const MAP_INFO = { themes: MAP_THEMES, mods: MAP_MODS };