// 浏览器入口：启动渲染 + 主循环 + 输入 + UI 交互。
//
// 【防御式依赖】src/game/app.js 由 data-dev 并行迭代，技能精炼/重置这些新动作可能还没落地。
// 所以这里对 app 模块用命名空间 import（而不是具名 import）：即使某个新导出暂时不存在，
// 也不会让整个入口模块（以及依赖它的所有 UI）加载失败。
import {
  createGame, updateGame, clearEvents, revivePlayer, travelToNewMap,
  doTakeTalent, doRefundTalent, doSkillRankUp, doEquipFromBag, doPickup, doUnequip, doSell, doSellAllJunk,
  doSetMagePreset,
} from '../game/app.js';
import * as appMod from '../game/app.js';
import { loadMap } from '../game/world.js';
import { sortBag } from '../game/inventory.js';
import { Input } from '../game/input.js';
import { GameUI } from './ui.js';
import { openSkills } from './skill-ui.js';
import {
  saveGame as saveToStorage, loadGame as loadFromStorage, applySave as applySaveToGame,
  getSaveSummary, formatPlayTime, formatSaveAge, hasStorage,
} from '../game/save.js';
import { Renderer } from '../render/renderer.js';

const canvas = document.getElementById('game');
// ---------------------------------------------------------------------------
// 进程内状态（game / renderer / input / ui / running / lastT / acc）
//
// 【这段写法很讲究，别"顺手整理"成 let/const，也别改成裸赋值】
// 本文件会被测试（tests/pause.test.mjs）剥掉 import 后在 vm 沙箱里执行：沙箱用
// `get game() { return fakeGame; }` / `get ui() {...}` / `get renderer() {...}` 这类访问器
// 把**同名全局**映射成测试里的假对象。三件事都踩过坑：
//  ① `let game = null` → 模块作用域变量遮蔽同名全局，frame() 永远读到 null（updateGame 一帧都没跑）；
//  ② 裸赋值 `game = x` → 单文件包（打包器把模块塞进一个大函数，且外部环境被当成"全局词法环境"）
//     解析不到绑定，严格模式下抛 ReferenceError: game is not defined → 单文件版启动即崩；
//  ③ `globalThis.game = x` 在沙箱里会撞上不可写的注入 getter（抛），也不能真改掉沙箱状态。
// 结论：**读**用裸名字（沙箱 getter / 浏览器全局都能命中），**写**统一走 setState()
//      （浏览器里写 globalThis = window；沙箱写注入 getter 失败时退化为模块影子变量）。
// input 是本地状态（沙箱不注入），必须真实声明；用 var 而不是 let：let 的 TDZ 会让模块体
// 执行到那一行之前的任何读取炸掉（V8 还会把错误信息显示成含糊的 "game is not defined"）。
// tests/input-session.test.mjs 有一条守护测试覆盖这条约定。
// ---------------------------------------------------------------------------
var input = null;     // Input 实例

// 状态写入适配器（见上面的说明）。只用于 game/renderer/ui/running/lastT/acc/input 这 7 个名字。
const __shadowState = { game: null, renderer: null, ui: null, running: false, lastT: 0, acc: 0, input: null };
/**
 * 写状态：**先写模块内状态，再写全局**。
 *
 * 【踩过的大坑 · 别再改回去】这里必须只用一句 `local[name] = value`，
 * 它同时满足三种运行环境：
 *   · 浏览器 ESM / 单文件包：`local` 是函数本身，等于挂到 window 上（或打包器的模块作用域）；
 *   · 测试的 vm 沙箱：`local` 里预先埋了 `get game(){ return fakeGame }` 这类访问器，
 *     赋值会落到访问器的 setter 上 —— 与老写法 `game = x` 的语义**完全一致**。
 *
 * 【为什么不能只写 globalThis】曾经的实现是 `globalThis[name] = value`，
 * 结果 `input` 这个**局部变量**（第 40 行 `var input = null`）从来没有被赋值：
 *   `readInput()` 里读到的 input 永远是 null → 命中 "没有输入" 的降级分支 →
 *   **移动、普攻、技能、翻滚全部失效**（角色死了/活了都在原地，按键只有冷却条在动）。
 * 单文件版和浏览器版都会中招，而且不报任何错 —— 因为降级分支是"故意不抛异常"的。
 * @param {'game'|'renderer'|'ui'|'running'|'lastT'|'acc'|'input'} name
 * @param {*} value
 */
function setState(name, value) {
  // ① 写回模块内状态（这是真正被 frame()/readInput() 读取的那份）
  try {
    if (local && typeof local === 'object') local[name] = value;
  } catch {
    // 沙箱访问器不可写：退化为影子变量
  }
  __shadowState[name] = value;
  // ② 再尽力同步到全局（沙箱里会和沙箱自身的存取器撞车，失败无所谓）
  try {
    globalThis[name] = value;
  } catch { /* 沙箱注入的不可写存取器 */ }
}
// `local` 必须声明在 setState 之前生效（函数体是运行期才读它，这里顺序无所谓）；
// 用 globalThis 作为"可写的自身"：浏览器/单文件版里就是 window。
const local = (typeof globalThis !== 'undefined' && globalThis) ? globalThis : {};
/** 读状态：**局部优先**（浏览器里=全局；沙箱里=注入的 getter），读不到再用影子变量 */
function getState(name) {
  const v = local[name];
  if (v !== undefined) return v;
  const g = (typeof globalThis !== 'undefined' && globalThis) ? globalThis[name] : undefined;
  if (g !== undefined) return g;
  return __shadowState[name];
}
const STEP = 1 / 60;
// 暂停时给渲染层的"时间"：必须是正数（renderer 把 dt<=0 当成没传、会改用 1/60），
// 又要足够小到让所有按 dt 积分的视觉系统看起来冻住（1e-6 秒 ≈ 0）。
const PAUSE_RENDER_DT = 1e-6;
let frameCount = 0;
let fps = 60;
let fpsTimer = 0;

// ---------------------------------------------------------------------------
// 渲染器初始化（带降级：渲染器异常时不阻塞游戏逻辑）
// ---------------------------------------------------------------------------
function makeRenderer() {
  try {
    const r = new Renderer(canvas);
    if (r && typeof r.resize === 'function') r.resize();
    if (r && r.camera && typeof r.camera.center === 'function') r.camera.center(game.world.player.x, game.world.player.z);
    return r;
  } catch (e) {
    console.error('[render] 初始化失败', e);
    return fallbackRenderer();
  }
}

function fallbackRenderer() {
  const ctx = canvas.getContext('2d');
  return {
    render(world) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr, h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = world.dungeon?.theme?.floor || '#1a1512';
      ctx.fillRect(0, 0, w, h);
      const p = world.player, s = 30;
      const proj = (x, z) => ({ x: w / 2 + (x - p.x) * s, y: h / 2 + (z - p.z) * s });
      ctx.fillStyle = '#8a1f1f';
      for (const m of world.monsters) {
        const q = proj(m.x, m.z);
        ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, Math.PI * 2); ctx.fill();
      }
      const q = proj(p.x, p.z);
      ctx.fillStyle = '#e8c05a';
      ctx.beginPath(); ctx.arc(q.x, q.y, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif';
      ctx.fillText(`HP ${Math.round(p.hp)}/${Math.round(p.maxHp)}  怪物 ${world.monsters.length} · ${world.map?.name || ''}`, 20, 30);
    },
    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    },
    screenToWorld(x, y) {
      const p = game.world.player;
      return { x: p.x + (x - canvas.clientWidth / 2) / 30, z: p.z + (y - canvas.clientHeight / 2) / 30 };
    },
    camera: null,
  };
}

// ---------------------------------------------------------------------------
// 动作桥：优先用 app 的新导出，缺席时退回本文件里的等价实现
// ---------------------------------------------------------------------------
/**
 * 取 app 模块里的函数（不存在则 undefined）。每次现取，不做模块级缓存，
 * 方便开发期 app.js 补齐导出后立即生效。
 * @param {string} name
 * @returns {Function|undefined}
 */
function appFn(name) {
  const fn = appMod[name];
  return typeof fn === 'function' ? fn : undefined;
}

