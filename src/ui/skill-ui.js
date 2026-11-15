// @file src/ui/skill-ui.js
// 技能面板：每个技能一个标签页 = 技能卡（等级/精炼/数值摘要）+ 分叉天赋树 + 底部资源栏。
//
// 【为什么整体重写】
//   旧实现只按 requires 层级横排节点，既表达不出「左支 / 右支 / 互斥」的分叉拓扑，
//   也没有精炼、互斥锁定提示、新手引导这些新机制。新面板固定成两列分支布局：
//     ROOT 居中上方 → 左支在左 / 右支在右 → 分支专精在最下两侧 → 终极节点居中底部。
//
// 【防御式依赖（重要）】
//   本文件与 core-dev / data-dev 的模块并行开发，对方的新导出随时可能还没落地。
//   因此所有跨模块引用都用「命名空间 import + 调用前判型 + 本地兜底」：
//     import * as skillTreeMod from '../items/skillTree.js';
//     const fn = skillTreeMod.skillNodeConflict;
//     if (typeof fn === 'function') { ... } else { 本地兜底实现 }
//   这样即使对方文件还是旧版（缺导出），甚至整个模块暂时消失，面板依然能渲染。

import { el, escapeHTML } from './dom.js';
import { playSfx } from './sfx.js';
// 命名空间导入：对方新增导出时不会因为具名 import 缺失而让整个 bundle 崩溃
import * as skillTreeMod from '../items/skillTree.js';
import * as skillsMod from '../core/skills.js';
import * as progressionMod from '../items/skillProgression.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 技能等级上限（progression 模块存在时以它为准） */
const FALLBACK_LEVEL_CAP = 5;
/** 精炼上限（0..4，即 4 个精炼格） */
const FALLBACK_REFINE_MAX = 4;
/** 无 progression 模块时的精炼花费表：把技能从 1 级精炼到 2/3/4/5 级各需要几颗石头 */
const FALLBACK_REFINE_COST = { 0: 3, 1: 4, 2: 6, 3: 8 };

/** 引导条的 localStorage 键（取不到 localStorage 就每次当首次，见 shouldShowGuide） */
const GUIDE_KEY = 'ember_skill_guide_seen';

/** 分叉树画布尺寸（px，滚动容器负责横向溢出） */
const TREE_W = 860;
const TREE_H = 470;

/**
 * 节点盒子高度兜底值（px）。连线端点取「节点盒子中心」= top + 高度/2；
 * 面板是脱离文档构建的（buildTree 返回后才挂到 modalBody），那一刻 offsetHeight 还是 0，
 * 所以实际用得上这个值：44 ≈ .tree-node 的真实高度（5px padding×2 + 边框 3px + 两行文字，实测 44~45px）。
 * 即使字体/缩放让实际高度漂几个像素，端点仍在盒子内部，线依旧是接上的。
 */
const NODE_H_FALLBACK = 44;

/**
 * 分支视觉定义：颜色 + 中文名 + 布局槽位。
 * 颜色刻意与 --gold(核心/终极) 拉开：左支用热血暗红（震怒），右支用钢蓝（壁垒）。
 * @type {Record<string, {label:string, color:string, side:-1|0|1, row:number}>}
 */
