// 随机地牢生成：房间 + 走廊 + 房间式地牢，或在神殿废墟中切割出房间（POE 式"地下墓穴"观感）
// 纯逻辑，无 DOM 依赖。坐标以 tile 为单位，tile 值 0=地板 1=墙 2=门。
import { RNG, hashString } from '../engine/rng.js';
import { clamp } from '../engine/math.js';

export const TILE_FLOOR = 0;
export const TILE_WALL = 1;
export const TILE_DOOR = 2;

export const MAP_THEMES = [
  { id: 'crypt', name: '众星教堂遗迹', floor: '#2a2622', wall: '#4a4038', accent: '#c8a25a', fog: '#150f0b' },
  { id: 'cavern', name: '骸骨洞窟', floor: '#21242a', wall: '#3a4048', accent: '#7fd4ff', fog: '#0a1014' },
  { id: 'forge', name: '熔火锻造厂', floor: '#2b1d17', wall: '#5a3226', accent: '#ff7a2f', fog: '#180a05' },
  { id: 'grove', name: '腐蚀林地', floor: '#1f2a20', wall: '#33502f', accent: '#7dff9a', fog: '#08130a' },
  { id: 'void', name: '虚空裂隙', floor: '#1a1726', wall: '#382a55', accent: '#b98bff', fog: '#0d0817' },
];

export const MAP_MODS = [
  { id: 'swift', name: '迅捷', text: '怪物移动速度 +25%', type: 'monsterSpeed', value: 0.25, weight: 10 },
  { id: 'tough', name: '坚韧', text: '怪物生命 +40%', type: 'monsterLife', value: 0.4, weight: 10 },
  { id: 'brutal', name: '残暴', text: '怪物伤害 +25%', type: 'monsterDamage', value: 0.25, weight: 10 },
  { id: 'horde', name: '蜂拥', text: '怪物数量 +50%', type: 'monsterCount', value: 0.5, weight: 8 },
  { id: 'vampiric', name: '嗜血', text: '怪物攻击附带生命吸取', type: 'monsterLeech', value: 0.05, weight: 6 },
  { id: 'resistant', name: '顽固', text: '怪物元素抗性 +25%', type: 'monsterResist', value: 0.25, weight: 8 },
  { id: 'arcane', name: '奥术', text: '怪物攻击附加 30% 寒冷伤害', type: 'monsterAddedCold', value: 0.3, weight: 6 },
  { id: 'volatile', name: '自爆', text: '怪物死亡时爆炸', type: 'monsterExplode', value: 1, weight: 5 },
  { id: 'elite', name: '精英', text: '精英怪物数量 +100%', type: 'eliteCount', value: 1, weight: 6 },
  { id: 'greed', name: '贪婪', text: '物品掉落 +80%', type: 'itemQuantity', value: 0.8, weight: 8 },
  { id: 'lucky', name: '好运', text: '物品稀有度 +60%', type: 'itemRarity', value: 0.6, weight: 8 },
  { id: 'spiky', name: '荆棘', text: '怪物受到近战伤害时反弹 25%', type: 'thorns', value: 0.25, weight: 5 },
  { id: 'dark', name: '无光', text: '视野变暗（光照更暗）', type: 'vision', value: -1, weight: 4 },
];

