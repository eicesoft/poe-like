// ─────────────────────────────────────────────────────────────────────────────
// particles.js — 纯逻辑粒子池（无 DOM）。
// 预分配 Float32Array 结构，对象池复用，永不每帧 new。上限默认 1800。
// 绘制由 renderer.js 负责（forEach 遍历）。
//
// 粒子字段（每种一个 TypedArray 的 SoA 布局）：
//   x,z,h, vx,vz,vh, life, maxLife, size, sizeEnd, hue, sat, light, alpha,
//   drag, gravity, spin, rot, kind(0 圆点 /1 线 /2 方块 /3 星芒 /4 火花拖尾), additive(0/1)
// ─────────────────────────────────────────────────────────────────────────────

export const PARTICLE_MAX = 1800;

// kind
export const P_DOT = 0;
export const P_LINE = 1;
export const P_QUAD = 2;
export const P_STAR = 3;
export const P_SPARK = 4;

const F = [
  'x', 'z', 'h', 'vx', 'vz', 'vh',
  'life', 'maxLife', 'psize', 'sizeEnd',
  'hue', 'sat', 'light', 'alpha',
  'drag', 'gravity', 'spin', 'rot',
  'kind', 'additive', 'seed',
];

export class ParticleSystem {
  constructor(max = PARTICLE_MAX) {
    this.max = max | 0;
    this.count = 0; // [0, count) 为活跃粒子（紧凑排列）
    for (const k of F) this[k] = new Float32Array(this.max);
    this.index = 0; // 环形分配指针（用于 spawn 覆盖最老的粒子）
    this.rngState = 0x2f6e2b1;
    this.emitted = 0;
  }

  get size() {
    return this.count;
  }

  /** 确定性随机 [0,1)（避免 Math.random 影响测试稳定） */
  rand() {
    let t = (this.rngState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) {
    return a + (b - a) * this.rand();
  }

  reset() {
    this.count = 0;
    this.index = 0;
    this.emitted = 0;
    return this;
  }

  /** 物理回收：把活着的粒子压缩到前部（O(n)，无分配） */
  update(dt) {
    if (!(dt > 0)) return this.count;
    // 大 dt（切后台回来 / 测试直接传 0.2s）拆成子步，保证物理稳定且寿命精确扣减
    const SUB = 1 / 60;
    let remaining = dt;
    while (remaining > 1e-9) {
      const step = remaining > SUB ? SUB : remaining;
      remaining -= step;
      this._step(step);
      if (this.count === 0) break;
    }
    return this.count;
  }

  _step(dt) {
    const { x, z, h, vx, vz, vh, life, drag, gravity, rot, spin } = this;
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      const l = life[i] - dt;
      if (l <= 0) continue; // 生命周期结束 → 丢弃
      life[i] = l;
      const d = drag[i];
      const k = d > 0 ? Math.exp(-d * dt) : 1;
      vx[i] *= k;
      vz[i] *= k;
      vh[i] = vh[i] * k - gravity[i] * dt;
      x[i] += vx[i] * dt;
      z[i] += vz[i] * dt;
      h[i] += vh[i] * dt;
      if (h[i] < 0) {
        h[i] = 0;
        vh[i] *= -0.35; // 轻微弹地
        if (Math.abs(vh[i]) < 0.2) vh[i] = 0;
      }
      rot[i] += spin[i] * dt;
      if (w !== i) this._copy(i, w);
      w++;
    }
    this.count = w;
    this.index = w; // 新粒子从尾部追加
  }

  _copy(from, to) {
    for (let f = 0; f < F.length; f++) this[F[f]][to] = this[F[f]][from];
  }

  /** 内部：拿一个槽位（满了则覆盖最老的） */
  _alloc() {
    if (this.count < this.max) return this.count++;
    // 池满：环形覆盖（最老的一批粒子）
    const i = this.index % this.max;
    this.index = (this.index + 1) % this.max;
    return i;
  }

  _write(i, o) {
    this.x[i] = o.x ?? 0;
    this.z[i] = o.z ?? 0;
    this.h[i] = o.h ?? 0.05;
    this.vx[i] = o.vx ?? 0;
    this.vz[i] = o.vz ?? 0;
    this.vh[i] = o.vh ?? 0;
    const lf = o.life > 0 ? o.life : 0.6;
    this.life[i] = lf;
    this.maxLife[i] = lf;
    const s = o.size ?? 0.12;
    this.psize[i] = s;
    this.sizeEnd[i] = o.sizeEnd ?? s * 0.15;
    this.hue[i] = o.hue ?? 30;
    this.sat[i] = o.sat ?? 90;
    this.light[i] = o.light ?? 60;
    this.alpha[i] = o.alpha ?? 1;
    this.drag[i] = o.drag ?? 2;
    this.gravity[i] = o.gravity ?? 0;
    this.spin[i] = o.spin ?? 0;
    this.rot[i] = o.rot ?? 0;
    this.kind[i] = o.kind ?? P_DOT;
    this.additive[i] = o.additive === false ? 0 : 1;
    // 注意：在 update 循环内调用 spawn 会覆盖正在读取的槽位，调用方应先收集再生成。
    this.seed[i] = o.seed ?? this.rand() * 6.283;
  }

