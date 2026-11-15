// 天赋树整图预览：用 src/ui/talent-ui.js 里**同一份 Canvas 绘制代码**（drawTalentMap）出 PNG。
//
// 浏览器在本沙箱里起不来（Chromium 的 mojo 命名管道被拦，见 tools/qa-shots.mjs），Python 也装不上 Pillow，
// 所以这里：
//   1. 用一个「记录型 Canvas2D」把 drawTalentMap 的每条绘制调用录下来；
//   2. 用本文件内的软件光栅器（3x 超采样 + 解析式距离场，覆盖圆 / 多边形 / 折线 / 文字块）回放成 PNG。
// PNG 用 node:zlib 直接写，零依赖。
//
// 用法：node tools/talent-map.mjs [输出目录]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { TALENTS, TALENT_BY_ID, START_NODE } from "../src/items/talentTree.js";
import { drawTalentMap } from "../src/ui/talent-ui.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] || join(ROOT, "tools", "_shots");
mkdirSync(OUT, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// 1) 记录型 Canvas2D
// ─────────────────────────────────────────────────────────────────────────────
function recorder(w, h) {
  const calls = [];
  const state = { fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "12px sans-serif", textAlign: "start", textBaseline: "alphabetic", globalAlpha: 1 };
  const m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const tx = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const sc = () => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  let path = [];
  let cur = null;
  const take = () => { const p = path; path = []; cur = null; return p; };
  const asGrad = (x) => (x && x.__id ? x : null);

  const ctx = {
    setTransform(a, b, c, d, e, f) { m.a = a; m.b = b; m.c = c; m.d = d; m.e = e; m.f = f; },
    save() {}, restore() {},
    clearRect(x, y, ww, hh) { calls.push(["rect", x, y, ww, hh, null]); },
    fillRect(x, y, ww, hh) { calls.push(["rect", x, y, ww, hh, state.fillStyle]); },
    beginPath() { path = []; cur = null; },
    closePath() { path.push({ t: "Z" }); },
    moveTo(x, y) { const p = tx(x, y); path.push({ t: "M", x: p.x, y: p.y }); cur = p; },
    lineTo(x, y) { const p = tx(x, y); path.push({ t: "L", x: p.x, y: p.y }); cur = p; },
    quadraticCurveTo(cx, cy, x, y) {
      const c = tx(cx, cy); const p = tx(x, y);
      path.push({ t: "Q", from: cur || c, c, x: p.x, y: p.y });
      cur = p;
    },
    bezierCurveTo(a1, b1, a2, b2, x, y) {
      const c1 = tx(a1, b1); const c2 = tx(a2, b2); const p = tx(x, y);
      path.push({ t: "C", from: cur || c1, c1, c2, x: p.x, y: p.y });
      cur = p;
    },
    arc(x, y, r, a0, a1) {
      const c = tx(x, y);
      path.push({ t: "A", cx: c.x, cy: c.y, r: r * sc(), a0, a1 });
      cur = { x: c.x + Math.cos(a1) * r * sc(), y: c.y + Math.sin(a1) * r * sc() };
    },
    fill() { calls.push(["fill", take(), asGrad(state.fillStyle), state.fillStyle, state.globalAlpha]); },
    stroke() { calls.push(["stroke", take(), asGrad(state.strokeStyle), state.strokeStyle, Math.max(0.6, state.lineWidth * sc()), state.globalAlpha]); },
    fillText(t, x, y) {
      const p = tx(x, y);
      const fs = parseFloat(String(state.font).split("px")[0].split(" ").pop()) * sc();
      calls.push(["text", String(t), p.x, p.y, state.fillStyle, fs, state.textAlign]);
    },
    strokeText(t, x, y) {
      const p = tx(x, y);
      const fs = parseFloat(String(state.font).split("px")[0].split(" ").pop()) * sc();
      calls.push(["textOutline", String(t), p.x, p.y, fs, state.textAlign]);
    },
    measureText(t) { return { width: String(t).length * 7 }; },
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      const g = { __id: "g" + calls.length + "_" + Math.random().toString(36).slice(2, 7), kind: "radial", x0, y0, r0, x1, y1, r1, stops: [] };
      calls.push(["grad", g]);
      return { __id: g.__id, addColorStop(p, c) { g.stops.push([p, c]); } };
    },
    createLinearGradient(x0, y0, x1, y1) {
      const g = { __id: "g" + calls.length + "_" + Math.random().toString(36).slice(2, 7), kind: "linear", x0, y0, x1, y1, stops: [] };
      calls.push(["grad", g]);
      return { __id: g.__id, addColorStop(p, c) { g.stops.push([p, c]); } };
    },
    setLineDash() {}, clip() {},
  };
  for (const k of Object.keys(state)) {
    Object.defineProperty(ctx, k, { get: () => state[k], set: (v) => { state[k] = v; } });
  }
  ctx.canvas = { width: w, height: h };
  return { calls, ctx };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 软件光栅器
// ─────────────────────────────────────────────────────────────────────────────
function parseColor(c) {
  if (!c || typeof c !== "string") return null;
  const s = c.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    if (h.length === 8) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const n = m[1].split(",").map((v) => parseFloat(v));
    return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
  }
  return [128, 128, 128, 1];
}

