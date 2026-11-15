// ─────────────────────────────────────────────────────────────────────────────
// screenFx.js — 全屏后处理状态机（纯逻辑，无 DOM）。
// 负责：闪白/闪光层、震动请求、慢动作时间缩放、受击红晕、色差强度、调色提示。
// 真正的绘制在 renderer.js。
// ─────────────────────────────────────────────────────────────────────────────

export class ScreenFx {
  constructor() {
    // 闪光层：多个可叠加（红闪 + 白闪 + 金闪）
    this.flashes = []; // {color,hue,sat,light,strength,t,dur,kind}
    this.maxFlashes = 6;
    this.shakeReq = 0; // 本帧请求的震动（由 renderer 读取后清零）
    this.shakeAccum = 0;
    // 慢动作
    this.slowDur = 0;
    this.slowLeft = 0;
    this.slowScale = 1;
    this.slowRampIn = 0.05; // 秒：进入慢动作的过渡
    // 受击红晕
    this.hurt = 0; // 0..1
    this.hurtDecay = 1.6;
    // 色差强度 0..1
    this.chroma = 0;
    this.chromaDecay = 2.2;
    // 屏幕整体色调（血怒等）hue + 强度
    this.tint = null; // {hue,sat,light,strength,left,dur}
    // 暗角强度 0..1（低血时呼吸红边用）
    this.lowHp = 0;
    this.time = 0;
    // 击杀时刻的"顿帧"（hit-stop）
    this.hitStop = 0;
  }

  reset() {
    this.flashes.length = 0;
    this.shakeReq = 0;
    this.shakeAccum = 0;
    this.slowDur = 0;
    this.slowLeft = 0;
    this.slowScale = 1;
    this.hurt = 0;
    this.chroma = 0;
    this.tint = null;
    this.lowHp = 0;
    this.hitStop = 0;
  }

  /**
   * 叠一层闪光
   * @param {string} color hsl 色相数字字符串或 css 色；也接受 {h,s,l}
   * @param {number} strength 0..1
   * @param {number} dur 秒
   * @param {string} kind 'flash' | 'hurt' | 'edge'
   */
  flash(color, strength = 0.5, dur = 0.25, kind = 'flash') {
    if (this.flashes.length >= this.maxFlashes) this.flashes.shift();
    const c = parseHsl(color);
    this.flashes.push({
      hue: c.h, sat: c.s, light: c.l, color: typeof color === 'string' ? color : `hsl(${c.h} ${c.s}% ${c.l}%)`,
      strength: Math.max(0, Math.min(1, strength)), t: 0, dur: Math.max(0.02, dur), kind,
    });
    return this;
  }

  /**
   * 请求震动（renderer 每帧取走 shakeReq）。
   *
   * 逐次调用有**上限**：正式战斗里怪物死亡/暴击/技能都会 shake，
   * 同一帧内叠加十几条事件时 `consumeShake()` 会一次性把 shakeAmt 顶到 40px 上限，
   * 画面剧烈抖动反而看不清内容。因此单次请求被夹在 [0, 22]（单个事件的"份量"），
   * 总量仍由 Camera.shake 的 40px 缓冲吸收 —— 大事件依旧更有冲击力。
   */
  shake(amount) {
    if (amount > 0) this.shakeReq += Math.min(22, amount);
    return this;
  }

  /**
   * 慢动作。dur 秒内时间缩放为 scale（0.25 = 四分之一速）。
   * @param {number} dur @param {number} scale
   */
  slowMo(dur = 0.6, scale = 0.25) {
    if (!(dur > 0)) return this;
    scale = Math.max(0.02, Math.min(1, scale));
    // 取更强（更慢）的那个；时长取较长
    this.slowScale = Math.min(this.slowScale < 1 ? this.slowScale : 1, scale);
    this.slowDur = Math.max(this.slowDur, dur);
    this.slowLeft = Math.max(this.slowLeft, dur);
    return this;
  }

  /** 受击红晕（玩家受伤） */
  hurtScreen(amount = 0.5) {
    this.hurt = Math.min(1, this.hurt + amount);
    return this;
  }

  /** 击杀顿帧（极短时间的冻结感，靠 renderer 读取） */
  freeze(sec = 0.045) {
    this.hitStop = Math.max(this.hitStop, sec);
    return this;
  }

  /** 色差脉冲 */
  chromaPulse(amount = 0.5) {
    this.chroma = Math.min(1, this.chroma + amount);
    return this;
  }

  /** 全局色调（血怒等持续效果） */
  setTint(hue, strength = 0.2, dur = 1) {
    const c = parseHsl(hue);
    this.tint = { hue: c.h, sat: c.s, light: c.l, strength, left: dur, dur };
    return this;
  }

  /** 低血呼吸（0..1，由 renderer 依据 hp 比例传入） */
  setLowHp(v) {
    this.lowHp = Math.max(0, Math.min(1, v));
    return this;
  }

