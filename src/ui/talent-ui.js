// @file src/ui/talent-ui.js
// 天赋树界面（POE 式「环 × 主干」网络）—— 深色奇幻 + 金色点缀，Canvas2D 绘制。
//
// 本文件分两层，互不依赖：
//   1. 纯绘制层：drawTalentMap(ctx, opts) —— 不碰任何 DOM API，只用 ctx 上的标准 Canvas2D 调用，
//      且刻意不用 save/restore/measureText/roundRect/filter/shadowBlur/ellipse/quadraticCurveTo，
//      让 tools/talent-map.mjs 的软件光栅器可以按同样的调用顺序回放出一模一样的图。
//   2. DOM 层：openTalents(ui) —— 构建面板、视图状态（平移/缩放/悬停）、交互相应。
//
// 坐标约定（与 talentTree.js 一致）：数据坐标以 (0,0) 为圆心；y 向下；单位为世界像素。
//   屏幕坐标 sx = width/2 + (n.x + view.panX) * zoom
//            sy = height/2 + (n.y + view.panY) * zoom
// 画布的 transform 由调用方设好（CSS 像素空间），这里只用 CSS 像素计算。
//
// 对外导出（其它代码 / 测试 / tools 依赖，改动前务必全局搜索）：
//   isTalentsOpen, openTalents, drawTalentMap, talentTooltipHTML,
//   KIND_COLORS, KIND_LABELS, NODE_RADII, colorOf, radiusOf
import { el, escapeHTML } from './dom.js';
import { TALENTS, BRANCHES as WARRIOR_BRANCHES } from '../items/talentTree.js';
import { MAGE_BRANCHES } from '../items/mageTalentTree.js';
import { talentTreeFor } from '../items/talentTrees.js';

// ============================================================================
// 1) 常量 & 小工具
// ============================================================================

/** 节点类型 → 颜色（也是图例色）。 */
export const KIND_COLORS = Object.freeze({
  classStart: '#4dd08a',
  minor: '#8aa0bf',
  notable: '#d9b463',
  keystone: '#e5653a',
  legendary: '#b06cf0',
});

/** 节点类型 → 中文名。 */
export const KIND_LABELS = Object.freeze({
  classStart: '起点',
  minor: '小点',
  notable: '显著',
  keystone: '基石',
  legendary: '传奇',
});

/** 节点类型 → 世界半径（画图与命中测试共用）。 */
export const NODE_RADII = Object.freeze({
  classStart: 15,
  minor: 5.5,
  notable: 8.5,
  keystone: 13,
  legendary: 11,
});

/** 主干 / 特殊分组的颜色（战士树 + 法师树共用一张颜色表）。 */
const BRANCH_COLORS = { ring: '#9a8fc0', center: '#4dd08a', keystone: '#e5653a', legendary: '#b06cf0' };
for (const b of [...(WARRIOR_BRANCHES || []), ...(MAGE_BRANCHES || [])]) {
  if (b && b.id && b.color) BRANCH_COLORS[b.id] = b.color;
}

/** stats 键 → 中文名（desc 缺失时用来拼行）。 */
const STAT_NAMES = {
  life: '生命', armor: '护甲', evasion: '闪避率', energyShield: '能量护盾',
  physDamageMult: '物理伤害', fireDamageMult: '火焰伤害', coldDamageMult: '冰霜伤害',
  lightningDamageMult: '闪电伤害', damageMult: '伤害', areaDamageMult: '范围伤害',
  dotMult: '持续伤害', aoeMult: '范围效果', attackSpeedMult: '攻击速度',
  moveSpeedMult: '移动速度', projectileSpeedMult: '投射物速度', cdrMult: '冷却缩减',
  critChance: '暴击率', critMulti: '暴击伤害', blockChance: '格挡几率',
  lifeRegen: '生命回复/秒', lifeLeech: '生命偷取', thorns: '反弹伤害',
  fireResist: '火焰抗性', coldResist: '冰霜抗性', lightningResist: '闪电抗性',
  chaosResist: '混沌抗性', rarityBonus: '物品稀有度', quantityBonus: '物品数量',
  xpBonus: '获得经验', skillLevelBonus: '技能等级', addedFireMin: '附加火焰伤害',
  // 法师专属（来自 items/mageTalentTree.js 的 mage* 自定义字段）
  mageReactionMult: '元素反应伤害', mageResonanceMult: '共鸣获取', mageMarkMax: '印记上限',
  mageAutoCastMult: '自动施法加速', mageEmpoweredMult: '强化技能伤害', mageShieldMult: '屏障护盾',
  mageNovaRadius: '霜环半径', mageNovaCdr: '霜环冷却缩减', mageChainJumpBonus: '雷链额外跳跃',
  mageReactionEcho: '反应回响', mageUltDuration: '元素狂潮持续', mageUltCdr: '元素狂潮冷却缩减',
  mageMeteor: '陨星等级', mageMeteorRate: '陨星间隔缩减', mageOrbs: '环绕法球',
  mageTrinity: '三相齐射间隔', mageUltKillExtend: '狂潮击杀延长', mageControlMult: '眩晕时长',
};

const FONT_STACK = '"Microsoft YaHei", sans-serif';
const GOLD_BRIGHT = '#ffe08a';
const HOVER_BLUE = '#bfe4ff';
const FILL_AVAILABLE = 'rgba(52,74,108,0.92)';
const FILL_LOCKED = 'rgba(26,24,34,0.94)';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** 半径缩放系数（view.zoom 夹到 0.55..1.9；缺省 1）。 */
const zOf = (view) => clamp(num(view && view.zoom, 1), 0.55, 1.9);