export class Dungeon {
  constructor(cols, rows, tileSize = 1) {
    this.cols = cols;
    this.rows = rows;
    this.tileSize = tileSize;
    this.tiles = new Uint8Array(cols * rows).fill(TILE_WALL);
    this.rooms = [];
    this.theme = MAP_THEMES[0];
    this.seed = 0;
  }
  idx(cx, cz) {
    return cz * this.cols + cx;
  }
  get(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return TILE_WALL;
    return this.tiles[this.idx(cx, cz)];
  }
  set(cx, cz, v) {
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return;
    this.tiles[this.idx(cx, cz)] = v;
  }
  isWalkableTile(cx, cz) {
    return this.get(cx, cz) !== TILE_WALL;
  }
  /** 世界坐标 → 瓦片 */
  toTile(x, z) {
    return [Math.floor(x / this.tileSize), Math.floor(z / this.tileSize)];
  }
  /** 瓦片 → 世界坐标（格子中心） */
  toWorld(cx, cz) {
    return { x: (cx + 0.5) * this.tileSize, z: (cz + 0.5) * this.tileSize };
  }
  worldBounds() {
    return { minX: 0, maxX: this.cols * this.tileSize, minZ: 0, maxZ: this.rows * this.tileSize };
  }
  /** 圆形实体的可通行检测：中心点所在格可走且中心离开墙格边缘 */
  circleWalkable(x, z, r) {
    const ts = this.tileSize;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const px = x + Math.cos(ang) * r;
      const pz = z + Math.sin(ang) * r;
      const [cx, cz] = this.toTile(px, pz);
      if (!this.isWalkableTile(cx, cz)) return false;
    }
    const [cx, cz] = this.toTile(x, z);
    return this.isWalkableTile(cx, cz);
  }
  /** 线段是否穿墙（简单采样） */
  lineClear(x0, z0, x1, z1, step = 0.35) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(d / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const [cx, cz] = this.toTile(x, z);
      if (!this.isWalkableTile(cx, cz)) return false;
    }
    return true;
  }
  findWalkableNear(x, z, maxR = 20) {
    const [cx0, cz0] = this.toTile(x, z);
    for (let r = 0; r < maxR; r++) {
      for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
        for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
          if (Math.abs(cx - cx0) !== r && Math.abs(cz - cz0) !== r) continue;
          if (this.isWalkableTile(cx, cz)) return this.toWorld(cx, cz);
        }
      }
    }
    return null;
  }
  /** 遍历地板瓦片 */
  forEachFloor(cb) {
    for (let cz = 0; cz < this.rows; cz++) {
      for (let cx = 0; cx < this.cols; cx++) {
        if (this.tiles[cz * this.cols + cx] !== TILE_WALL) cb(cx, cz);
      }
    }
  }
}

function carveRect(d, x0, z0, w, h, v = TILE_FLOOR) {
  for (let z = z0; z < z0 + h; z++) {
    for (let x = x0; x < x0 + w; x++) d.set(x, z, v);
  }
}

function carveCorridor(d, ax, az, bx, bz, width = 1) {
  const half = Math.floor(width / 2);
  if (ax === bx || az === bz) {
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
    const z0 = Math.min(az, bz), z1 = Math.max(az, bz);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0 - half; z <= z1 + half; z++) d.set(x, z, TILE_FLOOR);
    }
    return;
  }
  // L 型
  carveCorridor(d, ax, az, bx, az, width);
  carveCorridor(d, bx, az, bx, bz, width);
}

function roomCenter(room) {
  return { cx: Math.floor(room.x + room.w / 2), cz: Math.floor(room.z + room.h / 2) };
}

/** 保底：生成一座巨大的圆形神殿大厅 + 四角柱 + 侧厅 */
function buildFallbackHall(d, rng) {
  const { cols, rows } = d;
  d.tiles.fill(TILE_WALL);
  const cx = Math.floor(cols / 2), cz = Math.floor(rows / 2);
  const rx = Math.floor(cols * 0.42), rz = Math.floor(rows * 0.42);
  for (let z = 2; z < rows - 2; z++) {
    for (let x = 2; x < cols - 2; x++) {
      const nx = (x - cx) / rx, nz = (z - cz) / rz;
      if (nx * nx + nz * nz <= 1) d.set(x, z, TILE_FLOOR);
    }
  }
  // 中心圆坛（装饰墙）
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    d.set(Math.round(cx + Math.cos(ang) * 6), Math.round(cz + Math.sin(ang) * 6), TILE_WALL);
  }
  // 侧厅
  const wingW = Math.floor(cols * 0.16), wingH = Math.floor(rows * 0.12);
  carveRect(d, 3, cz - (wingH >> 1), wingW, wingH);
  carveRect(d, cols - 3 - wingW, cz - (wingH >> 1), wingW, wingH);
  carveRect(d, cx - (wingW >> 1), 3, wingW, wingH);
  carveRect(d, cx - (wingW >> 1), rows - 3 - wingH, wingW, wingH);
  d.rooms = [
    { x: 2, z: 2, w: cols - 4, h: rows - 4, type: 'entrance' },
    { x: cx - (wingW >> 1), z: rows - 3 - wingH, w: wingW, h: wingH, type: 'boss' },
  ];
}

/** 与地图种子绑定的确定性整数哈希（火把/装饰用，不影响随机流） */
function ctxRng(seed, x, z) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ Math.imul(x + 0x7f4a7c15, 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ Math.imul(z + 0x165667b1, 0x27d4eb2f), 0x165667b1) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * 生成一张随机地牢
 * @param {object} opts { seed, level, size: 'small'|'medium'|'large', style: 'rooms'|'caves'|'grid' }
 */
