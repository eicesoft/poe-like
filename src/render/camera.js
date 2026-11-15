// ─────────────────────────────────────────────────────────────────────────────
// camera.js — 纯逻辑相机（无 DOM）。平滑跟随 + 鼠标偏移 + 噪声震动。
// worldToScreen(x, z, h) → 屏幕像素坐标（与 project.js 投影约定一致）
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, damp, project } from './project.js';

export class Camera {
  /**
   * @param {object} opts
   *  - viewW/viewH : 视口尺寸（用于计算 zoom 与屏幕中心）。resize 时更新。
   *  - minScale/maxScale : zoom 夹取区间（默认 22 / 40）
   *  - zoomDivisor : scale = clamp(viewW / zoomDivisor, min, max)（默认 34）
   *  - follow : 跟随插值速率（默认 8 / s）
   *  - lookAhead : 鼠标偏移强度（世界单位 / 世界单位，默认 0.16）
   */
  constructor(opts = {}) {
    this.x = 0; // 相机世界坐标（注视点）
    this.y = 0; // 世界 z（沿用契约里的 cam.y）
    this.targetX = 0;
    this.targetY = 0;
    this.viewW = opts.viewW ?? 1280;
    this.viewH = opts.viewH ?? 720;
    this.minScale = opts.minScale ?? 22;
    this.maxScale = opts.maxScale ?? 40;
    this.zoomDivisor = opts.zoomDivisor ?? 34;
    this.scale = clamp(this.viewW / this.zoomDivisor, this.minScale, this.maxScale);
    this.follow = opts.follow ?? 8;
    this.lookAhead = opts.lookAhead ?? 0.16;
    this.maxLookOffset = opts.maxLookOffset ?? 1.2; // 鼠标偏移最多 1.2 世界单位（屏幕中心始终贴近玩家）
    this.squash = opts.squash ?? 0.72; // 2.5D 垂直压缩
    this.heightK = opts.heightK ?? 0.9; // 高度系数
    this.lookX = 0; // 平滑后的鼠标偏移（世界单位）
    this.lookZ = 0;
    this.shakeAmt = 0; // 当前震动幅度（屏幕像素）
    this.shakeT = 0; // 震动计时（驱动噪声）
    this.shakeX = 0;
    this.shakeY = 0;
    this.trauma = 0; // 0..1 冲击衰减
    this.time = 0;
  }

  /** 视口尺寸变化 → 重算 zoom */
  resize(w, h) {
    if (w > 0) this.viewW = w;
    if (h > 0) this.viewH = h;
    this.scale = clamp(this.viewW / this.zoomDivisor, this.minScale, this.maxScale);
    return this;
  }

  /** 设置缩放比例（画质档位可以微调） */
  setScale(s) {
    if (s > 0) this.scale = clamp(s, this.minScale, this.maxScale);
  }

  /**
   * 设置跟随目标。dt 用于平滑插值（不传则立即对齐）。
   * @param {number} x 世界 x
   * @param {number} z 世界 z
   * @param {number} dt 帧时间；传 0/undefined 时瞬时定位（用于初始化）
   * @param {{x:number,z:number}} [look] 鼠标世界坐标（可选）
   */
  target(x, z, dt, look) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    // 鼠标偏移：只取"准星到玩家"的偏差，并限制最大偏移（世界单位）
    // 这样镜头会朝瞄准方向轻推一点，但玩家始终保持在屏幕中心附近（POE 手感）。
    let lx = 0, lz = 0;
    if (look && Number.isFinite(look.x) && Number.isFinite(look.z)) {
      const dx = look.x - x;
      const dz = look.z - z;
      const dist = Math.hypot(dx, dz);
      const maxOff = this.maxLookOffset; // 世界单位上限
      const k = dist > 1e-6 ? Math.min(1, dist / 6) * maxOff / dist : 0; // 6 单位内线性增长到上限
      lx = dx * k;
      lz = dz * k;
    }
    if (!(dt > 0)) {
      this.x = x + lx;
      this.y = z + lz;
      this.targetX = this.x;
      this.targetY = this.y;
      this.lookX = lx;
      this.lookZ = lz;
    } else {
      // 平滑跟随鼠标偏移（速率温和，避免瞄准时镜头晃动过大）
      this.lookX = damp(this.lookX, lx, 4, dt);
      this.lookZ = damp(this.lookZ, lz, 5, dt);
      this.targetX = x + this.lookX;
      this.targetY = z + this.lookZ;
      this.x = damp(this.x, this.targetX, this.follow, dt);
      this.y = damp(this.y, this.targetY, this.follow, dt);
    }
  }

  /** 屏幕中心（震动后） */
  centerX() {
    return this.viewW * 0.5 + this.shakeX;
  }
  centerY() {
    return this.viewH * 0.5 + this.shakeY;
  }

  /**
   * 世界 → 屏幕
   * @param {number} x @param {number} z @param {number} [h] 高度
   */
  worldToScreen(x, z, h = 0, out = { x: 0, y: 0 }) {
    return project(x, z, h, this, null, out);
  }

  /** 屏幕 → 世界（地面平面） */
  screenToWorld(sx, sy, out = { x: 0, z: 0 }) {
    const scale = this.scale || 1;
    out.x = this.x + (sx - this.centerX()) / scale;
    out.z = this.y + (sy - this.centerY()) / (scale * this.squash);
    return out;
  }

  /** 施加震动（像素幅度，可叠加；上限 40） */
  shake(amount) {
    if (!(amount > 0)) return;
    this.shakeAmt = Math.min(40, this.shakeAmt + amount);
    this.trauma = Math.min(1.5, this.trauma + amount / 18);
  }

  /** 每帧推进：震动噪声 + 衰减 */
  update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.shakeT += dt;
    if (this.shakeAmt > 0.02) {
      const t = this.shakeT;
      // 两个不通频率的正弦 + 少量噪声，得到"抖动"而不是规律摆动
      const nx = Math.sin(t * 53.7) * 0.6 + Math.sin(t * 91.3 + 1.7) * 0.4;
      const ny = Math.cos(t * 47.1 + 0.9) * 0.6 + Math.sin(t * 83.9 + 2.3) * 0.4;
      this.shakeX = nx * this.shakeAmt;
      this.shakeY = ny * this.shakeAmt * 0.8;
      this.shakeAmt *= Math.exp(-9 * dt);
      if (this.shakeAmt < 0.02) {
        this.shakeAmt = 0;
        this.shakeX = 0;
        this.shakeY = 0;
      }
    } else {
      this.shakeAmt = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }
    this.trauma *= Math.exp(-3 * dt);
  }

  /** 供 project() 使用的视图快照 */
  view(out = {}) {
    out.cx = this.viewW * 0.5;
    out.cy = this.viewH * 0.5;
    out.scale = this.scale;
    out.squash = this.squash;
    out.heightK = this.heightK;
    out.w = this.viewW;
    out.h = this.viewH;
    out.camX = this.x;
    out.camY = this.y;
    out.shakeX = this.shakeX;
    out.shakeY = this.shakeY;
    return out;
  }
}