const BRANCH_META = {
  core: { label: '核心', color: '#d9b463', side: 0, row: 0 },
  left: { label: '左·震怒', color: '#e2643f', side: -1, row: 1 },
  leftDeep: { label: '左·专精', color: '#ff9a5c', side: -1, row: 2 },
  right: { label: '右·壁垒', color: '#5aa2e8', side: 1, row: 1 },
  rightDeep: { label: '右·专精', color: '#8fd0ff', side: 1, row: 2 },
  ultimate: { label: '终极', color: '#ffe9a8', side: 0, row: 3 },
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 保留 n 位小数并去掉末尾 0（用于数值摘要，避免出现「1.23000000001」）。
 * @param {number} v @param {number} [n=1]
 */
function fmt(v, n = 1) {
  if (!Number.isFinite(v)) return '0';
  const s = v.toFixed(n);
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * 符号化百分比：0.15 → '+15%'，-0.2 → '-20%'（用于天赋效果描述的回退文本）。
 * @param {number} v
 */
function signedPct(v) {
  const p = Math.round(v * 100);
  return (p > 0 ? '+' : '') + p + '%';
}

/**
 * 安全读 localStorage：桩环境里 localStorage 可能是 null，隐私模式会抛异常。
 * @param {string} key
 * @returns {string|null}
 */
function lsGet(key) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 安全写 localStorage（失败就算了，引导条下次还会出现，不影响游戏）。
 * @param {string} key @param {string} val
 */
function lsSet(key, val) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return;
    localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}

/**
 * 调一层可能不存在的游戏动作（app 层正在并行开发，动作名不保证齐全）。
 * 任何异常都吞掉并返回 undefined —— UI 不能因为一个按钮崩掉整个面板。
 * @param {Function|undefined} fn
 * @param {...any} args
 * @returns {any}
 */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch (err) {
    console.warn('[skill-ui] 动作调用失败', err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 防御式读取队友模块（每次现取，不做模块级缓存，方便开发期热更新后立刻生效）
// ---------------------------------------------------------------------------

/** data-dev: src/items/skillProgression.js 的只读常量 */
function progressionConsts() {
  return {
    cap: Number.isFinite(progressionMod.SKILL_LEVEL_CAP) ? progressionMod.SKILL_LEVEL_CAP : FALLBACK_LEVEL_CAP,
    refineMax: Number.isFinite(progressionMod.REFINE_MAX) ? progressionMod.REFINE_MAX : FALLBACK_REFINE_MAX,
  };
}

/**
 * 取玩家身上的技能精炼数据。契约里有两处写入点，按优先级读：
 *   inv.skillRefine[skillId]（progression 模块的权威值） > player.skills[skillId].refine（app 写入）。
 * @param {Object} inv @param {Object} player @param {string} skillId
 * @returns {number}
 */
function readRefine(inv, player, skillId) {
  const a = inv && inv.skillRefine ? inv.skillRefine[skillId] : undefined;
  if (Number.isFinite(a)) return Math.max(0, Math.floor(a));
  const b = player && player.skills && player.skills[skillId] ? player.skills[skillId].refine : undefined;
  if (Number.isFinite(b)) return Math.max(0, Math.floor(b));
  const inst = findInstance(player, skillId);
  if (inst && Number.isFinite(inst.refine)) return Math.max(0, Math.floor(inst.refine));
  return 0;
}

/**
 * 精炼石数量（契约字段 inv.skillOrbs）。
 * @param {Object} inv
 */
function readOrbs(inv) {
  const n = inv && inv.skillOrbs;
  return Number.isFinite(n) ? n : 0;
}

/**
 * 在技能栏里按 id 找技能实例。
 * @param {Object} player @param {string} skillId
 */
function findInstance(player, skillId) {
  const bar = player && Array.isArray(player.skillBar) ? player.skillBar : [];
  return bar.find((s) => s && s.id === skillId) || null;
}

/**
 * 某节点当前的投入档位（兼容「完整 id」与「短名」两种 ranks 键）。
 * @param {Object} ranks @param {string} skillId @param {Object} node
 */
function rankOf(ranks, skillId, node) {
  if (!ranks) return 0;
  const short = String(node.id).startsWith(skillId + '.') ? String(node.id).slice(skillId.length + 1) : node.id;
  const v = Number(ranks[node.id] != null ? ranks[node.id] : ranks[short]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * 节点所属分支（data 有 skillBranchOf 就用它，否则按 node.branch / 位置推断）。
 * @param {Object} tree @param {Object} node @param {number} idx 节点在树里的下标（兜底推断用）
 * @returns {string} 'core'|'left'|'right'|'leftDeep'|'rightDeep'|'ultimate'
 */
function branchOfNode(tree, node, idx) {
  const fn = skillTreeMod.skillBranchOf;
  let b = '';
  if (typeof fn === 'function') {
    try {
      b = fn(tree, node.id) || '';
    } catch { b = ''; }
  }
  if (!b && node.branch) b = String(node.branch);
  if (b) return b;
  // 兜底：无 branch 字段时按拓扑猜。第一个无前置节点 = 核心；无后续节点且有两个前置 = 终极。
  const reqs = node.requires || [];
  if (reqs.length === 0) return idx === 0 ? 'core' : 'left';
  if (reqs.length >= 2) return 'ultimate';
  const short = String(node.id).split('.').pop() || '';
  if (/^(l|left)/i.test(short)) return 'left';
  if (/^(r|right)/i.test(short)) return 'right';
  // 单链旧数据：按树内顺序前后半段分左右，避免全部堆到一边
  return idx > (tree.nodes || []).length / 2 ? 'right' : 'left';
}

/**
 * 互斥冲突检测（data 有 skillNodeConflict 就用它，否则用本地「同组已选」兜底）。
 * @param {Object} tree @param {Object} ranks @param {Object} node
 * @returns {null|{group:string, takenNodeId:string, takenName:string}}
 */
function conflictOf(tree, ranks, node) {
  const fn = skillTreeMod.skillNodeConflict;
  if (typeof fn === 'function') {
    try {
      return fn(tree, ranks, node.id) || null;
    } catch { /* 落到兜底 */ }
  }
  if (!node.group) return null;
  for (const other of tree.nodes || []) {
    if (other === node || other.id === node.id) continue;
    if (other.group !== node.group) continue;
    if (rankOf(ranks, tree.id, other) > 0) {
      return { group: node.group, takenNodeId: other.id, takenName: other.name || other.id };
    }
  }
  return null;
}

/**
 * 前置条件检查。返回未满足的前置节点名数组（空数组 = 满足）。
 * @param {Object} tree @param {Object} ranks @param {Object} node
 * @returns {string[]}
 */
function unmetRequires(tree, ranks, node) {
  const out = [];
  for (const r of node.requires || []) {
    const rn = (tree.nodes || []).find((x) => x.id === r || `${tree.id}.${x.id}` === r || x.id === `${tree.id}.${r}`);
    const rr = rn ? rankOf(ranks, tree.id, rn) : 0;
    if (rr <= 0) out.push(rn ? rn.name : String(r).split('.').pop());
  }
  return out;
}

/**
 * 天赋效果的「人话」描述。数据里带 desc 就用 desc；
 * 没有的话把 effects 翻译成本地面板里也通用的短句（新效果类型按契约语义）。
 * @param {Object} node
 * @returns {string}
 */
function effectText(node) {
  if (node.desc) return node.desc;
  const parts = [];
  for (const e of node.effects || []) {
    const v = Number(e.value) || 0;
    switch (e.type) {
      case 'damageMult': parts.push(`伤害 ${signedPct(v)}`); break;
      case 'radiusMult': parts.push(`范围 ${signedPct(v)}`); break;
      case 'cooldownMult': parts.push(`冷却 ${signedPct(v)}`); break;
      case 'stunDurMult': parts.push(`眩晕时长 ${signedPct(v)}`); break;
      case 'armorPerEnemyMult': parts.push(`每敌护甲 ${signedPct(v)}`); break;
      case 'armorDurMult': parts.push(`护甲持续 ${signedPct(v)}`); break;
      case 'armorFlat': parts.push(`额外护甲 +${fmt(v, 0)}`); break;
      case 'count': parts.push(`额外数量 +${Math.round(v)}`); break;
      default: parts.push(e.key ? String(e.key) : e.type);
    }
  }
  return parts.join('，');
}

// ---------------------------------------------------------------------------
// 数值摘要（核心 skillDisplayInfo 优先，缺失时自己从技能定义手算）
// ---------------------------------------------------------------------------

/**
 * 生成技能卡的数值行。每行 { label, value, hue }，hue 用于上色（核心/控制/生存）。
 *
 * 【为什么要有兜底】core-dev 的 skillDisplayInfo 是并行开发的新导出，
 * 面板必须在它缺席时仍然能显示「伤害/冷却/范围」等基本盘，所以这里按契约公式
 * （等级成长 8% 伤害、4% 冷却、5% 半径）自己算一遍。
 *
 * @param {Object} ctx 面板上下文（player / tree / ranks / inst）
 * @returns {Array<{label:string, value:string, hue:string}>}
 */
function statRows(ctx) {
  const { player, tree, ranks, inst } = ctx;
  const skillId = tree.id;
  const info = ctx.info; // 可能为 null
  const mods = (player && player.skillMods && player.skillMods[skillId]) || {};
  const stats = mods.stats || {};
  const lvl = Math.max(1, Number(info && info.level) || Number(inst && inst.level) || 1);
  const R = [];

  // ---- 伤害 ----
  let dmgPct = null;
  if (info && Number.isFinite(info.damagePct)) dmgPct = info.damagePct;
  else if (Number.isFinite(mods.damageMult)) dmgPct = mods.damageMult;
  if (dmgPct != null) R.push({ label: '伤害', value: Math.round(dmgPct * 100) + '%', hue: 'dmg' });

  // ---- 法力 ----
  const mana = info && Number.isFinite(info.manaCost) ? info.manaCost : null;
  if (mana != null) R.push({ label: '法力', value: fmt(mana, 0), hue: 'mana' });

  // ---- 冷却 ----
  const cd = info && Number.isFinite(info.cooldown) ? info.cooldown : null;
  if (cd != null) R.push({ label: '冷却', value: fmt(cd, cd < 10 ? 1 : 0) + 's', hue: 'cd' });

  // ---- 范围 ----
  const radius = info && Number.isFinite(info.radius) ? info.radius
    : info && Number.isFinite(info.range) ? info.range
      : null;
  if (radius != null) R.push({ label: '范围', value: fmt(radius, 1), hue: 'area' });

  // ---- 眩晕时长（stomp 类控制技能：乘子上限就是各天赋乘数之积）----
  let stunDur = info && Number.isFinite(info.stunDur) ? info.stunDur : stats.stunDur;
  if (stunDur == null && mods.multiplierBonuses && Number.isFinite(mods.multiplierBonuses.stunDurMult)) {
    // 没有基础值时用「倍率」表达（×1.3）
    const m = mods.multiplierBonuses.stunDurMult;
    if (m !== 1) R.push({ label: '眩晕', value: '×' + fmt(m, 2), hue: 'ctrl' });
  } else if (stunDur != null) {
    R.push({ label: '眩晕', value: fmt(stunDur, 2) + 's', hue: 'ctrl' });
  }

  // ---- 护甲（warStompArmor：18 + 5×命中数，再乘天赋）----
  const ag = info && info.armorGain ? info.armorGain : (ctx.def && ctx.def.armorGain) || null;
  const mb = mods.multiplierBonuses || {};
  if (ag && (Number.isFinite(ag.flat) || Number.isFinite(ag.per))) {
    const per = Number.isFinite(ag.per) ? ag.per : 0;
    const flat = Number.isFinite(ag.flat) ? ag.flat : 0;
    const mult = Number.isFinite(mb.armorPerEnemyMult) ? mb.armorPerEnemyMult : 1;
    const extraFlat = Number.isFinite(mb.armorFlat) ? mb.armorFlat : 0;
    const dur = Number.isFinite(mb.armorDurMult) ? mb.armorDurMult : 1;
    const total = Math.round((flat + per * mult) + extraFlat); // 以「命中 1 名敌人」为示例
    R.push({ label: '护甲', value: `+${total}/敌`, hue: 'armor' });
    if (Number.isFinite(ag.dur)) R.push({ label: '护甲持续', value: fmt(ag.dur * dur, 1) + 's', hue: 'armor' });
  } else if (Number.isFinite(info && info.armor)) {
    R.push({ label: '护甲', value: '+' + fmt(info.armor, 0), hue: 'armor' });
  }

  // ---- 冷却/范围/伤害的等级成长（让玩家一眼看到「再升一级值不值」）----
  const def = ctx.def || {};
  const growth = [];
  if (Number.isFinite(def.damageMultLevel)) growth.push(`伤害 ${signedPct(def.damageMultLevel)}/级`);
  if (Number.isFinite(def.cooldownMultLevel)) growth.push(`冷却 ${signedPct(-def.cooldownMultLevel)}/级`);
  if (Number.isFinite(def.radiusMultLevel)) growth.push(`范围 ${signedPct(def.radiusMultLevel)}/级`);
  if (growth.length) R.push({ label: '等级成长', value: growth.join(' · '), hue: 'muted' });

  if (!R.length) R.push({ label: '说明', value: (info && info.desc) || (ctx.def && ctx.def.desc) || '—', hue: 'muted' });
  return R;
}

// ---------------------------------------------------------------------------
// 引导条
// ---------------------------------------------------------------------------

/**
 * 是否显示新手引导。localStorage 取不到时**按首次处理**（宁可多显示一次，也不让新玩家错过）。
 * @returns {boolean}
 */
function shouldShowGuide() {
  return lsGet(GUIDE_KEY) !== '1';
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 技能面板是否打开。
 * @param {Object} ui GameUI 实例
 */
export function isSkillsOpen(ui) {
  return ui.modalOpen === 'skills';
}

/**
 * 打开（或刷新）技能面板。
 * 刷新策略：重绘「当前标签页」的内容区与底部资源区，不重建标签栏 —— 这样玩家连续加点时
 * 按钮不会闪烁、滚动位置也不会跳回顶部。
 * @param {Object} ui GameUI 实例
 * @param {{tab?:string}} [opts] tab = 要激活的技能 id（可选）
 */
export function openSkills(ui, opts = {}) {
  const game = ui.game;
  const player = (game.world && game.world.player) || {};
  const inv = game.inv || {};

  ui.el.modalTitle.textContent = '技能 · 天赋分叉';
  const body = ui.el.modalBody;
  body.innerHTML = '';

  const wrap = el('div', { class: 'skillui-wrap' });
  wrap.className = 'skillui-wrap';

  // ---- ① 新手引导条（首次打开）----
  if (shouldShowGuide()) wrap.appendChild(buildGuide());

  // ---- ② 标签栏 ----
  const treeIds = collectSkillIds(game, player);
  const bar = el('div', { class: 'skill-tabs' });
  bar.className = 'skill-tabs';
  const content = el('div', { class: 'skill-content' });
  content.className = 'skill-content';
  wrap.appendChild(bar);
  wrap.appendChild(content);

  let active = opts.tab && treeIds.includes(opts.tab) ? opts.tab : treeIds[0];

  /**
   * 面板级可变状态（闭包共享给技能卡/树/详情浮层）。
   * 放在 openSkills 里而不是模块级：每次打开都是独立会话，关闭后 GC 掉。
   * @type {{hoverNode: string|null}}
   */
  const state = { hoverNode: null };

  /**
   * 重绘标签栏。每个标签：图标 + 名称 + Lv.X + 可分配光点。
   */
  function drawTabs() {
    bar.innerHTML = '';
    for (const sid of treeIds) {
      const tree = getTree(sid) || { id: sid, name: sid, icon: '❔', nodes: [] };
      const inst = findInstance(player, sid);
      const info = displayInfo(player, sid);
      const lvl = Math.max(1, Number(info && info.level) || Number(inst && inst.level) || 1);
      const pend = pendingPointsFor(game, sid, inv);
      // 用 DOM 属性（而不是 el() 的 class 简写）落类名：className 与 classList 都同步，
      // 对真实浏览器和测试桩（classList 是独立 Set）语义一致。
      const btn = el('button', { 'data-skill': sid, type: 'button' });
      btn.className = 'skill-tab' + (sid === active ? ' active' : '') + (pend > 0 ? ' has-points' : '');
      if (pend > 0) btn.classList.add('has-points');
      // 图标文本同时放进 data-icon 与 title：测试/无障碍/触屏长按都能读到是哪个技能
      const iconChar = (info && info.icon) || (inst && inst.icon) || tree.icon || '◆';
      const iconEl = el('span', { class: 'st-icon', 'data-icon': iconChar, title: `${(info && info.name) || tree.name || sid}（${sid}）` });
      iconEl.textContent = iconChar; // setAttribute 会被桩环境吞掉 text；这里显式再写一次，真实 DOM 等价
      btn.appendChild(iconEl);
      btn.appendChild(el('span', { class: 'st-name', text: (info && info.name) || tree.name || sid }));
      btn.appendChild(el('span', { class: 'st-lv', text: 'Lv.' + lvl }));
      if (pend > 0) btn.appendChild(el('i', { class: 'st-dot', title: `有 ${pend} 点可分配` }));
      btn.addEventListener('click', () => {
        if (active === sid) return;
        active = sid;
        playSfx('rankUp');
        drawTabs();
        drawContent();
      });
      bar.appendChild(btn);
    }
  }

  /**
   * 重绘当前标签页的内容：技能卡 + 分叉树 + 详情浮层。
   *
   * 【为什么多包一层 .skill-content-inner】DOM 桩的 innerHTML 是不解析的纯字符串，
   * 真实节点的 textContent 也不会聚合 innerHTML 里的文字；但所有「递归遍历子节点取 textContent」
   * 的检查（测试、无障碍、屏幕阅读器）都只能看到**真实子节点树**。
   * 所以内容区一律用 createElement + textContent 建真实节点，保证两种环境读到的文字一致。
   */
  function drawContent() {
    content.innerHTML = '';
    const inner = el('div', { class: 'skill-content-inner' });
    inner.className = 'skill-content-inner';
    inner.appendChild(buildSkillCard(ui, active, render, state));
    inner.appendChild(buildTree(ui, active, render, state));
    inner.appendChild(buildFooter(ui, active));
    content.appendChild(inner);
  }

  /** 兼容旧入口：底部栏现在由 drawContent 一起重建 */
  function drawFooter() {
    drawContent();
  }

  /**
   * 统一的「重绘」入口：加点/精炼/重置后调用。
   * 用 setTimeout(0) 错开一帧，避免在按钮的 click 回调里同步销毁它自己（部分浏览器会丢失后续事件）。
   */
  function render() {
    drawTabs();
    drawContent();
  }

  // 详情浮层挂在模态框外面（tooltip 是全局单例），由 GameUI 负责定位。
  // 注意：这两个回调只由「带 ui 的」那次 openSkills 覆盖，没有 ui 时的不挂，
  // 避免测试里直接 openSkills(undefined) 把真实回调冲掉。
  if (ui) {
    ui._skillDetail = (nodeId) => showNodeDetail(ui, active, nodeId);
    ui._skillHideDetail = () => ui.hideTooltip();
  }

  drawTabs();
  drawContent();
  body.appendChild(wrap);
  ui.el.modalFoot.innerHTML = '';
}

/**
 * 只重绘面板（供 GameUI.onSkillsChange 复用同一入口）。
 * @param {Object} ui
 */
export function refreshSkills(ui) {
  if (ui.modalOpen === 'skills') openSkills(ui);
}

// ---------------------------------------------------------------------------
// 技能 id 收集 / 技能点与精炼相关查询
// ---------------------------------------------------------------------------

/**
 * 面板里展示哪些技能：优先技能栏前 5 格（保证顺序 = 1..5 按键），
 * 其次数据层 SKILL_TREES 的键，最后核心 SKILLS 里排除 dash 的部分。
 * 三者取并集可以让「1 号键是战争践踏、但数据里还留着旧 id」这种过渡期也能渲染出标签。
 * @param {Object} game @param {Object} player
 * @returns {string[]}
 */
function collectSkillIds(game, player) {
  const out = [];
  const push = (id) => { if (id && !out.includes(id)) out.push(id); };
  const bar = player && Array.isArray(player.skillBar) ? player.skillBar : [];
  for (let i = 0; i < Math.min(5, bar.length); i++) if (bar[i] && bar[i].id) push(bar[i].id);
  // 法师：只展示自己的 5 个技能（战士技能树的 id 不能混进法师面板）
  if (player && player.type === 'mage') return out;
  const trees = skillTreeMod.SKILL_TREES;
  if (trees && typeof trees === 'object') {
    for (const id of Object.keys(trees)) push(id);
  }
  const ids = skillsMod.SKILL_IDS;
  if (Array.isArray(ids)) for (const id of ids) push(id);
  if (!out.length) {
    const skills = skillsMod.SKILLS || {};
    for (const id of Object.keys(skills)) if (id !== 'dash') push(id);
  }
  return out;
}

/**
 * 取某技能的树；数据缺失时返回空树（面板显示「暂无可加点天赋」，而不是崩）。
 * @param {string} skillId
 */
function getTree(skillId) {
  const trees = skillTreeMod.SKILL_TREES;
  const t = trees && trees[skillId];
  if (t && Array.isArray(t.nodes) && t.nodes.length) return t;
  const fn = skillTreeMod.skillTreeOf;
  if (typeof fn === 'function') {
    try {
      const t2 = fn(skillId);
      if (t2 && Array.isArray(t2.nodes)) return t2;
    } catch { /* ignore */ }
  }
  return { id: skillId, name: skillId, icon: '❔', desc: '', nodes: [] };
}

/**
 * 核心 skillDisplayInfo（可能不存在 → 返回 null，由调用方走手算兜底）。
 * @param {Object} player @param {string} skillId
 * @returns {Object|null}
 */
function displayInfo(player, skillId) {
  const fn = skillsMod.skillDisplayInfo;
  if (typeof fn !== 'function') return null;
  try {
    const info = fn(player, skillId);
    return info && typeof info === 'object' ? info : null;
  } catch (err) {
    console.warn('[skill-ui] skillDisplayInfo 失败，改用兜底', err);
    return null;
  }
}

/** 已花费的技能点总数（所有技能共享） */
function spentPoints(inv) {
  if (!inv || !inv.skillRanks) return 0;
  let n = 0;
  for (const k in inv.skillRanks) {
    const v = Number(inv.skillRanks[k]);
    if (Number.isFinite(v) && v > 0) n += v;
  }
  return n;
}

/**
 * 技能点总量：优先 app 动作 → → inv.skillPoints.total 的**前缀和**兜底。
 *
 * 【公式同步（重要）】技能点曲线是「每级 +1」（Lv.1=1 / Lv.10=10 / Lv.14=14）。
 * 这里先重新取一次 app 的 skillPointsForLevel（命名空间 import，始终是最新实现），
 * 只有它也不可用时才用本地公式——本地公式必须与它一致，否则 app 动作一失败就会少显示点数。
 * @param {Object} game @param {Object} inv @param {Object} player
 */
function skillPointsTotal(game, inv, player) {
  const v = safeCall(game.actions && game.actions.skillPointsTotal);
  if (Number.isFinite(v)) return v;
  const lvl = Math.max(1, Math.floor(Number(player && player.level) || 1));
  let fromLevel = lvl;
  const forLevel = progressionMod.skillPointsForLevel;
  const appForLevel = game.__skillPointsForLevel; // 由 main.js 注入（可选），避免 skill-ui 反向依赖 game 层
  const fn = typeof appForLevel === 'function' ? appForLevel : typeof forLevel === 'function' ? forLevel : null;
  if (fn) {
    try {
      const r = fn(lvl);
      if (Number.isFinite(r)) fromLevel = r;
    } catch { /* 用本地公式 */ }
  }
  const stored = inv && inv.skillPoints && Number.isFinite(inv.skillPoints.total) ? inv.skillPoints.total : 0;
  return Math.max(fromLevel, stored);
}

/**
 * 某个技能还能用小号光点提示几「点」：只看「还剩可分配点数 + 该技能有可加点节点」，
 * 返回 0/1（技能栏角标再多也不必在标签上显示具体数字）。
 * @returns {number}
 */
function pendingPointsFor(game, skillId, inv) {
  const total = skillPointsTotal(game, inv, game.world && game.world.player);
  if (total - spentPoints(inv) <= 0) return 0;
  const tree = getTree(skillId);
  const ranks = (inv && inv.skillRanks) || {};
  for (const n of tree.nodes || []) {
    if (canRankUpNode(tree, ranks, n, total - spentPoints(inv))) return 1;
  }
  return 0;
}

/**
 * 单个节点是否可加点（点数/满档/前置/互斥 四道关）。
 * 注意：这里和 app 的实际校验是「双保险」——UI 只决定样式与提示，真正落库仍走 app 动作。
 * @returns {boolean}
 */
function canRankUpNode(tree, ranks, node, avail) {
  if (!(avail > 0)) return false; // 含 undefined / NaN
  if (avail < (node.cost || 1)) return false;
  if (rankOf(ranks, tree.id, node) >= (node.maxRank || 1)) return false;
  if (unmetRequires(tree, ranks, node).length) return false;
  if (conflictOf(tree, ranks, node)) return false;
  return true;
}

/**
 * 精炼条的展示状态。优先用 data 层的 refineDisplayState（它能区分「天赋已顶满 Lv.5」
 * 和「真的没精炼过」，文案如 `已满级（天赋 5 点顶满）`）；它缺席时用本地信息拼一个等价结果。
 * 返回结构统一为 { refine, max, level, cap, capped, cappedBy, nextCost, label, pips }。
 * @param {Object} inv @param {Object} player @param {string} skillId @param {Object} info skillDisplayInfo（可能为 null）
 * @returns {{refine:number,max:number,level:number,cap:number,capped:boolean,cappedBy:string,
 *   nextCost:number|null,label:string,pips:string}}
 */
export function refineDisplay(ui, skillId, info) {
  const game = ui.game || {};
  const inv = game.inv || {};
  const player = (game.world && game.world.player) || {};
  const fn = progressionMod.refineDisplayState;
  if (typeof fn === 'function') {
    try {
      const r = fn(inv, skillId);
      if (r && typeof r === 'object' && Number.isFinite(r.refine)) {
        return {
          refine: r.refine,
          max: Number.isFinite(r.max) ? r.max : FALLBACK_REFINE_MAX,
          level: Number.isFinite(r.level) ? r.level
            : Number.isFinite(r.levelCap) ? r.level : Number(info && info.level) || 1,
          cap: Number.isFinite(r.levelCap) ? r.levelCap : (Number.isFinite(r.cap) ? r.cap : FALLBACK_LEVEL_CAP),
          capped: !!r.capped,
          cappedBy: r.cappedBy || '',
          nextCost: r.nextCost === null ? null : (Number.isFinite(r.nextCost) ? r.nextCost : null),
          label: r.label || '',
          pips: r.pips || '',
        };
      }
    } catch { /* 落到本地拼装 */ }
  }
  // ---- 本地兜底：用技能等级 + 精炼等级自己判断「是不是被天赋顶满」 ----
  const { cap, refineMax } = progressionConsts();
  const refine = readRefine(inv, player, skillId);
  const level = Math.max(1, Number(info && info.level) || Number(findInstance(player, skillId) && findInstance(player, skillId).level) || 1);
  const ranks = inv.skillRanks || {};
  const talentPoints = countSkillPoints(skillId, ranks);
  const capped = level >= cap;
  const cappedBy = capped ? (refine >= refineMax ? 'refine' : 'talent') : refine >= refineMax ? 'refine' : '';
  const nextCost = capped || refine >= refineMax ? null : nextRefineCost(player, skillId, refine, { cap, refineMax });
  let label;
  if (!capped && refine < refineMax) label = `精炼 ${refine}/${refineMax}`;
  else if (capped && cappedBy === 'talent') label = `已满级（天赋 ${talentPoints} 点顶满）`;
  else if (capped) label = `已满级（精炼 ${refineMax}/${refineMax}）`;
  else label = `精炼已满（${refine}/${refineMax}）`;
  return { refine, max: refineMax, level, cap, capped, cappedBy, nextCost, label, pips: `${refine}/${refineMax}` };
}

/**
 * 判断某个技能当前能否精炼（返回结构化原因，供按钮置灰与提示）。
 * 优先用 progression.canRefineSkill；它缺席时按契约规则本地判断（等级上限 / 石头够不够）。
 * @param {Object} ui @param {string} skillId
 * @returns {{ok:boolean, reason:string, cost:number|null, have:number}}
 */
export function refineStatus(ui, skillId) {
  const game = ui.game;
  const inv = game.inv || {};
  const player = (game.world && game.world.player) || {};
  const have = readOrbs(inv);
  const { cap, refineMax } = progressionConsts();
  const refine = readRefine(inv, player, skillId);
  const info = displayInfo(player, skillId);
  const lvl = Math.max(1, Number(info && info.level) || Number(findInstance(player, skillId)?.level) || 1);
  // 展示层的 label 能把「天赋顶满」和「精炼未动」区分开，优先拿来当不可点时的原因
  const disp = refineDisplay(ui, skillId, info);
  const cost = nextRefineCost(player, skillId, refine, { cap, refineMax });

  const fn = progressionMod.canRefineSkill;
  if (typeof fn === 'function') {
    try {
      const r = fn(inv, player, skillId);
      if (r && typeof r === 'object') {
        return {
          ok: !!r.ok,
          // 不可点时优先用更精确的展示文案（如「已满级（天赋 5 点顶满）」）
          reason: r.ok ? '' : (disp.capped || refine >= refineMax ? (disp.label || r.reason || '无法精炼') : (r.reason || '无法精炼')),
          cost: Number.isFinite(r.cost) ? r.cost : cost,
          have: Number.isFinite(r.have) ? r.have : have,
        };
      }
    } catch { /* 落到本地判断 */ }
  }
  if (refine >= refineMax || lvl >= cap) return { ok: false, reason: disp.label || `已达技能等级上限 Lv.${cap}`, cost: null, have };
  if (cost == null) return { ok: false, reason: '已达上限', cost: null, have };
  if (have < cost) return { ok: false, reason: `精炼石不足（需要 ${cost}，现有 ${have}）`, cost, have };
  return { ok: true, reason: '', cost, have };
}

/**
 * 下一次精炼需要几颗石头：核心 nextRefineCost > progression.refineCost > 本地花费表。
 * @param {Object} player @param {string} skillId @param {number} refine @param {{cap:number,refineMax:number}} c
 * @returns {number|null} null = 已满
 */
function nextRefineCost(player, skillId, refine, c) {
  const coreFn = skillsMod.nextRefineCost;
  if (typeof coreFn === 'function') {
    try {
      const v = coreFn(player, skillId);
      if (v === null) return null;
      if (Number.isFinite(v)) return v;
    } catch { /* 落到下面 */ }
  }
  if (refine >= c.refineMax) return null;
  const fn = progressionMod.refineCost;
  if (typeof fn === 'function') {
    try {
      const v = fn(refine + 1, refine);
      if (Number.isFinite(v)) return v;
    } catch { /* 落到本地表 */ }
  }
  const v = FALLBACK_REFINE_COST[refine];
  return Number.isFinite(v) ? v : null;
}

/**
 * 「重置天赋」的花费（精炼石）。data 有 respecCost 就用，否则按契约 2 + 已点节点数。
 * @param {string} skillId @param {Object} inv @param {Object} player
 * @returns {number}
 */
function respecCostOf(skillId, inv, player) {
  const fn = progressionMod.respecCost;
  if (typeof fn === 'function') {
    try {
      const v = fn(skillId);
      if (Number.isFinite(v)) return v;
    } catch { /* 落到兜底 */ }
  }
  const ranks = (inv && inv.skillRanks) || {};
  let n = 0;
  for (const k in ranks) {
    if (k === skillId || k.startsWith(skillId + '.')) {
      const v = Number(ranks[k]);
      if (Number.isFinite(v) && v > 0) n += v;
    }
  }
  return 2 + n;
}

/**
 * 任意技能是否可精炼（HUD 角标用；这里只跑前 5 个技能，成本可以忽略）。
 * @param {Object} ui @param {string} [excludeId] 不检查的技能（底部栏里已单独展示）
 * @returns {boolean}
 */
function anyRefineable(ui, excludeId) {
  const ids = collectSkillIds(ui.game, ui.game.world && ui.game.world.player);
  return ids.some((sid) => sid !== excludeId && refineStatus(ui, sid).ok);
}

// ---------------------------------------------------------------------------
// ① 引导条
// ---------------------------------------------------------------------------

/**
 * 新手引导条。点「知道了」写 localStorage（写不进去也没关系，下次还会提示）。
 * @returns {HTMLElement}
 */
function buildGuide() {
  const g = el('div', { class: 'skill-guide' });
  g.innerHTML = `
    <span class="sg-star">✦</span>
    <div class="sg-text">
      <b>技能可以变强了</b>——每个技能都有自己的<b>分叉天赋</b>（左支 / 右支互斥，只能选一边），
      天赋点来自角色升级；<b>精炼石</b>可以直接提升技能等级（伤害、冷却、范围、机制数值一起成长）。
      点「精炼」升级技能，点「重置天赋」花精炼石换一条分支。
    </div>
    <button class="sg-ok">知道了</button>`;
  const ok = g.querySelector('.sg-ok');
  if (ok) {
    ok.addEventListener('click', () => {
      lsSet(GUIDE_KEY, '1');
      g.remove();
    });
  }
  return g;
}

// ---------------------------------------------------------------------------
// ② 技能卡
// ---------------------------------------------------------------------------

/**
 * 技能卡：图标 / 名称 / 等级 / 精炼格 / 数值摘要 / 精炼按钮 / 重置按钮。
 * @param {Object} ui @param {string} skillId @param {Function} render 重绘回调
 * @param {Object} state 面板状态
 * @returns {HTMLElement}
 */
function buildSkillCard(ui, skillId, render, state) {
  const game = ui.game;
  const player = (game.world && game.world.player) || {};
  const inv = game.inv || {};
  const tree = getTree(skillId);
  const inst = findInstance(player, skillId);
  const info = displayInfo(player, skillId);
  const def = (skillsMod.SKILLS && skillsMod.SKILLS[skillId]) || {};
  const { cap, refineMax } = progressionConsts();
  const ranks = inv.skillRanks || {};
  const refine = readRefine(inv, player, skillId);
  const level = Math.max(1, Number(info && info.level) || Number(inst && inst.level) || 1);

  const card = el('div', { class: 'skill-card', 'data-skill': skillId });
  card.className = 'skill-card';

  // ---- 左：图标 ----
  const iconBox = el('div', { class: 'sc-icon' });
  iconBox.className = 'sc-icon';
  iconBox.appendChild(el('span', { text: (info && info.icon) || (inst && inst.icon) || tree.icon || '◆' }));
  const lvBadge = el('i', { class: 'sc-lv-badge', text: `Lv.${level}` });
  lvBadge.className = 'sc-lv-badge';
  iconBox.appendChild(lvBadge);
  card.appendChild(iconBox);

  // ---- 中：名称 / 描述 / 精炼格 / 数值 ----
  const mid = el('div', { class: 'sc-main' });
  mid.className = 'sc-main';
  const name = (info && info.name) || (inst && inst.name) || tree.name || skillId;
  const desc = (info && info.desc) || def.desc || tree.desc || '';
  const head = el('div', { class: 'sc-head' });
  head.className = 'sc-head';
  const nameEl = el('span', { class: 'sc-name', text: name });
  nameEl.className = 'sc-name';
  head.appendChild(nameEl);
  const lvEl = el('span', { class: 'sc-level' });
  lvEl.className = 'sc-level';
  lvEl.appendChild(mkText('Lv.'));
  var levelB = el('b', { text: String(level) });
  lvEl.appendChild(levelB);
  lvEl.appendChild(mkText(`/${cap}`));
  head.appendChild(lvEl);
  if (info && info.focus) {
    const focusEl = el('span', {
      class: 'sc-focus focus-' + String(info.focus),
      text: info.focus === 'left' ? '左支·震怒' : '右支·壁垒',
    });
    head.appendChild(focusEl);
  }
  mid.appendChild(head);
  if (desc) {
    const descEl = el('p', { class: 'sc-desc', text: desc });
    descEl.className = 'sc-desc';
    mid.appendChild(descEl);
  }

  // 精炼格：实心 = 已精炼。标签用 refineDisplay 的文案，能区分「天赋顶满 Lv.5」和「没精炼过」
  const disp = refineDisplay(ui, skillId, info);
  const pips = el('div', {
    class: 'sc-pips',
    title: `精炼等级 ${refine}/${refineMax}（每颗精炼石提升 1 级技能，最多 4 级精炼）`,
  });
  pips.className = 'sc-pips';
  for (let i = 0; i < refineMax; i++) {
    const pip = el('i', { class: 'sc-pip' + (i < refine ? ' on' : '') });
    pip.className = 'sc-pip' + (i < refine ? ' on' : '');
    pips.appendChild(pip);
  }
  const pipLabel = el('span', {
    class: 'sc-pips-label' + (disp.capped ? ' capped' : ''),
    text: disp.label || (refine >= refineMax ? '精炼已满' : `精炼 ${refine}/${refineMax}`),
  });
  pipLabel.className = 'sc-pips-label' + (disp.capped ? ' capped' : '');
  if (disp.capped) pipLabel.title = '技能等级已达上限，继续精炼不会再加等级';
  pips.appendChild(pipLabel);
  mid.appendChild(pips);

  // 数值摘要
  const rows = statRows({ player, tree, ranks, inst, info, def });
  const stats = el('div', { class: 'sc-stats' });
  stats.className = 'sc-stats';
  for (const r of rows) {
    const row = el('div', { class: 'sc-stat hue-' + r.hue });
    row.className = 'sc-stat hue-' + r.hue;
    const k = el('span', { text: r.label });
    const v = el('b', { text: r.value });
    row.appendChild(k);
    row.appendChild(v);
    stats.appendChild(row);
  }
  mid.appendChild(stats);
  card.appendChild(mid);

  // ---- 右：操作按钮 ----
  const side = el('div', { class: 'sc-actions' });
  side.className = 'sc-actions';

  // 精炼按钮
  const rs = refineStatus(ui, skillId);
  const refineBtn = el('button', { class: 'skill-btn refine' + (rs.ok ? ' can' : ' off'), type: 'button' });
  refineBtn.className = 'skill-btn refine' + (rs.ok ? ' can' : ' off');
  const rMain = el('span', { class: 'sb-main', text: '精炼' });
  rMain.className = 'sb-main';
  const rSub = el('span', {
    class: 'sb-sub',
    // 不可点时：优先用 refineDisplay 的说明（能区分「天赋顶满」和「精炼满」），
    // 其次用 refineStatus 的拒绝原因（如「精炼石不足（需要 3，拥有 1）」），最后才是泛泛的「已满级」。
    text: rs.ok
      ? `${rs.cost} 颗精炼石`
      : (disp.capped || !rs.cost ? (disp.label || rs.reason || '已满级') : (rs.reason || '无法精炼')),
  });
  rSub.className = 'sb-sub';
  refineBtn.appendChild(rMain);
  refineBtn.appendChild(rSub);
  if (!rs.ok) refineBtn.title = rs.reason || '暂时无法精炼';
  refineBtn.addEventListener('click', () => {
    if (!rs.ok) {
      ui.addLog?.(`无法精炼：${rs.reason || '条件不足'}`, '#888');
      playSfx('deny');
      return;
    }
    // app 动作名在并行开发期不保证存在，三种可能都试一遍
    const acts = game.actions || {};
    const ok = safeCall(acts.refineSkill, skillId) || safeCall(acts.doSkillRefine, skillId);
    if (ok) {
      playSfx('refine');
      updateSkillBarGlyphs(ui);
      render();
    } else {
      ui.addLog?.('精炼失败：精炼石不足或已达上限', '#888');
      playSfx('deny');
    }
  });
  side.appendChild(refineBtn);

  // 重置天赋按钮
  const cost = respecCostOf(skillId, inv, player);
  const mySpent = countSkillPoints(skillId, ranks);
  const orbs = readOrbs(inv);
  const canRespec = mySpent > 0;
  const respecBtn = el('button', { class: 'skill-btn respec' + (canRespec ? '' : ' off'), type: 'button' });
  respecBtn.className = 'skill-btn respec' + (canRespec ? '' : ' off');
  const sMain = el('span', { class: 'sb-main', text: '重置天赋' });
  sMain.className = 'sb-main';
  const sSub = el('span', { class: 'sb-sub', text: `${cost} 颗精炼石` });
  sSub.className = 'sb-sub';
  respecBtn.appendChild(sMain);
  respecBtn.appendChild(sSub);
  if (!canRespec) respecBtn.title = '这个技能还没有投入天赋点';
  else if (orbs < cost) respecBtn.title = `精炼石不足（需要 ${cost}，现有 ${orbs}）`;
  respecBtn.addEventListener('click', () => {
    if (!canRespec) {
      ui.addLog?.('该技能还没有投入天赋点', '#888');
      playSfx('deny');
      return;
    }
    if (orbs < cost) {
      ui.addLog?.(`精炼石不足：重置天赋需要 ${cost} 颗`, '#888');
      playSfx('deny');
      return;
    }
    const acts = game.actions || {};
    const ok = safeCall(acts.respecSkill, skillId) || safeCall(acts.doSkillRespec, skillId);
    if (ok) {
      playSfx('respec');
      updateSkillBarGlyphs(ui);
      state.hoverNode = null;
      render();
    } else {
      ui.addLog?.('重置失败', '#888');
      playSfx('deny');
    }
  });
  side.appendChild(respecBtn);

  const tipEl = el('div', { class: 'sc-tip' });
  tipEl.className = 'sc-tip';
  tipEl.appendChild(mkText('剩余点数 '));
  tipEl.appendChild(el('b', { text: String(Math.max(0, skillPointsTotal(game, inv, player) - spentPoints(inv))) }));
  side.appendChild(tipEl);
  card.appendChild(side);

  return card;
}

/**
 * 某技能已投入的技能点（含 cost>1 的节点）。
 * @param {string} skillId @param {Object} ranks
 */
function countSkillPoints(skillId, ranks) {
  let n = 0;
  for (const k in ranks || {}) {
    if (k === skillId || k.startsWith(skillId + '.')) {
      const v = Number(ranks[k]);
      if (Number.isFinite(v) && v > 0) n += v;
    }
  }
  return n;
}

/**
 * 技能等级/精炼变化后，技能栏图标不用重建（数据驱动），但悬停提示可能过期；
 * 这里主动刷新一次技能栏 glyph 的 title（避免 HUD 显示旧名）。
 * @param {Object} ui
 */
function updateSkillBarGlyphs(ui) {
  try {
    const slots = ui.el && ui.el.slots ? ui.el.slots : [];
    const p = ui.game.world.player;
    // 简单刷新：应用层 recalc 会把新等级写回实例；HUD 的图标/名称由 GameUI 的 update 负责
    if (!slots.length || !p) return;
    const bar = p.skillBar || [];
    slots.forEach((slot, i) => {
      const inst = bar[i];
      const glyph = slot.querySelector && slot.querySelector('.glyph');
      if (inst && glyph) glyph.title = inst.name || '';
    });
  } catch { /* 纯装饰，失败无所谓 */ }
}

// ---------------------------------------------------------------------------
// ③ 分叉天赋树
// ---------------------------------------------------------------------------

/**
 * 计算分叉树的节点坐标。
 * 布局规则（契约 3.2 的拓扑）：
 *   core      → 居中，最上一行（ROOT 可能有多个，横向摊开）
 *   left      → 左侧，按「距离 ROOT 的深度」自上而下
 *   right     → 右侧，同左支
 *   leftDeep / rightDeep → 棋下两侧（分支专精）
 *   ultimate  → 居中，最下一行
 * 这样不必依赖分支内部的 requires 链有多长，都得到稳定的「树形」观感。
 * @param {Object} tree
 * @returns {Array<{node:Object, x:number, y:number, branch:string}>}
 */
function layoutTree(tree) {
  const nodes = tree.nodes || [];
  const placed = [];
  const byBranch = {};
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    let b = branchOfNode(tree, n, i);
    if (!BRANCH_META[b]) b = b.includes('left') ? 'left' : b.includes('right') ? 'right' : 'core';
    (byBranch[b] = byBranch[b] || []).push({ node: n, idx: i });
  }

  // 行高：核心/左右支/专精/终极 四层 + 少量留白
  const rowY = { core: 54, left: 168, right: 168, leftDeep: 300, rightDeep: 300, ultimate: 402 };
  const colX = { core: TREE_W / 2, left: TREE_W * 0.27, right: TREE_W * 0.73 };

  /**
   * 把一组节点横向铺开（col 是中心，spread 是每个槽位的最大间距）。
   * 纵向再按节点在数组里的顺序做小幅错位，避免同层两个节点完全重叠。
   */
  function place(list, branch, centerX, spread) {
    const n = list.length || 1;
    list.forEach((it, k) => {
      const x = n === 1 ? centerX : centerX + (k - (n - 1) / 2) * Math.min(spread, TREE_W * 0.2);
      const y = rowY[branch] + (n > 2 ? (k % 2) * 34 : 0);
      placed.push({ node: it.node, x, y, branch, idx: it.idx });
    });
  }

  if (byBranch.core) place(byBranch.core, 'core', colX.core, 200);
  if (byBranch.left) place(byBranch.left, 'left', colX.left, TREE_W * 0.22);
  if (byBranch.right) place(byBranch.right, 'right', colX.right, TREE_W * 0.22);
  if (byBranch.leftDeep) place(byBranch.leftDeep, 'leftDeep', colX.left * 0.82, TREE_W * 0.18);
  if (byBranch.rightDeep) place(byBranch.rightDeep, 'rightDeep', TREE_W - colX.left * 0.82, TREE_W * 0.18);
  if (byBranch.ultimate) place(byBranch.ultimate, 'ultimate', colX.core, 200);

  return placed;
}

/**
 * 构建分叉树区域（滚动容器 + SVG 连线 + 节点按钮 + 详情浮层挂载点）。
 * @param {Object} ui @param {string} skillId @param {Function} render @param {Object} state
 * @returns {HTMLElement}
 */
function buildTree(ui, skillId, render, state) {
  const game = ui.game;
  const player = (game.world && game.world.player) || {};
  const inv = game.inv || {};
  const tree = getTree(skillId);
  const ranks = inv.skillRanks || {};
  const avail = Math.max(0, skillPointsTotal(game, inv, player) - spentPoints(inv));

  const section = el('div', { class: 'skill-tree-section' });
  const head = el('div', { class: 'sts-head' });
  head.innerHTML = `
    <span class="sts-title">天赋分叉</span>
    <span class="sts-legend">
      <i class="lg core"></i>核心
      <i class="lg left"></i>左支·震怒
      <i class="lg right"></i>右支·壁垒
      <i class="lg locked"></i>不可用
    </span>
    <span class="sts-avail">可分配 <b>${avail}</b></span>`;
  section.appendChild(head);

  const scroll = el('div', { class: 'tree-scroll' });
  const canvas = el('div', { class: 'tree-canvas branch-tree' });
  canvas.style.width = TREE_W + 'px';
  canvas.style.height = TREE_H + 'px';
  scroll.appendChild(canvas);
  section.appendChild(scroll);

  if (!tree.nodes || !tree.nodes.length) {
    canvas.appendChild(el('p', {
      class: 'empty',
      text: player && player.type === 'mage'
        ? '法师技能由元素自动循环驱动，本版本暂未开放分叉天赋；可用精炼石提升技能等级。'
        : '该技能暂时没有可加点的天赋分支',
    }));
    return section;
  }

  const placed = layoutTree(tree);
  const posById = {};
  for (const p of placed) posById[p.node.id] = p;

  // ---- 节点 ----
  // 先建节点、量出盒子高度，再画连线（见下方「SVG 连线」）：端点按真实高度算，
  // 否则不同分支的节点（核心 150px / 终极 160px / 普通 128px）高矮不一，线头必然对不上。
  const nodeEls = {};
  for (const p of placed) {
    const node = p.node;
    const meta = BRANCH_META[p.branch] || BRANCH_META.core;
    const rank = rankOf(ranks, tree.id, node);
    const max = node.maxRank || 1;
    const conflict = conflictOf(tree, ranks, node);
    const unmet = unmetRequires(tree, ranks, node);
    const maxed = rank >= max;
    const canBuy = !maxed && !unmet.length && !conflict && avail >= (node.cost || 1);
    const cls = ['tree-node', `branch-${p.branch}`];
    if (rank > 0) cls.push('taken');
    if (canBuy) cls.push('buyable');
    else if (!rank && (unmet.length || conflict || maxed)) cls.push('locked');
    if (conflict) cls.push('conflict');

    const nEl = el('div', {
      class: cls.join(' '),
      'data-node': node.id,
      style: `left:${Math.round(p.x)}px;top:${Math.round(p.y)}px;--branch-color:${meta.color}`,
    });
    nEl.innerHTML = `
      <div class="tn-name">${escapeHTML(node.name || node.id)}</div>
      <div class="tn-rank">${rank}/${max}${node.cost > 1 ? ` <span class="tn-cost">${node.cost}点</span>` : ''}</div>`;
    // 锁定原因直接写进 title：悬停有自定义浮层，但 title 是「不依赖 JS 也能看到」的最后一层信息，
    // 自动化/无障碍也靠它（测试断言锁定节点必须给出原因）。
    nEl.title = nodeStateHint(node, rank, max, unmet, conflict, avail);

    // hover：名称 / 档位 / 描述 / 需前置 / 互斥冲突原因
    nEl.addEventListener('mouseenter', (ev) => {
      state.hoverNode = node.id;
      showNodeDetail(ui, skillId, node.id, ev);
    });
    nEl.addEventListener('mousemove', (ev) => showNodeDetail(ui, skillId, node.id, ev));
    nEl.addEventListener('mouseleave', () => ui.hideTooltip());

    // 点击加点：互斥/前置/点数不足都要给出**具体原因**（只置灰不解释最劝退）
    nEl.addEventListener('click', () => {
      if (maxed) {
        ui.addLog?.(`「${node.name}」已满档 ${max}/${max}`, '#888');
        playSfx('deny');
        return;
      }
      if (conflict) {
        const msg = `「${node.name}」与已选的「${conflict.takenName || conflict.takenNodeId}」互斥（${conflict.group || '同一分支'}），需先重置天赋`;
        ui.toast ? ui.toast(msg, '#ffb547') : ui.addLog?.(msg, '#ffb547');
        playSfx('deny');
        return;
      }
      if (unmet.length) {
        const msg = `「${node.name}」需要先点亮：${unmet.join('、')}`;
        ui.toast ? ui.toast(msg, '#8fd0ff') : ui.addLog?.(msg, '#8fd0ff');
        playSfx('deny');
        return;
      }
      if (avail < (node.cost || 1)) {
        const msg = `技能点不足（需要 ${node.cost || 1} 点，现有 ${avail}）——每升 1 级获得 1 点`;
        ui.toast ? ui.toast(msg, '#888') : ui.addLog?.(msg, '#888');
        playSfx('deny');
        return;
      }
      // 真正的加点交给 app 层（app 内部还有一层互斥/前置/点数校验）
      const acts = game.actions || {};
      const ok = safeCall(acts.skillRankUp, skillId, node.id) || safeCall(acts.doSkillRankUp, skillId, node.id);
      if (ok) {
        playSfx('rankUp');
        updateSkillBarGlyphs(ui);
        render();
      } else {
        ui.addLog?.(`无法加点：${node.name}`, '#888');
        playSfx('deny');
      }
    });
    canvas.appendChild(nEl);
    nodeEls[node.id] = nEl;
  }

  // ---- SVG 连线：选中的金色 / 可点的蓝色脉冲 / 锁住的灰色 ----
  // 端点 = 节点盒子的中心（top + height/2），SVG 插成画布第一个子节点 ⇒ 画在节点盒子下面。
  // 于是连线从父节点盒子内部穿出、钻进子节点盒子，视觉上正好在两条边之间「接上」，
  // 不会出现旧版硬编码 ±26px 那种线头悬空 / 错位的缝隙。
  const centerYOf = (p) => {
    const e = nodeEls[p.node.id];
    // 只认 offsetHeight：clientHeight 在测试桩里是容器的 810，会把端点甩出画布。
    // 脱离文档时 offsetHeight=0，用 NODE_H_FALLBACK；大于 90 的荒唐值同样忽略。
    const h = e ? Number(e.offsetHeight) : 0;
    const boxH = Number.isFinite(h) && h >= 16 && h <= 90 ? h : NODE_H_FALLBACK;
    return p.y + boxH / 2;
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tree-links');
  svg.setAttribute('width', String(TREE_W));
  svg.setAttribute('height', String(TREE_H));
  for (const p of placed) {
    const node = p.node;
    for (const reqId of node.requires || []) {
      const a = posById[reqId] || posById[`${tree.id}.${reqId}`];
      if (!a || !posById[node.id]) continue;
      const b = posById[node.id];
      const aOn = rankOf(ranks, tree.id, a.node) > 0;
      const bOn = rankOf(ranks, tree.id, b.node) > 0;
      const aCan = canRankUpNode(tree, ranks, a.node, avail);
      const bCan = canRankUpNode(tree, ranks, b.node, avail);
      let cls = 'link locked';
      if (aOn && bOn) cls = 'link on';
      else if (aOn && bCan) cls = 'link buyable';
      else if (aCan && bCan) cls = 'link buyable';
      else if (aOn) cls = 'link half';
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(Math.round(a.x)));
      line.setAttribute('y1', String(Math.round(centerYOf(a))));
      line.setAttribute('x2', String(Math.round(b.x)));
      line.setAttribute('y2', String(Math.round(centerYOf(b))));
      line.setAttribute('class', cls);
      line.setAttribute('stroke', cls === 'link on' ? 'rgba(235,200,110,0.85)'
        : cls === 'link buyable' ? 'rgba(120,200,255,0.75)'
          : cls === 'link half' ? 'rgba(150,130,180,0.5)' : 'rgba(80,76,100,0.5)');
      svg.appendChild(line);
    }
  }
  // 垫在节点下面：节点背景不透明，线只会露在两个盒子之间。
  // 精简 DOM 桩（pause.test 的版本）没有 insertBefore，退化成 appendChild —— 桩环境不画像素，顺序无所谓。
  if (typeof canvas.insertBefore === 'function') canvas.insertBefore(svg, canvas.firstChild || null);
  else canvas.appendChild(svg);

  return section;
}

/**
 * 底部资源栏（技能点 / 精炼石 / 互斥说明 / 操作提示）。
 * 全部用真实子节点 + textContent 拼出来（原因见 drawContent 的注释）：
 * 甲环境（桩）读 children 的 textContent、乙环境（真实 DOM）读渲染文字，都能拿到同样内容。
 * @param {Object} ui @param {string} skillId
 * @returns {HTMLElement}
 */
function buildFooter(ui, skillId) {
  const game = ui.game;
  const inv = game.inv || {};
  const player = (game.world && game.world.player) || {};
  const total = skillPointsTotal(game, inv, player);
  const avail = Math.max(0, total - spentPoints(inv));
  const orbs = readOrbs(inv);
  const foes = anyRefineable(ui, skillId);

  const footer = el('div', { class: 'skill-foot' });
  footer.className = 'skill-foot';

  const pointsEl = el('div', { class: 'sf-points' });
  pointsEl.className = 'sf-points';
  pointsEl.appendChild(mkText('可用技能点 '));
  pointsEl.appendChild(el('b', { text: String(avail) }));
  pointsEl.appendChild(mkText(` / ${total}`));
  footer.appendChild(pointsEl);

  const orbsEl = el('div', { class: 'sf-orbs' });
  orbsEl.className = 'sf-orbs';
  const ico = el('i', { class: 'orb-ico', text: '◆' });
  ico.className = 'orb-ico';
  orbsEl.appendChild(ico);
  orbsEl.appendChild(mkText(' 精炼石 '));
  const orbB = el('b', { text: String(orbs) });
  if (foes) orbB.className = 'hot';
  orbsEl.appendChild(orbB);
  footer.appendChild(orbsEl);

  const note = el('div', { class: 'sf-note' });
  note.className = 'sf-note';
  note.appendChild(mkText('左支与右支'));
  note.appendChild(el('b', { text: '互斥' }));
  note.appendChild(mkText('：同一层只能选一边，改派需先「重置天赋」。技能等级 = 天赋点数 + 精炼等级 − 1。'));
  footer.appendChild(note);

  const keys = el('div', { class: 'sf-keys', text: '点击 加点 · Tab / K 开关面板 · M 静音' });
  keys.className = 'sf-keys';
  footer.appendChild(keys);
  return footer;
}

/**
 * 创建文本节点；极简 DOM 桩里可能没有 createTextNode，就退化成 <span>。
 * @param {string} s
 * @returns {Node|Element}
 */
function mkText(s) {
  try {
    if (typeof document !== 'undefined' && typeof document.createTextNode === 'function') {
      return document.createTextNode(s);
    }
  } catch { /* 落到 span */ }
  const sp = el('span', { text: s });
  sp.className = 'txt';
  return sp;
}

/**
 * 节点状态的一句话原因（用于 title 与 tooltip）：名称 · 档位 · 为什么不能点。
 * @param {Object} node @param {number} rank @param {number} max
 * @param {string[]} unmet @param {Object|null} conflict @param {number} avail
 * @returns {string}
 */
function nodeStateHint(node, rank, max, unmet, conflict, avail) {
  const head = `${node.name || node.id}（${rank}/${max}）`;
  if (conflict) return `${head} — 与「${conflict.takenName || conflict.takenNodeId}」互斥，需先重置天赋`;
  if (unmet.length) return `${head} — 需要先点亮：${unmet.join('、')}`;
  if (rank >= max) return `${head} — 已满档`;
  if (avail < (node.cost || 1)) return `${head} — 技能点不足（需要 ${node.cost || 1}，现有 ${avail}）`;
  return `${head} — 点击加点`;
}

/**
 * 节点悬停详情：名称 / 档位 / 描述 / 前置 / 互斥冲突原因 / 能不能点。
 * @param {Object} ui @param {string} skillId @param {string} nodeId @param {MouseEvent} [ev]
 */
function showNodeDetail(ui, skillId, nodeId, ev) {
  if (!ui || !ui.game || !ui.game.inv) return;
  const tree = getTree(skillId);
  const node = (tree.nodes || []).find((n) => n.id === nodeId || `${tree.id}.${n.id}` === nodeId);
  if (!node) return;
  const inv = ui.game.inv;
  const ranks = inv.skillRanks || {};
  const player = (ui.game.world && ui.game.world.player) || {};
  const avail = Math.max(0, skillPointsTotal(ui.game, inv, player) - spentPoints(inv));
  const rank = rankOf(ranks, tree.id, node);
  const max = node.maxRank || 1;
  const conflict = conflictOf(tree, ranks, node);
  const unmet = unmetRequires(tree, ranks, node);
  const maxed = rank >= max;
  const branch = branchOfNode(tree, node, (tree.nodes || []).indexOf(node));
  const meta = BRANCH_META[branch] || BRANCH_META.core;

  const lines = [];
  lines.push(`<div class="tt-name" style="color:${meta.color}">${escapeHTML(node.name || node.id)}</div>`);
  lines.push(`<div class="tt-sub">${meta.label} · 档位 ${rank}/${max}${node.cost > 1 ? ` · 每档 ${node.cost} 技能点` : ''}</div>`);
  const et = effectText(node);
  if (et) lines.push(`<div class="tt-line node-desc">${escapeHTML(et)}</div>`);
  if ((node.requires || []).length) {
    const reqNames = (node.requires || []).map((r) => {
      const rn = (tree.nodes || []).find((x) => x.id === r || x.id === `${tree.id}.${r}`);
      return rn ? rn.name : String(r).split('.').pop();
    });
    lines.push(`<div class="tt-line implicit">需前置：${escapeHTML(reqNames.join('、'))}</div>`);
  }
  if (conflict) {
    lines.push(`<div class="tt-warn">⚠ 与「${escapeHTML(conflict.takenName || conflict.takenNodeId)}」互斥（同属「${escapeHTML(String(conflict.group || '分支'))}」组），改派需先「重置天赋」</div>`);
  } else if (maxed) {
    lines.push('<div class="tt-ok">✔ 已满档</div>');
  } else if (unmet.length) {
    lines.push(`<div class="tt-warn">🔒 尚未满足前置</div>`);
  } else if (avail < (node.cost || 1)) {
    lines.push(`<div class="tt-warn">技能点不足（现有 ${avail}）</div>`);
  } else {
    lines.push('<div class="tt-ok">✔ 点击加点</div>');
  }
  const html = `<div class="skill-tip node-tip">${lines.join('')}</div>`;
  const x = ev && Number.isFinite(ev.clientX) ? ev.clientX : 40;
  const y = ev && Number.isFinite(ev.clientY) ? ev.clientY : 40;
  ui.showTooltip?.(html, x, y);
}