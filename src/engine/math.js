// 数学工具
export const TAU = Math.PI * 2;

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}
export function dist2(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}
export function dist(ax, az, bx, bz) {
  return Math.sqrt(dist2(ax, az, bx, bz));
}
export function angleTo(ax, az, bx, bz) {
  return Math.atan2(bz - az, bx - ax);
}
export function normAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
export function angleLerp(a, b, t) {
  return a + normAngle(b - a) * t;
}
export function inCone(ax, az, facing, bx, bz, range, halfAngle) {
  const d = dist2(ax, az, bx, bz);
  if (d > range * range) return false;
  const a = angleTo(ax, az, bx, bz);
  return Math.abs(normAngle(a - facing)) <= halfAngle;
}
export function inArc(ax, az, bx, bz, r) {
  return dist2(ax, az, bx, bz) <= r * r;
}
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}