/**
 * 节点颜色：起点 / 基石 / 传奇用固定色，其余用所属主干色。
 * @param {any} t 天赋节点
 * @returns {string}
 */
export function colorOf(t) {
  if (!t) return KIND_COLORS.minor;
  if (t.kind === 'keystone') return KIND_COLORS.keystone;
  if (t.kind === 'legendary') return KIND_COLORS.legendary;
  if (t.kind === 'classStart') return KIND_COLORS.classStart;
  return BRANCH_COLORS[t.branch] || KIND_COLORS.minor;
}

/**
 * 节点世界半径。
 * @param {any} t 天赋节点
 * @returns {number}
 */
export function radiusOf(t) {
  return NODE_RADII[t && t.kind] || NODE_RADII.minor;
}

/**
 * '#b06cf0' → '176,108,240'（拼 rgba() 用）。
 * @param {string} hex
 * @returns {string}
 */
function rgbOf(hex) {
  const s = String(hex || '').trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) {
    const r = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (r) {
      const p = r[1].split(',').map((v) => parseFloat(v));
      return `${Math.round(num(p[0]))},${Math.round(num(p[1]))},${Math.round(num(p[2]))}`;
    }
    return '138,160,191';
  }
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
}

/** 颜色 + 透明度 → 'rgba(r,g,b,a)'。 */
const withAlpha = (hex, a) => `rgba(${rgbOf(hex)},${clamp(num(a), 0, 1)})`;

