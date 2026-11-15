// HUD 预览：用真实地牢渲染（软件光栅器）+ 把新增 HUD 元素（底部面板按钮列 / 暂停覆盖层）
// 按 style.css 里的真实尺寸画到同一张 PNG 上。
//
// 为什么需要它：本仓库的验证环境（DSH 沙箱）无法启动任何 Chromium 内核浏览器
// （mojo 命名管道被拦，见 tools/_shots/panelbar/ENV-PROBE.md），也没装 canvas 包，
// 所以没法用真浏览器截图。测试只能跑逻辑；**视觉回归**用这里的近似合成图顶上：
//   - 地牢/角色/怪物/掉落：真实 Renderer 输出（像素级真实）
//   - HUD 面板：按 style.css 的坐标/尺寸/颜色手绘（近似，用来看"是否重叠/是否越界/是否好看"）
//
// 用法：node tools/hud-preview.mjs [--view=idle|pause|panelbar|all]
// 输出：tools/_shots/hud/idle.png / pause.png / panelbar.png
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Renderer } from '../../../src/render/renderer.js';
import { renderPng } from '../../../tests/raster.mjs';
import { createGame, updateGame } from '../../../src/game/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'tools/_shots/panelbar/hud-1920');
mkdirSync(OUT, { recursive: true });

const VIEW_W = 1920;
const VIEW_H = 1080;

// ---------------------------------------------------------------------------
// 迷你画布：RGB 缓冲 + 基本图元 + PNG 编码（复用 tests/raster.mjs 的编码器）
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  const px = new Uint8Array(w * h * 3);
  return {
    w, h, px,
    fill(x, y, r, g, b) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 3;
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    },
    rect(x, y, rw, rh, color, alpha = 1) {
      color = parseColor(color);
      for (let yy = Math.max(0, y | 0); yy < Math.min(h, (y + rh) | 0); yy++) {
        for (let xx = Math.max(0, x | 0); xx < Math.min(w, (x + rw) | 0); xx++) {
          this._blend(xx, yy, color, alpha);
        }
      }
    },
    rrect(x, y, rw, rh, rad, color, alpha = 1) {
      color = parseColor(color);
      for (let yy = Math.max(0, y | 0); yy < Math.min(h, (y + rh) | 0); yy++) {
        for (let xx = Math.max(0, x | 0); xx < Math.min(w, (x + rw) | 0); xx++) {
          const dx = Math.min(xx - x, x + rw - 1 - xx);
          const dy = Math.min(yy - y, y + rh - 1 - yy);
          if (dx < rad && dy < rad) {
            const ex = rad - dx, ey = rad - dy;
            if (ex * ex + ey * ey > rad * rad) continue;
          }
          this._blend(xx, yy, color, alpha);
        }
      }
    },
    // 圆角描边（只画 1px 边）
    stroke(x, y, rw, rh, rad, color, alpha = 1) {
      color = parseColor(color);
      const inside = (px, py, inset) => {
        const x0 = x + inset, y0 = y + inset, x1 = x + rw - 1 - inset, y1 = y + rh - 1 - inset;
        if (px < x0 || py < y0 || px > x1 || py > y1) return false;
        const dx = Math.min(px - x0, x1 - px), dy = Math.min(py - y0, y1 - py);
        if (dx < rad - inset && dy < rad - inset) {
          const ex = (rad - inset) - dx, ey = (rad - inset) - dy;
          return ex * ex + ey * ey <= (rad - inset) * (rad - inset);
        }
        return true;
      };
      for (let py = y; py < y + rh; py++) {
        for (let pxx = x; pxx < x + rw; pxx++) {
          if (inside(pxx, py, 0) && !inside(pxx, py, 1)) this._blend(pxx, py, color, alpha);
        }
      }
    },
    vgrad(x, y, rw, rh, c0, c1, alpha = 1) {
      const a = parseColor(c0), b = parseColor(c1);
      for (let yy = 0; yy < rh; yy++) {
        const t = rh <= 1 ? 0 : yy / (rh - 1);
        const c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        this.rect(x, y + yy, rw, 1, c, alpha);
      }
    },
    line(x0, y0, x1, y1, color, alpha = 1) {
      color = parseColor(color);
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy, x = x0 | 0, y = y0 | 0;
      for (let guard = 0; guard < 4000; guard++) {
        this._blend(x, y, color, alpha);
        if (x === (x1 | 0) && y === (y1 | 0)) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x += sx; }
        if (e2 < dx) { err += dx; y += sy; }
      }
    },
    circle(cx, cy, r, color, alpha = 1) {
      color = parseColor(color);
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          const dx = x - cx, dy = y - cy;
          if (dx * dx + dy * dy <= r * r) this._blend(x, y, color, alpha);
        }
      }
    },
    ring(cx, cy, r, color, alpha = 1) {
      color = parseColor(color);
      for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
        for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
          const dx = x - cx, dy = y - cy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d <= r && d > r - 1.3) this._blend(x, y, color, alpha);
        }
      }
    },
    _blend(x, y, c, a) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 3;
      px[i] = px[i] + (c[0] - px[i]) * a;
      px[i + 1] = px[i + 1] + (c[1] - px[i + 1]) * a;
      px[i + 2] = px[i + 2] + (c[2] - px[i + 2]) * a;
    },
    // 4x6 点阵小字体（只用于数字/大写字母，近似 HUD 上的小字）
    text(str, x, y, color, scale = 1, alpha = 1) {
      color = parseColor(color);
      let cx = x;
      for (const ch of String(str).toUpperCase()) {
        const g = FONT[ch] || FONT['?'];
        for (let row = 0; row < 7; row++) {
          for (let col = 0; col < 5; col++) {
            if (g[row] && g[row][col] === '#') {
              this.rect(cx + col * scale, y + row * scale, scale, scale, color, alpha);
            }
          }
        }
        cx += 6 * scale;
      }
      return cx;
    },
    textWidth(str, scale = 1) { return String(str).length * 6 * scale; },
  };
}

