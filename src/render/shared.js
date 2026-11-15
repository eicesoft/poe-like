// ─────────────────────────────────────────────────────────────────────────────
// shared.js — 渲染器各拆分模块共用的小工具（无状态、无 DOM）
// ─────────────────────────────────────────────────────────────────────────────
import { hsl } from './sprites.js';

/** 把一组方法挂到原型（拆分模块用，保持 Renderer 单一公共类） */
export function mixin(proto, methods) {
  if (!methods) return proto;
  for (const k of Object.keys(methods)) {
    if (k === '__esModule' || k === 'default') continue;
    proto[k] = methods[k];
  }
  return proto;
}

/** 实体 z 排序：z 升序（远先画），同 z 按 id */
export function zSort(a, b) {
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

/** 数字缩写：1234 → 1.2K */
export function fmtNum(n) {
  const v = Math.abs(n);
  if (v >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (v >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

/** 确定性 PRNG（闪电折线用；不依赖 Math.random，同一 seed 每帧稳定） */
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 地面效果字段别名：{r, remaining} → {radius, t, dur}（复用临时对象，不 new） */
const _gfxScratch = { x: 0, z: 0, radius: 1, color: 30, kind: 'fire', t: 0, dur: 1 };
export function normalizeGroundFx(e) {
  _gfxScratch.x = e.x;
  _gfxScratch.z = e.z;
  _gfxScratch.radius = e.radius ?? e.r ?? 1;
  _gfxScratch.dur = e.dur ?? (e.remaining !== undefined && e.t !== undefined ? e.t + e.remaining : 1);
  _gfxScratch.t = e.t ?? (e.remaining !== undefined && e.dur !== undefined ? e.dur - e.remaining : 0.3);
  _gfxScratch.kind = e.kind || 'fire';
  _gfxScratch.color = e.color;
  return _gfxScratch;
}

/** 玩家技能名/状态 → 是否处于旋风斩 */
const WHIRL_STATES = new Set(['whirlwind', 'spin', 'whirl']);

export function isWhirlState(p) {
  if (!p) return false;
  const st = p.anim && p.anim.state;
  if (st && WHIRL_STATES.has(st)) return true;
  return !!(p.whirlwind || (p.anim && p.anim.whirlwind));
}

/** 玩家是否有血怒类 buff（玩家 buffs 可能是字符串或对象） */
export function hasBloodRage(p) {
  if (!p || !Array.isArray(p.buffs)) return false;
  for (const b of p.buffs) {
    const name = typeof b === 'string' ? b : b && (b.id || b.name || b.key || b.buffId || '');
    if (name && /bloodRage|blood_rage|rage|frenzy|血怒|狂暴|berserk/i.test(String(name))) return true;
  }
  return false;
}

/** 乘法混色：a → b，k∈[0,1]；a/b 为 {h,s,l} 或 {r,g,b} */
export function mixColor(a, b, k) {
  return { h: a.h + (b.h - a.h) * k, s: a.s + (b.s - a.s) * k, l: a.l + (b.l - a.l) * k };
}

/** 以 base 为底色的渐变（顶部亮、底部暗），用于重复绘制实体时缓存 */
export function bodyGradient(ctx, y0, y1, h, s, l) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, hsl(h, s * 0.9, Math.min(80, l + 16)));
  g.addColorStop(0.5, hsl(h, s, l));
  g.addColorStop(1, hsl(h, s * 0.8, Math.max(6, l - 26)));
  return g;
}