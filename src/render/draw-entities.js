// ─────────────────────────────────────────────────────────────────────────────
// draw-entities.js — 实体 / 特效层
//   · 按 z 排序绘制实体（脚底阴影 → 身体 → 武器弧光）
//   · 怪物血条、buff 图标、玩家光环
//   · 投射物、粒子、冲击波、裂纹、闪电、技能光环
// 全部方法 mixin 到 Renderer.prototype（见 renderer.js 末尾）；通过 this 访问状态。
// ─────────────────────────────────────────────────────────────────────────────
import { hsl, RARITY_COLOR } from './sprites.js';
import { P_DOT, P_LINE, P_QUAD, P_STAR, P_SPARK } from './particles.js';
import { clamp } from './project.js';
import { parseColor } from './sprites.js';
import { mulberry, zSort } from './shared.js';

const HAS = (o) => o !== undefined && o !== null;

// ── [契约 v1] 眩晕星星的数量（按画质档位：低/中/高）─────────────────────────
// 放在模块顶层而不是 renderer 里，是为了让"绘制"与"事件"共用同一份常量。
const STUN_STARS = [2, 3, 4];
/** 「踏地战甲」护甲 buff 的 id（与 core/skills.js 的 STOMP_ARMOR_BUFF_ID 一致） */
const WAR_STOMP_ARMOR_ID = 'warStompArmor';
/** 护甲辉光主色相（金色） */
const STOMP_ARMOR_HUE = 43;

/**
 * 估算实体的"身体高度"（世界单位，1 ≈ 一个 tile），用于把头顶特效贴在正确位置。
 * 玩家在 sprites.drawPlayer 里固定画 1.05 单位高；怪物 ≈ visual.size * 1.3；
 * Boss 的模板视觉尺寸约 2.1，这里再乘一个 1.25 让它"明显更高"。
 * 所有字段都可能缺失（HUD/测试桩数据），因此处处兜底 —— 绝不能返回 NaN。
 *
 * @param {object|null} e 实体
 * @param {number} [fallback] 兜底高度
 * @returns {number} 高度（世界单位，clamp 到 [0.6, 3.2]）
 */
function entityHeightOf(e, fallback = 1.2) {
  if (!e) return fallback;
  const v = e.visual;
  const size = v && Number.isFinite(v.size) ? v.size : 1;
  const bossK = e.isBoss || e.rarity === 'boss' ? 1.25 : 1;
  const h = Number.isFinite(e.height) ? e.height : size * 1.3 * bossK;
  return clamp(Number.isFinite(h) ? h : fallback, 0.6, 3.2);
}

/** 对外导出同一个实现（renderer 的事件层要用同样的高度贴粒子，避免两处漂移） */
export { entityHeightOf as entityHeight };