function segmentsOf(path) {
  const segs = [];
  let cur = null;
  for (const cmd of path) {
    if (cmd.t === "M") { if (cur && cur.length > 1) segs.push(cur); cur = [[cmd.x, cmd.y]]; }
    else if (cmd.t === "L") { if (!cur) cur = [[cmd.x, cmd.y]]; cur.push([cmd.x, cmd.y]); }
    else if (cmd.t === "Q") {
      if (!cur) cur = [[cmd.from.x, cmd.from.y]];
      const p0 = cur[cur.length - 1];
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        cur.push([(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * cmd.c.x + t * t * cmd.x, (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * cmd.c.y + t * t * cmd.y]);
      }
    } else if (cmd.t === "C") {
      if (!cur) cur = [[cmd.from.x, cmd.from.y]];
      const p0 = cur[cur.length - 1];
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        cur.push([
          (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * cmd.c1.x + 3 * (1 - t) * t * t * cmd.c2.x + t ** 3 * cmd.x,
          (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * cmd.c1.y + 3 * (1 - t) * t * t * cmd.c2.y + t ** 3 * cmd.y,
        ]);
      }
    } else if (cmd.t === "A") {
      if (cur && cur.length > 1) segs.push(cur);
      const pts = [];
      const span = cmd.a1 - cmd.a0;
      const n = Math.max(16, Math.ceil(Math.abs(span) / (Math.PI / 24)));
      for (let i = 0; i <= n; i++) {
        const a = cmd.a0 + (span * i) / n;
        pts.push([cmd.cx + Math.cos(a) * cmd.r, cmd.cy + Math.sin(a) * cmd.r]);
      }
      segs.push(pts);
      cur = null;
    } else if (cmd.t === "Z") {
      if (cur && cur.length > 1) { cur.push([cur[0][0], cur[0][1]]); segs.push(cur); cur = null; }
    }
  }
  if (cur && cur.length > 1) segs.push(cur);
  return segs;
}

function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPolyline(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) best = d;
  }
  return best;
}

