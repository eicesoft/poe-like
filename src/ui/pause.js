// @file src/ui/pause.js
// 暂停菜单（ESC）——纯 DOM 组件，不依赖 canvas，也不碰核心逻辑。
//
// 【职责边界】
//   - 本文件只负责「暂停菜单这张卡片本身」：DOM、按钮、焦点、二次确认、摘要刷新。
//   - 「暂停状态」、「ESC 状态机」、「画面去饱和、覆盖层显示」都由 GameUI 统一持有（ui.js），
//     因为 ESC 必须在一处排队处理（有面板 → 关面板；没面板且没暂停 → 开暂停菜单；已暂停 → 继续），
//     而面板热键（P/K/C/E）在暂停时也必须继续工作，它们只能落在 GameUI 上。
//   - 主循环（main.js）只读 game.paused 决定推不推进世界；这里不 import 任何游戏模块。
//
// 【契约】
//   new PauseMenu(gameUI)     —— 传入 GameUI 实例（需要 .game / .addLog / .toggleSfx / .openPanel）
//   pauseMenu.isOpen           —— 打开状态
//   pauseMenu.open()/.close()/.toggle()/.render()/.handleKey(e)
//   根节点 id=#pause-menu，class=pause-overlay（.show 表示可见）
//   每个按钮：data-act / aria-label / title；支持鼠标点击、方向键/Tab 聚焦、Enter/空格触发。
//
// 【防御式 DOM（重要）】
//   standalone 单文件版的 VM 桩里：querySelector 永远返回新节点、querySelectorAll 返回空数组、
//   classList 是空实现、appendChild 不挂真实父节点。所以：
//     - 所有取节点的操作都判空；拿不到 `#app / #hud / body` 时退化成「无 DOM 模式」，
//       只有状态（isOpen）变化，不抛异常；
//     - 键盘事件要么绑在根节点（我们在真实 DOM 里 push 进自己的数组），要么由 GameUI 用
//       移动端友好的 document 收集器喂进来；两者在桩环境都不会崩；
//     - 不依赖任何外部图片：图标全部是**内联 SVG**（字符串常量 ICONS），不引入任何资源文件。
//
// 【类名 → 用途】（全部沿用既有名字，本文件**没有**新增类名；样式由 style.css 的
//   `PAUSE (src/ui/pause.js)` 段落维护，改这里之前先确认那边有没有对应选择器）
//   #pause-menu            根节点，同时带 .pause-overlay（fixed / inset:0 / z-index 65）
//   .pause-overlay.hidden  收起态（默认）；.pause-overlay.show 显示态（opacity/visibility 过渡）
//   .pause-card            卡片本体（金线/背景/进场 transform）
//   .pause-corner.tl/.tr/.bl/.br   四角细金线装饰
//   .pause-head            标题 + 摘要容器
//   .pause-title           标题行；.pause-mark 标题前的 ❖；.pause-sub 「PAUSED」小字
//   .pause-summary         玩家摘要行；子项 .ps-name/.ps-lv/.ps-map/.ps-kill/.ps-sep
//   .pause-rule            金色细分隔线（上下各一条）
//   .pause-grid            按钮两列网格
//   .pause-btn             按钮；修饰 .primary（继续游戏）/ .danger（返回主菜单）
//                          状态 .focus（键盘焦点）/ .confirm（确认退出中）/ .off（音效已静音）
//                          / .disabled 与 [disabled]（存档不可用）
//   .pb-ico                按钮图标槽（内联 <svg>；音效静音时切到 ICONS.sfxOff）
//   .pb-text               按钮文案（会动态改：保存游戏/存档不可用、音效开启/关闭、返回主菜单/确认退出？）
//   .pb-kbd                快捷键提示（<kbd>，仅 resume/stats/talents/skills/equipment/sfx 有）
//   .pause-foot            底部提示条；.pause-hint 键位说明；.pause-sys 时间/存档状态
//
// 音效静音状态（纯函数读取，不碰 WebAudio，桩环境也安全）
import { isMuted } from './sfx.js';

// ---------------------------------------------------------------------------
// 内联 SVG 图标（24×24 viewBox / currentColor / stroke 1.6 / fill none / round）
// 与 src/ui/panel-bar.js 的 PANEL_ITEMS 风格一致；本体尺寸由 CSS 控制（.pause-btn .pb-ico svg）。
// aria-hidden + focusable="false"：图标纯装饰，可读文本在 .pb-text / aria-label 上。
// ---------------------------------------------------------------------------
const SVG_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" '
  + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const svg = (body) => SVG_OPEN + body + '</svg>';

