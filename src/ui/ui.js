// UI 主控：HUD 绑定、事件处理（击杀提示/升级/拾取公告）、弹窗系统、UI 回调集合。
// 只在浏览器运行；game.updateGame 会调用这些回调（game.ui）。
//
// 【防御式依赖】核心/数据层正在并行迭代（技能精炼、分叉天赋、战争践踏…），
// 所以对 src/core/skills.js 的引用一律走命名空间 import + 调用前判型：
// 对方的新导出（skillDisplayInfo / skillCooldownTotal / nextRefineCost）缺席时，
// HUD 必须退回旧逻辑继续工作，而不是整个 UI 崩掉。
import { $, $ALL, el, escapeHTML, rarityColor, itemTooltipHTML, pct, syncSkillSlotLabels } from './dom.js';
import { openInventory, resetSellConfirm } from './inventory-ui.js';
import { openTalents } from './talent-ui.js';
import { openSkills, refineStatus } from './skill-ui.js';
import { openHomePanel, refreshHomePanel } from './home-ui.js';
import * as skillsMod from '../core/skills.js';
import { isMuted, toggleMute, playSfx } from './sfx.js';
// 技能栏角标（Q/W/E/R/T）以输入层的键位表为唯一真相，见 syncSkillSlotLabels()
import { SKILL_KEYS } from '../game/input.js';
import { PanelBar } from './panel-bar.js';
// 暂停菜单（ESC）：纯 DOM 组件；状态机在 GameUI 上（见本文件末尾「暂停系统」段）
import { PauseMenu } from './pause.js';
// 属性面板由 stats-ui.js 提供（并行开发中）：命名空间 import + 调用前判型，
// 模块里暂时没有 openStats 时只记日志、不崩；到位后无需改动这里。
import * as statsMod from './stats-ui.js';

export class GameUI {
  constructor(game) {
    this.game = game;
    this.logLines = [];
    this.bannerTimer = 0;
    this.modalOpen = null; // 'inventory' | 'talents' | 'skills' | 'stats' | null
    this.damageGrid = [];
    this.lastKillCombo = { count: 0, timer: 0 };
    this.hudEls = {};
    this._skillNotifyT = 0; // 技能栏光点角标的节流计时
    this._skillNotifySig = null; // 上一次角标状态签名（null = 还没算过，必须首帧刷新）
    this._panelBarT = 0; // 底部面板按钮列角标的节流计时（≤1Hz，绝不每帧写 DOM）
    this._panelLevel = -1; // 上一次看到的玩家等级（等级变化立刻刷新角标）
    // ---- 暂停（ESC）----
    this.paused = false;        // 与 game.paused 双写；只由 togglePause 修改
    this.pauseMenu = null;      // PauseMenu 实例（第一次暂停时才创建 DOM）
    this._pauseShown = false;   // 暂停卡片当前是否「显示」（面板打开时暂停仍成立，但卡片让位）
    this._cacheDOM();
    this._bindStatic();
    this._bindSfx();
  }

  _cacheDOM() {
    this.hud = $('#hud');
    this.el = {
      hp: $('#bar-hp'), mp: $('#bar-mp'), xp: $('#bar-xp'),
      tHp: $('#txt-hp'), tMp: $('#txt-mp'), tXp: $('#txt-xp'),
      level: $('#char-level'), mapName: $('#map-name'), mapMods: $('#map-mods'),
      kills: $('#kill-count'), waves: $('#wave-count'),
      stats: $('#stats-panel'), statsRows: $('#stats-rows'), log: $('#log'), combo: $('#combo'),
      loot: $('#loot-items'), banner: $('#banner'), tooltip: $('#tooltip'),
      modal: $('#modal'), modalTitle: $('#modal-title'), modalBody: $('#modal-body'), modalFoot: $('#modal-foot'),
      slots: $ALL('#skillbar .slot'),
      avatar: $('#avatar'), charName: $('#char-name'), helpHint: $('#help-hint'),
      mageStatus: $('#mage-status'), mageAutoState: $('#mage-auto-state'),
      mageResFill: $('#mage-res-fill'), mageResText: $('#mage-res-text'),
      magePresets: $('#mage-presets'),
    };
    // 技能栏图标与快捷键（来自核心技能定义）
    this.el.slots.forEach((slot, i) => {
      const inst = this.game.world.player.skillBar?.[i];
      const glyph = slot.querySelector('.glyph');
      if (!glyph) return;
      if (inst) {
        glyph.textContent = inst.icon || '?';
        glyph.title = inst.name || '';
      } else if (i === 5) {
        glyph.textContent = '💨';
      } else if (i === 6) {
        glyph.textContent = '🏕';
      }
    });
    // 角标直接按输入层键位表写（Q W E R T / 空格），不等第一次 refreshSkillBarIcons
    /* TEMP-DISABLED */
    const hint = $('#buff-bar');
    if (!hint) {
      const bar = document.createElement('div');
      bar.id = 'buff-bar';
      document.getElementById('hud')?.appendChild(bar);
    }
    this._ensureSkillNotify();
    this._ensureMuteButton();
    this._ensurePanelBar();
  }

  /**
   * 底部面板按钮列（属性 C / 天赋 P / 技能 K / 装备 E）。
   * 持有在 GameUI 上：openModal/closeModals 负责同步 .active，update() 负责 ≤1Hz 刷角标。
   *
   * 【#panel-bar 全局唯一】重复 new GameUI()（HMR / 调试脚本 / 重开一局）时，页面里可能已经
   * 有上一个实例建的 #panel-bar。先接管它（PanelBar.ensure() 内部会 getElementById 复用），
   * 绝不新建第二个 —— QA 验收项：querySelectorAll('#panel-bar').length === 1。
   * （#pause-menu 是 pause-dev 的同类问题：那边也应"先查已有节点再建"，此处不越界改。）
   */
  _ensurePanelBar() {
    if (this.panelBar) return this.panelBar;
    try {
      this.panelBar = new PanelBar(this);
      this.panelBar.ensure(); // 有则接管、无则创建（唯一一次 append）
      this.panelBar.sync(this.activePanel());
      this.panelBar.syncBadges({ level: this.game?.world?.player?.level || 1 });
      this._panelLevel = this.game?.world?.player?.level || 1;
    } catch (e) {
      // 按钮列纯装饰性：建不出来也不该拖垮整个 HUD
      this.panelBar = null;
      console.warn('[ui] 面板按钮列初始化失败', e);
    }
    return this.panelBar;
  }

  /** 面板开闭 / 点数变化后同步按钮列（防御式：party 环境里 PanelBar 可能缺席） */
  _syncPanelBar() {
    const bar = this.panelBar || this._ensurePanelBar();
    if (!bar) return;
    try { bar.sync(this.activePanel()); } catch { /* 纯装饰 */ }
  }

