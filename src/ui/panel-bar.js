// 顶部面板栏目（属性 C / 天赋 P / 技能 K / 装备 E）。
//
// 设计要点
// ─────────────────────────────────────────────────────────────────────────────
// 1) **DOM 惰性创建**：构造函数不碰 DOM（`#hud` 可能还没渲染出来），第一次 `sync()` 才挂载；
//    挂载点丢了（HUD 重建 / 桩环境）会自动重建，和 GameUI._ensureSkillNotify 一个思路。
// 2) **防御式 DOM**：standalone 冒烟（tools/check-standalone.mjs）里的 DOM 桩非常弱：
//    `appendChild` 不挂 parentNode、`querySelector` 永远返回新节点、`classList` 是空实现。
//    所以这里每个 DOM 调用都 try/catch，状态（`_active` / `_badges`）永远先写在内存里，
//    再用 `_write()` 尝试同步到 DOM —— 桩坏了也只是"看不见"，不会抛异常。
// 3) **不每帧写 DOM**：角标只在 `syncBadges()` 里刷新，调用方（GameUI）负责节流；
//    内部还做了一次"数值签名比较"，数值没变就一个 DOM 都不碰。
// 4) **图标**：内联 SVG（currentColor 上色、24×24 viewBox、统一 stroke 1.6），
//    不依赖任何外部资源；每个按钮另带中文名 + <kbd> 快捷键角标。
//
// 与 GameUI 的契约
// ─────────────────────────────────────────────────────────────────────────────
//   new PanelBar(ui)                     // 传 GameUI 实例（game.ui）
//   bar.sync()                           // 面板开闭后调用：刷新 .active / aria-pressed
//   bar.syncBadges({ level })            // 点数/等级变化后调用：刷新角标数字
//   bar.setOverallLevel(n)               // 只写缓存（版本号变了 syncBadges 才重算）
//   bar.badgeState()                     // { stats, skills, refine }（测试/调试可读）
//   点击按钮 → ui.openPanel(act)；点的是当前已打开的面板 → ui.closeModals()。

/** 4 个面板按钮（顺序 = 竖向从上到下） */
export const PANEL_ACTIONS = ['stats', 'talents', 'skills', 'equipment'];

/** 每个按钮的元数据：中文名、快捷键、tooltip、图标 SVG */
export const PANEL_ITEMS = [
  {
    act: 'stats',
    label: '属性',
    key: 'C',
    keyDesc: 'C',
    tip: '属性面板 · 角色数值一览（C）',
    aria: '打开属性面板（快捷键 C）',
    svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + '<circle cx="12" cy="5.2" r="2.9"/>'
      + '<path d="M5.4 20.6v-3.3c0-2.5 2.9-4.3 6.6-4.3s6.6 1.8 6.6 4.3v3.3"/>'
      + '<path d="M9.9 13v-1.2M14.1 13v-1.2"/>'
      + '<path d="M10.3 16.1h3.4"/>'
      + '</svg>',
  },
  {
    act: 'talents',
    label: '天赋',
    key: 'P',
    keyDesc: 'P',
    tip: '天赋树 · 点亮节点强化角色（P）',
    aria: '打开天赋树（快捷键 P）',
    // 星芒 + 节点网络：中心大节点、六芒星内核、外圈 6 个节点与连线
    svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + '<path d="M12 2.9v3M12 18.1v3M5.6 6.6l2.2 2.2M16.2 15.2l2.2 2.2M3 12h3M18 12h3M5.6 17.4l2.2-2.2M16.2 8.8l2.2-2.2"/>'
      + '<circle cx="12" cy="12" r="2.9"/>'
      + '<circle cx="12" cy="2.6" r="1.05" fill="currentColor" stroke="none"/>'
      + '<circle cx="12" cy="21.4" r="1.05" fill="currentColor" stroke="none"/>'
      + '<circle cx="2.6" cy="12" r="1.05" fill="currentColor" stroke="none"/>'
      + '<circle cx="21.4" cy="12" r="1.05" fill="currentColor" stroke="none"/>'
      + '<circle cx="4.9" cy="4.9" r="1.05" fill="currentColor" stroke="none"/>'
      + '<circle cx="19.1" cy="19.1" r="1.05" fill="currentColor" stroke="none"/>'
      + '<circle cx="19.1" cy="4.9" r="1.05" fill="currentColor" stroke="none"/>'
      + '<circle cx="4.9" cy="19.1" r="1.05" fill="currentColor" stroke="none"/>'
      + '</svg>',
  },
  {
    act: 'skills',
    label: '技能',
    key: 'K',
    keyDesc: 'K',
    tip: '技能天赋分叉 · 加点与精炼（K / Tab）',
    aria: '打开技能面板（快捷键 K 或 Tab）',
    // 符文：六边形符文石 + 内嵌竖钩 + 三个点
    svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + '<path d="M12 2.4 19.9 7v10L12 21.6 4.1 17V7z"/>'
      + '<path d="M12 6.6v8.2"/><path d="M12 14.8 9.7 12.5"/>'
      + '<circle cx="9.1" cy="9.1" r="1" fill="currentColor" stroke="none"/>'
      + '<circle cx="14.9" cy="9.1" r="1" fill="currentColor" stroke="none"/>'
      + '<circle cx="12" cy="18.2" r="1" fill="currentColor" stroke="none"/>'
      + '</svg>',
  },
  {
    act: 'equipment',
    label: '装备',
    key: 'E',
    keyDesc: 'E',
    tip: '装备与背包 · 穿戴 / 出售（E / I）',
    aria: '打开装备背包（快捷键 E）',
    // 头盔甲胄：盔顶 + 面甲开口 + 颈甲
    svg: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + '<path d="M12 2.6 5.8 4.6v6.7c0 4.3 2.6 7.5 6.2 9.6 3.6-2.1 6.2-5.3 6.2-9.6V4.6z"/>'
      + '<path d="M9.4 11.5h5.2"/>'
      + '<path d="M12 6.3v3.2M9.4 17.4 12 15l2.6 2.4"/>'
      + '</svg>',
  },
];