  /** 单粒子（低级 API） */
  spawn(o) {
    const i = this._alloc();
    this._write(i, o);
    this.emitted++;
    return i;
  }

  /**
   * 爆发：向四周喷射 n 个粒子
   * @param {number} x @param {number} z
   * @param {object} o
   *   count, hue, hueJitter, sat, light, speed(min,max 世界单位/s), spread(0..π 角度),
   *   dir(基础角度, 世界 XZ), up(0..1 垂直分量), life, size, sizeEnd, kind, gravity,
   *   drag, alpha, radius(出生分布半径), spin, additive
   */
  spawnBurst(x, z, o = {}) {
    const n = Math.max(1, o.count | 0 || 8);
    const spMin = o.speedMin ?? o.speed ?? 1.5;
    const spMax = o.speedMax ?? o.speed ?? 4;
    const spread = o.spread ?? Math.PI * 2;
    const base = o.dir ?? 0;
    const up = o.up ?? 0.6;
    const rad = o.radius ?? 0;
    for (let k = 0; k < n; k++) {
      const a = base + (this.rand() - 0.5) * spread;
      const sp = this.range(spMin, spMax);
      const rr = rad > 0 ? Math.sqrt(this.rand()) * rad : 0;
      const oa = this.rand() * Math.PI * 2;
      this.spawn({
        x: x + Math.cos(oa) * rr,
        z: z + Math.sin(oa) * rr,
        h: o.h ?? this.range(0.15, 0.7),
        vx: Math.cos(a) * sp,
        vz: Math.sin(a) * sp,
        vh: sp * up * this.range(0.4, 1.2),
        life: (o.life ?? 0.7) * this.range(0.65, 1.3),
        size: (o.size ?? 0.11) * this.range(0.7, 1.4),
        sizeEnd: o.sizeEnd ?? (o.size ?? 0.11) * 0.1,
        hue: (o.hue ?? 30) + (this.rand() - 0.5) * 2 * (o.hueJitter ?? 14),
        sat: o.sat ?? 92,
        light: (o.light ?? 62) + (this.rand() - 0.5) * (o.lightJitter ?? 18),
        alpha: o.alpha ?? 1,
        drag: o.drag ?? 2.2,
        gravity: o.gravity ?? 3,
        spin: o.spin ?? (this.rand() - 0.5) * 6,
        kind: o.kind ?? P_DOT,
        additive: o.additive,
      });
    }
    return n;
  }

  /**
   * 地面冲击环（用粒子模拟碎屑 + 尘埃；真正的环由 renderer 的冲击波系统画）
   * @param {number} x @param {number} z
   * @param {object} o count, radius, hue, speed, life, size, up, kind, spread
   */
  spawnRing(x, z, o = {}) {
    const n = Math.max(1, o.count | 0 || 24);
    const rad = o.radius ?? 1;
    const base = o.dir ?? 0;
    const spread = o.spread ?? Math.PI * 2;
    const start = base - spread / 2;
    for (let k = 0; k < n; k++) {
      const a = spread >= Math.PI * 2 - 1e-3
        ? (k / n) * Math.PI * 2 + this.rand() * 0.2
        : start + (k / Math.max(1, n - 1)) * spread;
      const sp = (o.speed ?? 1.2) * this.range(0.75, 1.25);
      this.spawn({
        x: x + Math.cos(a) * rad * this.range(0.85, 1.05),
        z: z + Math.sin(a) * rad * this.range(0.85, 1.05),
        h: o.h ?? 0.1,
        vx: Math.cos(a) * sp,
        vz: Math.sin(a) * sp,
        vh: (o.up ?? 1.4) * this.range(0.5, 1.2),
        life: (o.life ?? 0.55) * this.range(0.7, 1.3),
        size: (o.size ?? 0.14) * this.range(0.7, 1.3),
        sizeEnd: o.sizeEnd ?? 0.02,
        hue: (o.hue ?? 30) + (this.rand() - 0.5) * (o.hueJitter ?? 20),
        sat: o.sat ?? 85,
        light: (o.light ?? 62) + this.rand() * 20,
        drag: o.drag ?? 3,
        gravity: o.gravity ?? 5,
        kind: o.kind ?? P_DOT,
        additive: o.additive,
        spin: (this.rand() - 0.5) * 8,
      });
    }
    return n;
  }