// 5x7 点阵字符（HUD 里只用到少量字符）
const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '>': ['10000', '01000', '00100', '00010', '00100', '01000', '10000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
};

function parseColor(c) {
  if (Array.isArray(c)) return c;
  let s = String(c).trim();
  if (s[0] === '#') s = s.slice(1);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

// ---------------------------------------------------------------------------
// 真实渲染一帧地牢世界
// ---------------------------------------------------------------------------
async function renderWorld(seconds = 4) {
  const game = createGame({ seed: 42, tier: 1 });
  const w = game.world;
  const p = w.player;
  const dt = 1 / 60;
  const frames = Math.round(60 * seconds);
  for (let i = 0; i < frames; i++) {
    let best = null, bd = 1e9;
    for (const m of w.monsters) {
      if (m.dead) continue;
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < bd) { bd = d; best = m; }
    }
    updateGame(game, dt, {
      move: best && bd > 1.9 ? { x: (best.x - p.x) / bd, z: (best.z - p.z) / bd } : { x: 0, z: 0 },
      aim: best ? { x: best.x, z: best.z } : { x: p.x + 1, z: p.z },
      attackHeld: i > frames - 90,
      skills: [],
    });
  }
  const { png, renderer } = await renderPng(Renderer, w, {
    w: VIEW_W, h: VIEW_H, frames: 3, dt,
    onFrame(i, r) { r.cam.target(p.x, p.z, 0, w.aim); },
  });
  return { game, png, renderer };
}

