// DOM 工具：小工具函数
import { itemScore } from '../items/itemgen.js';
import { PERCENT_KEYS, fmt, fmtPct, fmtSigned } from '../items/common.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $ALL = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

const RARITY_COLORS = { normal: '#c8c8c8', magic: '#8888ff', rare: '#ffff77', unique: '#af6025', legendary: '#c06000' };

export function rarityColor(r) {
  return RARITY_COLORS[r] || RARITY_COLORS.normal;
}

export function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtNum(n, digits = 0) {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}

export function pct(n, digits = 0) {
  return (n * 100).toFixed(digits) + '%';
}

/**
 * 把技能栏角标（.slot .key）写成真实键位，并给格子/角标挂悬停提示。
 *
 * 【为什么需要"自己往后代找"】浏览器里 `slot.querySelector('.key')` 就够，但有些简化 DOM 桩
 * （tools/skill-slot-check.mjs 用的导航型桩）节点自身的 querySelector 只搜**子节点**、
 * 不认 `.a .b` 这类后代组合，于是查不到 .key。这里先走节点 API，查不到再按
 * children/className 手动下探一层，浏览器与桩环境行为一致。
 *
 * 键位来自 src/game/input.js 的 SKILL_KEYS（Q/W/E/R/T），调用方传进来，避免 dom.js 反向依赖输入层。
 * 任何 DOM 缺席都静默跳过（纯装饰，绝不能影响游戏逻辑）。
 * @param {Array<any>} slots 技能栏格子（按顺序：0~4 技能、5 翻滚、6 回城）
 * @param {Array<{label:string}>} skillKeys 技能键表
 * @param {Array<{name?:string}>} bar 当前技能栏实例（取技能名做提示）
 */
export function syncSkillSlotLabels(slots, skillKeys, bar) {
  if (!Array.isArray(slots) || !slots.length) return;
  const keys = Array.isArray(skillKeys) ? skillKeys : [];
  const insts = Array.isArray(bar) ? bar : [];
  /** 在 slot 下找 class 含 cls 的元素（先节点 API，再一层下探，最后整棵子树） */
  const findChild = (slot, cls) => {
    try {
      if (typeof slot.querySelector === 'function') {
        const n = slot.querySelector('.' + cls);
        if (n) return n;
      }
    } catch { /* 桩不支持选择器 */ }
    const kids = Array.isArray(slot.children) ? slot.children : [];
    const hit = kids.find((c) => c && String(c.className || '').split(/\s+/).includes(cls));
    if (hit) return hit;
    for (const c of kids) {
      const grand = c && Array.isArray(c.children) ? c.children : [];
      const g = grand.find((x) => x && String(x.className || '').split(/\s+/).includes(cls));
      if (g) return g;
    }
    return null;
  };
  slots.forEach((slot, i) => {
    try {
      if (!slot) return;
      const keyEl = findChild(slot, 'key');
      let label = null;
      let hint = '';
      if (i < keys.length) {
        label = keys[i].label;
        hint = `${label} 释放 ${(insts[i] && insts[i].name) || '（空技能位）'}（数字键 ${i + 1} 也可以）`;
      } else if (i === 5) {
        label = '空格';
        hint = '空格 翻滚（0.18 秒无敌）';
      } else if (i === 6) {
        label = '🏕';
        hint = '点此回城 / 开启战斗地图（或按 T）';
      }
      if (keyEl && label) keyEl.textContent = label;
      if (hint) {
        slot.title = hint;
        if (keyEl) keyEl.title = hint;
      }
    } catch { /* 纯装饰 */ }
  });
}

/** 对比行里显示的统计键顺序（重要属性在前）。 */
const COMPARE_STAT_ORDER = Object.freeze([
  'life', 'lifeRegen', 'mana', 'manaRegen', 'energyShield',
  'armor', 'evasion', 'blockChance',
  'attackSpeedMult', 'critChance', 'critMulti', 'moveSpeedMult',
  'physDamageMult', 'fireDamageMult', 'coldDamageMult', 'lightningDamageMult', 'chaosDamageMult',
  'aoeMult', 'areaDamageMult', 'dotMult', 'skillLevelBonus',
  'lifeLeech', 'lifeOnHit', 'cdrMult', 'projectileSpeedMult', 'thorns',
  'damageMult', 'damageTakenMult', 'maxResistance',
  'fireResist', 'coldResist', 'lightningResist', 'chaosResist',
  'rarityBonus', 'xpBonus', 'quantityBonus', 'goldFind',
]);

