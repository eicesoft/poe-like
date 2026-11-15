// ─────────────────────────────────────────────────────────────────────────────
// renderer.js — 2.5D Canvas2D 渲染器（POE 暗黑余烬风格）
//
// 设计要点
//  1) 本文件顶层**不访问** document/window（可在 Node 中安全 import）；
//     所有 DOM/canvas 操作在 constructor 与 render 内完成。
//  2) 渲染顺序：清屏 → 地面 → 墙(伪3D) → 地面效果 → 物品/魂火 → 按 z 排序实体
//     （阴影 → 身体 → 武器弧光）→ 投射物 → 粒子 → 冲击波 → 飘字
//     → 后处理（Bloom / 暗角 / 色差 / 扫描线 / 受击红晕 / 低血红边）
//  3) 所有游戏字段只读；events 只消费不清空（Lead 负责清空）。
//  4) 粒子/飘字/特效全部对象池，不每帧 new。
// ─────────────────────────────────────────────────────────────────────────────
import { Camera } from './camera.js';
import { ParticleSystem, P_DOT, P_LINE, P_QUAD, P_STAR, P_SPARK } from './particles.js';
import { FloatingText } from './floatingText.js';
import { ScreenFx, parseHsl, elementHue } from './screenFx.js';
import { EffectField, normalizeSkillId, SKILL_META } from './effects.js';
import { Terrain, WALL_H } from './terrain.js';
import { project, clamp, hash2 } from './project.js';
import * as SP from './sprites.js';
import { parseColor } from './sprites.js';
import { renderCore } from './draw-core.js';
import { renderEntities, entityHeight } from './draw-entities.js';
import { renderWhirl } from './draw-whirl.js';
import { mixin, fmtNum, zSort } from './shared.js';

const hsl = SP.hsl;
const D2R = Math.PI / 180;

// 技能"持续层"池（旋风/血怒/图腾 aura）
function pool(n, make) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = make();
  return a;
}

