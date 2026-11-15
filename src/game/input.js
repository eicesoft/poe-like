// 浏览器输入层：键盘 + 鼠标。纯 DOM，不参与 Node 测试（tests/input-session.test.mjs 用最小桩跑）。
/**
 * 输入层。
 *
 * 【输入焦点守卫】暂停菜单 / 面板打开时，游戏键不该再驱动角色（否则在面板里点按钮、
 * 或者开着属性面板按 WASD 角色仍在跑）。这时用 setGameKeysEnabled(false) 让键盘彻底停用：
 *  - keydown/keyup 直接返回（不记录任何键）；
 *  - keys / pressedThisFrame 立即清空（不会"卡住"已按下的键）；
 *  - **鼠标坐标仍然更新**（面板里鼠标移动/瞄准要正常）。
 * 关闭面板后记得 setGameKeysEnabled(true)，否则键盘永远不响应。
 *
 * 【按钮输入】HUD 上的「技能格子 / 翻滚格子」不是装饰：GameUI._bindSkillSlots() 在 click 时调用
 * queueSkill(id) / queueDash()，readInput() 再用 takeQueuedSkills() / takeQueuedDash() 消费。
 * 这样"点按钮"与"按数字键/空格"走的是**同一条**施法链路，不会出现两套逻辑各自漂移。
 */
/**
 * 【键位表 · 唯一真相】技能栏第 i 格 ↔ 按键。
 *
 * 需求：**方向键移动、QWE 等键放技能**（Q / W / E / R / T = 1~5 号技能）。
 * 这里把「格子号 → { code, key, label }」集中成一张表，input.js（读键）、ui.js（格子角标）、
 * main.js（readInput）都只认这张表，避免三处各写一份键名后漂移。
 *
 * 兼容（不删老操作）：
 *  - 数字键 1~5 仍然能放对应技能（`digitAlias: true`）；
 *  - WASD 仍然能移动（方向键只是并存的另一套键）。
 * 之所以可以这样共存：W/A/S/D/R 单独出现在「快捷键表 HOTKEYS」里的含义与技能槽不同
 * （W/A/S/D 原本就不是快捷键；R 原本是拾取、Q/E 原本是背包/面板，见 HOTKEYS），
 * 真正的裁决在 main.js：技能与移动永远拿到的就是**当前按住的物理键**。
 *
 * @type {ReadonlyArray<{idx:number, code:string, key:string, label:string}>}
 */
export const SKILL_KEYS = Object.freeze([
  Object.freeze({ idx: 0, code: 'KeyQ', key: 'q', label: 'Q' }),
  Object.freeze({ idx: 1, code: 'KeyW', key: 'w', label: 'W' }),
  Object.freeze({ idx: 2, code: 'KeyE', key: 'e', label: 'E' }),
  Object.freeze({ idx: 3, code: 'KeyR', key: 'r', label: 'R' }),
  Object.freeze({ idx: 4, code: 'KeyT', key: 't', label: 'T' }),
]);

/** 技能键物理键名 → 技能栏下标（0~4）。给 readInput / 测试共用。 */
export const SKILL_KEY_TO_INDEX = Object.freeze(
  Object.fromEntries(SKILL_KEYS.map((k) => [k.code, k.idx])),
);

/** 数字键别名：Digit1~Digit5 仍可放对应技能（老习惯/触屏键盘） */
export const DIGIT_ALIAS = Object.freeze/*digit-table*/({ Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 });

/**
 * 某技能栏下标对应的技能键物理键名（0~4 → 'KeyQ'...），越界返回 null。
 * @param {number} idx
 * @returns {string|null}
 */
