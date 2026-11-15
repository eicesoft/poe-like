// ─────────────────────────────────────────────────────────────────────────────
// project.js — 纯函数投影工具（无 DOM，可在 Node 中 import）
// 世界坐标：XZ 平面（y = 高度）。屏幕坐标：cx/cy 为视口中心。
//   sx = cx + (x - cam.x) * scale
//   sy = cy + (z - cam.z) * scale * squash   (squash = 0.72 → 2.5D 俯视角压缩)
//   高度 h（世界单位，1 = 一个 tile 左右）在屏幕上额外上抬：sy -= h * scale * heightK
// ─────────────────────────────────────────────────────────────────────────────

export const VIEW_DEFAULTS = Object.freeze({
  cx: 0,
  cy: 0,
  scale: 30,
  squash: 0.72,
  heightK: 0.9,
});

/**
 * 把相机 + 视口合并成一份"视图快照"。obj 允许只传部分字段。
 * @param {{x:number,y:number,scale:number,squash?:number,heightK?:number,shakeX?:number,shakeY?:number}} cam
 * @param {{cx:number,cy:number,scale?:number,squash?:number,heightK?:number,w?:number,h?:number}} view
 */
export function makeView(cam, view = {}) {
  const scale = num(view.scale, num(cam && cam.scale, VIEW_DEFAULTS.scale));
  const vw = num(view.w, num(view.width, num(cam && cam.viewW, 1280)));
  const vh = num(view.h, num(view.height, num(cam && cam.viewH, 720)));
  return {
    // 未显式给屏幕中心时：默认视口中心（若 cam 是 Camera 实例，还会计入震动）
    cx: num(view.cx, Math.max(0, num(cam && cam.viewW, 0)) > 0 ? num(cam.viewW, vw) / 2 : 0),
    cy: num(view.cy, Math.max(0, num(cam && cam.viewH, 0)) > 0 ? num(cam.viewH, vh) / 2 : 0),
    scale,
    squash: num(view.squash, num(cam && cam.squash, VIEW_DEFAULTS.squash)),
    heightK: num(view.heightK, num(cam && cam.heightK, VIEW_DEFAULTS.heightK)),
    shakeX: num(cam && cam.shakeX, 0),
    shakeY: num(cam && cam.shakeY, 0),
    camX: num(cam && cam.x, 0),
    camY: num(cam && cam.y, 0),
    w: num(view.w, num(view.width, 1280)),
    h: num(view.h, num(view.height, 720)),
  };
}

function num(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/**
 * 世界 → 屏幕。纯函数。cam 与 view 可为 null（会走默认值），也可只传一部分。
 * @returns {{x:number,y:number}}
 */
export function project(x, z, h = 0, cam = null, view = null, out = { x: 0, y: 0 }) {
  const v = view && view.scale ? view : makeView(cam, view || {});
  const cx = num(v.cx, 0) + num(v.shakeX, num(cam && cam.shakeX, 0));
  const cy = num(v.cy, 0) + num(v.shakeY, num(cam && cam.shakeY, 0));
  const scale = num(v.scale, VIEW_DEFAULTS.scale);
  const squash = num(v.squash, VIEW_DEFAULTS.squash);
  const heightK = num(v.heightK, VIEW_DEFAULTS.heightK);
  const camX = num(v.camX, num(cam && cam.x, 0));
  const camZ = num(v.camY, num(cam && cam.y, 0));
  const wx = num(x, 0), wz = num(z, 0), wh = num(h, 0);
  out.x = cx + (wx - camX) * scale;
  out.y = cy + (wz - camZ) * scale * squash - wh * scale * heightK;
  return out;
}

/**
 * 屏幕 → 世界（地面平面 h=0）。project 之逆。
 * @returns {{x:number,z:number}}
 */
export function unproject(sx, sy, cam = null, view = null, out = { x: 0, z: 0 }) {
  const v = view && view.scale ? view : makeView(cam, view || {});
  const cx = num(v.cx, 0) + num(v.shakeX, num(cam && cam.shakeX, 0));
  const cy = num(v.cy, 0) + num(v.shakeY, num(cam && cam.shakeY, 0));
  const scale = num(v.scale, VIEW_DEFAULTS.scale);
  const squash = num(v.squash, VIEW_DEFAULTS.squash);
  const camX = num(v.camX, num(cam && cam.x, 0));
  const camZ = num(v.camY, num(cam && cam.y, 0));
  out.x = camX + (num(sx, 0) - cx) / scale;
  out.z = camZ + (num(sy, 0) - cy) / (scale * squash);
  return out;
}

/** 以世界距离 r 计算屏幕上的水平半径 */
export function screenRadius(r, view) {
  return r * num(view && view.scale, VIEW_DEFAULTS.scale);
}

/** 以世界距离 r 计算屏幕上的垂直（地面椭圆）半径 */
export function screenRadiusV(r, view) {
  return r * num(view && view.scale, VIEW_DEFAULTS.scale) * num(view && view.squash, VIEW_DEFAULTS.squash);
}

/** 视口可见世界矩形（带 pad 边距），用于视锥剔除 */
export function visibleWorldBounds(cam, view, pad = 1.5, out = { x0: 0, z0: 0, x1: 0, z1: 0 }) {
  const v = view && view.scale ? view : makeView(cam, view || {});
  const scale = num(v.scale, VIEW_DEFAULTS.scale);
  const squash = num(v.squash, VIEW_DEFAULTS.squash) * scale;
  const camX = num(v.camX, num(cam && cam.x, 0));
  const camZ = num(v.camY, num(cam && cam.y, 0));
  const cx = num(v.cx, 0), cy = num(v.cy, 0);
  const hw = num(v.w, 1280) / 2, hh = num(v.h, 720) / 2;
  out.x0 = camX - (hw / scale) - pad;
  out.x1 = camX + (hw / scale) + pad;
  out.z0 = camZ - (hh / squash) - pad;
  out.z1 = camZ + (hh / squash) + pad;
  void cx; void cy;
  return out;
}

/** 确定性 hash：0..1（同一格子每帧稳定） */
export function hash2(x, z) {
  let h = Math.imul((x | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((z | 0) + 0x165667b1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** 与帧率无关的平滑插值 */
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * Math.max(0, dt)));
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInCubic = (t) => Math.pow(clamp(t, 0, 1), 3);