// ─────────────────────────────────────────────────────────────────────────────
// effects.js — 世界内特效状态（冲击波环 / 闪电 / 技能层 / 残影）。纯逻辑，无 DOM。
// renderer 每帧 update + 绘制；不 new 对象（全部对象池）。
// ─────────────────────────────────────────────────────────────────────────────

export class EffectField {
  constructor(maxRings = 48, maxBolts = 24, maxGhosts = 40, maxCracks = 16, maxDisks = 20) {
    this.rings = pool(maxRings, () => ({ active: false, x: 0, z: 0, r0: 0, r1: 1, t: 0, dur: 0.5, hue: 30, sat: 90, light: 60, width: 3, kind: 'ring', seed: 0, squash: 0.72 }));
    this.bolts = pool(maxBolts, () => ({ active: false, x0: 0, z0: 0, x1: 0, z1: 0, h: 0.6, t: 0, dur: 0.16, seed: 1, hue: 55, sat: 100, light: 70, width: 2.5, branch: 0.5 }));
    this.ghosts = pool(maxGhosts, () => ({ active: false, x: 0, z: 0, facing: 0, t: 0, dur: 0.32, hue: 12, alpha: 0.5, scale: 1 }));
    this.cracks = pool(maxCracks, () => ({ active: false, x: 0, z: 0, radius: 1, t: 0, dur: 1.2, seed: 3, hue: 22, segs: [] }));
    // 实心扩散圆盘（战争践踏的冲击波本体）。与 rings 的区别：rings 是描边圆环，
    // disks 是**从内到外渐隐的实心面片 + 前沿亮带**，在 bloom 下不会糊成刺眼白环。
    this.disks = pool(maxDisks, () => ({ active: false, x: 0, z: 0, r1: 2, t: 0, dur: 0.5, hue: 30, sat: 90, light: 60, alpha: 0.5, core: 0.5, rim: 0.35 }));
    this.ringIdx = 0; this.boltIdx = 0; this.ghostIdx = 0; this.crackIdx = 0; this.diskIdx = 0;
    this.seed = 0x1234567;
  }
  reset() {
    for (const r of this.rings) r.active = false;
    for (const b of this.bolts) b.active = false;
    for (const g of this.ghosts) g.active = false;
    for (const c of this.cracks) c.active = false;
    for (const d of this.disks) d.active = false;
  }
  rand() {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  ring(x, z, o = {}) {
    const r = this.rings[this.ringIdx++ % this.rings.length];
    r.active = true;
    r.x = x; r.z = z;
    r.r0 = o.r0 ?? 0.1;
    r.r1 = o.r1 ?? 2;
    r.t = 0;
    r.dur = Math.max(0.05, o.dur ?? 0.45);
    r.hue = o.hue ?? 30; r.sat = o.sat ?? 95; r.light = o.light ?? 62;
    r.width = o.width ?? 3;
    r.kind = o.kind || 'ring'; // ring | dust | wave | ground | slash
    r.seed = this.rand() * 6.28;
    return r;
  }

  bolt(x0, z0, x1, z1, o = {}) {
    const b = this.bolts[this.boltIdx++ % this.bolts.length];
    b.active = true;
    b.x0 = x0; b.z0 = z0; b.x1 = x1; b.z1 = z1;
    b.h = o.h ?? 0.6;
    b.t = 0; b.dur = Math.max(0.03, o.dur ?? 0.14);
    b.seed = Math.floor(this.rand() * 100000) + 1;
    b.hue = o.hue ?? 55; b.sat = o.sat ?? 100; b.light = o.light ?? 72;
    b.width = o.width ?? 2.4;
    b.branch = o.branch ?? 0.6;
    return b;
  }

  ghost(x, z, facing, o = {}) {
    const g = this.ghosts[this.ghostIdx++ % this.ghosts.length];
    g.active = true;
    g.x = x; g.z = z; g.facing = facing;
    g.t = 0; g.dur = o.dur ?? 0.3;
    g.hue = o.hue ?? 14; g.alpha = o.alpha ?? 0.45; g.scale = o.scale ?? 1;
    return g;
  }

  crack(x, z, o = {}) {
    const c = this.cracks[this.crackIdx++ % this.cracks.length];
    c.active = true;
    c.x = x; c.z = z;
    c.radius = o.radius ?? 1.4;
    c.t = 0; c.dur = o.dur ?? 1.4;
    c.hue = o.hue ?? 22;
    c.seed = Math.floor(this.rand() * 1000) + 1;
    // 预生成裂纹线段（世界坐标偏移，确定性）
    const segs = c.segs;
    segs.length = 0;
    const n = o.branches ?? 7;
    for (let i = 0; i < n; i++) {
      let a = this.rand() * Math.PI * 2;
      let px = 0, pz = 0;
      const steps = 3 + Math.floor(this.rand() * 3);
      for (let s = 0; s < steps; s++) {
        a += (this.rand() - 0.5) * 0.9;
        const len = (c.radius / steps) * (0.5 + this.rand());
        const nx = px + Math.cos(a) * len;
        const nz = pz + Math.sin(a) * len;
        segs.push(px, pz, nx, nz);
        px = nx; pz = nz;
        if (this.rand() < 0.3) {
          // 分叉
          const ba = a + (this.rand() < 0.5 ? 1 : -1) * (0.6 + this.rand() * 0.6);
          segs.push(px, pz, px + Math.cos(ba) * len * 0.6, pz + Math.sin(ba) * len * 0.6);
        }
      }
    }
    return c;
  }

  /**
   * 实心扩散圆盘（战争践踏 / 升星冲击波用）。
   *
   * 为什么不用 ring()：ring 是 lineWidth 描边的整圈椭圆，bloom 后处理会把细线连成
   * 一圈刺眼的白环，把玩家和怪物糊掉（README「旋风斩视觉」踩过的坑）。
   * 这里改成**实心面片**：内部用径向渐变从中心到边缘渐隐（只会形成柔和的光斑），
   * 外加一条较宽的亮带贴着前沿，视觉上仍然"在扩散"，但不会出现闭合细环。
   *
   * @param {number} x @param {number} z 世界坐标（地面）
   * @param {object} o { r1, dur, hue, sat, light, alpha, core, rim }
   *   - r1    最终半径（世界单位）
   *   - alpha 中心最大不透明度（'lighter' 叠加下建议 0.2~0.45）
   *   - core  中心亮度占比（0 = 空心，只剩前沿亮带；1 = 实心亮盘）
   *   - rim   前沿亮带强度（0..1）
   */
  disk(x, z, o = {}) {
    const d = this.disks[this.diskIdx++ % this.disks.length];
    d.active = true;
    d.x = x; d.z = z;
    d.r1 = Math.max(0.2, o.r1 ?? 2);
    d.t = 0;
    d.dur = Math.max(0.05, o.dur ?? 0.5);
    d.hue = o.hue ?? 30; d.sat = o.sat ?? 90; d.light = o.light ?? 62;
    d.alpha = o.alpha ?? 0.4;
    d.core = o.core ?? 0.35;
    d.rim = o.rim ?? 0.5;
    return d;
  }

  update(dt) {
    if (!(dt > 0)) return;
    for (const d of this.disks) {
      if (!d.active) continue;
      d.t += dt;
      if (d.t >= d.dur) d.active = false;
    }
    for (const r of this.rings) {
      if (!r.active) continue;
      r.t += dt;
      if (r.t >= r.dur) r.active = false;
    }
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.t += dt;
      if (b.t >= b.dur) b.active = false;
    }
    for (const g of this.ghosts) {
      if (!g.active) continue;
      g.t += dt;
      if (g.t >= g.dur) g.active = false;
    }
    for (const c of this.cracks) {
      if (!c.active) continue;
      c.t += dt;
      if (c.t >= c.dur) c.active = false;
    }
  }
}