  /**
   * 环形迸发：在半径 rad 的圆上均匀取点，每个点都朝**径向向外**飞（与 spawnRing 同族，
   * 区别：支持 speedMin/speedMax 区间 + 出生半径抖动 + arc 弧段，做"一圈尘土在扩散"的踏实感）。
   *
   * 为什么单独加：战争践踏要"以玩家为圆心的 360° 冲击"，spawnBurst 是随机方向团簇、
   * spawnRing 又不能控制速度区间；这个版本让整圈的速度/寿命都有可控的抖动。
   *
   * @param {number} x @param {number} z
   * @param {object} o
   *   count, radius(出生圆半径), speed/speedMin/speedMax(径向速度), up(垂直速度),
   *   life, size, sizeEnd, hue/hueJitter, sat, light, drag, gravity, kind, additive, alpha,
   *   jitter(出生圆半径抖动比例), arc(只生成一段弧，默认整圈), dir(弧的起始角)
   */
  spawnBurstRing(x, z, o = {}) {
    const n = Math.max(1, o.count | 0 || 16);
    const rad = o.radius ?? 0.5;
    // 粒子池接近满时进一步限流，并按比例抽稀取点 ——
    // 否则池满会走 `_alloc` 的环形覆盖，把强冲击波自己的粒子互相踢掉，看起来"只喷了一半"。
    const total = this.count + n;
    const room = total > this.max * 0.92 ? Math.max(4, Math.floor(n * 0.5)) : n;
    const arc = o.arc ?? Math.PI * 2;
    const full = arc >= Math.PI * 2 - 1e-3;
    const start = (o.dir ?? 0) - arc / 2;
    const jitter = o.jitter ?? 0.12;
    const size = o.size ?? 0.12;
    const smin = o.speedMin ?? o.speed ?? 2;
    const smax = o.speedMax ?? o.speed ?? 4;
    for (let k = 0; k < room; k++) {
      // 整圈时用等分角 + 微抖，保证"环"是均匀的（纯随机会出现明显的空洞）
      const a = full
        ? (k / room) * Math.PI * 2 + (this.rand() - 0.5) * 0.35
        : start + ((k + this.rand()) / room) * arc;
      const rr = rad * (1 + (this.rand() - 0.5) * 2 * jitter);
      const sp = this.range(smin, smax);
      this.spawn({
        x: x + Math.cos(a) * rr,
        z: z + Math.sin(a) * rr,
        h: o.h ?? this.range(0.05, 0.3),
        vx: Math.cos(a) * sp,
        vz: Math.sin(a) * sp,
        vh: (o.up ?? 1.2) * this.range(0.5, 1.2),
        life: (o.life ?? 0.5) * this.range(0.65, 1.3),
        size: size * this.range(0.65, 1.35),
        sizeEnd: o.sizeEnd ?? size * 0.12,
        hue: (o.hue ?? 32) + (this.rand() - 0.5) * 2 * (o.hueJitter ?? 10),
        sat: o.sat ?? 60,
        light: (o.light ?? 55) + (this.rand() - 0.5) * 20,
        alpha: o.alpha ?? 1,
        drag: o.drag ?? 2.4,
        gravity: o.gravity ?? 5,
        spin: (this.rand() - 0.5) * 8,
        kind: o.kind ?? P_DOT,
        additive: o.additive,
      });
    }
    return room;
  }

  /** 拖尾：在两点之间连成火花线 */
  spawnTrail(x0, z0, x1, z1, o = {}) {
    const n = Math.max(1, o.count | 0 || 3);
    for (let k = 0; k < n; k++) {
      const t = this.rand();
      this.spawn({
        x: x0 + (x1 - x0) * t,
        z: z0 + (z1 - z0) * t,
        h: o.h ?? 0.6,
        vx: this.range(-0.5, 0.5),
        vz: this.range(-0.5, 0.5),
        vh: this.range(-0.2, 0.4),
        life: (o.life ?? 0.3) * this.range(0.6, 1.2),
        size: (o.size ?? 0.08) * this.range(0.7, 1.2),
        sizeEnd: 0.01,
        hue: (o.hue ?? 35) + this.range(-12, 12),
        sat: o.sat ?? 95,
        light: o.light ?? 65,
        drag: 4,
        gravity: 0,
        kind: o.kind ?? P_SPARK,
        additive: o.additive,
      });
    }
    return n;
  }

  /** 遍历活跃粒子（renderer 绘制用） */
  forEach(fn) {
    const { x, z, h, vx, vz, vh, life, maxLife, psize, sizeEnd, hue, sat, light, alpha, rot, kind, additive } = this;
    for (let i = 0; i < this.count; i++) {
      fn({
        x: x[i], z: z[i], h: h[i],
        vx: vx[i], vz: vz[i], vh: vh[i],
        life: life[i], maxLife: maxLife[i], t: 1 - life[i] / (maxLife[i] || 1),
        size: psize[i], sizeEnd: sizeEnd[i],
        hue: hue[i], sat: sat[i], light: light[i], alpha: alpha[i],
        rot: rot[i], kind: kind[i], additive: additive[i],
      });
    }
  }
}