/** 精炼技能：app 的 doSkillRefine > 老接口 doRefineSkill */
function refineSkillAction(game, skillId) {
  const a = appFn('doSkillRefine') || appFn('refineSkillAction') || appFn('doRefineSkill');
  if (a) {
    try { return a(game, skillId); } catch (err) { console.warn('[main] 精炼失败', err); return false; }
  }
  // 兜底：旧版 app 完全没有精炼逻辑，直接 telling 玩家（返回 false 让面板给出提示）
  return false;
}

/** 重置技能天赋：app 的 doSkillRespec > 老接口 doRespecSkill */
function respecSkillAction(game, skillId) {
  const a = appFn('doSkillRespec') || appFn('doRespecSkill');
  if (a) {
    try { return a(game, skillId); } catch (err) { console.warn('[main] 重置天赋失败', err); return false; }
  }
  return false;
}

/**
 * 技能点总量：app 的 skillPointsTotal(game) > data 层的 skillPointsForLevel > 本地公式。
 * 语义是「到当前等级为止总共获得过多少点」，已花掉的由 UI 自行扣减。
 *
 * 【公式同步】当前曲线是「每级 +1」：Lv.1=1 / Lv.10=10 / Lv.14=14。
 * 这里优先直接调 app 的 skillPointsForLevel，避免 UI 再抄一份公式；两层都缺席时才用本地兜底，
 * 兜底也必须写成同样的「每级 +1」，否则 app 动作一失败就会少显示点数。
 */
function skillPointsTotalAction(game) {
  const a = appFn('skillPointsTotal');
  if (a) {
    try {
      const v = a(game);
      if (Number.isFinite(v)) return v;
      if (v && typeof v === 'object' && Number.isFinite(v.avail)) return v.avail;
    } catch (err) { console.warn('[main] skillPointsTotal 失败', err); }
  }
  const p = game.world.player;
  const inv = game.inv;
  const lvl = Math.max(1, Math.floor(Number(p.level) || 1));
  let byLevel = lvl;
  const forLevel = appFn('skillPointsForLevel');
  if (forLevel) {
    try {
      const v = forLevel(lvl);
      if (Number.isFinite(v)) byLevel = v;
    } catch { /* 用本地公式 */ }
  }
  const stored = inv && inv.skillPoints && Number.isFinite(inv.skillPoints.total) ? inv.skillPoints.total : 0;
  return Math.max(byLevel, stored);
}

/** 某技能能否精炼（HUD 角标用；用 app 的 canRefine 时把结果规整成布尔） */
function canRefineAction(game, skillId) {
  const mod = appMod.canRefine;
  if (typeof mod === 'function') {
    try {
      const r = mod(game.inv, game.world.player, skillId);
      if (r && typeof r === 'object') return !!r.ok;
      return !!r;
    } catch { return false; }
  }
  return false;
}

/** 停下时同步一次技能栏角标（等级变化不会立刻产生事件，靠这里补一刀） */
function refreshSkillNotify() {
  if (!ui) return;
  try { ui.showSkillNotify?.(); } catch { /* 纯装饰 */ }
}

// 等级变化 → 技能点变化：面板/角标要立即反映（app 的事件流不保证会推 levelUp 之后的点数）
let _lastLevel = 0;
function watchLevel() {
  if (!game) return;
  const lvl = game.world.player.level | 0;
  if (lvl !== _lastLevel) {
    const leveledUp = lvl > _lastLevel && _lastLevel > 0; // 读档的第一帧不算"升级"
    _lastLevel = lvl;
    refreshSkillNotify();
    // 面板开着时刷新一次，保证「可分配点数」与节点可点态实时正确
    if (ui && ui.modalOpen === 'skills') openSkills(ui);
    // 升级后自动存档（节流 ≤1 次/10s，静默）
    if (leveledUp) autoSave(game.world.time || 0);
  }
}

// ---------------------------------------------------------------------------
// UI 方法兜底：ui.js 由队友并行修改（openPanel / handleEscape / togglePause 可能还不存在），
// 这里统一判型：新 API 缺席时退回旧逻辑（toggleXxx / closeModals），保证入口不会因为 UI 没跟上而崩。
// ---------------------------------------------------------------------------
/** UI 上的某方法是否可用 */
function uiHas(name) {
  return !!ui && typeof ui[name] === 'function';
}

/** 某个面板当前是否打开（ui.modalOpen 约定为 'inventory' | 'talents' | 'skills' | 'stats' | null） */
function panelOpen(kind) {
  return !!ui && ui.modalOpen === kind;
}

/**
 * 打开/关闭面板的**唯一入口**（快捷键只走这里，避免"一个键两个路径"的双触发）。
 *  - 优先 ui.openPanel(kind)：由 panelbar-dev 实现，内部处理「同一个面板再按一次就关」；
 *  - 缺席时退回旧的 toggleXxx（同样有开关语义）；
 *  - 都没有时直接 openModal + 对应渲染函数。
 * @param {'stats'|'talents'|'skills'|'inventory'} kind
 * @returns {boolean} 是否处理成功
 */
function openPanelRoute(kind) {
  if (!ui) return false;
  try {
    if (typeof ui.openPanel === 'function') {
      ui.openPanel(kind);
      return true;
    }
    // 旧 API 兜底：toggleXxx（开关语义）
    const legacy = { talents: 'toggleTalents', skills: 'toggleSkills', inventory: 'toggleInventory' }[kind];
    if (legacy && typeof ui[legacy] === 'function') {
      ui[legacy]();
      return true;
    }
    // 最后兜底：openModal + 对应渲染函数（老 ui.js 没有统一的 openPanel）
    return openPanelLegacy(kind);
  } catch (e) {
    console.warn('[main] 打开面板失败', kind, e);
    return false;
  }
}

/** 真正执行"开/关同一个面板"的老逻辑（ui.openPanel 缺席时用） */
function openPanelLegacy(kind) {
  if (panelOpen(kind)) { ui.closeModals?.(); return true; }
  // 允许"面板互斥"：当前开着别的面板时先关掉（ui.openPanel 已内建这一行为）
  if (panelOpen('inventory') || panelOpen('talents') || panelOpen('skills') || panelOpen('stats')) ui.closeModals?.();
  if (typeof ui.openModal !== 'function') return false;
  ui.openModal(kind);
  // 老 ui.js 的 toggleXxx 都是「openModal + 渲染」，这里复用渲染函数；
  // 注意不要把 toggleXxx 放在 openModal 之后调（它们看到 modalOpen 相同会立刻关掉）
  const render = { inventory: 'openInventory', talents: 'openTalents', skills: 'openSkills', stats: 'openStats' }[kind];
  if (render && typeof ui[render] === 'function') ui[render]();
  else if (typeof ui.OnPanelOpen === 'function') ui.OnPanelOpen(kind);
  return true;
}

/**
 * ESC 的唯一入口：优先 ui.handleEscape()（pause-dev 的状态机：先关面板 → 再关暂停 → 最后打开暂停），
 * 缺席时退回「关掉所有面板」的旧行为。
 */
function escapeRoute() {
  if (!ui) return false;
  try {
    if (typeof ui.handleEscape === 'function') {
      ui.handleEscape();
      return true;
    }
    if (typeof ui.closeModals === 'function') { ui.closeModals(); return true; }
  } catch (e) {
    console.warn('[main] ESC 处理失败', e);
  }
  return false;
}

/** 暂停菜单是否打开（暂停核心由 pause-dev 实现；这里只做只读判型，不自己写状态） */
function isPauseMenuOpen() {
  if (!ui) return false;
  // ui.isPauseMenuOpen() 只看"菜单有没有显示"（面板压在它上面时会让位 = false）
  if (typeof ui.isPauseMenuOpen === 'function') { try { return !!ui.isPauseMenuOpen(); } catch { /* 走字段判断 */ } }
  if (typeof ui.isPaused === 'function') { try { return !!ui.isPaused(); } catch { /* 走字段判断 */ } }
  if (ui.paused === true) return true;
  if (ui.pauseMenuOpen === true) return true;
  if (typeof ui.pauseOpen === 'boolean' && ui.pauseOpen) return true;
  return false;
}

