// ─────────────────────────────────────────────────────────────────────────────
// floatingText.js — 飘字池（伤害数字 / 回血 / 经验 / 提示）。纯逻辑，无 DOM。
// 上限 60 条；满了覆盖最老的。上升 + 淡出 + 轻微横向漂移。
// ─────────────────────────────────────────────────────────────────────────────

export const FT_MAX = 60;

/**
 * 飘字整体字号缩放。
 * 初版在 1080p 下数字偏大（普通命中约 29px、暴击约 48px），遮挡角色和怪物；
 * 统一缩到 50%，实际大小仍由相机 scale 做一次缩放（见 draw-core 的 _drawFloatingText）。
 */
export const FT_SCALE = 0.5;

export const FT_STYLE = {
  damage: { size: 18, weight: 800, hue: 0, sat: 0, light: 96, rise: 1.1, dur: 0.85, shadow: true },
  crit: { size: 30, weight: 900, hue: 45, sat: 100, light: 60, rise: 1.5, dur: 1.05, shadow: true },
  // 玩家自己受到的伤害：红色 + 负号，和"打怪的伤害"一眼区分
  playerHurt: { size: 22, weight: 800, hue: 4, sat: 92, light: 60, rise: 1.35, dur: 0.95, shadow: true },
  playerCrit: { size: 32, weight: 900, hue: 0, sat: 100, light: 58, rise: 1.6, dur: 1.1, shadow: true },
  fire: { size: 19, weight: 800, hue: 22, sat: 100, light: 58, rise: 1.1, dur: 0.85 },
  cold: { size: 19, weight: 800, hue: 195, sat: 95, light: 68, rise: 1.1, dur: 0.85 },
  lightning: { size: 19, weight: 800, hue: 55, sat: 100, light: 66, rise: 1.1, dur: 0.8 },
  chaos: { size: 19, weight: 800, hue: 285, sat: 85, light: 62, rise: 1.1, dur: 0.9 },
  physical: { size: 19, weight: 800, hue: 0, sat: 0, light: 96, rise: 1.1, dur: 0.85 },
  heal: { size: 20, weight: 800, hue: 120, sat: 80, light: 55, rise: 1.2, dur: 1.0 },
  xp: { size: 16, weight: 700, hue: 275, sat: 90, light: 68, rise: 1.3, dur: 1.0, prefix: '+' },
  info: { size: 16, weight: 600, hue: 40, sat: 30, light: 86, rise: 1.0, dur: 1.1 },
  miss: { size: 16, weight: 700, hue: 0, sat: 0, light: 70, rise: 1.0, dur: 0.7 },
  gold: { size: 20, weight: 900, hue: 44, sat: 100, light: 58, rise: 1.4, dur: 1.2 },
};

export class FloatingText {
  constructor(max = FT_MAX) {
    this.max = max | 0;
    this.items = new Array(this.max);
    for (let i = 0; i < this.max; i++) {
      this.items[i] = {
        active: false, x: 0, z: 0, h: 0, vx: 0, vh: 0, text: '', kind: 'damage',
        life: 0, maxLife: 1, size: 18, drift: 0, crit: false, wobble: 0, scalePop: 0, id: 0,
      };
    }
    this.next = 0; // 环形写指针
    this.activeCount = 0;
    this.seq = 0;
  }

  get size() {
    return this.activeCount;
  }

  reset() {
    for (let i = 0; i < this.max; i++) this.items[i].active = false;
    this.next = 0;
    this.activeCount = 0;
  }

  /**
   * 添加一条飘字
   * @param {number} x @param {number} z
   * @param {string|number} text
   * @param {object} o kind, crit, size, h(起始高度), life, color(可选 css), vx, drift
   */
  add(x, z, text, o = {}) {
    const it = this.items[this.next];
    if (it.active) {
      // 覆盖时计数不变
    } else {
      this.activeCount++;
    }
    this.next = (this.next + 1) % this.max;
    const kind = o.kind || (o.crit ? 'crit' : 'damage');
    const st = FT_STYLE[kind] || FT_STYLE.damage;
    it.active = true;
    it.x = Number.isFinite(x) ? x : 0;
    it.z = Number.isFinite(z) ? z : 0;
    it.h = o.h ?? 1.5;
    it.vx = o.vx ?? (Math.random() - 0.5) * 0.6;
    it.vh = o.vh ?? st.rise;
    it.text = String(text);
    it.kind = kind;
    it.crit = !!o.crit || kind === 'crit';
    it.size = (o.size ?? (o.crit ? st.size * 1.0 : st.size)) * FT_SCALE;
    it.maxLife = Math.max(0.1, o.life ?? st.dur);
    it.life = it.maxLife;
    it.drift = o.drift ?? 0;
    it.wobble = Math.random() * 6.283;
    it.scalePop = it.crit ? 1 : 0.55;
    it.color = o.color || '';
    it.id = ++this.seq;
    return it;
  }

  update(dt) {
    if (!(dt > 0)) return this.activeCount;
    // 大 dt 拆分（切后台回来也不会让飘字"瞬移"）
    const SUB = 1 / 60;
    let remaining = dt;
    let alive = this.activeCount;
    while (remaining > 1e-9) {
      const step = remaining > SUB ? SUB : remaining;
      remaining -= step;
      alive = this._step(step);
      if (alive === 0) break;
    }
    this.activeCount = alive;
    return alive;
  }

  _step(dt) {
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const it = this.items[i];
      if (!it.active) continue;
      it.life -= dt;
      if (it.life <= 0) {
        it.active = false;
        continue;
      }
      // 先快后慢的上升（ease-out）
      const k = 1 - it.life / it.maxLife;
      const rise = 1 - Math.pow(1 - Math.min(1, k * 1.6), 2);
      it.h += it.vh * dt * (1 - rise * 0.7);
      it.x += it.vx * dt;
      it.scalePop += (1 - it.scalePop) * Math.min(1, dt * 14);
      alive++;
    }
    return alive;
  }

  /** 遍历活跃飘字（renderer 绘制用） */
  forEach(fn) {
    for (let i = 0; i < this.max; i++) {
      const it = this.items[i];
      if (!it.active) continue;
      const k = 1 - it.life / it.maxLife;
      const st = FT_STYLE[it.kind] || FT_STYLE.damage;
      fn({
        x: it.x, z: it.z, h: it.h, text: it.text, kind: it.kind, crit: it.crit,
        t: k, // 0 → 1 进度
        alpha: k < 0.62 ? 1 : 1 - (k - 0.62) / 0.38,
        size: it.size * it.scalePop,
        slip: (it.wobble + k * 5) * it.drift,
        style: st,
        color: it.color || null,
      });
    }
  }
}