function pool(n, make) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// 玩家技能持续层（落地/旋风/战吼/血怒/图腾）— 由 renderer 维护
// ─────────────────────────────────────────────────────────────────────────────

export const SKILL_META = {
  // [契约 v1] 1 号技能「裂地斩 groundSlam」已被「战争践踏 stomp」取代：
  // 这里是**圆形 360° 自转冲击**而不是前向扇形，所以 hue 取"踏地金"38 而不是旧锤击橙 26。
  stomp: { hue: 38, name: '战争践踏', type: 'burst' },
  /** @deprecated 旧 id，仅为老事件/老存档保留（渲染层仍按锥形/锤击色调处理，不报错） */
  groundSlam: { hue: 26, name: '裂地斩', type: 'burst' },
  whirlwind: { hue: 36, name: '旋风斩', type: 'channel' },
  warcry: { hue: 44, name: '战吼', type: 'burst' },
  bloodRage: { hue: 352, name: '血性狂暴', type: 'aura' },
  rally: { hue: 205, name: '集结图腾', type: 'aura' },
  totem: { hue: 205, name: '图腾', type: 'aura' },
  dash: { hue: 20, name: '翻滚', type: 'burst' },
  leap: { hue: 30, name: '跃击', type: 'burst' },
  cleave: { hue: 30, name: '顺劈', type: 'burst' },
  shieldBash: { hue: 30, name: '盾击', type: 'burst' },
  flurry: { hue: 34, name: '乱舞', type: 'burst' },
  chainLightning: { hue: 55, name: '连锁闪电', type: 'burst' },
  fireNova: { hue: 20, name: '火焰新星', type: 'burst' },
  iceNova: { hue: 195, name: '冰霜新星', type: 'burst' },
  bloodExplosion: { hue: 350, name: '血爆', type: 'burst' },
  // ── 元素法师 ──────────────────────────────────────────────────────────────
  mageFirebolt: { hue: 24, name: '灼热飞弹', type: 'projectile' },
  mageIceShard: { hue: 195, name: '寒冰箭', type: 'projectile' },
  mageArc: { hue: 55, name: '电弧', type: 'projectile' },
  magePyro: { hue: 24, name: '炎爆术', type: 'burst' },
  mageNova: { hue: 200, name: '霜环', type: 'burst' },
  mageChain: { hue: 55, name: '雷链', type: 'beam' },
  mageBarrier: { hue: 195, name: '冰霜屏障', type: 'buff' },
  mageUltimate: { hue: 280, name: '元素狂潮', type: 'aura' },
  mageMeteor: { hue: 24, name: '天火陨星', type: 'burst' },
  mageOrb: { hue: 280, name: '环形法球', type: 'projectile' },
};

