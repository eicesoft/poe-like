// ─────────────────────────────────────────────────────────────────────────────
// sprites.js — 程序化精灵绘制（全部 Canvas2D，无图片资源）
// 约定：所有 draw* 函数都在"脚底屏幕坐标 (x, y)"处绘制，单位尺度 u = 世界单位
//       换算到像素（= camera.scale）。y 轴屏幕向下。
// 怪物/玩家在 local 空间定义：脚在 (0,0)，向上为负 y。
// ─────────────────────────────────────────────────────────────────────────────
import { hash2 } from './project.js';

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** hsl 字符串（h 可越界，自动取模） */
export function hsl(h, s, l, a = 1) {
  h = ((h % 360) + 360) % 360;
  return a >= 1 ? `hsl(${h.toFixed(1)} ${s.toFixed(0)}% ${l.toFixed(0)}%)` : `hsl(${h.toFixed(1)} ${s.toFixed(0)}% ${l.toFixed(0)}% / ${a.toFixed(3)})`;
}

/** 颜色解析：支持 '#rgb' '#rrggbb' 'hsl(...)' 'rgb(...)' 以及数字（当色相） */
export function parseColor(c, fallback = { h: 30, s: 70, l: 55 }) {
  if (typeof c === 'number') return { h: c, s: 80, l: 55 };
  if (!c || typeof c !== 'string') return fallback;
  const s = c.trim();
  if (s[0] === '#') {
    let hx = s.slice(1);
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    const r = parseInt(hx.slice(0, 2), 16) / 255, g = parseInt(hx.slice(2, 4), 16) / 255, b = parseInt(hx.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let h = 0, sat = 0;
    if (max !== min) {
      const d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h, s: sat * 100, l: l * 100 };
  }
  let m = s.match(/hsl\(\s*([-\d.]+)/);
  if (m) {
    const nums = s.match(/[-\d.]+/g).map(Number);
    return { h: ((nums[0] % 360) + 360) % 360, s: nums[1] ?? 70, l: nums[2] ?? 55 };
  }
  m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const n = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    const r = n[0] / 255, g = n[1] / 255, b = n[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let h = 0, sat = 0;
    if (max !== min) {
      const d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return { h, s: sat * 100, l: l * 100 };
  }
  const named = {
    red: { h: 352, s: 90, l: 50 }, green: { h: 130, s: 70, l: 45 }, blue: { h: 212, s: 90, l: 56 },
    gold: { h: 42, s: 100, l: 52 }, white: { h: 0, s: 0, l: 96 }, black: { h: 0, s: 0, l: 6 },
    purple: { h: 275, s: 85, l: 60 }, cyan: { h: 190, s: 95, l: 58 }, orange: { h: 24, s: 100, l: 55 },
    yellow: { h: 52, s: 100, l: 56 }, gray: { h: 210, s: 10, l: 50 },
  };
  return named[s.toLowerCase()] || fallback;
}

/** 颜色变亮/变暗（l 偏移 + 饱和调整） */
export function shade(c, dl = 0, ds = 0) {
  const p = parseColor(c);
  return hsl(p.h, Math.max(0, Math.min(100, p.s + ds)), Math.max(0, Math.min(100, p.l + dl)));
}

export function ellipse(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, Math.PI * 2);
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** 有机形状（多边形 + 平滑）—— 用中点闭合 */
export function blobPath(ctx, pts, jitter = 0, seed = 1) {
  const n = pts.length / 2;
  ctx.beginPath();
  let px = pts[2 * n - 2], py = pts[2 * n - 1];
  let cx0 = (px + pts[0]) / 2, cy0 = (py + pts[1]) / 2;
  ctx.moveTo(cx0, cy0);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    const nx = pts[((i + 1) % n) * 2], ny = pts[((i + 1) % n) * 2 + 1];
    const jx = jitter ? (hash2(seed + i, 7) - 0.5) * jitter : 0;
    const jy = jitter ? (hash2(seed + i, 13) - 0.5) * jitter : 0;
    ctx.quadraticCurveTo(x + jx, y + jy, (x + nx) / 2, (y + ny) / 2);
  }
  ctx.closePath();
}

/** 发光圆点（加色混合由调用方设置）。color 建议传 hue/sat/light 数字以免字符串替换出错 */
export function glowDot(ctx, x, y, r, h, s = 90, l = 60, alpha = 1) {
  if (!(r > 0)) return;
  const hp = parseColor(h, { h: 40, s: 100, l: 70 });
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hsl(hp.h, hp.s, Math.min(96, hp.l + 18), alpha));
  g.addColorStop(0.35, hsl(hp.h, hp.s, hp.l, alpha * 0.7));
  g.addColorStop(1, hsl(hp.h, hp.s, hp.l, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 柔和径向光晕。additive 由调用方设定。
 * 注意：r 的单位是**像素**（调用方应先乘以精灵尺度 S / 世界单位 u）。
 * @param {number} alpha 峰值不透明度
 */
export function radialGlow(ctx, x, y, r, h, s, l, alpha = 0.6) {
  if (!(r > 0.5) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hsl(h, s, Math.min(96, l + 18), Math.max(0, Math.min(1, alpha))));
  g.addColorStop(0.45, hsl(h, s, l, Math.max(0, Math.min(1, alpha * 0.55))));
  g.addColorStop(1, hsl(h, s, l, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** 径向光晕渐变（不做裁剪，调用方已有正确弧线路径时用它填充） */
export function radialGlowGradient(ctx, x, y, r, h, s, l, alpha = 0.6) {
  const rr = Math.max(0.5, r);
  const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
  g.addColorStop(0, hsl(h, s, Math.min(96, l + 18), Math.max(0, Math.min(1, alpha))));
  g.addColorStop(0.5, hsl(h, s, l, Math.max(0, Math.min(1, alpha * 0.5))));
  g.addColorStop(1, hsl(h, s, l, 0));
  return g;
}

// ── 通用：脚底阴影 ───────────────────────────────────────────────────────────
export function drawShadow(ctx, x, y, r, alpha = 0.5, squash = 0.45) {
  if (!(r > 0.5)) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, r));
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(0.55, `rgba(0,0,0,${alpha * 0.7})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(1, r), Math.max(0.6, r * squash), 0, 0, Math.PI * 2);
  ctx.fill();
}

/** 稀有度光环（脚底） */
export const RARITY_COLOR = {
  normal: null,
  magic: { h: 262, s: 95, l: 62 },
  rare: { h: 44, s: 100, l: 58 },
  unique: { h: 28, s: 100, l: 56 },
  boss: { h: 0, s: 92, l: 50 },
};

export function drawRarityRing(ctx, x, y, rx, ry, rarity, t, scale) {
  const col = RARITY_COLOR[rarity] || null;
  if (!col) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pulse = 0.65 + 0.35 * Math.sin(t * 3.2);
  const lw = rarity === 'boss' ? 2.6 : rarity === 'rare' ? 2 : 1.5;
  ctx.globalAlpha = 0.5 * pulse;
  ctx.strokeStyle = hsl(col.h, col.s, col.l, 0.9);
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  // 断续外环（旋转）
  const segs = rarity === 'boss' ? 10 : 6;
  const rot = t * (rarity === 'boss' ? 0.8 : 1.4);
  ctx.lineWidth = lw * 0.8;
  ctx.strokeStyle = hsl(col.h, col.s, col.l + 12, 0.7);
  for (let i = 0; i < segs; i++) {
    const a0 = rot + (i / segs) * Math.PI * 2;
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 1.22, ry * 1.22, 0, a0, a0 + 0.35);
    ctx.stroke();
  }
  ctx.restore();
  void scale;
}

// ── 玩家：红金盔甲战士 ────────────────────────────────────────────────────────

const PLAYER_DEFAULT_LOOK = { armorColor: '#b23a26', weaponType: 'axe', cape: true, trimColor: '#e8c05a' };

/**
 * @param ctx  @param x 脚底屏幕 x  @param y 脚底屏幕 y
 * @param {object} p   player 对象
 * @param {number} u   世界单位→像素
 * @param {number} t   时间（秒）
 * @param {object} o   {ghost:bool, attackAnim, moving, walkPhase, hitFlash, invuln}
 */
export function drawPlayer(ctx, x, y, p, u, t, o = {}) {
  // [Lead 修复] 入口参数消毒：任何 NaN 都会让整帧渲染抛异常 → 画面全黑（"人物和怪物都看不见"）
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  u = Number.isFinite(u) && u > 0.5 ? u : 30;
  t = Number.isFinite(t) ? t : 0;
  const look = { ...PLAYER_DEFAULT_LOOK, ...((p && p.look) || {}) };
  const armor = parseColor(look.armorColor || PLAYER_DEFAULT_LOOK.armorColor);
  const trim = parseColor(look.trimColor || PLAYER_DEFAULT_LOOK.trimColor);
  const ghost = !!o.ghost;
  const facing = Number.isFinite(p.facing) ? p.facing : 0; // 世界角度：0 = +x，π/2 = +z（下）
  const moving = o.moving ?? (Math.hypot(p.vx || 0, p.vz || 0) > 0.2);
  const walk = Number.isFinite(o.walkPhase) ? o.walkPhase : t * (moving ? 9 : 2);
  const attack = Number.isFinite(o.attackAnim) ? o.attackAnim : (Number.isFinite(p.attackAnim) ? p.attackAnim : 0);
  const bob = moving ? Math.abs(Math.sin(walk)) * 0.09 * u : Math.sin(t * 2.2) * 0.025 * u;
  const S = u; // 1 世界单位 ≈ u 像素
  const height = 1.05 * S; // 战士身高（像素）
  const hitFlash = Number.isFinite(p.hitFlash) ? p.hitFlash : 0;
  const cast = p.anim && p.anim.state === 'cast';
  const whirl = o.whirlwind;

  ctx.save();
  ctx.translate(x, y);
  const flip = Math.sin(facing) > 0.12 ? 1 : -1; // 朝下走时显示正面细节阴影
  const lean = Math.cos(facing) * 0.05 * S;

  // 披风（在身体之后）
  if (look.cape) {
    ctx.save();
    const sway = Math.sin(t * 7) * 0.04 * S + (moving ? 0.05 * S * Math.sign(Math.cos(facing) || 1) : 0);
    ctx.fillStyle = hsl(armor.h, Math.max(20, armor.s - 20), Math.max(10, armor.l - 26), 0.95);
    ctx.beginPath();
    ctx.moveTo(-0.16 * S, -height * 0.92);
    ctx.quadraticCurveTo(-0.34 * S + sway, -height * 0.45, -0.26 * S + sway * 2, -0.02 * S);
    ctx.quadraticCurveTo(0, 0.06 * S, 0.26 * S + sway * 2, -0.02 * S);
    ctx.quadraticCurveTo(0.3 * S - sway, -height * 0.5, 0.16 * S, -height * 0.92);
    ctx.closePath();
    ctx.fill();
    // 披风高光
    ctx.strokeStyle = hsl(trim.h, trim.s * 0.6, trim.l, 0.25);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  ctx.translate(lean, 0);

  // 腿（两个椭圆摆动）
  const legSwing = moving ? Math.sin(walk) * 0.12 * S : 0;
  const legLift = moving ? Math.max(0, Math.sin(walk)) * 0.05 * S : 0;
  ctx.fillStyle = hsl(armor.h, armor.s * 0.55, Math.max(8, armor.l - 30));
  ellipse(ctx, -0.11 * S, -0.2 * S - legLift, 0.075 * S, 0.19 * S, legSwing * 0.5);
  ctx.fill();
  ellipse(ctx, 0.11 * S, -0.2 * S - (moving ? Math.max(0, -Math.sin(walk)) * 0.05 * S : 0), 0.075 * S, 0.19 * S, -legSwing * 0.5);
  ctx.fill();
  // 靴子
  ctx.fillStyle = hsl(trim.h, 20, 16);
  ellipse(ctx, -0.11 * S + legSwing * 0.4, -0.03 * S, 0.085 * S, 0.045 * S);
  ctx.fill();
  ellipse(ctx, 0.11 * S - legSwing * 0.4, -0.03 * S, 0.085 * S, 0.045 * S);
  ctx.fill();

  // 武器（挥砍时先画在身后的一部分——简化为整体后画）
  const weapon = drawPlayerWeapon;
  if (!whirl) {
    // 非攻击时武器在右侧握持
    weapon(ctx, S, height, attack, facing, armor, trim, look.weaponType, t, bob, cast, false);
  }

  // 躯干（盔甲）
  const bodyBot = -0.42 * S + bob * 0.3;
  const bodyTop = -height * 0.86 + bob;
  const bodyGrad = ctx.createLinearGradient(-0.2 * S, bodyTop, 0.2 * S, bodyBot);
  bodyGrad.addColorStop(0, hsl(armor.h, armor.s, Math.min(78, armor.l + 22)));
  bodyGrad.addColorStop(0.45, hsl(armor.h, armor.s, armor.l));
  bodyGrad.addColorStop(1, hsl(armor.h, armor.s * 0.8, Math.max(10, armor.l - 24)));
  ctx.fillStyle = bodyGrad;
  blobPath(ctx, [
    -0.2 * S, bodyTop + 0.06 * S,
    0, bodyTop,
    0.2 * S, bodyTop + 0.06 * S,
    0.24 * S, bodyTop + 0.28 * S,
    0.17 * S, bodyBot,
    -0.17 * S, bodyBot,
    -0.24 * S, bodyTop + 0.28 * S,
  ]);
  ctx.fill();
  // 胸甲金线
  ctx.strokeStyle = hsl(trim.h, trim.s, trim.l, 0.85);
  ctx.lineWidth = Math.max(1, 0.022 * S);
  ctx.beginPath();
  ctx.moveTo(0, bodyTop + 0.05 * S);
  ctx.lineTo(0, bodyBot - 0.06 * S);
  ctx.moveTo(-0.17 * S, bodyTop + 0.24 * S);
  ctx.quadraticCurveTo(0, bodyTop + 0.32 * S, 0.17 * S, bodyTop + 0.24 * S);
  ctx.stroke();
  // 肩甲
  ctx.fillStyle = hsl(trim.h, Math.min(80, trim.s), trim.l);
  ellipse(ctx, -0.23 * S, bodyTop + 0.1 * S, 0.1 * S, 0.075 * S, -0.3);
  ctx.fill();
  ellipse(ctx, 0.23 * S, bodyTop + 0.1 * S, 0.1 * S, 0.075 * S, 0.3);
  ctx.fill();
  // 腰带
  ctx.fillStyle = hsl(trim.h, 40, 18);
  ctx.fillRect(-0.17 * S, bodyBot - 0.07 * S, 0.34 * S, 0.05 * S);

  // 头（头盔）+ 发光眼缝
  const headY = bodyTop - 0.085 * S;
  ctx.fillStyle = hsl(armor.h, armor.s * 0.7, Math.max(12, armor.l - 18));
  ellipse(ctx, 0, headY, 0.115 * S, 0.125 * S);
  ctx.fill();
  ctx.fillStyle = hsl(trim.h, trim.s, trim.l);
  ctx.beginPath();
  ctx.moveTo(-0.1 * S, headY - 0.06 * S);
  ctx.quadraticCurveTo(0, headY - 0.17 * S, 0.1 * S, headY - 0.06 * S);
  ctx.closePath();
  ctx.fill();
  // 眼缝（发光）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = hsl(38, 100, 78, 0.95);
  ctx.fillRect(-0.07 * S, headY - 0.005 * S, 0.14 * S, 0.022 * S);
  radialGlow(ctx, 0, headY + 0.005 * S, 0.16 * S, 38, 100, 70, 0.35 + 0.15 * Math.sin(t * 3));
  ctx.restore();

  // 受击闪白
  if (hitFlash > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.85, hitFlash);
    ctx.fillStyle = '#fff';
    blobPath(ctx, [
      -0.2 * S, bodyTop + 0.06 * S, 0, bodyTop, 0.2 * S, bodyTop + 0.06 * S,
      0.24 * S, bodyTop + 0.28 * S, 0.17 * S, bodyBot, -0.17 * S, bodyBot, -0.24 * S, bodyTop + 0.28 * S,
    ]);
    ctx.fill();
    ellipse(ctx, 0, headY, 0.13 * S, 0.14 * S);
    ctx.fill();
    ctx.restore();
  }

  // 挥砍弧光 / 旋风
  if (whirl) {
    // [Lead 修复] 精灵层不再画旋风刀光：它是一圈以角色为中心的描边弧，
    // 经 bloom 后必然连成一圈白环。旋风视觉改由 renderer 的 draw-whirl.js 负责。
  } else if (attack > 0) {
    drawSlashArc(ctx, 0, -height * 0.62, 0.95 * S, attack, facing, trim, look.weaponType);
  }

  // 施法手势（cast 时手臂抬起 + 手部光球）
  if (cast) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pulse = 0.5 + 0.5 * Math.sin(t * 14);
    radialGlow(ctx, 0.22 * S, -height * 0.95, 0.22 * S * (0.8 + pulse * 0.4), 44, 100, 70, 0.55);
    ctx.restore();
  }

  // 朝向指示（脚下的金色小光斑，椭圆贴合地面）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const fx = Math.cos(facing) * 0.34 * S, fy = Math.sin(facing) * 0.34 * S * 0.72;
  const fgr = 0.13 * S;
  // [Lead 修复] 原 alpha 0.32 + 亮色在 lighter 叠加下会形成一圈刺眼白环，盖在角色脚下像"光环"，
  // 与旋风斩的刀光叠在一起时更糊。降到 0.14 并缩小半径，只作微弱朝向提示。
  ctx.fillStyle = radialGlowGradient(ctx, fx, fy * 0.5 + 2, fgr, trim.h, 100, 58, 0.14);
  ctx.beginPath();
  ctx.ellipse(fx, fy * 0.5 + 2, fgr, fgr * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (ghost) ctx.globalAlpha = 1;
  void flip;
  ctx.restore();
}

function drawPlayerWeapon(ctx, S, height, attack, facing, armor, trim, type, t, bob, cast, back) {
  ctx.save();
  const handY = -height * 0.6 + bob;
  // 武器角度：attack 决定挥舞角度
  let ang = -0.5; // 静止：斜向下举
  if (attack > 0) ang = -2.3 + attack * 3.6; // 从上往下扫
  if (cast) ang = -1.7;
  ctx.translate(0.18 * S, handY);
  const swing = attack > 0 ? Math.sin(attack * Math.PI) : 0;
  // 光刃拖影
  if (swing > 0.05) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = swing * 0.5;
    ctx.strokeStyle = hsl(trim.h, 90, 72, 0.8);
    ctx.lineWidth = 4 * swing;
    ctx.beginPath();
    ctx.arc(0, 0, 0.7 * S, ang - 0.9, ang - 0.05);
    ctx.stroke();
    ctx.restore();
  }
  ctx.rotate(ang);
  const len = type === 'hammer' ? 0.62 : type === 'sword' ? 0.72 : 0.66;
  ctx.scale(1, 1);
  // 木杆
  const shaftGrad = ctx.createLinearGradient(0, -2, 0, 2);
  shaftGrad.addColorStop(0, '#6b4a2a');
  shaftGrad.addColorStop(1, '#2b1c10');
  ctx.strokeStyle = shaftGrad;
  ctx.lineWidth = Math.max(1.5, 0.035 * S);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(len * S, 0);
  ctx.stroke();
  // 刃/锤头/剑身
  if (type === 'sword') {
    const g = ctx.createLinearGradient(len * S, -0.05 * S, len * S, 0.05 * S);
    g.addColorStop(0, '#f4f7ff');
    g.addColorStop(0.5, '#c9d3e0');
    g.addColorStop(1, '#8f9aab');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(len * S * 0.55, -0.045 * S);
    ctx.lineTo(len * S * 1.05, 0);
    ctx.lineTo(len * S * 0.55, 0.045 * S);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = hsl(trim.h, trim.s, trim.l);
    ctx.fillRect(len * S * 0.52, -0.09 * S, 0.035 * S, 0.18 * S);
  } else if (type === 'staff') {
    // 法师长杖：深色杖身 + 顶端发光法球
    ctx.strokeStyle = '#3a2b1c';
    ctx.lineWidth = Math.max(1.6, 0.024 * S);
    ctx.beginPath();
    ctx.moveTo(len * S * 0.08, 0);
    ctx.lineTo(len * S * 0.98, 0);
    ctx.stroke();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    radialGlow(ctx, len * S * 0.98, 0, 0.16 * S, trim.h, 95, 72, 0.75 + 0.12 * Math.sin(t * 5));
    ctx.fillStyle = hsl(trim.h, 95, 78, 0.95);
    ellipse(ctx, len * S * 0.98, 0, 0.055 * S, 0.055 * S);
    ctx.fill();
    ctx.restore();
  } else if (type === 'hammer') {
    ctx.fillStyle = '#59606b';
    roundRect(ctx, len * S * 0.72, -0.12 * S, 0.2 * S, 0.24 * S, 0.03 * S);
    ctx.fill();
    ctx.fillStyle = hsl(trim.h, 70, 55);
    ctx.fillRect(len * S * 0.74, -0.03 * S, 0.16 * S, 0.04 * S);
  } else {
    // axe 双刃
    const g = ctx.createLinearGradient(len * S * 0.6, 0, len * S * 1.05, 0);
    g.addColorStop(0, '#9aa4b1');
    g.addColorStop(0.6, '#e6ecf5');
    g.addColorStop(1, '#7b8492');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(len * S * 0.6, -0.02 * S);
    ctx.quadraticCurveTo(len * S * 0.82, -0.2 * S, len * S * 1.02, -0.02 * S);
    ctx.quadraticCurveTo(len * S * 0.82, 0.17 * S, len * S * 0.6, 0.02 * S);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = hsl(trim.h, trim.s, trim.l, 0.9);
    ctx.fillRect(len * S * 0.56, -0.06 * S, 0.05 * S, 0.12 * S);
  }
  // 刃口发光
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.35 + (attack > 0 ? 0.4 : 0);
  ctx.strokeStyle = hsl(trim.h, 100, 75, 0.8);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(len * S * 0.7, -0.06 * S);
  ctx.lineTo(len * S * 1.0, 0);
  ctx.stroke();
  ctx.restore();
  // 手（握柄）
  ctx.fillStyle = hsl(armor.h, armor.s, armor.l);
  ellipse(ctx, 0.05 * S, 0, 0.05 * S, 0.045 * S);
  ctx.fill();
  ctx.restore();
  void facing; void t; void back;
}

/** 挥砍弧——加色混合的扇形扫过 */
export function drawSlashArc(ctx, cx, cy, R, attackAnim, facing, trimColor, weaponType) {
  // attackAnim 0..1：弧从起始角扫到结束角
  const sweep = 2.5; // 弧度
  const start = -Math.PI * 0.85;
  const head = start + sweep * Math.min(1, attackAnim * 1.25);
  const tail = Math.max(start, head - sweep * 0.55);
  const fade = Math.sin(Math.min(1, attackAnim) * Math.PI);
  const flip = Math.sin(facing) < 0 ? -1 : 1;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(flip, 1);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.max(0, fade) * 0.9;
  // 实体扇
  const grad = ctx.createRadialGradient(0, 0, R * 0.35, 0, 0, R * 1.05);
  grad.addColorStop(0, hsl(trimColor.h, trimColor.s, trimColor.l, 0));
  grad.addColorStop(0.55, hsl(trimColor.h, 100, 70, 0.22));
  grad.addColorStop(0.92, hsl(trimColor.h, 100, 80, 0.85));
  grad.addColorStop(1, hsl(trimColor.h, 100, 92, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, R * 1.05, tail, head);
  ctx.arc(0, 0, R * 0.3, head, tail, true);
  ctx.closePath();
  ctx.fill();
  // 亮刃线
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.2, R * 0.045);
  ctx.globalAlpha = Math.max(0, fade);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.92, tail + (head - tail) * 0.35, head);
  ctx.stroke();
  ctx.globalAlpha = Math.max(0, fade) * 0.6;
  ctx.strokeStyle = hsl(trimColor.h, 100, 62);
  ctx.lineWidth = Math.max(2, R * 0.12);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.86, tail, head);
  ctx.stroke();
  ctx.restore();
  void weaponType;
}

/** 旋风斩：持续旋转的两道刀刃弧 */
export function drawWhirlBlades(ctx, cx, cy, R, t, armor, trim) {
  // [Lead 修复] 原实现用 radialGradient 填充 2 个大扇形 + 一整圈灰白填充，
  // 在 'lighter' 叠加下糊成一个纯白圆盘，把玩家和周围怪物全吃掉了。
  // 现改为：只画描边拖尾（分段、逐段加粗变亮），不再做任何"面"填充。
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const span = Math.PI * 0.55;
  for (let k = 0; k < 2; k++) {
    const head = t * 7.5 + k * Math.PI;
    const N = 6;
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N;
      const a0 = head - span + span * u0;
      const a1 = head - span + span * u1;
      const fade = Math.pow(u1, 1.4);
      ctx.globalAlpha = 0.62 * fade;
      ctx.strokeStyle = hsl(trim.h, 100, 66 + 26 * u1);
      ctx.lineWidth = Math.max(1, R * (0.05 + 0.07 * u1));
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.9, a0, a1);
      ctx.stroke();
    }
    // 刀锋顶端一小段纯亮线（不加粗，避免糊成白团）
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = hsl(50, 100, 94);
    ctx.lineWidth = Math.max(1, R * 0.055);
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.9, head - 0.35, head);
    ctx.stroke();
  }
  ctx.restore();
  void armor;
}

// ── 怪物 ─────────────────────────────────────────────────────────────────────

const SHAPE_MAP = {
  humanoid: 'humanoid', human: 'humanoid', warrior: 'humanoid', skeleton: 'skeleton',
  quadruped: 'quadruped', wolf: 'quadruped', beast: 'quadruped', hound: 'quadruped',
  spider: 'spider', wraith: 'wraith', ghost: 'wraith', spectre: 'wraith',
  blob: 'blob', slime: 'blob',
};

export function resolveShape(m) {
  const v = m.visual || {};
  const raw = v.shape || m.shape || m.type || 'humanoid';
  return SHAPE_MAP[String(raw).toLowerCase()] || 'humanoid';
}

/**
 * 怪物总入口
 * @param ctx @param x @param y 脚底屏幕坐标 @param m 怪物 @param u 世界单位→像素 @param t 时间
 * @param o {hitFlash, scale, dead, deathT}
 */
export function drawMonster(ctx, x, y, m, u, t, o = {}) {
  const v = m.visual || {};
  const col = v.color || defaultMonsterColor(m.type);
  const rarity = m.rarity || 'normal';
  const boss = rarity === 'boss' || m.isBoss;
  // 体型：visual.size 是"设计尺寸"，实际屏幕尺寸按玩家身高做 POE 手感校准
  //   普通怪 ≈ 玩家 0.95 身高；精英 1.05；Boss 2.0
  const baseSize = Number.isFinite(v.size) ? v.size : 1;
  const bodyScale = baseSize * (boss ? 2.0 : m.elite || rarity === 'rare' ? 1.12 : rarity === 'magic' ? 1.0 : 0.95);
  const scaleOpt = Number.isFinite(o.scale) ? o.scale : 1;
  const size = Number.isFinite(bodyScale * scaleOpt) ? bodyScale * scaleOpt : 1;
  const shape = resolveShape(m);
  // [Lead 修复] 尺寸/时间/坐标必须是有限值：任何一处 NaN 都会让整个精灵绘制抛异常（整帧黑屏）
  const S = Number.isFinite(u * size) && u * size > 0.5 ? u * size : 30;
  const tt = Number.isFinite(t) ? t : 0;
  const px = Number.isFinite(x) ? x : 0;
  const py = Number.isFinite(y) ? y : 0;
  const hitFlash = Number.isFinite(m.hitFlash) ? m.hitFlash : Number.isFinite(o.hitFlash) ? o.hitFlash : 0;
  const facing = Number.isFinite(m.facing) ? m.facing : 0;
  const dirX = Math.cos(facing);
  const moving = !!(m.vx || m.vz);
  const walk = tt * 6 + (m.id || 0) * 1.37;

  ctx.save();
  ctx.translate(px, py);
  ctx.globalAlpha = o.alpha ?? 1;

  // 稀有度光环 + 地面光
  const ringR = S * (boss ? 1.3 : 0.62);
  drawRarityRing(ctx, 0, 0, ringR, ringR * 0.45, rarity, tt, u);

  // 环境轮廓光：先用"胖描边"把身体形状画一圈发光轮廓，再正常绘制身体。
  // 让怪物从深色地板/墙面上脱离出来（POE 怪物可读性关键）
  if (!boss && o.silhouette !== false) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(0,0,0,0)';
    const rimHue = parseColor(col, { h: 30, s: 60, l: 55 });
    ctx.lineWidth = 0;
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (o.alpha ?? 1) * (rarity === 'normal' ? 0.5 : 0.62);
    ctx.fillStyle = hsl(rimHue.h, Math.min(90, rimHue.s), Math.min(72, rimHue.l + 26));
    ctx.strokeStyle = hsl(rimHue.h, Math.min(90, rimHue.s), Math.min(78, rimHue.l + 34));
    const rim = Math.max(1.5, S * 0.075);
    drawMonsterRim(ctx, shape, S, m, rim, tt, walk, moving, dirX);
    ctx.restore();
  }

  switch (shape) {
    case 'quadruped': drawQuadruped(ctx, S, col, tt, walk, moving, hitFlash, dirX); break;
    case 'spider': drawSpider(ctx, S, col, tt, walk, moving, hitFlash, dirX); break;
    case 'wraith': drawWraith(ctx, S, col, tt, walk, hitFlash, px, py); break;
    case 'skeleton': drawSkeleton(ctx, S, col, tt, walk, moving, hitFlash, dirX); break;
    case 'blob': drawBlob(ctx, S, col, tt, walk, moving, hitFlash); break;
    default: drawHumanoid(ctx, S, col, tt, walk, moving, hitFlash, dirX, m); break;
  }

  if (boss) drawBossAura(ctx, S, tt);
  if (rarity === 'rare' || rarity === 'magic') drawRarityOutline(ctx, S, rarity, tt);

  ctx.restore();
}

function defaultMonsterColor(type) {
  const m = {
    skeleton: '#d8d2be', zombie: '#7f9a74', brute: '#a0503a', spider: '#4e3a5e',
    wraith: '#6fa8d8', blob: '#7ab04a', wolf: '#6a6f78', imp: '#c04a3a', golem: '#6a6250',
    cultist: '#8e3a5a', wretch: '#9a7a5a', boss: '#b02020',
  };
  return m[String(type || '').toLowerCase()] || '#8a6a5a';
}

function localGradient(ctx, S, col, top, bot) {
  // [Lead 修复] 防御 NaN/Inf：只有有限值才建渐变，否则退化为纯色（避免整帧抛异常 → 画面全黑）
  const tY = top * S, bY = bot * S;
  if (!Number.isFinite(tY) || !Number.isFinite(bY)) {
    const cc = parseColor(col);
    return hsl(cc.h, cc.s, cc.l);
  }
  const g = ctx.createLinearGradient(0, tY, 0, bY);
  const c = parseColor(col);
  g.addColorStop(0, hsl(c.h, c.s * 0.9, Math.min(80, c.l + 16)));
  g.addColorStop(0.5, hsl(c.h, c.s, c.l));
  g.addColorStop(1, hsl(c.h, c.s * 0.8, Math.max(6, c.l - 26)));
  return g;
}

function flashOverlay(ctx, S, hitFlash, drawSamePath) {
  if (hitFlash <= 0.01) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(0.9, hitFlash);
  ctx.fillStyle = '#ffffff';
  drawSamePath();
  ctx.restore();
}

/** 人形：躯干 / 头 / 双臂 / 武器 */
function drawHumanoid(ctx, S, col, t, walk, moving, hitFlash, dirX, m) {
  const c = parseColor(col);
  const bob = moving ? Math.abs(Math.sin(walk)) * 0.05 * S : Math.sin(t * 2 + (m.id || 0)) * 0.02 * S;
  const top = -1.02 * S + bob, bot = -0.34 * S + bob;
  // 腿
  const lswing = moving ? Math.sin(walk) * 0.1 * S : 0;
  ctx.fillStyle = hsl(c.h, c.s * 0.6, Math.max(8, c.l - 30));
  ellipse(ctx, -0.1 * S, -0.18 * S, 0.065 * S, 0.17 * S, lswing * 0.4);
  ctx.fill();
  ellipse(ctx, 0.1 * S, -0.18 * S, 0.065 * S, 0.17 * S, -lswing * 0.4);
  ctx.fill();
  // 躯干
  const bodyPath = () => {
    blobPath(ctx, [
      -0.17 * S, top + 0.1 * S, 0, top + 0.02 * S, 0.17 * S, top + 0.1 * S,
      0.21 * S, top + 0.3 * S, 0.15 * S, bot, -0.15 * S, bot, -0.21 * S, top + 0.3 * S,
    ]);
  };
  ctx.fillStyle = localGradient(ctx, S, col, top / S, bot / S);
  bodyPath();
  ctx.fill();
  flashOverlay(ctx, S, hitFlash, () => { bodyPath(); ctx.fill(); });
  // 手臂
  const armSwing = moving ? Math.sin(walk + Math.PI) * 0.08 * S : 0;
  ctx.fillStyle = hsl(c.h, c.s * 0.8, Math.max(10, c.l - 10));
  ellipse(ctx, -0.22 * S, top + 0.34 * S + armSwing, 0.06 * S, 0.14 * S, -0.2);
  ctx.fill();
  ellipse(ctx, 0.22 * S, top + 0.34 * S - armSwing, 0.06 * S, 0.14 * S, 0.2);
  ctx.fill();
  // 头
  const headY = top - 0.06 * S;
  ctx.fillStyle = hsl(c.h, c.s * 0.7, Math.max(10, c.l - 6));
  ellipse(ctx, 0, headY, 0.1 * S, 0.11 * S);
  ctx.fill();
  // 角（随机给点邪气）
  if ((m.id || 0) % 3 === 0) {
    ctx.fillStyle = hsl(c.h, 20, 20);
    ctx.beginPath();
    ctx.moveTo(-0.08 * S, headY - 0.05 * S);
    ctx.lineTo(-0.16 * S, headY - 0.2 * S);
    ctx.lineTo(-0.02 * S, headY - 0.08 * S);
    ctx.closePath();
    ctx.fill();
  }
  // 发光的眼睛
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const eyeH = (m.rarity && m.rarity !== 'normal') ? 40 : 12;
  radialGlow(ctx, dirX * 0.03 * S, headY, 0.13 * S, eyeH, 100, 70, 0.55 + 0.2 * Math.sin(t * 6));
  ctx.fillStyle = hsl(eyeH, 100, 85, 0.95);
  ctx.fillRect(dirX * 0.02 * S - 0.05 * S, headY - 0.012 * S, 0.1 * S, 0.024 * S);
  ctx.restore();
  // 武器（粗糙的棍/刀）
  ctx.save();
  ctx.translate(0.24 * S * (dirX >= 0 ? 1 : -1), top + 0.36 * S);
  ctx.rotate(0.7);
  ctx.strokeStyle = '#5a4632';
  ctx.lineWidth = Math.max(1.2, 0.03 * S);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0.42 * S, 0);
  ctx.stroke();
  ctx.fillStyle = '#b9c2cf';
  ctx.beginPath();
  ctx.moveTo(0.4 * S, -0.05 * S);
  ctx.lineTo(0.52 * S, 0);
  ctx.lineTo(0.4 * S, 0.05 * S);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 骷髅：骨骼结构（肋骨架 + 头骨眼眶发光） */
function drawSkeleton(ctx, S, col, t, walk, moving, hitFlash, dirX) {
  const bone = '#d9d2bd', boneDark = '#8f887a';
  const bob = moving ? Math.abs(Math.sin(walk)) * 0.05 * S : Math.sin(t * 2) * 0.02 * S;
  const top = -1.0 * S + bob;
  // 腿骨
  ctx.strokeStyle = bone;
  ctx.lineWidth = Math.max(1.4, 0.035 * S);
  ctx.lineCap = 'round';
  const lg = moving ? Math.sin(walk) * 0.1 * S : 0;
  ctx.beginPath();
  ctx.moveTo(-0.06 * S, -0.4 * S);
  ctx.lineTo(-0.1 * S - lg, -0.02 * S);
  ctx.moveTo(0.06 * S, -0.4 * S);
  ctx.lineTo(0.1 * S + lg, -0.02 * S);
  ctx.stroke();
  // 骨盆
  ctx.fillStyle = boneDark;
  ellipse(ctx, 0, -0.42 * S, 0.12 * S, 0.06 * S);
  ctx.fill();
  // 脊柱
  ctx.strokeStyle = boneDark;
  ctx.beginPath();
  ctx.moveTo(0, -0.44 * S);
  ctx.lineTo(0, top + 0.08 * S);
  ctx.stroke();
  // 肋骨
  ctx.strokeStyle = bone;
  ctx.lineWidth = Math.max(1.1, 0.028 * S);
  for (let i = 0; i < 4; i++) {
    const y = top + 0.16 * S + i * 0.1 * S;
    const w = 0.16 * S * (1 - i * 0.12);
    ctx.beginPath();
    ctx.moveTo(0, y - 0.03 * S);
    ctx.quadraticCurveTo(-w, y, -w * 0.9, y + 0.08 * S);
    ctx.moveTo(0, y - 0.03 * S);
    ctx.quadraticCurveTo(w, y, w * 0.9, y + 0.08 * S);
    ctx.stroke();
  }
  // 手臂（持生锈武器）
  ctx.beginPath();
  ctx.moveTo(-0.14 * S, top + 0.16 * S);
  ctx.lineTo(-0.26 * S, top + 0.44 * S);
  ctx.moveTo(0.14 * S, top + 0.16 * S);
  ctx.lineTo(0.28 * S * (dirX >= 0 ? 1 : -1), top + 0.34 * S);
  ctx.stroke();
  // 武器
  ctx.save();
  ctx.translate(0.28 * S * (dirX >= 0 ? 1 : -1), top + 0.36 * S);
  ctx.rotate(0.9);
  ctx.fillStyle = '#7f8a96';
  ctx.fillRect(0, -0.015 * S, 0.45 * S, 0.03 * S);
  ctx.fillStyle = '#9aa6b3';
  ctx.beginPath();
  ctx.moveTo(0.4 * S, -0.04 * S);
  ctx.lineTo(0.56 * S, 0);
  ctx.lineTo(0.4 * S, 0.04 * S);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // 头骨
  const hy = top - 0.04 * S;
  ctx.fillStyle = bone;
  ellipse(ctx, 0, hy, 0.1 * S, 0.1 * S);
  ctx.fill();
  ctx.fillStyle = boneDark;
  ctx.beginPath();
  ctx.moveTo(-0.05 * S, hy + 0.06 * S);
  ctx.lineTo(0.05 * S, hy + 0.06 * S);
  ctx.lineTo(0.04 * S, hy + 0.13 * S);
  ctx.lineTo(-0.04 * S, hy + 0.13 * S);
  ctx.closePath();
  ctx.fill();
  // 眼眶发光（青蓝鬼火）
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const flick = 0.7 + 0.3 * Math.sin(t * 9 + 1.2);
  radialGlow(ctx, -0.035 * S, hy - 0.005 * S, 0.075 * S, 190, 100, 70, 0.75 * flick);
  radialGlow(ctx, 0.035 * S, hy - 0.005 * S, 0.075 * S, 190, 100, 70, 0.75 * flick);
  ctx.fillStyle = '#dff7ff';
  ellipse(ctx, -0.035 * S, hy - 0.005 * S, 0.022 * S, 0.028 * S);
  ctx.fill();
  ellipse(ctx, 0.035 * S, hy - 0.005 * S, 0.022 * S, 0.028 * S);
  ctx.fill();
  ctx.restore();
  if (hitFlash > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.8, hitFlash);
    ctx.fillStyle = '#fff';
    ellipse(ctx, 0, hy, 0.11 * S, 0.11 * S);
    ctx.fill();
    ellipse(ctx, 0, top + 0.3 * S, 0.17 * S, 0.2 * S);
    ctx.fill();
    ctx.restore();
  }
  void col;
}

/** 四足：身体 + 四条腿 + 头，奔跑时腿交替 */
function drawQuadruped(ctx, S, col, t, walk, moving, hitFlash, dirX) {
  const c = parseColor(col);
  const d = dirX >= 0 ? 1 : -1;
  const bodyY = -0.5 * S;
  const legA = moving ? Math.sin(walk) * 0.16 * S : 0;
  const legB = moving ? Math.sin(walk + Math.PI) * 0.16 * S : 0;
  // 腿
  ctx.strokeStyle = hsl(c.h, c.s * 0.6, Math.max(8, c.l - 26));
  ctx.lineWidth = Math.max(1.5, 0.06 * S);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-0.28 * S, bodyY + 0.08 * S); ctx.lineTo(-0.3 * S + legA, -0.01 * S);
  ctx.moveTo(0.26 * S, bodyY + 0.08 * S); ctx.lineTo(0.24 * S + legB, -0.01 * S);
  ctx.moveTo(-0.2 * S, bodyY + 0.1 * S); ctx.lineTo(-0.22 * S + legB * 0.7, -0.01 * S);
  ctx.moveTo(0.34 * S, bodyY + 0.1 * S); ctx.lineTo(0.36 * S + legA * 0.7, -0.01 * S);
  ctx.stroke();
  // 躯干
  const bodyPath = () => {
    ellipse(ctx, 0, bodyY, 0.38 * S, 0.19 * S, -0.06);
  };
  ctx.fillStyle = localGradient(ctx, S, col, bodyY / S - 0.2, bodyY / S + 0.2);
  bodyPath();
  ctx.fill();
  flashOverlay(ctx, S, hitFlash, () => { bodyPath(); ctx.fill(); });
  // 鬃毛
  ctx.fillStyle = hsl(c.h, c.s, Math.max(8, c.l - 18));
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const bx = -0.2 * S + i * 0.1 * S;
    ctx.moveTo(bx, bodyY - 0.14 * S);
    ctx.lineTo(bx + 0.03 * S, bodyY - 0.28 * S - (i % 2) * 0.04 * S);
    ctx.lineTo(bx + 0.08 * S, bodyY - 0.13 * S);
  }
  ctx.fill();
  // 头
  const hx = d * 0.44 * S;
  ctx.fillStyle = hsl(c.h, c.s * 0.8, c.l + 4);
  ellipse(ctx, hx, bodyY - 0.12 * S, 0.15 * S, 0.13 * S, d * 0.25);
  ctx.fill();
  // 吻部/牙
  ctx.fillStyle = hsl(c.h, c.s * 0.5, Math.max(8, c.l - 22));
  ctx.beginPath();
  ctx.moveTo(hx + d * 0.06 * S, bodyY - 0.1 * S);
  ctx.lineTo(hx + d * 0.24 * S, bodyY - 0.06 * S);
  ctx.lineTo(hx + d * 0.06 * S, bodyY - 0.02 * S);
  ctx.closePath();
  ctx.fill();
  // 尾巴
  ctx.strokeStyle = hsl(c.h, c.s * 0.7, Math.max(10, c.l - 10));
  ctx.lineWidth = Math.max(1.4, 0.04 * S);
  ctx.beginPath();
  ctx.moveTo(-d * 0.36 * S, bodyY - 0.04 * S);
  ctx.quadraticCurveTo(-d * 0.56 * S, bodyY - 0.14 * S + Math.sin(t * 8) * 0.06 * S, -d * 0.6 * S, bodyY - 0.34 * S);
  ctx.stroke();
  // 眼睛发光
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  radialGlow(ctx, hx + d * 0.05 * S, bodyY - 0.16 * S, 0.1 * S, 0, 100, 65, 0.6);
  ctx.restore();
}

/** 蜘蛛：圆腹 + 多条反向关节腿 + 复眼 */
function drawSpider(ctx, S, col, t, walk, moving, hitFlash, dirX) {
  const c = parseColor(col);
  const d = dirX >= 0 ? 1 : -1;
  const bodyY = -0.34 * S;
  // 腿（8 条，按 sin 摆动）
  ctx.strokeStyle = hsl(c.h, c.s * 0.7, Math.max(10, c.l - 16));
  ctx.lineWidth = Math.max(1.3, 0.028 * S);
  ctx.lineCap = 'round';
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 4; i++) {
      const phase = (moving ? Math.sin(walk + i * 1.1 + (side > 0 ? Math.PI : 0)) : Math.sin(t * 2 + i)) * 0.1 * S;
      const baseA = -0.6 + i * 0.42;
      const kx = side * 0.16 * S;
      const ky = bodyY + 0.02 * S;
      const jx = kx + side * Math.cos(baseA) * 0.3 * S;
      const jy = ky - Math.sin(baseA) * 0.34 * S + phase;
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.lineTo(jx, jy);
      ctx.lineTo(jx + side * 0.18 * S, -0.01 * S + phase * 0.5);
      ctx.stroke();
    }
  }
  // 腹部
  const abPath = () => { ellipse(ctx, -d * 0.08 * S, bodyY, 0.24 * S, 0.19 * S); };
  ctx.fillStyle = localGradient(ctx, S, col, bodyY / S - 0.2, bodyY / S + 0.2);
  abPath();
  ctx.fill();
  flashOverlay(ctx, S, hitFlash, () => { abPath(); ctx.fill(); });
  // 花纹
  ctx.fillStyle = hsl(c.h + 20, 80, 62, 0.7);
  for (let i = 0; i < 3; i++) {
    ellipse(ctx, -d * (0.04 + i * 0.07) * S, bodyY - 0.02 * S, 0.035 * S, 0.028 * S);
    ctx.fill();
  }
  // 头胸
  ctx.fillStyle = hsl(c.h, c.s * 0.85, c.l - 6);
  ellipse(ctx, d * 0.2 * S, bodyY + 0.03 * S, 0.14 * S, 0.12 * S);
  ctx.fill();
  // 复眼
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    radialGlow(ctx, d * (0.24 + (i - 1) * 0.05) * S, bodyY - 0.02 * S + (i % 2) * 0.04 * S, 0.06 * S, 20, 100, 62, 0.8);
  }
  ctx.restore();
}

/** 幽魂：半透明飘浮 + 拖尾 + 兜帽 */
function drawWraith(ctx, S, col, t, walk, hitFlash) {
  const c = parseColor(col);
  const float = Math.sin(t * 1.8) * 0.08 * S;
  // 注意：下面用 const float 命名会覆盖 float 样式定位；此处沿用现有命名但避免依赖它
  const top = -1.12 * S + float;
  const base = -0.12 * S + float * 0.5;
  // 尾部幽灵触须（多层）
  for (let k = 0; k < 3; k++) {
    ctx.save();
    ctx.globalAlpha = 0.22 - k * 0.05;
    ctx.fillStyle = hsl(c.h, c.s, c.l + 6);
    ctx.beginPath();
    const w = (0.2 - k * 0.04) * S;
    const by = base + k * 0.06 * S + Math.sin(t * 3 + k) * 0.03 * S;
    ctx.moveTo(-w, top + 0.4 * S);
    ctx.quadraticCurveTo(-w * 1.3, by, 0, by + 0.1 * S);
    ctx.quadraticCurveTo(w * 1.3, by, w, top + 0.4 * S);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // 身体（长袍）
  const bodyPath = () => {
    ctx.beginPath();
    ctx.moveTo(-0.22 * S, top + 0.3 * S);
    ctx.quadraticCurveTo(-0.3 * S, base, 0, base + 0.05 * S);
    ctx.quadraticCurveTo(0.3 * S, base, 0.22 * S, top + 0.3 * S);
    ctx.quadraticCurveTo(0.16 * S, top, 0, top - 0.02 * S);
    ctx.quadraticCurveTo(-0.16 * S, top, -0.22 * S, top + 0.3 * S);
    ctx.closePath();
  };
  ctx.save();
  ctx.globalAlpha = 0.72;
  const g = ctx.createLinearGradient(0, top, 0, base);
  g.addColorStop(0, hsl(c.h, c.s, Math.min(80, c.l + 18), 0.95));
  g.addColorStop(0.6, hsl(c.h, c.s, c.l, 0.8));
  g.addColorStop(1, hsl(c.h, c.s, c.l, 0.05));
  ctx.fillStyle = g;
  bodyPath();
  ctx.fill();
  ctx.restore();
  flashOverlay(ctx, S, hitFlash, () => { bodyPath(); ctx.fill(); });
  // 兜帽内黑暗 + 眼睛
  ctx.fillStyle = 'rgba(6,4,14,0.9)';
  ellipse(ctx, 0, top + 0.16 * S, 0.11 * S, 0.13 * S);
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const flick = 0.7 + 0.3 * Math.sin(t * 7);
  radialGlow(ctx, -0.045 * S, top + 0.15 * S, 0.09 * S, c.h, 100, 78, 0.9 * flick);
  radialGlow(ctx, 0.045 * S, top + 0.15 * S, 0.09 * S, c.h, 100, 78, 0.9 * flick);
  // 幽光轮廓
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = hsl(c.h, 100, 75);
  ctx.lineWidth = 1.2;
  bodyPath();
  ctx.stroke();
  ctx.restore();
  // 飘浮拖尾（向下散落的光点由粒子系统负责）
  void walk;
}

/** 自爆尸：膨胀软体 + 内核发光（血量越低越红越胀） */
function drawBlob(ctx, S, col, t, walk, moving, hitFlash) {
  const c = parseColor(col);
  const wob = 1 + Math.sin(t * 5) * 0.06;
  const sq = 1 / wob;
  const r = 0.3 * S;
  const cy = -0.28 * S;
  ctx.save();
  ctx.translate(0, cy);
  ctx.scale(wob, sq);
  const bodyPath = () => {
    blobPath(ctx, [
      -r, 0, -r * 0.75, -r * 0.95, 0, -r * 1.15, r * 0.75, -r * 0.95, r, 0,
      r * 0.6, r * 0.95, 0, r * 1.08, -r * 0.6, r * 0.95,
    ]);
  };
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.45, r * 0.1, 0, 0, r * 1.15);
  g.addColorStop(0, hsl(c.h, c.s, Math.min(86, c.l + 26)));
  g.addColorStop(0.5, hsl(c.h, c.s, c.l));
  g.addColorStop(1, hsl(c.h, c.s * 0.9, Math.max(6, c.l - 28)));
  ctx.fillStyle = g;
  bodyPath();
  ctx.fill();
  // 高光
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#fff';
  ellipse(ctx, -r * 0.35, -r * 0.5, r * 0.22, r * 0.14, -0.5);
  ctx.fill();
  ctx.globalAlpha = 1;
  flashOverlay(ctx, S, hitFlash, () => { bodyPath(); ctx.fill(); });
  // 内核（爆炸前兆：脉冲越来越快）
  ctx.globalCompositeOperation = 'lighter';
  const pulse = 0.55 + 0.45 * Math.sin(t * 8);
  radialGlow(ctx, 0, 0, r * (0.45 + pulse * 0.2), 20, 100, 60, 0.6 * pulse);
  ctx.restore();
  void moving; void walk;
}

/**
 * 怪物轮廓光：按形态画一圈加色描边（在身体下面先画，形成外发光边缘）。
 * 只用简单几何，开销极低。
 */
function drawMonsterRim(ctx, shape, S, m, rim, t, walk, moving, dirX) {
  ctx.lineWidth = rim;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const bob = Math.sin(t * 2 + (m.id || 0)) * 0.02 * S;
  ctx.beginPath();
  switch (shape) {
    case 'quadruped':
      ctx.ellipse(0, -0.5 * S, 0.38 * S, 0.19 * S, -0.06, 0, Math.PI * 2);
      ctx.ellipse(dirX * 0.44 * S, -0.62 * S, 0.15 * S, 0.13 * S, 0, 0, Math.PI * 2);
      break;
    case 'spider':
      ctx.ellipse(-dirX * 0.08 * S, -0.34 * S, 0.24 * S, 0.19 * S, 0, 0, Math.PI * 2);
      ctx.ellipse(dirX * 0.2 * S, -0.31 * S, 0.14 * S, 0.12 * S, 0, 0, Math.PI * 2);
      break;
    case 'wraith':
      ctx.moveTo(-0.22 * S, -0.82 * S);
      ctx.quadraticCurveTo(-0.3 * S, -0.12 * S, 0, -0.07 * S);
      ctx.quadraticCurveTo(0.3 * S, -0.12 * S, 0.22 * S, -0.82 * S);
      ctx.quadraticCurveTo(0.16 * S, -1.12 * S, 0, -1.14 * S);
      ctx.quadraticCurveTo(-0.16 * S, -1.12 * S, -0.22 * S, -0.82 * S);
      break;
    case 'skeleton':
      ctx.ellipse(0, -1.04 * S + bob, 0.1 * S, 0.1 * S, 0, 0, Math.PI * 2);
      ctx.moveTo(-0.16 * S, -0.6 * S);
      ctx.lineTo(0.16 * S, -0.66 * S);
      ctx.lineTo(0.14 * S, -0.36 * S);
      ctx.lineTo(-0.14 * S, -0.36 * S);
      ctx.closePath();
      break;
    case 'blob':
      ctx.ellipse(0, -0.28 * S, 0.3 * S, 0.34 * S, 0, 0, Math.PI * 2);
      break;
    default: // humanoid
      ctx.moveTo(-0.17 * S, -0.92 * S + bob);
      ctx.quadraticCurveTo(-0.22 * S, -0.6 * S, -0.15 * S, -0.34 * S + bob);
      ctx.lineTo(0.15 * S, -0.34 * S + bob);
      ctx.quadraticCurveTo(0.22 * S, -0.6 * S, 0.17 * S, -0.92 * S + bob);
      ctx.closePath();
      ctx.ellipse(0, -1.08 * S + bob, 0.1 * S, 0.11 * S, 0, 0, Math.PI * 2);
      break;
  }
  ctx.stroke();
  void walk; void moving;
}

function drawRarityOutline(ctx, S, rarity, t) {
  const col = RARITY_COLOR[rarity];
  if (!col) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.25 + 0.15 * Math.sin(t * 4);
  radialGlow(ctx, 0, -0.5 * S, 0.85 * S, col.h, col.s, col.l, 0.35);
  ctx.restore();
}

function drawBossAura(ctx, S, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  radialGlow(ctx, 0, -0.6 * S, 1.6 * S, 355, 100, 40, 0.3 + 0.1 * Math.sin(t * 2));
  // 环绕暗红粒子（由粒子系统补充，这里画基础环）
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = 'hsl(355 100% 52% / .5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, -0.02 * S, S * 1.1, S * 0.5, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ── 投射物 ──────────────────────────────────────────────────────────────────

export function drawProjectile(ctx, x, y, pr, u, t) {
  const c = parseColor(pr.color || '#ffaa33');
  const ang = Math.atan2((pr.vz || 0) * 0.72, pr.vx || 0);
  const kind = pr.kind || 'orb';
  const S = u * Math.max(0.5, (pr.radius ?? 0.15) / 0.15);
  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  if (kind === 'arrow') {
    ctx.rotate(ang);
    // 箭身
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = '#d7c39a';
    ctx.lineWidth = Math.max(1.2, 0.035 * u);
    ctx.beginPath();
    ctx.moveTo(-0.3 * u, 0);
    ctx.lineTo(0.12 * u, 0);
    ctx.stroke();
    ctx.fillStyle = '#e9eef7';
    ctx.beginPath();
    ctx.moveTo(0.2 * u, 0);
    ctx.lineTo(0.08 * u, -0.05 * u);
    ctx.lineTo(0.08 * u, 0.05 * u);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    // 拖尾
    const g = ctx.createLinearGradient(-0.9 * u, 0, 0.1 * u, 0);
    g.addColorStop(0, hsl(c.h, c.s, c.l, 0));
    g.addColorStop(1, hsl(c.h, 100, 75, 0.5));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-0.9 * u, -0.02 * u);
    ctx.lineTo(0.1 * u, -0.05 * u);
    ctx.lineTo(0.1 * u, 0.05 * u);
    ctx.lineTo(-0.9 * u, 0.02 * u);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'bolt') {
    ctx.rotate(ang);
    radialGlow(ctx, 0, 0, 0.4 * u, c.h, 100, 70, 0.6);
    const g = ctx.createLinearGradient(-1.2 * u, 0, 0.2 * u, 0);
    g.addColorStop(0, hsl(c.h, 100, 65, 0));
    g.addColorStop(0.8, hsl(c.h, 100, 80, 0.9));
    g.addColorStop(1, '#ffffff');
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(1.5, 0.07 * u);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-1.2 * u, 0);
    ctx.lineTo(0.15 * u, 0);
    ctx.stroke();
  } else {
    // orb / orb_aoe
    const pulse = 1 + Math.sin(t * 12) * 0.1;
    const rr = 0.26 * u * pulse;
    radialGlow(ctx, 0, 0, rr * 2.6, c.h, c.s, c.l, 0.55);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rr);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, hsl(c.h, 100, 82));
    g.addColorStop(1, hsl(c.h, 100, 55, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.fill();
    // 环轨道
    ctx.strokeStyle = hsl(c.h, 100, 78, 0.7);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, rr * 1.6, rr * 0.7, t * 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ── 地面物品 / 魂火 ──────────────────────────────────────────────────────────

export const RARITY_ITEM_HSL = {
  normal: { h: 210, s: 8, l: 82 }, magic: { h: 262, s: 92, l: 66 }, rare: { h: 44, s: 100, l: 60 },
  unique: { h: 26, s: 100, l: 56 }, legendary: { h: 26, s: 100, l: 56 }, currency: { h: 40, s: 46, l: 70 },
};

/** 掉落在地上的物品：光柱 + 小图标（按稀有度着色，颜色与 POE 一致） */
export function drawGroundItem(ctx, x, y, it, u, t, hovered = false) {
  const rarity = (it && it.rarity) || 'normal';
  const c = RARITY_ITEM_HSL[rarity] || RARITY_ITEM_HSL.normal;
  const bob = Math.sin(t * 3 + x * 0.05) * 0.03 * u;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  // 地面光圈
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.34 * u);
  g.addColorStop(0, hsl(c.h, c.s, c.l, 0.5));
  g.addColorStop(1, hsl(c.h, c.s, c.l, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.4 * u, 0.18 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  // 光柱
  const beamH = (rarity === 'normal' ? 0.5 : rarity === 'unique' ? 1.6 : 1.1) * u;
  const bg = ctx.createLinearGradient(0, 0, 0, -beamH);
  bg.addColorStop(0, hsl(c.h, c.s, c.l, 0.5));
  bg.addColorStop(1, hsl(c.h, c.s, c.l, 0));
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(-0.12 * u, 0);
  ctx.lineTo(-0.05 * u, -beamH);
  ctx.lineTo(0.05 * u, -beamH);
  ctx.lineTo(0.12 * u, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // 图标（实体绘制，不发光）
  ctx.save();
  ctx.translate(0, -0.16 * u + bob);
  drawItemIcon(ctx, it && it.icon, 0.2 * u, c, t);
  ctx.restore();
  if (hovered) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hsl(c.h, c.s, 90, 0.6);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.46 * u, 0.2 * u, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** 物品图标：按 icon/name 关键词画不同小图形（剑/盾/盔/戒/药/链/宝石） */
export function drawItemIcon(ctx, icon, size, c, t = 0) {
  const s = size;
  const kind = iconKind(icon);
  ctx.save();
  ctx.translate(0, -s * 0.5);
  ctx.rotate(Math.sin(t * 1.5) * 0.05);
  const body = hsl(c.h, Math.max(12, c.s), Math.min(92, c.l + 18));
  const edge = hsl(c.h, Math.max(12, c.s), Math.max(20, c.l - 10));
  ctx.lineWidth = Math.max(1, s * 0.08);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'sword':
    case 'axe':
      ctx.strokeStyle = body;
      ctx.beginPath();
      ctx.moveTo(-s * 0.35, s * 0.75);
      ctx.lineTo(s * 0.35, -s * 0.75);
      ctx.stroke();
      ctx.strokeStyle = edge;
      ctx.beginPath();
      ctx.moveTo(-s * 0.5, s * 0.35);
      ctx.lineTo(s * 0.05, s * 0.35);
      ctx.stroke();
      break;
    case 'shield':
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.8);
      ctx.lineTo(s * 0.7, -s * 0.55);
      ctx.lineTo(s * 0.55, s * 0.35);
      ctx.lineTo(0, s * 0.85);
      ctx.lineTo(-s * 0.55, s * 0.35);
      ctx.lineTo(-s * 0.7, -s * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.stroke();
      break;
    case 'helm':
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.62, Math.PI, 0);
      ctx.lineTo(s * 0.62, s * 0.45);
      ctx.lineTo(-s * 0.62, s * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(-s * 0.45, s * 0.02, s * 0.9, s * 0.16);
      break;
    case 'ring':
      ctx.strokeStyle = body;
      ctx.lineWidth = Math.max(1.4, s * 0.16);
      ctx.beginPath();
      ctx.arc(0, s * 0.2, s * 0.46, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = edge;
      ctx.beginPath();
      ctx.arc(0, -s * 0.35, s * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'amulet':
      ctx.strokeStyle = body;
      ctx.lineWidth = Math.max(1, s * 0.1);
      ctx.beginPath();
      ctx.arc(0, -s * 0.1, s * 0.55, Math.PI * 0.15, Math.PI * 0.85, true);
      ctx.stroke();
      ctx.fillStyle = edge;
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.05);
      ctx.lineTo(s * 0.3, s * 0.3);
      ctx.lineTo(0, s * 0.75);
      ctx.lineTo(-s * 0.3, s * 0.3);
      ctx.closePath();
      ctx.fill();
      break;
    case 'belt':
      ctx.fillStyle = body;
      ctx.fillRect(-s * 0.8, -s * 0.15, s * 1.6, s * 0.3);
      ctx.fillStyle = edge;
      ctx.fillRect(-s * 0.16, -s * 0.28, s * 0.32, s * 0.56);
      break;
    case 'potion':
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(-s * 0.18, -s * 0.7);
      ctx.lineTo(s * 0.18, -s * 0.7);
      ctx.lineTo(s * 0.18, -s * 0.3);
      ctx.quadraticCurveTo(s * 0.6, 0, s * 0.42, s * 0.5);
      ctx.quadraticCurveTo(0, s * 0.9, -s * 0.42, s * 0.5);
      ctx.quadraticCurveTo(-s * 0.6, 0, -s * 0.18, -s * 0.3);
      ctx.closePath();
      ctx.fill();
      break;
    case 'gem':
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.75);
      ctx.lineTo(s * 0.6, -s * 0.1);
      ctx.lineTo(0, s * 0.8);
      ctx.lineTo(-s * 0.6, -s * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.stroke();
      break;
    case 'boots':
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(-s * 0.3, -s * 0.8);
      ctx.lineTo(s * 0.2, -s * 0.8);
      ctx.lineTo(s * 0.2, s * 0.2);
      ctx.lineTo(s * 0.75, s * 0.5);
      ctx.lineTo(s * 0.75, s * 0.8);
      ctx.lineTo(-s * 0.3, s * 0.8);
      ctx.closePath();
      ctx.fill();
      break;
    case 'gloves':
      ctx.fillStyle = body;
      roundRect(ctx, -s * 0.45, -s * 0.4, s * 0.9, s * 1.1, s * 0.3);
      ctx.fill();
      for (let i = 0; i < 4; i++) {
        roundRect(ctx, -s * 0.42 + i * s * 0.23, -s * 0.85, s * 0.18, s * 0.55, s * 0.09);
        ctx.fill();
      }
      break;
    case 'coin':
      ctx.fillStyle = hsl(44, 95, 58);
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = hsl(44, 95, 36);
      ctx.stroke();
      break;
    default:
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.7);
      ctx.lineTo(s * 0.65, 0);
      ctx.lineTo(0, s * 0.7);
      ctx.lineTo(-s * 0.65, 0);
      ctx.closePath();
      ctx.fill();
  }
  ctx.restore();
}

export function iconKind(icon) {
  const s = String(icon || '').toLowerCase();
  if (/sword|blade|axe|sword|刀|剑|斧/.test(s)) return 'sword';
  if (/shield|盾/.test(s)) return 'shield';
  if (/helm|helmet|头/.test(s)) return 'helm';
  if (/ring|戒/.test(s)) return 'ring';
  if (/amulet|necklace|项链|护符/.test(s)) return 'amulet';
  if (/belt|腰/.test(s)) return 'belt';
  if (/boot|鞋/.test(s)) return 'boots';
  if (/glove|手/.test(s)) return 'gloves';
  if (/potion|flask|药/.test(s)) return 'potion';
  if (/gem|orb|currency|宝石|通货/.test(s)) return 'gem';
  if (/gold|coin|金/.test(s)) return 'coin';
  return 'gem';
}

/** 魂火（金色/经验紫/生命红的小光球） */
export function drawLootOrb(ctx, x, y, orb, u, t) {
  const kind = orb.kind || 'gold';
  const hue = kind === 'gold' ? 44 : kind === 'xp' ? 275 : kind === 'life' ? 350 : 190;
  const pulse = 0.8 + 0.2 * Math.sin(t * 10 + x * 0.1);
  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  radialGlow(ctx, 0, 0, 0.36 * u * pulse, hue, 100, 62, 0.6);
  ctx.fillStyle = hsl(hue, 100, 82);
  ctx.beginPath();
  ctx.arc(0, 0, 0.09 * u * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-0.02 * u, -0.02 * u, 0.035 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── 图腾 ────────────────────────────────────────────────────────────────────

export function drawTotem(ctx, x, y, s, u, t) {
  const S = u * Math.max(0.8, (s.radius ?? 0.45) / 0.45);
  ctx.save();
  ctx.translate(x, y);
  // 法术阵
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.7;
  const rot = t * 0.9;
  const hue = 205;
  ctx.strokeStyle = hsl(hue, 100, 66, 0.75);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, 1.0 * S, 0.46 * S, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(0, 0, 0.78 * S, 0.36 * S, 0, 0, Math.PI * 2);
  ctx.stroke();
  // 符文：旋转的短线
  for (let i = 0; i < 8; i++) {
    const a = rot + (i / 8) * Math.PI * 2;
    const px = Math.cos(a) * 0.88 * S, py = Math.sin(a) * 0.4 * S;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.strokeStyle = hsl(hue, 100, 78, 0.85);
    ctx.beginPath();
    ctx.moveTo(-0.05 * S, -0.05 * S);
    ctx.lineTo(0.05 * S, 0.05 * S);
    ctx.moveTo(0.05 * S, -0.05 * S);
    ctx.lineTo(-0.05 * S, 0.05 * S);
    ctx.stroke();
    ctx.restore();
  }
  radialGlow(ctx, 0, 0, 0.9 * S, hue, 100, 60, 0.22);
  ctx.restore();
  // 图腾柱
  const H = 1.1 * S;
  const grd = ctx.createLinearGradient(-0.12 * S, 0, 0.12 * S, 0);
  grd.addColorStop(0, '#3a2a1c');
  grd.addColorStop(0.45, '#7a5a3a');
  grd.addColorStop(1, '#2a1c12');
  ctx.fillStyle = grd;
  roundRect(ctx, -0.12 * S, -H, 0.24 * S, H, 0.03 * S);
  ctx.fill();
  // 顶上的发光图腾头
  ctx.fillStyle = '#8a6a44';
  ellipse(ctx, 0, -H - 0.04 * S, 0.15 * S, 0.12 * S);
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const flick = 0.75 + 0.25 * Math.sin(t * 13);
  radialGlow(ctx, 0, -H - 0.04 * S, 0.5 * S, hue, 100, 66, 0.7 * flick);
  ctx.restore();
  // 生命条（小）
  const hp = s.maxHp ? Math.max(0, Math.min(1, s.hp / s.maxHp)) : 1;
  if (hp < 1) {
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(-0.22 * S, -H - 0.36 * S, 0.44 * S, 0.05 * S);
    ctx.fillStyle = hp > 0.4 ? '#63d06a' : '#e04a3a';
    ctx.fillRect(-0.22 * S, -H - 0.36 * S, 0.44 * S * hp, 0.05 * S);
  }
  ctx.restore();
}

// ── 地面效果 ────────────────────────────────────────────────────────────────

export const GROUND_KIND = {
  fire: { h: 22, s: 100, l: 52, flames: true },
  poison: { h: 110, s: 85, l: 45, bubbles: true },
  void: { h: 285, s: 95, l: 45, swirl: true },
  frost: { h: 195, s: 90, l: 66, shards: true },
  holy: { h: 46, s: 100, l: 60, runes: true },
  blood: { h: 352, s: 90, l: 42, swirl: true },
};

/** 地面效果：加色或正片叠底的地面圆斑 + 火苗/气泡/漩涡 */
export function drawGroundEffect(ctx, x, y, e, u, t) {
  const k = GROUND_KIND[e.kind] || GROUND_KIND.fire;
  const r = (e.radius ?? 1) * u;
  const life = e.dur > 0 ? Math.min(1, e.t / Math.min(0.4, e.dur * 0.3)) * Math.min(1, Math.max(0, (e.dur - e.t) / 0.4)) : 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = Math.max(0, life);
  // 地面焦痕（正片叠底）
  ctx.globalCompositeOperation = e.kind === 'fire' ? 'source-over' : 'lighter';
  if (e.kind === 'fire') {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, 'rgba(20,8,4,0.75)');
    g.addColorStop(0.75, hsl(k.h, 80, 30, 0.4));
    g.addColorStop(1, hsl(k.h, 80, 30, 0));
    ctx.fillStyle = g;
  } else {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, hsl(k.h, k.s, k.l, 0.35));
    g.addColorStop(0.7, hsl(k.h, k.s, k.l, 0.16));
    g.addColorStop(1, hsl(k.h, k.s, k.l, 0));
    ctx.fillStyle = g;
  }
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.max(0, life) * 0.9;
  if (k.flames) {
    const n = Math.max(6, Math.min(16, Math.round(r / 8)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + t * 1.5;
      const rr = r * (0.25 + 0.65 * hash2(i, 3));
      const fx = Math.cos(a) * rr, fy = Math.sin(a) * rr * 0.5;
      const hgt = 0.22 * u * (0.6 + 0.6 * hash2(i, 9)) * (0.7 + 0.3 * Math.sin(t * 12 + i));
      const g2 = ctx.createLinearGradient(fx, fy, fx, fy - hgt);
      g2.addColorStop(0, hsl(30, 100, 60, 0.8));
      g2.addColorStop(0.6, hsl(26, 100, 55, 0.5));
      g2.addColorStop(1, hsl(20, 100, 50, 0));
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.moveTo(fx - 0.06 * u, fy);
      ctx.quadraticCurveTo(fx - 0.03 * u, fy - hgt * 0.6, fx, fy - hgt);
      ctx.quadraticCurveTo(fx + 0.03 * u, fy - hgt * 0.6, fx + 0.06 * u, fy);
      ctx.closePath();
      ctx.fill();
    }
    radialGlow(ctx, 0, 0, r * 0.9, 26, 100, 55, 0.25);
  } else if (k.bubbles) {
    for (let i = 0; i < 10; i++) {
      const a = t * 1.2 + i * 0.9;
      const rr = r * (0.2 + 0.7 * hash2(i, 5));
      const bx = Math.cos(a) * rr, by = Math.sin(a) * rr * 0.5;
      const bs = (0.04 + 0.04 * Math.abs(Math.sin(t * 3 + i))) * u;
      ctx.fillStyle = hsl(k.h, 90, 62, 0.6);
      ctx.beginPath();
      ctx.arc(bx, by - 0.02 * u, bs, 0, Math.PI * 2);
      ctx.fill();
    }
    radialGlow(ctx, 0, 0, r, k.h, k.s, k.l, 0.2);
  } else if (k.swirl) {
    for (let arm = 0; arm < 3; arm++) {
      ctx.beginPath();
      for (let s = 0; s <= 12; s++) {
        const a = arm * 2.09 + t * 2.2 + s * 0.35;
        const rr = (s / 12) * r * 0.95;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr * 0.5;
        if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = hsl(k.h, k.s, k.l + 12, 0.5);
      ctx.lineWidth = Math.max(1, 0.03 * u);
      ctx.stroke();
    }
    radialGlow(ctx, 0, 0, r * 0.8, k.h, k.s, k.l, 0.28);
  } else if (k.shards) {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + hash2(i, 11) * 0.6;
      const rr = r * (0.3 + 0.6 * hash2(i, 2));
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr * 0.5;
      const hgt = (0.12 + 0.1 * hash2(i, 4)) * u;
      ctx.fillStyle = hsl(k.h, 90, 78, 0.6);
      ctx.beginPath();
      ctx.moveTo(px, py - hgt);
      ctx.lineTo(px + 0.05 * u, py);
      ctx.lineTo(px - 0.05 * u, py);
      ctx.closePath();
      ctx.fill();
    }
    radialGlow(ctx, 0, 0, r * 0.9, k.h, k.s, k.l, 0.26);
  } else {
    radialGlow(ctx, 0, 0, r, k.h, k.s, k.l, 0.3);
    // 符文环
    ctx.strokeStyle = hsl(k.h, k.s, 80, 0.5);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.85, r * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** 投射物影子（地面） */
export function drawProjectileShadow(ctx, x, groundY, u) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(x, groundY, 0.14 * u, 0.06 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 血的痕迹（击杀后短暂） */
export function drawBloodSplat(ctx, x, y, r, seed, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(70,6,10,0.85)';
  ctx.beginPath();
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + seed;
    const rr = r * (0.35 + 0.65 * hash2(i + seed * 10, 17));
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr * 0.5;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}