/** 对比行里统计键 → 中文名。 */
const COMPARE_STAT_ZH = Object.freeze({
  life: '生命', lifeRegen: '生命回复', mana: '法力', manaRegen: '法力回复', energyShield: '能量护盾',
  armor: '护甲', evasion: '闪避率', blockChance: '格挡率',
  attackSpeedMult: '攻击速度', critChance: '暴击率', critMulti: '暴击伤害',
  moveSpeedMult: '移动速度', physDamageMult: '物理伤害',
  fireDamageMult: '火焰伤害', coldDamageMult: '冰霜伤害', lightningDamageMult: '闪电伤害', chaosDamageMult: '混沌伤害',
  aoeMult: '范围效果', areaDamageMult: '范围伤害', dotMult: '持续伤害', skillLevelBonus: '技能等级',
  lifeLeech: '生命偷取', lifeOnHit: '击中回复', cdrMult: '冷却缩减',
  projectileSpeedMult: '投射物速度', thorns: '荆棘',
  damageMult: '全局伤害', damageTakenMult: '承受伤害', maxResistance: '抗性上限',
  fireResist: '火焰抗性', coldResist: '冰霜抗性', lightningResist: '闪电抗性', chaosResist: '混沌抗性',
  rarityBonus: '物品稀有度', xpBonus: '获得经验', quantityBonus: '物品数量', goldFind: '硫磺碎片',
});

/** 成对出现的附加伤害键：对比时合并成「附加火焰伤害 +3~+6」一行。 */
const COMPARE_DAMAGE_PAIRS = Object.freeze([
  { min: 'physAddedMin', max: 'physAddedMax', label: '附加物理伤害' },
  { min: 'addedFireMin', max: 'addedFireMax', label: '附加火焰伤害' },
  { min: 'addedColdMin', max: 'addedColdMax', label: '附加冰霜伤害' },
  { min: 'addedLightningMin', max: 'addedLightningMax', label: '附加闪电伤害' },
]);

/**
 * 物品的总属性（item.stats 已包含基底 + 词缀，implicit 单独再加一次）。
 * 注意不能再加 item.mods：itemgen 的 mergeStats 已经把词缀并进 item.stats 了。
 * @param {any} item
 * @returns {Record<string, number>}
 */
function itemTotalStats(item) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!item || typeof item !== 'object') return out;
  const add = (src) => {
    if (!src || typeof src !== 'object') return;
    for (const k in src) {
      const v = Number(src[k]);
      if (Number.isFinite(v) && v !== 0) out[k] = (out[k] || 0) + v;
    }
  };
  add(item.stats);
  add(item.implicit && item.implicit.stats);
  return out;
}

/** 武器的每秒伤害（没有 damage 字段时用 dmgMin/dmgMax 估算平均值）。 */
function itemDpsValue(item) {
  if (!item || typeof item !== 'object') return 0;
  if (item.damage && Number.isFinite(item.damage.dps)) return item.damage.dps;
  if (Number.isFinite(item.dmgMin) && Number.isFinite(item.dmgMax) && item.dmgMin + item.dmgMax > 0) {
    return (item.dmgMin + item.dmgMax) / 2;
  }
  return 0;
}

/**
 * 当前装备对比块：战力差值 + 武器 DPS 差值 + 逐条属性差值。
 * current 为 null 表示该部位还没装备，此时给出「装备后战力」。
 *
 * @param {any} candidate 正在查看的物品
 * @param {any|null} current 当前穿在对应槽位的物品
 * @returns {string} HTML 字符串（无 candidate 时返回空串）
 */