// ── 新增视觉的常量集中在这里，方便调手感时只改一处 ────────
// 眩晕星星/护甲辉光的常量与 entityHeight 已经搬到 draw-entities.js（绘制方），
// 这里也 import 同一个 entityHeight，保证"事件里的迸射高度"和"头顶星星高度"一致。
// （同理：SteamArmor 的 id 常量只维护一份，避免 core 改名时漏改渲染层。）

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts] { dpr, maxParticles, quality:'high'|'medium'|'low' }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas || null;
    this.ctx = null;
    this.dpr = opts.dpr ?? (typeof window !== 'undefined' && window.devicePixelRatio ? Math.min(2, window.devicePixelRatio) : 1);
    this.quality = 2; // 0 low / 1 medium / 2 high
    if (opts.quality) this.setQuality(opts.quality);
    this.w = 1;
    this.h = 1;

    this.cam = new Camera({ viewW: 1280, viewH: 720 });
    /** @type {Camera} 兼容 Lead 的调用：renderer.camera.screenToWorld(sx, sy) */
    this.camera = this.cam;
    this.particles = new ParticleSystem(opts.maxParticles ?? 1800);
    this.text = new FloatingText(60);
    this.fx = new ScreenFx();
    this.effects = new EffectField();
    this.terrain = new Terrain();
    this._sprites = SP;

    // 离屏层（在构造函数里按需创建；Node 下没有则静默跳过）
    this.bloomCanvas = null;
    this.bloomCtx = null;
    this.postCanvas = null;
    this.postCtx = null;

    // 实体排序缓冲（复用，不 new）
    this.zBuffer = [];
    this._sortBuf = [];
    this.zCount = 0;
    this.torchBuf = [];
    this.scratch = { x: 0, y: 0 };
    this.scratch2 = { x: 0, y: 0 };
    this.scratch3 = { x: 0, y: 0 };
    this.shockwaves = pool(24, () => ({ active: false, x: 0, z: 0, t: 0, dur: 0.5, r1: 3, hue: 30, sat: 100, light: 60, width: 3, kind: 'ring', seed: 0 }));

    // 技能持续层
    this.auras = pool(8, () => ({ active: false, kind: '', left: 0, dur: 1, color: 30, power: 1 }));
    this.totems = pool(6, () => ({ active: false, x: 0, z: 0, left: 0, dur: 1, hue: 205 }));
    this.whirl = { active: false, left: 0, fadeOut: 0, dur: 0.1, hue: 36, angle: 0, radius: 2, x: 0, z: 0 };
    this.slamRings = pool(4, () => ({ active: false, x: 0, z: 0, t: 0, dur: 0.7 }));

    // 其他状态
    this.time = 0;
    this.frame = 0;
    this.debug = false;
    this.lastWorld = null;
    this.lastHpRatio = 1;
    this.lastPlayer = null;
    this.lastPlayerX = null;
    this.lastPlayerZ = null;
    this.dashTrailTimer = 0;
    this.flashVignette = 0;
    this.enemyFlash = 0; // 玩家受伤时屏幕边缘红光
    this.screenDirt = null;
    this.bossPresent = false;
    this.fps = 60;
    this._fpsAcc = 0;
    this._fpsN = 0;
    /** 离屏录制钩子（仅测试/无浏览器环境用，见 tests/raster.mjs） */
    this._capture = null;
    this.stats = { emittedParticles: 0, drawnEntities: 0, skippedEntities: 0 };
    /** 最近一次捕获到的错误信息（排查用，调试面板/控制台可见） */
    this.lastError = null;

    if (this.canvas) this._initContext();
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────────

  _initContext() {
    if (!this.canvas || typeof this.canvas.getContext !== 'function') return;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this._buildLayers();
    this.resize();
  }

  _buildLayers() {
    if (typeof document === 'undefined') return;
    const mk = (w, h) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, w | 0);
      c.height = Math.max(1, h | 0);
      return { c, ctx: c.getContext('2d') };
    };
    const w = this.w, h = this.h;
    if (!this.bloomCanvas) {
      const b = mk(w / 2, h / 2);
      this.bloomCanvas = b.c;
      this.bloomCtx = b.ctx;
      const p = mk(w, h);
      this.postCanvas = p.c;
      this.postCtx = p.ctx;
    }
  }

  /**
   * 无浏览器环境用：不碰 DOM，直接使用"假 canvas"（记录绘制调用，见 tests/raster.mjs）。
   * @param {{width:number,height:number,getContext:(t:string)=>any}} fakeCanvas
   */
  static forOffscreen(fakeCanvas, opts = {}) {
    const r = new Renderer(null, { ...opts, dpr: 1 });
    r.canvas = fakeCanvas;
    r.w = fakeCanvas.width;
    r.h = fakeCanvas.height;
    r.ctx = fakeCanvas.getContext('2d');
    r.cam.resize(r.w, r.h);
    return r;
  }

  /** 触发地形缓存重建（换图时 Lead 可调用） */
  invalidateTerrain() {
    this.terrain.reset();
  }

  /** 画质：'high'|'medium'|'low' 或 0|1|2 */
  setQuality(level) {
    if (typeof level === 'string') {
      const m = { low: 0, medium: 1, high: 2, off: 0 };
      this.quality = m[level.toLowerCase()] ?? 2;
    } else if (typeof level === 'number') {
      this.quality = clamp(level | 0, 0, 2);
    }
    // 低画质自动 dpr 限制
    if (this.quality === 0) this.dpr = 1;
    return this.quality;
  }

  /**
   * 设置画布尺寸（CSS 像素）。不传则读 canvas.clientWidth / window。
   */
  resize(w, h) {
    if (this.canvas) {
      const cw = this.canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
      const ch = this.canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0);
      if (!(w > 0)) w = cw || 1280;
      if (!(h > 0)) h = ch || 720;
    }
    if (!(w > 0)) w = this.w;
    if (!(h > 0)) h = this.h;
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    const dpr = this.quality === 0 ? 1 : this.dpr;
    if (this.canvas) {
      this.canvas.width = Math.max(1, Math.round(this.w * dpr));
      this.canvas.height = Math.max(1, Math.round(this.h * dpr));
    }
    this.cam.resize(this.w, this.h);
    if (typeof document !== 'undefined') {
      // 重建离屏层（尺寸变化）
      this.bloomCanvas = null;
      this.bloomCtx = null;
      this.postCanvas = null;
      this.postCtx = null;
      this._buildLayers();
    }
    return this;
  }

  // ── 全屏特效 API ───────────────────────────────────────────────────────────

  /** 全屏闪光：color 可为 'red' | 22 | '#ff8800' | 'hsl(...)' */
  flash(color = 'white', strength = 0.35, dur = 0.22) {
    this.fx.flash(color, strength, dur, 'flash');
    if (color === 'red' || color === 352) this.enemyFlash = Math.max(this.enemyFlash, strength);
    return this;
  }

  /** 屏幕震动（像素幅度） */
  shake(amount = 4) {
    this.cam.shake(amount);
    return this;
  }

  /** 地面冲击波（世界坐标） */
  shockwave(x, z, color = 36, opts = {}) {
    const c = parseHsl(color);
    const sw = this._takeShockwave();
    sw.active = true;
    sw.x = x; sw.z = z;
    sw.t = 0;
    sw.dur = opts.dur ?? 0.5;
    sw.r1 = opts.radius ?? 3.2;
    sw.hue = c.h; sw.sat = c.s; sw.light = c.l;
    sw.width = opts.width ?? 3.5;
    sw.kind = opts.kind || 'ring';
    sw.seed = Math.random() * 6.28;
    // 附带粒子
    if (this.quality > 0) {
      this.particles.spawnRing(x, z, {
        count: Math.round((opts.count ?? 22) * (this.quality === 2 ? 1 : 0.6)),
        radius: 0.3, hue: c.h, speed: (opts.radius ?? 3.2) * 0.45, life: 0.5,
        size: 0.12, up: 0.8, kind: P_SPARK, light: c.l + 12,
      });
    }
    return this;
  }

  /** 慢动作：dur 秒内时间缩放为 scale */
  slowMo(dur = 0.6, scale = 0.25) {
    this.fx.slowMo(dur, scale);
    return this;
  }

  /** 当前时间缩放（供 Lead 的循环使用；也可自行忽略） */
  timeScale() {
    return this.fx.timeScale();
  }

  /** 对外：手动发事件（内部 emitFromEvent 别名） */
  emit(evt) {
    return this.emitFromEvent(evt);
  }

  /**
   * 这条伤害事件是不是打在玩家身上？
   * 优先用 core 的 targetIsPlayer；老事件/外部事件没有该字段时退回对象比对。
   * @param {object} evt
   */
  _isPlayerTarget(evt) {
    if (!evt) return false;
    if (evt.targetIsPlayer) return true;
    const t = evt.target;
    if (!t) return false;
    if (t.kind === 'player') return true;
    if (this.lastPlayer && t === this.lastPlayer) return true;
    return !!(this.lastWorld && this.lastWorld.player && t === this.lastWorld.player);
  }

  // ── 事件 → 视觉 ────────────────────────────────────────────────────────────

  /**
   * 入口：把 core 推的一条世界事件翻成视觉。
   *
   * 稳健性约定（踩过的坑）：**任何新分支都不允许抛异常**。
   * 帧渲染有一层 try/catch（见 render()），但那一下会丢掉整帧的画面 ——
   * 在 main.js 里还会被当成"渲染彻底坏了"。所以：
   *   1) 新事件分支各自 try/catch，坏 payload 最多让"这次特效不播"；
   *   2) 所有数值字段都有兜底，缺失（技能面板里触发的 skillRankUp 就没有 x/z）时退回玩家位置。
   */
  emitFromEvent(evt) {
    if (!evt || !evt.type) return this;
    const q = this.quality;
    const P = this.particles;
    // 事件缺坐标（技能面板/日志里触发的升级）→ 以玩家为圆心
    const hasPos = Number.isFinite(evt.x) && Number.isFinite(evt.z);
    const pl = this.lastPlayer || (this.lastWorld && this.lastWorld.player) || null;
    const x = hasPos ? evt.x : (pl && Number.isFinite(pl.x) ? pl.x : 0);
    const z = hasPos ? evt.z : (pl && Number.isFinite(pl.z) ? pl.z : 0);
    const el = evt.element || evt.damageType;
    const hue = elementHue(el, 30);

    switch (evt.type) {
      case 'hit': {
        const crit = !!evt.crit;
        const amt = evt.amount ?? evt.damage ?? 0;
        const toPlayer = this._isPlayerTarget(evt);
        // 记录本次命中：core 在暴击时会紧接着再推一条同数值的 'crit'（同一个 evtBase），
        // 'crit' 分支据此去重，避免一次暴击出现两个数字 / 叠两层特效。
        this._lastHit = { amount: amt, crit, x, z, time: this.time };
        if (amt > 0) {
          if (toPlayer) {
            // 自己受到的伤害：红色 + 负号，过顶更高，和打怪的白色/元素色数字区分开
            this.text.add(x, z, `-${fmtNum(amt)}`, {
              kind: crit ? 'playerCrit' : 'playerHurt',
              h: evt.h ?? 1.9,
            });
          } else {
            this.text.add(x, z, fmtNum(amt), {
              kind: crit ? 'crit' : (el && elementHue(el, 0) !== 0 ? String(el).toLowerCase() : 'damage'),
              crit, h: evt.h ?? 1.45,
            });
          }
        }
        P.spawnBurst(x, z, {
          count: (crit ? 14 : 7) * (q === 2 ? 1 : 0.6), hue, speedMin: 2.2, speedMax: crit ? 7 : 5,
          up: 0.75, life: crit ? 0.45 : 0.32, size: crit ? 0.16 : 0.1, kind: crit ? P_SPARK : P_DOT,
          radius: 0.25, light: 68, hueJitter: 16, drag: 3.2, gravity: 6,
        });
        if (crit) {
          this.effects.ring(x, z, { r0: 0.15, r1: 1.15, dur: 0.3, hue, width: 3, kind: 'slash' });
          this.cam.shake(3.2);
          this.fx.chromaPulse(0.22);
        } else if (amt > 0) {
          this.cam.shake(0.9);
        }
        break;
      }
      case 'crit': {
        // core 的暴击会先推 'hit'(crit:true) 再推 'crit'（同一个 evtBase）。
        // 命中分支已经播过数字与强化特效，这里跳过重复的那一条；单独到来的
        // 'crit'（旧 caller / 外部事件）仍按暴击处理。
        const lh = this._lastHit;
        const amt = evt.amount ?? evt.damage;
        if (lh && lh.crit && lh.amount === (amt ?? 0)
          && Math.abs(lh.x - x) < 1e-6 && Math.abs(lh.z - z) < 1e-6 && lh.time === this.time) break;
        if (amt > 0) {
          if (this._isPlayerTarget(evt)) {
            this.text.add(x, z, `-${fmtNum(amt)}`, { kind: 'playerCrit', h: evt.h ?? 1.9 });
          } else {
            this.text.add(x, z, fmtNum(amt), { kind: 'crit', crit: true, h: 1.5 });
          }
        }
        this.effects.ring(x, z, { r0: 0.2, r1: 1.6, dur: 0.35, hue: 45, width: 4, kind: 'slash' });
        P.spawnBurst(x, z, { count: 20, hue: 45, hueJitter: 20, speedMin: 3, speedMax: 9, up: 0.9, life: 0.5, size: 0.17, kind: P_STAR, light: 75 });
        this.cam.shake(5);
        this.fx.chromaPulse(0.35);
        break;
      }
      case 'kill': {
        const big = evt.boss || evt.rarity === 'boss' || evt.elite || evt.rarity === 'rare';
        const n = (big ? 46 : 20) * (q === 2 ? 1 : 0.55);
        P.spawnBurst(x, z, {
          count: n | 0, hue: big ? 355 : 12, hueJitter: 26, speedMin: 1.5, speedMax: big ? 8 : 5,
          up: 0.85, life: 0.85, size: big ? 0.2 : 0.13, kind: P_QUAD, light: 55, gravity: 4,
          drag: 1.8, radius: big ? 0.7 : 0.3,
        });
        this.effects.ring(x, z, { r0: big ? 0.3 : 0.15, r1: big ? 4.5 : 1.7, dur: big ? 0.8 : 0.45, hue: big ? 355 : 20, width: big ? 6 : 3, kind: big ? 'ground' : 'dust' });
        if (big) {
          this.cam.shake(12);
          this.slowMo(0.45, 0.3);
          this.flash('red', 0.16, 0.3);
          this.fx.freeze(0.05);
        } else {
          // 斩杀：短促慢动作 + 轻微震动
          this.slowMo(0.12, 0.45);
          this.cam.shake(3.5);
          this.flash('white', 0.06, 0.12);
        }
        break;
      }
      case 'skillCast': {
        this._onSkillCast(evt, x, z);
        break;
      }
      // ── 元素法师：印记反应 / 陨星 / 法球 / 三相齐射 ───────────────────────────
      case 'mageReaction': {
        try { this._playMageReaction(x, z, evt); } catch (err) { this._warnEvent('mageReaction', err); }
        break;
      }
      case 'mageReactionEcho': {
        try { this._playMageEcho(evt, x, z); } catch (err) { this._warnEvent('mageReactionEcho', err); }
        break;
      }
      case 'mageMeteor': {
        try { this._playMageMeteor(x, z, evt); } catch (err) { this._warnEvent('mageMeteor', err); }
        break;
      }
      case 'mageOrb': {
        try { this._playMageOrb(evt, x, z); } catch (err) { this._warnEvent('mageOrb', err); }
        break;
      }
      case 'mageTrinity': {
        try { this._playMageTrinity(evt, x, z); } catch (err) { this._warnEvent('mageTrinity', err); }
        break;
      }
      case 'whirl': {
        // [Lead 修复] 只同步半径；旋转/停止完全由 player.whirlspinning 驱动，
        // 不再用事件设置"余晖"，否则松手后画面会残留一段刀光。
        if (Number.isFinite(evt.radius)) this.whirl.radius = evt.radius * 0.86;
        break;
      }
      case 'whirlTick': {
        this._onWhirlTick(x, z, Number.isFinite(evt.radius) ? evt.radius : (evt.r ?? 2.2));
        this.cam.shake(1.4);
        break;
      }
      case 'whirlEnd': {
        // 松手时只留一个很短、很淡的收尾环，避免"停止后画面还有东西"
        this.effects.ring(x, z, { r0: this.whirl.radius * 0.9, r1: this.whirl.radius * 1.05, dur: 0.18, hue: 38, sat: 88, light: 52, width: 1.6, kind: 'slash' });
        break;
      }
      case 'projectileHit': {
        P.spawnBurst(x, z, { count: 10, hue, speedMin: 2, speedMax: 6, up: 0.7, life: 0.32, size: 0.11, kind: P_SPARK, light: 72 });
        this.effects.ring(x, z, { r0: 0.1, r1: 0.9, dur: 0.28, hue, width: 2.5, kind: 'slash' });
        if (evt.crit) this.cam.shake(2.5);
        break;
      }
      case 'spawn': {
        P.spawnRing(x, z, { count: 14, radius: 0.55, hue: evt.hue ?? 265, speed: 0.6, life: 0.6, size: 0.09, up: 2.2, kind: P_DOT, sat: 90, light: 65 });
        this.effects.ring(x, z, { r0: 0.8, r1: 0.1, dur: 0.55, hue: evt.hue ?? 265, width: 2, kind: 'ring' });
        break;
      }
      case 'levelUp': {
        this.flash('gold', 0.32, 0.6);
        this.shockwave(x, z, 44, { radius: 4, dur: 0.7, count: 40 });
        P.spawnBurst(x, z, { count: 42, hue: 44, hueJitter: 16, speedMin: 1.5, speedMax: 6, up: 1.4, life: 1.1, size: 0.16, kind: P_STAR, light: 78, gravity: -0.6, drag: 1.4 });
        this.text.add(x, z, 'LEVEL UP', { kind: 'gold', h: 2.2, size: 26, life: 1.4 });
        break;
      }
      // ── [契约 v1] 战争践踏：以玩家为圆心的 360° 踏地冲击 ─────────────────────
      case 'stomp': {
        try {
          this._playStomp(x, z, evt);
        } catch (err) {
          // 坏 payload 只让这次特效不播，绝不让整帧抛异常（见 emitFromEvent 头注释）
          this._warnEvent('stomp', err);
        }
        break;
      }
      // ── [契约 v1] 眩晕：头顶星星由实体状态驱动，这里只做"起势"的小迸射 ───────
      case 'stun': {
        try {
          this._onStun(x, z, evt);
        } catch (err) {
          this._warnEvent('stun', err);
        }
        break;
      }
      case 'stunEnd': {
        try {
          this._onStunEnd(x, z, evt);
        } catch (err) {
          this._warnEvent('stunEnd', err);
        }
        break;
      }
      // ── [契约 v1] 技能升星 / 精炼：levelUp 的"小一号"版本 ────────────────────
      case 'skillRankUp': {
        try {
          this._onSkillUp(x, z, evt, false);
        } catch (err) {
          this._warnEvent('skillRankUp', err);
        }
        break;
      }
      case 'skillRefine': {
        try {
          this._onSkillUp(x, z, evt, true);
        } catch (err) {
          this._warnEvent('skillRefine', err);
        }
        break;
      }
      case 'loot': {
        const rar = evt.rarity || 'normal';
        const h2 = rar === 'unique' ? 26 : rar === 'rare' ? 44 : rar === 'magic' ? 262 : 210;
        P.spawnBurst(x, z, { count: rar === 'unique' || rar === 'rare' ? 18 : 8, hue: h2, speedMin: 0.8, speedMax: 3, up: 1.2, life: 0.7, size: 0.1, kind: P_STAR, light: 70 });
        this.effects.ring(x, z, { r0: 0.05, r1: rar === 'unique' ? 2.2 : 1.1, dur: 0.5, hue: h2, width: 2, kind: 'ring' });
        break;
      }
      case 'orb': {
        const h2 = evt.kind === 'xp' ? 275 : evt.kind === 'life' ? 350 : 44;
        P.spawnBurst(x, z, { count: 5, hue: h2, speedMin: 0.5, speedMax: 2, up: 1.5, life: 0.4, size: 0.08, kind: P_DOT, light: 72, gravity: -1 });
        break;
      }
      case 'heal': {
        const amt = evt.amount;
        this.text.add(x, z, amt ? `+${fmtNum(amt)}` : '+', { kind: 'heal', h: 1.6 });
        P.spawnBurst(x, z, { count: 14, hue: 125, speedMin: 0.4, speedMax: 1.6, up: 2.4, life: 0.9, size: 0.1, kind: P_DOT, light: 62, gravity: -2.2, drag: 0.8, radius: 0.4 });
        break;
      }
      // 持续失血（血性狂暴）与荆棘反伤：两处都是"没走 dealDamage 的伤害"，
      // 但同样要有数字 —— 否则玩家会只看到血条在掉、不知道掉了多少。
      case 'drain': {
        const amt = evt.amount ?? 0;
        if (amt > 0 && this._isPlayerTarget(evt)) {
          this.text.add(x, z, `-${fmtNum(amt)}`, { kind: 'playerHurt', size: 16, h: evt.h ?? 1.7, life: 0.75 });
        }
        break;
      }
      case 'thorns': {
        const amt = evt.amount ?? 0;
        if (amt > 0) {
          if (this._isPlayerTarget(evt)) {
            this.text.add(x, z, `-${fmtNum(amt)}`, { kind: 'playerHurt', size: 18, h: evt.h ?? 1.8 });
          } else {
            this.text.add(x, z, fmtNum(amt), { kind: 'damage', h: evt.h ?? 1.5, size: 16 });
          }
          P.spawnBurst(x, z, { count: 8, hue: 35, speedMin: 1, speedMax: 3.5, up: 0.9, life: 0.3, size: 0.09, kind: P_SPARK, light: 70 });
        }
        break;
      }
      case 'explosion': {
        const r = evt.radius ?? 2.2;
        this.shockwave(x, z, evt.hue ?? 24, { radius: r, dur: 0.55, count: 40 });
        this.effects.ring(x, z, { r0: 0.2, r1: r, dur: 0.5, hue: 24, width: 5, kind: 'ground' });
        P.spawnBurst(x, z, { count: 34 * (q === 2 ? 1 : 0.6), hue: 24, hueJitter: 20, speedMin: 2, speedMax: 8, up: 1.1, life: 0.8, size: 0.18, kind: P_QUAD, light: 60, gravity: 2.5, radius: 0.5 });
        P.spawnBurst(x, z, { count: 16, hue: 30, sat: 30, speedMin: 0.6, speedMax: 3, up: 0.6, life: 1.1, size: 0.3, kind: P_DOT, light: 30, gravity: -0.3, drag: 1.4, additive: false, alpha: 0.5 });
        this.flash(24, 0.22, 0.3);
        this.cam.shake(8);
        if (evt.big) this.slowMo(0.3, 0.4);
        break;
      }
      case 'bossSpawn': {
        this.bossPresent = true;
        this.flash('red', 0.45, 0.9);
        this.shockwave(x, z, 355, { radius: 7, dur: 1.1, count: 60 });
        this.effects.ring(x, z, { r0: 0.1, r1: 6, dur: 1, hue: 355, width: 8, kind: 'ground' });
        P.spawnBurst(x, z, { count: 60, hue: 355, hueJitter: 10, speedMin: 2, speedMax: 7, up: 1.6, life: 1.4, size: 0.22, kind: P_DOT, light: 45, sat: 95, gravity: -0.4, drag: 1.2 });
        this.cam.shake(16);
        this.slowMo(0.9, 0.35);
        break;
      }
      case 'bossKilled': {
        this.bossPresent = false;
        this.flash('white', 0.5, 0.5);
        this.flash('gold', 0.4, 1.2);
        this.shockwave(x, z, 44, { radius: 9, dur: 1.4, count: 90 });
        P.spawnBurst(x, z, { count: 80, hue: 40, hueJitter: 30, speedMin: 2, speedMax: 11, up: 1.4, life: 1.6, size: 0.2, kind: P_STAR, light: 80, gravity: 3, drag: 1.1 });
        this.cam.shake(22);
        this.slowMo(1.6, 0.22);
        break;
      }
      case 'playerDeath': {
        this.flash('red', 0.65, 1.4);
        this.cam.shake(18);
        this.slowMo(1.6, 0.18);
        P.spawnBurst(x, z, { count: 40, hue: 350, speedMin: 1, speedMax: 5, up: 1.1, life: 1.4, size: 0.18, kind: P_QUAD, light: 50, gravity: 3 });
        break;
      }
      case 'waveStart': {
        this.flash('cyan', 0.1, 0.5);
        this.effects.ring(x, z, { r0: 1, r1: 9, dur: 1.1, hue: 190, width: 2, kind: 'ring' });
        break;
      }
      case 'eliteSpawn': {
        this.flash(265, 0.14, 0.4);
        this.shockwave(x, z, 265, { radius: 2.5, dur: 0.6, count: 26 });
        P.spawnBurst(x, z, { count: 26, hue: 265, speedMin: 1, speedMax: 4.5, up: 1.3, life: 0.9, size: 0.14, kind: P_STAR, light: 70 });
        break;
      }
      case 'dash': {
        this.effects.ghost(x, z, evt.facing ?? 0, { dur: 0.28, alpha: 0.45 });
        this.effects.ring(x, z, { r0: 0.6, r1: 0.15, dur: 0.3, hue: 20, width: 2, kind: 'dust' });
        P.spawnBurst(x, z, { count: 10, hue: 30, sat: 25, speedMin: 0.5, speedMax: 2.5, up: 0.4, life: 0.55, size: 0.16, kind: P_DOT, light: 45, additive: false, alpha: 0.55, gravity: 0.2 });
        this.cam.shake(1.5);
        break;
      }
      case 'warcry': {
        this._playWarcry(x, z);
        break;
      }
      case 'bloodRage': {
        this._activateAura('bloodRage', 8, 352, 1);
        break;
      }
      case 'rally': {
        this._spawnTotem(x, z, 8);
        break;
      }
      case 'pickup': {
        P.spawnBurst(x, z, { count: 8, hue: evt.hue ?? 44, speedMin: 0.4, speedMax: 2, up: 2, life: 0.5, size: 0.09, kind: P_STAR, light: 75, gravity: -1 });
        break;
      }
      case 'dodge': {
        P.spawnBurst(x, z, { count: 6, hue: 40, sat: 20, speedMin: 0.5, speedMax: 2, up: 0.4, life: 0.4, size: 0.12, kind: P_DOT, light: 60, additive: false, alpha: 0.5 });
        break;
      }
      case 'hazard':
      case 'warning': {
        this.effects.ring(x, z, { r0: evt.radius ?? 1.6, r1: 0.2, dur: evt.dur ?? 0.9, hue: 355, width: 2, kind: 'ring' });
        break;
      }
      default:
        // 未知事件：只做最轻量的火花，保证视觉有反馈
        if (evt.x !== undefined && q > 0) {
          P.spawnBurst(x, z, { count: 4, hue, speedMin: 0.5, speedMax: 2, up: 0.8, life: 0.4, size: 0.08, kind: P_DOT, light: 70 });
        }
        break;
    }
    return this;
  }

  _onSkillCast(evt, x, z) {
    const id = normalizeSkillId(evt.skillId || evt.id || evt.skill);
    const meta = SKILL_META[id] || { hue: 36 };
    const hue = evt.hue ?? meta.hue;
    const P = this.particles;
    switch (id) {
      case 'stomp': {
        // [契约 v1] 战争践踏取代裂地斩：**360° 以自身为圆心**的踏地冲击。
        // 由 here 统一走 _playStomp，和 'stomp' 事件共用一套视觉（事件带 hits/armor 时更强）；
        // 只收到 skillCast（老 caller / 精简事件）时用基础强度也能踏出来。
        try {
          this._playStomp(x, z, evt);
        } catch (err) {
          this._warnEvent('skillCast.stomp', err);
        }
        break;
      }
      case 'groundSlam': {
        // [兼容保留] 旧「裂地斩」。新版本 core 已经不会再推它，但老事件/老存档、
        // 以及技能树数据里残留的 id 仍可能进来 —— 保持原来的锥形锤击表现，不报错。
        // 注意：_playStomp 会把 evt.skillId 改写成 'stomp' 以免重复播放；
        // 这里进来时 id 已经是归一化后的 groundSlam（说明是真正的旧事件）。
        this.effects.crack(x, z, { radius: evt.radius ?? 2.2, dur: 1.6, hue: 22, branches: 9 });
        this.effects.ring(x, z, { r0: 0.2, r1: evt.radius ?? 2.6, dur: 0.5, hue: 26, width: 6, kind: 'ground' });
        this.shockwave(x, z, 26, { radius: evt.radius ?? 2.8, dur: 0.6, count: 40 });
        P.spawnBurst(x, z, { count: 30, hue: 28, sat: 20, speedMin: 1, speedMax: 4.5, up: 1.3, life: 0.9, size: 0.22, kind: P_DOT, light: 40, gravity: 5, additive: false, alpha: 0.6, radius: 0.4 });
        P.spawnBurst(x, z, { count: 22, hue: 28, hueJitter: 14, speedMin: 2, speedMax: 7, up: 1.5, life: 0.8, size: 0.14, kind: P_QUAD, light: 60, gravity: 8, radius: 0.5 });
        // 锤击落点闪光
        P.spawnBurst(x, z, { count: 10, hue: 44, speedMin: 3, speedMax: 8, up: 1, life: 0.35, size: 0.16, kind: P_SPARK, light: 85 });
        this.cam.shake(11);
        this.flash(26, 0.12, 0.25);
        this.fx.chromaPulse(0.25);
        break;
      }
      case 'whirlwind': {
        // 不设置余晖时长：旋风的显示周期严格跟随 player.whirlspinning
        this.whirl.fadeOut = 1;
        this.whirl.hue = 36;
        this.cam.shake(2);
        break;
      }
      case 'warcry': this._playWarcry(x, z); break;
      case 'bloodRage': this._activateAura('bloodRage', evt.dur ?? 8, 352, 1); break;
      case 'rally':
      case 'totem': this._spawnTotem(x, z, evt.dur ?? 8); break;
      case 'dash': {
        for (let i = 0; i < 3; i++) this.effects.ghost(x, z, evt.facing ?? 0, { dur: 0.25 + i * 0.05, alpha: 0.4 - i * 0.1 });
        break;
      }
      case 'fireNova':
      case 'iceNova': {
        const h2 = id === 'iceNova' ? 195 : 20;
        this.shockwave(x, z, h2, { radius: evt.radius ?? 3.5, dur: 0.55, count: 36 });
        break;
      }
      case 'chainLightning': {
        P.spawnBurst(x, z, { count: 16, hue: 55, speedMin: 2, speedMax: 7, up: 0.8, life: 0.3, size: 0.12, kind: P_SPARK, light: 85 });
        break;
      }
      // ── 元素法师：填充技弹道 ────────────────────────────────────────────────
      case 'mageFirebolt':
      case 'mageIceShard':
      case 'mageArc': {
        const fromX = Number.isFinite(evt.fromX) ? evt.fromX : x;
        const fromZ = Number.isFinite(evt.fromZ) ? evt.fromZ : z;
        const boltHue = id === 'mageFirebolt' ? 24 : id === 'mageIceShard' ? 195 : 55;
        this.effects.bolt(fromX, fromZ, x, z, {
          h: 0.95, hue: boltHue, width: id === 'mageArc' ? 2.6 : 2.1,
          dur: id === 'mageArc' ? 0.1 : 0.13, branch: id === 'mageArc' ? 0.9 : 0.35,
        });
        P.spawnBurst(x, z, {
          count: id === 'mageIceShard' ? 12 : 10, hue: boltHue, hueJitter: 12,
          speedMin: 1.6, speedMax: 5, up: 0.7, life: 0.32, size: 0.1,
          kind: id === 'mageIceShard' ? P_QUAD : P_SPARK, light: 78, drag: 3.4, gravity: 4,
        });
        break;
      }
      case 'magePyro': {
        this._playMagePyro(x, z, evt);
        break;
      }
      case 'mageNova': {
        this._playMageNova(x, z, evt);
        break;
      }
      case 'mageBarrier': {
        this.effects.disk(x, z, { r1: 1.8, dur: 0.5, hue: 195, sat: 90, light: 62, alpha: 0.32, core: 0.3, rim: 0.6 });
        P.spawnBurstRing(x, z, {
          count: 18, radius: 0.5, jitter: 0.2, speedMin: 0.6, speedMax: 1.8, up: 1.4,
          life: 0.8, size: 0.1, kind: P_STAR, hue: 195, hueJitter: 10, light: 76, drag: 1.6, gravity: -1.2,
        });
        break;
      }
      case 'mageChain': {
        const fromX = Number.isFinite(evt.fromX) ? evt.fromX : x;
        const fromZ = Number.isFinite(evt.fromZ) ? evt.fromZ : z;
        this.effects.bolt(fromX, fromZ, x, z, { h: 0.9, hue: 55, width: 3, dur: 0.13, branch: 1.1 });
        P.spawnBurst(x, z, { count: 18, hue: 55, speedMin: 2, speedMax: 8, up: 0.9, life: 0.34, size: 0.13, kind: P_SPARK, light: 88 });
        this.effects.disk(x, z, { r1: 1.5, dur: 0.24, hue: 55, sat: 100, light: 70, alpha: 0.22, core: 0.15, rim: 0.6 });
        break;
      }
      case 'mageUltimate': {
        this._playMageUltimate(x, z, evt);
        break;
      }
      default: {
        this.shockwave(x, z, hue, { radius: evt.radius ?? 2, dur: 0.4, count: 16 });
        P.spawnBurst(x, z, { count: 10, hue, speedMin: 1, speedMax: 4, up: 1, life: 0.4, size: 0.1, kind: P_DOT, light: 70 });
        break;
      }
    }
  }

  // ── 元素法师：事件视觉 ─────────────────────────────────────────────────────

  /**
   * 元素反应：熔解（火）/ 超载（火雷爆炸）/ 等离子（冰雷眩晕）。
   * 用实心圆盘 + 粒子 + 反应名飘字，避免在 bloom 下出现细白环。
   */
  _playMageReaction(x, z, evt = {}) {
    const P = this.particles;
    const hue = Number.isFinite(evt.hue) ? evt.hue : 30;
    const name = evt.name || '元素反应';
    this.effects.disk(x, z, {
      r1: 1.9, dur: 0.34, hue, sat: 96, light: 64, alpha: 0.26, core: 0.2, rim: 0.8,
    });
    if (name === '超载') {
      this.effects.crack(x, z, { radius: 1.9, dur: 0.62, hue: 24, branches: 5 });
      P.spawnBurst(x, z, {
        count: 24, hue: 24, hueJitter: 18, speedMin: 2.4, speedMax: 7.5, up: 1.1,
        life: 0.5, size: 0.13, kind: P_SPARK, light: 82, drag: 2.6, gravity: 4,
      });
      this.cam.shake(4.5);
    } else if (name === '等离子') {
      P.spawnBurst(x, z, {
        count: 22, hue: 200, hueJitter: 22, speedMin: 2.2, speedMax: 8, up: 0.9,
        life: 0.4, size: 0.12, kind: P_SPARK, light: 84, drag: 2.8, gravity: 2,
      });
      this.cam.shake(2.5);
    } else {
      P.spawnBurst(x, z, {
        count: 16, hue: 24, hueJitter: 14, speedMin: 1.8, speedMax: 5.5, up: 1,
        life: 0.45, size: 0.12, kind: P_DOT, light: 76, drag: 2.4, gravity: 3,
      });
      P.spawnBurst(x, z, {
        count: 10, hue: 195, hueJitter: 12, speedMin: 1.4, speedMax: 4.5, up: 1.2,
        life: 0.5, size: 0.1, kind: P_QUAD, light: 78, drag: 2.2, gravity: 2,
      });
    }
    this.text.add(x, z, name, {
      kind: 'damage', h: 2.0, size: 15,
      color: `hsl(${hue} 100% 72%)`,
    });
  }

  /** 反应回响：从原目标弹向附近敌人的同色电光。 */
  _playMageEcho(evt, x, z) {
    const P = this.particles;
    const hue = Number.isFinite(evt.hue) ? evt.hue : 55;
    const fromX = Number.isFinite(evt.fromX) ? evt.fromX : x;
    const fromZ = Number.isFinite(evt.fromZ) ? evt.fromZ : z;
    this.effects.bolt(fromX, fromZ, x, z, { h: 0.85, hue, width: 2.2, dur: 0.12, branch: 0.9 });
    P.spawnBurst(x, z, {
      count: 9, hue, hueJitter: 16, speedMin: 1.6, speedMax: 5.5, up: 0.8,
      life: 0.3, size: 0.1, kind: P_SPARK, light: 86, drag: 3.2, gravity: 2,
    });
  }

  /** 天火陨星：天空斜落的火柱 + 落地裂纹 + 火焰圆盘。 */
  _playMageMeteor(x, z, evt = {}) {
    const P = this.particles;
    const level = Number.isFinite(evt.level) ? evt.level : 1;
    const r = clamp(Number.isFinite(evt.radius) ? evt.radius : 2.6, 1.2, 6.5);
    const power = clamp(level / 3, 0.25, 1);
    // 天空落下的斜向火柱（bolt 的 h 让它从高处插到地面）
    this.effects.bolt(x + 2.6, z - 2.2, x, z, {
      h: 5.4, hue: 22, sat: 100, light: 68, width: 7 + power * 4,
      dur: 0.24, branch: 0.22,
    });
    this.effects.crack(x, z, { radius: r * 0.95, dur: 0.95, hue: 22, branches: 6 + Math.round(power * 4) });
    this.effects.disk(x, z, {
      r1: r, dur: 0.5, hue: 24, sat: 100, light: 60,
      alpha: 0.34 + power * 0.08, core: 0.32, rim: 0.6,
    });
    this.shockwave(x, z, 24, { radius: r * 1.15, dur: 0.55, count: 34 });
    P.spawnBurstRing(x, z, {
      count: 22 + Math.round(power * 14), radius: r * 0.3, jitter: 0.3,
      speedMin: 2.4, speedMax: 6 + power * 2, up: 2.4,
      life: 0.75, size: 0.16, sizeEnd: 0.03, kind: P_SPARK,
      hue: 24, hueJitter: 16, sat: 100, light: 76, drag: 1.8, gravity: 7,
    });
    this.cam.shake(7 + power * 5);
    this.flash(24, 0.05 + power * 0.05, 0.2);
  }

  /** 环形法球：玩家 → 目标的细小元素弹道。 */
  _playMageOrb(evt, x, z) {
    const P = this.particles;
    const hue = Number.isFinite(evt.hue) ? evt.hue : 30;
    const fromX = Number.isFinite(evt.fromX) ? evt.fromX : x;
    const fromZ = Number.isFinite(evt.fromZ) ? evt.fromZ : z;
    this.effects.bolt(fromX, fromZ, x, z, {
      h: 1.0 + 0.08 * (Number.isFinite(evt.index) ? evt.index : 0),
      hue, width: 1.8, dur: 0.11, branch: 0.5,
    });
    P.spawnBurst(x, z, {
      count: 7, hue, hueJitter: 12, speedMin: 1.4, speedMax: 4.4, up: 0.7,
      life: 0.26, size: 0.09, kind: P_DOT, light: 80, drag: 3, gravity: 2,
    });
  }

  /** 三相齐射：火 / 冰 / 雷三道弹道同帧命中，颜色直接铺满屏幕。 */
  _playMageTrinity(evt, x, z) {
    const P = this.particles;
    const fromX = Number.isFinite(evt.fromX) ? evt.fromX : x;
    const fromZ = Number.isFinite(evt.fromZ) ? evt.fromZ : z;
    const els = Array.isArray(evt.elements) ? evt.elements : ['cold', 'lightning'];
    const hues = els.map((el) => (el === 'cold' ? 195 : el === 'lightning' ? 55 : 24));
    for (let i = 0; i < hues.length; i++) {
      this.effects.bolt(fromX, fromZ, x, z, {
        h: 0.8 + i * 0.18, hue: hues[i], width: 2.4, dur: 0.14, branch: 0.7,
      });
      P.spawnBurst(x, z, {
        count: 9, hue: hues[i], hueJitter: 10, speedMin: 1.8, speedMax: 5.6, up: 1,
        life: 0.34, size: 0.11, kind: P_SPARK, light: 84, drag: 2.8, gravity: 2,
      });
    }
    this.effects.disk(x, z, {
      r1: 1.6, dur: 0.28, hue: 280, sat: 90, light: 66, alpha: 0.2, core: 0.1, rim: 0.8,
    });
  }

  /** 炎爆术：目标处火焰爆发（强化时更大、更亮、带裂纹）。 */
  _playMagePyro(x, z, evt = {}) {
    const P = this.particles;
    const r = clamp(Number.isFinite(evt.radius) ? evt.radius : 3, 1, 7);
    const empowered = !!evt.empowered;
    this.effects.crack(x, z, {
      radius: r * 0.9, dur: 0.85, hue: 22, branches: empowered ? 10 : 6,
    });
    this.effects.disk(x, z, {
      r1: r, dur: 0.5, hue: empowered ? 38 : 24, sat: 100, light: 60,
      alpha: empowered ? 0.4 : 0.3, core: 0.35, rim: 0.65,
    });
    this.shockwave(x, z, 24, { radius: r * 1.1, dur: 0.5, count: empowered ? 42 : 28 });
    P.spawnBurstRing(x, z, {
      count: empowered ? 34 : 22, radius: r * 0.35, jitter: 0.28,
      speedMin: 2.2, speedMax: empowered ? 8 : 5.5, up: 1.6,
      life: 0.6, size: 0.13, sizeEnd: 0.02, kind: P_SPARK,
      hue: empowered ? 38 : 24, hueJitter: 14, sat: 100, light: 78, drag: 2.2, gravity: 4,
    });
    this.cam.shake(empowered ? 9 : 5.5);
    if (empowered) this.flash(24, 0.09, 0.22);
  }

  /** 霜环：以玩家为圆心的冰环，强化时更大、冻结更久。 */
  _playMageNova(x, z, evt = {}) {
    const P = this.particles;
    const r = clamp(Number.isFinite(evt.radius) ? evt.radius : 4.2, 1.5, 8);
    const empowered = !!evt.empowered;
    this.effects.disk(x, z, {
      r1: r, dur: 0.48, hue: 195, sat: 92, light: 66,
      alpha: empowered ? 0.34 : 0.24, core: 0.2, rim: 0.75,
    });
    this.shockwave(x, z, 195, { radius: r, dur: 0.55, count: empowered ? 44 : 30 });
    P.spawnBurstRing(x, z, {
      count: empowered ? 34 : 24, radius: r * 0.32, jitter: 0.26,
      speedMin: 1.8, speedMax: empowered ? 6.5 : 4.6, up: 2,
      life: 0.7, size: 0.12, sizeEnd: 0.02, kind: P_QUAD,
      hue: 195, hueJitter: 10, sat: 84, light: 76, drag: 2, gravity: 3,
    });
    P.spawnBurst(x, z, {
      count: empowered ? 20 : 12, hue: 195, hueJitter: 16, speedMin: 0.5, speedMax: 2.4,
      up: 2.4, life: 0.8, size: 0.1, kind: P_STAR, light: 82, drag: 1.4, gravity: -1.4,
    });
    this.cam.shake(empowered ? 6 : 3.5);
  }

  /** 元素狂潮：三色爆发 + 屏幕闪白 / 色差。 */
  _playMageUltimate(x, z, evt = {}) {
    const P = this.particles;
    const r = clamp(Number.isFinite(evt.radius) ? evt.radius : 4.6, 2, 9);
    this.flash(280, 0.16, 0.55);
    this.fx.chromaPulse(0.5);
    this.cam.shake(10);
    this.effects.disk(x, z, {
      r1: r, dur: 0.8, hue: 280, sat: 88, light: 66, alpha: 0.36, core: 0.24, rim: 0.8,
    });
    const hues = [280, 24, 195, 55];
    for (let i = 0; i < hues.length; i++) {
      P.spawnBurstRing(x, z, {
        count: 14, radius: r * (0.25 + i * 0.16), jitter: 0.22,
        speedMin: 2.2, speedMax: 6.8, up: 1.8,
        life: 0.85, size: 0.13, sizeEnd: 0.02, kind: P_STAR,
        hue: hues[i], hueJitter: 12, sat: 100, light: 78, drag: 1.8, gravity: 2,
      });
    }
    this.text.add(x, z, '元素狂潮', { kind: 'gold', h: 2.6, size: 24, life: 1.3 });
  }

  // ── 战争践踏 / 眩晕 / 技能升星 的视觉实现 ───────────────────────────────────

  /** 坏事件 payload 的告警（同一类型只警告一次，不刷屏） */
  _warnEvent(tag, err) {
    this._evtWarned = this._evtWarned || new Set();
    if (this._evtWarned.has(tag)) return;
    this._evtWarned.add(tag);
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[Renderer] 事件视觉异常（已忽略该次特效）:', tag, (err && err.message) || err);
    }
  }

  /**
   * 战争践踏：360° 以玩家为圆心的"踏实感"冲击。
   *
   * 与旧裂地斩（前向扇形 + 锤击落点）的区别：
   *   · 圆心就在脚下 → 冲击波是**同心双盘**（内圈亮金 = 踏击核心，外圈尘土 = 扬起的土浪），
   *     再叠一层地面裂纹，整体从脚下向四面八方推出去；
   *   · 强度随命中数（hits）上升：震屏、粒子量、裂纹分支数，但都有上限（性能 + 手感）。
   *
   * 硬约束（README「旋风斩视觉」）：**一律用实心非环形几何**。
   *   → 冲击波用 effects.disk（径向渐隐的实心圆盘 + 前沿亮带填充），不用 ring() 的细圆环描边；
   *   → 裂纹沿用 effects.crack（已有的刻痕 + 熔岩光画法，已经被实机验证不糊）。
   *
   * @param {number} x @param {number} z 踩踏圆心（世界坐标）
   * @param {object} evt { r|radius, hits, stunned, armor, dur, level, color }
   */
  _playStomp(x, z, evt = {}) {
    const q = this.quality;
    const P = this.particles;
    // 半径：契约里 r 与 radius 都给，任取其一；兜底 3.6（stomp 的基础半径）
    let r = Number(evt.radius ?? evt.r);
    if (!Number.isFinite(r) || r <= 0) r = 3.6;
    r = clamp(r, 1.6, 7.5);
    // 命中数 → 强度 0..1（3 只怪就接近满强度，避免大群怪时强度失控）
    const hits = Number.isFinite(evt.hits) ? evt.hits : (Number.isFinite(evt.stunned) ? evt.stunned : 0);
    const power = clamp(hits / 3, 0, 1);
    const qk = q === 2 ? 1 : q === 1 ? 0.7 : 0.45; // 画质档位的粒子系数（低画质砍到手感下限）

    // 1) 地面裂纹：从脚下向外炸开（分支数随强度 7→11）
    //    颜色偏土褐（26）而不是熔岩橙：践踏是"压碎石板"，不是灼烧。
    this.effects.crack(x, z, {
      radius: r * 0.94, dur: 1.05 + power * 0.35, hue: 26,
      branches: 7 + Math.round(power * 4),
    });

    // 2) 内圈亮金：踏击核心。短促、中途开始淡出（"第一脚砸实"的那一下）
    //    [实测] 这一层曾经是 0.42+ 的 alpha，叠上 bloom 后把角色糊成一个白团（见 stomp-badpayload 对照图），
    //    现在压到 0.3 左右，并依靠盘面内部的径向渐隐保持"亮而不白"。
    this.effects.disk(x, z, {
      r1: r * 0.42, dur: 0.26, hue: 42, sat: 100, light: 58,
      alpha: 0.3 + power * 0.06, core: 0.7, rim: 0.4,
    });
    // 3) 外圈尘土：扬起的土浪，慢一点、宽一点、偏土褐（additive 关闭避免发白）
    this.effects.disk(x, z, {
      r1: r * 1.02, dur: 0.62 + power * 0.1, hue: 26, sat: 30, light: 38,
      alpha: 0.3, core: 0.2, rim: 0.6,
    });
    // [实测] 原计划还有一层"中圈金色前沿"。多次践踏叠在一起时它会和上面两层一起过曝，
    // 所以直接去掉 —— 冲击感由内金盘 + 尘土外盘 + 粒子 + 震屏承担，两个圆盘已经足够。

    // 4) 环形尘土 + 碎石：一圈均匀向外推（spawnBurstRing 保证"整圈"而不是随机团簇）
    P.spawnBurstRing(x, z, {
      count: Math.round(18 + power * 12) * qk, radius: r * 0.32, jitter: 0.25,
      speedMin: 2.2, speedMax: 4.6 + power * 1.6, up: 1.1,
      life: 0.62, size: 0.18, sizeEnd: 0.24, kind: P_DOT,
      // 饱和度压在 30 以内 + 亮度 34：radial 渐变土棕，才像"土"而不是"灰烟"
      hue: 28, hueJitter: 6, sat: 30, light: 34, drag: 2.6, gravity: 1.6,
      additive: false, alpha: 0.5,
    });
    if (q > 0) {
      // 碎石：暗色方块，抛物线飞起再落地（P_QUAD + gravity）
      P.spawnBurstRing(x, z, {
        count: Math.round(8 + power * 6) * qk, radius: r * 0.22, jitter: 0.35,
        speedMin: 1.8, speedMax: 3.6 + power * 1.5, up: 2.6,
        life: 0.7, size: 0.1, sizeEnd: 0.07, kind: P_QUAD,
        hue: 28, hueJitter: 10, sat: 18, light: 34, drag: 1.4, gravity: 11,
        additive: false, alpha: 0.85,
      });
      // 金色碎屑：少量、只做点缀（数量克制 —— 别在每次践踏时喷上百个）
      P.spawnBurstRing(x, z, {
        count: Math.round(7 + power * 5) * qk, radius: r * 0.3, jitter: 0.3,
        speedMin: 2.4, speedMax: 5.2, up: 1.8,
        life: 0.42, size: 0.075, sizeEnd: 0.01, kind: P_SPARK,
        hue: 44, hueJitter: 8, sat: 100, light: 74, drag: 2.4, gravity: 4,
      });
    }

    // 6) 震屏：随命中数提升，封顶（power 上限已 clamp）；
    //    注意 core 也会推一条 'shake' 事件 —— 两处叠加会被 ScreenFx.shake 的单次上限吃掉一部分，
    //    所以这里刻意为"中等量级"，不要跟 core 抢强度。
    this.cam.shake(7 + power * 6);
    // 7) 轻闪白 + 半透明冲击**圆盘**（一次性、0.4s 内消失）。
    //    这里刻意不用 shockwave()：它画的是描边椭圆（线宽递减），在 bloom 下会变成一圈白环；
    //    换成 disk 的"前沿亮带 + 内部微光"后，既是一次性爆发的观感，又不会糊掉角色。
    //    [实测] 这层只保留给**低强度**施放（hits 少时画面本来就空，需要一点亮）；
    //    高强度时前三层已经够亮，再加就会在角色身上叠成白团，所以随 power 反向衰减。
    //    伤害飘字调用链：闪现用 strength 0.15 → forEachFlash 里 ×0.6 = 满屏 ~9% 亮度；
    //    原来是 0.05+power*0.05（≈6% ×2 = 12%），三连发时整屏发灰，已减半。
    this.flash('white', 0.03 + power * 0.03, 0.16);
    const surge = 1 - power * 0.55;
    this.effects.disk(x, z, {
      r1: r * 1.06, dur: 0.4, hue: 40, sat: 96, light: 52,
      alpha: (0.2 + power * 0.08) * surge, core: 0.06, rim: 0.7,
    });
    this.fx.chromaPulse(0.2 + power * 0.12);
    // 8) 命中的敌人脚下补一圈"被震得站不稳"的交错小亮瓣（数量克制：最多 3 个）
    const foes = this._stompNeighbors(x, z, r);
    for (let i = 0; i < foes.length && i < 3; i++) {
      const f = foes[i];
      if (!Number.isFinite(f.x) || !Number.isFinite(f.z)) continue;
      this.effects.disk(f.x, f.z, {
        r1: 0.55 + (i === 0 ? 0.1 : 0), dur: 0.3 + i * 0.04, hue: 34, sat: 30, light: 46,
        alpha: 0.24, core: 0.15, rim: 0.6,
      });
    }
    // 9) 一次性"踏"的余韵：很短的轻微慢动作，强调重量（不叠加成顿帧）
    if (power > 0.65) this.slowMo(0.1, 0.55);
  }

  /**
   * 找出践踏范围内的活着的敌人（只给视觉用，最多 3 个）。
   *
   * 为什么从世界数据里找而不是用事件里的列表：契约只给 `hits`（数字），不给目标数组；
   * 用 h * h 的半径平方比较，不做 sqrt（每次施放都要扫一遍怪物数组）。
   *
   * @param {number} x @param {number} z 圆心
   * @param {number} r 半径
   * @returns {Array<object>} 敌人实体（可能为空数组，调用方不要假设长度）
   */
  _stompNeighbors(x, z, r) {
    const out = [];
    const w = this.lastWorld;
    const list = w && (w.all || w.monsters);
    if (!Array.isArray(list)) return out;
    const r2 = r * r;
    for (let i = 0; i < list.length && out.length < 3; i++) {
      const m = list[i];
      if (!m || m === w.player || m.dead) continue;
      const dx = m.x - x, dz = m.z - z;
      if (dx * dx + dz * dz <= r2) out.push(m);
    }
    return out;
  }

  /**
   * 眩晕生效：头顶的星星由实体的 stunTime/stunMax 驱动绘制（见 draw-entities），
   * 这里只补一下"被砸晕"那一刻的小迸射，让眼睛看到"是谁被控了"。
   * @param {number} x @param {number} z @param {object} evt { target, dur, sourceSkill }
   */
  _onStun(x, z, evt = {}) {
    if (this.quality <= 0) return;
    const target = evt.target || null;
    const boss = !!(target && (target.isBoss || target.rarity === 'boss'));
    const elite = !!(target && (target.elite || target.rarity === 'rare'));
    const h = entityHeight(target, boss ? 2.4 : elite ? 1.5 : 1.2);
    const qk = this.quality === 2 ? 1 : 0.65;
    this.particles.spawnBurst(x, z, {
      count: Math.round((boss ? 12 : 7) * qk), hue: 52, hueJitter: 10,
      speedMin: 1.2, speedMax: 3.2, up: 1.8, life: 0.55, size: 0.09, kind: P_STAR,
      light: 82, gravity: -1.2, drag: 2.2, radius: 0.18, h: h * 0.9,
    });
    this.effects.ring(x, z, { r0: 0.15, r1: 0.55 + (boss ? 0.5 : 0), dur: 0.24, hue: 52, width: 2, kind: 'slash' });
  }

  /**
   * 眩晕结束（实体 stunTime 归零）：撒一把碎星，表示"控制解除"。
   * @param {number} x @param {number} z @param {object} evt { target, sourceSkill }
   */
  _onStunEnd(x, z, evt = {}) {
    if (this.quality <= 0) return;
    const target = evt.target || null;
    const boss = !!(target && (target.isBoss || target.rarity === 'boss'));
    const h = entityHeight(target, boss ? 2.4 : 1.2);
    const qk = this.quality === 2 ? 1 : 0.6;
    this.particles.spawnBurst(x, z, {
      count: Math.round((boss ? 10 : 6) * qk), hue: 50, hueJitter: 14,
      speedMin: 0.6, speedMax: 2.4, up: 0.5, life: 0.45, size: 0.07, kind: P_STAR,
      light: 76, gravity: 3.2, drag: 1.8, radius: 0.3, h: h * 0.85,
    });
  }

  /**
   * 技能升星闪光（skillRankUp / skillRefine）：levelUp 的"小一号"版本。
   *
   * · skillRankUp：金色主调（天赋点投入 → 技能变强）
   * · skillRefine：金属白金色调（消耗精炼石精炼 → 更"精工"的冷白金）
   * · 没有 x/z 时以玩家为圆心（技能面板里点的升级）；有坐标（例如战场拾取触发）就用事件坐标。
   *
   * 只用实心圆盘 + 星芒粒子，**不画整圈细描边环**（bloom 会连成白环）。
   *
   * @param {number} x @param {number} z
   * @param {object} evt { skillId, name, rank, maxRank, level, refine }
   * @param {boolean} refine true = 精炼（白金色），false = 天赋升星（金色）
   */
  _onSkillUp(x, z, evt = {}, refine) {
    const q = this.quality;
    const P = this.particles;
    const qk = q === 2 ? 1 : q === 1 ? 0.7 : 0.4;
    const hue = refine ? 50 : 42;          // 精炼偏冷白（低饱和高亮度），升星偏暖金
    const sat = refine ? 42 : 96;
    const light = refine ? 82 : 66;

    // 1) 脚下的实心小圆盘（比 levelUp 的 4 格半径小一号 → 2.1 格）
    this.effects.disk(x, z, { r1: 2.1, dur: 0.5, hue, sat, light, alpha: 0.26, core: 0.5, rim: 0.35 });
    this.effects.disk(x, z, { r1: 1.15, dur: 0.3, hue, sat: sat + 4, light: light + 12, alpha: 0.3, core: 0.9, rim: 0.3 });
    // 2) 星芒粒子：从脚下向上炸开再缓缓飘落
    P.spawnBurstRing(x, z, {
      count: Math.round(14 * qk), radius: 0.5, jitter: 0.4,
      speedMin: 0.9, speedMax: 2.6, up: 2.4,
      life: 0.85, size: 0.085, sizeEnd: 0.01, kind: P_STAR,
      hue, hueJitter: refine ? 6 : 12, sat, light: light + 12, drag: 1.6, gravity: -0.8,
    });
    P.spawnBurst(x, z, {
      count: Math.round(6 * qk), hue, hueJitter: 8, sat, speedMin: 0.4, speedMax: 1.6,
      up: 3.2, life: 1.0, size: 0.07, kind: P_DOT, light: light + 16, gravity: -1.6, drag: 0.8, radius: 0.35,
    });
    // 3) 轻闪 + 一下很小的震动（技能面板里升的也不要在战场上震得难受）
    this.flash(refine ? 'white' : 'gold', 0.1, 0.3);
    this.cam.shake(2.2);
    this.fx.chromaPulse(0.16);
  }

  _playWarcry(x, z) {
    const P = this.particles;
    // 三道向外扩张的金色音波环
    for (let i = 0; i < 3; i++) {
      this.effects.ring(x, z, { r0: 0.3 + i * 0.2, r1: 4.5 + i * 0.8, dur: 0.65 + i * 0.12, hue: 44, width: 5 - i, kind: 'wave' });
    }
    this.shockwave(x, z, 44, { radius: 5.5, dur: 0.8, count: 30 });
    P.spawnRing(x, z, { count: 30, radius: 0.8, hue: 44, speed: 3.2, life: 0.7, size: 0.12, up: 1.2, kind: P_STAR, light: 78 });
    this.cam.shake(4.5);
    this.flash('gold', 0.1, 0.3);
  }

  _activateAura(kind, dur, hue, power) {
    let slot = this.auras.find((a) => a.active && a.kind === kind);
    if (!slot) slot = this.auras.find((a) => !a.active) || this.auras[0];
    slot.active = true;
    slot.kind = kind;
    slot.left = dur;
    slot.dur = dur;
    slot.color = hue;
    slot.power = power ?? 1;
  }

  _spawnTotem(x, z, dur) {
    let t = this.totems.find((o) => o.active && o.x === x && o.z === z);
    if (!t) t = this.totems.find((o) => !o.active) || this.totems[0];
    t.active = true;
    t.x = x; t.z = z;
    t.left = dur; t.dur = dur;
    t.hue = 205;
    this.effects.ring(x, z, { r0: 0.2, r1: 2.2, dur: 0.6, hue: 205, width: 3, kind: 'ring' });
  }

  _takeShockwave() {
    // 找最后激活的（环形复用）
    for (const s of this.shockwaves) if (!s.active) return s;
    return this.shockwaves[(this.frame++) % this.shockwaves.length];
  }

  // ── 主渲染入口 ─────────────────────────────────────────────────────────────

  /**
   * @param {object} world 游戏世界（只读）
   * @param {number} dt 帧时间（秒）
   * @param {number} time 累计时间
   */
  render(world, dt, time) {
    // 离屏录制：把本帧所有绘制调用交给外部光栅器（仅无浏览器验证使用）
    const cap = this._capture;
    if (cap && typeof cap.beginFrame === 'function') {
      try {
        cap.beginFrame(this);
        this._renderFrame(world, dt, time);
      } finally {
        cap.endFrame();
      }
      return this;
    }
    // 单帧异常保护：绝不让一帧的错误让整页白屏（同样错误只警告一次）
    try {
      this._renderFrame(world, dt, time);
    } catch (err) {
      this.errorCount = (this.errorCount || 0) + 1;
      const msg = (err && err.message) || String(err);
      this.lastError = msg + '\n' + String((err && err.stack) || '').split('\n').slice(1, 4).join('\n');
      this._warned = this._warned || new Set();
      if (!this._warned.has(msg) && typeof console !== 'undefined' && console.warn) {
        this._warned.add(msg);
        console.warn('[Renderer] 帧渲染异常（已忽略，同错误只提示一次）:', msg);
      }
      // 尽量恢复上下文状态，避免后续帧跟着坏掉
      try {
        this.ctx.setTransform(this.quality === 0 ? 1 : this.dpr, 0, 0, this.quality === 0 ? 1 : this.dpr, 0, 0);
        this.ctx.globalAlpha = 1;
        this.ctx.globalCompositeOperation = 'source-over';
      } catch (_) { /* ignore */ }
    }
    return this;
  }

  _renderFrame(world, dt, time) {
    if (!this.ctx && this.canvas) this._initContext();
    if (!this.ctx) return this; // 无 canvas：静默（Node/冒烟测试）
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 0.1);
    this.time = Number.isFinite(time) ? time : this.time + dt;
    this.frame++;
    this.lastWorld = world || null;
    const ctx = this.ctx;
    const cam = this.cam;
    const dpr = this.quality === 0 ? 1 : this.dpr;
    const W = this.w, H = this.h;

    // 0) 相机跟随（玩家）
    const player = world && world.player;
    this.lastPlayer = player || null;
    if (player && Number.isFinite(player.x)) {
      const look = world.aim || world.cameraTarget || null;
      cam.target(player.x, player.z, dt, look);
      // 冲刺残影（有速度时自动补）
      const sp = Math.hypot(player.vx || 0, player.vz || 0);
      this.dashTrailTimer -= dt;
      if (sp > 6 && this.dashTrailTimer <= 0) {
        this.dashTrailTimer = 0.03;
        this.effects.ghost(player.x, player.z, player.facing || 0, { dur: 0.26, alpha: 0.35 });
      }
    }
    cam.update(dt);
    // 屏幕震动请求
    const shakeReq = this.fx.consumeShake();
    if (shakeReq > 0) cam.shake(shakeReq);

    // 1) 更新所有纯逻辑系统
    const simDt = dt * this.fx.timeScale();
    this.fx.update(dt);
    this.particles.update(simDt);
    this.text.update(dt);
    this.effects.update(simDt);
    this._updateSkillLayers(simDt, world);
    this._updateWhirl(simDt, world);
    this._updateShockwaves(simDt);
    // 低血呼吸 + 玩家受伤红边
    const hpRatio = player && player.maxHp ? clamp(player.hp / player.maxHp, 0, 1) : 1;
    this.fx.setLowHp(hpRatio < 0.35 ? 1 - hpRatio / 0.35 : 0);
    if (player && this.lastHpRatio - hpRatio > 0.005) this.enemyFlash = Math.min(1, this.enemyFlash + (this.lastHpRatio - hpRatio) * 2.2);
    this.lastHpRatio = hpRatio;
    this.enemyFlash = Math.max(0, this.enemyFlash - dt * 2.4);
    this._ambientEmbers(world, dt);
    // fps 统计
    this._fpsAcc += dt;
    this._fpsN++;
    if (this._fpsAcc > 0.5) {
      this.fps = Math.round(this._fpsN / this._fpsAcc);
      this._fpsAcc = 0;
      this._fpsN = 0;
    }

    // 2) 绘制
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    this._drawBackground(ctx, cam, world);
    this._drawGround(ctx, cam, world);
    this._drawWalls(ctx, cam, world);
    this._drawGroundEffects(ctx, cam, world);
    this._drawItemsAndOrbs(ctx, cam, world);
    this._drawShadows(ctx, cam, world);
    this._drawWhirl(ctx, cam);
    this._drawEntities(ctx, cam, world);
    this._drawProjectiles(ctx, cam, world);
    this._drawParticles(ctx, cam);
    this._drawShockwaves(ctx, cam);
    this._drawOverlays(ctx, cam, world);
    this._drawFloatingText(ctx, cam);
    this._postProcess(ctx, cam, world, dt);

    if (this.debug) this._drawDebug(ctx, cam, world);
    return this;
  }
}