/** 把真实的 PNG 渲染结果解成像素（PNG 是我们自己的编码器写的：无压缩 zlib store/正常 deflate） */
async function decodePng(buf) {
  // tests/raster.mjs 用 node zlib 压缩；这里借内置 zlib 解，逻辑与 encoder 对称
  const zlib = await import('node:zlib');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit PNG');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.from(row);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

// ---------------------------------------------------------------------------
// HUD 绘制（尺寸/颜色对齐 src/ui/style.css 的真实规则）
// ---------------------------------------------------------------------------
const GOLD = '#d9b463';
const GOLD_BRIGHT = '#ffe9a8';
const LINE = '#5a5540';
const TEXT = '#d9d2c4';
const TEXT_DIM = '#8f8a80';

function drawHud(cv) {
  // ---- 左上：角色卡 ----
  hudCard(cv, 14, 12, 300, 92);
  cv.rrect(22, 20, 40, 40, 3, '#8a1f1f', 0.9);
  cv.text('W', 38, 34, GOLD_BRIGHT, 1.4);
  cv.text('LV.12', 74, 24, GOLD_BRIGHT, 1);
  const bars = [['HP', 156, 196, '#c8321e'], ['MP', 50, 72, '#3f7fe0'], ['XP', 42, 100, '#9d6bff']];
  bars.forEach(([name, cur, max, col], i) => {
    const y = 46 + i * 14;
    cv.rrect(74, y, 226, 9, 2, '#0a0c12', 1);
    cv.rect(75, y + 1, Math.round(224 * cur / max), 7, col, 0.95);
    cv.text(`${cur}/${max}`, 210, y + 1, '#e8e0d0', 1);
  });
  // ---- 中上：地图卡 ----
  hudCard(cv, Math.round(VIEW_W / 2 - 150), 12, 300, 74);
  cv.text('MAP  TIER 3', 456, 22, GOLD_BRIGHT, 1.1);
  cv.rect(456, 44, 130, 11, '#2a2430', 1);
  cv.text('MODS  25%', 458, 46, '#ff9a5c', 1);
  cv.text('KILLS 148   WAVE 7', 456, 64, TEXT_DIM, 1);
  // ---- 右上：属性面板卡（#stats-panel） ----
  hudCard(cv, VIEW_W - 12 - 266, 12, 266, 314);
  const rows = [['DMG', '2-41'], ['APS', '1.35'], ['CRIT', '6.2% 1.5'], ['ARMOR', '61'], ['EVADE', '4%'], ['MOVE', '6.2'], ['RES', '0/0/0'], ['AOE', '+0%']];
  rows.forEach(([k, v], i) => {
    const y = 24 + i * 34;
    cv.text(k, 1016, y, TEXT_DIM, 1);
    cv.text(v, 1180, y, TEXT, 1);
  });
  // ---- 左下：日志 ----
  for (let i = 0; i < 5; i++) cv.text('LOG ' + (i + 1), 16, 520 + i * 14, '#a89e8a', 0.8, 0.75);
  // ---- 中下偏右：掉落栏 ----
  hudCard(cv, VIEW_W - 14 - 340, VIEW_H - 96 - 46, 340, 46);
  cv.text('LOOT', 938, 590, GOLD, 1);
  cv.circle(1002, 596, 4, '#af6025'); cv.text('UNIQUE', 1012, 592, '#af6025', 0.9);
  cv.circle(1102, 596, 4, '#ffff77'); cv.text('RARE', 1112, 592, '#ffff77', 0.9);
  // ---- 技能栏（居中底部：7 槽 52x52，gap 7，padding 7/9） ----
  const barW = 7 * 52 + 6 * 7 + 2 * 9 + 2;
  const barX = Math.round((VIEW_W - barW) / 2);
  const barY = VIEW_H - 18 - (52 + 14 + 2);
  hudCard(cv, barX, barY, barW, 52 + 14 + 2);
  const slots = ['1', '2', '3', '4', '5', 'SPC', 'T'];
  slots.forEach((k, i) => {
    const x = barX + 10 + i * 59;
    const y = barY + 8;
    cv.rrect(x, y, 52, 52, 3, '#14161e', 1);
    cv.stroke(x, y, 52, 52, 3, i === 5 || i === 6 ? LINE : '#96694a', 0.9);
    cv.text(k, x + 4, y + 3, GOLD_BRIGHT, 0.8);
    cv.circle(x + 26, y + 28, 11, i < 5 ? '#b8873a' : '#5a5540', 0.5);
  });
  // ---- 右下：面板按钮列（#panel-bar right:14 bottom:328，58x50，gap8，padding5） ----
  drawPanelBar(cv, null);
  // ---- 右下：静音键（right:14 bottom:310） ----
  cv.rrect(VIEW_W - 14 - 34, VIEW_H - 20 - 34, 34, 34, 4, '#12141c', 1);
  cv.stroke(VIEW_W - 14 - 34, VIEW_H - 20 - 34, 34, 34, 4, LINE, 1);
  cv.circle(VIEW_W - 14 - 17, VIEW_H - 20 - 17, 5, GOLD, 0.9);
  // ---- 底部居中：帮助提示 ----
  cv.text('WASD MOVE  RMB SKILL  1-5  SPACE  ESC PAUSE  C STATS', VIEW_W / 2 - 190, VIEW_H - 12, TEXT_DIM, 0.85, 0.8);
}

function hudCard(cv, x, y, w, h) {
  cv.rrect(x, y, w, h, 4, '#12141c', 0.92);
  cv.stroke(x, y, w, h, 4, LINE, 1);
  cv.rect(x + 1, y + 1, w - 2, 1, '#2a2e3c', 0.9);
}

/** 底部面板按钮列（最终形态：左下角横排 4 个 44×44，left:14 bottom:19 gap8 pad4） */
function drawPanelBar(cv, activeAct, badges = { stats: 2, skills: 3 }) {
  const btns = [
    { act: 'stats', key: 'C', glyph: 'person' },
    { act: 'talents', key: 'P', glyph: 'star' },
    { act: 'skills', key: 'K', glyph: 'rune' },
    { act: 'equipment', key: 'E', glyph: 'armor' },
  ];
  const w = 44, h = 44, gap = 8, pad = 4;
  const boxW = btns.length * w + (btns.length - 1) * gap + pad * 2 + 2;
  const boxH = h + pad * 2 + 2;
  const bx = 14, by = VIEW_H - 19 - boxH;
  cv.rrect(bx, by, boxW, boxH, 6, '#0a0c12', 0.8);
  cv.stroke(bx, by, boxW, boxH, 6, LINE, 0.55);
  btns.forEach((b, i) => {
    const x = bx + 1 + pad + i * (w + gap), y = by + 1 + pad;
    const active = activeAct === b.act;
    cv.vgrad(x, y, w, h, active ? '#3a2f1a' : '#1b1f2b', active ? '#1a1408' : '#07080c', 1);
    cv.stroke(x, y, w, h, 4, active ? GOLD : '#6a5f42', active ? 1 : 0.85);
    const c = active ? GOLD_BRIGHT : '#b9ad8e';
    const cx = x + w / 2, cy = y + 17;
    if (b.glyph === 'person') { cv.circle(cx, cy - 5, 3.6, c, 0.9); cv.ring(cx, cy + 5, 5.6, c, 0.9); }
    if (b.glyph === 'star') {
      cv.ring(cx, cy, 3.2, c, 0.9);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        cv.line(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5, cx + Math.cos(a) * 8, cy + Math.sin(a) * 8, c, 0.85);
        cv.circle(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8, 1, c, 0.9);
      }
    }
    if (b.glyph === 'rune') {
      const pts = [[0, -8], [7, -4], [7, 4], [0, 8], [-7, 4], [-7, -4]];
      for (let k = 0; k < 6; k++) cv.line(cx + pts[k][0], cy + pts[k][1], cx + pts[(k + 1) % 6][0], cy + pts[(k + 1) % 6][1], c, 0.9);
      cv.line(cx, cy - 4, cx, cy + 4, c, 0.8);
    }
    if (b.glyph === 'armor') {
      cv.line(cx, cy - 8, cx - 6, cy - 5, c, 0.9);
      cv.line(cx, cy - 8, cx + 6, cy - 5, c, 0.9);
      cv.line(cx - 6, cy - 5, cx - 5, cy + 2, c, 0.9);
      cv.line(cx + 6, cy - 5, cx + 5, cy + 2, c, 0.9);
      cv.line(cx - 5, cy + 2, cx, cy + 8, c, 0.9);
      cv.line(cx + 5, cy + 2, cx, cy + 8, c, 0.9);
    }
    // 中文名贴底 + 快捷键角标（真实 DOM 里是文字，这里用小点阵近似）
    cv.text(b.key, x + 4, y + h - 10, GOLD_BRIGHT, 0.65);
    cv.rect(x + 14, y + h - 8, 22, 2, c, 0.55);
    const n = badges[b.act];
    if (n) {
      cv.circle(x + w - 6, y + 6, 6.5, '#1a1305', 1);
      cv.ring(x + w - 6, y + 6, 6.5, GOLD, 1);
      cv.text(String(n), x + w - 9, y + 4, GOLD_BRIGHT, 0.5);
    }
  });
  return { bx, by, boxW, boxH };
}