export function generateDungeon(opts = {}) {
  const level = Math.max(1, opts.level || 1);
  const seed = (opts.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
  const rng = new RNG(seed);
  const theme = opts.theme ?? MAP_THEMES[rng.int(0, MAP_THEMES.length - 1)];
  const size = opts.size ?? ['small', 'medium', 'large'][Math.min(2, Math.floor(level / 8))];
  // 地图整体放大（面积约为旧尺寸的 3 倍）：探索更久、房间更多、刷怪更爽。
  const dims = size === 'small' ? [76, 68] : size === 'medium' ? [100, 88] : [124, 108];
  const style = opts.style ?? rng.pick(['rooms', 'rooms', 'caves', 'grid']);
  const d = new Dungeon(dims[0], dims[1], 1);
  d.seed = seed;
  d.theme = theme;
  d.style = style;
  d.level = level;
  d.size = size;
  // 相对旧版中等地图(56x52)的面积系数：刷怪上限 / 每批数量会随之提高，
  // 保证大地图不会因为"同屏怪太少"而显得空旷。
  d.sizeFactor = Math.max(1, Math.min(1.8, Math.sqrt((d.cols * d.rows) / (56 * 52))));

  // 外圈墙壁
  const cols = d.cols, rows = d.rows, margin = 2;

  if (style === 'grid') {
    generateGrid(d, rng, margin);
  } else {
    // 随机房间 + L 型走廊（POE 地下的房间式布局）
    const targetRooms = size === 'small' ? 22 : size === 'medium' ? 34 : 46;
    const roomBoxes = [];
    let tries = 0;
    while (roomBoxes.length < targetRooms && tries < 1200) {
      tries++;
      const w = rng.int(5, 12), h = rng.int(5, 12);
      const x = rng.int(margin, cols - margin - w - 1);
      const z = rng.int(margin, rows - margin - h - 1);
      let ok = true;
      for (const r of roomBoxes) {
        if (x < r.x + r.w + 2 && x + w + 2 > r.x && z < r.z + r.h + 2 && z + h + 2 > r.z) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      roomBoxes.push({ x, z, w, h, type: 'normal' });
    }
    roomBoxes[0].type = 'entrance';
    for (const r of roomBoxes.slice(1)) r.type = 'normal';
    if (roomBoxes.length > 2) roomBoxes[roomBoxes.length - 1].type = 'boss';

    for (const r of roomBoxes) carveRect(d, r.x, r.z, r.w, r.h);
    // 按接近顺序连接
    for (let i = 0; i < roomBoxes.length; i++) {
      const a = roomCenter(roomBoxes[i]);
      let best = i + 1;
      let bestD = Infinity;
      for (let j = i + 1; j < roomBoxes.length; j++) {
        const b = roomCenter(roomBoxes[j]);
        const dd = Math.abs(a.cx - b.cx) + Math.abs(a.cz - b.cz);
        if (dd < bestD) { bestD = dd; best = j; }
      }
      if (best < roomBoxes.length && i !== best) {
        const b = roomCenter(roomBoxes[best]);
        carveCorridor(d, a.cx, a.cz, b.cx, b.cz, rng.chance(0.55) ? 3 : 1);
      }
      // 额外的环路，让地图不是纯树状
      if (i > 1 && rng.chance(0.5)) {
        const j = rng.int(0, i - 1);
        const b = roomCenter(roomBoxes[j]);
        carveCorridor(d, a.cx, a.cz, b.cx, b.cz, 1);
      }
    }
    // 房间太少时兜底：直接铺墙 + 大房间
    if (roomBoxes.length < 3) {
      for (let z = margin; z < rows - margin; z++) for (let x = margin; x < cols - margin; x++) d.set(x, z, TILE_FLOOR);
      const fallback = [];
      for (let i = 0; i < 6; i++) {
        fallback.push({ x: margin + (i % 3) * Math.floor((cols - margin * 2) / 3), z: margin + Math.floor(i / 3) * Math.floor((rows - margin * 2) / 2), w: Math.floor((cols - margin * 2) / 3) - 1, h: Math.floor((rows - margin * 2) / 2) - 1, type: i === 0 ? 'entrance' : 'normal' });
      }
      fallback[fallback.length - 1].type = 'boss';
      d.rooms = fallback;
    } else {
      d.rooms = roomBoxes;
    }
  }

  // 怪物/杂物：在房间里放柱子、墙中开口做成门
  addDoors(d, rng);
  if (style !== 'grid') decorateRooms(d, rng, style === 'caves');

  // 边界封起来
  for (let x = 0; x < cols; x++) {
    d.set(x, 0, TILE_WALL);
    d.set(x, 1, TILE_WALL);
    d.set(x, rows - 1, TILE_WALL);
    d.set(x, rows - 2, TILE_WALL);
  }
  for (let z = 0; z < rows; z++) {
    d.set(0, z, TILE_WALL);
    d.set(1, z, TILE_WALL);
    d.set(cols - 1, z, TILE_WALL);
    d.set(cols - 2, z, TILE_WALL);
  }

  // 连通性裁剪：从第一间房开始 flood fill，移除孤立区域
  const region = floodFill(d, d.rooms[0] ? roomCenter(d.rooms[0]) : { cx: 3, cz: 3 });
  cleanIslands(d, region);
  // 兜底：如果地板少于 8%，换成保证可玩的神殿大厅
  if (floorRatio(d) < 0.08) {
    buildFallbackHall(d, rng);
    const region2 = floodFill(d, roomCenter(d.rooms[0]));
    cleanIslands(d, region2);
  }
  d.playerStart = d.rooms[0] ? d.toWorld(roomCenter(d.rooms[0]).cx, roomCenter(d.rooms[0]).cz) : d.findWalkableNear(cols / 2, rows / 2);
  d.bossRoom = d.rooms.find((r) => r.type === 'boss') ? d.toWorld(roomCenter(d.rooms.find((r) => r.type === 'boss')).cx, roomCenter(d.rooms.find((r) => r.type === 'boss')).cz) : null;

  // 火把/光源点：房间角落 + 墙体边
  d.torches = [];
  const torchList = [];
  for (let cz = 0; cz < rows; cz++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!d.isWalkableTile(cx, cz)) continue;
      if (ctxRng(seed, cx, cz) % 13 !== 0) continue;
      if (!(d.get(cx - 1, cz) === TILE_WALL || d.get(cx + 1, cz) === TILE_WALL || d.get(cx, cz - 1) === TILE_WALL || d.get(cx, cz + 1) === TILE_WALL)) continue;
      const w = d.toWorld(cx, cz);
      torchList.push({ x: w.x, z: w.z, color: [theme.accent, '#ffb060', '#7fb0ff', '#a070ff'][ctxRng(seed + 7, cx, cz) % 4] });
    }
  }
  d.torches = torchList;
  // 大地图需要更多光源；按面积给出上限（旧版 48 在新地图上会留下大片黑区）。
  const torchCap = Math.round(60 + (d.cols * d.rows) / 90);
  if (d.torches.length > torchCap) d.torches = rng.shuffle(d.torches).slice(0, torchCap);

  return d;
}