const ICONS = {
  // 继续：实心播放三角（唯一的"主操作"，实心更醒目）
  resume: svg('<path d="M8.2 4.9v14.2c0 .9 1 1.4 1.7 .9l10.1-7.1c.6-.4.6-1.3 0-1.7L9.9 4c-.7-.5-1.7 0-1.7.9z" fill="currentColor" stroke="none"/>'),
  // 属性：人物剪影（头 + 肩）
  stats: svg('<circle cx="12" cy="7.6" r="3.4"/><path d="M4.8 20.4c0-3.6 3.2-5.6 7.2-5.6s7.2 2 7.2 5.6"/>'),
  // 天赋：中心节点 + 星芒放射 + 六个外圈节点（与底部按钮列同款）
  talents: svg(
    '<path d="M12 2.9v2.4M12 18.7v2.4M4.8 6.4l1.8 1.8M17.4 15.8l1.8 1.8M2.9 12h2.4M18.7 12h2.4M4.8 17.6l1.8-1.8M17.4 8.2l1.8-1.8"/>'
    + '<circle cx="12" cy="12" r="3.1"/>'
    + '<circle cx="12" cy="2.7" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="12" cy="21.3" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="2.7" cy="12" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="21.3" cy="12" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="5.2" cy="5.2" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="18.8" cy="18.8" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="18.8" cy="5.2" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="5.2" cy="18.8" r="1" fill="currentColor" stroke="none"/>',
  ),
  // 技能：六边形符文石 + 内嵌竖钩 + 三点（与底部按钮列同款）
  skills: svg(
    '<path d="M12 2.4 19.9 7v10L12 21.6 4.1 17V7z"/>'
    + '<path d="M12 6.6v8.2"/><path d="M12 14.8 9.7 12.5"/>'
    + '<circle cx="9.1" cy="9.1" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="14.9" cy="9.1" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="12" cy="18.2" r="1" fill="currentColor" stroke="none"/>',
  ),
  // 装备：甲胄/胸甲（护肩 + 胸线 + 下摆）
  equipment: svg(
    '<path d="M12 3.2 6.6 5.1v6.2c0 4 2.3 6.9 5.4 8.8 3.1-1.9 5.4-4.8 5.4-8.8V5.1z"/>'
    + '<path d="M9.6 10.9h4.8"/><path d="M12 6.6v2.6"/><path d="M9.7 16.6 12 14.5l2.3 2.1"/>',
  ),
  // 音效开：喇叭 + 两道声波
  sfx: svg(
    '<path d="M4.2 9.4h3.1L12 5.6v12.8l-4.7-3.8H4.2z"/>'
    + '<path d="M15.4 9.2a4 4 0 0 1 0 5.6"/>'
    + '<path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  ),
  // 音效关：喇叭 + 叉（来自 ICONS.sfxOff，静音时由 render() 切换）
  sfxOff: svg(
    '<path d="M4.2 9.4h3.1L12 5.6v12.8l-4.7-3.8H4.2z"/>'
    + '<path d="M15.6 9.6l4.6 4.8"/><path d="M20.2 9.6l-4.6 4.8"/>',
  ),
  // 保存：软盘（外框 + 上部写保护缺口 + 底部标签）
  save: svg(
    '<path d="M4.6 4.6h11.2l3.6 3.6v11.2H4.6z"/>'
    + '<path d="M8.2 4.6v4.6h6V4.6"/>'
    + '<path d="M8.2 19.4v-5.2h7.6v5.2"/>',
  ),
  // 返回：门框 + 向外箭头
  quit: svg(
    '<path d="M13.6 4.4H5.2v15.2h8.4"/>'
    + '<path d="M16.4 8.4 20 12l-3.6 3.6"/>'
    + '<path d="M20 12H9.8"/>',
  ),
};

/** 按钮定义。`key` 是快捷键提示文本，`act` 同时写进 data-act，`icon` 是 ICONS 的键。 */
const ACTIONS = [
  { act: 'resume', icon: 'resume', label: '继续游戏', key: 'ESC', title: '关闭暂停菜单并继续冒险（ESC）' },
  { act: 'stats', icon: 'stats', label: '属性', key: 'C', title: '查看角色详细属性（C）' },
  { act: 'talents', icon: 'talents', label: '天赋', key: 'P', title: '打开天赋树（P）' },
  { act: 'skills', icon: 'skills', label: '技能', key: 'K', title: '打开技能与天赋分叉（K / Tab）' },
  { act: 'equipment', icon: 'equipment', label: '装备', key: 'E', title: '打开背包 / 装备（E / I）' },
  { act: 'sfx', icon: 'sfx', label: '音效', key: 'M', title: '切换音效开关（M）' },
  { act: 'save', icon: 'save', label: '保存游戏', key: '', title: '保存当前进度' },
  { act: 'quit', icon: 'quit', label: '返回主菜单', key: '', title: '返回主菜单（需要再点一次确认）' },
];

/** 二次确认后恢复文案的时间（毫秒） */
const CONFIRM_MS = 2500;

/** 判断「方向键之外的、属于焦点导航的按键」 */
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'NumpadEnter', ' ', 'Spacebar']);

/**
 * 取按键名（兼容 code / key / 桩环境里的事件对象）
 * @param {any} e
 * @returns {string}
 */
function keyOf(e) {
  if (!e) return '';
  return String(e.key || e.code || '');
}

/** 元素是否是可点击的按钮（有 disabled 属性就跳过） */
function isClickable(node) {
  if (!node) return false;
  if (node.disabled === true) return false;
  if (node.getAttribute && node.getAttribute('disabled') != null) return false;
  return true;
}