  /**
   * 技能栏「有可分配技能点 / 可精炼」光点角标。
   * 为什么建在 #skillbar 里而不是槽位上：#skillbar 有定位上下文，角标可以浮在整条栏的右上方，
   * 且 7 个槽位的 hover / 冷却遮罩都不会盖住它（z-index 单独抬高）。
   *
   * 【读信号要宽松】每次 build 之后都 getElementById 一遍：DOM 桩里动态创建的节点可能查不到，
   * 此时就重建一个并挂到 #skillbar；不能因为「查不到」就认为角标不存在（那样角标永远不显示）。
   */
  _ensureSkillNotify() {
    const bar = document.getElementById('skillbar') || document.getElementById('hud');
    let node = document.getElementById('skill-notify');
    if (!node) node = this.el && this.el.skillNotify;
    // 节点已从 DOM 里掉了（面板重绘 / 桩环境 reference 失效）→ 重建
    if (node && !node.parentNode && bar) node = null;
    if (!node) {
      node = el('div', { id: 'skill-notify', title: '有可分配的技能点' });
      node.innerHTML = '<i class="sn-dot"></i><span class="sn-num"></span>';
      // 初始即隐藏：真正的显隐由 updateSkillNotify 依据「有点/可精炼」决定
      node.className = 'skill-notify hidden';
      node.classList.add('hidden');
      if (node.addEventListener) {
        // 点光点直接打开技能面板（比让玩家去记 K 键友好）
        node.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          this.toggleSkills();
        });
      }
      if (bar) bar.appendChild(node);
    }
    this.el.skillNotify = node;
  }

  /**
   * HUD 右下角的静音开关（同时支持 M 键）。
   * 用 textContent 而不是图标字体：不依赖任何外部资源。
   */
  _ensureMuteButton() {
    let btn = document.getElementById('sfx-toggle');
    if (!btn) {
      btn = el('button', { id: 'sfx-toggle', class: 'sfx-toggle', type: 'button' });
      (document.getElementById('hud') || document.body)?.appendChild(btn);
      if (btn.addEventListener) btn.addEventListener('click', (e) => { e.stopPropagation?.(); this.toggleSfx(); });
    }
    this.el.sfxToggle = btn;
    this._syncMuteButton();
  }

  /** 刷新静音按钮的外观与 title */
  _syncMuteButton() {
    const btn = this.el.sfxToggle;
    if (!btn) return;
    const m = isMuted();
    btn.textContent = m ? '🔇' : '🔊';
    btn.title = m ? '音效已静音（M 键切换）' : '音效开启（M 键切换）';
    btn.classList.toggle('muted', m);
  }

  /** 音效：首次用户手势后 Mk 一个短促的 UI 音，顺便把 AudioContext 唤醒 */
  _bindSfx() {
    try {
      window.addEventListener('pointerdown', () => {
        // 浏览器要求 AudioContext 在用户手势内创建/恢复，这里做一次"预热"：
        // 不发声（突然出声会吓到玩家），只是确保之后的技能音效不会被自动播放策略吞掉。
        this._sfxWarm = true;
      }, { once: true });
    } catch { /* 桩环境没有真 window 也无所谓 */ }
  }

  /** 切换静音（M 键 / 按钮） */
  toggleSfx() {
    const muted = toggleMute();
    this._syncMuteButton();
    this.addLog(muted ? '🔇 音效已关闭' : '🔊 音效已开启', muted ? '#888' : '#c8a25a');
    if (!muted) playSfx('orb');
    return muted;
  }

  _bindStatic() {
    $('#modal-close')?.addEventListener('click', () => this.closeModals());
    this.el.modal?.addEventListener('click', (e) => { if (e.target === this.el.modal) this.closeModals(); });
    // 【ESC 只走一处】键盘路由在 main.js（capture 阶段 → ui.handleEscape()）。
    // 这里**不能**再挂 Escape→closeModals 的监听：那样一次 ESC 会先关面板、再被状态机当成
    // "没有面板"而顺手打开暂停菜单。想看 ESC 的完整语义请搜索 handleEscape()。
    // 技能栏悬停提示
    for (const slot of this.el.slots) {
      slot.addEventListener('mouseenter', () => this._showSkillTooltip(slot));
      slot.addEventListener('mouseleave', () => this.hideTooltip());
    }
    this._bindSkillSlots();
    this._bindMagePresets();
  }

  /** 法师循环预设按钮（均衡 / 反应流 / 蓄积流） */
  _bindMagePresets() {
    const bar = this.el && this.el.magePresets;
    if (!bar) return;
    const buttons = bar.querySelectorAll ? bar.querySelectorAll('button[data-preset]') : [];
    for (const btn of buttons) {
      if (!btn || typeof btn.addEventListener !== 'function') continue;
      btn.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const preset = (btn.getAttribute && btn.getAttribute('data-preset'))
          || (btn.dataset && btn.dataset.preset) || '';
        if (!preset) return;
        if (this.game && this.game.actions && typeof this.game.actions.setMagePreset === 'function') {
          this.game.actions.setMagePreset(preset);
        } else if (this.game && this.game.world && this.game.world.player && this.game.world.player.mage) {
          this.game.world.player.mage.preset = preset;
        }
      });
    }
  }

  /**
   * 技能栏格子 = 真正的按钮。
   *
   * 【为什么必须有这段】HUD 上的 7 个格子只有 hover 提示，从来没有 click 处理：
   * 鼠标点上去什么都没发生（"技能释放的按钮不能正常工作"）。这里把它接回输入层：
   *   - 0~4 号格子 → input.queueSkill(id)，与按 1-5 走完全相同的 tryCast 链路；
   *   - 5 号（翻滚）→ input.queueDash()，与按空格相同；
   *   - 6 号（回城）→ 快捷键表里的 newMap（与按 T 相同）。
   * 防御式：input 可能还没创建（GameUI 在 startGame 里先于 new Input 构造），
   * 所以每次点击时**现取** game.ui.input / window.__poeMain.input，而不是构造时抓死。
   */
  _bindSkillSlots() {
    const slots = this.el && Array.isArray(this.el.slots) ? this.el.slots : [];
    slots.forEach((slot, idx) => {
      if (!slot || typeof slot.addEventListener !== 'function') return;
      // 键盘可达性：格子可 Tab 聚焦，回车/空格触发（空格在游戏里是翻滚，这里只认回车）
      try {
        slot.setAttribute('role', 'button');
        slot.setAttribute('tabindex', '-1');
      } catch { /* 桩环境 */ }
      const activate = (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        this._activateSkillSlot(idx);
      };
      slot.addEventListener('click', activate);
      slot.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
          if (e.preventDefault) e.preventDefault();
          activate(e);
        }
      });
    });
  }

  /**
   * 点击某个技能格子的实际动作。game 暂停 / 面板打开时不响应（与键盘一致）。
   * @param {number} idx 0-4 技能 · 5 翻滚 · 6 回城
   * @returns {boolean} 是否已处理
   */
  _activateSkillSlot(idx) {
    if (this.isPaused() || this.modalOpen) return false; // 暂停/面板中不施法（与键盘守卫一致）
    const input = this._inputRef();
    const p = this.game && this.game.world && this.game.world.player;
    if (!p) return false;
    if (idx === 6) {
      // 回城 / 下一张图：与快捷键 T 同一个动作（main.js 的 HOTKEYS.KeyT）
      const travel = this.game && this.game.actions && this.game.actions.newMap;
      if (typeof travel === 'function') { travel(); return true; }
      return false;
    }
    if (idx === 5) {
      if (input && typeof input.queueDash === 'function') return input.queueDash();
      return false;
    }
    const inst = Array.isArray(p.skillBar) ? p.skillBar[idx] : null;
    if (!inst || !inst.id) return false;
    if (!input || typeof input.queueSkill !== 'function') return false;
    // 点一下 = 按一下数字键：排进输入队列，下一次 updateGame 时由 tryCast 结算
    const ok = input.queueSkill(inst.id);
    if (ok) {
      // 轻量反馈：点击瞬间给格子一个 .pressed 动画（不改变任何游戏状态）
      try {
        const node = this.el && Array.isArray(this.el.slots) ? this.el.slots[idx] : null;
        if (node && node.classList) {
          node.classList.remove('pressed');
          void node.offsetWidth;
          node.classList.add('pressed');
        }
      } catch { /* 纯装饰 */ }
    }
    return ok;
  }

  /** 取当前 Input 实例（GameUI 构造时它可能还不存在，所以每次现取） */
  _inputRef() {
    if (this.input) return this.input;
    try {
      if (typeof window !== 'undefined' && window && window.__poeMain && window.__poeMain.input) return window.__poeMain.input;
    } catch { /* 桩环境 */ }
    return null;
  }

  // ---- 生命周期回调（由 game 调用） ----
  onEvents(events) {
    const w = this.game.world;
    for (const e of events) {
      switch (e.type) {
        case 'monsterKilled':
          this._bumpCombo();
          if (e.rarity === 'boss') this.banner(`击败首领 · ${e.name || '深渊主宰'}`, '#ff5a2a');
          else if (e.rarity === 'rare') this.banner(`击杀精英 · ${(e.entity && e.entity.displayName) || e.name || ''}`, '#ffd34d');
          break;
        case 'bossSpawn':
          this.banner(`⚠ 首领降临 · ${e.name || '深渊主宰'} ⚠`, '#ff2a2a');
          break;
        case 'levelUp':
          this.banner(`升级！ 等级 ${e.level}  ·  天赋点 +${e.gainedPoints || 2}`, '#8be8ff');
          this.flashSide('level');
          // 升级会同时给天赋点 / 技能点：事件里立刻刷一次按钮列角标（不等 ≤1Hz 节拍）
          try { this.panelBar?.syncBadges({ level: e.level || this.game.world.player.level }); } catch { /* 纯装饰 */ }
          break;
        case 'loot':
          if (e.item) this.lootToast(e.item);
          break;
        case 'playerDeath':
          this.banner('你已倒下…', '#ff2a2a');
          break;
        case 'eliteSpawn':
          this.addLog('精英怪物出现了', '#ffd34d');
          break;
        case 'waveStart':
          this.addLog(`第 ${(w.stats && w.stats.waves) || '?'} 波`, '#999');
          break;
        case 'mapLoaded':
          if (e.isHome) {
            this.banner(`回到： ${e.name}`, '#ffcf7a');
            this.addLog('庇护所：靠近设施按 F 互动 · 战斗之门 / T 开启战斗地图', '#c8a25a');
          } else {
            this.banner(`进入： ${e.name}`, '#c8a25a');
            this.addLog(`进入地图：${e.name}（第 ${w.map.tier} 层，等级 ${w.map.level}）`, '#c8a25a');
          }
          break;
        case 'noMana':
          this.addLog('法力不足', '#5a8bff');
          break;
        case 'ground':
          break;
        // ---- 技能成长相关事件（data-dev 的 app 动作会 push 这 4 个）----
        case 'skillRankUp':
          this.addLog(`✦ 天赋加点：${e.name || e.skillId || ''} · ${e.nodeName || ''} ${e.rank != null ? `(${e.rank}/${e.maxRank ?? '?'})` : ''}`.trim(), '#8be8ff');
          playSfx('rankUp');
          this.flashSide('skill');
          this.showSkillNotify();
          try { this.panelBar?.syncBadges({ level: this.game.world.player.level }); } catch { /* 纯装饰 */ }
          break;
        case 'skillRefine':
          this.banner(`精炼成功 · ${e.name || ''} Lv.${e.level ?? '?'}`, '#ffe9a8');
          this.addLog(`◆ 精炼：${e.name || ''} → 技能等级 ${e.level ?? '?'}${e.refine != null ? `（精炼 ${e.refine}）` : ''}`, '#ffd34d');
          playSfx('refine');
          this.flashSide('skill');
          this.showSkillNotify();
          try { this.panelBar?.syncBadges({ level: this.game.world.player.level }); } catch { /* 纯装饰 */ }
          break;
        case 'skillRespec':
          this.addLog(`↺ 重置天赋：${e.name || ''}${e.refunded != null ? ` 返还 ${e.refunded} 点` : ''}`, '#c9a8ff');
          playSfx('respec');
          this.flashSide('skill');
          this.showSkillNotify();
          try { this.panelBar?.syncBadges({ level: this.game.world.player.level }); } catch { /* 纯装饰 */ }
          break;
        case 'skillOrbGain':
          this.addLog(`◆ 获得技能精炼石 ×${e.amount ?? 1}${e.total != null ? `（共 ${e.total}）` : ''}`, '#ffd34d');
          playSfx('orb');
          this.showSkillNotify();
          try { this.panelBar?.syncBadges({ level: this.game.world.player.level }); } catch { /* 纯装饰 */ }
          break;
        default:
          break;
      }
    }
  }

  /** 刷新技能栏图标/键位名（技能实例的 name/icon 可能随精炼与重算变化） */
  refreshSkillBarIcons() {
    const bar = this.game.world.player.skillBar || [];
    this.el.slots.forEach((slot, i) => {
      const inst = bar[i];
      const glyph = slot.querySelector && slot.querySelector('.glyph');
      if (!glyph) return;
      if (inst) {
        glyph.textContent = inst.icon || '?';
        glyph.title = inst.name || '';
      } else if (i === 5) {
        glyph.textContent = this.game.world.player.type === 'mage' ? '✨' : '💨';
        glyph.title = this.game.world.player.type === 'mage' ? '闪现（空格）' : '翻滚（空格）';
      } else if (i === 6) {
        glyph.textContent = '🏕';
        glyph.title = '回城 / 开启战斗地图';
      }
    });
    /* TEMP-DISABLED */
  }

  /**
   * 职业相关的 HUD：头像字、角色名、法师状态面板、操作提示。
   * 在读档 / 新开局 / 切换职业后调用一次即可（每帧不写）。
   */
  refreshClassUI() {
    const p = this.game && this.game.world && this.game.world.player;
    if (!p) return;
    const mage = p.type === 'mage';
    if (this.el.avatar) this.el.avatar.textContent = mage ? '法' : '战';
    if (this.el.charName) this.el.charName.textContent = p.name || (mage ? '元素法师' : '流浪战士');
    if (this.el.mageStatus) this.el.mageStatus.classList.toggle('hidden', !mage);
    if (this.el.helpHint) {
      this.el.helpHint.innerHTML = mage
        ? '方向键 / WASD 移动 · <b>自动施法</b> · 左键锁定 · <b>T</b> 元素狂潮 · 空格闪现 · F 互动/拾取 · I 背包 · K/Tab 技能 · C 属性 · <b>ESC 暂停</b>'
        : '方向键 移动 · <b>Q W E R T</b> 技能 · 左键 普攻 · 空格 翻滚 · F 互动/拾取 · I 背包 · K/Tab 技能天赋 · P 天赋 · <b>C 属性</b> · <b>ESC 暂停</b> · M 静音';
    }
    this.refreshSkillBarIcons();
    this._updateMageHud();
  }

  /** 法师状态面板：共鸣 / 自动目标 / 预设 / 下一手 / 大招就绪 */
  _updateMageHud() {
    const p = this.game && this.game.world && this.game.world.player;
    const m = p && p.mage;
    const mage = !!(p && p.type === 'mage' && m);
    if (this.el.mageStatus) this.el.mageStatus.classList.toggle('hidden', !mage);
    // 先清掉法师专属角标（战士/切换职业时不能残留）
    for (const slot of this.el.slots || []) {
      if (slot && slot.classList) {
        slot.classList.remove('mage-next');
        slot.classList.remove('mage-ult-ready');
      }
    }
    if (!mage) return;
    const res = Math.max(0, Math.min(100, Number(m.resonance) || 0));
    if (this.el.mageResFill) this.el.mageResFill.style.width = pct(res / 100, 1);
    if (this.el.mageResText) {
      this.el.mageResText.textContent = m.ultTimer > 0
        ? `元素狂潮 ${Math.max(0, m.ultTimer).toFixed(1)}s`
        : `共鸣 ${Math.floor(res)} / 100`;
    }
    if (this.el.mageAutoState) {
      const target = m.targetId && Array.isArray(this.game.world.monsters)
        ? this.game.world.monsters.find((t) => t && !t.dead && t.id === m.targetId)
        : null;
      if (m.ultTimer > 0) this.el.mageAutoState.textContent = '元素狂潮 · 冷却减半 / 法力免费';
      else if (m.lockId && target) this.el.mageAutoState.textContent = `锁定：${target.displayName || target.name || '目标'}`;
      else if (target) this.el.mageAutoState.textContent = `自动目标：${target.displayName || target.name || '目标'}`;
      else this.el.mageAutoState.textContent = '等待目标';
    }
    if (this.el.magePresets && this.el.magePresets.querySelectorAll) {
      const buttons = this.el.magePresets.querySelectorAll('button[data-preset]');
      for (const btn of buttons) {
        if (!btn || !btn.classList) continue;
        const preset = (btn.getAttribute && btn.getAttribute('data-preset'))
          || (btn.dataset && btn.dataset.preset);
        btn.classList.toggle('active', preset === m.preset);
      }
    }
    // 下一手高亮
    if (m.nextSkillId && Array.isArray(p.skillBar)) {
      const idx = p.skillBar.findIndex((s) => s && s.id === m.nextSkillId);
      const slot = idx >= 0 && this.el.slots ? this.el.slots[idx] : null;
      if (slot && slot.classList) slot.classList.add('mage-next');
    }
    // 大招就绪：共鸣满 100 且当前不在元素狂潮
    const ultReady = res >= 100 && !(m.ultTimer > 0);
    if (ultReady && this.el.slots && this.el.slots[4] && this.el.slots[4].classList) {
      this.el.slots[4].classList.add('mage-ult-ready');
    }
  }

  /**
   * 技能栏角标 = 真实键位（Q W E R T / 空格 / 🏕）+ 悬停提示。
   * 【为什么要有】HUD 上的 `.key` 角标以前是**写死在 index.html 里的数字 1~5**，
   * 改键位后如果只改逻辑不改角标，玩家会按着"1"找技能（UI 与输入层漂移）。
   * 这里以 src/game/input.js 的 SKILL_KEYS 为唯一真相，实现放在 dom.js（见 syncSkillSlotLabels 注释）。
   */
  syncSkillSlotLabels() {
    const slots = this.el && Array.isArray(this.el.slots) ? this.el.slots : [];
    const bar = (this.game && this.game.world && this.game.world.player && this.game.world.player.skillBar) || [];
    syncSkillSlotLabels(slots, SKILL_KEYS, bar);
  }

  onMapChange() {
    this.refreshMap();
  }
  onInventoryChange() {
    if (this.modalOpen === 'inventory') openInventory(this);
    else refreshHomePanel(this);
  }
  onTalentsChange() {
    if (this.modalOpen === 'talents') openTalents(this);
  }
  onSkillsChange() {
    if (this.modalOpen === 'skills') openSkills(this);
  }
  onDeath() {
    this.showDeathScreen();
  }
  onRespawn() {
    this._hideDeathScreen?.();
    this.addLog('你重新站了起来', '#8be8ff');
  }
  toast(msg, color = '#ddd') {
    this.addLog(msg, color);
  }

  // ---- 帧更新（每帧调用，做数值绑定） ----
  update(dt) {
    const game = this.game;
    const p = game.world.player;
    const st = game.stats || {};
    // 生命 / 法力 = 技能栏两侧的圆形进度条：用 SVG 的 stroke-dashoffset 画弧
    // （圆环元素带 pathLength="100"，所以 dashoffset = 100 - 百分比×100）
    const hpRatio = Math.max(0, Math.min(1, p.hp / Math.max(1, p.maxHp)));
    const mpRatio = Math.max(0, Math.min(1, p.mp / Math.max(1, p.maxMp)));
    if (this.el.hp) this.el.hp.style.strokeDashoffset = (100 - hpRatio * 100).toFixed(2);
    if (this.el.mp) this.el.mp.style.strokeDashoffset = (100 - mpRatio * 100).toFixed(2);
    const xp = p.xp || 0, xpMax = st.xp?.xpMax || 1;
    this.el.xp.style.width = pct(Math.min(1, xp / xpMax), 1);
    this.el.tHp.textContent = `${Math.round(p.hp)}/${Math.round(p.maxHp)}`;
    this.el.tMp.textContent = `${Math.round(p.mp)}/${Math.round(p.maxMp)}`;
    this.el.tXp.textContent = `${pct(Math.min(1, xp / xpMax), 0)}`;
    this.el.level.textContent = 'Lv.' + p.level;
    this.el.kills.textContent = game.world.stats?.kills ?? 0;
    this.el.waves.textContent = game.world.stats?.waves ?? 0;
    // 低血闪烁
    this.hud.classList.toggle('lowlife', p.hp / p.maxHp < 0.3);

    // 技能冷却（核心以 player.cooldowns[id] 为准；总时长取核心的等级/CDR 感知值）
    for (let i = 0; i < this.el.slots.length; i++) {
      const slot = this.el.slots[i];
      const inst = p.skillBar?.[i];
      const id = inst ? inst.id : i === 5 ? 'dash' : null;
      const cd = id ? (p.cooldowns?.[id] || 0) : 0;
      const def = id ? (skillsMod.SKILLS && skillsMod.SKILLS[id]) : null;
      const total = this.skillCooldownTotal(p, id, def);
      slot.classList.toggle('ready', cd <= 0);
      slot.classList.toggle('nomana', !!def && (def.manaCost || 0) > p.mp);
      const cdEl = slot.querySelector('.cd');
      const txt = slot.querySelector('.cdtxt');
      if (cdEl) {
        cdEl.style.height = cd > 0 ? pct(Math.min(1, cd / Math.max(0.001, total)), 1) : '0%';
        if (txt) txt.textContent = cd > 0 ? (cd < 1 ? cd.toFixed(1) : Math.ceil(cd)) : '';
      }
    }
    // 法师：共鸣 / 自动目标 / 预设 / 下一手 / 大招就绪（战士时自行隐藏）
    this._updateMageHud();

    // 技能栏光点角标：每次 update 都算「现在能不能加点/精炼」。
    // 【为什么不再按时间节流】这只是一次「读 player.skillBar + 几个缓存字段」的判定（没有遍历全技能树、
    // 没有精炼成本计算），开销可以忽略；而节流会带来两类问题：
    //   ① 花掉最后一点技能点后角标要等 0.25 秒才消失，看起来像"卡住了"；
    //   ② DOM 写入本身由 updateSkillNotify 里的签名比较兜着，状态没变时不会碰 DOM。
    this.updateSkillNotify();

    // Buff / Debuff 图标条
    const buffBar = document.getElementById('buff-bar');
    if (buffBar) {
      const sig = (p.buffs || []).map((b) => b.id + (b.remaining != null ? Math.ceil(b.remaining) : '')).join('|');
      if (sig !== this._buffSig) {
        this._buffSig = sig;
        buffBar.innerHTML = (p.buffs || [])
          .map((b) => `<div class="buff ${b.type === 'debuff' ? 'debuff' : ''}" title="${escapeHTML(b.name + '：' + (b.text || '') + (b.remaining != null ? '（' + b.remaining.toFixed(1) + 's）' : ''))}"><span>${escapeHTML((b.name || b.id || '').slice(0, 4))}</span>${b.remaining != null ? '<i style="width:' + pct(Math.max(0, Math.min(1, b.remaining / (b.dur || b.remaining || 1))), 0) + '"></i>' : ''}</div>`)
          .join('');
      }
    }

    // 连击计数器淡出
    this.lastKillCombo.timer -= dt;
    if (this.lastKillCombo.timer <= 0 && !this.el.combo.classList.contains('hidden')) {
      this.el.combo.classList.add('hidden');
      this.lastKillCombo.count = 0;
    }

    // banner 淡出
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.el.banner.classList.add('hidden');
    }

    // 日志行过期
    this._trimLog();

    // 面板统计（每 0.25 秒刷新即可）
    this._panelT = (this._panelT || 0) + dt;
    if (this._panelT > 0.25 && this.el.stats) {
      this._panelT = 0;
      this.renderStatsPanel();
    }

    // 底部按钮列角标：等级一变立刻刷；否则 ≤1Hz 节流（点数只可能被玩家操作/事件改变，
    // PanelBar.syncBadges 内部还有数值签名短路，没变化时一个 DOM 都不碰 —— 绝不每帧写 DOM）。
    this._panelBarT = (this._panelBarT || 0) + dt;
    const lvl = (p.level | 0) || 1;
    if (lvl !== this._panelLevel || this._panelBarT >= 1) {
      this._panelBarT = 0;
      this._panelLevel = lvl;
      try { (this.panelBar || this._ensurePanelBar())?.syncBadges({ level: lvl }); } catch { /* 纯装饰 */ }
    }

    // 暂停：暂停菜单可见时同步摘要/按钮状态（签名短路；不暂停时是空操作）
    if (this.isPaused()) this._updatePauseMenu();
  }

  // ---- 技能冷却总量（等级/CDR 感知） ----
  /**
   * 技能冷却总时长。核心导出的名字在开发过程中变过一次（skillCooldownTotal → skillCooldown），
   * 这里两个都认；都缺席时退回技能定义里的基础 cooldown（旧的 UI 行为）。
   * @param {Object} player @param {string|null} id @param {Object|null} def
   * @returns {number}
   */
  skillCooldownTotal(player, id, def) {
    if (!id) return 1;
    for (const name of ['skillCooldownTotal', 'skillCooldown']) {
      const fn = skillsMod[name];
      if (typeof fn !== 'function') continue;
      try {
        const v = fn(player, id);
        if (Number.isFinite(v) && v > 0) return v;
      } catch { /* 换下一个候选 */ }
    }
    if (def && Number.isFinite(def.cooldown) && def.cooldown > 0) return def.cooldown;
    return id === 'dash' ? 1.2 : 1;
  }

  // ---- 技能提醒角标 ----
  /**
   * 统计「现在能做什么」：
   *   points    —— 未分配的技能点（app.skillPointsTotal 可能返回数字或 {avail}，都认）
   *   refineable —— 可精炼的技能数（canRefineSkill 优先，缺席时本地判断）
   * 契约 §5 要求：**有未分配技能点 或 任一技能可精炼** 时技能栏出现光点并带数字。
   * @returns {{points:number, refineable:number}}
   */
  skillNotifyState() {
    const game = this.game;
    const inv = game.inv || {};
    const p = game.world.player || {};

    // ---- 1) 未分配技能点 ----
    let points = NaN;
    const totalFn = game.actions && game.actions.skillPointsTotal;
    if (typeof totalFn === 'function') {
      try {
        const r = totalFn();
        if (Number.isFinite(r)) points = r;
        else if (r && typeof r === 'object' && Number.isFinite(r.avail)) points = r.avail;
      } catch { /* 走兜底 */ }
    }
    if (!Number.isFinite(points)) {
      // 兜底：技能点曲线 = 每级 +1（与 app.skillPointsForLevel 一致：Lv.1=1 / Lv.10=10 / Lv.14=14），
      // 再减去已花点数。
      // 【公式必须跟 data 层同步】否则 app 动作一失败就会少显示点数。
      const lvl = Math.max(1, Math.floor(Number(p.level) || 1));
      let fromLevel = lvl;
      const appForLevel = this.game && this.game.__skillPointsForLevel; // 由 main.js 注入（可选）
      if (typeof appForLevel === 'function') {
        try {
          const r = appForLevel(lvl);
          if (Number.isFinite(r)) fromLevel = r;
        } catch { /* 用本地公式 */ }
      }
      const stored = inv && inv.skillPoints && Number.isFinite(inv.skillPoints.total) ? inv.skillPoints.total : 0;
      const total = Math.max(fromLevel, stored);
      let spent = 0;
      for (const k in inv.skillRanks || {}) {
        const n = Number(inv.skillRanks[k]);
        if (Number.isFinite(n) && n > 0) spent += n;
      }
      points = Math.max(0, total - spent);
    }
    points = Math.max(0, Math.floor(points));

    // ---- 2) 可精炼技能数 ----
    const bar = Array.isArray(p.skillBar) ? p.skillBar : [];
    const ids = [];
    for (const inst of bar) if (inst && inst.id && inst.id !== 'dash' && !ids.includes(inst.id)) ids.push(inst.id);
    let refineable = 0;
    if (ids.length) {
      try {
        // 面板里的 refineStatus 已经封装了 canRefineSkill + 本地兜底（等级上限 / 石头够不够）
        for (const sid of ids) if (refineStatus(this, sid).ok) refineable++;
      } catch { refineable = 0; }
    }
    return { points, refineable };
  }

  /**
   * 更新技能栏光点角标（每帧调用；内部做「廉价签名」短路，状态没变就不碰 DOM）。
   * 显示的「数字」= 可分配技能点；没有点但能精炼时显示可精炼技能数（同一个角标复用两种提醒）。
   *
   * 【性能取舍】精炼判定要查背包余额 / 技能等级上限，虽然便宜但没必要每帧做：
   * 先比一次几乎零成本的签名（等级 + 技能点 + 精炼石 + 精炼等级表 + 档位表），
   * 变了才算完整的 skillNotifyState()。
   */
  updateSkillNotify() {
    if (!this.el.skillNotify) this._ensureSkillNotify();
    const node = this.el.skillNotify;
    if (!node) return;
    const cheap = this._skillNotifyCheapSig();
    if (cheap !== this._skillNotifyCheap) this._skillNotifyCheap = cheap;
    if (cheap !== this._skillNotifySig) {
      const { points, refineable } = this.skillNotifyState();
      this._renderSkillNotify(node, points, refineable);
    }
  }

  /**
   * 廉价状态签名：数值一变就一定重算（任何加点点/精炼/掉落都会改变其中一项）。
   * @returns {string}
   */
  _skillNotifyCheapSig() {
    const game = this.game;
    const inv = game.inv || {};
    const p = game.world.player || {};
    const ranks = inv.skillRanks || {};
    const refine = inv.skillRefine || {};
    return [
      p.level | 0,
      Number(inv.skillOrbs) || 0,
      (inv.skillPoints && inv.skillPoints.avail) | 0,
      (inv.skillPoints && inv.skillPoints.total) | 0,
      Object.keys(ranks).length,
      Object.values(ranks).reduce((a, v) => a + (Number(v) || 0), 0),
      Object.values(refine).reduce((a, v) => a + (Number(v) || 0), 0),
    ].join(':');
  }

  /**
   * 真正写 DOM：只有签名变化时才走到这里。
   * @param {Object} node #skill-notify
   * @param {number} points 可分配技能点
   * @param {number} refineable 可精炼技能数
   */
  _renderSkillNotify(node, points, refineable) {
    const show = points > 0 || refineable > 0;
    const sig = `${points}|${refineable}|${show}`;
    if (sig === this._skillNotifySig) return;
    this._skillNotifySig = sig;
    // 先落类名再 toggle：桩环境的 classList 与 className 是两套存储，两边都写最稳
    node.className = 'skill-notify' + (points > 0 ? ' points' : refineable > 0 ? ' refine' : '');
    node.classList.toggle('hidden', !show);
    node.classList.toggle('points', points > 0);
    node.classList.toggle('refine', points <= 0 && refineable > 0);
    const num = node.querySelector('.sn-num');
    const n = points > 0 ? points : refineable;
    if (num) num.textContent = show && n > 0 ? String(n > 99 ? '99+' : n) : '';
    // 桩/极简 DOM 里 querySelector 的子树查找可能不可靠，同时兜底写一份纯文本，
    // 保证 `.sn-num` 或节点的 textContent 至少有一处能读到数字。
    if (!num) node.textContent = show && n > 0 ? String(n) : '';
    node.title = points > 0
      ? `有 ${points} 点技能点可分配${refineable ? ` · ${refineable} 个技能可精炼` : ''}（点此或按 K/Tab 打开）`
      : `${refineable} 个技能可以精炼（点此或按 K/Tab 打开）`;
  }

  /** 短暂放大角标，提示「刚刚有新东西」 */
  showSkillNotify() {
    this.updateSkillNotify();
    const node = this.el.skillNotify;
    if (!node) return;
    node.classList.remove('pop');
    void node.offsetWidth;
    node.classList.add('pop');
  }

  renderStatsPanel() {
    const s = this.game.stats || {};
    const rows = [
      ['伤害', s.dmg || '0-0', 'gold'],
      ['攻速', (s.aps || 0).toFixed(2), '#ddd'],
      ['暴击', `${pct(s.crit || 0, 1)} ×${(s.critMulti || 1.5).toFixed(1)}`, '#ddd'],
      ['护甲', s.armor || 0, '#ddd'],
      ['闪避', pct(s.evasion || 0, 0), '#ddd'],
      ['移速', (s.moveSpeed || 0).toFixed(1), '#ddd'],
      ['火/冰/雷抗', `${pct(s.fire || 0, 0)} / ${pct(s.cold || 0, 0)} / ${pct(s.lightning || 0, 0)}`, '#ddd'],
      ['范围加成', pct(s.aoe || 0, 0), '#ddd'],
    ];
    // 战斗数值写进 #stats-rows；角色等级/经验在 #char-summary 里常驻，不能被覆盖
    const target = this.el.statsRows || this.el.stats;
    if (!target) return;
    target.innerHTML = rows.map(([k, v, c]) => `<div class="st-row"><span>${k}</span><b style="color:${c}">${escapeHTML(String(v))}</b></div>`).join('');
  }

  refreshMap() {
    const m = this.game.world.map;
    if (!m) return;
    if (m.isHome) {
      this.el.mapName.textContent = `${m.name} · 安全区`;
      this.el.mapMods.innerHTML = '<span class="mapmod">仓库 · 商人 · 赌徒 · 战斗之门</span>';
      return;
    }
    this.el.mapName.textContent = `${m.name} · 第 ${m.tier} 层`;
    this.el.mapMods.innerHTML = (m.mods || []).map((mod) => `<span class="mapmod">${escapeHTML(mod.text)}</span>`).join('');
  }

  setFps(fps) {
    if (!this.el.fps) {
      this.el.fps = el('div', { id: 'fps', class: 'fps' });
      document.getElementById('hud')?.appendChild(this.el.fps);
    }
    this.el.fps.textContent = fps + ' FPS';
    this.el.fps.style.color = fps < 40 ? '#ff6a5a' : '#8fbf8f';
  }

  // ---- 日志 / 提示 ----
  addLog(msg, color = '#ccc') {
    const line = el('div', { class: 'log-line', html: `<span style="color:${color}">${escapeHTML(msg)}</span>` });
    if (this.el.log) this.el.log.appendChild(line);
    this.logLines.push({ node: line, t: performance.now() });
    while (this.logLines.length > 7) {
      const old = this.logLines.shift();
      old.node.remove();
    }
  }

  /** 日志中最近 n 条文本（供测试/调试） */
  logText(n = 7) {
    return this.logLines.slice(-n).map((l) => (l.node._html || '').replace(/<[^>]*>/g, ''));
  }

  lootToast(item) {
    if (!item) return;
    const color = rarityColor(item.rarity);
    const icon = item.icon || '◆';
    // 记录掉落（用于汇报与去重），并把 HTML 累加到掉落栏
    this._lootItems = this._lootItems || [];
    this._lootItems.push({ name: item.name, rarity: item.rarity, icon: item.icon, t: performance.now() });
    if (this._lootItems.length > 40) this._lootItems.shift();
    const list = this._lootItems.slice(-6);
    if (this.el.loot) {
      this.el.loot.innerHTML = list
        .map((it) => `<span class="loot-item"><i style="color:${rarityColor(it.rarity)}">${escapeHTML(it.icon || '◆')}</i> <span style="color:${rarityColor(it.rarity)}">${escapeHTML(it.name)}</span></span>`)
        .join('');
    }
    // 黄/橙装现在也会自动拾取：掉落时提示玩家「走近即可自动入包」，不必再找按键
    if (item.rarity === 'rare' || item.rarity === 'unique' || item.rarity === 'legendary') {
      const label = item.rarity === 'rare' ? '稀有' : '传奇';
      this.addLog(`✦ ${label}掉落：${item.name} · 走近自动拾取`, color);
    }
  }

  _trimLog() {
    const now = performance.now();
    while (this.logLines.length && now - this.logLines[0].t > 6000) {
      this.logLines.shift().node.remove();
    }
  }

  _bumpCombo() {
    this.lastKillCombo.count++;
    this.lastKillCombo.timer = 1.6;
    if (this.lastKillCombo.count >= 3) {
      this.el.combo.classList.remove('hidden');
      this.el.combo.innerHTML = `<b>${this.lastKillCombo.count}</b><span>连杀</span>`;
      this.el.combo.classList.remove('pop');
      void this.el.combo.offsetWidth;
      this.el.combo.classList.add('pop');
    }
  }

  banner(text, color = '#ffd34d') {
    this.el.banner.classList.remove('hidden');
    this.el.banner.querySelector('.banner-text').textContent = text;
    this.el.banner.querySelector('.banner-text').style.color = color;
    this.el.banner.classList.remove('show');
    void this.el.banner.offsetWidth;
    this.el.banner.classList.add('show');
    this.bannerTimer = 2.2;
  }

  flashSide(kind) {
    document.body.classList.remove('flash-' + kind);
    void document.body.offsetWidth;
    document.body.classList.add('flash-' + kind);
    setTimeout(() => document.body.classList.remove('flash-' + kind), 600);
  }

  // ---- 悬停提示 ----
  showTooltip(html, x, y) {
    this.el.tooltip.innerHTML = html;
    this.el.tooltip.classList.remove('hidden');
    const w = this.el.tooltip.offsetWidth, h = this.el.tooltip.offsetHeight;
    let px = x + 16, py = y + 16;
    if (px + w > window.innerWidth - 8) px = x - w - 16;
    if (py + h > window.innerHeight - 8) py = window.innerHeight - h - 8;
    this.el.tooltip.style.left = px + 'px';
    this.el.tooltip.style.top = py + 'px';
  }
  hideTooltip() {
    this.el.tooltip.classList.add('hidden');
  }
  /**
   * 技能栏悬停提示：名称 / 等级 / 精炼 / 关键数值 / 是否可升级。
   * 数值优先取核心 skillDisplayInfo（已套用天赋与等级），缺席时退回技能定义。
   * @param {Element} slot
   */
  _showSkillTooltip(slot) {
    const idx = Number(slot.dataset ? slot.dataset.idx : slot.getAttribute?.('data-idx')) || 0;
    const p = this.game.world.player;
    const inst = p.skillBar?.[idx];
    if (!inst || !inst.id) return;
    const id = inst.id;
    const names = skillsMod.SKILL_NAMES || {};
    const def = (skillsMod.SKILLS && skillsMod.SKILLS[id]) || {};
    const infoFn = skillsMod.skillDisplayInfo;
    let info = null;
    if (typeof infoFn === 'function') {
      try {
        info = infoFn(p, id) || null;
      } catch { info = null; }
    }
    const name = (info && info.name) || names[id] || inst.name || id;
    const desc = (info && info.desc) || inst.desc || def.desc || '';
    const level = Math.max(1, Number((info && info.level) || inst.level) || 1);
    const cap = Number((info && info.levelCap) || 5);
    const refine = Number((info && info.refine) ?? (this.game.inv?.skillRefine?.[id]) ?? (inst && inst.refine) ?? 0);
    const refineMax = Number((skillsMod.REFINE_MAX ?? 4));

    // ---- 关键数值：伤害 / 冷却 / 范围 / 法力 ----
    const rows = [];
    const cdTotal = this.skillCooldownTotal(p, id, def);
    if (Number.isFinite(info?.damagePct)) rows.push(['伤害', Math.round(info.damagePct * 100) + '%']);
    else if (Number.isFinite(def.damagePct)) rows.push(['伤害', Math.round(def.damagePct * 100) + '%']);
    if (Number.isFinite(info?.manaCost)) rows.push(['法力', String(Math.round(info.manaCost))]);
    else if (Number.isFinite(def.manaCost)) rows.push(['法力', String(Math.round(def.manaCost))]);
    rows.push(['冷却', (cdTotal < 10 ? cdTotal.toFixed(1) : Math.round(cdTotal)) + 's']);
    if (Number.isFinite(info?.radius)) rows.push(['范围', info.radius.toFixed(1)]);
    else if (Number.isFinite(def.radius)) rows.push(['范围', def.radius.toFixed(1)]);
    if (Number.isFinite(info?.stunDur)) rows.push(['眩晕', info.stunDur.toFixed(2) + 's']);

    // ---- 精炼格 ----
    let pips = '';
    for (let i = 0; i < refineMax; i++) pips += `<i class="tip-pip${i < refine ? ' on' : ''}"></i>`;

    // ---- 是否可升级（技能点 / 精炼石） ----
    const st = this.skillNotifyState();
    const rs = refineStatus(this, id);
    const hints = [];
    if (st.points > 0) hints.push(`<span class="tip-ok">✦ 有 ${st.points} 点技能点可分配</span>`);
    if (rs.ok) hints.push(`<span class="tip-ok">◆ 可精炼（${rs.cost} 颗精炼石）</span>`);
    if (!hints.length && level < cap) hints.push(`<span class="tip-dim">精炼石 ${rs.have} · 还需 ${rs.cost ?? '?'} 颗可精炼</span>`);

    const html = `<div class="skill-tip skill-tip-rich">
      <h3>${escapeHTML(name)}</h3>
      <div class="tip-sub">Lv.<b>${level}</b>/${cap} · 精炼 <span class="tip-pips">${pips}</span>${refine >= refineMax ? ' <span class="tip-ok">已满</span>' : ''}</div>
      <p>${escapeHTML(desc)}</p>
      ${rows.length ? `<div class="tip-stats">${rows.map(([k, v]) => `<div><span>${k}</span><b>${escapeHTML(v)}</b></div>`).join('')}</div>` : ''}
      ${hints.join('')}
      <div class="tip-foot">K / Tab 打开技能天赋</div>
    </div>`;
    const r = slot.getBoundingClientRect();
    this.showTooltip(html, r.left, r.top - 10);
  }

  // ---- 弹窗 ----
  openModal(kind) {
    this.modalOpen = kind;
    this.el.modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    this._syncPanelBar();
    // 暂停中打开面板：暂停卡片让位（面板 z-index 70 压在覆盖层 65 之上），暂停状态保持
    this._pauseOnModalOpened();
  }
  closeModals() {
    // 橙色装备的出售确认属于背包面板的临时状态：关面板就取消，避免下次打开又弹出来
    resetSellConfirm();
    this.modalOpen = null;
    this.el.modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
    this.hideTooltip();
    this._syncPanelBar();
    // 暂停中收起面板：暂停菜单重新露出来（仍然暂停，直到 ESC / 「继续游戏」）
    if (this.isPaused()) this._showPauseChrome();
  }

  /**
   * 统一面板入口（按钮列 / 快捷键 / 调试脚本都走这里）。
   * kind: 'stats' | 'talents' | 'skills' | 'equipment' | 'inventory'
   *   - 'equipment' / 'inventory' → 背包·装备面板（同一个面板，两种叫法）
   *   - 'talents' → 天赋树；'skills' → 技能天赋；'stats' → 属性面板（stats-ui.js）
   * 目前已经在这个面板里 → 关闭；否则切换过去（打开另一个面板时先关掉当前的）。
   * @param {string} kind
   * @returns {string|null} 切换后的 this.modalOpen
   */
  openPanel(kind) {
    let k = String(kind || '').toLowerCase();
    if (k === 'inventory' || k === 'bag' || k === 'equip') k = 'equipment';
    const act = k === 'stats' || k === 'talents' || k === 'skills' || k === 'equipment' ? k : null;
    if (act) {
      // 按钮列高亮用的 key：'equipment' 面板的 modalOpen 是 'inventory'，两者互认
      this._lastPanelKind = act;
    }
    switch (act) {
      case 'stats':
        this.toggleStats();
        break;
      case 'talents':
        this.toggleTalents();
        break;
      case 'skills':
        this.toggleSkills();
        break;
      case 'equipment':
      case 'inventory':
        this.toggleInventory();
        break;
      default:
        this.addLog(`[面板] 未知面板：${kind}`, '#ff6a5a');
        return this.modalOpen;
    }
    this._syncPanelBar();
    return this.modalOpen;
  }

  /**
   * 按钮列用的「当前面板」：modalOpen 为 'inventory' 时对应 data-act="equipment" 按钮。
   * @returns {string|null} 'stats'|'talents'|'skills'|'equipment'|null
   */
  activePanel() {
    const m = this.modalOpen;
    if (!m || m.startsWith('home-')) return null;
    return m === 'inventory' ? 'equipment' : m;
  }

  /**
   * 属性面板（C）。实现由 stats-ui.js 的 openStats(ui) 提供（并行开发中）。
   * 模块或导出缺席时只记日志 + 屏幕提示并收起遮罩，绝不抛异常。
   * @returns {string|null}
   */
  toggleStats() {
    if (this.modalOpen === 'stats') return this.closeModals();
    this.openModal('stats');
    this.el.modalTitle.textContent = '属性 · 角色面板';
    this.el.modalBody.innerHTML = '';
    this.el.modalFoot.innerHTML = '';
    const fn = statsMod && statsMod.openStats;
    if (typeof fn === 'function') {
      try {
        fn(this);
      } catch (e) {
        console.warn('[ui] 属性面板渲染失败', e);
        this.el.modalBody.innerHTML = '<div class="panel-missing">属性面板渲染出错（详见控制台）</div>';
        this.addLog('[属性] 面板渲染出错', '#ff6a5a');
      }
    } else {
      console.warn('[ui] 属性面板模块 stats-ui.js 未就绪（缺少 openStats）');
      this.el.modalBody.innerHTML = '<div class="panel-missing">属性面板尚未就绪</div>';
      this.addLog('[属性] 属性面板模块尚未就绪', '#ff6a5a');
    }
    this._syncPanelBar();
    return this.modalOpen;
  }

  toggleInventory() {
    if (this.modalOpen === 'inventory') return this.closeModals();
    this.openModal('inventory');
    openInventory(this);
    this._syncPanelBar();
  }
  /**
   * 庇护所设施面板（仓库 / 商人 / 赌徒）。
   * modalOpen 使用 'home-stash' / 'home-merchant' / 'home-gambler'，
   * 与底部按钮列（stats/talents/skills/equipment）互不干扰。
   * @param {'stash'|'merchant'|'gambler'} kind
   */
  showHomePanel(kind) {
    const key = 'home-' + kind;
    if (this.modalOpen === key) return this.closeModals();
    this.openModal(key);
    openHomePanel(this, kind);
    this._syncPanelBar();
    return this.modalOpen;
  }
  toggleTalents() {
    if (this.modalOpen === 'talents') return this.closeModals();
    this.openModal('talents');
    openTalents(this);
    this._syncPanelBar();
  }
  toggleSkills() {
    if (this.modalOpen === 'skills') return this.closeModals();
    this.openModal('skills');
    openSkills(this);
    this._syncPanelBar();
  }

  // ---- 死亡 ----
  showDeathScreen() {
    let node = document.getElementById('death-screen');
    if (!node) {
      node = el('div', { id: 'death-screen' });
      node.appendChild(el('h1', { text: '你倒下了' }));
      node.appendChild(el('p', { text: '亡魂在黑暗中低语…' }));
      const btn = el('button', { class: 'btn-primary', text: '在营地复活' });
      btn.addEventListener('click', () => {
        this.game.actions?.revive?.();
        node.classList.remove('show');
      });
      node.appendChild(btn);
      (document.getElementById('app') || document.body).appendChild(node);
    }
    node.classList.add('show');
    this.deathShown = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 暂停系统（ESC）
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 【唯一状态机】暂停状态只由这里维护（game.paused + this.paused 双写），
  // 外部（main.js / input / 面板按钮 / 测试）只需要调用：
  //   ui.handleEscape()          —— ESC 语义（POE 习惯）：有面板 → 关面板；否则开/关暂停菜单
  //   ui.togglePause(force?)     —— 直接开/关暂停；force 省略时取反
  //   ui.isPaused()              —— 只读判断
  //   ui.pauseMenu               —— PauseMenu 实例（惰性创建，DOM 见 src/ui/pause.js）
  //
  // 【为什么显示/隐藏与暂停状态分在两个方法里】
  //   暂停菜单里点「属性/天赋/技能/装备」时，面板要压在暂停覆盖层之上（#modal z-index 70 > 覆盖层 65），
  //   此时暂停菜单要「让位」隐藏，但 game.paused 必须保持 true——所以 _showPauseChrome()/_hidePauseChrome()
  //   只动 DOM 与画面滤镜，不碰 paused 字段。

  /** 只读：当前是否暂停 */
  isPaused() {
    if (this.paused) return true;
    return !!(this.game && (this.game.paused || (this.game.world && this.game.world.paused)));
  }

  /** 只读：暂停菜单是否处于「显示」状态（可能因面板打开而临时让位） */
  isPauseMenuOpen() {
    return !!(this.pauseMenu && this.pauseMenu.isOpen && this.pauseMenu.isOpen && this._pauseShown);
  }

  /**
   * 暂停被什么把持：'menu'（暂停菜单）| 'panel'（暂停菜单里打开的面板）| null
   */
  get pauseReason() {
    if (!this.isPaused()) return null;
    return this.modalOpen ? 'panel' : 'menu';
  }

  /**
   * 惰性创建 PauseMenu（构造失败也不拖垮 UI：退化成只有 paused 状态）。
   * 【注意】这里**不要**调 close()：close 会为了隐藏而提前建 DOM，
   * 惰性创建的意义就是「第一次暂停前一个节点都不建」。
   * @returns {PauseMenu|null}
   */
  _ensurePauseMenu() {
    if (this.pauseMenu) return this.pauseMenu;
    try {
      this.pauseMenu = new PauseMenu(this);
    } catch (e) {
      this.pauseMenu = null;
      if (typeof console !== 'undefined' && console.warn) console.warn('[ui] 暂停菜单初始化失败', e);
    }
    return this.pauseMenu;
  }

  /**
   * ESC 唯一入口（main.js 的键盘路由、暂停菜单、测试都调它）。
   * @param {{shiftKey?:boolean}} [e] 可选的事件对象（暂未使用，留给扩展）
   * @returns {'panel'|'paused'|'resumed'} 本次动作
   */
  handleEscape(e) {
    // ① 有面板打开 → 只关面板（如果暂停中，关掉面板后把暂停菜单重新露出来）
    if (this.modalOpen) {
      const wasPaused = this.isPaused();
      this.closeModals();
      if (wasPaused) this._showPauseChrome(); // 面板收起后回到暂停菜单（仍然暂停）
      return 'panel';
    }
    // ② 死亡界面/开始界面：ESC 不做任何事（避免"暂停中又弹死亡"这类怪状态）
    if (this._pauseBlockedByOverlay()) return 'none';
    // ③ 已暂停 → 继续游戏（面板若开着保持打开，这是现有行为）
    if (this.isPaused()) {
      this.togglePause(false);
      return 'resumed';
    }
    // ④ 都没开 → 打开暂停菜单并冻结世界
    this.togglePause(true);
    return 'paused';
  }

  /** 死亡屏/开始界面显示时不允许暂停（纯装饰性判断，取不到就当作允许） */
  _pauseBlockedByOverlay() {
    try {
      // 判定必须**宽松**：只有拿得到节点、并且明确「可见」时才拦。
      // （DOM 桩里 classList 可能是空实现 / 只记录不生效，不能因为它"不含 hidden"就当成开始界面还在。）
      const death = document.getElementById('death-screen');
      if (death && death.classList && death.classList.contains('show')) return true;
      const start = document.getElementById('start-screen');
      if (start && start.style && start.style.display === 'none') return false; // 明确已隐藏
      // 开始界面：HUD 已经显示（startGame 里 #hud 去掉 hidden）时一定已经在游戏里了
      const hud = document.getElementById('hud');
      if (hud && hud.classList && !hud.classList.contains('hidden')) return false;
      return false;
    } catch { /* 桩环境 */ }
    return false;
  }

  /**
   * 开/关暂停（幂等）。这是唯一写 game.paused 的地方。
   * @param {boolean} [on] 省略 = 取反
   * @param {string} [reason] 'menu' | 'quit' | 'panel'（记录在 game.pauseReason，便于排查）
   * @returns {boolean} 现在是否暂停
   */
  togglePause(on, reason) {
    const want = on === undefined ? !this.isPaused() : !!on;
    const wasPaused = this.isPaused();
    this.paused = want;
    if (this.game) {
      this.game.paused = want;
      this.game.pauseReason = want ? (reason || 'menu') : null;
    }
    if (want) {
      if (!wasPaused) this.addLog('⏸ 已暂停 · ESC 继续', '#c8a25a');
      this._showPauseChrome();
    } else {
      this._hidePauseChrome();
      if (wasPaused) this.addLog('▶ 继续冒险', '#8be8ff');
      // 恢复时清掉输入残留：否则暂停期间按住的键会在恢复后"凭空砍一刀"
      try { this.game && this.game.actions && this.game.actions.onResume && this.game.actions.onResume(); } catch { /* 可选钩子 */ }
    }
    return want;
  }

  /**
   * 显示暂停外观：开启暂停菜单 + 画面去饱和。
   * 面板打开时只做去饱和，暂停菜单让位（避免两层遮罩叠在一起把面板糊暗）。
   */
  _showPauseChrome() {
    const menu = this._ensurePauseMenu();
    this._setPauseVisual(true);
    if (!menu) { this._pauseShown = false; return; }
    // 暂停菜单只反映「是否显示」（给 main.js 的输入守卫 / 调试脚本读）；
    // game.paused 才是真正的冻结开关，两者互不影响。
    menu.paused = true;
    if (this.modalOpen) {
      // 面板在暂停中打开：隐藏暂停卡片，只保留去饱和（面板在 #modal 里，z-index 更高）
      this._pauseShown = false;
      menu.close();
      return;
    }
    this._pauseShown = true;
    try { menu.render(true); menu.open(); } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[ui] 暂停菜单显示失败', e);
    }
  }

  /** 收起暂停外观（画面滤镜还原、暂停菜单隐藏）；不改 paused 字段 */
  _hidePauseChrome() {
    this._pauseShown = false;
    if (this.pauseMenu) {
      try { this.pauseMenu.paused = false; this.pauseMenu.close(); } catch { /* 纯装饰 */ }
    }
    this._setPauseVisual(false);
  }

  /**
   * 画面效果：canvas 轻微去饱和 + 暗化。用 class 切换（CSS 里有 transition），不会闪烁。
   * 桩环境（没有 classList / 没有 canvas）时静默降级。
   * @param {boolean} on
   */
  _setPauseVisual(on) {
    try {
      const c = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('game') : null;
      if (c && c.classList) c.classList.toggle('paused-canvas', !!on);
    } catch { /* 桩 */ }
    try {
      if (this.el && this.el.app === undefined && typeof document !== 'undefined' && document.getElementById) {
        this.el.app = document.getElementById('app');
      }
      if (this.el && this.el.app && this.el.app.classList) this.el.app.classList.toggle('paused', !!on);
    } catch { /* 桩 */ }
  }

  /**
   * 面板打开时的暂停联动（由 openModal 调用）：暂停中则不解除暂停，
   * 只让暂停卡片隐藏、面板顶上来；没暂停时什么也不做。
   */
  _pauseOnModalOpened() {
    if (!this.isPaused()) return;
    this._pauseShown = false;
    if (this.pauseMenu) {
      try { this.pauseMenu.close(); } catch { /* 纯装饰 */ }
    }
  }

  /**
   * 帧刷新：暂停中若暂停菜单可见，同步摘要/按钮状态（内部有签名短路，不写 DOM 时几乎零成本）。
   * 由 GameUI.update() 调用；不在暂停中则什么都不做。
   */
  _updatePauseMenu() {
    if (!this._pauseShown || !this.pauseMenu) return;
    try { this.pauseMenu.render(); } catch { /* 纯装饰 */ }
  }

  /**
   * 暂停时的键盘处理（由 main.js 的 keydown 捕获层转发）。
   *  - ESC：交给 handleEscape()（状态机）
   *  - 暂停菜单可见且没有面板：↑↓←→/Tab 移焦点，Enter/空格触发当前按钮
   *  - 暂停中面板开着：面板自己在处理键盘，这里只吞掉会让角色移动的游戏键
   * @param {KeyboardEvent} e
   * @returns {boolean} 是否已消费
   */
  handlePauseKey(e) {
    if (!e || !this.isPaused()) return false;
    // 同时看 key 与 code：控制台/自动化脚本常常只给 key（'2'），真实浏览器两者都有
    const k = String(e.key || '');
    const code = String(e.code == null ? '' : e.code);
    const hit = (...names) => names.some((n) => k === n || code === n);
    if (hit('Escape', 'Esc')) {
      this.handleEscape(e);
      return true;
    }
    // 面板打开时暂停菜单被挡在后面：这时任何键都交给面板处理（面板自己也会拦键盘），
    // 不能再让暂停菜单抢焦点/触发按钮，否则"在属性面板里按 Enter"会莫名打开另一个面板。
    // 注意顺序：这个判断必须在「ESC」之后、「交给暂停菜单」之前。
    if (this.modalOpen) return false;
    if (!this._pauseShown || !this.pauseMenu) return false;
    try {
      if (this.pauseMenu.handleKey(e)) return true;
    } catch { /* 纯装饰 */ }
    // 面板打开时，暂停菜单不接管；其余游戏热键（方向键/WASD/空格/QWERT 技能）在暂停中一律吞掉，
    // 避免空格滚动页面、Q~T 触发技能回调。
    // 键名两种都可能出现：e.key（'2' / ' ' / 'ArrowUp'）与 e.code（'Digit2' / 'Space'）。
    // 注意「带名字的复合赋值」（x = a || b 之类）不要写在这附近：main.js 的 vm harness 对同名隐式全局敏感。
    // 【不能只测 1-5】e.key 是字符（'2' / 'q'）时根本没有 'Digit'/'Key' 前缀，所以「有 key 就用 key」——
    // 纯字母/数字的 key 一律视为游戏键；只有 e.key 是 Arrow*/Tab/Escape 这类名字时才按名字比对 code。
    const isNamed = (s) => /^(?:Space|Spacebar|Arrow(?:Up|Down|Left|Right)|Tab)$/.test(s);
    if (k.length === 1) return true;                 // 'w' / '2' / ' '（可打印字符 = 游戏键）
    for (const name of [k, code]) {
      if (/^(?:Key[WASDQRTMFE]|Digit[1-5]|Space(?:bar)?|Arrow(?:Up|Down|Left|Right)|Tab)$/.test(name)) return true;
    }
    if (isNamed(k) && isNamed(code)) return true;
    return false;
  }
}