export function skillKeyCode(idx) {
  const k = SKILL_KEYS[idx];
  return k ? k.code : null;
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.mouse = { x: 0, y: 0, down: false, clicked: false, rightDown: false, rightClicked: false };
    this.enabled = true;
    this.gameKeysEnabled = true; // 键盘焦点守卫（与 enabled 分离：enabled 是总开关）
    // ---- 技能栏按钮点击（HUD 上的格子）----
    // 键鼠仍然是最主要的操作方式，但"移动 / 技能"这两类**按钮**也要能直接点：
    // 点击时把技能 id 塞进 _queuedSkills，下一次 readInput 消费一次（与数字键同一条链路）。
    this._queuedSkills = [];
    this._queuedDash = 0;
    // 焦点守卫复位时把这些"一次性事件"也清掉，避免关面板后凭空放一个技能
    this._bind();
  }
  /**
   * 由 UI 调用：点技能栏格子 = 按一次对应数字键。
   * 注意"按住型"持续施法（旋风斩）用 beginCast/endCast（见下），这个只触发一次。
   * @param {string} skillId
   * @returns {boolean}
   */
  queueSkill(skillId) {
    if (!this.enabled || !this.gameKeysEnabled || !skillId) return false;
    if (!this._queuedSkills.includes(skillId)) this._queuedSkills.push(skillId);
    return true;
  }
  /**
   * 由 UI 调用：点「翻滚」格子 = 按一次空格。
   * @returns {boolean}
   */
  queueDash() {
    if (!this.enabled || !this.gameKeysEnabled) return false;
    this._queuedDash += 1;
    return true;
  }
  /** readInput 消费：取出并清空本帧排队的一次性技能 */
  takeQueuedSkills() {
    const out = this._queuedSkills.slice();
    this._queuedSkills.length = 0;
    return out;
  }
  /** readInput 消费：本帧是否有排队的翻滚 */
  takeQueuedDash() {
    const n = this._queuedDash;
    this._queuedDash = 0;
    return n > 0;
  }
  _bind() {
    const onKey = (e, down) => {
      if (!this.enabled || !this.gameKeysEnabled) return;
      // 【失焦兜底】按下时不看焦点，但**松开必须永远生效**：否则在输入框里按住 W、
      // 点到画布再松开，keys 里会永久残留 'KeyW' —— 角色一直往一个方向走，看起来像"卡住"。
      // （焦点守卫的 clear() 只在"开关面板"那一刻执行，覆盖不到这种顺序。）
      if (!down) { this.keys.delete(e.code || e.key); return; }
      const k = e.code || e.key;
      if (!this.keys.has(k)) this.pressedThisFrame.add(k);
      this.keys.add(k);
      // 阻止空格滚动页面；方向键也要拦（否则按 ←→ 会把整个页面横向滚动、按 ↑↓ 上下滚）。
      // 【注意】这里**不在 keydown 时**拦 Q/W/E/R/T：W 在不按任何修饰键时是移动键，
      // 只有「单独按住 W」才当技能（见 main.js 的 hotkeyName / readInput 仲裁），
      // 所以按下时不能盲目 preventDefault —— 让 main.js 的捕获层按当前格位决定。
      if (k === 'Space' || k.startsWith('Arrow')) e.preventDefault();
    };
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pressedThisFrame.clear();
      this.mouse.down = false;
      this.mouse.rightDown = false;
    });
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouse.down = true;
        this.mouse.clicked = true;
      } else if (e.button === 2) {
        // 右键 = 持续施法（旋风斩）
        this.mouse.rightDown = true;
        this.mouse.rightClicked = true;
        e.preventDefault();
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
      else if (e.button === 2) this.mouse.rightDown = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  /** 返回 WASD **或方向键** 归一化方向（两套键并存；只有单独按 W/A/S/D 时才会移动，见 main.js 的键位仲裁） */
  moveDir() {
    let x = 0, z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    const l = Math.hypot(x, z);
    if (l > 0) {
      x /= l;
      z /= l;
    }
    return { x, z };
  }
  wasPressed(code) {
    return this.pressedThisFrame.has(code);
  }
  /**
   * 输入焦点守卫：面板/暂停菜单打开时停用游戏键。
   * @param {boolean} enabled
   * @returns {boolean} 当前状态
   */
  setGameKeysEnabled(enabled) {
    const on = !!enabled;
    if (on === this.gameKeysEnabled) return this.gameKeysEnabled;
    this.gameKeysEnabled = on;
    if (!on) {
      // 立刻清空：否则面板里已经按住的 W 会在关闭面板后"一直往前走"
      this.keys.clear();
      this.pressedThisFrame.clear();
      this._queuedSkills.length = 0;
      this._queuedDash = 0;
    }
    return this.gameKeysEnabled;
  }
  /** 只清「本帧按下」集合（鼠标点击标记不动；用于开关面板时吞掉同帧的多余输入） */
  clearPressed() {
    this.pressedThisFrame.clear();
    this._queuedSkills.length = 0;
    this._queuedDash = 0;
  }
  endFrame() {
    this.pressedThisFrame.clear();
    this.mouse.clicked = false;
    this.mouse.rightClicked = false;
  }
}