function rasterize(scene, w, h) {
  const SS = 3;
  const buf = new Float32Array(w * h * 3);
  const bg = [11, 10, 16];
  for (let i = 0; i < w * h; i++) { buf[i * 3] = bg[0]; buf[i * 3 + 1] = bg[1]; buf[i * 3 + 2] = bg[2]; }
  const grads = new Map();
  for (const c of scene.calls) if (c[0] === "grad") grads.set(c[1].__id, c[1]);

  function blend(i, col, a) {
    buf[i] = buf[i] * (1 - a) + col[0] * a;
    buf[i + 1] = buf[i + 1] * (1 - a) + col[1] * a;
    buf[i + 2] = buf[i + 2] * (1 - a) + col[2] * a;
  }

  /** 逐像素覆盖率填充；colorAt 返回 [r,g,b,a] 或 null */
  function paint(bbox, shape, colorAt) {
    const x0 = Math.max(0, Math.floor(bbox[0])), y0 = Math.max(0, Math.floor(bbox[1]));
    const x1 = Math.min(w - 1, Math.ceil(bbox[2])), y1 = Math.min(h - 1, Math.ceil(bbox[3]));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            if (shape(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++;
          }
        }
        if (!hit) continue;
        const col = colorAt(x + 0.5, y + 0.5);
        if (!col) continue;
        blend((y * w + x) * 3, col, (hit / (SS * SS)) * (col[3] === undefined ? 1 : col[3]));
      }
    }
  }

  function sampleGrad(g, x, y) {
    if (!g || !g.stops.length) return null;
    let t;
    if (g.kind === "radial") {
      const d = Math.hypot(x - g.x1, y - g.y1);
      t = (d - g.r0) / Math.max(1e-6, g.r1 - g.r0);
    } else {
      const dx = g.x1 - g.x0, dy = g.y1 - g.y0;
      t = ((x - g.x0) * dx + (y - g.y0) * dy) / Math.max(1e-6, dx * dx + dy * dy);
    }
    t = Math.max(0, Math.min(1, t));
    const stops = g.stops.slice().sort((a, b) => a[0] - b[0]);
    let prev = stops[0];
    for (const s of stops) {
      if (t <= s[0]) {
        const span = s[0] - prev[0] || 1;
        const k = (t - prev[0]) / span;
        const c1 = parseColor(prev[1]), c2 = parseColor(s[1]);
        return [c1[0] + (c2[0] - c1[0]) * k, c1[1] + (c2[1] - c1[1]) * k, c1[2] + (c2[2] - c1[2]) * k, c1[3] + (c2[3] - c1[3]) * k];
      }
      prev = s;
    }
    return parseColor(stops[stops.length - 1][1]);
  }

  for (const c of scene.calls) {
    const op = c[0];
    if (op === "rect") {
      const [, x, y, ww, hh, fill] = c;
      const col = parseColor(fill);
      if (!col) continue;
      paint([x, y, x + ww, y + hh], (px, py) => px >= x && px <= x + ww && py >= y && py <= y + hh, () => col);
    } else if (op === "fill") {
      const [, path, gradRef, fill, alpha] = c;
      const segs = segmentsOf(path);
      if (!segs.length) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const sg of segs) for (const [x, y] of sg) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
      const pinned = segs.map((sg) => segs.length === 1 || inPoly((sg[0][0] + sg[1][0]) / 2, (sg[0][1] + sg[1][1]) / 2, sg));
      const grad = gradRef && gradRef.__id ? grads.get(gradRef.__id) : null;
      const base = grad ? null : parseColor(fill);
      if (!grad && !base) continue;
      const all = segs.flat();
      const colorAt = (px, py) => {
        const col = grad ? sampleGrad(grad, px, py) : base;
        if (!col) return null;
        return [col[0], col[1], col[2], col[3] * alpha];
      };
      if (segs.length === 1) {
        paint([minX, minY, maxX, maxY], (px, py) => inPoly(px, py, segs[0]), colorAt);
      } else {
        paint([minX, minY, maxX, maxY], (px, py) => segs.some((sg) => inPoly(px, py, sg)) || inPoly(px, py, all), colorAt);
      }
    } else if (op === "stroke") {
      const [, path, , strokeStyle, lineWidth, alpha] = c;
      const segs = segmentsOf(path);
      const col = parseColor(strokeStyle);
      if (!col || !segs.length) continue;
      const half = Math.max(0.4, lineWidth / 2);
      const colorAt = () => [col[0], col[1], col[2], col[3] * alpha];
      for (const sg of segs) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of sg) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
        paint([minX - half - 1, minY - half - 1, maxX + half + 1, maxY + half + 1], (px, py) => distToPolyline(px, py, sg) <= half + 0.3, colorAt);
      }
    } else if (op === "text" || op === "textOutline") {
      const isFill = op === "text";
      const t = c[1], x = c[2], y = c[3];
      if (!String(t).trim()) continue;
      let col, fs, align;
      if (isFill) { col = parseColor(c[4]); fs = c[5]; align = c[6]; }
      else { col = [6, 6, 10, 1]; fs = c[4]; align = c[5]; }
      if (!col) continue;
      const tw = String(t).length * fs * 0.92;
      const x0 = align === "center" ? x - tw / 2 : align === "right" ? x - tw : x;
      const pad = isFill ? 0 : Math.max(1, fs * 0.12);
      paint([x0 - 1, y - fs * 1.1, x0 + tw + 1, y + fs * 0.35],
        (px, py) => px >= x0 - pad && px <= x0 + tw + pad && py >= y - fs * 0.8 - pad && py <= y + fs * 0.18 + pad,
        () => [col[0], col[1], col[2], isFill ? 0.95 : 0.9]);
    }
  }

  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(buf[i])));
  return encodePNG(out, w, h);
}

// ── PNG 编码 ────────────────────────────────────────────────────────────────
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(rgb, w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 出图
// ─────────────────────────────────────────────────────────────────────────────
function shot(name, o) {
  const { calls, ctx } = recorder(o.width, o.height);
  const takenSet = new Set(o.taken);
  drawTalentMap(ctx, {
    width: o.width, height: o.height,
    view: { panX: o.panX || 0, panY: o.panY || 0, zoom: o.zoom, hover: o.hover ? TALENT_BY_ID[o.hover] : null },
    taken: takenSet,
    available: (t) => !takenSet.has(t.id) && t.neighbors.some((id) => takenSet.has(id)),
    byId: TALENT_BY_ID,
    time: o.time || 0,
  });
  const png = rasterize({ calls }, o.width, o.height);
  const file = join(OUT, name + ".png");
  writeFileSync(file, png);
  return { name, file, kb: Math.round(png.length / 1024), calls: calls.length };
}

const takenPath = [START_NODE].concat(
  ["war-trunc", "war-hub", "war-stem1", "war-stem2", "war-stem3", "war-stem4", "war-armL", "war-upL", "war-outerL", "war-cap", "war-armR", "war-upR", "war-outerR", "ring-in-0", "ring-out-0a", "ring-out-0b"].filter((id) => TALENT_BY_ID[id]),
);

const results = [
  shot("talent-map", { width: 1240, height: 940, zoom: 0.66, taken: [START_NODE] }),
  shot("talent-map-progress", { width: 1240, height: 940, zoom: 0.66, taken: takenPath, hover: "ks-war" }),
  shot("talent-map-zoom", { width: 1240, height: 940, zoom: 1.35, taken: takenPath, hover: "lg-fate" }),
];
writeFileSync(join(OUT, "talent-map.json"), JSON.stringify({ nodes: TALENTS.length, results }, null, 1));
console.log(JSON.stringify({ nodes: TALENTS.length, taken: takenPath.length, results }, null, 1));