/** 安全地取属性（桩环境里 getAttribute 需要 _attrs 存在） */
function attr(node, name) {
  try {
    return node && typeof node.getAttribute === 'function' ? node.getAttribute(name) : null;
  } catch { return null; }
}

export class PauseMenu {
  /**
   * @param {object} ui GameUI 实例
   */
  constructor(ui) {
    this.ui = ui;
    this.root = null;       // #pause-menu 根节点
    this.card = null;       // .pause-card
    this.summaryEl = null;  // 左上摘要
    this.sysEl = null;      // 右上小字（时间/存档状态）
    this.focusables = [];   // 可聚焦按钮（真实 DOM 顺序）
    this.buttons = {};      // act → 按钮节点
    this._focusIdx = 0;
    this._confirmTimer = null;
    this._confirmArmed = false;
    this._lastSig = null;
    this._built = false;
    // 初始状态挂在 ui.paused 上：由 GameUI 保证两者一致
    this.open0 = false;
  }

  get game() {
    return (this.ui && this.ui.game) || null;
  }

  get isOpen() {
    return !!(this.ui && this.ui.paused);
  }

  // -------------------------------------------------------------------------
  // DOM 构（惰性，只建一次）
  // -------------------------------------------------------------------------
  /**
   * 找到（必要时创建）根节点。宿主优先 #app（N UI 系统的根），退而求其次 #hud / body。
   * 拿不到任何宿主时返回 null（standalone 桩里 #app 是注册过的，正常会成功）。
   * @returns {Element|null}
   */
  _ensureDOM() {
    if (this.root) return this.root;
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || typeof doc.createElement !== 'function') return null;

    // ① 接管已存在的 #pause-menu（重开游戏 / 第二个 GameUI 实例 / HMR 残留）：
    //    绝不新建第二份。节点是我们自己的模板时直接复用；如果上一任实例绑过事件，
    //    先把它解绑（避免两个 PauseMenu 同时响应点击），再由本实例重新绑定。
    let node = null;
    try {
      node = doc.getElementById ? doc.getElementById('pause-menu') : null;
    } catch { node = null; }
    if (!node && doc.querySelectorAll) {
      try {
        const found = Array.from(doc.querySelectorAll('#pause-menu'));
        node = found.find((n) => n && n.classList && n.classList.contains('pause-overlay')) || found[0] || null;
      } catch { node = null; }
    }

    if (node) {
      // 清掉旧实例的委托监听（只要不是本实例绑的）
      try {
        if (typeof node._pauseUnbind === 'function' && node._pauseOwner !== this) node._pauseUnbind();
      } catch { /* 桩 */ }
      try { node._pauseOwner = this; } catch { /* 桩 */ }
      // 【单例语义】#pause-menu 是全页唯一的 id：接管之后把它挪到本实例的宿主（#app）下，
      // 保证「重开游戏 / 第二个 GameUI」之后卡片仍然挂在预期位置，且页面上只有一张。
      // 这里只移动我们自己接管到的这一个节点，绝不删除其它节点。
      try {
        const host = this._host(doc);
        if (host && typeof host.appendChild === 'function' && node.parentNode !== host) {
          host.appendChild(node); // appendChild 到新宿主 = 自动从旧宿主摘除
        }
      } catch { /* 桩环境可能拒绝 */ }
      // 接管时同步一次可见性：默认收起，交给 open()/close() 决定
      try { if (!node.classList.contains('show')) { node.classList.add('hidden'); node.classList.remove('show'); } } catch { /* 桩 */ }
      this._bindLocalEvents(node);
    } else {
      node = doc.createElement('div');
      node.id = 'pause-menu';
      try { node.className = 'pause-overlay hidden'; } catch { /* 桩 */ }
      try { node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); } catch { /* 桩 */ }
      try { node.setAttribute('aria-label', '暂停菜单'); } catch { /* 桩 */ }
      node.innerHTML = this._bodyHTML();
      this._bindLocalEvents(node);

