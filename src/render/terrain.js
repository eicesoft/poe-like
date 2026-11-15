// ─────────────────────────────────────────────────────────────────────────────
// terrain.js — 程序化地面与墙壁（Canvas2D，只在浏览器运行；用离屏 canvas 缓存）。
// 地面：确定性 hash 生成每格色调 / 裂缝 / 苔藓；墙：伪 3D 块（侧面暗 + 顶面亮）。
// 依赖 world.dungeon: { tiles, cols, rows, tileSize, isWall(cx,cz) }  0=地板 1=墙 2=门
// ─────────────────────────────────────────────────────────────────────────────
import { hash2 } from './project.js';

export const WALL_H = 1.15; // 墙的世界高度（与 camera.heightK 配合）

function tileAt(d, cx, cz) {
  if (!d) return 1;
  if (cx < 0 || cz < 0 || cx >= d.cols || cz >= d.rows) return 1;
  if (typeof d.isWall === 'function' && d.isWall(cx, cz) === true) return 1;
  const v = d.tiles ? d.tiles[cz * d.cols + cx] : 0;
  return v === undefined ? 0 : v;
}

export class Terrain {
  constructor() {
    this.cache = []; // {key, canvas, x0, z0, x1, z1, u, ts, tint}
    this.cacheLimit = 24;
    this.wallCache = null; // 墙面树缓存
    this.wallKey = '';
    this.dungeonRef = null;
    this.palette = {
      // 深色石板地面
      base: { h: 218, s: 14, l: 12 },
      light: { h: 36, s: 28, l: 18 },
    };
  }

  /** 地图换了 → 清缓存 */
  reset() {
    this.cache.length = 0;
    this.wallCache = null;
    this.wallKey = '';
    this.dungeonRef = null;
  }

  /**
   * 绘制整张地面（只绘制视口内的格子）。
   * @param ctx 主画布 ctx（已 devicePixelRatio 缩放）
   * @param d world.dungeon
   * @param cam Camera
   * @param t 时间
   * @param quality 0..2
   */
  drawGround(ctx, d, cam, t, quality = 2) {
    if (!d) {
      // 没有地牢数据：用暗色底 + 网格兜底
      this._drawFallbackGround(ctx, cam, quality);
      return;
    }
    if (this.dungeonRef !== d) {
      this.reset();
      this.dungeonRef = d;
    }
    const ts = d.tileSize || 1;
    const u = cam.scale;
    // 可见范围（按屏幕四角反投影）
    const c0 = cam.screenToWorld(0, 0);
    const c1 = cam.screenToWorld(cam.viewW, cam.viewH);
    // 墙有高度，近处的墙会被抬高：向下扩展一点
    const padZ = 3 + WALL_H * 1.6;
    const cx0 = Math.floor(Math.min(c0.x, c1.x) / ts) - 1;
    const cx1 = Math.ceil(Math.max(c0.x, c1.x) / ts) + 1;
    const cz0 = Math.floor(Math.min(c0.z, c1.z) / ts) - 2;
    const cz1 = Math.ceil(Math.max(c0.z, c1.z) / ts) + padZ;

    ctx.save();
    // 外部虚空
    const vg = ctx.createLinearGradient(0, 0, 0, cam.viewH);
    vg.addColorStop(0, '#05060a');
    vg.addColorStop(1, '#020205');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, cam.viewW, cam.viewH);