/** 角标数字格式：>99 → "99+" */
export function badgeText(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v <= 0) return '';
  return v > 99 ? '99+' : String(v);
}

/** 可分配天赋点（防御式：inv 可能还没创建） */
export function talentPointsOf(ui) {
  const inv = ui && ui.game && ui.game.inv;
  const raw = inv && inv.talentPoints;
  // 兼容 { points } / { avail } 这种对象形态（数据层偶尔会换形状）
  const n = raw && typeof raw === 'object' ? (raw.points ?? raw.avail ?? raw.remaining) : raw;
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export class PanelBar {
  /**
   * @param {Object} ui GameUI 实例（需要 openPanel / closeModals / modalOpen / skillNotifyState）
   */
  constructor(ui) {
    this.ui = ui;
    /** @type {HTMLElement|null} */
    this.el = null;
    /** @type {Object<string, HTMLElement>} */
    this.btns = {};
    /** 当前激活的面板（与 ui.modalOpen 同步） */
    this._active = null;
    /** 每个按钮的角标状态：{ stats, skills, refine } */
    this._badges = { stats: 0, skills: 0, refine: 0 };
    /** 上一次写进 DOM 的签名（数字没变就不碰 DOM） */
    this._badgeSig = null;
    /** 玩家等级缓存（版本号真变化时才重算角标） */
    this._level = 0;
    this._mounted = false;
  }

  // ── DOM ────────────────────────────────────────────────────────────────
  /**
   * 惰性创建 + 挂载。返回容器（拿不到 DOM 时返回 null）。
   *
   * 【#panel-bar 全局只能有一个】重复 `new GameUI()`（HMR / 调试脚本 / 重开一局）时，
   * 新实例必须**接管**页面里已存在的按钮列，而不是再建一个叠在右下角（QA 验收项 G：
   * `querySelectorAll('#panel-bar').length === 1`）。所以顺序是：
   *   ① 已有自己的引用 → 直接用；
   *   ② 页面上已有 #panel-bar（上一个实例建的）→ 接管：重新绑定按钮事件、刷新 .active / 角标；
   *   ③ 都没有 → 新建并**追加一次**。
   * 注意桩环境里 getElementById 可能查不到动态创建节点 —— 查不到时才会走 ③，
   * 而且 ③ 只在"确实没有"时执行，所以即使桩永远查不到，第一实例也只会建一次（靠 ①）。
   * @returns {HTMLElement|null}
   */
  ensure() {
    try {
      if (this.el) return this.el;
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
      // ② 接管已有节点（不 append）
      const exist = this._findExisting();
      if (exist) return this._adopt(exist);
      // ③ 新建 + 挂载（唯一一次 append）
      const host = document.getElementById('hud') || document.body || null;
      if (!host) return null;
      const node = this._build();
      try { if (node && typeof host.appendChild === 'function') host.appendChild(node); } catch { /* 桩环境 */ }
      this.el = node;
      try { node._pbOwner = this; } catch { /* 桩环境 */ }
      this._mounted = true;
      this._badgeSig = null; // 新节点必须重写一次角标 DOM
      this._syncBadgeDom();
      this.sync();
      return node;
    } catch {
      return this.el || null;
    }
  }

  /** 页面里已存在的 #panel-bar（查不到返回 null；任何异常都当成"没有"） */
  _findExisting() {
    try {
      if (typeof document.getElementById !== 'function') return null;
      const node = document.getElementById('panel-bar');
      return node && typeof node === 'object' ? node : null;
    } catch {
      return null;
    }
  }

  /**
   * 接管一个已存在的 #panel-bar：重新绑定按钮引用与事件（旧实例留在 DOM 上的监听器
   * 指向旧 GameUI，不能继续用），然后刷新状态。不创建、不移动、不重复追加。
   * @param {HTMLElement} node
   * @returns {HTMLElement}
   */
  _adopt(node) {
    // 旧实例（上一任 owner）立即让位：它的监听器即便还挂在 DOM 上也不再改状态
    try {
      const prev = node._pbOwner;
      if (prev && prev !== this) prev._superseded = true;
      node._pbOwner = this;
    } catch { /* 桩环境 */ }
    this.el = node;
    this._mounted = true;
    this.btns = {};
    // 按顺序取按钮：优先 querySelectorAll（真浏览器），退化到 children 遍历（弱 DOM 桩）
    let found = [];
    try {
      if (typeof node.querySelectorAll === 'function') found = Array.from(node.querySelectorAll('.panel-btn') || []);
    } catch { found = []; }
    if (!found.length) {
      const kids = Array.isArray(node.children) ? node.children : [];
      found = kids.filter((c) => c && String(c.className || '').split(/\s+/).includes('panel-btn'));
    }
    for (const item of PANEL_ITEMS) {
      const btn = found.find((b) => b && typeof b.getAttribute === 'function' && b.getAttribute('data-act') === item.act);
      if (!btn) continue;
      // force=true：旧实例的监听器要交还给本实例（见 _bindButton 注释）
      this._bindButton(btn, item, true);
      this.btns[item.act] = btn;
      // 子结构缺了就补齐（旧版本节点 / 桩里 innerHTML 没解析）
      if (!this._hasChildren(btn)) this._rebuildChildren(btn, item);
    }
    this._badgeSig = null;
    this._syncBadgeDom();
    this.sync();
    return node;
  }

  /** 按钮内部结构是否齐全（ico / label / kbd / badge） */
  _hasChildren(btn) {
    try {
      const kids = Array.isArray(btn.children) ? btn.children : [];
      const has = (cls) => kids.some((c) => c && String(c.className || '').split(/\s+/).includes(cls));
      return has('pb-ico') && has('pb-label') && has('pb-key') && has('pb-badge');
    } catch {
      return false;
    }
  }

  /**
   * 给按钮绑定点击（接管时必须**强制重绑**：旧实例留在 DOM 节点上的监听器指向旧 GameUI，
   * 继续用就会"点了没反应 / 点在旧实例上"）。
   * 重绑前先解绑：优先 removeEventListener（移除该实例的监听）；桩里没有该能力时，
   * 退化为"重写 _pbHandler 标记 + 旧监听器自检 this.panelBar 是否仍是自己"——
   * 旧监听器发现自己已被接管就会主动让位，不产生重复触发。
   * @param {HTMLElement} btn @param {Object} item PANEL_ITEMS 的一项
   * @param {boolean} [force] true = 从旧实例手上抢回
   */
  _bindButton(btn, item, force) {
    try {
      if (!btn) return;
      if (btn._pbBound && !force) return;
      if (force && btn._pbHandler && typeof btn.removeEventListener === 'function') {
        try { btn.removeEventListener('click', btn._pbHandler); } catch { /* 桩环境 */ }
      }
      btn._pbBound = true;
      btn._pbOwnerAct = item.act;
      const owner = this;
      const handler = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (e && e.preventDefault) e.preventDefault();
        owner.activate(item.act);
      };
      btn._pbHandler = handler;
      if (btn.addEventListener) btn.addEventListener('click', handler);
    } catch { /* 桩环境 */ }
  }

  /** 一次性建好 4 个按钮（只有 ensure() 会调用） */
  _build() {
    const wrap = document.createElement('div');
    wrap.id = 'panel-bar';
    wrap.className = 'panel-bar';
    wrap.setAttribute('role', 'toolbar');
    wrap.setAttribute('aria-label', '角色面板');
    // 防止 input.js 的 window 级 keydown 把焦点按钮上的 Enter/空格当成游戏按键
    if (wrap.addEventListener) {
      wrap.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          // Enter/空格的触发统一由按钮自己的 click 负责；这里只阻止冒泡到全局
          if (e.stopPropagation) e.stopPropagation();
        }
      });
    }

    for (const item of PANEL_ITEMS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'panel-btn';
      btn.setAttribute('data-act', item.act);
      btn.setAttribute('title', item.tip);
      btn.setAttribute('aria-label', item.aria);
      btn.setAttribute('aria-pressed', 'false');
      // 子节点用 innerHTML 一次性拼出来（轴上的样式全在 CSS，JS 不碰）
      btn.innerHTML =
        `<span class="pb-ico" aria-hidden="true">${item.svg}</span>`
        + `<span class="pb-label">${item.label}</span>`
        + `<kbd class="pb-key">${item.keyDesc}</kbd>`
        + `<i class="pb-badge pb-badge-hidden" aria-hidden="true"></i>`;
      // 【为什么还要逐个 appendChild】innerHTML 依赖桩里"解析 HTML 字符串"的能力，
      // 极弱 DOM（standalone 冒烟）里拿不到子节点，角标就永远写不进 DOM。
      // 这里再用真实节点搭一次同样的结构：innerHTML 解析成功时它是幂等覆盖，解析失败时它就是唯一来源。
      this._rebuildChildren(btn, item);
      this._bindButton(btn, item);
      try { wrap.appendChild(btn); } catch { /* 桩环境 */ }
      this.btns[item.act] = btn;
    }
    return wrap;
  }

  /**
   * 用真实节点重建按钮内部结构（icon / 中文名 / <kbd> / 角标）。
   * 只在 _build 里调用一次；失败也只是少了个装饰。
   * @param {HTMLElement} btn @param {Object} item PANEL_ITEMS 的一项
   */
  _rebuildChildren(btn, item) {
    try {
      if (!btn || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
      if (typeof btn.removeChild === 'function') {
        for (const c of (Array.isArray(btn.children) ? btn.children.slice() : [])) {
          try { btn.removeChild(c); } catch { /* 桩环境 */ }
        }
      }
      const ico = document.createElement('span');
      ico.className = 'pb-ico';
      ico.setAttribute('aria-hidden', 'true');
      ico.innerHTML = item.svg;
      const label = document.createElement('span');
      label.className = 'pb-label';
      label.textContent = item.label;
      const kbd = document.createElement('kbd');
      kbd.className = 'pb-key';
      kbd.textContent = item.keyDesc;
      const badge = document.createElement('i');
      badge.className = 'pb-badge pb-badge-hidden';
      badge.setAttribute('aria-hidden', 'true');
      // 注意：桩里 appendChild 不写 parentNode，所以按钮能否"包含"子节点只取决于 children 数组
      for (const c of [ico, label, kbd, badge]) btn.appendChild(c);
    } catch { /* 桩环境 */ }
  }

  // ── 交互 ───────────────────────────────────────────────────────────────
  /**
   * 点击/键盘激活某个面板按钮：已打开同一个 → 关闭；否则切到该面板。
   * （暂停菜单打开时也能用：暂停菜单 z-index 65 / #modal 70，按钮列 20 且不被遮罩挡住）
   * @param {string} act
   * @returns {string|null} 切换后的 modalOpen
   */
  activate(act) {
    const ui = this.ui;
    if (!ui || !act) return ui ? ui.modalOpen : null;
    // 【被接管后让位】同一个 #panel-bar 被新的 GameUI 实例接管时，旧实例的监听器可能还挂在
    // DOM 上（桩环境没有 removeEventListener）。此时旧 PanelBar 不能再改 ui.modalOpen ——
    // 否则一次点击会被两个实例各处理一次（关了又开）。判据是"节点上的 owner 是不是我"，
    // 不能用 getElementById 比较（桩里查不到动态节点，真浏览器里也会误判）。
    if (this._superseded || (this.el && this.el._pbOwner && this.el._pbOwner !== this)) {
      this._superseded = true;
      try {
        if (ui.modalOpen != null && typeof ui.closeModals === 'function') ui.closeModals();
      } catch { /* 纯装饰 */ }
      return ui.modalOpen || null;
    }
    // 判断"这个面板是否已经开着"用 ui.activePanel()（它把 inventory ↔ equipment 互认）；
    // 退化到 modalOpen 时也要认 equipment，否则点第二次装备按钮不会关、而是重开。
    const shown = typeof ui.activePanel === 'function' ? ui.activePanel() : (ui.modalOpen === 'inventory' && act === 'equipment' ? 'equipment' : ui.modalOpen);
    if (shown === act) {
      ui.closeModals();
      this.sync();
      return null;
    }
    let result = null;
    if (typeof ui.openPanel === 'function') {
      result = ui.openPanel(act);
      this.sync();
      if (result === undefined) result = ui.modalOpen;
    } else if (typeof ui.closeModals === 'function') {
      result = ui.modalOpen || null;
    }
    return result;
  }

  /**
   * 面板开闭状态同步：给当前面板的按钮加 .active。
   * @param {string|null} [kind] 缺省读 ui.modalOpen
   */
  sync(kind) {
    // 与 GameUI.activePanel() 同一套映射：装备面板的 modalOpen 是 'inventory'，按钮 data-act 是 'equipment'
    const raw = (kind !== undefined ? kind : (this.ui ? this.ui.modalOpen : null)) || null;
    const norm = raw === 'inventory' || raw === 'bag' || raw === 'equip' ? 'equipment' : raw;
    this._active = norm;
    if (!this.el) return;
    // 被新实例接管的旧节点：把状态记在节点上（两个实例各自持有自己的 el 引用，靠 setAttribute 区分 owner）
    try {
      const owner = this.el._pbOwner;
      if (owner && owner !== this) {
        this._superseded = true;
        return;
      }
      this.el._pbOwner = this;
    } catch { /* 桩环境 */ }
    for (const act of PANEL_ACTIONS) {
      const btn = this.btns[act];
      if (!btn) continue;
      const on = act === norm;
      try {
        // 先写 className 再 toggle：与 GameUI._renderSkillNotify 同理，桩里两套存储都写最稳。
        // 【顺序不能反】classList.toggle 在真浏览器里会回写 className，所以类名先落 className，
        // 断言/调试脚本读到的 className 才是最终真相。
        btn.className = 'panel-btn' + (on ? ' active' : '');
        if (btn.classList && btn.classList.toggle) btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      } catch { /* 桩环境 */ }
    }
    // 按钮列的挂载状态与 HUD 同步（HUD 隐藏时整列跟着隐藏，靠 CSS 的 #hud .hidden 继承即可）
  }

  /** 当前激活面板（与 DOM 无关的可读状态） */
  get active() {
    return this._active;
  }

  // ── 角标 ───────────────────────────────────────────────────────────────
  /** 缓存玩家等级；版本号变了才需要重算角标 */
  setOverallLevel(level) {
    const v = Math.floor(Number(level) || 0);
    if (v !== this._level) this._level = v;
    return this._level;
  }

  /** 统计当前应显示的角标数字（不含 DOM 操作） */
  badgeState() {
    const ui = this.ui;
    const stats = talentPointsOf(ui);
    let skills = 0;
    let refine = 0;
    if (ui && typeof ui.skillNotifyState === 'function') {
      try {
        const st = ui.skillNotifyState() || {};
        skills = Math.max(0, Math.floor(Number(st.points) || 0));
        refine = Math.max(0, Math.floor(Number(st.refineable) || 0));
      } catch {
        skills = 0;
        refine = 0;
      }
    }
    return { stats, skills, refine };
  }

  /**
   * 刷新角标（由 GameUI 在 ≤1Hz 的节拍 / 点数变化事件里调用）。
   * @param {{level?:number}} [opts]
   * @returns {{stats:number, skills:number, refine:number}}
   */
  syncBadges(opts = {}) {
    if (opts && opts.level != null) this.setOverallLevel(opts.level);
    const st = this.badgeState();
    if (st.stats !== this._badges.stats || st.skills !== this._badges.skills || st.refine !== this._badges.refine) {
      this._badges = st;
      this._badgeSig = null; // 数值变了 → 允许写 DOM
    }
    if (!this.el) this.ensure();
    this._syncBadgeDom();
    return st;
  }

  /**
   * 真正写 DOM：数值签名没变就什么都不做（每帧调用也安全）。
   * 角标语义：
   *   stats   —— 可分配天赋点（金色，数字 = 点数）
   *   skills  —— 可分配技能点（金色，数字 = 点数）
   *   refine  —— 没有技能点但有可精炼技能时，技能按钮显示琥珀色 "!"（与 #skill-notify 的 refine 态同义）
   */
  _syncBadgeDom() {
    const st = this._badges;
    const skillsText = badgeText(st.skills);
    const refineText = skillsText ? '' : (st.refine > 0 ? '!' : '');
    const sig = `${badgeText(st.stats)}|${skillsText}|${refineText}|${st.refine}`;
    if (sig === this._badgeSig) return;
    this._badgeSig = sig;
    this._writeBadge('stats', badgeText(st.stats), false);
    this._writeBadge('skills', skillsText || refineText, !skillsText && !!refineText);
  }

  /**
   * 写一个按钮的角标。桩环境下 querySelector 可能拿不到，退化为纯文本写入。
   * @param {string} act
   * @param {string} text '' = 隐藏
   * @param {boolean} refineMode 琥珀色 "!"（可精炼但无可分配点）
   */
  _writeBadge(act, text, refineMode) {
    const btn = this.btns[act];
    if (!btn) return;
    try {
      if (text && btn.setAttribute) {
        if (act === 'stats') btn.setAttribute('title', `属性面板 · 角色数值一览（C） · ${text} 点天赋可分配`);
        else if (act === 'skills' && refineMode) btn.setAttribute('title', `技能天赋分叉 · 有技能可以精炼（K / Tab）`);
        else if (act === 'skills') btn.setAttribute('title', `技能天赋分叉 · ${text} 点技能点可分配（K / Tab）`);
        else btn.setAttribute('title', PANEL_ITEMS.find((it) => it.act === act)?.tip || '');
      }
      // 调试/测试可读：data-badge 始终反映"应该显示什么"
      if (btn.setAttribute) btn.setAttribute('data-badge', text);
    } catch { /* 桩环境 */ }
    const badge = this._badgeNode(btn);
    if (!badge) return;
    try {
      badge.textContent = text;
      if (badge.className != null) badge.className = 'pb-badge' + (text ? '' : ' pb-badge-hidden') + (refineMode ? ' refine' : '');
      if (badge.classList && badge.classList.toggle) {
        // 两套写法都上：桩里 classList 与 className 可能是两份独立存储
        badge.classList.toggle('pb-badge-hidden', !text);
        badge.classList.toggle('refine', !!refineMode);
      }
      if (badge.setAttribute) badge.setAttribute('title', text || '');
    } catch { /* 桩环境 */ }
  }

  /**
   * 取按钮里的角标节点。优先 querySelector，拿不到就遍历 children
   * （极弱 DOM 桩的 querySelector 永远返回 null）。
   * @param {HTMLElement} btn
   * @returns {HTMLElement|null}
   */
  _badgeNode(btn) {
    try {
      let node = typeof btn.querySelector === 'function' ? btn.querySelector('.pb-badge') : null;
      if (node) return node;
    } catch { /* 走遍历 */ }
    const kids = Array.isArray(btn.children) ? btn.children : [];
    for (const c of kids) {
      const cls = String((c && (c.className || c.id)) || '');
      if (cls.split(/\s+/).includes('pb-badge')) return c;
    }
    return null;
  }

  /** 测试/调试：当前写入 DOM 的角标文字 */
  debugState() {
    return {
      acts: PANEL_ACTIONS.slice(),
      btns: Object.keys(this.btns).length,
      active: this._active,
      badges: { ...this._badges },
      badgeSig: this._badgeSig,
    };
  }
}

export default PanelBar;