// ── 拆分模块的绘制方法（挂到原型，保持 Renderer 公共 API 不变） ──────────────
const debugMethods = {
  _drawDebug(ctx, cam, world) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, 8, 264, 100);
    ctx.fillStyle = '#8ff';
    const lines = [
      `fps ${this.fps}  q${this.quality}  dpr ${this.dpr}`,
      `particles ${this.particles.size}/${this.particles.max}`,
      `text ${this.text.activeCount}/60  ents ${this.stats.drawnEntities}`,
      `scale ${cam.scale.toFixed(1)}  shake ${cam.shakeAmt.toFixed(1)}`,
      `timeScale ${this.fx.timeScale().toFixed(2)}  chroma ${this.fx.chroma.toFixed(2)}`,
      `cam (${cam.x.toFixed(2)}, ${cam.y.toFixed(2)})`,
    ];
    lines.forEach((s, i) => ctx.fillText(s, 16, 26 + i * 14));
    if (world && world.all) {
      for (const m of world.all) {
        if (!m || !Number.isFinite(m.x)) continue;
        const p = cam.worldToScreen(m.x, m.z, 0, this.scratch);
        ctx.strokeStyle = 'rgba(0,255,128,0.4)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, (m.radius ?? 0.35) * cam.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
};

mixin(Renderer.prototype, renderCore);
mixin(Renderer.prototype, renderEntities);
mixin(Renderer.prototype, renderWhirl);
mixin(Renderer.prototype, debugMethods);

// 供外部使用的类型/常量（可选）
export { WALL_H, SKILL_META, normalizeSkillId, P_DOT, P_LINE, P_STAR, P_QUAD, P_SPARK, hash2 };
export default Renderer;