    const p = cam.worldToScreen(0, 0); // 先量出 (0,0) 屏幕位置
    const tileW = ts * u;
    const tileH = ts * u * cam.squash;

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const ty = tileAt(d, cx, cz);
        if (ty === 1) continue; // 墙在墙面通道绘制
        const sx = p.x + cx * tileW;
        const sy = p.y + cz * tileH;
        // 视口剔除
        if (sx > cam.viewW + tileW || sx + tileW < -tileW || sy > cam.viewH + tileH * 2 || sy + tileH < -tileH * 2) continue;
        this._drawFloorTile(ctx, sx, sy, tileW, tileH, cx, cz, ty === 2, t, quality);
      }
    }
    ctx.restore();
  }

  _drawFallbackGround(ctx, cam, quality) {
    const u = cam.scale;
    const p = cam.worldToScreen(0, 0);
    const step = 1;
    ctx.save();
    ctx.fillStyle = '#080a10';
    ctx.fillRect(0, 0, cam.viewW, cam.viewH);
    ctx.strokeStyle = 'rgba(120,140,180,0.06)';
    ctx.lineWidth = 1;
    const gx0 = Math.floor(-p.x / u) - 1, gx1 = Math.ceil((cam.viewW - p.x) / u) + 1;
    const gz0 = Math.floor(-p.y / (u * cam.squash)) - 1, gz1 = Math.ceil((cam.viewH - p.y) / (u * cam.squash)) + 1;
    for (let x = gx0; x < gx1; x += 2) {
      const sx = p.x + x * u;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, cam.viewH);
      ctx.stroke();
    }
    for (let z = gz0; z < gz1; z += 2) {
      const sy = p.y + z * u * cam.squash;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(cam.viewW, sy);
      ctx.stroke();
    }
    ctx.restore();
    void step; void quality;
  }

  /** 单格地砖：底色 + 砖缝 + 裂纹 + 苔藓 + 高光 */
  _drawFloorTile(ctx, sx, sy, w, h, cx, cz, isDoor, t, quality) {
    const hb = hash2(cx, cz);
    const hb2 = hash2(cx + 91, cz - 37);
    const hb3 = hash2(cx - 13, cz + 71);
    // 色调变化
    const isDoorTile = isDoor;
    // 地板亮度：POE 暗黑风格但保证实体可读（太黑会让怪物/玩家糊成一团）
    const lBase = isDoorTile ? 13 : 9 + hb * 3.5;
    const hue = isDoorTile ? 40 : 215 + (hb - 0.5) * 18;
    const sat = isDoorTile ? 18 : 10 + hb2 * 6;
    ctx.fillStyle = `hsl(${hue} ${sat}% ${lBase}%)`;
    ctx.fillRect(sx, sy, w + 0.5, h + 0.5);
    // 砖缝：把每格再切成 2x2 的小砖（不同偏移 → 错缝）
    const bw = w / 2, bh = h / 2;
    const off = (hb > 0.5) ? 0.5 : 0;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const hv = hash2(cx * 2 + i, cz * 2 + j);
        if (hv < 0.12) continue; // 缺砖 → 暗坑
        const bx = sx + i * bw + (j % 2 ? off : 0) * 0;
        const by = sy + j * bh;
        const dl = (hv - 0.5) * 5;
        ctx.fillStyle = `hsl(${hue + (hv - 0.5) * 12} ${sat}% ${Math.max(6, lBase + 1.5 + dl)}%)`;
        ctx.fillRect(bx + 0.7, by + 0.7, bw - 1.4, bh - 1.4);
        // 顶部/左侧微高光（受光来自上方）
        ctx.fillStyle = `rgba(190,210,255,${0.045 + hv * 0.03})`;
        ctx.fillRect(bx + 0.7, by + 0.7, bw - 1.4, Math.max(0.6, bh * 0.12));
      }
    }
    // 裂缝
    if (hb3 > 0.72 && quality > 0) {
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(0.6, w * 0.012);
      ctx.beginPath();
      let px = sx + w * (0.2 + 0.6 * hash2(cx, cz + 3));
      let py = sy + h * 0.15;
      ctx.moveTo(px, py);
      for (let s = 0; s < 3; s++) {
        px += (hash2(cx + s * 7, cz) - 0.5) * w * 0.35;
        py += h * 0.28;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // 苔藓/污渍
    if (hb2 > 0.86) {
      const g = ctx.createRadialGradient(sx + w * 0.5, sy + h * 0.5, 0, sx + w * 0.5, sy + h * 0.5, w * 0.6);
      g.addColorStop(0, 'rgba(40,58,30,0.35)');
      g.addColorStop(1, 'rgba(40,58,30,0)');
      ctx.fillStyle = g;
      ctx.fillRect(sx, sy, w, h);
    }
    // 门：脚下有暖色符文
    if (isDoorTile) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.18 + 0.08 * Math.sin(t * 2 + cx);
      ctx.fillStyle = 'hsl(38 100% 60%)';
      ctx.fillRect(sx + w * 0.15, sy + h * 0.15, w * 0.7, h * 0.7);
      ctx.restore();
    }
    // 格子边界极淡
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - 0.5, sy - 0.5, w + 1, h + 1);
  }

  /**
   * 绘制所有可见墙块（伪 3D）。
   * 只画"前侧/左侧/右侧可见"的墙格：若其后方格子不是墙，则绘制可见侧面。
   * 排序：按 z 从远到近，保证遮挡正确。
   */
  drawWalls(ctx, d, cam, t, quality = 2, bloom = null) {
    if (!d) return;
    const ts = d.tileSize || 1;
    const u = cam.scale;
    const p0 = cam.worldToScreen(0, 0);
    const c0 = cam.screenToWorld(0, 0);
    const c1 = cam.screenToWorld(cam.viewW, cam.viewH);
    const cx0 = Math.floor(Math.min(c0.x, c1.x) / ts) - 2;
    const cx1 = Math.ceil(Math.max(c0.x, c1.x) / ts) + 2;
    const cz0 = Math.floor(Math.min(c0.z, c1.z) / ts) - 2;
    const cz1 = Math.ceil(Math.max(c0.z, c1.z) / ts) + 3 + WALL_H * 2;
    const tileW = ts * u;
    const tileH = ts * u * cam.squash;
    const wallH = WALL_H * u * cam.heightK;

    ctx.save();
    for (let cz = cz0; cz <= cz1; cz++) {
      const sy = p0.y + cz * tileH;
      for (let cx = cx0; cx <= cx1; cx++) {
        if (tileAt(d, cx, cz) !== 1) continue;
        const sx = p0.x + cx * tileW;
        if (sx > cam.viewW + tileW * 2 || sx + tileW < -tileW * 2 || sy > cam.viewH + tileH * 2 || sy + tileH < -wallH - tileH * 2) continue;

        const frontOpen = tileAt(d, cx, cz + 1) !== 1; // 朝玩家的面（+z 方向）
        const leftOpen = tileAt(d, cx - 1, cz) !== 1;
        const rightOpen = tileAt(d, cx + 1, cz) !== 1;
        const topOnly = !frontOpen && !leftOpen && !rightOpen;

        // 侧面（+z 方向朝向屏幕下方 = 玩家可见面）
        if (frontOpen) {
          const g = ctx.createLinearGradient(0, sy - wallH + tileH, 0, sy + tileH);
          const hv = hash2(cx, cz + 5);
          g.addColorStop(0, `hsl(220 ${10 + hv * 5}% ${13 + hv * 4}%)`);
          g.addColorStop(0.6, `hsl(220 ${8 + hv * 4}% ${9 + hv * 3}%)`);
          g.addColorStop(1, `hsl(220 10% ${4 + hv * 2}%)`);
          ctx.fillStyle = g;
          ctx.fillRect(sx, sy - wallH + tileH, tileW + 0.5, wallH);
          // 砖缝（横向 3 行）
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.lineWidth = 1;
          for (let r = 1; r < 3; r++) {
            const yy = sy - wallH + tileH + (wallH / 3) * r;
            ctx.beginPath();
            ctx.moveTo(sx, yy);
            ctx.lineTo(sx + tileW, yy);
            ctx.stroke();
          }
          // 竖向砖缝错位
          for (let r = 0; r < 3; r++) {
            const yy = sy - wallH + tileH + (wallH / 3) * r;
            const ox = (hash2(cx + r * 31, cz) * 0.6 + 0.2) * tileW;
            ctx.beginPath();
            ctx.moveTo(sx + ox, yy);
            ctx.lineTo(sx + ox, yy + wallH / 3);
            ctx.stroke();
          }
          // 顶部边缘亮线（受光）
          ctx.fillStyle = `rgba(150,175,220,${0.10 + quality * 0.02})`;
          ctx.fillRect(sx, sy - wallH + tileH, tileW, Math.max(1, wallH * 0.08));
          // 底部接触阴影（AO）
          const ao = ctx.createLinearGradient(0, sy + tileH - tileH * 0.5, 0, sy + tileH + tileH * 0.4);
          ao.addColorStop(0, 'rgba(0,0,0,0.55)');
          ao.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = ao;
          ctx.fillRect(sx - 2, sy + tileH - tileH * 0.5, tileW + 4, tileH * 0.9);
        }
        // 左右侧面（较窄、更暗）—— 用平行四边形制造体积感
        if (leftOpen) {
          ctx.fillStyle = 'rgba(4,6,10,0.85)';
          ctx.beginPath();
          ctx.moveTo(sx, sy - wallH + tileH);
          ctx.lineTo(sx + tileW * 0.18, sy - wallH + tileH * 0.82);
          ctx.lineTo(sx + tileW * 0.18, sy + tileH * 0.82);
          ctx.lineTo(sx, sy + tileH);
          ctx.closePath();
          ctx.fill();
        }
        if (rightOpen) {
          ctx.fillStyle = 'rgba(10,13,20,0.8)';
          ctx.beginPath();
          ctx.moveTo(sx + tileW, sy - wallH + tileH);
          ctx.lineTo(sx + tileW * 0.82, sy - wallH + tileH * 0.82);
          ctx.lineTo(sx + tileW * 0.82, sy + tileH * 0.82);
          ctx.lineTo(sx + tileW, sy + tileH);
          ctx.closePath();
          ctx.fill();
        }
        // 顶面（亮）— 只有上方是空的墙格才画满顶面，否则只画一条边
        const topVisible = frontOpen || leftOpen || rightOpen;
        if (topVisible) {
          const ty0 = sy - wallH;
          const g2 = ctx.createLinearGradient(sx, ty0, sx, ty0 + tileH);
          const hv = hash2(cx + 3, cz + 9);
          g2.addColorStop(0, `hsl(${215 + hv * 20} ${12 + hv * 6}% ${22 + hv * 6}%)`);
          g2.addColorStop(1, `hsl(${212 + hv * 20} ${10 + hv * 4}% ${15 + hv * 4}%)`);
          ctx.fillStyle = g2;
          ctx.fillRect(sx, ty0, tileW + 0.5, tileH + 0.5);
          // 顶面砖纹
          ctx.strokeStyle = 'rgba(0,0,0,0.3)';
          ctx.lineWidth = 1;
          ctx.strokeRect(sx + 0.5, ty0 + 0.5, tileW - 1, tileH - 1);
          ctx.strokeStyle = `rgba(190,210,245,${0.07 + hv * 0.05})`;
          ctx.beginPath();
          ctx.moveTo(sx, ty0 + 0.5);
          ctx.lineTo(sx + tileW, ty0 + 0.5);
          ctx.stroke();
          // 顶面接缝
          if (tileAt(d, cx, cz - 1) === 1) {
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.beginPath();
            ctx.moveTo(sx, ty0);
            ctx.lineTo(sx + tileW, ty0);
            ctx.stroke();
          }
        }
        // 顶沿高光线
        if (frontOpen) {
          ctx.fillStyle = `rgba(200,215,250,${0.16})`;
          ctx.fillRect(sx, sy - wallH + tileH - 1, tileW, 1.5);
        }
        void topOnly;
      }
    }
    ctx.restore();
    void bloom; void t;
  }

  /**
   * 柱子/火把/装饰（world.dungeon.torchLights 或 tiles 值 3=柱子）。
   * 返回需要 bloom 的灯光位置（renderer 会画发光）。
   */
  collectTorches(d, cam, out) {
    out.length = 0;
    if (!d) return out;
    const ts = d.tileSize || 1;
    if (Array.isArray(d.torchLights) || Array.isArray(d.torches)) {
      const src = d.torchLights || d.torches;
      // 大地图火把数量多：只渲染视口附近的（含柔和光晕半径的余量），
      // 避免每帧对几百个屏幕外光源做渐变/贴图。
      const halfW = cam.viewW / (2 * cam.scale) + 7;
      const halfH = cam.viewH / (2 * cam.scale * cam.squash) + 9;
      for (const tl of src) {
        if (Math.abs(tl.x - cam.x) > halfW || Math.abs(tl.z - cam.y) > halfH) continue;
        out.push({ x: tl.x, z: tl.z, color: tl.color || 'hsl(36 100% 60%)' });
      }
      return out;
    }
    // 兜底：沿墙格规律放置火把（每 7 格一个）
    const c0 = cam.screenToWorld(0, 0);
    const c1 = cam.screenToWorld(cam.viewW, cam.viewH);
    const cx0 = Math.max(0, Math.floor(Math.min(c0.x, c1.x) / ts) - 1);
    const cx1 = Math.min(d.cols - 1, Math.ceil(Math.max(c0.x, c1.x) / ts) + 1);
    const cz0 = Math.max(0, Math.floor(Math.min(c0.z, c1.z) / ts) - 1);
    const cz1 = Math.min(d.rows - 1, Math.ceil(Math.max(c0.z, c1.z) / ts) + 2);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (tileAt(d, cx, cz) !== 1) continue;
        if (tileAt(d, cx, cz + 1) === 1) continue; // 只放在可见面
        if (hash2(cx * 7 + 3, cz * 13 + 1) < 0.86) continue;
        out.push({ x: (cx + 0.5) * ts, z: (cz + 0.92) * ts, color: 'hsl(36 100% 60%)' });
      }
    }
    return out;
  }
}