function generateGrid(d, rng, margin) {
  // 神殿风格的方格迷宫：均匀房间 + 规则走廊
  const cell = rng.int(6, 8);
  const rooms = [];
  const cols = d.cols, rows = d.rows;
  for (let z = margin; z + cell < rows - margin; z += cell + 1) {
    for (let x = margin; x + cell < cols - margin; x += cell + 1) {
      const w = Math.max(4, Math.min(cell, cols - margin - x - 1 - 1) - rng.int(0, 2));
      const h = Math.max(4, Math.min(cell, rows - margin - z - 1 - 1) - rng.int(0, 2));
      if (w < 4 || h < 4) continue;
      const x0 = Math.min(x + rng.int(0, 1), cols - 2 - w), z0 = Math.min(z + rng.int(0, 1), rows - 2 - h);
      if (x0 < margin || z0 < margin || x0 + w > cols - 2 || z0 + h > rows - 2) continue;
      rooms.push({ x: x0, z: z0, w, h, type: 'normal' });
    }
  }
  for (const r of rooms) carveRect(d, r.x, r.z, r.w, r.h);
  // 连接相邻格子
  for (const r of rooms) {
    const a = roomCenter(r);
    for (const o of rooms) {
      if (o === r) continue;
      const b = roomCenter(o);
      if ((b.cx > a.cx && b.cz === a.cz) || (b.cz > a.cz && b.cx === a.cx)) {
        if (rng.chance(0.85)) carveCorridor(d, a.cx, a.cz, b.cx, b.cz, 1);
      }
    }
  }
  rooms[0].type = 'entrance';
  rooms[rooms.length - 1].type = 'boss';
  d.rooms = rooms;
}

