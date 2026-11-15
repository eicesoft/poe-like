// ─────────────────────────────────────────────────────────────────────────────
// raster.mjs — 无浏览器环境下的"软件 Canvas2D 光栅器"（验证渲染层画面用）
//
// 做法：记录 renderer 对 ctx 的**每一次调用**（含 save/restore/clip/transform），
// 然后按调用顺序在一个 RGBA 缓冲区里做软件光栅化（扫描线填充 / 抗锯齿 / 渐变 /
// globalCompositeOperation: source-over | lighter / globalAlpha），
// 最后输出 PNG。这样能在没有 GPU/浏览器的情况下，人眼检查画面构图与配色。
//
// 说明：这是**验证工具**，不是生产代码；对 text/shadow 等仅做近似。
// ─────────────────────────────────────────────────────────────────────────────
import { deflateSync } from 'node:zlib';

// ── 矩阵 / 几何 ──────────────────────────────────────────────────────────────
const ID = [1, 0, 0, 1, 0, 0];
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

const TAU = Math.PI * 2;
function arcPts(cx, cy, rx, ry, rot, a0, a1) {
  let sweep = a1 - a0;
  if (Math.abs(sweep) >= TAU - 1e-9) sweep = Math.sign(sweep || 1) * (TAU - 1e-6);
  const steps = Math.max(4, Math.ceil(Math.abs(sweep) / 0.16));
  const c = Math.cos(rot), s = Math.sin(rot);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    const px = Math.cos(a) * rx, py = Math.sin(a) * ry;
    out.push(cx + px * c - py * s, cy + px * s + py * c);
  }
  return out;
}

// ── 颜色 ────────────────────────────────────────────────────────────────────
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function parseColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (s[0] === '#') {
    let hx = s.slice(1);
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    if (hx.length < 6) return null;
    return [parseInt(hx.slice(0, 2), 16) / 255, parseInt(hx.slice(2, 4), 16) / 255, parseInt(hx.slice(4, 6), 16) / 255, 1];
  }
  if (s.startsWith('hsl')) {
    const nums = s.match(/-?[\d.]+(?:e-?\d+)?/g);
    if (!nums) return null;
    const h = +nums[0], sat = +nums[1] / 100, li = +nums[2] / 100;
    const a = nums.length > 3 ? +nums[3] : 1;
    const [r, g, b] = hslToRgb(h, sat, li);
    return [r, g, b, Math.max(0, Math.min(1, a))];
  }
  if (s.startsWith('rgb')) {
    const nums = s.match(/-?[\d.]+(?:e-?\d+)?/g);
    if (!nums) return null;
    const a = nums.length > 3 ? +nums[3] : 1;
    return [+nums[0] / 255, +nums[1] / 255, +nums[2] / 255, Math.max(0, Math.min(1, a))];
  }
  const named = {
    white: [1, 1, 1, 1], black: [0, 0, 0, 1], red: [1, 0, 0, 1], green: [0, 0.5, 0, 1], blue: [0, 0, 1, 1],
    gold: [1, 0.84, 0.4, 1], yellow: [1, 1, 0, 1], cyan: [0, 1, 1, 1], orange: [1, 0.55, 0.1, 1],
  };
  return named[s.toLowerCase()] || null;
}

function parseGradientStops(stops) {
  const out = [];
  for (const st of stops) {
    const raw = st.color;
    let col = parseColor(raw);
    if (col) out.push({ pos: st.pos, c: col });
    else out.push({ pos: st.pos, c: [0, 0, 0, 0] });
  }
  out.sort((a, b) => a.pos - b.pos);
  return out;
}

