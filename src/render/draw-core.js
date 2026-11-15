// ─────────────────────────────────────────────────────────────────────────────
// draw-core.js — 渲染器的"环境层"：每帧更新辅助 / 背景 / 地面 / 墙 / 后处理 / 调试
// 这些方法会被 mixin 挂到 Renderer.prototype（见 renderer.js），内部通过 this 访问状态。
// ─────────────────────────────────────────────────────────────────────────────
import { hsl, parseColor } from './sprites.js';
import { P_DOT, P_LINE, P_STAR } from './particles.js';
import { clamp } from './project.js';
import { WALL_H } from './terrain.js';
import { normalizeGroundFx, isWhirlState, hasBloodRage } from './shared.js';

export const renderCore = {
  // ── 更新辅助 ───────────────────────────────────────────────────────────────

  _updateSkillLayers(dt, world) {
    const p = world && world.player;
    // 旋风斩：只要 player.anim.state==='whirlwind'（或 whirlwind 标记/技能层活着）就维持
    if (isWhirlState(p)) {
      this.whirl.active = true;
      this.whirl.left = Math.max(this.whirl.left, 0.12);
    }
    if (this.whirl.active) {
      this.whirl.left -= dt;
      if (this.whirl.left <= 0) this.whirl.active = false;
      // 旋风粒子
      if (p && this.quality > 0 && this.particles.count < this.particles.max * 0.9) {
        const a = Math.random() * Math.PI * 2;
        const r = 0.75 + Math.random() * 0.25;
        this.particles.spawn({
          x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r, h: 0.3 + Math.random() * 0.7,
          vx: -Math.sin(a) * 4, vz: Math.cos(a) * 4, vh: 0.4, life: 0.28, size: 0.09, sizeEnd: 0.01,
          hue: 36, sat: 100, light: 70, drag: 1, gravity: 0, kind: P_LINE, spin: 6,
        });
      }
    }
    // 血怒光环：玩家 buff 或技能层
    const rageAura = this.auras.find((a) => a.kind === 'bloodRage');
    const hasRage = hasBloodRage(p) || this.auras.some((a) => a.active && a.kind === 'bloodRage');
    if (hasRage && rageAura && !rageAura.active) {
      rageAura.active = true;
      rageAura.left = 2;
      rageAura.dur = 2;
    }
    if (hasRage && p && this.quality > 0 && this.particles.count < this.particles.max * 0.92) {
      // 血色光环粒子：绕玩家内外旋转
      const a = this.time * 1.6 + Math.random() * 0.5;
      const r = 0.5 + Math.random() * 0.8;
      this.particles.spawn({
        x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r, h: 0.1 + Math.random() * 1.1,
        vx: -Math.sin(a) * 1.6, vz: Math.cos(a) * 1.6, vh: 0.6, life: 0.6, size: 0.07, sizeEnd: 0.01,
        hue: 352, sat: 100, light: 55, drag: 0.6, gravity: -0.4, kind: P_DOT,
      });
    }
    for (const a of this.auras) {
      if (!a.active) continue;
      a.left -= dt;
      if (a.left <= 0) a.active = false;
    }
    // 图腾从 world.summoned 同步
    const summoned = (world && world.summoned) || null;
    if (Array.isArray(summoned)) {
      for (const s of summoned) {
        if (!s || s.kind !== 'totem') continue;
        let t = this.totems.find((o) => o.active && Math.abs(o.x - s.x) < 0.6 && Math.abs(o.z - s.z) < 0.6);
        if (!t) {
          t = this.totems.find((o) => !o.active) || this.totems[0];
          t.active = true;
          t.x = s.x; t.z = s.z; t.left = 1; t.dur = 1; t.hue = 205;
          this.effects.ring(s.x, s.z, { r0: 0.2, r1: 2.4, dur: 0.6, hue: 205, width: 3 });
        }
        t.left = 0.5; // 由 world 维持
      }
    }
    for (const t of this.totems) {
      if (!t.active) continue;
      t.left -= dt;
      if (t.left <= 0) t.active = false;
      else if (this.quality > 0 && this.particles.count < this.particles.max * 0.9 && Math.random() < 0.35) {
        // 图腾上升的蓝光点
        this.particles.spawn({
          x: t.x + (Math.random() - 0.5) * 0.3, z: t.z + (Math.random() - 0.5) * 0.3, h: 0.1,
          vx: 0, vz: 0, vh: 1.2, life: 0.9, size: 0.08, sizeEnd: 0.01, hue: 205, sat: 100, light: 70,
          drag: 0.2, gravity: -0.2, kind: P_DOT,
        });
      }
    }
    // 裂地斩残留环
    for (const s of this.slamRings) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= s.dur) s.active = false;
    }
  },

  _updateShockwaves(dt) {
    for (const s of this.shockwaves) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= s.dur) s.active = false;
    }
  },

  /** 环境余烬：全屏缓慢飘动的火星（POE 暗黑余烬感） */
  _ambientEmbers(world, dt) {
    if (this.quality === 0) return;
    const cam = this.cam;
    const rate = this.quality === 2 ? 90 : 40; // 每秒
    const want = rate * dt;
    let n = Math.floor(want);
    if (Math.random() < want - n) n++;
    const pool = this.particles;
    for (let i = 0; i < n; i++) {
      if (pool.count >= pool.max - 40) break;
      // 在相机周围生成
      const wx = cam.x + (Math.random() - 0.5) * (cam.viewW / cam.scale);
      const wz = cam.z + (Math.random() - 0.5) * (cam.viewH / (cam.scale * cam.squash)) + 2;
      pool.spawn({
        x: wx, z: wz, h: Math.random() * 1.5,
        vx: (Math.random() - 0.5) * 0.3, vz: -0.15 - Math.random() * 0.2, vh: 0.25 + Math.random() * 0.35,
        life: 3.5 + Math.random() * 2, size: 0.03 + Math.random() * 0.04, sizeEnd: 0.005,
        hue: 26 + Math.random() * 14, sat: 100, light: 55 + Math.random() * 20,
        drag: 0.1, gravity: -0.02, kind: P_DOT, alpha: 0.75,
      });
    }
    // BOSS 存在时额外暗红粒子环绕玩家
    if (this.bossPresent && world && world.player) {
      const p = world.player;
      if (Math.random() < 0.5) {
        this.particles.spawn({
          x: p.x + (Math.random() - 0.5) * 0.6, z: p.z + (Math.random() - 0.5) * 0.6, h: 0,
          vx: 0, vz: 0, vh: 0.8, life: 0.8, size: 0.08, sizeEnd: 0.01, hue: 355, sat: 100, light: 45,
          kind: P_DOT, gravity: -0.3,
        });
      }
    }
  },

  // ── 各绘制阶段 ─────────────────────────────────────────────────────────────

  _drawBackground(ctx, cam, world) {
    const W = this.w, H = this.h;
    // 地牢外的虚空（雾 + 星点余烬）
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#05060b');
    g.addColorStop(0.5, '#070910');
    g.addColorStop(1, '#020305');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 远处的"深渊光"
    const map = world && world.map;
    const bossy = map && map.isBoss;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const rg = ctx.createRadialGradient(W * 0.5, H * 0.35, 0, W * 0.5, H * 0.35, Math.max(W, H) * 0.75);
    const hue = bossy ? 352 : 22;
    rg.addColorStop(0, hsl(hue, 60, 18, 0.16));
    rg.addColorStop(0.5, hsl(hue, 50, 10, 0.06));
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  },

  _drawGround(ctx, cam, world) {
    const d = world && world.dungeon;
    this.terrain.drawGround(ctx, d, cam, this.time, this.quality);
    // 火把的宽幅地面光池画在墙体之前：墙体自然遮挡光线，光不会"糊穿"整面墙。
    if (d) this._drawTorchPools(ctx, cam, d);
  },

  /**
   * 火把地面光池：两层高斯式柔光叠加。
   * 提前预渲染成 256px 贴图（_torchGlow），每帧只做 drawImage；
   * 无浏览器环境（离屏光栅测试）退回径向渐变，保证预览一致。
   */
  _drawTorchPools(ctx, cam, d) {
    const torches = this.terrain.collectTorches(d, cam, this.torchBuf);
    if (!torches.length) return;
    const p = this.scratch;
    const t = this.time;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const tc of torches) {
      const flick = this._torchFlicker(tc, t);
      cam.worldToScreen(tc.x, tc.z, 0, p);
      const sprite = this._torchGlow(tc.color);
      // 宽幅光池（柔）+ 近距亮芯，避免整块区域被照成一片"雾"
      const r = cam.scale * 3.8 * flick;
      if (sprite) {
        ctx.globalAlpha = 0.18;
        ctx.drawImage(sprite, p.x - r, p.y - r * cam.squash, r * 2, r * 2 * cam.squash);
      } else {
        this._paintSoftGlow(ctx, p.x, p.y, r, tc.color, 0.18, cam.squash);
      }
      // 近处再叠一层，中心稍亮、边缘更柔
      const r2 = cam.scale * 1.9 * flick;
      if (sprite) {
        ctx.globalAlpha = 0.09;
        ctx.drawImage(sprite, p.x - r2, p.y - r2 * cam.squash, r2 * 2, r2 * 2 * cam.squash);
      } else {
        this._paintSoftGlow(ctx, p.x, p.y, r2, tc.color, 0.09, cam.squash);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  /** 火焰抖动：低频、多正弦叠加，幅度很小 → 柔和不跳眼 */
  _torchFlicker(tc, t) {
    const phase = tc.x * 2.3 + tc.z * 3.7;
    return 0.94
      + 0.045 * Math.sin(t * 1.9 + phase)
      + 0.028 * Math.sin(t * 4.7 + phase * 1.7)
      + 0.018 * Math.sin(t * 8.3 + phase * 0.6);
  },

  /**
   * 预渲染柔光贴图（每种颜色一张，缓存复用）。
   * 衰减曲线 exp(-4.6k²)·(1-k)：中心最亮，平滑过渡到完全透明，没有"光圈边"。
   */
  _torchGlow(color) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    const key = String(color || 'hsl(36 100% 60%)');
    const cache = this._torchGlowCache || (this._torchGlowCache = new Map());
    const hit = cache.get(key);
    if (hit) return hit;
    const col = parseColor(key);
    const hue = col.h;
    const sat = Math.max(58, Math.min(100, col.s));
    const light = Math.max(62, Math.min(82, col.l));
    const S = 256;
    let cv;
    try { cv = document.createElement('canvas'); } catch { return null; }
    if (!cv || typeof cv.getContext !== 'function') return null;
    cv.width = S;
    cv.height = S;
    const g = cv.getContext('2d');
    if (!g || typeof g.createRadialGradient !== 'function') return null;
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    const steps = 18;
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      const a = Math.exp(-4.6 * k * k) * (1 - k);
      grad.addColorStop(k, hsl(hue, sat, light, Math.max(0, Math.min(1, a))));
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    if (cache.size > 15) cache.clear();
    cache.set(key, cv);
    return cv;
  },

  /** 径向渐变兜底（离屏光栅 / 无 DOM 环境），形状与贴图一致 */
  _paintSoftGlow(ctx, x, y, radius, color, alpha, squash = 1) {
    const col = parseColor(color);
    const hue = col.h;
    const sat = Math.max(58, Math.min(100, col.s));
    const light = Math.max(62, Math.min(82, col.l));
    const r = Math.max(1, radius);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, squash);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      const a = Math.exp(-4.6 * k * k) * (1 - k) * alpha;
      g.addColorStop(k, hsl(hue, sat, light, Math.max(0, Math.min(1, a))));
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },

  _drawWalls(ctx, cam, world) {
    const d = world && world.dungeon;
    if (!d) return;
    this.terrain.drawWalls(ctx, d, cam, this.time, this.quality);
    // 火把本体：墙体之上的近距核心光 + 柔化火苗 + 火星
    const torches = this.terrain.collectTorches(d, cam, this.torchBuf);
    if (torches.length) {
      const p = this.scratch;
      const t = this.time;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const tc of torches) {
        const flick = this._torchFlicker(tc, t);
        cam.worldToScreen(tc.x, tc.z, WALL_H * 0.72, p);
        // 贴墙的小范围柔光（不是实心火球）
        const sprite = this._torchGlow(tc.color);
        const r = cam.scale * 1.5 * flick;
        if (sprite) {
          ctx.globalAlpha = 0.19;
          ctx.drawImage(sprite, p.x - r, p.y - r * cam.squash, r * 2, r * 2 * cam.squash);
        } else {
          this._paintSoftGlow(ctx, p.x, p.y, r, tc.color, 0.19, cam.squash);
        }
        if (this.quality <= 0) continue;
        const col = parseColor(tc.color);
        const hue = col.h;
        const sat = Math.max(55, col.s);
        const fh = cam.scale * 0.34 * flick;
        const sway = Math.sin(t * 2.3 + tc.z * 2.7) * cam.scale * 0.014;
        const fx = p.x + sway;
        const fy = p.y - fh * 0.18;
        // 火苗：径向渐变 + 椭圆轮廓，中心亮、边缘完全淡出
        const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, fh);
        fg.addColorStop(0, hsl(hue, sat, 95, 0.95));
        fg.addColorStop(0.3, hsl(hue, sat, 78, 0.55));
        fg.addColorStop(1, hsl(hue, sat, 58, 0));
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.ellipse(fx, fy, fh * 0.34, fh * 0.78, 0, 0, Math.PI * 2);
        ctx.fill();
        if (Math.random() < 0.045 && this.particles.count < this.particles.max - 10) {
          this.particles.spawn({
            x: tc.x, z: tc.z, h: WALL_H * 0.8, vx: (Math.random() - 0.5) * 0.2, vz: 0, vh: 0.45,
            life: 0.9, size: 0.045, sizeEnd: 0.004, hue, sat: 100, light: 72,
            kind: P_DOT, gravity: -0.25, drag: 0.3,
          });
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  },

  _drawGroundEffects(ctx, cam, world) {
    const ge = world && world.groundEffects;
    if (!Array.isArray(ge) || !ge.length) return;
    const u = cam.scale;
    const p = this.scratch;
    const SP = this._sprites;
    for (const e of ge) {
      if (!e || !Number.isFinite(e.x)) continue;
      cam.worldToScreen(e.x, e.z, 0, p);
      if (p.x < -200 || p.x > this.w + 200 || p.y < -200 || p.y > this.h + 200) continue;
      // 字段别名：{r, remaining} → {radius, t, dur}
      const e2 = (e.radius === undefined || e.dur === undefined) ? normalizeGroundFx(e) : e;
      SP.drawGroundEffect(ctx, p.x, p.y, e2, u, this.time);
    }
  },

  /** 角色上方的覆盖层：玩家施法地面法阵 */
  _drawOverlays(ctx, cam, world) {
    if (!world) return;
    const p = this.scratch;
    const pl = world.player;
    if (pl && pl.anim && pl.anim.state === 'cast' && this.quality > 0) {
      cam.worldToScreen(pl.x, pl.z, 0, p);
      const k = pl.anim.dur ? clamp(pl.anim.t / pl.anim.dur, 0, 1) : 0.5;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.sin(k * Math.PI) * 0.7;
      ctx.strokeStyle = hsl(44, 100, 70);
      ctx.lineWidth = 2;
      const r = cam.scale * 0.8;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * cam.squash, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // 元素法师：环绕法球 / 元素狂潮光环（状态驱动，不依赖事件）
    if (typeof this._drawMageOverlay === 'function') this._drawMageOverlay(ctx, cam, world);
  },

  _drawFloatingText(ctx, cam) {
    const p = this.scratch;
    const n = this.text.activeCount;
    if (!n) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const scaleK = 0.7 + this.cam.scale / 40;
    this.text.forEach((ft) => {
      cam.worldToScreen(ft.x, ft.z, ft.h, p);
      if (p.x < -60 || p.x > this.w + 60 || p.y < -60 || p.y > this.h + 60) return;
      const st = ft.style;
      const size = Math.max(9, ft.size * scaleK);
      const x = p.x + ft.slip;
      const y = p.y;
      ctx.globalAlpha = Math.max(0, Math.min(1, ft.alpha));
      const col = ft.color || hsl(st.hue, st.sat, st.light);
      // 描边（暗底保证在深色场景中可读）
      ctx.font = `${st.weight} ${size.toFixed(1)}px "Rajdhani","Segoe UI",system-ui,sans-serif`;
      ctx.lineWidth = Math.max(2, size * 0.18);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(ft.text, x, y);
      if (ft.crit) {
        // 暴击：黄色发光 + 轻微双影
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = hsl(45, 100, 58);
        ctx.globalAlpha *= 0.7;
        ctx.fillText(ft.text, x, y);
        ctx.restore();
      }
      ctx.fillStyle = col;
      ctx.fillText(ft.text, x, y);
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  // ── 后处理 ─────────────────────────────────────────────────────────────────

  _postProcess(ctx, cam, world, dt) {
    const W = this.w, H = this.h;
    const bloomOn = this.quality > 0 && this.bloomCtx && this.bloomCanvas;
    if (bloomOn) {
      const bc = this.bloomCtx;
      const bw = this.bloomCanvas.width, bh = this.bloomCanvas.height;
      bc.setTransform(1, 0, 0, 1, 0, 0);
      bc.globalCompositeOperation = 'source-over';
      bc.clearRect(0, 0, bw, bh);
      // 缩小主画面 → 模糊 → 放大叠加 = 廉价 Bloom
      bc.imageSmoothingEnabled = true;
      bc.drawImage(this.canvas, 0, 0, this.canvas.width, this.canvas.height, 0, 0, bw, bh);
      bc.globalCompositeOperation = 'lighter';
      // 第二层更小的模糊（多次缩放模拟高斯）
      const tmp = this._tmpLayer(bw >> 1, bh >> 1);
      if (tmp) {
        tmp.ctx.setTransform(1, 0, 0, 1, 0, 0);
        tmp.ctx.clearRect(0, 0, tmp.c.width, tmp.c.height);
        tmp.ctx.drawImage(this.bloomCanvas, 0, 0, tmp.c.width, tmp.c.height);
        bc.globalAlpha = this.quality === 2 ? 0.85 : 0.6;
        bc.drawImage(tmp.c, 0, 0, tmp.c.width, tmp.c.height, 0, 0, bw, bh);
        bc.globalAlpha = 1;
      }
      // 放大叠加回主画面
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this.quality === 2 ? 0.6 : 0.42;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.bloomCanvas, 0, 0, bw, bh, 0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();
    }
    ctx.setTransform(this.quality === 0 ? 1 : this.dpr, 0, 0, this.quality === 0 ? 1 : this.dpr, 0, 0);

    // 色差（Chromatic aberration）：把画面左右错开一点点
    const chroma = this.fx.chroma + (this.fx.lowHp > 0 ? this.fx.lowHp * (0.35 + 0.35 * Math.sin(this.time * 3)) : 0);
    if (chroma > 0.02 && this.quality > 0 && this.postCtx) {
      const pc = this.postCtx;
      const pcv = this.postCanvas;
      pc.setTransform(1, 0, 0, 1, 0, 0);
      pc.globalCompositeOperation = 'source-over';
      pc.clearRect(0, 0, pcv.width, pcv.height);
      pc.drawImage(this.canvas, 0, 0);
      const off = Math.max(1, chroma * 7) * (this.quality === 0 ? 1 : this.dpr);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.5, chroma * 0.55);
      ctx.drawImage(pcv, 0, 0, pcv.width, pcv.height, off, 0, pcv.width, pcv.height);
      ctx.globalAlpha *= 0.7;
      ctx.drawImage(pcv, 0, 0, pcv.width, pcv.height, -off * 0.9, 0, pcv.width, pcv.height);
      ctx.restore();
    }

    // 闪光层 / 受击红晕
    ctx.save();
    this.fx.forEachFlash((f, alpha) => {
      if (alpha <= 0.002) return;
      ctx.globalCompositeOperation = 'lighter';
      if (f.kind === 'hurt') {
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.72);
        g.addColorStop(0, hsl(f.hue, f.sat, f.light, 0));
        g.addColorStop(1, hsl(f.hue, f.sat, f.light, alpha));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = hsl(f.hue, f.sat, f.light, Math.min(0.55, alpha * 0.6));
      }
      ctx.fillRect(0, 0, W, H);
    });
    // 玩家受伤：屏幕边缘红色脉冲
    if (this.enemyFlash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(180,20,20,${Math.min(0.55, this.enemyFlash * 0.55)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    // 低血：呼吸红边
    const low = this.fx.lowHp;
    if (low > 0.01) {
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 4.2);
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.22, W / 2, H / 2, Math.max(W, H) * 0.68);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.65, `rgba(120,0,0,${0.12 * low * pulse})`);
      g.addColorStop(1, `rgba(220,20,20,${0.42 * low * pulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    // 全局色调（血怒等）
    if (this.fx.tint && this.fx.tint.left > 0) {
      const tn = this.fx.tint;
      const k = Math.min(1, tn.left / Math.min(0.4, tn.dur)) * tn.strength;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hsl(tn.hue, tn.sat, tn.light, k * 0.6);
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();

    // 暗角 vignette：四周压暗
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(0.6, 'rgba(0,0,0,0.28)');
    vg.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // 扫描线（可选，低强度）
    this.scanlineAcc = (this.scanlineAcc || 0) + dt;
    if (this.quality === 2 && this.scanlineAcc > 1 / 30) {
      this.scanlineAcc = 0;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.055;
      ctx.fillStyle = '#000';
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
      ctx.restore();
    }

    // BOSS 出场：屏幕暗红渐晕
    if (this.bossPresent) {
      ctx.save();
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      const pulse = 0.05 + 0.03 * Math.sin(this.time * 1.8);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(90,0,0,${pulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    void cam;
    void world;
  },

  _tmpLayer(w, h) {
    if (typeof document === 'undefined') return null;
    if (!this._tmp) {
      const c = document.createElement('canvas');
      this._tmp = { c, ctx: c.getContext('2d') };
    }
    if (this._tmp.c.width !== w || this._tmp.c.height !== h) {
      this._tmp.c.width = Math.max(1, w);
      this._tmp.c.height = Math.max(1, h);
    }
    return this._tmp;
  },
};

export { parseColor, P_STAR };