/** 压暗颜色：k=0.55 → 亮度 × 0.55。 */
function shade(hex, k) {
  const [r, g, b] = rgbOf(hex).split(',').map(Number);
  const f = (v) => Math.round(v * k);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/** 大节点：名字常驻显示、光晕更大、带呼吸环。 */
const isBig = (t) => !!t && (t.kind === 'keystone' || t.kind === 'legendary' || t.kind === 'classStart');

/**
 * 位置描述（tooltip 用）：主干节点给「主干 · 战争」，环节点按半径给「环 · 外/内层」。
 * @param {any} t
 * @param {ReadonlyArray<any>} [branches] 当前职业的树干表
 * @returns {string}
 */
function branchNameOf(t, branches) {
  if (!t) return '';
  for (const b of branches || WARRIOR_BRANCHES || []) if (b.id === t.branch) return `主干 · ${b.name}`;
  if (t.branch === 'ring') {
    const r = num(t.radius, 0);
    if (r >= 430) return '环 · 外侧';
    if (r >= 330) return '环 · 中层';
    if (r >= 260) return '环 · 内层';
    return '环 · 近核';
  }
  if (t.branch === 'center') return '环 · 中心';
  if (t.branch === 'keystone') return '主干 · 终点';
  if (t.branch === 'legendary') return '内圈 · 传奇';
  return '环';
}

// ============================================================================
// 2) 纯绘制层
// ============================================================================

/**
 * 画一整棵天赋树（纯函数：只读 opts，只调用 ctx 的绘制原语）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{
 *   width:number, height:number,
 *   view:{panX?:number, panY?:number, zoom?:number, hover?:any},
 *   taken?:Set<string>, available?:(t:any)=>boolean,
 *   byId?:Object<string,any>, nodes?:any[], ringRadii?:number[], time?:number
 * }} opts
 * @returns {{edges:number, nodes:number, names:string[]}} 画了多少条连线 / 多少个节点 / 画了名字的节点
 */
export function drawTalentMap(ctx, opts) {
  const o = opts || {};
  const W = Math.max(1, num(o.width, 800));
  const H = Math.max(1, num(o.height, 600));
  const view = o.view || {};
  const zoom = num(view.zoom, 0.7) || 0.7;
  const panX = num(view.panX, 0);
  const panY = num(view.panY, 0);
  const hover = view.hover || null;
  const hoverId = hover ? (typeof hover === 'string' ? hover : hover.id) : null;
  const taken = o.taken instanceof Set ? o.taken : new Set(Array.isArray(o.taken) ? o.taken : []);
  const available = typeof o.available === 'function' ? o.available : () => false;
  const byId = o.byId || {};
  const time = Math.max(0, num(o.time, 0));
  const cx = W / 2;
  const cy = H / 2;
  const zs = clamp(zoom, 0.55, 1.9);
  const result = { edges: 0, nodes: 0, names: [] };
  if (!ctx) return result;

  const sx = (n) => cx + (num(n.x) + panX) * zoom;
  const sy = (n) => cy + (num(n.y) + panY) * zoom;
  const isTaken = (n) => !!(n && taken.has(n.id));
  const haloGradient = (x, y, R, stops) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.5, R));
    for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  };
  // 多边形：中心 (x,y)，第 i 个顶点在 startDeg + i*(360/sides) 方向。
  const polygon = (x, y, radius, sides, startDeg) => {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = ((startDeg + (360 / sides) * i) * Math.PI) / 180;
      const px = x + Math.cos(a) * radius;
      const py = y + Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  };
  const circle = (x, y, radius) => {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.1, radius), 0, Math.PI * 2);
  };

  // -- 2.1 背景：中心径向微光（clearRect 由调用方负责） -----------------------
  ctx.fillStyle = haloGradient(cx, cy, Math.max(W, H) * 0.72, [
    [0, 'rgba(46,34,68,0.55)'],
    [0.55, 'rgba(18,14,28,0.35)'],
    [1, 'rgba(6,5,10,0)'],
  ]);
  ctx.fillRect(0, 0, W, H);

  // -- 2.2 三圈极淡的参考环 ---------------------------------------------------
  ctx.strokeStyle = 'rgba(120,110,160,0.10)';
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const ref of (Array.isArray(o.ringRadii) && o.ringRadii.length ? o.ringRadii : [290, 448, 600])) {
    circle(cx + panX * zoom, cy + panY * zoom, ref * zoom);
    ctx.stroke();
  }

  // -- 2.3 连线（无向边只画一次） ---------------------------------------------
  // 主干（spine）：两端同属一条主干，或任一端是基石 / 传奇；否则算支线（环缝、跨界连接）。
  const isSpine = (a, b) => {
    const ba = a.branch;
    const bb = b.branch;
    const valid = (x) => x && x !== 'ring' && x !== 'center';
    if (valid(ba) && ba === bb) return true;
    return ba === 'keystone' || bb === 'keystone';
  };
  const edgeStyle = (both, one, spine) => {
    if (both) return spine ? { color: 'rgba(255,214,130,0.92)', width: 3.2 } : { color: 'rgba(226,196,132,0.72)', width: 2.4 };
    if (one) return spine ? { color: 'rgba(150,138,180,0.55)', width: 2.2 } : { color: 'rgba(116,106,146,0.42)', width: 1.6 };
    return spine ? { color: 'rgba(96,90,120,0.42)', width: 1.8 } : { color: 'rgba(76,72,98,0.30)', width: 1.2 };
  };
  const all = Array.isArray(o.nodes) ? o.nodes : (Array.isArray(TALENTS) ? TALENTS : []);
  const seen = new Set();
  for (const t of all) {
    if (!t || !t.id) continue;
    for (const nid of t.neighbors || []) {
      if (!nid || nid === t.id) continue;
      const key = t.id < nid ? `${t.id}|${nid}` : `${nid}|${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = byId[nid];
      if (!b) continue;
      const both = isTaken(t) && isTaken(b);
      const one = !both && (isTaken(t) || isTaken(b));
      const style = edgeStyle(both, one, isSpine(t, b));
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.beginPath();
      ctx.moveTo(sx(t), sy(t));
      ctx.lineTo(sx(b), sy(b));
      ctx.stroke();
      result.edges++;
    }
  }

  // -- 2.4 节点 ---------------------------------------------------------------
  for (const n of all) {
    if (!n || !n.id) continue;
    const x = sx(n);
    const y = sy(n);
    const r = Math.max(3.4, radiusOf(n) * zs);
    const on = isTaken(n);
    const hovered = hoverId === n.id;
    const avail = !on && !!available(n);
    const big = isBig(n);
    const color = colorOf(n);
    const rgb = rgbOf(color);
    const haloR = r * (big ? 3.1 : 2.3);

    // 光晕：已点亮（金）> 可加点（冰蓝）> 悬停/大节点（本色）> 显著（本色淡）
    let glow = null;
    if (on) {
      glow = haloGradient(x, y, haloR, [
        [0, big ? 'rgba(255,190,90,0.55)' : 'rgba(255,206,120,0.40)'],
        [0.45, 'rgba(240,170,70,0.16)'],
        [1, 'rgba(0,0,0,0)'],
      ]);
    } else if (avail) {
      glow = haloGradient(x, y, haloR, [
        [0, 'rgba(120,200,255,0.42)'],
        [0.5, 'rgba(120,200,255,0.12)'],
        [1, 'rgba(0,0,0,0)'],
      ]);
    } else if (hovered || big) {
      glow = haloGradient(x, y, haloR, [
        [0, `rgba(${rgb},0.30)`],
        [1, 'rgba(0,0,0,0)'],
      ]);
    } else if (n.kind === 'notable') {
      glow = haloGradient(x, y, haloR, [
        [0, `rgba(${rgb},0.14)`],
        [1, 'rgba(0,0,0,0)'],
      ]);
    }
    if (glow) {
      circle(x, y, haloR);
      ctx.fillStyle = glow;
      ctx.fill();
    }

    // 形状：小点=圆，显著=菱形，基石/传奇/起点=正六边形（平顶，首顶点朝上）
    if (n.kind === 'minor') {
      circle(x, y, r);
    } else if (n.kind === 'notable') {
      const d = r * 1.05;
      ctx.beginPath();
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
    } else {
      polygon(x, y, r, 6, -90);
    }

    // 填充
    if (on) {
      ctx.fillStyle = haloGradient(x, y, Math.max(1, r), [
        [0, '#fff6dc'],
        [0.45, color],
        [1, shade(color, 0.55)],
      ]);
    } else if (hovered) {
      ctx.fillStyle = withAlpha(color, 0.55);
    } else if (avail) {
      ctx.fillStyle = FILL_AVAILABLE;
    } else {
      ctx.fillStyle = FILL_LOCKED;
    }
    ctx.fill();

    // 描边
    if (on) {
      ctx.strokeStyle = GOLD_BRIGHT;
      ctx.lineWidth = 2.1;
    } else if (hovered) {
      ctx.strokeStyle = HOVER_BLUE;
      ctx.lineWidth = 1.8;
    } else if (avail) {
      ctx.strokeStyle = 'rgba(140,200,255,0.92)';
      ctx.lineWidth = 1.3;
    } else {
      ctx.strokeStyle = withAlpha(color, big ? 0.9 : 0.6);
      ctx.lineWidth = 1.3;
    }
    ctx.stroke();

    // 基石 / 传奇：呼吸环
    if (n.kind === 'keystone' || n.kind === 'legendary') {
      const pulse = 0.5 + 0.5 * Math.sin(time * 2 + num(n.x) * 0.01 + num(n.y) * 0.013);
      circle(x, y, r * (1.85 + pulse * 0.35));
      ctx.strokeStyle = withAlpha(color, on ? 0.55 + pulse * 0.3 : 0.25 + pulse * 0.2);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // 名字：大节点 / 显著 / 悬停 或 放大到 1.25 倍以上
    const labelled = big || n.kind === 'notable' || zoom >= 1.25 || hovered;
    if (labelled && n.name) {
      const fs = Math.round(clamp(11 * Math.min(1.25, zs), 9, 15));
      ctx.font = `${big ? '600 ' : ''}${fs}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const ly = y - r - (big ? 8 : 5);
      ctx.strokeStyle = 'rgba(6,6,10,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeText(n.name, x, ly);
      ctx.fillStyle = on ? '#ffe7a8' : hovered ? '#dcecff' : 'rgba(176,180,204,0.92)';
      ctx.fillText(n.name, x, ly);
      result.names.push(n.name);
    }
    result.nodes++;
  }

  return result;
}