// ── 光栅器 ──────────────────────────────────────────────────────────────────
export class SoftCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.buf = new Float32Array(w * h * 3);
    const self = this;
    let calls = 0;
    this.ctx = new SoftCtx(self, () => { calls++; });
    this.ctx.__calls = () => calls;
  }
  clone() {
    const c = new SoftCanvas(this.width, this.height);
    c.buf.set(this.buf);
    return c;
  }
  drawFrom(src, sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh, alpha = 1, op = 'source-over') {
    // 最近邻缩放（bloom 用）
    for (let y = 0; y < dh; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) continue;
      const syi = Math.min(sh - 1, Math.max(0, Math.floor(sy + (y / dh) * sh)));
      for (let x = 0; x < dw; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.width) continue;
        const sxi = Math.min(sw - 1, Math.max(0, Math.floor(sx + (x / dw) * sw)));
        const si = ((sy + syi) * src.width + (sx + sxi)) * 3;
        this.blend(tx, ty, src.buf[si], src.buf[si + 1], src.buf[si + 2], alpha, op);
      }
    }
  }
  blend(x, y, r, g, b, a, op) {
    if (a <= 0) return;
    const i = (y * this.width + x) * 3;
    const B = this.buf;
    if (op === 'lighter') {
      B[i] += r * a;
      B[i + 1] += g * a;
      B[i + 2] += b * a;
    } else if (op === 'multiply') {
      B[i] *= 1 - a + a * r;
      B[i + 1] *= 1 - a + a * g;
      B[i + 2] *= 1 - a + a * b;
    } else {
      B[i] += (r - B[i]) * a;
      B[i + 1] += (g - B[i + 1]) * a;
      B[i + 2] += (b - B[i + 2]) * a;
    }
  }
  toPNG() {
    const { width: w, height: h, buf } = this;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    let p = 0;
    for (let y = 0; y < h; y++) {
      raw[p++] = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        raw[p++] = Math.max(0, Math.min(255, Math.round(buf[i] * 255)));
        raw[p++] = Math.max(0, Math.min(255, Math.round(buf[i + 1] * 255)));
        raw[p++] = Math.max(0, Math.min(255, Math.round(buf[i + 2] * 255)));
      }
    }
    const chunks = [];
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td) >>> 0);
      chunks.push(len, td, crc);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2; // RGB
    chunk('IHDR', ihdr);
    chunk('IDAT', deflateSync(raw, { level: 6 }));
    chunk('IEND', Buffer.alloc(0));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
  }
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// ── 状态机式 ctx ─────────────────────────────────────────────────────────────
class SoftCtx {
  constructor(canvas, count) {
    this.c = canvas;
    this.scaleHint = 1;
    this.count = count;
    this.m = ID;
    this.stack = [];
    this.clipRect = null; // [x0,y0,x1,y1]（设备像素，近似：仅 axis-aligned）
    this.clipPoly = null;
    this.path = []; // [{kind:'poly',pts:[x,y,..]}, ...]
    this.cur = null;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.gradient = null;
    this.gradKind = null;
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.imageSmoothingEnabled = true;
    this.scaleHint = 1;
    this.opCounter = 0;
  }
  // 状态
  save() {
    this.count();
    this.stack.push({ m: this.m, clipRect: this.clipRect, clipPoly: this.clipPoly, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, gradient: this.gradient, gradKind: this.gradKind, lineWidth: this.lineWidth, globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline });
  }
  restore() {
    this.count();
    const s = this.stack.pop();
    if (!s) return;
    Object.assign(this, s);
  }
  setTransform(a, b, c, d, e, f) {
    this.count();
    if (Array.isArray(a)) this.m = a.slice();
    else this.m = [a, b, c, d, e, f];
    this.scaleHint = scaleOf(this.m);
  }
  resetTransform() { this.count(); this.m = ID.slice(); this.scaleHint = 1; }
  translate(x, y) { this.count(); this.m = mul(this.m, [1, 0, 0, 1, x, y]); }
  rotate(a) { this.count(); this.m = mul(this.m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); }
  scale(x, y) { this.count(); this.m = mul(this.m, [x, 0, 0, y, 0, 0]); this.scaleHint *= Math.abs(x); }
  // 路径
  beginPath() { this.count(); this.path = []; this.cur = null; }
  moveTo(x, y) { this.count(); this.cur = { kind: 'poly', pts: [x, y] }; this.path.push(this.cur); this._sub = [x, y]; }
  lineTo(x, y) { this.count(); if (!this.cur) this.moveTo(x, y); else this.cur.pts.push(x, y); }
  quadraticCurveTo(cx, cy, x, y) {
    this.count();
    if (!this.cur) this.moveTo(x, y);
    const p = this.cur.pts;
    const x0 = p[p.length - 2], y0 = p[p.length - 1];
    for (let i = 1; i <= 6; i++) {
      const t = i / 6, mt = 1 - t;
      p.push(mt * mt * x0 + 2 * mt * t * cx + t * t * x, mt * mt * y0 + 2 * mt * t * cy + t * t * y);
    }
  }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    this.count();
    if (!this.cur) this.moveTo(x, y);
    const p = this.cur.pts;
    const x0 = p[p.length - 2], y0 = p[p.length - 1];
    for (let i = 1; i <= 8; i++) {
      const t = i / 8, mt = 1 - t;
      p.push(mt ** 3 * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t ** 3 * x,
        mt ** 3 * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t ** 3 * y);
    }
  }
  arc(cx, cy, r, a0, a1, ccw = false) {
    this.count();
    const pts = arcPts(cx, cy, r, r, 0, ccw ? a1 : a0, ccw ? a0 : a1);
    const poly = { kind: 'poly', pts, arc: { cx, cy, r } };
    const startX = pts[0], startY = pts[1];
    if (this.cur && Math.hypot(this.cur.pts[this.cur.pts.length - 2] - startX, this.cur.pts[this.cur.pts.length - 1] - startY) < 1e-6) {
      this.cur.pts.push(...pts.slice(2));
      this.cur.arc = { cx, cy, r };
    } else {
      this.cur = poly;
      this.path.push(poly);
    }
  }
  ellipse(cx, cy, rx, ry, rot, a0, a1, ccw = false) {
    this.count();
    const pts = arcPts(cx, cy, rx, ry, rot, ccw ? a1 : a0, ccw ? a0 : a1);
    const poly = { kind: 'poly', pts, full: Math.abs(a1 - a0) > TAU - 1e-6, ell: { cx, cy, rx, ry, rot } };
    this.cur = poly;
    this.path.push(poly);
  }
  rect(x, y, w, h) {
    this.count();
    const poly = { kind: 'poly', pts: [x, y, x + w, y, x + w, y + h, x, y + h], rect: true };
    this.cur = poly;
    this.path.push(poly);
  }
  roundRect(x, y, w, h, r) {
    this.count();
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    const pts = [];
    const seg = (cx, cy, a0, a1) => pts.push(...arcPts(cx, cy, rr, rr, 0, a0, a1));
    pts.push(x + rr, y);
    pts.push(x + w - rr, y);
    seg(x + w - rr, y + rr, -Math.PI / 2, 0);
    pts.push(x + w, y + rr);
    pts.push(x + w, y + h - rr);
    seg(x + w - rr, y + h - rr, 0, Math.PI / 2);
    pts.push(x + w - rr, y + h);
    pts.push(x + rr, y + h);
    seg(x + rr, y + h - rr, Math.PI / 2, Math.PI);
    pts.push(x, y + h - rr);
    pts.push(x, y + rr);
    seg(x + rr, y + rr, Math.PI, Math.PI * 1.5);
    this.cur = { kind: 'poly', pts };
    this.path.push(this.cur);
  }
  closePath() { this.count(); if (this.cur && !this.cur.closed) { this.cur.closed = true; this.cur = null; } }
  clip() {
    this.count();
    // 近似：若路径是 axis-aligned rect 就裁矩形，否则记录世界多边形的设备包围盒
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of this.path) {
      for (let i = 0; i < poly.pts.length; i += 2) {
        const [dx, dy] = apply(this.m, poly.pts[i], poly.pts[i + 1]);
        x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy);
      }
    }
    const r = [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
    this.clipRect = this.clipRect ? [Math.max(this.clipRect[0], r[0]), Math.max(this.clipRect[1], r[1]), Math.min(this.clipRect[2], r[2]), Math.min(this.clipRect[3], r[3])] : r;
  }
  // 样式
  createLinearGradient(x0, y0, x1, y1) {
    this.count();
    return { kind: 'linear', p0: apply(this.m, x0, y0), p1: apply(this.m, x1, y1), stops: [], addColorStop(pos, color) { this.stops.push({ pos, color }); } };
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    this.count();
    return { kind: 'radial', c0: apply(this.m, x0, y0), r0: r0 * this.scaleHint, c1: apply(this.m, x1, y1), r1: r1 * this.scaleHint, stops: [], addColorStop(pos, color) { this.stops.push({ pos, color }); } };
  }
  createPattern() { this.count(); return { kind: 'pattern' }; }
  // 绘制
  fill() { this.count(); this._fillPath(this.fillStyle); }
  stroke() { this.count(); this._strokePath(this.strokeStyle); }
  fillRect(x, y, w, h) {
    this.count();
    this.beginPath(); this.rect(x, y, w, h);
    this._fillPath(this.fillStyle);
    this.path = []; this.cur = null;
  }
  strokeRect(x, y, w, h) {
    this.count();
    this.beginPath(); this.rect(x, y, w, h);
    this._strokePath(this.strokeStyle);
    this.path = []; this.cur = null;
  }
  clearRect() { this.count(); }
  fillText(t, x, y) {
    this.count();
    // 近似：用一个小方块代表文字位置与颜色（验证用）
    // 注意：font 形如 `800 13.8px "Rajdhani","Segoe UI",system-ui,sans-serif`，
    // 不能直接 parseFloat（会得到 800），要取带 px 的那个数值。
    const size = parseFontSize(this.font);
    const [dx, dy] = apply(this.m, x, y);
    const sh = size * this.scaleHint;
    const w = Math.max(2, String(t).length * sh * 0.6);
    this._fillGlyphBlock(dx, dy - sh * 0.5, w, sh, this.fillStyle);
  }
  strokeText() { this.count(); }
  measureText(t) { return { width: String(t).length * 8 }; }
  drawImage(img, ...a) {
    this.count();
    if (!img) return;
    const src = img.__soft || img;
    if (!src || !src.buf) return;
    let dx = 0, dy = 0, dw = src.width, dh = src.height, sx = 0, sy = 0, sw = src.width, sh = src.height;
    if (a.length >= 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
    else if (a.length >= 4) { [dx, dy, dw, dh] = a; }
    else if (a.length >= 2) { dx = a[0]; dy = a[1]; }
    // 只处理恒等变换下的贴图（后处理层都是这种情况）
    if (this.m[0] !== 1 || this.m[1] !== 0 || this.m[2] !== 0 || this.m[3] !== 1) {
      // 缩放/平移变换：按矩阵缩放后贴
      const s = scaleOf(this.m);
      this.c.drawFrom(src, sx, sy, sw, sh, Math.round(this.m[4] + dx * s), Math.round(this.m[5] + dy * s), Math.round(dw * s), Math.round(dh * s), this.globalAlpha, this.globalCompositeOperation);
      return;
    }
    const op = this.globalCompositeOperation === 'lighter' ? 'lighter' : 'source-over';
    this.c.drawFrom(src, sx, sy, sw, sh, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh), this.globalAlpha, op);
  }
  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    return { data, width: w, height: h };
  }
  putImageData() { this.count(); }
  setLineDash() {}
  // ── 核心：填充/描边 ────────────────────────────────────────────────────────
  _colorAt(style, x, y) {
    if (typeof style === 'string') {
      const c = parseColor(style);
      return c || [1, 1, 1, 1];
    }
    if (style && style.stops) {
      const st = parseGradientStops(style.stops);
      if (!st.length) return [0, 0, 0, 0];
      let t;
      if (style.kind === 'linear') {
        const dx = style.p1[0] - style.p0[0], dy = style.p1[1] - style.p0[1];
        const len2 = dx * dx + dy * dy || 1;
        t = ((x - style.p0[0]) * dx + (y - style.p0[1]) * dy) / len2;
      } else {
        const d = Math.hypot(x - style.c1[0], y - style.c1[1]);
        const rr = style.r1 || 1;
        t = (d - style.r0) / Math.max(1e-6, rr - style.r0);
      }
      if (t <= st[0].pos) return st[0].c;
      if (t >= st[st.length - 1].pos) return st[st.length - 1].c;
      for (let i = 0; i < st.length - 1; i++) {
        const a = st[i], b = st[i + 1];
        if (t >= a.pos && t <= b.pos) {
          const k = (t - a.pos) / Math.max(1e-6, b.pos - a.pos);
          return [a.c[0] + (b.c[0] - a.c[0]) * k, a.c[1] + (b.c[1] - a.c[1]) * k, a.c[2] + (b.c[2] - a.c[2]) * k, a.c[3] + (b.c[3] - a.c[3]) * k];
        }
      }
    }
    return [1, 1, 1, 1];
  }
  _fillGlyphBlock(x, y, w, h, style) {
    this.beginPath();
    this.rect(x - w / 2, y, w, h);
    this._fillPath(style);
    this.path = [];
  }
  _fillPath(style) {
    const polys = [];
    for (const poly of this.path) {
      const pts = [];
      for (let i = 0; i < poly.pts.length; i += 2) {
        const [dx, dy] = apply(this.m, poly.pts[i], poly.pts[i + 1]);
        pts.push(dx, dy);
      }
      if (pts.length >= 6) polys.push(pts);
    }
    if (!polys.length) return;
    // 包围盒
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
    }
    this._raster(x0, y0, x1, y1, style, null);
  }
  _strokePath(style) {
    const lw = Math.max(0.4, this.lineWidth * this.scaleHint);
    const polys = [];
    for (const poly of this.path) {
      const pts = [];
      for (let i = 0; i < poly.pts.length; i += 2) {
        const [dx, dy] = apply(this.m, poly.pts[i], poly.pts[i + 1]);
        pts.push(dx, dy);
      }
      if (pts.length >= 4) polys.push(pts);
    }
    if (!polys.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
    }
    this._raster(x0, y0, x1, y1, style, { polys, lw });
  }
  _raster(bbx0, bby0, bbx1, bby1, style, stroke) {
    const target = this.c;
    const op = this.globalCompositeOperation === 'lighter' ? 'lighter' : (this.globalCompositeOperation === 'multiply' ? 'multiply' : 'source-over');
    const alpha = Math.max(0, Math.min(1, this.globalAlpha));
    let x0 = Math.max(0, Math.floor(bbx0) - 1), y0 = Math.max(0, Math.floor(bby0) - 1);
    let x1 = Math.min(target.width - 1, Math.ceil(bbx1) + 1), y1 = Math.min(target.height - 1, Math.ceil(bby1) + 1);
    if (this.clipRect) {
      x0 = Math.max(x0, this.clipRect[0]); y0 = Math.max(y0, this.clipRect[1]);
      x1 = Math.min(x1, this.clipRect[2] - 1); y1 = Math.min(y1, this.clipRect[3] - 1);
    }
    if (x1 < x0 || y1 < y0) return;
    // 像素中心采样 + 2 个子采样（抗锯齿与速度折中）
    // 注意：必须先把每段路径转换成"扁平坐标数组 [x0,y0,x1,y1,...]"
    const polys = [];
    let minY = Infinity, maxY = -Infinity;
    for (const poly of this.path) {
      const pts = [];
      for (let i = 0; i < poly.pts.length; i += 2) {
        const [px2, py2] = apply(this.m, poly.pts[i], poly.pts[i + 1]);
        pts.push(px2, py2);
        if (py2 < minY) minY = py2;
        if (py2 > maxY) maxY = py2;
      }
      if (pts.length >= 6) polys.push(pts);
    }
    if (!polys.length) return;
    // y 方向按路径范围再收一次（包围盒可能远大于实际覆盖）
    if (minY - 1 > y0) y0 = Math.max(y0, Math.floor(minY) - 1);
    if (maxY + 1 < y1) y1 = Math.min(y1, Math.ceil(maxY) + 1);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        let cov = 0;
        {
          const X = px + 0.5, Y = py + 0.5;
          if (stroke) {
            if (strokeHit(stroke.polys, X, Y, stroke.lw * 0.5)) cov = 2;
          } else if (insidePolys(polys, X, Y)) cov = 2;
          // 对边缘像素再做一次子采样（只在中心命中或临界时）
          if (!cov || stroke) {
            const X2 = px + 0.25, Y2 = py + 0.25;
            if (stroke) { if (strokeHit(stroke.polys, X2, Y2, stroke.lw * 0.5)) cov++; }
            else if (insidePolys(polys, X2, Y2)) cov++;
          }
        }
        if (!cov) continue;
        const a = (cov / 2) * alpha;
        const col = this._colorAt(style, px + 0.5, py + 0.5);
        const ca = a * (col[3] ?? 1);
        if (ca <= 0.002) continue;
        target.blend(px, py, col[0], col[1], col[2], ca, op);
      }
    }
  }
}