/** 暂停覆盖层（#pause-menu：z65 全屏暗化 + 居中金色卡片 + 8 个按钮） */
function drawPauseOverlay(cv) {
  // 画面去饱和 + 暗化（canvas#game.paused-canvas: grayscale(.35) brightness(.72)）
  for (let i = 0; i < cv.px.length; i += 3) {
    const r = cv.px[i], g = cv.px[i + 1], b = cv.px[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    cv.px[i] = (r + (lum - r) * 0.35) * 0.72;
    cv.px[i + 1] = (g + (lum - g) * 0.35) * 0.72;
    cv.px[i + 2] = (b + (lum - b) * 0.35) * 0.72;
  }
  // 覆盖层暗化
  cv.rect(0, 0, cv.w, cv.h, '#040509', 0.62);
  // 暂停时 HUD 淡出（#app.paused #hud{opacity:0}）：这里把 HUD 区域整体压暗近似
  cv.rect(0, 0, cv.w, cv.h, '#000000', 0.35);
  // 卡片：按 style.css 的 .pause-card（min(560px,92vw)、22/24 padding）近似
  const cw = 520, ch = 560;
  const cx = Math.round((VIEW_W - cw) / 2), cy = Math.round((VIEW_H - ch) / 2);
  // 外发光
  for (let i = 26; i > 0; i--) cv.rrect(cx - i, cy - i, cw + i * 2, ch + i * 2, 5 + i, '#d9b463', 0.012);
  cv.vgrad(cx, cy, cw, ch, '#161925', '#090a0f', 0.99);
  cv.stroke(cx, cy, cw, ch, 5, GOLD, 0.85);
  cv.rect(cx + 1, cy, cw - 2, 2, GOLD, 0.9);
  cv.text('PAUSED', cx + cw / 2 - 44, cy + 26, GOLD_BRIGHT, 2.2);
  cv.rect(cx + 60, cy + 58, cw - 120, 1, GOLD, 0.35);
  cv.text('WARRIOR  LV.12  TIER 3  KILLS 148', cx + 34, cy + 74, TEXT, 0.95);
  cv.text('PLAYED 00:42:11   SAVED 8S AGO', cx + 34, cy + 92, TEXT_DIM, 0.8);
  cv.rect(cx + 24, cy + 112, cw - 48, 1, LINE, 0.6);
  const labels = ["RESUME  ESC  // #1 继续游戏","STATS  C  // #2 属性","TALENTS  P  // #3 天赋","SKILLS  K  // #4 技能","EQUIP  E  // #5 装备","SFX  M  // #6 音效","SAVE  // #7 保存游戏","QUIT (CONFIRM)  // #8 返回主菜单"];
  labels.forEach((lab, i) => {
    const x = cx + Math.round(cw * 30 / 520) + (i % 2) * Math.round(cw * 232 / 520);
    const y = cy + 128 + Math.floor(i / 2) * 54;
    const w = Math.round(cw * 220 / 520), h = 44;
    const hover = i === 0; const isDanger = i === 7;
    cv.vgrad(x, y, w, h, hover ? '#3a2f1a' : (isDanger ? '#2a1414' : '#1a1d28'), hover ? '#241b0c' : (isDanger ? '#180a0a' : '#0b0c12'), 1);
    cv.stroke(x, y, w, h, 3, hover ? GOLD : (isDanger ? '#7a3a32' : '#4d4634'), 1);
    cv.text(lab, x + 14, y + 18, hover ? GOLD_BRIGHT : TEXT, 0.95);
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function copyRenderedToCanvas(decoded, cv) {
  const { data, channels, width } = decoded;
  const sx = width / cv.w, sy = decoded.height / cv.h;
  for (let y = 0; y < cv.h; y++) {
    const srcy = Math.min(decoded.height - 1, Math.floor(y * sy));
    for (let x = 0; x < cv.w; x++) {
      const srcx = Math.min(width - 1, Math.floor(x * sx));
      const si = (srcy * width + srcx) * channels;
      const di = (y * cv.w + x) * 3;
      cv.px[di] = data[si];
      cv.px[di + 1] = data[si + 1];
      cv.px[di + 2] = data[si + 2];
    }
  }
}

async function main() {
  const views = (process.argv.find((a) => a.startsWith('--view=')) || '').slice(7) || 'all';
  const { png } = await renderWorld(4);
  const decoded = await decodePng(Buffer.from(png));
  const outs = [];
  const want = (v) => views === 'all' || views.split(',').includes(v);

  if (want('idle') || want('panelbar')) {
    const cv = makeCanvas(VIEW_W, VIEW_H);
    copyRenderedToCanvas(decoded, cv);
    drawHud(cv);
    const file = join(OUT, 'panelbar.png');
    const out = await renderPngFromCanvas(cv);
    writeFileSync(file, out);
    outs.push({ file, view: 'panelbar' });
  }
  if (want('pause')) {
    const cv = makeCanvas(VIEW_W, VIEW_H);
    copyRenderedToCanvas(decoded, cv);
    drawHud(cv);
    drawPauseOverlay(cv);
    const file = join(OUT, 'pause.png');
    writeFileSync(file, await renderPngFromCanvas(cv));
    outs.push({ file, view: 'pause' });
  }
  console.log(JSON.stringify({ out: OUT, views: outs }, null, 2));
}

/** 用一个假的 canvas2d 把像素写回 PNG（reuse tests/raster.mjs 的 png 编码器） */
async function renderPngFromCanvas(cv) {
  const zlib = await import('node:zlib');
  const raw = Buffer.alloc((cv.w * 3 + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) {
    raw[y * (cv.w * 3 + 1)] = 0;
    for (let x = 0; x < cv.w; x++) {
      const si = (y * cv.w + x) * 3;
      const di = y * (cv.w * 3 + 1) + 1 + x * 3;
      raw[di] = cv.px[si];
      raw[di + 1] = cv.px[si + 1];
      raw[di + 2] = cv.px[si + 2];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const chunks = [];
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0); ihdr.writeUInt32BE(cv.h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});