/** 世界是否处于暂停（game 与 ui 任一侧说的都算：ui.isPaused 会同时看 this.paused / game.paused / world.paused） */
function isWorldPaused() {
  if (game && game.paused) return true;
  if (game && game.world && game.world.paused) return true;
  if (ui && typeof ui.isPaused === 'function') { try { return !!ui.isPaused(); } catch { /* 忽略 */ } }
  return !!(ui && ui.paused === true);
}

/** 是否有任何"会吃掉游戏输入"的界面：面板 / 暂停菜单 / 游戏暂停 */
function isInputBlocked() {
  return isWorldPaused() || !!ui?.modalOpen || isPauseMenuOpen();
}

/**
 * 输入焦点守卫：面板/暂停菜单打开时停用游戏键（Input 层不再记录 W/A/S/D/技能键）。
 * **注意**：快捷键（ESC/C/P/K/I/E/Tab/M）必须仍然有效，所以键盘路由不读 input，
 * 而是由 window 上的 keydown 捕获阶段记进 pendingHotkeys，再在 readInput 里统一消费一次。
 */
let _lastInputBlocked = null;
function syncInputFocus() {
  if (!input) return;
  const blocked = isInputBlocked();
  if (blocked === _lastInputBlocked) return;
  _lastInputBlocked = blocked;
  // 判型：Input 类永远有这些方法，但本函数也会在无 DOM 的 vm 沙箱里被调用（测试传的是极简 input）
  if (typeof input.setGameKeysEnabled === 'function') input.setGameKeysEnabled(!blocked);
  else input.gameKeysEnabled = !blocked;
  if (blocked) {
    // 进面板/暂停时把鼠标的按住状态也清掉：否则关面板后会"凭空砍一刀"或一直施法
    if (input.mouse) {
      input.mouse.down = false;
      input.mouse.rightDown = false;
    }
    if (typeof input.clearPressed === 'function') input.clearPressed();
    if (game && game.world && game.world.player) {
      game.world.player.moveX = 0;
      game.world.player.moveZ = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// 存档：手动保存 / 自动保存（全部静默降级，localStorage 不可用时游戏照常运行）
// ---------------------------------------------------------------------------
const AUTOSAVE_INTERVAL = 60; // 秒
const AUTOSAVE_THROTTLE = 10; // 秒：换图/升级触发的自动存档最多每 10 秒一次
let _autoSaveT = 0;
let _lastAutoSaveAt = -Infinity;
let _autoSaveTimer = 0;
let _saveWarned = false;

/**
 * 静默自动存档（不写日志）。节流 ≤1 次/10s + 最少间隔 60s 的定时触发由调用方控制。
 * @param {number} worldTime 游戏内时间（秒）
 * @returns {boolean}
 */
function autoSave(worldTime = 0) {
  if (!game || !running) return false;
  if (worldTime - _lastAutoSaveAt < AUTOSAVE_THROTTLE) return false;
  _lastAutoSaveAt = worldTime;
  _autoSaveT = worldTime;
  try {
    return !!saveToStorage(game.world, game.inv);
  } catch {
    return false; // 隐私模式 / 配额满：静默
  }
}

/**
 * 手动保存（game.actions.save / 暂停菜单「保存游戏」按钮）。
 * @param {boolean} silent true 时不写日志（自动存档用）
 * @returns {boolean}
 */
function saveNow(silent = false) {
  if (!game) return false;
  let ok = false;
  try {
    ok = !!saveToStorage(game.world, game.inv);
  } catch {
    ok = false;
  }
  if (!ok && !_saveWarned) {
    _saveWarned = true;
    console.warn('[save] 存档失败：localStorage 不可用或被禁用，游戏继续运行');
  }
  if (!silent && ui) {
    if (ok) ui.addLog(`💾 已保存（Lv.${game.world.player.level} · 第 ${game.world.tier} 层）`, '#8fbf8f');
    else ui.addLog('⚠ 保存失败（浏览器禁用了本地存储）', '#ff6a5a');
  }
  return ok;
}

/** 主循环每帧调用：每 60 秒自动存档一次（节流 10s） */
function tickAutoSave(worldTime) {
  if (!running || !game) return;
  if (worldTime - _autoSaveT < AUTOSAVE_INTERVAL) return;
  _autoSaveT = worldTime; // 无论成功失败都推进，避免每帧重试
  autoSave(worldTime);
}

/**
 * 开始界面：读存档并刷新 #btn-start 文案 / #profile-info。
 * localStorage 不可用 / 没有存档 / 存档损坏 → 全部静默，保持「进入神庙」。
 */
let _pendingSave = null;
/** 开始界面当前选择的职业（warrior | mage） */
let _selectedClass = 'warrior';

/** 存档里的职业（老存档没有 classId → 战士） */
function saveClassOf(data) {
  return data && data.player && data.player.classId === 'mage' ? 'mage' : 'warrior';
}

/**
 * 开始界面选中职业（卡片点击 / 键盘选择共用）。
 * @param {'warrior'|'mage'} cls
 */
function selectStartClass(cls) {
  if (cls !== 'warrior' && cls !== 'mage') return _selectedClass;
  _selectedClass = cls;
  syncStartScreenSelection();
  return _selectedClass;
}

/** 开始按钮文案/提示：无存档 = 以当前职业进入；有同职业存档 = 继续旅程；选了不同职业 = 新旅程 */
function syncStartScreenSelection() {
  const btn = document.getElementById('btn-start');
  const info = document.getElementById('profile-info');
  const cards = document.querySelectorAll ? document.querySelectorAll('#start-screen .class-card') : [];
  const label = _selectedClass === 'mage' ? '元素法师' : '战士';
  for (const card of cards) {
    if (!card || !card.classList) continue;
    const cls = card.getAttribute ? card.getAttribute('data-class') : card.dataset && card.dataset.class;
    card.classList.toggle('selected', cls === _selectedClass);
    if (card.setAttribute) card.setAttribute('aria-pressed', cls === _selectedClass ? 'true' : 'false');
  }
  if (!btn) return;
  if (!_pendingSave) {
    // 按钮直接写出职业名：否则玩家点了卡片后仍看到「进入神庙」，会误以为没有选中。
    btn.textContent = `以${label}进入神庙`;
    if (info) {
      info.textContent = _selectedClass === 'mage'
        ? '已选择：元素法师 · 自动施法 · 左键锁定 · T 元素狂潮 · 空格闪现'
        : '已选择：战士 · 左键普攻 · QWERT 技能 · 空格翻滚';
    }
    return;
  }
  const saveClass = saveClassOf(_pendingSave);
  const same = saveClass === _selectedClass;
  btn.textContent = same ? `继续旅程 · ${label}` : `以${label}开始新旅程`;
  if (info && !same) {
    const classLabel = saveClass === 'mage' ? '元素法师' : '战士';
    const old = info.getAttribute('data-save-text') || info.textContent || '';
    info.setAttribute('data-save-text', old);
    info.textContent = `当前存档：${classLabel}。点击开始将新建一局（旧存档会在自动存档时被覆盖）。`;
  } else if (info) {
    const saved = info.getAttribute('data-save-text');
    if (saved) info.textContent = saved;
  }
}

function refreshStartScreen() {
  const btn = document.getElementById('btn-start');
  const info = document.getElementById('profile-info');
  _pendingSave = null;
  let data = null;
  try {
    data = hasStorage() ? loadFromStorage() : null;
  } catch {
    data = null;
  }
  const sum = data ? getSaveSummary(data) : null;
  if (!sum) {
    if (btn) btn.textContent = '进入神庙';
    if (info) { info.textContent = ''; info.removeAttribute?.('data-save-text'); }
    syncStartScreenSelection();
    return null;
  }
  _pendingSave = data;
  _selectedClass = saveClassOf(data);
  const classLabel = _selectedClass === 'mage' ? '元素法师' : '战士';
  if (info) {
    const parts = [
      `存档：${classLabel} · Lv.${sum.level}`,
      `第 ${sum.tier} 层`,
      `金币 ${sum.gold}`,
      `游戏 ${formatPlayTime(sum.playTime)}`,
    ];
    const age = formatSaveAge(sum.ts);
    if (age) parts.push(age);
    info.textContent = parts.join(' · ');
    info.setAttribute('data-save-text', info.textContent);
  }
  syncStartScreenSelection();
  return sum;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function startGame() {
  document.getElementById('start-screen')?.classList.add('hidden');
  document.getElementById('hud')?.classList.remove('hidden');
  document.getElementById('loading')?.classList.add('hidden');
  // 【调试】`game = createGame({})` 在单文件包里抛 "ReferenceError: game is not defined"：
  // 打包器把外部环境当"全局词法环境"，裸赋值写不出去。这里是临时探针（会删）。
  if (typeof globalThis === 'undefined') { /* probe-a */ }
  setState('game', createGame({ classId: _selectedClass }));
  // 把 data 层的「技能点曲线」挂到 game 上：UI 各处兜底都读它，
  // 这样以后曲线再变也只需要改 app.js 一处，不会出现 UI 与数据层算法漂移。
  const spfl = appFn('skillPointsForLevel');
  if (spfl) {
    Object.defineProperty(game, '__skillPointsForLevel', {
      value: spfl, writable: true, configurable: true, enumerable: false,
    });
  }
  // ---- 读档：把存档合并进刚创建的 game（失败 → 全新游戏）----
  // 注意顺序：必须在 renderer / ui 创建**之前**完成，否则 UI 会先按 Lv.1 的数值渲染一轮。
  let saveApplied = false;
  let restoreInfo = null;
  try {
    const candidate = _pendingSave || (hasStorage() ? loadFromStorage() : null);
    // 只有「存档职业 = 开始界面选择的职业」才读档；否则按玩家选择开始新一局。
    const data = candidate && saveClassOf(candidate) === _selectedClass ? candidate : null;
    if (data) {
      saveApplied = !!applySaveToGame(game, data);
      if (saveApplied) restoreInfo = getSaveSummary(data);
    }
  } catch (e) {
    console.warn('[save] 读档失败，按新游戏开始', e);
    saveApplied = false;
  }
  _pendingSave = null;
  if (saveApplied) {
    // applySave 只记了目标层数，这里真正把地图换成存档层（loadMap 会重置怪物/掉落与玩家位置）
    try { loadMap(game.world, { tier: game.world.tier }); } catch (e) { console.warn('[save] 换图失败', e); }
    try {
      if (typeof game.recalcPlayer === 'function') game.recalcPlayer();
      if (typeof game.world.__syncTalentPoints === 'function') game.world.__syncTalentPoints();
    } catch (e) { console.warn('[save] 读档后重算失败', e); }
  }
  setState('renderer', makeRenderer());
  setState('ui', new GameUI(game));
  game.ui = ui;
  game.actions = {
    revive: () => revivePlayer(game),
    newMap: () => travelToNewMap(game),
    pickup: () => doPickup(game),
    equipFromBag: (i) => doEquipFromBag(game, i),
    unequip: (s) => doUnequip(game, s),
    sell: (i) => doSell(game, i),
    sellJunk: () => doSellAllJunk(game),
    sortBag: () => { sortBag(game.inv); ui.onInventoryChange(); },
    setMagePreset: (preset) => doSetMagePreset(game, preset),
    takeTalent: (id) => doTakeTalent(game, id),
    refundTalent: (id) => doRefundTalent(game, id),
    // ---- 技能树 / 精炼 / 重置（UX 层只做转发，校验全在 app 里）----
    skillRankUp: (sid, nid) => doSkillRankUp(game, sid, nid),
    refineSkill: (sid) => refineSkillAction(game, sid),
    respecSkill: (sid) => respecSkillAction(game, sid),
    skillPointsTotal: () => skillPointsTotalAction(game),
    canRefine: (sid) => canRefineAction(game, sid),
    // ---- 存档（暂停菜单「保存游戏」按钮直接复用这个）----
    save: () => saveNow(false),
    autoSave: () => saveNow(true),
    hasSave: () => { try { return hasStorage() && !!loadFromStorage(); } catch { return false; } },
  };
  setState('input', new Input(canvas));
  // 【必须显式回写】setState 只负责全局/影子状态，而 frame() → readInput() 读的是
  // 模块内的局部变量 `input`（第 40 行 `var input = null`）。少了这一行，
  // readInput 永远看到 null → 走"没有输入"的降级分支 → 移动/普攻/技能/翻滚全部失灵。
  input = getState('input');
  // 【接线】GameUI 的技能栏按钮（点击施法 / 翻滚 / 回城）需要拿到 Input 实例。
  // GameUI 是在 Input 之前构造的（它要读 player / world），所以这里补一刀；
  // ui._inputRef() 还会在缺失时回退到 window.__poeMain.input，双保险。
  if (ui) ui.input = input;
  // 输入焦点守卫初值：暂停菜单/面板默认都是关的
  _lastInputBlocked = null;
  syncInputFocus();
  _pendingHotkeys.clear();
  // 自动存档计时清零（每 60 秒一次）
  const nowT = game.world.time || 0;
  _autoSaveT = nowT;
  _lastAutoSaveAt = nowT - AUTOSAVE_THROTTLE;
  _autoSaveTimer = nowT;
  ui.refreshMap();
  ui.renderStatsPanel();
  ui.refreshSkillBarIcons();
  ui.refreshClassUI?.();
  ui.updateSkillNotify();
  _lastLevel = game.world.player.level | 0;
  if (saveApplied && restoreInfo) {
    ui.addLog(`已读取存档：${restoreInfo.classId === 'mage' ? '元素法师' : '战士'} · Lv.${restoreInfo.level} · 第 ${restoreInfo.tier} 层 · 金币 ${restoreInfo.gold}`, '#8be8ff');
  } else if (game.world.player.type === 'mage') {
    ui.addLog('法师自动施法：Q/W/E/R 由循环自动释放 · 左键锁定目标 · T 元素狂潮（共鸣满） · 空格闪现 · K 技能 · C 属性', '#9ad8ff');
  } else {
    ui.addLog('方向键 / WASD 移动 · Q W E R T 技能 · 左键攻击 · 空格翻滚 · F 拾取 · I 背包 · K/Tab 技能天赋 · P 天赋 · C 属性 · ESC 暂停', '#c8a25a');
  }
  setState('running', true);
  setState('lastT', performance.now());
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------
function frame(now) {
  if (!running) return;
  const realDt = Math.min(0.1, (now - lastT) / 1000);
  setState('lastT', now);
  fpsTimer += realDt;
  frameCount++;
  if (fpsTimer >= 0.5) {
    fps = Math.round(frameCount / fpsTimer);
    frameCount = 0;
    fpsTimer = 0;
    if (ui) ui.setFps(fps);
  }
  // 慢动作（渲染层提供）
  const ts = renderer && typeof renderer.timeScale === 'function' ? renderer.timeScale() : 1;
  const stepDt = STEP * (ts > 0 ? ts : 1);

  // ---- 暂停：世界完全冻结 ----
  // 暂停状态由 GameUI 维护（ui.isPaused()，底层 game.paused；updateGame 里也有 `if (game.paused) return`）。
  // 这里在循环层再挡一次：暂停时**不调用 updateGame**、丢弃累计步长，
  // 于是 world.time / 怪物坐标 / 冷却 / 持续伤害 / 掉落吸引全部停止推进。
  // （暂停 3 秒后这几个值必须与暂停前逐位一致，见 tests/pause.test.mjs）
  const paused = !!(ui && typeof ui.isPaused === 'function' ? ui.isPaused() : (game && game.paused));
  if (paused) {
    setState('acc', 0); // 暂停期间累计的时间直接丢掉：恢复后不会出现"补帧"
  } else {
    setState('acc', getState('acc') + realDt);
    let steps = 0;
    const aim = getAim();
    while (acc >= stepDt && steps < 6) {
      setState('acc', getState('acc') - stepDt);
      steps++;
      updateGame(game, STEP, readInput(aim));
    }
    if (steps >= 6) acc = 0;
  }

  // ---- 世界事件 → 视觉（伤害数字 / 命中特效 / 飘字）----
  // 渲染层只消费不清空，clearEvents 在本帧末尾统一清空（见文件末尾）。
  // 【必须接线】core 的 'hit' / 'crit' / 'heal' 等事件只有喂给 renderer.emitFromEvent
  // 才会变成伤害数字；少了这一步，打怪和自己掉血都看不到任何数值。
  const fw = game && game.world;
  if (fw && Array.isArray(fw.events) && fw.events.length
    && renderer && typeof renderer.emitFromEvent === 'function') {
    for (let i = 0; i < fw.events.length; i++) {
      try { renderer.emitFromEvent(fw.events[i]); } catch { /* 单条坏事件不影响整帧 */ }
    }
  }

  // ---- 渲染照常，但暂停时 simDt 必须"几乎为 0" ----
  // 【踩坑】不能直接传 0：renderer._renderFrame 里 `if (!(dt > 0)) dt = 1/60;` 会把 0 当成"没传"，
  // 于是粒子上浮/特效/飘字/相机跟随全部按满速继续播放。
  // 传一个极小的正数（PAUSE_RENDER_DT）则反过来：所有按 dt 积分的视觉系统都被冻住，
  // 帧计数照常推进（画面仍然每帧绘制，只是不动）；环境余烬的按概率生成也被压到 0。
  // 时间戳继续用 world.time（暂停时不增长），基于绝对时间的动画同样静止。
  const renderDt = paused ? PAUSE_RENDER_DT : realDt;
  try {
    renderer.render(game.world, renderDt, game.world.time);
  } catch (e) {
    if (!window.__renderErr) {
      console.error('[render] 异常，已切换到降级渲染', e);
      window.__renderErr = true;
      setState('renderer', fallbackRenderer());
    }
  }
  // HUD 继续刷新（血条等数值暂停时本来就不变，但暂停菜单的摘要/按钮要靠 update 驱动）；
  // 传 0 让连击/banner 的淡出计时也随之冻结，画面真正"静止"。
  ui.update(paused ? 0 : realDt);
  watchLevel();
  // 自动存档：每 60 秒一次（与实际进度无关的"墙钟"计时，节流见 autoSave/tickAutoSave）
  try { tickAutoSave(game.world.time || 0); } catch { /* 存档永远不能影响主循环 */ }
  if (typeof clearEvents === 'function') clearEvents(game.world);
  if (input && typeof input.endFrame === 'function') input.endFrame();
  requestAnimationFrame(frame);
}

function getAim() {
  // 【判型】本文件会在无 DOM 的 vm 沙箱里跑（tests/pause.test.mjs）：input/renderer/canvas/game 都可能
  // 缺席或残缺，这里一律降级成"瞄准原点"，而不是每帧抛异常。
  const sx = input && input.mouse ? input.mouse.x : 0;
  const sy = input && input.mouse ? input.mouse.y : 0;
  try {
    if (renderer && renderer.camera && typeof renderer.camera.screenToWorld === 'function') {
      const p = renderer.camera.screenToWorld(sx, sy);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) return { x: p.x, z: p.z };
    }
    if (renderer && typeof renderer.screenToWorld === 'function') return renderer.screenToWorld(sx, sy);
  } catch { /* 忽略 */ }
  const p = game && game.world && game.world.player;
  if (!p || !canvas) return { x: 0, z: 0 };
  const cw = Number(canvas.clientWidth) || 0;
  const ch = Number(canvas.clientHeight) || 0;
  return { x: (p.x || 0) + (sx - cw / 2) / 30, z: (p.z || 0) + (sy - ch / 2) / 30 };
}

// ---------------------------------------------------------------------------
// 快捷键：唯一路由
// ---------------------------------------------------------------------------
/**
 * 快捷键表（**唯一真相**）。按键 → 动作。
 * 老版本里 Tab 在 window 捕获阶段 toggle 一次、input 层又一次（面板开了又立刻关），
 * 另外 ui.js 自己也挂了一个 Escape→closeModals 的监听。现在统一成：
 *   window keydown（捕获）→ 查表 → 记进 pendingHotkeys（每个键每帧只记一次）
 *   → readInput() 里统一消费并执行 → endFrame 时清空。
 * 这样同一帧、同一次按键只会触发一次，且面板打开时快捷键依然有效（input 层可能已被聚焦守卫停用）。
 *
 * 约定：面板开关**都走 openPanelRoute(同一个入口)**，由 ui.openPanel 决定"同面板再按一次就关"。
 */
const HOTKEYS = {
  Escape: { action: 'escape' }, // 先关面板 → 再关暂停 → 都没有则打开暂停
  KeyC: { panel: 'stats' }, // 属性面板
  KeyP: { panel: 'talents' }, // 天赋树
  KeyK: { panel: 'skills' }, // 技能天赋树
  KeyI: { panel: 'inventory' }, // 背包
  Tab: { panel: 'skills', preventDefault: true }, // 技能面板（防焦点跳动）
  KeyM: { action: 'mute' }, // 静音开关（暂停/面板打开时同样有效）
};
// 技能键（Q/W/E/R/T = 1~5 号技能）**故意不写进 HOTKEYS**：
// 它们是「按住施法」型，由 readInput 直接读 input.keys 施放，不进快捷键队列。
// 键名映射见本文件上方的 SKILL_KEYS（与 src/game/input.js 的同名导出由测试守护一致）。
// 同名老快捷键（E 背包 / R 拾取 / T 回城）见下方 legacyHotkey() / LEGACY_BY_CODE。

/** 捕获阶段收集到的快捷键（readInput 消费后清空） */
const _pendingHotkeys = new Set();

/**
 * 某个物理键现在是不是「技能槽键」。
 * 规则：Q / W / E / R / T 中，只要**技能栏那一格有技能**，它就是技能键；
 * 空格则永远是技能键（空格 = 翻滚）。
 * @param {string} code
 * @returns {boolean}
 */
function isSkillSlotKey(code) {
  if (!code) return false;
  if (code === 'Space') return true;
  if (!(code in SKILL_KEY_TO_INDEX)) return false;
  return hasSkillAt(SKILL_KEY_TO_INDEX[code]);
}

/**
 * 某个物理键现在是不是「移动键」。
 * 规则（需求：方向键移动）：
 *  - 方向键永远是移动键；
 *  - W/A/S/D **只有在该键不是技能槽时**才是移动键（例如 2 号格子被清空后，W 自动退回移动）。
 * @param {string} code
 * @returns {boolean}
 */
function isMoveKey(code) {
  if (!code) return false;
  if (code.startsWith('Arrow')) return true;
  if (code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD') return !isSkillSlotKey(code);
  return false;
}

/**
 * 键位表（**文件内常量**：本文件会被测试按行剥掉 import 后丢进 vm 沙箱直跑，
 * 所以键名不能只从 import 里来，否则沙箱里 `SKILL_KEYS is not defined`）。
 * 唯一真相仍是 src/game/input.js 的 SKILL_KEYS —— tests/input-chain.test.mjs 断言两边逐项一致。
 */
const SKILL_KEYS = Object.freeze([
  Object.freeze({ idx: 0, code: 'KeyQ', key: 'q', label: 'Q' }),
  Object.freeze({ idx: 1, code: 'KeyW', key: 'w', label: 'W' }),
  Object.freeze({ idx: 2, code: 'KeyE', key: 'e', label: 'E' }),
  Object.freeze({ idx: 3, code: 'KeyR', key: 'r', label: 'R' }),
  Object.freeze({ idx: 4, code: 'KeyT', key: 't', label: 'T' }),
]);

/** 技能键物理键名 → 技能栏下标（0~4） */
const SKILL_KEY_TO_INDEX = Object.freeze({
  KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3, KeyT: 4,
});

/** 数字键别名：Digit1~Digit5 仍可放对应技能（同样必须是文件内常量，理由同上） */
const DIGIT_ALIAS = Object.freeze/*digit-table*/({ Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 });

/** 把 KeyboardEvent 归一成 HOTKEYS 的键名（e.code 优先，回退 e.key） */
function hotkeyName(e) {
  if (!e) return null;
  const code = e.code;
  if (code && code in HOTKEYS) return code;
  const key = e.key;
  if (!key) return null;
  if (key === 'Escape' || key === 'Esc') return 'Escape';
  if (key === 'Tab') return 'Tab';
  if (key.length === 1) {
    const up = 'Key' + key.toUpperCase();
    if (up in HOTKEYS || Object.prototype.hasOwnProperty.call(LEGACY_BY_CODE, up)) return up;
  }
  return null;
}

/**
 * 某个键在这套键位下，**角色由谁驱动**：
 *   'skill'  → 施放技能（Q/W/E/R/T 且该格有技能；空格=翻滚）
 *   'move'   → 移动（方向键；或 W/A/S/D 且该键不是技能槽）
 *   'legacy' → 老快捷键（E 背包 / R 拾取 / T 回城 / F 拾取，仅当它们不是技能槽）
 *   null     → 其它（C/P/K/I/M/Tab/Esc 等）
 * @param {string} code
 * @returns {'skill'|'move'|'legacy'|null}
 */
function keyRole(code) {
  if (!code) return null;
  if (isSkillSlotKey(code)) return 'skill';
  if (isMoveKey(code)) return 'move';
  if (Object.prototype.hasOwnProperty.call(LEGACY_BY_CODE, code)) return 'legacy';
  return null;
}

/**
 * 捕获层：这个键要不要 preventDefault？
 *  - 角色驱动键（技能/移动）一律拦：避免按住方向键/空格滚动页面、避免 Q/W 触发浏览器快捷行为
 *    （某些浏览器里单独按某些键会进「快速查找」）；
 *  - 老快捷键（Tab / C / P ...）按 HOTKEYS 里的声明拦。
 * @param {any} e
 * @param {string|null} name
 * @returns {boolean}
 */
function shouldPreventKey(e, name) {
  if (!e) return false;
  const code = e.code || (name || '');
  if (keyRole(code)) return true;
  if (name && HOTKEYS[name] && HOTKEYS[name].preventDefault) return true;
  if (name === 'Tab') return true;
  return false;
}

/**
 * 老键盘快捷键（**文件内常量**，理由同上）。
 * 物理键 → 动作；只有当这个键**不是**当前技能槽、也**不是**移动键时才生效：
 *   E（3 号格子被清空时）→ 背包　　R（4 号格子被清空时）→ 拾取
 *   T（5 号格子被清空时）→ 回城　　F → 拾取（不占技能键，永远可用）
 * 默认满技能栏时 E/R/T 全部是技能键，所以不会误触发背包/回城。
 * @type {Readonly<Record<string, any>>}
 */
const LEGACY_BY_CODE = {
  KeyE: { panel: 'inventory' }, // 背包（旧键位）
  KeyR: { action: 'pickup' }, // 拾取（旧键位）
  KeyT: { action: 'newMap' }, // 回城 / 下一张图（旧键位）
  KeyF: { action: 'pickup' }, // 拾取（新键位：F 不占技能键）
};

/**
 * @param {string|null} code
 * @returns {{name:string, spec:any}|null}
 */
function legacyHotkey(code) {
  if (!code) return null;
  if (!Object.prototype.hasOwnProperty.call(LEGACY_BY_CODE, code)) return null;
  if (isSkillSlotKey(code) || isMoveKey(code)) return null;
  return { name: code, spec: LEGACY_BY_CODE[code] };
}

/**
 * 技能栏第 idx 格是否有技能（Q/W/E/R/T 是否是技能键的判据）。
 * 防御式：game / player / skillBar 任何一环缺席都当"没有技能"（这样 W 退回移动键，角色不至于卡死）。
 * @param {number} idx
 * @returns {boolean}
 */
function hasSkillAt(idx) {
  const p = game && game.world && game.world.player;
  const bar = p && Array.isArray(p.skillBar) ? p.skillBar : null;
  if (!bar) return false;
  const inst = bar[idx];
  return !!(inst && inst.id);
}

/**
 * 角色移动方向（方向键 + 非技能槽的 WASD），已归一化。
 * 与 Input.moveDir() 的区别：这里会**按当前键位仲裁**剔除被技能占用的字母键（默认是 W）。
 * @returns {{x:number, z:number}}
 */
function playerMoveDir() {
  // 不用 `instanceof Set`：测试 vm 沙箱和宿主可能各有自己的 Set 构造器（跨 realm 判型失败），
  // 这里只要求最小契约「能 .has(code)」即可。
  const kb = input && input.keys && typeof input.keys.has === 'function' ? input.keys : null;
  let x = 0, z = 0;
  const down = (code) => (kb ? kb.has(code) : false);
  // 上下：方向键优先；W 只在它「不是技能槽」时才算向上（默认 W 是 2 号技能）
  if (down('ArrowUp') || (down('KeyW') && isMoveKey('KeyW'))) z -= 1;
  if (down('ArrowDown') || (down('KeyS') && isMoveKey('KeyS'))) z += 1;
  if (down('ArrowLeft') || down('KeyA')) x -= 1;
  if (down('ArrowRight') || down('KeyD')) x += 1;
  const l = Math.hypot(x, z);
  if (l > 0) { x /= l; z /= l; }
  return { x, z };
}

/** 焦点在输入框里时不劫持按键（以后加聊天/改名输入框也不会被吃掉） */
function isTextInputTarget(t) {
  if (!t || typeof t !== 'object') return false;
  const tag = (t.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return t.isContentEditable === true;
}

/**
 * 执行一个快捷键动作。
 * @param {string} name
 * @param {any} [spec] 覆盖用的 spec（老快捷键 LEGACY_BY_CODE 走这条；不传则查 HOTKEYS）
 */
function runHotkey(name, spec) {
  spec = spec || HOTKEYS[name];
  if (!spec || !ui) return false;
  try {
    if (spec.action === 'escape') return escapeRoute();
    if (spec.action === 'mute') { if (uiHas('toggleSfx')) { ui.toggleSfx(); return true; } return false; }
    // 【面板类快捷键必须在"输入阻塞"判断之前】C/P/K/I/E/Tab 在任何界面态都有效：
    // 面板已经打开时按 K/P/C/E/Tab 要能切换过去、按同一个键要能关掉（ui.openPanel 自己处理
    // "同名面板再按一次 = 关闭"）。曾经放在 isInputBlocked() 之后 → 面板一开，所有面板键失灵，
    // 只能点底部按钮才关得掉（QA 复核确认的真实缺陷）。
    if (spec.panel) return openPanelRoute(spec.panel);
    // 下面几个"世界动作"只在没有面板/暂停时执行（面板里按 R/T 不该把角色传到下一张图）
    if (isInputBlocked()) return false;
    if (spec.action === 'pickup') { doPickup(game); return true; }
    if (spec.action === 'newMap') {
      travelToNewMap(game);
      ui.addLog('你回到了营地，前往更深的第 ' + game.world.tier + ' 层', '#c8a25a');
      if (typeof ui.onMapChange === 'function') ui.onMapChange();
      autoSave(game.world.time || 0); // 换图后自动存档（节流 ≤1 次/10s）
      return true;
    }
  } catch (e) {
    console.warn('[main] 快捷键处理失败', name, e);
  }
  return false;
}

/**
 * 暂停期间按键的**同步**处理路径（不能走 pendingHotkeys 队列）。
 *
 * 【为什么必须有这一条】frame() 在暂停时不会调用 readInput（暂停分支由 pause-dev 实现），
 * 而 readInput 里才会消费 _pendingHotkeys 并清空它——所以暂停期间把 ESC 塞进队列等于石沉大海，
 * 真机表现为"暂停后按 ESC 无法恢复"。这里在捕获层直接执行：
 *   ① ESC → escapeRoute()（先关面板 → 再关暂停 → 最后打开暂停）
 *   ② 其余键交给 ui.handlePauseKey(e)：它以返回值声明是否消费（↑↓ 移焦点 / Enter 触发按钮 /
 *      数字键与空格等游戏键一律吞掉）。返回 true 就 preventDefault 并结束，避免与暂停菜单
 *      自己的 Enter/空格触发打两遍。
 * @param {KeyboardEvent} e
 * @returns {boolean} 是否已在本层处理（true = 调用方不要再入队）
 */
function handlePausedKey(e) {
  const name = hotkeyName(e);
  if (name === 'Escape') {
    e.preventDefault();
    escapeRoute();
    return true;
  }
  if (ui && typeof ui.handlePauseKey === 'function') {
    let consumed = false;
    try {
      consumed = !!ui.handlePauseKey(e);
    } catch (err) {
      console.warn('[main] 暂停按键处理失败', e && e.code, err);
      consumed = false;
    }
    if (consumed) {
      e.preventDefault();
      return true;
    }
  }
  // 暂停菜单不认这个键（例如没有 ui.handlePauseKey）：游戏键一律不要落进 pendingHotkeys，
  // 否则恢复后会被 readInput 重新执行一遍（"按一下 T 却换了图"这类鬼故事）。
  if (name) e.preventDefault();
  return true;
}

/**
 * window keydown 捕获层的**唯一实现**（浏览器里由下面的 addEventListener 调用；
 * 测试可以直接调 main.js 里的这个函数验证分流，不必真的派发 DOM 事件）。
 *
 * 分四条路（键位：方向键移动 / Q W E R T 放 1~5 号技能 / 空格翻滚）：
 *   角色驱动键（技能键 or 移动键）→ 只拦默认行为，不入队（技能由 readInput 读 input.keys 施放）
 *   老快捷键（E 背包 / R 拾取 / T 回城，且该键当前不是技能槽）→ 入队，readInput 统一执行
 *   普通快捷键（ESC/C/P/K/I/M/F/Tab）→ 入队
 *   暂停中 → handlePausedKey（同步执行，见上）
 * @param {KeyboardEvent} e
 * @returns {boolean} 是否已消费（已 preventDefault 或已入队）
 */
function handleKeydown(e) {
  if (!e) return false;
  const code = e.code || '';
  const role = keyRole(code);
  // ① 暂停中：所有键先交给暂停菜单（它在「面板打开」时会自己让位给面板）；ESC 在内部同步处理。
  if (!e.repeat && running && (isWorldPaused() || isPauseMenuOpen())) return handlePausedKey(e);
  // ② ESC：正常游戏时入队（readInput 统一消费 → escapeRoute()），并拦默认行为。
  if (hotkeyName(e) === 'Escape') {
    if (e.repeat) return false;
    if (isTextInputTarget(e.target)) return false;
    if (!running) return false;
    if (e.preventDefault) e.preventDefault();
    _pendingHotkeys.add('Escape');
    return true;
  }
  // ③ 老快捷键（E/R/T 当它们不是技能槽时）——必须排在 "!name → return" 之前
  const legacy = isTextInputTarget(e.target) ? null : legacyHotkey(code);
  if (legacy) {
    if (e.repeat) return false;
    if (!running) return false;
    e.preventDefault();
    _pendingHotkeys.add(legacy.name);
    return true;
  }
  // ③ 角色驱动键：不占快捷键通道，只拦浏览器默认行为
  if (role === 'skill' || role === 'move') {
    if (!running) return false;
    if (e.preventDefault) e.preventDefault();
    return true;
  }
  const name = hotkeyName(e);
  if (!name) {
    // [data-pause-key] 之外的暂停专用键（方向键等）也要让暂停菜单拿到
    if (e.repeat || isTextInputTarget(e.target)) return false;
    if (!running) return false;
    return false;
  }
  if (e.repeat) return false; // 长按不重复触发（面板开关与暂停按钮尤其不能）
  if (isTextInputTarget(e.target)) return false;
  if (!running) {
    // 开始界面：ESC/Tab 不拦，其余游戏热键也不响应
    return false;
  }
  if (shouldPreventKey(e, name)) e.preventDefault();
  _pendingHotkeys.add(name);
  return true;
}

// 捕获阶段：真正执行逻辑的是 handleKeydown（见上），这里只负责挂监听。
// 【判型】main.js 会被测试（tests/pause.test.mjs）剥成裸函数在 vm 沙箱里执行，
// 那里可能没有 window 或 window.addEventListener；缺了就跳过绑定，别让整个入口加载失败。
if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
  window.addEventListener('keydown', (e) => {
    try { handleKeydown(e); } catch (err) { console.warn('[main] keydown 处理失败', err); }
  }, true);
}

function readInput(aim) {
  // ---- 0) 输入焦点守卫：真·暂停时不推进（暂停核心在 pause-dev 手里，这里只是双保险）----
  if (isWorldPaused()) {
    syncInputFocus();
    // 暂停期间的按键已经在捕获层同步处理掉了（见 handlePausedKey），队列里通常没有残留；
    // 这里仍然清一次，防止"暂停那一刻之前入队、还没来得及消费"的旧按键在恢复后被重放。
    _pendingHotkeys.clear();
    if (input && typeof input.endFrame === 'function') input.endFrame(); // frame() 里也会调 endFrame，多清一次幂等
    return {
      move: { x: 0, z: 0 },
      aim,
      attackHeld: false,
      attackPressed: false,
      skills: [],
      dash: false,
      releaseChannels: true,
      pickup: false,
    };
  }
  // ---- 1) 快捷键：每帧统一消费一次（面板开关 / ESC / M / F-拾取 等）----
  for (const name of _pendingHotkeys) {
    // 老快捷键：入队之后格位可能已经变了（例如同一帧先清空技能栏），执行前再确认一次
    if (!(name in HOTKEYS)) {
      const legacy = legacyHotkey(name);
      if (!legacy) continue;
      runHotkey(name, legacy.spec);
      continue;
    }
    runHotkey(name);
  }
  _pendingHotkeys.clear();
  // 快捷键可能刚刚打开了面板/暂停菜单 → 立即让守卫生效（同帧就不再产生移动/攻击）
  syncInputFocus();
  // ---- 2) 面板/暂停菜单打开：角色不动、不攻击、不放技能（只保留背包装备热键的鼠标悬停）----
  if (isInputBlocked()) {
    if (input && typeof input.clearPressed === 'function') input.clearPressed();
    return {
      move: { x: 0, z: 0 },
      aim,
      attackHeld: false,
      attackPressed: false,
      skills: [],
      dash: false,
      releaseChannels: true,
      pickup: false,
    };
  }
  // ---- 3) 正常游戏输入 ----
  // 【兼容】main.js 会被测试剥成裸函数在 vm 沙箱里跑（不可能有真 Input 实例），
  // 所以这里对 input / game / player 判型：缺席时就当"没有任何输入"，而不是每帧抛异常。
  // 最小契约只要求 input.keys 能 .has(code)（跨 realm 的 Set 也能用，见 playerMoveDir）。
  if (!input || !input.keys || typeof input.keys.has !== 'function') {
    return { move: { x: 0, z: 0 }, aim, attackHeld: false, attackPressed: false, skills: [], dash: false, releaseChannels: true, pickup: false };
  }
  // ---- 移动：方向键 / WASD ----
  // 【键位仲裁】W/A/S/D 里，只要该键当前是**技能槽**（见 isSkillSlotKey），就不参与移动：
  // 默认 Y 轴用「↑ / ↓」，W 留给 2 号技能；清空 2 号格子后 W 自动退回移动键，不需要改代码。
  const move = playerMoveDir();
  const attackHeld = !!(input.mouse && input.mouse.down);
  const attackPressed = !!(input.mouse && (input.mouse.clicked || input.mouse.pressed));
  const skills = [];
  const bar = (game && game.world && game.world.player && game.world.player.skillBar) || [];
  let anySkillDown = false;
  // ---- 技能：Q / W / E / R / T = 1~5 号格子（按住即持续，与数字键、右键同一条 tryCast 链路）----
  for (let i = 0; i < SKILL_KEYS.length; i++) {
    const code = SKILL_KEYS[i].code;
    if (input.keys.has(code)) {
      skills.push(bar[i] && bar[i].id);
      anySkillDown = true;
    }
  }
  // 数字键 1~5 老习惯：仍然放对应技能（与 Q~T 完全等价）
  for (const digit of Object.keys(DIGIT_ALIAS)) {
    if (!input.keys.has(digit)) continue;
    const i = DIGIT_ALIAS[digit];
    skills.push(bar[i] && bar[i].id);
    anySkillDown = true;
  }
  // ---- 技能栏按钮（点击）= 与 Q~T 完全同一条链路 ----
  // takeQueuedSkills 会把队列清空，所以"点一下放一次"，不会因为每帧都读而连放。
  // 这里的技能**不算** anySkillDown：否则点一下旋风斩就会一直按住（按钮是单击，不是长按）。
  if (typeof input.takeQueuedSkills === 'function') {
    for (const id of input.takeQueuedSkills()) skills.push(id);
  }
  // 右键也可以释放 2 号技能（旋风斩）：按住右键持续旋转
  const rmb = !!(input.mouse && input.mouse.rightDown);
  if (rmb && bar[1] && bar[1].id === 'whirlwind') { skills.push('whirlwind'); anySkillDown = true; }
  // ---- 空格翻滚：键盘 wasPressed 之外，也接受技能栏「空格」格子的点击 ----
  const queuedDash = typeof input.takeQueuedDash === 'function' ? input.takeQueuedDash() : false;
  const dash = (input.wasPressed ? input.wasPressed('Space') : false) || queuedDash;
  return {
    move,
    aim,
    attackHeld,
    attackPressed,
    skills: skills.filter(Boolean),
    dash,
    // 松开所有技能键与攻击键时结束持续施法（旋风斩）
    releaseChannels: !anySkillDown && !attackHeld && !rmb,
  };
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
// Tab 键已并入上面的 HOTKEYS（捕获阶段只记录，readInput 统一执行），
// 这里不再单独 toggle —— 否则一次按键会开关两次（面板刚打开就被关掉）。
document.getElementById('btn-start')?.addEventListener('click', startGame);
// 职业卡：点击 = 选中（不直接开始）。开始按钮使用当前选择。
try {
  const classCards = document.querySelectorAll ? document.querySelectorAll('#start-screen .class-card') : [];
  for (const card of classCards) {
    if (!card || typeof card.addEventListener !== 'function') continue;
    card.addEventListener('click', () => {
      const cls = (card.getAttribute && card.getAttribute('data-class'))
        || (card.dataset && card.dataset.class) || '';
      selectStartClass(cls);
    });
  }
} catch { /* 桩环境没有 querySelectorAll */ }
// 开始界面键盘选择：←/A/1 = 战士，→/D/2 = 元素法师（游戏开始后这段不生效）。
if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
  window.addEventListener('keydown', (e) => {
    const screen = document.getElementById('start-screen');
    if (!screen || !screen.classList || screen.classList.contains('hidden')) return;
    const code = e && (e.code || e.key);
    if (code === 'ArrowLeft' || code === 'KeyA' || code === 'Digit1') {
      selectStartClass('warrior');
      if (typeof e.preventDefault === 'function') e.preventDefault();
    } else if (code === 'ArrowRight' || code === 'KeyD' || code === 'Digit2') {
      selectStartClass('mage');
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
  });
}
// 下面的绑定都可能在「无 DOM 的 vm 沙箱」里执行（tests/pause.test.mjs 会把本文件剥成裸函数跑），
// 统一判型，缺 DOM 就跳过绑定而不是抛异常。
const hasWindow = typeof window !== 'undefined' && !!window;
// 自动化/排查用：window.__dbg.enableDebugOverlay() 打开调试信息（fps/实体数/坐标）
if (hasWindow) window.__dbg = {
  enableDebugOverlay() {
    if (renderer) renderer.debug = !renderer.debug;
    return !!(renderer && renderer.debug);
  },
  stats() {
    if (!game) return null;
    const p = game.world.player;
    return {
      player: { x: +p.x.toFixed(2), z: +p.z.toFixed(2), hp: Math.round(p.hp), dead: p.dead, walking: !!(p.moveX || p.moveZ) },
      camera: { x: +game.world.player.x.toFixed(2), z: +game.world.player.z.toFixed(2), scale: renderer && renderer.cam ? +renderer.cam.scale.toFixed(2) : 0 },
      monsters: game.world.monsters.length,
      drawnEntities: renderer ? renderer.stats.drawnEntities : 0,
      renderErrors: renderer ? (renderer.errorCount || 0) : -1,
      lastRenderError: renderer ? renderer.lastError || null : null,
      skippedEntities: renderer && renderer.stats ? renderer.stats.skippedEntities || 0 : 0,
      rendererFallback: !!(renderer && !renderer.cam),
      fps,
      map: game.world.map && game.world.map.name, tier: game.world.tier,
      paused: isPauseMenuOpen(),
      modalOpen: ui ? ui.modalOpen : null,
      inputBlocked: isInputBlocked(),
      gameKeys: input ? input.gameKeysEnabled : null,
    };
  },
  // ---- 存档相关（自动化验证用）----
  save: () => saveNow(false),
  load: () => { try { return hasStorage() ? loadFromStorage() : null; } catch { return null; } },
  saveSummary: () => { try { return getSaveSummary(hasStorage() ? loadFromStorage() : null); } catch { return null; } },
  autosaveNow: () => autoSave(game ? (game.world.time || 0) + AUTOSAVE_THROTTLE : 0),
  refreshStartScreen,
  /** 模拟一次按键（测试/排查：不依赖真实键盘焦点、不依赖游戏是否已开始） */
  press(code) {
    if (!HOTKEYS[code] && !legacyHotkey(code)) return false;
    _pendingHotkeys.add(code);
    return true;
  },
  /**
   * 直接走一次「捕获层」处理（与真实 keydown 同一条路径：暂停同步执行 / 面板与游戏态入队）。
   * tests/input-session.test.mjs 用它验证两条回归（面板键不被阻塞、暂停时 ESC 能恢复）。
   * @param {{code?:string,key?:string,repeat?:boolean,target?:any}} e
   */
  key(e) { return handleKeydown(e); },
  /** 立即消费队列（等价于 readInput 里"执行 pendingHotkeys"的那一步） */
  flushHotkeys() {
    const names = Array.from(_pendingHotkeys);
    _pendingHotkeys.clear();
    let n = 0;
    for (const name of names) {
      if (!(name in HOTKEYS)) {
        const legacy = legacyHotkey(name);
        if (legacy && runHotkey(name, legacy.spec)) n++;
        continue;
      }
      if (runHotkey(name)) n++;
    }
    return n;
  },
  /** 只读诊断：当前是否暂停 / 是否被面板挡住 / 队列里堆了哪些键 */
  state() {
    return {
      paused: isWorldPaused(), pauseMenuOpen: isPauseMenuOpen(), inputBlocked: isInputBlocked(),
      modalOpen: ui ? ui.modalOpen : null, pending: Array.from(_pendingHotkeys),
      running: !!running,
    };
  },
  hotkeys: () => Object.keys(HOTKEYS),
  // ---- 键位表（HUD 角标 / 自动化验证 / 排查用）----
  /** 技能栏 0~4 → 技能键（Q/W/E/R/T）；空格 = 翻滚 */
  skillKeys: () => SKILL_KEYS.map((k) => ({ idx: k.idx, code: k.code, label: k.label })),
  /** 某个物理键此刻的角色：'skill' | 'move' | 'legacy' | null */
  keyRole: (code) => keyRole(code),
  /** 当前移动方向（已按键位仲裁） */
  moveDir: () => playerMoveDir(),
};
if (hasWindow && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => { if (renderer && renderer.resize) renderer.resize(); });
}
// 自动化 / 录制用：?autostart=1&class=mage
// 开始界面先读一次存档，让 #btn-start 显示「继续旅程」并在 #profile-info 给出摘要。
// 放在 autostart 判定之前：自动开始（自动化/录制）不应被存档摘要干扰。
try { refreshStartScreen(); } catch (e) { console.warn('[save] 开始界面读档失败', e); }
// 显式 `?class=` 用于自动化/录制，优先级高于「按存档自动选中职业」。
// 必须放在 refreshStartScreen 之后：读档会把 _selectedClass 改成存档职业，否则这里会被覆盖。
try {
  if (typeof location !== 'undefined' && location && location.search) {
    const params = new URLSearchParams(location.search);
    const requested = params.get('class');
    if (requested === 'mage' || requested === 'warrior') {
      _selectedClass = requested;
      syncStartScreenSelection();
    }
  }
} catch { /* ignore */ }
if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('autostart') === '1') startGame();
// 隐式全局在单文件包/严格模式下写不出来（打包器把外部环境当"全局词法环境"）：
// 这里显式把状态挂到 window 上（= globalThis），浏览器与单文件版语义一致；
// vm 沙箱里的不可写 getter 会静默失败并被 try/catch 吞掉（那时对象由沙箱注入）。
try { if (typeof window !== 'undefined' && window) window.__poeMain = { get game() { return game; }, get renderer() { return renderer; }, get ui() { return ui; }, get input() { return input; } }; } catch { /* ignore */ }
if (hasWindow) window.__game = () => ({ game, renderer, ui });