      let host = null;
      try {
        host = this._host(doc);
      } catch { host = null; }
      if (host && typeof host.appendChild === 'function') {
        try { host.appendChild(node); } catch { /* 桩环境可能拒绝 */ }
      }
      try { node._pauseOwner = this; } catch { /* 桩 */ }
      // 只清理「同一个宿主」下的重复节点：弱 DOM 桩里 appendChild 可能根本没挂上，
      // 于是同一宿主里会残留一个孤儿 #pause-menu（页面上出现两张卡）。
      // 【绝不能全局删】真实浏览器里若真的存在两个 GameUI（各自持有一张卡、可能挂在不同宿主下），
      // 全局扫一遍会把对方正在用的节点摘掉。所以只动 parentNode === 本宿主、且不属于本实例的节点。
      try {
        if (host && host.querySelectorAll) {
          const dupes = Array.from(host.querySelectorAll('#pause-menu'));
          for (const n of dupes) {
            if (!n || n === node) continue;
            if (n.parentNode !== host) continue;          // 不是挂在本宿主上的，不动
            if (n._pauseOwner === this) continue;          // 不属于别人的（理论上不会出现）
            if (typeof n._pauseUnbind === 'function') n._pauseUnbind();
            n.remove();
          }
        }
      } catch { /* ignore */ }
    }
    // 无论节点是怎么来的，都把引用缓存起来；桩环境的查询可能每次返回不同对象，
    // 所以内部子节点引用一律「建完立刻从我们自己的节点上取」，取不到就降级。
    this.root = node;
    this._built = true;
    this._cacheParts();
    return node;
  }

  /**
   * 首选宿主：优先 #app（持续存在、不会被 .hidden 吞掉），其次 #hud，最后 body。
   * @param {Document} doc
   * @returns {Element|null}
   */
  _host(doc) {
    try {
      return (doc.getElementById && (doc.getElementById('app') || doc.getElementById('hud'))) || doc.body || null;
    } catch { return null; }
  }

  /** 卡片内部结构（字符串，一次性 innerHTML） */
  _bodyHTML() {
    // 按钮由 ACTIONS 单点生成：类名/结构只在这里出现一次，图标是内联 SVG。
    const btn = (a) => `<button type="button" class="pause-btn${a.act === 'resume' ? ' primary' : ''}${a.act === 'quit' ? ' danger' : ''}" data-act="${a.act}" aria-label="${a.label}" title="${a.title}">`
      + `<span class="pb-ico">${ICONS[a.icon] || ''}</span>`
      + `<span class="pb-text">${a.label}</span>`
      + `${a.key ? `<kbd class="pb-kbd">${a.key}</kbd>` : ''}</button>`;
    return ''
      + '<div class="pause-card" role="document">'
      +   '<i class="pause-corner tl"></i><i class="pause-corner tr"></i>'
      +   '<i class="pause-corner bl"></i><i class="pause-corner br"></i>'
      +   '<div class="pause-head">'
      +     '<div class="pause-title"><span class="pause-mark">❖</span>暂停<span class="pause-sub">PAUSED</span></div>'
      +     '<div class="pause-summary" aria-live="polite"></div>'
      +   '</div>'
      +   '<div class="pause-rule"></div>'
      +   '<div class="pause-grid">'
      +     ACTIONS.map(btn).join('')
      +   '</div>'
      +   '<div class="pause-rule"></div>'
      +   '<div class="pause-foot">'
      +     '<span class="pause-hint">↑ ↓ 选择 · Enter 确认 · ESC 继续</span>'
      +     '<span class="pause-sys"></span>'
      +   '</div>'
      + '</div>';
  }

  /** 从根节点上取子节点引用（取不到就保持 null，后续所有使用都要判空） */
  _cacheParts() {
    const root = this.root;
    if (!root) return;
    const q = (sel) => {
      try { return root.querySelector ? root.querySelector(sel) : null; } catch { return null; }
    };
    this.card = q('.pause-card');
    this.summaryEl = q('.pause-summary');
    this.sysEl = q('.pause-sys');
    // 按钮：优先用真实的 querySelectorAll（浏览器），其次按 data-act 逐个查
    let list = [];
    try {
      list = root.querySelectorAll ? Array.from(root.querySelectorAll('.pause-btn')) : [];
    } catch { list = []; }
    const buttons = {};
    for (const a of ACTIONS) {
      let b = list.find((n) => attr(n, 'data-act') === a.act) || null;
      if (!b) b = q(`.pause-btn[data-act="${a.act}"]`);
      if (b) buttons[a.act] = b;
    }
    // 节点上的真实子节点顺序（桩环境 appendChild 会把子节点放进 children，真实 DOM 用 children 也行）
    if (!list.length && root.children && root.children.length) {
      const walk = (n) => {
        for (const c of n.children || []) {
          const a = attr(c, 'data-act');
          if (a && !buttons[a]) buttons[a] = c;
          if (c.children && c.children.length) walk(c);
        }
      };
      try { walk(root); } catch { /* ignore */ }
    }
    this.buttons = buttons;
    this.focusables = ACTIONS.map((a) => buttons[a.act]).filter((n) => !!n && isClickable(n));
  }

  /**
   * 事件绑定：全部用委托，绑在根节点上。
   * 根节点是我们自己创建的真实元素，浏览器里点击能冒泡到这里。
   *
   * 【可重入 / 可接管】同一个节点被第二个 PauseMenu 实例接管时：
   *   - 先调用上一任留下的 _pauseUnbind()，把旧监听摘干净（否则一次点击会触发两遍）；
   *   - 把本实例的移除函数挂在 node._pauseUnbind 上，并记 node._pauseOwner = this。
   * 这样「重开游戏 / 第二个 GameUI 实例」不会出现两张暂停卡，也不会双触发。
   */
  _bindLocalEvents(node) {
    if (!node || typeof node.addEventListener !== 'function' || typeof node.querySelectorAll !== 'function') return;
    const offs = [];
    const on = (target, type, fn) => {
      try {
        target.addEventListener(type, fn);
        offs.push(() => { try { target.removeEventListener(type, fn); } catch { /* 桩 */ } });
      } catch { /* 桩 */ }
    };
    const onClick = (e) => this._onClick(e);
    const onKey = (e) => this.handleKey(e);
    try {
      node._pauseOwner = this;
      node._pauseBound = true;
      node._pauseUnbind = () => { for (const off of offs.splice(0)) off(); };
      on(node, 'click', onClick);
      // 焦点在卡片里时，方向键 / Tab / Enter 一律由我们接管（不让它跑出暂停菜单）
      on(node, 'keydown', onKey);
      return;
    } catch { /* 桩 */ }
    // 极简 DOM 桩里 addEventListener 可能什么都没做：退化成给每个按钮单独绑（真实 DOM 里绝不会走到这）
    let list = [];
    try { list = Array.from(node.querySelectorAll('.pause-btn')); } catch { list = []; }
    for (const b of list) {
      try {
        if (!b || typeof b.addEventListener !== 'function') continue;
        on(b, 'click', (e) => this._onClick({ ...e, target: e && e.target ? e.target : b }));
        on(b, 'keydown', onKey);
      } catch { /* 桩 */ }
    }
  }

  /** 从事件里找出带 data-act 的按钮（最多向上找 4 层） */
  _actFromEvent(e) {
    let t = e && e.target;
    for (let i = 0; i < 4 && t; i++) {
      const act = attr(t, 'data-act');
      if (act) return act;
      t = t.parentNode;
    }
    return null;
  }

  _onClick(e) {
    const act = this._actFromEvent(e);
    if (!act) return;
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    this.activate(act);
  }

  // -------------------------------------------------------------------------
  // 开合
  // -------------------------------------------------------------------------
  /** 打开（幂等）。真正的「暂停」由 ui.togglePause 负责，这里只显示菜单并做准备。 */
  open() {
    this.resetConfirm();
    const root = this._ensureDOM();
    this.render();
    if (root) {
      try { root.classList.remove('hidden'); } catch { /* 桩 */ }
      try { root.classList.add('show'); } catch { /* 桩 */ }
      try { root.setAttribute('aria-hidden', 'false'); } catch { /* 桩 */ }
      // 打开时先把焦点放到「继续游戏」上：键盘用户直接 Enter 就能继续
      this._focusIdx = 0;
      this.focusFirst();
    }
    return this;
  }

  /** 关闭（幂等）：只隐藏 DOM、清确认态；暂停状态由 GameUI 维护 */
  close() {
    this.resetConfirm();
    this._lastSig = null;
    const root = this.root || (typeof document !== 'undefined' && document.getElementById ? document.getElementById('pause-menu') : null);
    if (!root) return this;
    try { root.classList.remove('show'); } catch { /* 桩 */ }
    try { root.classList.add('hidden'); } catch { /* 桩 */ }
    try { root.setAttribute('aria-hidden', 'true'); } catch { /* 桩 */ }
    try {
      if (root.contains && typeof document !== 'undefined' && document.activeElement
        && root.contains(document.activeElement) && document.activeElement.blur) {
        document.activeElement.blur();
      }
    } catch { /* 桩环境没有 activeElement */ }
    return this;
  }

  /** 开关：真正的状态机在 ui.togglePause，这里只做兜底（两者语义一致） */
  toggle() {
    if (this.isOpen) {
      if (this.ui && typeof this.ui.togglePause === 'function') return this.ui.togglePause(false);
      this.close();
      return this;
    }
    if (this.ui && typeof this.ui.togglePause === 'function') return this.ui.togglePause(true);
    this.open();
    return this;
  }

  // -------------------------------------------------------------------------
  // 渲染（打开时刷新摘要 / 按钮可用性；用签名短路，避免每帧写 DOM）
  // -------------------------------------------------------------------------
  /**
   * @param {boolean} [force] 忽略签名缓存，强制重写
   */
  render(force) {
    if (!this._built && !this.root) {
      // 还没建过 DOM：只有确实要显示时才建（render 也可能在打开流程里被调用）
      this._ensureDOM();
    }
    const game = this.game;
    const d = this._snapshot();
    const sig = JSON.stringify(d);
    if (!force && sig === this._lastSig) return this;
    this._lastSig = sig;

    // ---- 摘要 ----
    if (this.summaryEl) {
      this.summaryEl.innerHTML = ''
        + `<span class="ps-name">${esc(d.name)}</span>`
        + `<span class="ps-lv">Lv.${d.level}</span>`
        + `<span class="ps-sep">·</span><span class="ps-map">${esc(d.map)}</span>`
        + `<span class="ps-sep">·</span><span class="ps-kill">击杀 ${d.kills}</span>`;
    }
    if (this.sysEl) {
      this.sysEl.textContent = `${d.time} · ${d.saveText}`;
    }

    // ---- 按钮状态 ----
    const saveBtn = this.buttons.save;
    if (saveBtn) {
      const ok = !!d.canSave;
      this._setDisabled(saveBtn, !ok);
      const text = saveBtn.querySelector ? saveBtn.querySelector('.pb-text') : null;
      if (text) text.textContent = ok ? '保存游戏' : '存档不可用';
      else if (saveBtn.querySelectorAll) { /* 桩：不动 */ }
      if (ok) this._setTitle(saveBtn, '保存当前进度');
      else this._setTitle(saveBtn, '存档不可用（当前环境没有 game.actions.save）');
    }
    const sfxBtn = this.buttons.sfx;
    if (sfxBtn) {
      const muted = !!d.muted;
      const text = sfxBtn.querySelector ? sfxBtn.querySelector('.pb-text') : null;
      if (text) text.textContent = muted ? '音效关闭' : '音效开启';
      const ico = sfxBtn.querySelector ? sfxBtn.querySelector('.pb-ico') : null;
      // 内联 SVG 两个状态都准备好（静态模板 + 静音版），这里只切内容，不重建按钮。
      if (ico) ico.innerHTML = muted ? ICONS.sfxOff : ICONS.sfx;
      try { sfxBtn.classList.toggle('off', muted); } catch { /* 桩 */ }
      this._setTitle(sfxBtn, muted ? '音效已关闭（M 键切换）' : '音效开启（M 键切换）');
    }
    const quitBtn = this.buttons.quit;
    if (quitBtn && !this._confirmArmed) {
      const text = quitBtn.querySelector ? quitBtn.querySelector('.pb-text') : null;
      if (text) text.textContent = '返回主菜单';
      this._setTitle(quitBtn, '返回主菜单（需要再点一次确认）');
    }
    // 其余静态按钮：只在缺失时补 aria-label/title（文案之上覆盖了 title 的会被保留）
    for (const act of ['resume', 'stats', 'talents', 'skills', 'equipment']) {
      const a = ACTIONS.find((x) => x.act === act);
      const b = this.buttons[act];
      if (!a || !b) continue;
      if (attr(b, 'aria-label') == null) this._setLabel(b, a.label);
      if (attr(b, 'title') == null) this._setTitle(b, a.title);
    }
    // 可聚焦列表可能因为 disabled 变化而变，重新算一遍
    this.focusables = ACTIONS.map((a) => this.buttons[a.act]).filter((n) => !!n && isClickable(n));
    if (game) { /* game 仅用于 snapshot，占位避免未使用告警 */ }
    return this;
  }

  /** 实时状态快照（也是渲染的签名来源） */
  _snapshot() {
    const game = this.game || {};
    const world = game.world || {};
    const p = world.player || {};
    const inv = game.inv || {};
    const canSave = !!(game.actions && typeof game.actions.save === 'function');
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    // 金币字段在不同版本里叫法不一样，都认
    const goldCandidates = [inv.gold, inv.coins, world.stats && world.stats.gold];
    const gold = Number(goldCandidates.find((v) => Number.isFinite(v)) ?? 0) || 0;
    // 音效开关状态：真实来源是 src/ui/sfx.js 的 isMuted()（GameUI.toggleSfx/M 键都改它）。
    // 依次回退：GameUI.isSfxMuted() 钩子 → 静态导入的 isMuted() → ui._muted（旧版本字段）。
    // 【踩过的坑】早期只读 ui._muted，而 GameUI 上根本没有这个字段 → 静音后按钮永远不变。
    let muted = false;
    try {
      const m = this.ui && this.ui.isSfxMuted;
      if (typeof m === 'function') muted = !!m.call(this.ui);
      else if (typeof isMuted === 'function') muted = !!isMuted();
      else muted = !!(this.ui && this.ui._muted);
    } catch { muted = false; }
    return {
      name: p.name || p.charName || '无名战士',
      level: p.level | 0 || 1,
      map: (world.map && world.map.name) || '未知区域',
      tier: world.tier | 0,
      kills: (world.stats && world.stats.kills) | 0,
      gold,
      muted,
      canSave,
      saveText: canSave ? `时间 ${hh}:${mm}` : '存档不可用',
      time: `${hh}:${mm}`,
    };
  }

  _setDisabled(btn, off) {
    try {
      if (off) btn.setAttribute('disabled', '');
      else btn.removeAttribute('disabled');
    } catch { /* 桩 */ }
    try { btn.disabled = !!off; } catch { /* 只读属性，忽略 */ }
    try { btn.classList.toggle('disabled', !!off); } catch { /* 桩 */ }
  }

  _setTitle(btn, text) {
    if (!btn) return;
    try { btn.title = text; btn.setAttribute('title', text); } catch { /* 桩 */ }
    this._setLabel(btn, text);
  }

  /** 只写 aria-label（不动 title） */
  _setLabel(btn, text) {
    if (!btn) return;
    try { if (btn.setAttribute) btn.setAttribute('aria-label', text); } catch { /* 桩 */ }
  }

  // -------------------------------------------------------------------------
  // 按钮动作
  // -------------------------------------------------------------------------
  /**
   * 执行某个按钮的动作。返回 true 表示动作被接受。
   * 所有动作都可以在测试里直接调用（不需要真实点击）。
   * @param {string} act
   * @returns {boolean}
   */
  activate(act) {
    const ui = this.ui || {};
    const game = this.game || {};
    switch (act) {
      case 'resume':
        this.resetConfirm();
        if (typeof ui.togglePause === 'function') ui.togglePause(false);
        else this.close();
        return true;
      case 'stats':
      case 'talents':
      case 'skills':
      case 'equipment':
        this._openPanel(act);
        return true;
      case 'sfx':
        try {
          if (typeof ui.toggleSfx === 'function') ui.toggleSfx();
        } catch { /* 音效失败不影响菜单 */ }
        this.render(true);
        return true;
      case 'save': {
        const save = game.actions && game.actions.save;
        if (typeof save !== 'function') {
          // 不可用：保持禁用态提示
          this.render(true);
          return false;
        }
        let ok = false;
        try { ok = save() !== false; } catch { ok = false; }
        if (typeof ui.addLog === 'function') {
          ui.addLog(ok ? '❖ 游戏已保存' : '保存失败（当前环境不支持）', ok ? '#9fe7a0' : '#ff6a5a');
        }
        this.render(true);
        return ok;
      }
      case 'quit':
        return this._quit();
      default:
        return false;
    }
  }

  /**
   * 打开面板：仍然保持暂停。优先 ui.openPanel(kind)（panelbar-dev 实现），
   * 缺席时退回 ui.toggleXxx()，再缺席时什么也不做（不抛异常）。
   * @param {string} act 'stats' | 'talents' | 'skills' | 'equipment'
   */
  _openPanel(act) {
    const ui = this.ui || {};
    const kind = act === 'equipment' ? 'equipment' : act;
    // 已经开着同一个面板 → 关掉（POE 习惯：再点一次收起），其余情况一律打开
    const map = { stats: 'stats', talents: 'talents', skills: 'skills', equipment: 'inventory' };
    const target = map[act] || act;
    const sameOpen = ui.modalOpen && (ui.modalOpen === target || (act === 'equipment' && ui.modalOpen === 'inventory'));
    try {
      if (typeof ui.openPanel === 'function') {
        ui.openPanel(kind);
      } else if (typeof ui.openPanelSafe === 'function') {
        ui.openPanelSafe(kind);
      } else {
        // panelbar-dev 的 openPanel 还没落地：用既有 toggle 兜底
        if (sameOpen && typeof ui.closeModals === 'function') ui.closeModals();
        else if (act === 'talents' && typeof ui.toggleTalents === 'function') ui.toggleTalents();
        else if (act === 'skills' && typeof ui.toggleSkills === 'function') ui.toggleSkills();
        else if (typeof ui.toggleInventory === 'function') ui.toggleInventory();
        // 属性面板（stats-ui.js）没就绪时没有可调用的入口，静默降级
      }
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[pause] 打开面板失败', err);
    }
    // 暂停保持：面板关掉之后如果暂停菜单还开着，仍然暂停（由 ui.togglePause 的状态决定）
    this._syncPanelFocus();
  }

  /** 面板压在暂停覆盖层之上时，暂停菜单失去焦点：把焦点交给面板（真实 DOM 下） */
  _syncPanelFocus() {
    const ui = this.ui || {};
    if (!ui.modalOpen) return;
    try {
      const closeBtn = typeof document !== 'undefined' && document.getElementById ? document.getElementById('modal-close') : null;
      if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
    } catch { /* 桩 */ }
  }

  /**
   * 退出到主菜单：第一次把按钮变成「确认退出？」并开始 2.5s 倒计时，
   * 第二次（2.5s 内）才真正执行。执行内容依次尝试：
   *   game.actions.quitToMenu() → game.actions.restart() → location.reload()
   * 都拿不到时只记日志（不假装成功）。
   * @returns {boolean} true 表示已确认执行，false 表示只是进入确认态
   */
  _quit() {
    if (!this._confirmArmed) {
      this.armConfirm();
      return false;
    }
    this.resetConfirm();
    const game = this.game || {};
    const ui = this.ui || {};
    const acts = game.actions || {};
    const fn = typeof acts.quitToMenu === 'function' ? acts.quitToMenu
      : typeof acts.restart === 'function' ? acts.restart : null;
    let done = false;
    if (fn) {
      try { done = fn() !== false; } catch { done = false; }
    }
    if (!done) {
      // 兜底：刷新页面回到开始界面（真实浏览器里就是"返回主菜单"的等价行为）
      try {
        if (typeof location !== 'undefined' && location && typeof location.reload === 'function') {
          location.reload();
          done = true;
        }
      } catch { done = false; }
    }
    if (typeof ui.addLog === 'function') {
      ui.addLog(done ? '离开远征…' : '无法返回主菜单（缺少 quitToMenu / reload）', done ? '#c8a25a' : '#ff6a5a');
    }
    return done;
  }

  /** 进入「确认退出？」态（2.5 秒后自动复原） */
  armConfirm() {
    this._confirmArmed = true;
    const btn = this.buttons.quit;
    if (btn) {
      const text = btn.querySelector ? btn.querySelector('.pb-text') : null;
      if (text) text.textContent = '确认退出？';
      this._setTitle(btn, '再点击一次确认返回主菜单（2.5 秒内有效）');
      try { btn.classList.add('confirm'); } catch { /* 桩 */ }
    }
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    this._confirmTimer = setTimeout(() => { this._confirmTimer = null; this.resetConfirm(); }, CONFIRM_MS);
    return this;
  }

  /** 复原确认态 */
  resetConfirm() {
    this._confirmArmed = false;
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    }
    const btn = this.buttons.quit;
    if (btn) {
      const text = btn.querySelector ? btn.querySelector('.pb-text') : null;
      if (text) text.textContent = '返回主菜单';
      try { btn.classList.remove('confirm'); } catch { /* 桩 */ }
      this._setTitle(btn, '返回主菜单（需要再点一次确认）');
    }
    return this;
  }

  /** 当前是否处于「确认退出」态 */
  get isConfirming() {
    return this._confirmArmed;
  }

  // -------------------------------------------------------------------------
  // 键盘：焦点导航 + Enter 触发
  // -------------------------------------------------------------------------
  /**
   * 处理按键。返回 true 表示已消费（调用方不要再处理）。
   * 注意：ESC 不在这里处理（由 ui.handleEscape 统一走状态机）。
   * @param {{key?:string, code?:string, preventDefault?:Function, target?:any}} e
   * @param {{navOnly?:boolean}} [opts] navOnly=true 时只处理方向键/Tab（面板打开时用）
   * @returns {boolean}
   */
  handleKey(e, opts = {}) {
    if (!this.isOpen || !e) return false;
    const k = keyOf(e);
    if (!k) return false;
    // 面板打开时方向键仍可移动暂停菜单的「高亮项」（卡片被面板挡住，但这不影响内部状态）；
    // 其余键一律交给面板，避免和面板里的输入/快捷键抢。
    if ((this.ui && this.ui.modalOpen) || opts.navOnly) {
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        this.moveFocus(k === 'ArrowDown' ? 1 : -1);
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      }
      return false;
    }
    // 【空格/Enter 归按钮触发】方向键/Tab 只做焦点移动；Enter/空格在当前按钮上触发。
    // （空格在游戏里是翻滚，暂停时按空格＝按下当前高亮按钮，这是桌面 UI 的通行做法。）
    // 注意：这里返回 true 只表示「事件被暂停菜单消费」，不代表暂停状态变化。
    switch (k) {
      case 'ArrowDown':
        this.moveFocus(1);
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      case 'ArrowUp':
        this.moveFocus(-1);
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      case 'ArrowLeft':
        this.moveFocus(-2);
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      case 'ArrowRight':
        this.moveFocus(2);
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      case 'Tab':
        this.moveFocus((e && e.shiftKey) ? -1 : 1);
        if (typeof e.preventDefault === 'function') e.preventDefault();
        return true;
      case 'Enter':
      case 'NumpadEnter':
      case ' ':
      case 'Spacebar':
      case 'Space': {
        // 焦点在某个按钮上 → 触发它；否则触发当前索引
        const cur = this.focusables[this._focusIdx] || this.focusables[0] || null;
        const act = cur ? attr(cur, 'data-act') : 'resume';
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (act) this.activate(act);
        return true;
      }
      default:
        return false;
    }
  }

  /** 焦点移动（环形）。step=±1 逐项，±2 两列网格的左右 */
  moveFocus(step) {
    const n = this.focusables.length;
    if (!n) return this;
    const dir = step < 0 ? -1 : 1;
    const size = Math.abs(step);
    this._focusIdx = (((this._focusIdx + dir * size) % n) + n) % n;
    this._applyFocus();
    return this;
  }

  /** 当前焦点索引（测试用） */
  get focusIndex() {
    return this._focusIdx;
  }

  /** 当前焦点按钮的 data-act（测试用） */
  get focusedAct() {
    const b = this.focusables[this._focusIdx];
    return b ? attr(b, 'data-act') : null;
  }

  _applyFocus() {
    const list = this.focusables;
    for (let i = 0; i < list.length; i++) {
      try { list[i].classList.toggle('focus', i === this._focusIdx); } catch { /* 桩 */ }
    }
    const cur = list[this._focusIdx];
    if (cur && typeof cur.focus === 'function') {
      try { cur.focus(); } catch { /* 桩 */ }
    }
    return this;
  }

  /** 把焦点放到第一个可聚焦按钮（真实 DOM 里会真正 focus，键盘用户可直接 Enter） */
  focusFirst() {
    this._focusIdx = 0;
    return this._applyFocus();
  }

  /** 打印一次摘要文本（测试/调试用；不依赖 DOM） */
  summaryText() {
    const d = this._snapshot();
    return `${d.name} Lv.${d.level} · ${d.map} · 击杀 ${d.kills}`;
  }
}

/** 极简 HTML 转义（不 import dom.js，避免 UI 模块间的循环依赖） */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 供 UI / 测试复用：动作清单与导航键集合 */
export { ACTIONS, NAV_KEYS, CONFIRM_MS };

export default PauseMenu;