// ============================================================================
// 3) 悬浮提示（纯字符串）
// ============================================================================

/**
 * 天赋节点的悬浮提示 HTML（全部文本都经过 escapeHTML）。
 * 结构：
 *   .tt-head（色条 + 名字 + 类型·位置）
 *   .tt-body（desc 逐行：'【…】' → .tt-cost，其余 → .tt-stat；notable 额外有 .tt-trait）
 *   .tt-foot（状态 + 剩余点数）
 *
 * @param {any} t 天赋节点（null → 空串）
 * @param {{taken?:boolean|Set<string>|string[], points?:number, canTake?:boolean, takenSet?:Set<string>}} [ctx]
 * @returns {string}
 */
export function talentTooltipHTML(t, ctx) {
  if (!t || !t.id) return '';
  const c = ctx || {};
  let taken = !!c.taken;
  if (!taken) {
    if (c.takenSet instanceof Set) taken = c.takenSet.has(t.id);
    else if (Array.isArray(c.taken)) taken = c.taken.indexOf(t.id) >= 0;
    else if (c.taken === t.id) taken = true;
  }
  const points = Math.max(0, Math.floor(num(c.points, 0)));
  const color = colorOf(t);
  const kind = t.kind || 'minor';
  const kindLabel = KIND_LABELS[kind] || '小点';
  const sub = `${kindLabel} · ${branchNameOf(t, c.branches)}`;

  // 描述：'【…】' 行是代价/机制说明，其余是属性行
  const raw = typeof t.desc === 'string' ? t.desc : '';
  const txt = (x) => String(x == null ? '' : x);
  const body = raw.split('\n').map((x) => txt(x).trim()).filter(Boolean);
  if (!body.length) {
    // 数据里没有 desc 时，用 stats 拼几行（老数据 / 测试节点）
    if (t.stats && typeof t.stats === 'object') {
      for (const k in t.stats) {
        const v = t.stats[k];
        if (typeof v !== 'number' || !v || !Number.isFinite(v)) continue;
        const label = STAT_NAMES[k] || k;
        const pctLike = /Mult$|Chance$|resist|Resist|Bonus|leech|Regen|crit/i.test(k);
        const shown = pctLike && Math.abs(v) < 3 ? `${Math.round(v * 1000) / 10}%` : `${v}`;
        body.push(`${label} ${v > 0 ? '+' : ''}${shown}`);
      }
    }
  }
  const htmlBody = body.map((line) => {
    const s = line.trim();
    if (s.charAt(0) === '【') return `<div class="tt-cost">${escapeHTML(s)}</div>`;
    return `<div class="tt-stat">${escapeHTML(s)}</div>`;
  });
  // 显著 / 基石 / 传奇的特殊机制
  const trait = t.notable;
  if (trait && (trait.icon || trait.trait)) {
    const full = txt(trait.trait).trim();
    const head = full ? full.split(/[，。；,;:：]/)[0].slice(0, 14) : kindLabel;
    const icon = trait.icon ? `${escapeHTML(trait.icon)} ` : '';
    htmlBody.push(
      `<div class="tt-trait"><b>${icon}${escapeHTML(head)}</b>`
      + (full && full !== head ? `<span>${escapeHTML(full)}</span>` : '')
      + '</div>',
    );
  }
  if (!htmlBody.length) htmlBody.push('<div class="tt-stat">（无额外效果）</div>');

  // 行末状态：已点亮 / 可加点 / 需要相邻
  let state;
  if (taken) state = '<span class="tt-state taken" style="color:#ffe08a">已点亮</span>';
  else if (c.canTake) state = '<span class="tt-state ok" style="color:#8fd0ff">可加点（1 点）</span>';
  else state = '<span class="tt-state locked" style="color:#8f8a80">需要相邻的已点亮天赋</span>';

  return (
    `<div class="tt-head" style="border-color:${color}">`
    + `<i style="background:${color}"></i>`
    + `<b style="color:${color}">${escapeHTML(t.name || t.id)}</b>`
    + `<em>${escapeHTML(sub)}</em>`
    + '</div>'
    + `<div class="tt-body">${htmlBody.join('')}</div>`
    + `<div class="tt-foot">${state}<span>剩余天赋点：${points}</span></div>`
  );
}

// ============================================================================
// 4) DOM 面板
// ============================================================================

/** 天赋面板当前是否打开。 */
export function isTalentsOpen(ui) {
  return !!ui && ui.modalOpen === 'talents';
}

// 同一时间只允许一个天赋树实例在跑动画循环 / 监听 resize，
// 这样「打开 -> 关闭 -> 再打开」不会叠出多条循环（旧实例在新面板构建前被 dispose）。
let activeDispose = null;