/** 归一化技能 id：'ground_slam' / 'GroundSlam' / 'slam' → 已知 key（找不到就原样返回） */
export function normalizeSkillId(id) {
  if (!id) return '';
  const s = String(id).replace(/[\s_-]+/g, '').toLowerCase();
  const map = {
    // 战争践踏：warStomp / 践踏 / quake（外部/旧数据可能用这些别名）
    stomp: 'stomp', warstomp: 'stomp', warmarch: 'stomp', quake: 'stomp', footslam: 'stomp',
    // 「战争践踏」的中文 id / 拼音：UI 层某些临时数据可能直接带中文名
    '战争践踏': 'stomp', zhanzhengta: 'stomp', ta: 'stomp',
    // groundSlam 保留映射：老事件、老存档、其他角色的技能表里可能还有它
    groundslam: 'groundSlam', slam: 'groundSlam', earthquakeslam: 'groundSlam',
    whirlwind: 'whirlwind', ww: 'whirlwind', cyclone: 'whirlwind', spin: 'whirlwind',
    warcry: 'warcry', rally: 'rally', rallytotem: 'rally', totem: 'rally',
    bloodrage: 'bloodRage', frenzy: 'bloodRage', berserk: 'bloodRage',
    dash: 'dash', roll: 'dash', dodgeroll: 'dash',
    leap: 'leap', leapslam: 'leap',
  };
  return map[s] || id;
}