/** 从 CSS font 字符串取像素字号：'800 13.8px "Rajdhani",sans-serif' → 13.8 */
function parseFontSize(font) {
  const m = String(font || '').match(/([\d.]+)px/);
  return m ? parseFloat(m[1]) : 12;
}

function insidePolys(polys, X, Y) {
  let inside = false;
  for (const p of polys) {
    const n = p.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
      if ((yi > Y) !== (yj > Y) && X < ((xj - xi) * (Y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function strokeHit(polys, X, Y, halfW) {
  for (const p of polys) {
    const n = p.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const x0 = p[i * 2], y0 = p[i * 2 + 1], x1 = p[i * 2 + 2], y1 = p[i * 2 + 3];
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((X - x0) * dx + (Y - y0) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(X - (x0 + dx * t), Y - (y0 + dy * t));
      if (d <= halfW) return true;
    }
  }
  return false;
}

// ── 与 Renderer 对接：捕获一次 render 的所有绘制 ─────────────────────────────
export function createCapture() {
  const canvases = [];
  const fakeCanvas = (w, h) => {
    const sc = new SoftCanvas(w, h);
    canvases.push(sc);
    return {
      width: w,
      height: h,
      get __soft() { return sc; },
      getContext() { return sc.ctx; },
    };
  };
  const main = fakeCanvas(1, 1);
  return { main, fakeCanvas, canvases };
}

/**
 * 渲染一帧并返回 PNG Buffer。
 * @param {typeof import('../src/render/renderer.js').Renderer} Renderer
 * @param {object} world
 * @param {{w:number,h:number,frames?:number,dt?:number,onFrame?:(i:number)=>void}} opts
 */
export async function renderPng(Renderer, world, opts = {}) {
  const w = opts.w || 1280;
  const h = opts.h || 720;
  const frames = opts.frames || 1;
  const dt = opts.dt || 1 / 60;
  // 主 canvas 用全分辨率软画布（离屏 bloom 层由 document.createElement 补丁提供）
  const sc = new SoftCanvas(w, h);
  const canvas = {
    width: w,
    height: h,
    get __soft() { return sc; },
    getContext() { return sc.ctx; },
  };
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return { style: {} };
      const c = new SoftCanvas(w, h);
      return { width: w, height: h, get __soft() { return c; }, getContext() { return c.ctx; } };
    },
  };
  try {
    const r = Renderer.forOffscreen(canvas, { quality: opts.quality || 'high' });
    // bloom / post 离屏层尺寸与主画布一致
    if (r.bloomCanvas) r.bloomCanvas.width = w;
    if (r.bloomCanvas) r.bloomCanvas.height = h;
    if (r.postCanvas) { r.postCanvas.width = w; r.postCanvas.height = h; }
    // 预演若干帧（让粒子/相机稳定）
    let t = 0;
    for (let i = 0; i < frames; i++) {
      t += dt;
      if (opts.onFrame) opts.onFrame(i, r);
      r.render(world, dt, t);
    }
    return { png: sc.toPNG(), renderer: r };
  } finally {
    globalThis.document = prevDoc;
  }
}