/**
 * 打开（构建）天赋树面板。
 * 需要 ui.el.modalTitle / ui.el.modalBody；ui.game.inv.talents + talentPoints；
 * ui.game.actions.takeTalent(id) / refundTalent(id)（可选，缺了就只有浏览没有交互）。
 * @param {any} ui
 */
export function openTalents(ui) {
  if (!ui) return;
  if (typeof activeDispose === 'function') {
    try { activeDispose(); } catch { /* ignore */ }
  }
  activeDispose = null;

  const game = ui.game || {};
  const inv = game.inv || {};
  const actions = game.actions || {};
  if (!Array.isArray(inv.talents)) inv.talents = [];
  if (typeof inv.talentPoints !== 'number' || !Number.isFinite(inv.talentPoints)) inv.talentPoints = 0;

  const root = (ui.el && ui.el.modalBody) || null;
  if (!root) return;
  if (ui.el.modalTitle) ui.el.modalTitle.textContent = '天赋树';
  try { root.innerHTML = ''; } catch { /* ignore */ }

  // 法师与战士各有一棵天赋树：按当前玩家职业选择（见 items/talentTrees.js）。
  const activePlayer = game.world && game.world.player;
  const tree = talentTreeFor(activePlayer ? activePlayer.type : 'warrior');
  const startNodeId = tree.start;
  if (ui.el.modalTitle) ui.el.modalTitle.textContent = tree.title || '天赋树';

  const byId = Object.assign({}, tree.byId || {});
  const allNodes = [];
  for (const t of tree.nodes || []) if (t && t.id) { byId[t.id] = t; allNodes.push(t); }
  const treeBranches = Array.isArray(tree.branches) ? tree.branches : [];

  // 背景参考环：按树的最大半径生成（战士 290/448/600，法师 300/425/560）。
  let maxR = 0;
  for (const t of allNodes) maxR = Math.max(maxR, num(t.radius, 0));
  const ringRadii = tree.id === 'mage' ? [300, 425, Math.max(560, maxR)] : [290, 448, Math.max(600, maxR)];

  // -- 4.1 DOM 骨架 ---------------------------------------------------------
  const wrap = el('div', { class: 'talent-wrap' });

  const canvasBox = el('div', { class: 'talent-canvas-box' });
  let canvas = null;
  try { canvas = document.createElement('canvas'); } catch { canvas = null; }
  if (!canvas) return;
  canvas.className = 'talent-canvas';
  canvas.setAttribute('width', '900');
  canvas.setAttribute('height', '600');
  canvasBox.appendChild(canvas);

  // 悬浮提示框：样式表把它默认贴在左下角，这里用内联样式改成跟随鼠标
  const info = el('div', { class: 'talent-info hidden' });
  info.setAttribute('style', 'left:auto;bottom:auto;top:0;max-width:300px;width:max-content;z-index:3;'
    + 'padding:9px 11px;border:1px solid rgba(217,180,99,.4);box-shadow:0 10px 26px rgba(0,0,0,.7)');
  canvasBox.appendChild(info);

  const hint = el('div', {
    class: 'talent-hint',
    text: '拖动平移 · 滚轮缩放 · 点击加点 · Shift+点击 退点',
  });
  hint.setAttribute('style', 'position:absolute;right:10px;bottom:8px;font-size:11px;letter-spacing:.04em;'
    + 'color:rgba(160,148,120,.75);pointer-events:none;text-shadow:0 1px 2px #000');
  canvasBox.appendChild(hint);

  // 右侧栏：点数 -> 说明 -> 图例 -> 主干色标 -> 进度 -> 按钮
  const side = el('div', { class: 'talent-side' });
  const head = el('h3');
  head.innerHTML = `剩余点数 <b class="pts">${escapeHTML(String(inv.talentPoints))}</b>`;
  side.appendChild(head);

  side.appendChild(el('p', {
    class: 'talent-tip',
    text: '点击节点消耗 1 点天赋点，只能点亮与已点亮节点相邻的节点。按住 Shift 点击已点亮的节点可退还该点（起点不可退还）。',
  }));

  const legend = el('div', { class: 'legend' });
  for (const kind of ['classStart', 'minor', 'notable', 'keystone', 'legendary']) {
    const row = el('div');
    row.innerHTML = `<i style="background:${KIND_COLORS[kind]};color:${KIND_COLORS[kind]}"></i>`
      + `${escapeHTML(KIND_LABELS[kind])} · ${escapeHTML(kindDescOf(kind))}`;
    legend.appendChild(row);
  }
  side.appendChild(legend);

  // 各主干：色点 + 名字
  const branchRow = el('div', { class: 'talent-legend-branches' });
  branchRow.setAttribute('style', 'display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11.5px;color:var(--text-dim,#8f8a80)');
  for (const b of treeBranches) {
    if (!b || !b.id) continue;
    const chip = el('span');
    chip.innerHTML = `<i style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;`
      + `vertical-align:middle;background:${escapeHTML(b.color || '#888')}"></i>${escapeHTML(b.name || b.id)}`;
    if (b.desc) chip.setAttribute('title', `${b.name}：${b.desc}`);
    branchRow.appendChild(chip);
  }
  side.appendChild(branchRow);

  const progress = el('div', { class: 'talent-progress' });
  const takenRow = el('div');
  takenRow.innerHTML = '已点亮 <b class="taken">0</b>';
  const bigRow = el('div');
  bigRow.innerHTML = '基石 / 传奇 <b class="big">0</b>';
  progress.appendChild(takenRow);
  progress.appendChild(bigRow);
  progress.setAttribute('style', 'display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;font-size:11.5px;'
    + 'color:var(--text-dim,#8f8a80);padding:6px 0;border-top:1px solid rgba(160,140,100,.16);'
    + 'border-bottom:1px solid rgba(160,140,100,.16)');
  for (const b of queryAll(progress, 'b')) b.setAttribute('style', 'color:#ffb547;font-variant-numeric:tabular-nums;margin-left:4px');
  side.appendChild(progress);

  const btnBox = el('div', { class: 'talent-actions' });
  btnBox.setAttribute('style', 'display:flex;flex-direction:column;gap:8px;margin-top:auto;padding-top:8px');
  const btnRefund = el('button', { class: 'btn-mini', text: '撤回最后一点' });
  btnRefund.setAttribute('id', 'talent-refund');
  btnRefund.setAttribute('type', 'button');
  const btnReset = el('button', { class: 'btn-mini', text: '重置全部天赋' });
  btnReset.setAttribute('id', 'talent-reset');
  btnReset.setAttribute('type', 'button');
  const btnClose = el('button', { class: 'btn-mini', text: '关闭' });
  btnClose.setAttribute('id', 'talent-close');
  btnClose.setAttribute('type', 'button');
  btnBox.appendChild(btnRefund);
  btnBox.appendChild(btnReset);
  btnBox.appendChild(btnClose);
  side.appendChild(btnBox);

  wrap.appendChild(canvasBox);
  wrap.appendChild(side);
  root.appendChild(wrap);

  // -- 4.2 视图状态 ---------------------------------------------------------
  const view = { panX: 0, panY: 0, zoom: 0.62, dragging: false, moved: 0, lx: 0, ly: 0, hover: null, mouse: null };
  let time = 0;
  let rafId = null;
  let lastNow = 0;
  let disposed = false;
  let ctx2d = null;

  const ready = () => !disposed && !!canvas && canvas.isConnected !== false;
  const takenSet = () => new Set(Array.isArray(inv.talents) ? inv.talents : []);
  const pointsNow = () => Math.max(0, Math.floor(num(inv.talentPoints, 0)));
  const isTaken = (t) => !!t && Array.isArray(inv.talents) && inv.talents.indexOf(t.id) >= 0;
  const canTake = (t) => {
    if (!t || isTaken(t)) return false;
    if (pointsNow() <= 0) return false;
    for (const id of t.neighbors || []) if (isTaken(byId[id])) return true;
    return false;
  };
  const cssW = () => Math.max(1, num(canvas.clientWidth, 0) || num(canvas.offsetWidth, 0) || 900);
  const cssH = () => Math.max(1, num(canvas.clientHeight, 0) || num(canvas.offsetHeight, 0) || 600);

  /** 让整棵树正好塞进画布（按实际节点包围盒计算，法师树与战士树共用）。 */
  function fit() {
    let extX = 1;
    let extY = 1;
    for (const n of allNodes) {
      extX = Math.max(extX, Math.abs(num(n.x, 0)));
      extY = Math.max(extY, Math.abs(num(n.y, 0)));
    }
    const margin = 70;
    view.zoom = clamp(Math.min((cssW() / 2 - margin) / extX, (cssH() / 2 - margin) / extY), 0.2, 1.4);
    view.panX = 0;
    view.panY = 0;
  }

  function getCtx() {
    try {
      if (typeof canvas.getContext !== 'function') return null;
      return canvas.getContext('2d') || null;
    } catch {
      return null;
    }
  }

  /** 按 DPR 调整后备缓冲，并把 ctx 变换成 CSS 像素空间。 */
  function resize() {
    if (disposed) return;
    const dpr = (typeof window !== 'undefined' && window && Number(window.devicePixelRatio) > 0)
      ? Math.min(2, Number(window.devicePixelRatio))
      : 1;
    canvas.width = Math.max(1, Math.round(cssW() * dpr));
    canvas.height = Math.max(1, Math.round(cssH() * dpr));
    ctx2d = getCtx();
    if (ctx2d && typeof ctx2d.setTransform === 'function') ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // -- 4.3 渲染 -------------------------------------------------------------
  function render() {
    if (disposed) return;
    if (!ctx2d) ctx2d = getCtx();
    const w = cssW();
    const h = cssH();
    if (ctx2d) {
      try {
        ctx2d.clearRect(0, 0, w, h);
        drawTalentMap(ctx2d, {
          width: w,
          height: h,
          view: { panX: view.panX, panY: view.panY, zoom: view.zoom, hover: view.hover },
          taken: takenSet(),
          available: canTake,
          byId,
          nodes: allNodes,
          ringRadii,
          time,
        });
      } catch { /* 桩 ctx 可能缺方法：画不出来也不能崩面板 */ }
    }
    refreshSide();
  }

  function refreshSide() {
    const pts = pointsNow();
    for (const e of queryAll(side, '.pts')) e.textContent = String(pts);
    const allocated = Array.isArray(inv.talents) ? inv.talents : [];
    const startOn = allocated.indexOf(startNodeId) >= 0;
    const takenCount = Math.max(0, allocated.length - (startOn ? 1 : 0));
    let bigCount = 0;
    for (const id of allocated) {
      const n = byId[id];
      if (n && (n.kind === 'keystone' || n.kind === 'legendary')) bigCount++;
    }
    for (const e of queryAll(side, '.taken')) e.textContent = String(takenCount);
    for (const e of queryAll(side, '.big')) e.textContent = String(bigCount);
    if (head.classList && typeof head.classList.toggle === 'function') head.classList.toggle('empty', pts <= 0);
  }

  // -- 4.4 悬浮提示（跟随鼠标） ----------------------------------------------
  function refreshInfo() {
    const t = view.hover ? byId[view.hover.id] : null;
    if (!t || view.dragging) {
      info.classList.add('hidden');
      return;
    }
    info.classList.remove('hidden');
    info.innerHTML = talentTooltipHTML(t, {
      taken: isTaken(t), points: pointsNow(), canTake: canTake(t), branches: treeBranches,
    });
    placeInfo();
  }

  /** 放到鼠标附近；靠近右 / 下边界时翻到另一侧。 */
  function placeInfo() {
    if (!view.mouse) return;
    const boxW = Math.max(1, num(canvasBox.clientWidth, 0) || cssW());
    const boxH = Math.max(1, num(canvasBox.clientHeight, 0) || cssH());
    const tw = num(info.offsetWidth, 0) || 250;
    const th = num(info.offsetHeight, 0) || 150;
    const mx = view.mouse.x;
    const my = view.mouse.y;
    let left = mx + 16;
    let top = my + 16;
    if (left + tw > boxW - 8) left = mx - tw - 16;
    if (top + th > boxH - 8) top = my - th - 16;
    left = clamp(left, 8, Math.max(8, boxW - tw - 8));
    top = clamp(top, 8, Math.max(8, boxH - th - 8));
    info.style.position = 'absolute';
    info.style.left = `${Math.round(left)}px`;
    info.style.top = `${Math.round(top)}px`;
    info.style.bottom = 'auto';
  }

  // -- 4.5 命中测试 ---------------------------------------------------------
  function pick(mx, my) {
    const z = clamp(view.zoom, 0.2, 3);
    const w = cssW();
    const h = cssH();
    let best = null;
    let bestD = Infinity;
    for (const n of allNodes) {
      const px = w / 2 + (num(n.x) + view.panX) * view.zoom;
      const py = h / 2 + (num(n.y) + view.panY) * view.zoom;
      // 容差随缩放收缩：缩到看全图时节点间距只有 ~10~30px，给太大会点到隔壁节点
      const reach = Math.max(5, radiusOf(n) * z) + (view.zoom >= 0.9 ? 7 : view.zoom >= 0.55 ? 4 : 2);
      const dx = px - mx;
      const dy = py - my;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= reach && d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // -- 4.6 交互 -------------------------------------------------------------
  const localXY = (ev) => {
    let lx = num(ev.offsetX, NaN);
    let ly = num(ev.offsetY, NaN);
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) {
      try {
        const r = canvas.getBoundingClientRect();
        lx = num(ev.clientX, 0) - num(r.left, 0);
        ly = num(ev.clientY, 0) - num(r.top, 0);
      } catch {
        lx = num(ev.clientX, 0);
        ly = num(ev.clientY, 0);
      }
    }
    return { x: lx, y: ly };
  };
  const setCursor = (v) => { if (canvas.style) canvas.style.cursor = v; };

  function setHover(node) {
    const prev = view.hover;
    if ((prev && prev.id) === (node && node.id)) return;
    view.hover = node || null;
    refreshInfo();
    render();
  }

  function onMouseDown(ev) {
    if (!ready()) return;
    const p = localXY(ev);
    view.dragging = true;
    view.moved = 0;
    view.lx = p.x;
    view.ly = p.y;
    view.mouse = p;
    info.classList.add('hidden');
    setCursor('grabbing');
  }

  function onMouseMove(ev) {
    if (!ready()) return;
    const p = localXY(ev);
    view.mouse = p;
    if (view.dragging) {
      const dx = p.x - view.lx;
      const dy = p.y - view.ly;
      view.lx = p.x;
      view.ly = p.y;
      view.moved += Math.sqrt(dx * dx + dy * dy);
      view.panX += dx / view.zoom;
      view.panY += dy / view.zoom;
      render();
      return;
    }
    const node = pick(p.x, p.y);
    setCursor(node ? 'pointer' : 'grab');
    setHover(node);
    if (view.hover) placeInfo();
  }

  function onMouseUp(ev) {
    if (disposed || !canvas) return;
    const wasDragging = view.dragging;
    view.dragging = false;
    if (!wasDragging) return;
    setCursor('grab');
    const moved = view.moved;
    view.moved = 0;
    if (moved > 6) return; // 拖过 -> 不当作点击
    const p = localXY(ev);
    const node = pick(p.x, p.y);
    if (!node) return;
    let changed = false;
    if (isTaken(node)) {
      if (ev.shiftKey && node.id !== startNodeId && actions && typeof actions.refundTalent === 'function') {
        try { changed = actions.refundTalent(node.id) === true; } catch { changed = false; }
      }
    } else if (actions && typeof actions.takeTalent === 'function') {
      try { changed = actions.takeTalent(node.id) === true; } catch { changed = false; }
    }
    if (changed) {
      view.hover = byId[node.id] || null;
      render();
      refreshInfo();
    }
  }

  function onMouseLeave() {
    if (view.dragging) return;
    view.mouse = null;
    view.hover = null;
    info.classList.add('hidden');
    render();
  }

  /** 以画布坐标 (px,py) 为锚点缩放。 */
  function zoomAt(px, py, factor) {
    const nz = clamp(view.zoom * factor, 0.22, 2.6);
    if (nz === view.zoom) return;
    const wx = (px - cssW() / 2) / view.zoom - view.panX;
    const wy = (py - cssH() / 2) / view.zoom - view.panY;
    view.zoom = nz;
    view.panX = (px - cssW() / 2) / nz - wx;
    view.panY = (py - cssH() / 2) / nz - wy;
    render();
    refreshInfo();
  }

  function onWheel(ev) {
    if (!ready()) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    const dy = num(ev.deltaY, 0);
    if (!dy) return;
    const p = localXY(ev);
    view.mouse = p;
    zoomAt(p.x, p.y, dy < 0 ? 1.14 : 1 / 1.14);
  }

  /** 撤回最后一点：从后往前找第一个能退的（跳过起点）。 */
  function refundLast() {
    if (!actions || typeof actions.refundTalent !== 'function') return false;
    const list = Array.isArray(inv.talents) ? inv.talents.slice() : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i];
      if (!id || id === startNodeId) continue;
      let ok = false;
      try { ok = actions.refundTalent(id) === true; } catch { ok = false; }
      if (ok) { render(); refreshInfo(); return true; }
    }
    return false;
  }

  /**
   * 重置：反复退掉「叶子」（没有其它已点亮节点依赖它），直到一整轮都退不动。
   * 起点永远保留；最多 400 次，防止 actions 实现异常导致死循环。
   */
  function resetAll() {
    if (!actions || typeof actions.refundTalent !== 'function') return 0;
    let count = 0;
    for (let guard = 0; guard < 400; guard++) {
      const allocated = takenSet();
      const cands = [];
      for (const id of allocated) {
        if (id === startNodeId) continue;
        const n = byId[id];
        if (!n) continue;
        let leaf = true;
        for (const other of allocated) {
          if (other === id) continue;
          const o2 = byId[other];
          if (o2 && (o2.neighbors || []).indexOf(id) >= 0) { leaf = false; break; }
        }
        if (leaf) cands.push(id);
      }
      if (!cands.length) break;
      let progressed = false;
      for (const id of cands) {
        let ok = false;
        try { ok = actions.refundTalent(id) === true; } catch { ok = false; }
        if (ok) { count++; progressed = true; }
        if (count >= 400) break;
      }
      if (!progressed || count >= 400) break;
    }
    render();
    refreshInfo();
    return count;
  }

  // 事件绑定（全部登记下来，dispose 时统一解绑）
  const offs = [];
  const on = (target, type, fn, opts) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    offs.push(() => { try { target.removeEventListener(type, fn, opts); } catch { /* ignore */ } });
  };
  on(canvas, 'mousedown', onMouseDown);
  on(canvas, 'mousemove', onMouseMove);
  on(canvas, 'mouseleave', onMouseLeave);
  on(canvas, 'wheel', onWheel, { passive: false });
  on(canvas, 'contextmenu', (ev) => { if (ev && typeof ev.preventDefault === 'function') ev.preventDefault(); });
  const win = typeof window !== 'undefined' ? window : null;
  // 抬键可能落在画布外：同时挂在 window 上
  on(win || canvas, 'mouseup', onMouseUp);
  on(btnRefund, 'click', () => { refundLast(); });
  on(btnReset, 'click', () => { resetAll(); });
  on(btnClose, 'click', () => {
    try {
      if (typeof ui.closeModals === 'function') ui.closeModals();
      else ui.modalOpen = null;
    } catch { /* ignore */ }
  });
  const onResize = () => {
    if (!ready()) return;
    resize();
    render();
    refreshInfo();
  };
  on(win, 'resize', onResize);

  // -- 4.7 动画循环 / 清理 --------------------------------------------------
  function schedule() {
    if (disposed) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null);
    if (!raf) { rafId = null; return; }
    try { rafId = raf(loop); } catch { rafId = null; }
  }

  function loop(now) {
    rafId = null;
    if (disposed) return;
    if (!ready()) { dispose(); return; }
    const t = num(now, 0) / 1000;
    let dt = lastNow ? t - lastNow : 0;
    if (!(dt > 0)) dt = 0;
    time += Math.min(0.1, dt);
    lastNow = t;
    render();
    schedule();
  }

  // 500ms 看门狗：面板被从别处移除时停掉循环、定时器和 resize 监听
  let watchdog = null;
  function checkAlive() {
    if (disposed) return;
    if (canvas.isConnected === false) { dispose(); return; }
    if (wrap.isConnected === false && root && wrap.parentNode !== root) dispose();
  }
  if (typeof setInterval === 'function') {
    try { watchdog = setInterval(checkAlive, 500); } catch { watchdog = null; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (rafId != null && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(rafId); } catch { /* ignore */ }
    }
    rafId = null;
    if (watchdog != null && typeof clearInterval === 'function') {
      try { clearInterval(watchdog); } catch { /* ignore */ }
    }
    watchdog = null;
    for (const off of offs) off();
    offs.length = 0;
    if (activeDispose === dispose) activeDispose = null;
  }
  activeDispose = dispose;

  // 首帧：同步量尺寸并画出来（不依赖 rAF），然后启动动画循环
  resize();
  fit();
  render();
  schedule();
}

/** 图例里每个类型的说明文字。 */
function kindDescOf(kind) {
  return {
    classStart: '旅程的起点',
    minor: '常规属性',
    notable: '强力加成',
    keystone: '改变玩法',
    legendary: '独特机制',
  }[kind] || '';
}

/**
 * querySelectorAll 的安全包装（NodeList / 桩列表不一定可展开）。
 * @returns {any[]}
 */
function queryAll(node, sel) {
  if (!node || typeof node.querySelectorAll !== 'function') return [];
  let list;
  try { list = node.querySelectorAll(sel); } catch { return []; }
  if (!list) return [];
  const out = [];
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}

export default {
  isTalentsOpen,
  openTalents,
  drawTalentMap,
  talentTooltipHTML,
  KIND_COLORS,
  KIND_LABELS,
  NODE_RADII,
  colorOf,
  radiusOf,
};