  /**
   * 当前时间缩放（1.0 = 正常）。renderer 用它来缩放游戏 dt。
   */
  timeScale() {
    if (this.slowLeft <= 0) return 1;
    // 进出都有个线性过渡，避免突兀
    const total = this.slowDur || 1;
    const elapsed = total - this.slowLeft;
    const tin = Math.min(1, elapsed / this.slowRampIn);
    const tout = Math.min(1, this.slowLeft / 0.16);
    const k = Math.min(tin, tout);
    return 1 + (this.slowScale - 1) * k;
  }

  update(dt) {
    if (!(dt > 0)) return this;
    // 不截断 dt：主循环用固定步长（1/60），但测试与切后台回来可能传较大的 dt，
    // 计时器必须完整推进，否则慢动作/闪光永远不结束。
    dt = Math.min(dt, 2);
    this.time += dt;
    // 闪光
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      if (f.t >= f.dur) this.flashes.splice(i, 1);
    }
    // 慢动作
    if (this.slowLeft > 0) {
      this.slowLeft = Math.max(0, this.slowLeft - dt);
      if (this.slowLeft <= 0) {
        this.slowDur = 0;
        this.slowScale = 1;
      }
    }
    // 红晕 / 色差
    this.hurt = Math.max(0, this.hurt - this.hurtDecay * dt * (0.35 + this.hurt));
    this.chroma = Math.max(0, this.chroma - this.chromaDecay * dt);
    if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt);
    if (this.tint) {
      this.tint.left -= dt;
      if (this.tint.left <= 0) this.tint = null;
    }
    return this;
  }

  /** 取出并清零震动请求（renderer 每帧调用一次） */
  consumeShake() {
    const v = this.shakeReq;
    this.shakeReq = 0;
    return v;
  }

  /** 遍历闪光层（renderer 绘制 alpha 用） */
  forEachFlash(fn) {
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      const k = f.t / f.dur; // 0 → 1
      // 快升慢降：开始时就有可见强度（避免第一帧"闪空"），随后缓慢衰减
      const head = 0.12;
      const rise = k < head ? 0.65 + (k / head) * 0.35 : 1;
      const alpha = f.strength * rise * Math.max(0, 1 - Math.pow(Math.max(0, (k - head) / (1 - head)), 1.4));
      fn(f, Math.max(0, alpha), k);
    }
  }
}

/** 'red' / 20 / 'hsl(20 100% 50%)' / '#ff0000' → {h,s,l} */
export function parseHsl(c) {
  if (c && typeof c === 'object') return { h: c.h ?? 0, s: c.s ?? 80, l: c.l ?? 60 };
  if (typeof c === 'number') return { h: c, s: 90, l: 55 };
  if (typeof c !== 'string') return { h: 0, s: 0, l: 100 };
  const s0 = c.trim().toLowerCase();
  const named = {
    white: { h: 0, s: 0, l: 100 }, red: { h: 352, s: 100, l: 52 }, gold: { h: 42, s: 100, l: 55 },
    amber: { h: 36, s: 100, l: 55 }, green: { h: 130, s: 80, l: 50 }, blue: { h: 210, s: 100, l: 58 },
    purple: { h: 275, s: 90, l: 60 }, cyan: { h: 190, s: 100, l: 58 }, orange: { h: 22, s: 100, l: 55 },
    black: { h: 0, s: 0, l: 0 }, yellow: { h: 54, s: 100, l: 58 },
  };
  if (named[s0]) return { ...named[s0] };
  const m = s0.match(/hsl\(\s*([\d.]+)(?:\s*[ ,]\s*([\d.]+)%)?(?:\s*[ ,]\s*([\d.]+)%)?/);
  if (m) return { h: +m[1], s: m[2] !== undefined ? +m[2] : 90, l: m[3] !== undefined ? +m[3] : 55 };
  const hex = s0.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/);
  if (hex) {
    let hx = hex[1];
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    const r = parseInt(hx.slice(0, 2), 16) / 255, g = parseInt(hx.slice(2, 4), 16) / 255, b = parseInt(hx.slice(4, 6), 16) / 255;
    return rgbToHsl(r, g, b);
  }
  if (/^\d+(\.\d+)?$/.test(s0)) return { h: +s0, s: 90, l: 55 };
  return { h: 0, s: 0, l: 100 };
}

export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

/** 元素 → 色相（伤害飘字 / 粒子 / 投射物） */
export const ELEMENT_HUE = {
  physical: 0, fire: 22, cold: 195, ice: 195, lightning: 55, chaos: 285, void: 285,
  poison: 120, bleed: 352, holy: 46, arcane: 265, blood: 350, holy_fire: 30,
};

export function elementHue(el, fallback = 30) {
  if (typeof el === 'number') return el;
  if (!el) return fallback;
  return ELEMENT_HUE[String(el).toLowerCase()] ?? fallback;
}