// ═════════════════════════════════════════════════════════════════════════════
// draw-whirl.js — 旋风斩（whirlwind）的视觉表现
//
// 背景：原先 renderer 里只设置了 this.whirl.active，却没有任何绘制代码，
//       所以"旋风斩没有效果"（玩家只是在不停播放普通挥砍）。本文件补上旋风的视觉。
//
// 踩过的坑（勿重犯，都被实机渲染验证过）：
//   1) 不要用 radial/linear 渐变**填充**覆盖角色的面：在 'lighter' + bloom 下
//      整块渐变会变成纯白圆盘，把玩家和怪物完全吃掉。
//   2) 不要用细弧/细线"围"成一整圈：bloom 会把它们连成一个刺眼的白圆环。
//      → 因此这里只画**开口的扇形刀光**，并且不画整圈地面法环。
//   3) 不要用 P_LINE 拖尾粒子做旋风，原因同上。
// 最终方案：两段错位、越靠刀头越亮越粗的扇形弧线（不闭合、不成环）+ 极少量火星。
// ═════════════════════════════════════════════════════════════════════════════
import { hsl } from './sprites.js';
import { P_DOT } from './particles.js';

const TAU = Math.PI * 2;
/** 松手后的淡出时长（秒）。超过这个时间旋风必须完全消失 */
const WHIRL_FADE = 0.12;

export const renderWhirl = {
  /** 每帧推进旋风状态（由 _renderFrame 调用） */
  _updateWhirl(dt, world) {
    const p = world && world.player;
    const w = this.whirl;
    const spinning = !!(p && (p.whirlspinning || (p.anim && p.anim.state === 'whirlwind')));
    // [Lead 修复] 松手即停：不再有"余晖停留"。
    //   spinning 一旦结束就只做 0.12s 的淡出（fadeOut 1→0），同时角度冻结、不再喷粒子。
    //   （旧实现有一个 w.left 计时器 + whirl 事件每帧续命，导致松手后画面还停一会儿刀光。）
    if (spinning) {
      w.fadeOut = 1;
      w.active = true;
    } else {
      w.fadeOut = Math.max(0, (Number.isFinite(w.fadeOut) ? w.fadeOut : 0) - dt / WHIRL_FADE);
      w.active = w.fadeOut > 0;
    }
    if (!w.active) return;
    if (spinning) {
      const spd = 12 + (p && p.stats ? (p.stats.attackSpeedMult || 0) * 4 : 0);
      w.angle = ((w.angle || 0) + dt * spd) % TAU;
    }
    const aoe = p && p.stats ? p.stats.aoeMult || 0 : 0;
    w.radius = 2.1 * (1 + Math.min(2, Math.max(-0.6, aoe))) * 0.86;
    if (p) { w.x = p.x; w.z = p.z; }
    // 极少量火星（仅旋转时生成，短寿命、低亮度；P_DOT 不会拖出长条）
    if (spinning && this.quality > 0 && p && Math.random() < 0.16 && this.particles.count < this.particles.max - 20) {
      const a = w.angle + (Math.random() - 0.5) * 1.4;
      const r = w.radius * (0.55 + Math.random() * 0.4);
      this.particles.spawn({
        x: w.x + Math.cos(a) * r, z: w.z + Math.sin(a) * r, h: 0.2 + Math.random() * 0.6,
        vx: -Math.sin(a) * 0.8, vz: Math.cos(a) * 0.8, vh: 0.9,
        life: 0.22, size: 0.03, sizeEnd: 0.004,
        hue: 38, sat: 100, light: 55, drag: 3, gravity: -0.7, kind: P_DOT, alpha: 0.6,
      });
    }
  },

  /** 旋风视觉：两段开口的扇形刀光（绝不闭合成环） */
  _drawWhirl(ctx, cam) {
    const w = this.whirl;
    const pt = this.scratch;
    const u = cam.scale;
    if (!(u > 0)) return;
    const R = (w.radius || 2) * u;
    const sq = cam.squash || 0.72;
    cam.worldToScreen(w.x, w.z, 0, pt);
    if (pt.x < -R - 80 || pt.x > this.w + R + 80 || pt.y < -R - 80 || pt.y > this.h + R + 80) return;
    const ang = Number.isFinite(w.angle) ? w.angle : 0;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // [Lead 修复] 松手后不得残留刀光：用 fadeOut 在 0.12s 内把整体透明度收到 0，
    // 旋涡角度同时冻结（不再旋转），避免"停止后画面还在转/还留着一坨刀光"。
    ctx.globalAlpha = Number.isFinite(w.fadeOut) ? w.fadeOut : 1;
    // [实测结论] 任何"绕圈"的图形（细弧/环/椭环）在 bloom 下都会被连成白色圆环；
    // 而实心、非环形的图形完全没问题。所以旋风 = 两片绕角色旋转的"实心刀光瓣"。
    for (let k = 0; k < 2; k++) {
      const head = ang + k * Math.PI;
      const inner = 0.22, outer = 0.98;
      const halfW = 0.34;
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = hsl(38, 96, 56);
      ctx.beginPath();
      // 一片刀光：内外两条边 + 两个端点，构成"月牙形"实体（不闭合到圆心，不是环）
      for (let i = 0; i <= 8; i++) {
        const a = head - halfW + (2 * halfW) * (i / 8);
        const rr = R * outer * (0.86 + 0.14 * Math.sin((i / 8) * Math.PI));
        const x = pt.x + Math.cos(a) * rr, y = pt.y + Math.sin(a) * rr * sq;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let i = 8; i >= 0; i--) {
        const a = head - halfW + (2 * halfW) * (i / 8);
        const rr = R * inner * (0.9 + 0.2 * Math.sin((i / 8) * Math.PI));
        const x = pt.x + Math.cos(a) * rr, y = pt.y + Math.sin(a) * rr * sq;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      // 更亮的刀锋（更薄的一片，略靠外）
      ctx.globalAlpha = 0.46;
      ctx.fillStyle = hsl(46, 100, 70);
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) {
        const a = head - halfW * 0.72 + (2 * halfW * 0.72) * (i / 8);
        const rr = R * (outer - 0.02);
        const x = pt.x + Math.cos(a) * rr, y = pt.y + Math.sin(a) * rr * sq;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let i = 8; i >= 0; i--) {
        const a = head - halfW * 0.72 + (2 * halfW * 0.72) * (i / 8);
        const rr = R * (outer - 0.18);
        const x = pt.x + Math.cos(a) * rr, y = pt.y + Math.sin(a) * rr * sq;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  /** 跳伤害：一次非常轻的细环（不喷粒子） */
  _onWhirlTick(x, z, r) {
    this.effects.ring(x, z, {
      r0: r * 0.82, r1: r * 0.98, dur: 0.18, hue: 40, sat: 90, light: 56, width: 1.3, kind: 'slash',
    });
  },
};