function addDoors(d, rng) {
  // 走廊与房间之间的门：一格地板两侧是墙
  d.forEachFloor((cx, cz) => {
    if (d.get(cx - 1, cz) === TILE_WALL && d.get(cx + 1, cz) === TILE_WALL) d.set(cx, cz, TILE_DOOR);
    else if (d.get(cx, cz - 1) === TILE_WALL && d.get(cx, cz + 1) === TILE_WALL) d.set(cx, cz, TILE_DOOR);
  });
  d.doors = [];
  d.forEachFloor((cx, cz) => {
    if (d.get(cx, cz) === TILE_DOOR) d.doors.push(d.toWorld(cx, cz));
  });
}

function decorateRooms(d, rng, caves) {
  // 柱子和杂物（用墙格模拟柱子）
  for (const r of d.rooms) {
    if (r.type === 'entrance') continue;
    const cx = Math.floor(r.x + r.w / 2), cz = Math.floor(r.z + r.h / 2);
    if (r.w >= 8 && r.h >= 8) {
      // 四角柱子
      const px = [r.x + 2, r.x + r.w - 3], pz = [r.z + 2, r.z + r.h - 3];
      for (const a of px) for (const b of pz) {
        if (a === cx || b === cz) continue;
        d.set(a, b, TILE_WALL);
      }
    } else if (rng.chance(0.3) && r.w >= 5 && r.h >= 5) {
      d.set(r.x + 1, r.z + 1, TILE_WALL);
    }
  }
  if (caves) {
    // 洞窟：随机挖掉一些墙，形成不规则的边缘
    for (let i = 0; i < 40; i++) {
      const cx = rng.int(2, d.cols - 3), cz = rng.int(2, d.rows - 3);
      let floors = 0;
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) if (d.isWalkableTile(cx + ox, cz + oz)) floors++;
      if (floors >= 4 && floors <= 8 && rng.chance(0.5)) d.set(cx, cz, TILE_FLOOR);
    }
  }
}

function floodFill(d, start) {
  const region = new Uint8Array(d.cols * d.rows);
  if (!d.isWalkableTile(start.cx, start.cz)) return region;
  const stack = [[start.cx, start.cz]];
  while (stack.length) {
    const [cx, cz] = stack.pop();
    if (!d.isWalkableTile(cx, cz)) continue;
    const i = d.idx(cx, cz);
    if (region[i]) continue;
    region[i] = 1;
    stack.push([cx + 1, cz], [cx - 1, cz], [cx, cz + 1], [cx, cz - 1]);
  }
  return region;
}

function cleanIslands(d, region) {
  for (let i = 0; i < d.tiles.length; i++) {
    if (d.tiles[i] !== TILE_WALL && !region[i]) d.tiles[i] = TILE_WALL;
  }
}

/** 统计地板比例（测试/地形评估用） */
export function floorRatio(d) {
  let f = 0;
  for (let i = 0; i < d.tiles.length; i++) if (d.tiles[i] !== TILE_WALL) f++;
  return f / d.tiles.length;
}

/** 最大连通区域是否覆盖绝大多数地板（测试用） */
export function isConnected(d) {
  let first = null, floors = 0;
  d.forEachFloor((cx, cz) => {
    floors++;
    if (!first) first = { cx, cz };
  });
  if (!first) return false;
  const region = floodFill(d, first);
  let reached = 0;
  for (let i = 0; i < region.length; i++) reached += region[i];
  return reached >= floors * 0.999;
}

/** 从字符串生成地图种子 */
export function seedFrom(text) {
  return hashString(String(text));
}

/** 地图等级相对玩家等级的修正（防止越级太难） */
export function mapLevelFor(playerLevel, mapTier) {
  return clamp(playerLevel + mapTier - 1, 1, 40);
}

/** 为地图随机抽取词缀（数量随等级提高） */
export function rollMapMods(rng, level) {
  const n = clamp(1 + Math.floor(level / 7), 1, 4);
  const pool = MAP_MODS.slice();
  const chosen = [];
  while (chosen.length < n && pool.length) {
    const total = pool.reduce((s, m) => s + m.weight, 0);
    let r = rng.next() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].weight;
      if (r <= 0) break;
    }
    idx = Math.min(idx, pool.length - 1);
    chosen.push(pool.splice(idx, 1)[0]);
  }
  return chosen;
}

export function mapNameFor(theme, level) {
  const prefixes = ['', '被遗忘的', '崩塌的', '远古的', '血染的', '封印的'];
  const rng = new RNG(level * 7919 + theme.name.length);
  const p = prefixes[rng.int(0, prefixes.length - 1)];
  return `${p}${theme.name}`;
}