// CSS 几何核对（静态）：把 style.css 里的关键定位规则解析成数值，按视口算包围盒，
// 和 tools/_shots/panelbar/hud-<W>/panelbar.png 里画的位置对比。
//
// 用法：node tools/_shots/panelbar/_geom-check.mjs [W H]
// 说明：只读 style.css / index.html，不改任何 src/ 文件。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const css = readFileSync(join(ROOT, 'src', 'ui', 'style.css'), 'utf8');
const W = Number(process.argv[2] || 1280);
const H = Number(process.argv[3] || 720);

/** 取某个选择器（顶层规则里第一次出现）的声明块 */
function rule(sel) {
  const re = new RegExp('(?:^|\\n)' + sel.replace(/[.#]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(';')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const px = (v) => (v == null ? null : Number(String(v).replace('px', '')));

/** 从 #a { ... } 里拿一个数值（缺失则用 fallback） */
const num = (sel, prop, fallback = 0) => {
  const r = rule(sel);
  return (r && r[prop] != null) ? px(r[prop]) : fallback;
};

// ---- 关键盒模型（全部直接来自 style.css） ----
const panel = {
  left: num('#panel-bar', 'left', 14),
  bottom: num('#panel-bar', 'bottom', 19),
  pad: num('#panel-bar', 'padding', 4),
  gap: num('#panel-bar', 'gap', 8),
  border: 1, // 注释里写明 1px
  btnW: num('.panel-btn', 'width', 44),
  btnH: num('.panel-btn', 'height', 44),
};
const barW = 4 * panel.btnW + 3 * panel.gap + 2 * panel.pad + 2 * panel.border;
const barH = panel.btnH + 2 * panel.pad + 2 * panel.border;
const panelRect = { x: panel.left, y: H - panel.bottom - barH, w: barW, h: barH };

const skillbar = {
  bottom: num('#skillbar', 'bottom', 18),
  padX: px((rule('#skillbar') || { padding: '7px 9px' }).padding.split(' ')[1] || '9px'),
  gap: num('#skillbar', 'gap', 7),
};
const slots = (readFileSync(join(ROOT, 'index.html'), 'utf8').match(/class="slot/g) || []).length;
const skillW = slots * 52 + (slots - 1) * skillbar.gap + 2 * skillbar.padX + 2;
const skillH = 52 + 2 * 7 + 2;
const skillRect = { x: (W - skillW) / 2, y: H - skillbar.bottom - skillH, w: skillW, h: skillH };

const logRect = { x: num('#log', 'left', 14), y: 0, w: num('#log', 'width', 300), h: 0 };
const logBottom = H - num('#log', 'bottom', 92);
logRect.y = logBottom - 162; // 7 行满时的最大高度（12px 行高 × 7 + gap 2×6 + padding ≈ 162，保守上限）
logRect.h = 162;

const loot = { right: num('#loot-bar', 'right', 14), bottom: num('#loot-bar', 'bottom', 96), w: 340, h: 141 };
const lootRect = { x: W - loot.right - loot.w, y: H - loot.bottom - loot.h, w: loot.w, h: loot.h };

const sfx = { right: num('.sfx-toggle', 'right', 14), bottom: num('.sfx-toggle', 'bottom', 20), s: 34 };
const sfxRect = { x: W - sfx.right - sfx.s, y: H - sfx.bottom - sfx.s, w: sfx.s, h: sfx.s };

const help = { bottom: 6, h: 14, w: 470 };
// #help-hint 的 bottom / max-width 以**最后一条**规则为准（CSS 后者覆盖前者）
const hintBodies = [...css.matchAll(/(?:^|\n)#help-hint\s*\{([^}]*)\}/g)].map((mm) => mm[1]);
const hintLast = hintBodies[hintBodies.length - 1] || '';
const hintBottom = hintLast.match(/bottom:\s*(\d+(?:\.\d+)?)px/);
if (hintBottom) help.bottom = Number(hintBottom[1]);
const hintMw = hintLast.match(/max-width:\s*min\((\d+)px,\s*(\d+)vw\)/);
// 文字估算宽度 470px（见 _hint-width.mjs）→ 实际取 min(文字宽度, max-width)
if (hintMw) help.w = 470 < Number(hintMw[1]) && 470 < Math.round((Number(hintMw[2]) / 100) * W) ? 470 : (Number(W) * 0 + (Number(hintMw[1]) < Math.round((Number(hintMw[2]) / 100) * W) ? Number(hintMw[1]) : Math.round((Number(hintMw[2]) / 100) * W)));

const helpRect = { x: W / 2 - help.w / 2, y: H - help.bottom - help.h, w: help.w, h: help.h };

const rects = { panelBar: panelRect, skillbar: skillRect, log: logRect, lootBar: lootRect, sfxToggle: sfxRect, helpHint: helpRect };
const overlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? +(w * h).toFixed(1) : 0;
};
const gaps = [];
for (const [ka, a] of Object.entries(rects)) {
  for (const [kb, b] of Object.entries(rects)) {
    if (ka >= kb) continue;
    const o = overlap(a, b);
    const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    gaps.push({ a: ka, b: kb, overlap: o, gapX: +gx.toFixed(1), gapY: +gy.toFixed(1) });
  }
}
// ---- 暂停态可见性（Lead 的 PAUSE 段）：#app.paused #hud 淡出，但 #panel-bar / .sfx-toggle 有例外 ----
const pausedSection = (() => {
  const i = css.indexOf('PAUSE (src/ui/pause.js)');
  const j = css.indexOf('PAUSE END', Math.max(0, i));
  return i >= 0 ? css.slice(i, j > i ? j : i + 12000) : '';
})();
const pauseHidesHud = /#app\.paused\s+#hud\s*\{[^}]*opacity:\s*0/.test(pausedSection) || /#app\.paused\s+#hud\s*\{[^}]*visibility:\s*hidden/.test(pausedSection);
const panelVisibleWhenPaused = /#app\.paused\s+#panel-bar[^{]*\{[^}]*visibility:\s*visible/.test(css);
const sfxVisibleWhenPaused = /#app\.paused[^{]*\.sfx-toggle[^{]*\{[^}]*visibility:\s*visible/.test(css);
const pausedVisibility = {
  'PAUSE 段存在': pausedSection.length > 200,
  '#app.paused #hud 隐藏': pauseHidesHud,
  '暂停时 #panel-bar 例外可见（可点）': panelVisibleWhenPaused,
  '暂停时 .sfx-toggle 例外可见': sfxVisibleWhenPaused,
};
const pausedOK = pausedVisibility['PAUSE 段存在'] && pauseHidesHud && panelVisibleWhenPaused && sfxVisibleWhenPaused;

const outOfView = Object.entries(rects).filter(([, r]) => r.x < -0.5 || r.y < -0.5 || r.x + r.w > W + 0.5 || r.y + r.h > H + 0.5).map(([k]) => k);
const conflicts = gaps.filter((g) => g.overlap > 0);
const result = {
  viewport: `${W}x${H}`,
  cssNumbers: { panel, skillbar, log: { left: logRect.x, width: logRect.w, bottom: num('#log', 'bottom', 92) }, loot, sfx, help },
  rects,
  conflicts,
  outOfView,
  pausedVisibility,
  PASS: conflicts.length === 0 && outOfView.length === 0 && pausedOK,
  note: '#help-hint 的宽度按文字长度估算（_hint-width.mjs），并用 CSS 的 max-width:min(720px,46vw) 限宽后取较小值',
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.PASS ? 0 : 1);