export const renderEntities = {
  // ── 地面层小物件：物品与魂火 ────────────────────────────────────────────────
  _drawItemsAndOrbs(ctx, cam, world) {
    if (!world) return;
    const SP = this._sprites;
    const u = cam.scale;
    const p = this.scratch;
    const hoverId = world.hoverItemId ?? world.hoveredItem ?? null;
    // 地面物品
    const items = world.items;
    if (Array.isArray(items)) {
      for (const gi of items) {
        if (!gi || !Number.isFinite(gi.x)) continue;
        cam.worldToScreen(gi.x, gi.z, 0, p);
        if (p.x < -80 || p.x > this.w + 80 || p.y < -120 || p.y > this.h + 80) continue;
        const it = gi.item || gi;
        const hovered = hoverId != null && (gi.id === hoverId || it.id === hoverId);
        SP.drawGroundItem(ctx, p.x, p.y, { rarity: it.rarity || gi.rarity, icon: it.icon || gi.icon || it.type }, u, this.time, hovered);
      }
    }
    // 魂火
    const orbs = world.lootOrbs;
    if (Array.isArray(orbs)) {
      for (const o of orbs) {
        if (!o || !Number.isFinite(o.x)) continue;
        cam.worldToScreen(o.x, o.z, 0.25 + Math.sin(this.time * 4 + o.x) * 0.05, p);
        if (p.x < -40 || p.x > this.w + 40 || p.y < -40 || p.y > this.h + 40) continue;
        SP.drawLootOrb(ctx, p.x, p.y, o, u, this.time);
      }
    }
  },

  /**
   * 庇护所交互物：仓库 / 商人 / 赌徒 / 战斗之门。
   * 地面光环 + 浮动图标 + 名称；战斗之门额外画旋转符文与光柱。
   * 数据来自 world.interactables（game/home.js），战斗地图为空数组。
   */
  _drawHomeInteractables(ctx, cam, world) {
    const list = world && world.interactables;
    if (!Array.isArray(list) || !list.length) return;
    const u = cam.scale;
    const p = this.scratch;
    const t = this.time;
    const player = world.player;

    // 庇护所地毯：一条横贯四个设施的暖色长毯（先画，设施光环压在上面）
    {
      let minX = Infinity, maxX = -Infinity, sumZ = 0, n = 0;
      for (const it of list) {
        if (!it || !Number.isFinite(it.x)) continue;
        minX = Math.min(minX, it.x);
        maxX = Math.max(maxX, it.x);
        sumZ += it.z;
        n++;
      }
      if (n > 0) {
        const z0 = sumZ / n - 2.2;
        const z1 = sumZ / n + 2.2;
        const a = cam.worldToScreen(minX - 2.2, z0, 0);
        const b = cam.worldToScreen(maxX + 2.2, z0, 0);
        const c = cam.worldToScreen(maxX + 2.2, z1, 0);
        const d = cam.worldToScreen(minX - 2.2, z1, 0);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(92, 34, 24, 0.32)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 207, 122, 0.30)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
    }

    for (const it of list) {
      if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.z)) continue;
      cam.worldToScreen(it.x, it.z, 0, p);
      if (p.x < -160 || p.x > this.w + 160 || p.y < -200 || p.y > this.h + 120) continue;
      const portal = it.kind === 'portal';
      const col = parseColor(it.color || '#ffcf7a');
      const rgba = (l, a) => `hsla(${col.h}, ${Math.min(100, col.s + 10)}%, ${l}%, ${a})`;
      const near = !!(player && Math.hypot(player.x - it.x, player.z - it.z) <= (it.range ?? 2.6));
      const pulse = 0.72 + Math.sin(t * 2.6 + it.z * 1.7) * 0.16 + (near ? 0.18 : 0);
      const R = u * (portal ? 1.9 : 0.95);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // 地面光环
      const grad = ctx.createRadialGradient(p.x, p.y, R * 0.08, p.x, p.y, R * 1.5);
      grad.addColorStop(0, rgba(78, 0.34 * pulse));
      grad.addColorStop(0.55, rgba(58, 0.18 * pulse));
      grad.addColorStop(1, rgba(45, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, R * 1.5, R * 1.5 * cam.squash, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = rgba(72, 0.85 * pulse);
      ctx.lineWidth = portal ? 3 : 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, R, R * cam.squash, 0, 0, Math.PI * 2);
      ctx.stroke();

      // 战斗之门：旋转符文 + 光柱
      if (portal) {
        ctx.strokeStyle = rgba(85, 0.7 * pulse);
        ctx.lineWidth = 1.6;
        for (let i = 0; i < 8; i++) {
          const a = t * 0.7 + (i / 8) * Math.PI * 2;
          const rx = Math.cos(a) * R * 1.22;
          const rz = Math.sin(a) * R * 1.22 * cam.squash;
          ctx.beginPath();
          ctx.arc(p.x + rx, p.y + rz, Math.max(1.2, u * 0.075), 0, Math.PI * 2);
          ctx.stroke();
        }
        const beamH = u * 3.2;
        const beam = ctx.createLinearGradient(p.x, p.y - beamH, p.x, p.y);
        beam.addColorStop(0, rgba(78, 0));
        beam.addColorStop(0.55, rgba(70, 0.14 * pulse));
        beam.addColorStop(1, rgba(62, 0.32 * pulse));
        ctx.fillStyle = beam;
        ctx.beginPath();
        ctx.moveTo(p.x - R * 0.72, p.y);
        ctx.lineTo(p.x - R * 0.4, p.y - beamH);
        ctx.lineTo(p.x + R * 0.4, p.y - beamH);
        ctx.lineTo(p.x + R * 0.72, p.y);
        ctx.closePath();
        ctx.fill();
      }

      // 设施本体：一个悬浮的符文图标
      const bob = Math.sin(t * 2.1 + it.x * 0.9) * u * 0.08;
      const iconY = p.y - u * (portal ? 1.55 : 1.2) + bob;
      const iconR = u * (portal ? 0.62 : 0.46);
      const halo = ctx.createRadialGradient(p.x, iconY, 0, p.x, iconY, iconR * 1.7);
      halo.addColorStop(0, rgba(90, 0.55));
      halo.addColorStop(1, rgba(60, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, iconY, iconR * 1.7, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = 'source-over';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.max(14, Math.round(iconR * 1.5))}px "Segoe UI Emoji","Apple Color Emoji",sans-serif`;
      ctx.globalAlpha = 0.95;
      ctx.fillText(it.icon || '◆', p.x, iconY);
      ctx.globalAlpha = 1;

      // 名称 + F 提示
      const labelY = p.y - u * (portal ? 2.45 : 2.0);
      ctx.font = `600 ${Math.max(10, Math.round(u * 0.24))}px "Rajdhani","Segoe UI",system-ui,sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      const label = `${it.name || it.kind || ''}${near ? '  [F]' : ''}`;
      ctx.strokeText(label, p.x, labelY);
      ctx.fillStyle = near ? rgba(88, 1) : rgba(74, 0.9);
      ctx.fillText(label, p.x, labelY);
      ctx.restore();
    }
  },

  /** 地面阴影：所有实体先统一画（这样 z 排序时阴影不会盖住别人） */
  _drawShadows(ctx, cam, world) {
    if (!world) return;
    const SP = this._sprites;
    const u = cam.scale;
    const p = this.scratch;
    const pl = world.player;
    if (pl && Number.isFinite(pl.x)) {
      cam.worldToScreen(pl.x, pl.z, 0, p);
      SP.drawShadow(ctx, p.x, p.y, (pl.radius ?? 0.35) * u * 1.05, 0.55);
    }
    const list = world.all || world.monsters;
    if (Array.isArray(list)) {
      for (const m of list) {
        if (!m || m.dead || !Number.isFinite(m.x)) continue;
        cam.worldToScreen(m.x, m.z, 0, p);
        if (p.x < -120 || p.x > this.w + 120 || p.y < -140 || p.y > this.h + 120) continue;
        const r = (m.radius ?? 0.35) * u;
        SP.drawShadow(ctx, p.x, p.y, r * (m.rarity === 'boss' ? 1.5 : 1.15), 0.5);
      }
    }
    // 图腾阴影
    if (Array.isArray(world.summoned)) {
      for (const s of world.summoned) {
        if (!s || !Number.isFinite(s.x)) continue;
        cam.worldToScreen(s.x, s.z, 0, p);
        SP.drawShadow(ctx, p.x, p.y, (s.radius ?? 0.4) * u * 1.2, 0.45);
      }
    }
    // 投射物小阴影
    if (Array.isArray(world.projectiles)) {
      for (const pr of world.projectiles) {
        if (!pr || !Number.isFinite(pr.x)) continue;
        cam.worldToScreen(pr.x, pr.z, 0, p);
        SP.drawProjectileShadow(ctx, p.x, p.y, u);
      }
    }
  },

  /** 按 z 排序绘制实体：玩家 / 怪物 / 图腾 / 残影 */
  _drawEntities(ctx, cam, world) {
    if (!world) return;
    const SP = this._sprites;
    const buf = this.zBuffer;
    buf.length = 0;
    const pl = world.player;
    if (pl && Number.isFinite(pl.x)) buf.push({ z: pl.z, id: -1e9, ent: pl, kind: 0 });
    const list = world.all || world.monsters;
    if (Array.isArray(list)) {
      for (const m of list) {
        if (!m || !Number.isFinite(m.x)) continue;
        buf.push({ z: m.z, id: m.id ?? 0, ent: m, kind: 1 });
      }
    }
    if (Array.isArray(world.summoned)) {
      for (const s of world.summoned) {
        if (!s || !Number.isFinite(s.x)) continue;
        buf.push({ z: s.z, id: s.id ?? 0, ent: s, kind: 2 });
      }
    }
    // 残影（并入排序，保证遮挡正确）
    for (const g of this.effects.ghosts) {
      if (!g.active) continue;
      buf.push({ z: g.z, id: 0, ent: g, kind: 3 });
    }
    buf.sort(zSort);
    const u = cam.scale;
    const p = this.scratch;
    let drawn = 0;
    const margin = 140;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b.kind === 3) {
        // 冲刺残影：玩家形态的发光淡影
        const g = b.ent;
        cam.worldToScreen(g.x, g.z, 0, p);
        if (p.x < -margin || p.x > this.w + margin || p.y < -margin || p.y > this.h + margin) continue;
        const life = Math.max(0, 1 - g.t / g.dur);
        const base = this.lastPlayer;
        ctx.save();
        ctx.globalAlpha = g.alpha * life;
        ctx.globalCompositeOperation = 'lighter';
        const ghost = this._ghostView || (this._ghostView = {});
        for (const k of Object.keys(base || {})) ghost[k] = base[k];
        ghost.x = g.x; ghost.z = g.z; ghost.facing = g.facing;
        ghost.vx = 0; ghost.vz = 0; ghost.hitFlash = 0; ghost.attackAnim = 0;
        if (!base) ghost.look = null;
        SP.drawPlayer(ctx, p.x, p.y, ghost, u, this.time, { ghost: true, attackAnim: 0, moving: true });
        ctx.restore();
        continue;
      }
      const e = b.ent;
      // [Lead 修复] 单实体隔离：单个实体绘制抛异常时只跳过它，不能让整帧（所有人和怪）都不画
      try {
      cam.worldToScreen(e.x, e.z, 0, p);
      if (p.x < -margin || p.x > this.w + margin || p.y < -margin * 1.5 || p.y > this.h + margin) continue;
      drawn++;
      if (b.kind === 0) {
        SP.drawPlayer(ctx, p.x, p.y, e, u, this.time, {
          attackAnim: e.attackAnim || 0,
          moving: Math.hypot(e.vx || 0, e.vz || 0) > 0.2,
          walkPhase: this.time * 10 + (e.x + e.z) * 2,
          hitFlash: e.hitFlash || 0,
          whirlwind: this.whirl.active,
        });
        if (Array.isArray(e.buffs) && e.buffs.length) this._drawBuffIcons(ctx, p.x, p.y, e, u);
        if (e.aura) this._drawPlayerAura(ctx, p.x, p.y, e, u);
        // [契约 v1] 踏地战甲：玩家身上的金色护甲辉光（buff 剩余时间驱动）
        this._drawStompArmor(ctx, p.x, p.y, e, u);
      } else if (b.kind === 1) {
        this._drawMonsterEntity(ctx, p.x, p.y, e, u);
        // 法师锁定 / 自动目标：脚下画一个细环（锁定=金，自动=蓝）
        if (pl && pl.type === 'mage' && pl.mage && (pl.mage.lockId === e.id || pl.mage.targetId === e.id)) {
          this._drawMageTargetRing(ctx, p.x, p.y, e, u, pl.mage.lockId === e.id);
        }
        // 法师元素印记：头顶的彩色小菱形（火橙 / 冰蓝 / 雷黄）
        this._drawMageMarks(ctx, p.x, p.y, e, u);
      } else if (b.kind === 2) {
        if (e.kind === 'totem' || e.kind === undefined) SP.drawTotem(ctx, p.x, p.y, e, u, this.time);
      }
      // [契约 v1] 眩晕标记：玩家/怪/Boss 都可能在头顶转星星（stunTime 驱动，无需事件）
      if (!e.dead) this._drawStunMark(ctx, p.x, p.y, e, u);
      } catch (err) {
        // 单实体异常：只跳过这一只，并保证画布状态被恢复（否则后续实体也会被带坏）
        this.stats.skippedEntities = (this.stats.skippedEntities || 0) + 1;
        if (!this._entityWarned) {
          this._entityWarned = true;
          if (typeof console !== 'undefined' && console.warn) console.warn('[Renderer] 单个实体绘制异常（已跳过）:', (err && err.message) || err);
        }
        try { ctx.restore(); } catch (_) { /* ignore */ }
        try { ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; } catch (_) { /* ignore */ }
      }
    }
    this.stats.drawnEntities = drawn;
  },

  /**
   * 法师目标环：锁定的目标用金色，自动选中的目标用冰蓝色。
   * 只画一个椭圆描边，不进 bloom 的强光层，避免整圈发白。
   */
  _drawMageTargetRing(ctx, x, y, e, u, locked) {
    const r = Math.max(0.34, (e.radius || 0.45) * 1.5) * u;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = locked ? 0.9 : 0.55;
    ctx.strokeStyle = locked ? '#ffd166' : '#9ad8ff';
    ctx.lineWidth = Math.max(1.2, u * 0.035);
    ctx.beginPath();
    ctx.ellipse(x, y + u * 0.04, r, r * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (locked) {
      // 四个小刻度，强调这是玩家手动锁定的目标
      ctx.lineWidth = Math.max(1, u * 0.025);
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI / 2) * i + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r * 0.82, y + u * 0.04 + Math.sin(a) * r * 0.34);
        ctx.lineTo(x + Math.cos(a) * r * 1.08, y + u * 0.04 + Math.sin(a) * r * 0.45);
        ctx.stroke();
      }
    }
    ctx.restore();
  },

  /**
   * 法师元素印记：在怪物头顶画出已叠层数（每种元素最多显示 5 颗）。
   * 印记是法师做反应/强化的核心信息，画出来才能"看得懂自己在打什么"。
   */
  _drawMageMarks(ctx, x, y, e, u) {
    const marks = e && e.mageMarks;
    if (!marks) return;
    const fire = Math.max(0, Math.floor(marks.fire || 0));
    const cold = Math.max(0, Math.floor(marks.cold || 0));
    const lightning = Math.max(0, Math.floor(marks.lightning || 0));
    const total = Math.min(5, fire) + Math.min(5, cold) + Math.min(5, lightning);
    if (!total) return;
    const h = entityHeightOf(e);
    const size = clamp(h * 0.055 * u, 2.4, 6.5);
    const gap = size * 2.5;
    const cy = y - h * u - Math.max(5, size * 2.2);
    const startX = x - ((total - 1) * gap) / 2;
    const groups = [
      { n: Math.min(5, fire), hue: 24 },
      { n: Math.min(5, cold), hue: 195 },
      { n: Math.min(5, lightning), hue: 55 },
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    let i = 0;
    for (const g of groups) {
      for (let k = 0; k < g.n; k++) {
        const px = startX + i * gap;
        const py = cy;
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = hsl(g.hue, 100, 68);
        ctx.beginPath();
        ctx.moveTo(px, py - size);
        ctx.lineTo(px + size * 0.8, py);
        ctx.lineTo(px, py + size);
        ctx.lineTo(px - size * 0.8, py);
        ctx.closePath();
        ctx.fill();
        // 高光核心：小一号的亮色点，让印记在 bloom 下仍然是一颗颗而不是糊成条
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = hsl(g.hue, 100, 90);
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.8, size * 0.28), 0, Math.PI * 2);
        ctx.fill();
        i++;
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  _drawMonsterEntity(ctx, x, y, m, u) {
    const SP = this._sprites;
    const deathT = m.deathT || 0;
    ctx.save();
    if (m.dead) {
      // 死亡：下沉 + 淡出 + 纵向压扁
      const k = clamp(deathT, 0, 1);
      if (k >= 1) { ctx.restore(); return; }
      ctx.globalAlpha = 1 - k;
      ctx.translate(x, y);
      ctx.scale(1 + k * 0.25, 1 - k * 0.55);
      ctx.translate(-x, -y);
    }
    const flash = m.hitFlash || 0;
    SP.drawMonster(ctx, x, y, m, u, this.time, {
      hitFlash: flash,
      scale: 1 + flash * 0.06,
      deathT,
    });
    // 受击闪白（在身体上叠一层亮白剪影感）
    if (flash > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.55, flash * 0.6);
      const vs = (m.visual && m.visual.size) || 1;
      const r = Math.max(6, (m.radius ?? 0.35) * u * Math.max(0.9, vs));
      const g = ctx.createRadialGradient(x, y - r * 1.2, 0, x, y - r * 1.2, r * 1.8);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y - r * 1.2, r * 1.5, r * 2.0, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    this._drawMonsterHp(ctx, x, y, m, u);
    ctx.restore();
  },

  _drawMonsterHp(ctx, x, y, m, u) {
    if (!m || !(m.maxHp > 0)) return;
    const ratio = clamp(m.hp / m.maxHp, 0, 1);
    const rarity = m.rarity || 'normal';
    const boss = rarity === 'boss' || m.isBoss;
    const always = boss || rarity === 'rare' || m.elite || m.isBoss;
    // 满血普通怪不显示血条（POE 习惯）；受伤后显示
    const show = always || ratio < 0.999;
    if (!show) return;
    const v = m.visual || {};
    const bodyScale = (v.size ?? 1) * (boss ? 2.0 : m.elite || rarity === 'rare' ? 1.12 : 0.95);
    const w = boss ? Math.max(80, u * 2.6) : Math.max(26, u * bodyScale * 0.95);
    const h = boss ? 6 : Math.max(3.4, u * 0.1);
    const bx = Math.round(x - w / 2);
    const by = Math.round(y - (boss ? 2.1 : 1.3) * u * bodyScale / (bodyScale > 1.5 ? 1.4 : 1));
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
    ctx.fillStyle = boss ? '#4a0d0d' : 'rgba(42,10,10,0.9)';
    ctx.fillRect(bx, by, w, h);
    const col = ratio > 0.55 ? '#c8321e' : ratio > 0.25 ? '#d8651c' : '#e8c14a';
    ctx.fillStyle = col;
    ctx.fillRect(bx, by, Math.max(0, w * ratio), h);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(bx, by, Math.max(0, w * ratio), Math.max(1, h * 0.42));
    if (rarity !== 'normal') {
      const rc = RARITY_COLOR[rarity];
      if (rc) {
        ctx.strokeStyle = hsl(rc.h, rc.s, rc.l, 0.8);
        ctx.lineWidth = 1;
        ctx.strokeRect(bx - 1.5, by - 1.5, w + 3, h + 3);
      }
    }
    // 精英/Boss 名字
    if ((boss || m.elite) && m.displayName) {
      ctx.font = `bold ${boss ? 12 : 10}px "Rajdhani",system-ui,sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillText(m.displayName, x + 1, by - 4);
      ctx.fillStyle = boss ? '#ffd9a0' : '#ffcf6a';
      ctx.fillText(m.displayName, x, by - 5);
    }
    ctx.restore();
  },

  _drawBuffIcons(ctx, x, y, e, u) {
    const buffs = e.buffs;
    let i = 0;
    for (const b of buffs) {
      if (i >= 6) break;
      const name = typeof b === 'string' ? b : (b && (b.id || b.name || b.key)) || '';
      const hue = /rage|frenzy|血怒|狂暴/i.test(name) ? 352 : /slow|chill|冰/i.test(name) ? 195 : /poison|毒/i.test(name) ? 110 : /burn|火/i.test(name) ? 24 : 210;
      const bx = x - 14 + i * 12;
      const by = y - u * 1.62;
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.arc(bx, by, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hsl(hue, 90, 60);
      ctx.beginPath();
      ctx.arc(bx, by, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      i++;
    }
  },

  /** 玩家光环（world.player.aura：字符串或 {color,radius}） */
  _drawPlayerAura(ctx, x, y, e, u) {
    if (this.quality <= 0) return;
    const aura = e.aura;
    const hue = typeof aura === 'object' ? parseColor(aura.color || 44).h : 44;
    const rr = u * (typeof aura === 'object' && aura.radius ? aura.radius : 1.4);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, hsl(hue, 100, 60, 0.1));
    g.addColorStop(0.8, hsl(hue, 100, 60, 0.18));
    g.addColorStop(1, hsl(hue, 100, 60, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, rr, rr * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },

  /**
   * 元素法师的持续视觉层：
   *   · 环绕法球：按天赋 mageOrbs 数量，火 / 冰 / 雷三色小球绕玩家旋转；
   *   · 元素狂潮：脚下三色旋转光斑 + 呼吸光晕（状态驱动，事件结束后自动消失）。
   * 全部是实心光斑（径向渐变 / 小圆），不使用整圈细描边，避免 bloom 糊成白环。
   */
  _drawMageOverlay(ctx, cam, world) {
    const pl = world && world.player;
    if (!pl || pl.type !== 'mage' || pl.dead) return;
    if (this.quality <= 0) return;
    const m = pl.mage || {};
    const t = this.time;
    const u = cam.scale;
    const p = this.scratch;
    const mods = pl.talentStats || {};
    const orbN = clamp(Math.floor(Number(mods.mageOrbs) || 0), 0, 3);
    const ult = Number.isFinite(m.ultTimer) ? m.ultTimer : 0;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 元素狂潮：地面三色光斑旋转 + 中心呼吸光
    if (ult > 0) {
      const pulse = 0.72 + 0.28 * Math.sin(t * 6.5);
      cam.worldToScreen(pl.x, pl.z, 0, p);
      const rr = u * 2.0;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
      g.addColorStop(0, `rgba(176,108,240,${0.12 * pulse})`);
      g.addColorStop(0.55, `rgba(176,108,240,${0.08 * pulse})`);
      g.addColorStop(1, 'rgba(176,108,240,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rr, rr * cam.squash, 0, 0, Math.PI * 2);
      ctx.fill();
      const tri = [24, 195, 55];
      for (let i = 0; i < 3; i++) {
        const a = t * 3.2 + (i / 3) * Math.PI * 2;
        const wx = pl.x + Math.cos(a) * 1.5;
        const wz = pl.z + Math.sin(a) * 1.5;
        cam.worldToScreen(wx, wz, 0.05, p);
        const cr = u * 0.34;
        const gg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, cr);
        gg.addColorStop(0, hsl(tri[i], 100, 72, 0.6));
        gg.addColorStop(0.5, hsl(tri[i], 100, 62, 0.22));
        gg.addColorStop(1, hsl(tri[i], 100, 60, 0));
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, cr, cr * cam.squash, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 环绕法球
    if (orbN > 0) {
      const hues = [24, 195, 55];
      for (let i = 0; i < orbN; i++) {
        const a = t * 1.7 + (i / orbN) * Math.PI * 2;
        const wx = pl.x + Math.cos(a) * 1.05;
        const wz = pl.z + Math.sin(a) * 1.05;
        const wh = 1.02 + Math.sin(t * 3.4 + i * 2.1) * 0.1;
        cam.worldToScreen(wx, wz, wh, p);
        const hue = hues[i % hues.length];
        const core = Math.max(1.6, u * 0.075);
        const glowR = core * 3.6;
        const gg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
        gg.addColorStop(0, hsl(hue, 100, 88, 0.95));
        gg.addColorStop(0.28, hsl(hue, 100, 68, 0.7));
        gg.addColorStop(1, hsl(hue, 100, 60, 0));
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hsl(hue, 100, 92, 0.95);
        ctx.beginPath();
        ctx.arc(p.x, p.y, core, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  // ── [契约 v1] 眩晕标记 ──────────────────────────────────────────────────────
  /**
   * 被眩晕实体头顶的旋转星环。
   *
   * 数据来源：实体上的 `stunTime`（剩余秒）/ `stunMax`（本次控制的总时长）。
   * 完全由**状态**驱动而不是事件驱动 —— 这样即使渲染层错过了 'stun' 事件
   * （事件被 Lead 清理、切图、存档读档），星星也会随 stunTime 正确出现/消失。
   *
   * 绘制要点（踩过的坑）：
   *   · 每一颗星都是**实心小多角星**（fill），没有任何整圈描边；
   *   · 星星绕头顶椭圆轨道旋转（用 sin 做前后层次：后面的暗、前面的亮，产生"绕过脑袋"的纵深感）；
   *   · 淡出跟随 stunTime/stunMax（剩余越少越淡越小），结束瞬间由 'stunEnd' 撒碎星收尾。
   *   · 尺寸随实体高度缩放（玩家 1.05 / 普通怪 ~1.2 / Boss ~2.7 世界单位）。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x @param {number} y 脚底屏幕坐标
   * @param {object} e 实体
   * @param {number} u 每世界单位的像素数
   */
  _drawStunMark(ctx, x, y, e, u) {
    const st = Number.isFinite(e && e.stunTime) ? e.stunTime : 0;
    if (!(st > 0.001)) return;
    if (this.quality <= 0 && st <= 0.15) return; // 低画质下只在最后收尾时跳过（前面照常显示状态）
    const max = Number.isFinite(e.stunMax) && e.stunMax > 0 ? e.stunMax : st;
    // k: 1 → 0（剩余比例）。前 15% 的时间内快速淡入，最后 30% 内淡出
    const remain = clamp(st / max, 0, 1);
    const fadeIn = clamp((max - st) / Math.min(0.12, max * 0.4), 0, 1);
    const alpha = clamp(remain / 0.3, 0, 1) * (0.35 + 0.65 * fadeIn);
    if (alpha <= 0.02) return;
    const h = entityHeightOf(e);
    const n = STUN_STARS[clamp(this.quality | 0, 0, 2)];
    const rx = Math.max(7, h * 0.2 * u);            // 轨道水平半径
    const ry = rx * 0.34;                            // 椭圆压缩（2.5D 俯视）
    const cx = x;
    const cy = y - h * u - Math.max(6, rx * 0.45);   // 头顶略上方
    // 转速：越快越"晕"（剩余越少转得越慢，像要醒过来）
    const spin = this.time * (5.2 + 2.4 * remain);
    const size = clamp(h * 0.075 * u, 3.2, 12);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const a = spin + (i / n) * Math.PI * 2;
      const px = cx + Math.cos(a) * rx;
      const py = cy + Math.sin(a) * ry;
      // sin(a) < 0 → 在脑袋后方（暗一点、小一点）
      const depth = (Math.sin(a) + 1) * 0.5; // 0 后 / 1 前
      const ss = size * (0.78 + depth * 0.42);
      const al = alpha * (0.5 + depth * 0.5);
      ctx.globalAlpha = al;
      ctx.fillStyle = hsl(50 - depth * 6, 100, 62 + depth * 16);
      this._starPath(ctx, px, py, ss, spin * 1.6 + i);
      ctx.fill();
      // 星芯：一颗更亮的小实心点（避免整颗星在 bloom 里发灰）
      ctx.globalAlpha = al * 0.9;
      ctx.fillStyle = hsl(54, 100, 88);
      ctx.beginPath();
      ctx.arc(px, py, Math.max(0.9, ss * 0.26), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  /** 实心四角星路径（4 长角 + 4 短角，绕 (x,y) 旋转 rot） */
  _starPath(ctx, x, y, r, rot) {
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const rr = k % 2 === 0 ? r : r * 0.36;
      const a = rot + (k * Math.PI) / 4;
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr * 0.82;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  },

  // ── [契约 v1] 踏地战甲护甲辉光 ──────────────────────────────────────────────
  /**
   * 玩家身上「踏地战甲」buff 的金色装甲辉光。
   *
   * 设计（**不是**整圈细描边环 —— 那样 bloom 会连成白圈把角色糊掉）：
   *   · 躯干位置一块**实心半透明琥珀色板甲面片**（梯形/弧肩剪影），透明度、大小随护甲值增长；
   *   · 外层一圈**柔和的径向光晕**（实心圆斑，越靠外越透明）烘托"镀了一层金"；
   *   · 剩余时间最后 35% 开始整体淡出，并在边缘做轻微呼吸（用迭代次数做"金属反光"而不是描边）。
   *
   * 亮度/厚度与 buff.stats.armor 挂钩：armor 18（空放保底）→ 最薄最暗，armor ≥ 60 → 拉满。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x @param {number} y 脚底屏幕坐标
   * @param {object} player 玩家实体（读 buffs）
   * @param {number} u 每世界单位的像素数
   */
  _drawStompArmor(ctx, x, y, player, u) {
    const buffs = player && player.buffs;
    if (!Array.isArray(buffs) || !buffs.length) return;
    let b = null;
    for (let i = 0; i < buffs.length; i++) {
      const o = buffs[i];
      if (o && typeof o === 'object' && o.id === WAR_STOMP_ARMOR_ID) { b = o; break; }
    }
    if (!b) return;
    const dur = Number.isFinite(b.dur) && b.dur > 0 ? b.dur : 4;
    const left = Number.isFinite(b.remaining) ? clamp(b.remaining, 0, dur) : dur;
    const remain = clamp(left / dur, 0, 1);
    const armor = b.stats && Number.isFinite(b.stats.armor) ? b.stats.armor : 18;
    // 护甲 → 0..1：18 是空放保底，60 是 8 只怪命中的量级（契约 18 + 5*hits）
    const k = clamp((armor - 14) / 46, 0, 1);
    const fade = clamp(remain / 0.35, 0, 1);           // 最后 35% 淡出
    const breath = 0.86 + 0.14 * Math.sin(this.time * 3.4); // 金属呼吸
    const alpha = (0.16 + 0.2 * k) * fade * breath;
    if (alpha <= 0.01) return;
    const h = 1.05 * u;                                // 玩家身高 ≈ 1.05 世界单位（sprites.drawPlayer）
    const bobY = y - h * 0.5;                          // 躯干中心
    const halfW = (0.2 + 0.06 * k) * u;                // 板甲半宽
    const top = y - h * (0.9 + 0.06 * k);              // 肩部上缘
    const bot = y - h * 0.16;                          // 下缘

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 1) 外层柔和光晕（实心径向渐变圆斑，不是环）
    const glowR = (0.7 + 0.28 * k) * u;
    const g = ctx.createRadialGradient(x, bobY, 0, x, bobY, glowR);
    g.addColorStop(0, hsl(STOMP_ARMOR_HUE, 96, 58, alpha * 0.55));
    g.addColorStop(0.55, hsl(STOMP_ARMOR_HUE - 6, 96, 50, alpha * 0.32));
    g.addColorStop(1, hsl(STOMP_ARMOR_HUE - 10, 90, 46, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, bobY, glowR, glowR * 1.1, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2) 板甲面片（肩甲 + 胸甲剪影，实心渐变填充，无描边）
    const plate = ctx.createLinearGradient(0, top, 0, bot);
    plate.addColorStop(0, hsl(STOMP_ARMOR_HUE + 6, 100, 74, alpha));
    plate.addColorStop(0.5, hsl(STOMP_ARMOR_HUE, 95, 56, alpha * 0.92));
    plate.addColorStop(1, hsl(STOMP_ARMOR_HUE - 8, 88, 40, alpha * 0.35));
    ctx.globalAlpha = 1;
    ctx.fillStyle = plate;
    ctx.beginPath();
    // 左肩 → 胸口 → 右肩 → 上缘弧（用 quadratic 描出肩甲的圆肩）
    ctx.moveTo(x - halfW * 1.34, bobY - h * 0.1);
    ctx.quadraticCurveTo(x - halfW * 1.5, top + h * 0.02, x - halfW * 0.78, top);
    ctx.quadraticCurveTo(x, top - h * 0.06, x + halfW * 0.78, top);
    ctx.quadraticCurveTo(x + halfW * 1.5, top + h * 0.02, x + halfW * 1.34, bobY - h * 0.1);
    ctx.quadraticCurveTo(x + halfW * 0.96, bot, x, bot + h * 0.04);
    ctx.quadraticCurveTo(x - halfW * 0.96, bot, x - halfW * 1.34, bobY - h * 0.1);
    ctx.closePath();
    ctx.fill();

    // 3) 胸口高光块：护甲越高越多层（"叠甲"的观感），全部是实心小面片
    const bars = 1 + Math.round(k * 2);
    for (let i = 0; i < bars; i++) {
      const yy = bobY - h * (0.2 - i * 0.13);
      const ww = halfW * (1.05 - i * 0.22);
      ctx.globalAlpha = alpha * (0.55 - i * 0.12);
      ctx.fillStyle = hsl(STOMP_ARMOR_HUE + 10, 100, 78);
      ctx.beginPath();
      ctx.ellipse(x, yy, ww, Math.max(1.2, h * 0.035), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  /** 投射物：先全部画本体，再单独补拖尾（不在绘制途中 spawn，保持数据一致） */
  _drawProjectiles(ctx, cam, world) {
    const SP = this._sprites;
    const list = world && world.projectiles;
    if (!Array.isArray(list) || !list.length) return;
    const u = cam.scale;
    const p = this.scratch;
    for (const pr of list) {
      if (!pr || !Number.isFinite(pr.x)) continue;
      cam.worldToScreen(pr.x, pr.z, 0.5, p);
      if (p.x < -100 || p.x > this.w + 100 || p.y < -100 || p.y > this.h + 100) continue;
      SP.drawProjectile(ctx, p.x, p.y, pr, u, this.time);
    }
    if (this.quality <= 0) return;
    for (const pr of list) {
      if (!pr || !Number.isFinite(pr.x)) continue;
      if (this.particles.count >= this.particles.max - 20) break;
      const c = parseColor(pr.color || 30);
      const isBolt = pr.kind === 'bolt';
      this.particles.spawnTrail(pr.x - (pr.vx || 0) * 0.03, pr.z - (pr.vz || 0) * 0.03, pr.x, pr.z, {
        count: 1, hue: c.h, light: 70, size: isBolt ? 0.06 : 0.07, life: 0.22,
        kind: isBolt ? P_LINE : P_DOT,
      });
    }
  },

  _drawParticles(ctx, cam) {
    const ps = this.particles;
    const n = ps.size;
    if (!n) return;
    const u = cam.scale;
    const p = this.scratch;
    let additive = true;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      // 视口剔除（世界坐标 → 屏幕）
      const x = ps.x[i], z = ps.z[i], h = ps.h[i];
      const lifeK = ps.life[i] / (ps.maxLife[i] || 1); // 1 → 0
      const add = ps.additive[i] > 0.5;
      if (add !== additive) {
        ctx.globalCompositeOperation = add ? 'lighter' : 'source-over';
        additive = add;
      }
      cam.worldToScreen(x, z, h, p);
      if (p.x < -40 || p.x > this.w + 40 || p.y < -40 || p.y > this.h + 40) continue;
      const size = (ps.sizeEnd[i] + (ps.psize[i] - ps.sizeEnd[i]) * lifeK) * u;
      if (size <= 0.05) continue;
      const tK = 1 - lifeK;
      const a = (ps.alpha[i] || 1) * Math.min(1, lifeK * 1.6) * (tK < 0.15 ? tK / 0.15 : 1);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      const col = hsl(ps.hue[i], ps.sat[i], ps.light[i]);
      const kind = ps.kind[i];
      if (kind === P_SPARK || kind === P_LINE) {
        // 火花：沿速度方向画短线
        const vx = ps.vx[i], vz = ps.vz[i] * cam.squash;
        const sp = Math.hypot(vx, vz);
        const len = Math.min(size * 4, sp * u * 0.05 + size);
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(0.7, size * 0.7);
        ctx.lineCap = 'round';
        if (sp > 0.01) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - (vx / sp) * len, p.y - (vz / sp) * len);
          ctx.stroke();
        } else {
          ctx.fillStyle = col;
          ctx.fillRect(p.x - size * 0.3, p.y - size * 0.3, size * 0.6, size * 0.6);
        }
      } else if (kind === P_STAR) {
        ctx.fillStyle = col;
        const r = size * 1.7;
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const ang = ps.rot[i] + (k * Math.PI) / 2;
          const ex = p.x + Math.cos(ang) * r, ey = p.y + Math.sin(ang) * r * 0.75;
          const ang2 = ang + Math.PI / 4;
          const mx = p.x + Math.cos(ang2) * r * 0.28, my = p.y + Math.sin(ang2) * r * 0.28 * 0.75;
          if (k === 0) ctx.moveTo(ex, ey); else ctx.lineTo(ex, ey);
          ctx.lineTo(mx, my);
        }
        ctx.closePath();
        ctx.fill();
      } else if (kind === P_QUAD) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(ps.rot[i]);
        ctx.fillStyle = col;
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.restore();
      } else {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.4, size), 0, Math.PI * 2);
        ctx.fill();
        if (size > 2.2) {
          ctx.globalAlpha = a * 0.22;
          ctx.beginPath();
          ctx.arc(p.x, p.y, size * 2.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  /** 冲击波 / 环 / 裂纹 / 闪电 / 技能光环 —— 属于地面层特效，在实体之后叠加 */
  _drawShockwaves(ctx, cam) {
    const u = cam.scale;
    const p = this.scratch;
    ctx.save();
    for (const s of this.shockwaves) {
      if (!s.active) continue;
      cam.worldToScreen(s.x, s.z, 0, p);
      if (p.x < -300 || p.x > this.w + 300 || p.y < -300 || p.y > this.h + 300) continue;
      const k = s.t / s.dur;
      const r = s.r1 * u * (1 - Math.pow(1 - k, 2.2));
      const a = (1 - k) * 0.9;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a;
      ctx.strokeStyle = hsl(s.hue, s.sat, s.light + 20);
      ctx.lineWidth = Math.max(0.8, s.width * (1 - k));
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * cam.squash, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (s.kind === 'ground' || s.kind === 'wave') {
        ctx.globalAlpha = a * 0.35;
        ctx.lineWidth = Math.max(1, s.width * 2.2 * (1 - k));
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r * 0.82, r * 0.82 * cam.squash, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // [契约 v1] 实心扩散圆盘（战争践踏 / 升星冲击波）。
    // 刻意不用 stroke：bloom 会把整圈细描边连成刺眼白环（README「旋风斩视觉」踩过的坑）。
    // 这里用「径向渐隐的实心圆斑 + 贴着前沿的宽亮带填充」，靠亮度分布表达"在扩散"，
    // 同时中间是半透明的，不会把站在上面的玩家/怪物糊掉。
    for (const d of this.effects.disks) {
      if (!d.active) continue;
      cam.worldToScreen(d.x, d.z, 0, p);
      const k = d.t / d.dur;                       // 0 → 1
      const grow = 1 - Math.pow(1 - k, 2.6);       // 先快后慢（冲击波的手感）
      const rad = d.r1 * u * (0.18 + 0.82 * grow);
      if (!(rad > 1)) continue;
      if (p.x < -rad - 20 || p.x > this.w + rad + 20 || p.y < -rad - 20 || p.y > this.h + rad + 20) continue;
      const fade = Math.pow(1 - k, 1.5);           // 尾段快速淡出
      const a = d.alpha * fade;
      if (a <= 0.005) continue;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      // 1) 内部实心：中心淡、边缘浓（core 控制"实心"程度）。
      //    [实测] 中心到 86% 处如果亮度拉得太高，几层圆盘叠在 bloom 下会把角色洗成白团；
      //    这里把 55%~86% 的亮度抬幅限制在 +8，靠"边缘更亮"而不是"整体更亮"来表达推进感。
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
      g.addColorStop(0, hsl(d.hue, d.sat, d.light, a * 0.2 * d.core));
      g.addColorStop(0.55, hsl(d.hue, d.sat, d.light, a * 0.5 * d.core));
      g.addColorStop(0.86, hsl(d.hue, d.sat, d.light + 8, a * (0.32 + d.core * 0.4)));
      g.addColorStop(1, hsl(d.hue, d.sat, d.light, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rad, rad * cam.squash, 0, 0, Math.PI * 2);
      ctx.fill();
      // 2) 前沿亮带：用"实心环带填充"（两段椭圆组成的面），不是描边线
      if (d.rim > 0.02) {
        const w = Math.max(2, rad * 0.2);
        const g2 = ctx.createRadialGradient(p.x, p.y, Math.max(0, rad - w * 2), p.x, p.y, rad);
        g2.addColorStop(0, hsl(d.hue + 4, d.sat, d.light, 0));
        g2.addColorStop(0.55, hsl(d.hue + 4, d.sat, d.light + 8, a * d.rim * 0.35));
        g2.addColorStop(1, hsl(d.hue + 6, d.sat, d.light + 14, a * d.rim * 0.5));
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rad, rad * cam.squash, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // EffectField 的环
    for (const r of this.effects.rings) {
      if (!r.active) continue;
      cam.worldToScreen(r.x, r.z, r.kind === 'slash' ? 0.7 : 0, p);
      const k = r.t / r.dur;
      const e = 1 - Math.pow(1 - k, 2.4);
      const rad = (r.r0 + (r.r1 - r.r0) * e) * u;
      if (Math.abs(rad) < 0.5) continue;
      ctx.globalCompositeOperation = 'lighter';
      const a = (1 - k) * 0.85;
      ctx.globalAlpha = Math.max(0, a);
      ctx.strokeStyle = hsl(r.hue, r.sat, r.light + 15);
      ctx.lineWidth = Math.max(0.6, r.width * (1 - k * 0.7));
      ctx.beginPath();
      if (r.kind === 'slash') {
        ctx.arc(p.x, p.y, Math.abs(rad), r.seed, r.seed + Math.PI * 1.5);
      } else {
        ctx.ellipse(p.x, p.y, Math.abs(rad), Math.abs(rad) * cam.squash, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
      if (r.kind === 'dust') {
        ctx.globalAlpha = a * 0.25;
        ctx.fillStyle = hsl(30, 20, 45);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, Math.abs(rad), Math.abs(rad) * cam.squash, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 裂纹（裂地斩）
    const q2 = this.scratch2;
    const o2 = this.scratch3;
    for (const c of this.effects.cracks) {
      if (!c.active) continue;
      cam.worldToScreen(c.x, c.z, 0, p);
      const k = c.t / c.dur;
      const grow = Math.min(1, c.t / 0.18);
      const a = (1 - k) * 0.95;
      const segs = c.segs;
      const nseg = Math.floor((segs.length / 4) * grow);
      if (!nseg) continue;
      // 1) 暗色刻痕
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = 'rgba(0,0,0,0.78)';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < nseg; i++) {
        cam.worldToScreen(c.x + segs[i * 4], c.z + segs[i * 4 + 1], 0, q2);
        cam.worldToScreen(c.x + segs[i * 4 + 2], c.z + segs[i * 4 + 3], 0, o2);
        ctx.moveTo(q2.x, q2.y);
        ctx.lineTo(o2.x, o2.y);
      }
      ctx.stroke();
      // 2) 裂缝里的熔岩光
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * 0.85;
      ctx.strokeStyle = hsl(26, 100, 60);
      ctx.lineWidth = 1.8 * (1 - k * 0.6);
      ctx.stroke();
      ctx.globalAlpha = a * 0.3;
      ctx.strokeStyle = hsl(36, 100, 75);
      ctx.lineWidth = 5.5 * (1 - k * 0.7);
      ctx.stroke();
    }
    // 闪电
    for (const b of this.effects.bolts) {
      if (!b.active) continue;
      this._drawBolt(ctx, cam, b);
    }
    // 技能光环（血怒等）
    for (const a of this.auras) {
      if (!a.active) continue;
      const pl = this.lastPlayer;
      if (!pl) continue;
      cam.worldToScreen(pl.x, pl.z, 0, p);
      const k = a.left / a.dur;
      const fade = Math.min(1, k * 4) * Math.min(1, (1 - k) * 6 + 0.4);
      if (a.kind !== 'bloodRage') continue;
      ctx.globalCompositeOperation = 'lighter';
      const rr = u * 1.15;
      // 呼吸红光
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr * 1.6);
      g.addColorStop(0, hsl(352, 100, 50, 0.16 * fade));
      g.addColorStop(1, hsl(352, 100, 50, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rr * 1.6, rr * 1.6 * cam.squash, 0, 0, Math.PI * 2);
      ctx.fill();
      // 内外旋转的血色符文环
      ctx.globalAlpha = 0.55 * fade;
      ctx.strokeStyle = hsl(352, 100, 55);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rr, rr * cam.squash, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.4 * fade;
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 6; i++) {
        const a0 = this.time * 2 + (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rr * 1.25, rr * 1.25 * cam.squash, 0, a0, a0 + 0.5);
        ctx.stroke();
      }
      // 内环反向
      ctx.globalAlpha = 0.3 * fade;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rr * 0.55, rr * 0.55 * cam.squash, 0, -this.time * 3, -this.time * 3 + Math.PI * 1.6);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  _drawBolt(ctx, cam, b) {
    const a0 = cam.worldToScreen(b.x0, b.z0, b.h, this.scratch);
    const x0 = a0.x, y0 = a0.y;
    const a1 = cam.worldToScreen(b.x1, b.z1, b.h, this.scratch2);
    const x1 = a1.x, y1 = a1.y;
    const k = b.t / b.dur;
    const segs = 7;
    const rnd = mulberry(b.seed + Math.floor(b.t * 60) * 7919);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (1 - k) * 0.95;
    // 三层：宽光晕 / 主体 / 白芯
    const passes = [
      { w: b.width * 5, l: 40, a: 0.18 },
      { w: b.width * 1.6, l: 62, a: 0.75 },
      { w: b.width * 0.6, l: 92, a: 1 },
    ];
    for (const pass of passes) {
      ctx.strokeStyle = hsl(b.hue, b.sat, pass.l, pass.a);
      ctx.lineWidth = pass.w;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (let i = 1; i < segs; i++) {
        const t = i / segs;
        const jitter = (rnd() - 0.5) * 34 * b.branch * (1 - Math.abs(t - 0.5) * 1.2);
        ctx.lineTo(x0 + (x1 - x0) * t + jitter, y0 + (y1 - y0) * t + (rnd() - 0.5) * 16 * b.branch);
      }
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
  },
};

export { HAS, P_QUAD, P_STAR, P_SPARK };