export function itemCompareHTML(candidate, current) {
  if (!candidate) return '';
  const out = ['<div class="tt-compare">'];
  const score = itemScore(candidate);
  if (!current) {
    out.push('<div class="tt-cmp-title">当前装备：<span class="eq">无</span></div>');
    out.push(`<div class="tt-cmp-line good">装备后战力 ${score}</div>`);
    out.push('</div>');
    return out.join('');
  }

  const curScore = itemScore(current);
  const diff = score - curScore;
  const tone = diff > 0 ? 'good' : diff < 0 ? 'bad' : 'eq';
  const word = diff > 0 ? '提升' : diff < 0 ? '下降' : '持平';
  out.push(`<div class="tt-cmp-title">对比当前装备：<span style="color:${rarityColor(current.rarity)}">${escapeHTML(current.name)}</span></div>`);
  out.push(`<div class="tt-cmp-line ${tone}">战力 ${curScore} → ${score}（${diff > 0 ? '+' : ''}${diff}，${word}）</div>`);

  // 武器：DPS 差值（非武器两端都是 0，自动跳过）
  const cd = itemDpsValue(candidate);
  const pd = itemDpsValue(current);
  const dd = Math.round((cd - pd) * 10) / 10;
  if (dd !== 0) out.push(`<div class="tt-cmp-line ${dd > 0 ? 'good' : 'bad'}">每秒伤害 ${fmtSigned(dd)}</div>`);

  // 逐条属性差值（只显示有变化的）
  const a = itemTotalStats(candidate);
  const b = itemTotalStats(current);
  for (const k of COMPARE_STAT_ORDER) {
    const d = Math.round(((a[k] || 0) - (b[k] || 0)) * 1000) / 1000;
    if (!d) continue;
    const zh = COMPARE_STAT_ZH[k];
    if (!zh) continue;
    const pct = PERCENT_KEYS.has(k);
    // 承受伤害是「越低越好」，颜色要反过来
    const good = k === 'damageTakenMult' ? d < 0 : d > 0;
    out.push(`<div class="tt-cmp-line ${good ? 'good' : 'bad'}">${escapeHTML(zh)} ${fmtSigned(d, pct ? fmtPct : fmt)}${pct ? '%' : ''}</div>`);
  }

  // 附加伤害成对显示（min~max 的差值），避免拆成两行噪声
  for (const pair of COMPARE_DAMAGE_PAIRS) {
    const dMin = Math.round(((a[pair.min] || 0) - (b[pair.min] || 0)) * 10) / 10;
    const dMax = Math.round(((a[pair.max] || 0) - (b[pair.max] || 0)) * 10) / 10;
    if (!dMin && !dMax) continue;
    const good = dMin + dMax > 0;
    const lo = Math.min(dMin, dMax);
    const hi = Math.max(dMin, dMax);
    const range = lo === hi ? fmtSigned(lo) : (lo === 0 ? fmtSigned(hi) : hi === 0 ? fmtSigned(lo) : `${fmtSigned(lo)}~${fmtSigned(hi)}`);
    out.push(`<div class="tt-cmp-line ${good ? 'good' : 'bad'}">${escapeHTML(pair.label)} ${range}</div>`);
  }
  out.push('</div>');
  return out.join('');
}

/**
 * 物品悬浮提示 HTML。
 *
 * @param {any} item 物品
 * @param {any|null} [compare=null] 当前装备（用于对比）
 * @param {{compare?: boolean}} [opts] compare:true 时才渲染对比块（自己身上的装备不需要对比自己）
 * @returns {string}
 */
export function itemTooltipHTML(item, compare = null, opts = {}) {
  if (!item) return '';
  const color = rarityColor(item.rarity);
  const lines = [];
  lines.push(`<div class="tt-name" style="color:${color}">${escapeHTML(item.name)}</div>`);
  const rarityName = { normal: '普通', magic: '魔法', rare: '稀有', unique: '传奇' }[item.rarity] || '普通';
  lines.push(`<div class="tt-sub">${escapeHTML(rarityName)} ${escapeHTML(item.slotName || item.slot || '')}${item.itemLevel ? ' · 物品等级 ' + item.itemLevel : ''}</div>`);
  if (item.implicit?.text) lines.push(`<div class="tt-line implicit">${escapeHTML(item.implicit.text)}</div>`);
  if (item.dmgMin != null && item.dmgMax != null) {
    lines.push(`<div class="tt-line">基础伤害 ${Math.round(item.dmgMin)}-${Math.round(item.dmgMax)}</div>`);
  }
  const seen = new Set();
  for (const m of item.mods || []) {
    const t = m.text || '';
    if (!t || seen.has(t)) continue;
    seen.add(t);
    lines.push(`<div class="tt-line">${escapeHTML(t)}</div>`);
  }
  for (const line of item.affixLines || []) {
    const t = typeof line === 'string' ? line : line.text;
    if (!t || seen.has(t)) continue;
    seen.add(t);
    lines.push(`<div class="tt-line">${escapeHTML(t)}</div>`);
  }
  if (item.flavor) lines.push(`<div class="tt-flavor">${escapeHTML(item.flavor)}</div>`);
  if (opts && opts.compare) lines.push(itemCompareHTML(item, compare));
  return `<div class="item-tooltip rarity-${item.rarity}">${lines.join('')}</div>`;
}