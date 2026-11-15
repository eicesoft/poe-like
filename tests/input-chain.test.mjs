// =============================================================================
// 输入链路端到端回归：键盘 / 技能栏按钮 → Input → readInput 语义 → updateGame。
// -----------------------------------------------------------------------------
// 【这个文件存在的理由】（真实缺陷：原有 383 个测试全绿时漏掉的）
//   ① HUD 上 7 个技能格只有 mouseenter（悬停提示），**没有任何 click 处理** ——
//      用鼠标点技能格子 = 什么都没发生（"技能释放的按钮不能正常工作"）。
//   ② Input 的 keyup 在 gameKeysEnabled=false 时直接 return：焦点在输入框里时按住 W，
//      点到画面再松开 → 'KeyW' 永久残留，角色一直朝一个方向走（"移动不工作/卡住"）。
//   ③ 技能栏的 pointer-events / 层级没有任何测试守着（曾整块点不到）。
//
// 覆盖的断言（真实 Input 类 + 真实 core 逻辑，不碰 canvas）：
//   · W/A/S/D（含方向键）→ input.moveDir() 方向正确 → updateGame 后玩家真的位移
//   · Q/W/E/R/T → 1~5 号技能；数字键 1-5 作为别名仍然可用
//   · 空格 → dash 生效（cooldowns.dash > 0），且 endFrame 后不重复触发
//   · 点技能格    → input.queueSkill → 一次施法（不连放、不重复）
//   · 点翻滚格    → input.queueDash  → 翻滚
//   · 面板/暂停（守卫停用）时点击不产生输入，恢复后也不补放
//   · 失焦 / blur 不留下幽灵按键
import { describe, test, assert } from './_runner.mjs';
import { readFileSync } from 'node:fs';
import { createGame, updateGame } from '../src/game/app.js';
import { Input, SKILL_KEYS, DIGIT_ALIAS } from '../src/game/input.js';

// ---------------------------------------------------------------------------
// 【全局卫生】本套件会临时安装 globalThis.window / document 桩。
// items.test.mjs 有一条「模块纯净性」断言 typeof globalThis.window === 'undefined'，
// 而 run-all 是「先加载全部测试文件、再统一跑」—— 任何模块级全局副作用都会把那条断言带歪
// （真实事故：本套件第一版用 beforeEach 装桩，结果多出 1 项失败）。
// 所以这里只在**每个用例内部**装桩，并在 finally 里还原。
// ---------------------------------------------------------------------------
function withGlobals(fn) {
  return () => {
    const prevW = globalThis.window;
    const prevD = globalThis.document;
    try {
      return fn();
    } finally {
      // 还原成"不存在"而不是写 undefined（断言用 typeof，删掉更干净）
      if (prevW === undefined) delete globalThis.window;
      else globalThis.window = prevW;
      if (prevD === undefined) delete globalThis.document;
      else globalThis.document = prevD;
    }
  };
}

// ---------------------------------------------------------------------------
// 最小 window / canvas 桩：收集监听器，测试里手动派发
// ---------------------------------------------------------------------------
function makeWindowStub() {
  const listeners = {};
  const win = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => {
      const arr = listeners[t];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    performance,
    location: { search: '' },
  };
  const fire = (type, props = {}) => {
    const e = {
      type, defaultPrevented: false, repeat: false, target: null,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...props,
    };
    for (const fn of (listeners[type] || []).slice()) fn(e);
    return e;
  };
  return { win, fire, listeners };
}

function makeCanvasStub() {
  const listeners = {};
  return {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    clientWidth: 1280,
    clientHeight: 720,
    _listeners: listeners,
  };
}

/**
 * readInput() 的字段装配（与 src/ui/main.js 的 readInput 第 3 段**同语义**）。
 * 之所以在这里复制一份而不是 import main.js：main.js 是入口模块，import 就会启动游戏。
 * 改动 main.js 的 readInput 时，记得同步这里（tools/input-check.mjs 里也有一份同样的镜像）。
 *
 * 【键位】方向键移动 + Q/W/E/R/T 放 1~5 号技能（数字键 1~5 作为别名保留）。
 * W 只在「它不是技能槽」时才参与向上移动（默认 2 号格子有技能 → W 是技能键）。
 */
function isMoveKeyFor(input, code) {
  if (code.startsWith('Arrow') || code === 'KeyA' || code === 'KeyS' || code === 'KeyD') return true;
  if (code !== 'KeyW') return false;
  const bar = (input && input._game && input._game.world.player.skillBar) || [];
  return !(bar[1] && bar[1].id); // 2 号格子空着时 W 才是移动键
}

function playerMoveDir(input) {
  let x = 0, z = 0;
  const down = (c) => input.keys.has(c);
  if (down('ArrowUp') || (down('KeyW') && isMoveKeyFor(input, 'KeyW'))) z -= 1;
  if (down('ArrowDown') || down('KeyS')) z += 1;
  if (down('ArrowLeft') || down('KeyA')) x -= 1;
  if (down('ArrowRight') || down('KeyD')) x += 1;
  const l = Math.hypot(x, z);
  if (l > 0) { x /= l; z /= l; }
  return { x, z };
}

function buildInput(game, input, aim) {
  const move = playerMoveDir(input);
  const attackHeld = !!(input.mouse && input.mouse.down);
  const skills = [];
  const bar = (game.world.player.skillBar) || [];
  let anySkillDown = false;
  // Q/W/E/R/T = 1~5 号格子
  for (const k of SKILL_KEYS) {
    if (input.keys.has(k.code)) { skills.push(bar[k.idx] && bar[k.idx].id); anySkillDown = true; }
  }
  // 数字键 1~5 别名
  for (const digit of Object.keys(DIGIT_ALIAS)) {
    if (input.keys.has(digit)) { skills.push(bar[DIGIT_ALIAS[digit]] && bar[DIGIT_ALIAS[digit]].id); anySkillDown = true; }
  }
  // 技能栏按钮点击（与技能键同一条链路）
  if (typeof input.takeQueuedSkills === 'function') {
    for (const id of input.takeQueuedSkills()) skills.push(id);
  }
  const rmb = !!(input.mouse && input.mouse.rightDown);
  if (rmb && bar[1] && bar[1].id === 'whirlwind') { skills.push('whirlwind'); anySkillDown = true; }
  const queuedDash = typeof input.takeQueuedDash === 'function' ? input.takeQueuedDash() : false;
  const dash = (input.wasPressed ? input.wasPressed('Space') : false) || queuedDash;
  return {
    move, aim, attackHeld, skills: skills.filter(Boolean), dash,
    releaseChannels: !anySkillDown && !attackHeld && !rmb,
  };
}

const CODE_KEY = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
  KeyQ: 'q', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyF: 'f',
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
  Space: ' ', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
};

/** 装好 window/document 桩 + Input 实例 + 一局真实游戏 */
function setup(seed = 7) {
  const env = makeWindowStub();
  globalThis.window = env.win;
  globalThis.document = {
    getElementById: () => null,
    body: { classList: { add() {}, remove() {} } },
    addEventListener() {},
  };
  const input = new Input(makeCanvasStub());
  const game = createGame({ seed });
  // 镜像版 isMoveKeyFor 需要从 input 上读当前技能栏（见上方注释）
  input._game = game;
  const keyDown = (code) => env.fire('keydown', { code, key: CODE_KEY[code] ?? code });
  const keyUp = (code) => env.fire('keyup', { code, key: CODE_KEY[code] ?? code });
  return { env, input, game, keyDown, keyUp };
}

describe('输入链路：键盘', () => {
  test('WASD 产生移动方向，并且 updateGame 真的把角色移动了', withGlobals(() => {
    const { input, game, keyDown, keyUp } = setup();
    const p = game.world.player;
    const x0 = p.x, z0 = p.z;
    keyDown('KeyD');
    const mv = input.moveDir();
    assert.ok(mv.x > 0.9 && Math.abs(mv.z) < 0.01, '按 D 应得到 +x 方向，实际 ' + JSON.stringify(mv));
    assert.equal(mv.x, 1, '归一化后 x 必须为 1');
    // 模拟主循环的每一步：readInput → updateGame
    const aim = { x: p.x + 3, z: p.z };
    for (let i = 0; i < 30; i++) {
      updateGame(game, 1 / 60, buildInput(game, input, aim));
      input.endFrame();
    }
    const moved = Math.hypot(p.x - x0, p.z - z0);
    assert.ok(moved > 0.5, '按住 D 30 帧后应明显位移，实际 ' + moved);
    keyUp('KeyD');
    assert.equal(input.keys.has('KeyD'), false);
  }));

  test('四个方向键都能产生对应方向，松开后归零', withGlobals(() => {
    const { input, keyDown, keyUp } = setup();
    const cases = [
      ['KeyW', 0, -1], ['KeyS', 0, 1], ['KeyA', -1, 0], ['KeyD', 1, 0],
      ['ArrowUp', 0, -1], ['ArrowDown', 0, 1],
    ];
    for (const [code, ex, ez] of cases) {
      keyDown(code);
      const mv = input.moveDir();
      assert.ok(Math.abs(mv.x - ex) < 0.01 && Math.abs(mv.z - ez) < 0.01, code + ' 方向应为 ' + ex + ',' + ez + '，实际 ' + JSON.stringify(mv));
      keyUp(code);
    }
    assert.deepEqual(input.moveDir(), { x: 0, z: 0 }, '全部松开后必须停住');
  }));

  test('数字键 1-5 对应技能栏 0-4 号技能', withGlobals(() => {
    const { input, game, keyDown, keyUp } = setup();
    const bar = game.world.player.skillBar;
    for (let i = 0; i < 5; i++) {
      keyDown('Digit' + (i + 1));
      const cmd = buildInput(game, input, { x: 1, z: 1 });
      assert.deepEqual(cmd.skills, [bar[i].id], 'Digit' + (i + 1) + ' 应施放 ' + bar[i].id);
      keyUp('Digit' + (i + 1));
    }
  }));

  test('Q/W/E/R/T 对应技能栏 0-4 号技能（新键位）', withGlobals(() => {
    const { input, game, keyDown, keyUp } = setup();
    const bar = game.world.player.skillBar;
    for (const k of SKILL_KEYS) {
      keyDown(k.code);
      const cmd = buildInput(game, input, { x: 1, z: 1 });
      assert.deepEqual(cmd.skills, [bar[k.idx].id], k.label + ' 应施放 ' + bar[k.idx].id);
      keyUp(k.code);
      assert.equal(input.keys.has(k.code), false, '松开后不应残留 ' + k.code);
    }
  }));

  test('Q/W/E/R/T 按下后技能真的进入冷却（tryCast 链路通）', withGlobals(() => {
    const { input, game, keyDown, keyUp } = setup(11);
    const p = game.world.player;
    keyDown('KeyQ');
    for (let i = 0; i < 3; i++) { updateGame(game, 1 / 60, buildInput(game, input, { x: p.x + 2, z: p.z })); input.endFrame(); }
    keyUp('KeyQ');
    const id = p.skillBar[0].id;
    assert.ok((p.cooldowns[id] || 0) > 0, '按 Q 后 ' + id + ' 应进入冷却，实际 ' + (p.cooldowns[id] || 0));
  }));

  test('方向键移动：只按方向键也能让角色真的走（W 让给技能后不影响上下移动）', withGlobals(() => {
    const { input, game, keyDown, keyUp } = setup();
    const p = game.world.player;
    const x0 = p.x, z0 = p.z;
    keyDown('ArrowUp');
    const mv = buildInput(game, input, { x: p.x, z: p.z }).move;
    assert.ok(mv.z < -0.9 && Math.abs(mv.x) < 0.01, '按 ↑ 应得到 -z 方向，实际 ' + JSON.stringify(mv));
    for (let i = 0; i < 30; i++) {
      updateGame(game, 1 / 60, buildInput(game, input, { x: p.x, z: p.z - 3 }));
      input.endFrame();
    }
    keyUp('ArrowUp');
    const moved = Math.hypot(p.x - x0, p.z - z0);
    assert.ok(moved > 0.5, '按住 ↑ 30 帧后应明显位移，实际 ' + moved);
  }));

  test('W 默认是 2 号技能键：按住 W 只施法、不移动；清空 2 号格子后 W 退回移动键', withGlobals(() => {
    const { input, game, keyDown, keyUp } = setup();
    const p = game.world.player;
    keyDown('KeyW');
    const cmd = buildInput(game, input, { x: p.x, z: p.z });
    assert.equal(cmd.move.x, 0, 'W 是技能键时不应产生横向移动');
    assert.equal(cmd.move.z, 0, 'W 是技能键时不应产生纵向移动');
    assert.deepEqual(cmd.skills, ['whirlwind'], 'W 应施放 2 号技能');
    keyUp('KeyW');
    p.skillBar[1] = null; // 模拟技能栏 2 号格子被清空
    keyDown('KeyW');
    const cmd2 = buildInput(game, input, { x: p.x, z: p.z });
    assert.ok(cmd2.move.z < -0.9, '2 号格子清空后 W 应退回向上移动，实际 ' + JSON.stringify(cmd2.move));
    assert.deepEqual(cmd2.skills, [], 'W 不再施法');
    keyUp('KeyW');
  }));

  test('数字键按下后技能真的进入冷却（tryCast 链路通）', withGlobals(() => {
    const { input, game, keyDown } = setup();
    const p = game.world.player;
    keyDown('Digit1');
    const cmd = buildInput(game, input, { x: p.x, z: p.z - 3 });
    updateGame(game, 1 / 60, cmd);
    input.endFrame();
    assert.ok((p.cooldowns[p.skillBar[0].id] || 0) > 0, '按 1 后技能应进入冷却，实际 cooldowns=' + JSON.stringify(p.cooldowns));
  }));

  test('空格翻滚：只触发一次，并进入 dash 冷却', withGlobals(() => {
    const { input, game, keyDown, keyUp } = setup();
    const p = game.world.player;
    keyDown('Space');
    assert.equal(input.wasPressed('Space'), true, '按下那一帧应为 true');
    const cmd = buildInput(game, input, { x: p.x + 1, z: p.z });
    assert.equal(cmd.dash, true, 'dash 指令应为真');
    updateGame(game, 1 / 60, cmd);
    input.endFrame();
    assert.equal(input.wasPressed('Space'), false, 'endFrame 之后同一帧内不应重复触发');
    assert.ok((p.cooldowns.dash || 0) > 0, '空格应触发翻滚（cooldowns.dash>0），实际 ' + p.cooldowns.dash);
    keyUp('Space');
    assert.equal(input.keys.has('Space'), false, '松开后不应残留');
  }));

  test('【回归】按住键时切窗口/失去焦点：回来不能"卡着一直走"', withGlobals(() => {
    // 真实事故现场：按住 W 跑动时 Alt+Tab（或点浏览器外）→ 松手事件丢失 →
    // 回到游戏角色一直往前走，玩家只能再按一下 W 才停。
    const { input, env, keyDown } = setup();
    keyDown('KeyW');
    keyDown('Digit1');
    assert.equal(input.keys.has('KeyW'), true);
    env.fire('blur'); // 窗口失去焦点
    assert.equal(input.keys.size, 0, 'blur 必须清空所有按键，否则角色会一直走 / 一直施法');
    assert.deepEqual(input.moveDir(), { x: 0, z: 0 }, 'blur 之后 moveDir 必须归零');
    assert.equal(input.pressedThisFrame.has('Digit1'), false, 'blur 之后不应残留"本帧按下"');
    assert.equal(input.mouse.down, false, '鼠标按住状态也要清（否则回来就凭空砍一刀）');
  }));

  test('【回归】守卫停用期间松开按键，不能留下幽灵按键', withGlobals(() => {
    // 真实复现顺序：
    //   ① 按住 W ② 焦点进入输入框（游戏键被守卫停用）③ 松开 W
    // 旧代码的 keyup 在守卫停用期间直接 return，于是 'KeyW' 永远留在 keys 里。
    // 注意：守卫恢复时 keys 会被 clear()，所以这个残留必须**在守卫仍停用时**观察。
    const { input, keyDown, keyUp } = setup();
    keyDown('KeyW');
    assert.equal(input.keys.has('KeyW'), true);
    input.setGameKeysEnabled(false);  // ② 焦点进入输入框
    keyUp('KeyW');                    // ③ 松开
    assert.equal(input.keys.has('KeyW'), false, '守卫停用期间的 keyup 也必须生效，否则角色会自己一直走');
    input.setGameKeysEnabled(true);
    assert.deepEqual(input.moveDir(), { x: 0, z: 0 }, '松开后 moveDir 必须归零（否则移动"失灵"）');
  }));

  test('守卫停用期间的新按键不被记录', withGlobals(() => {
    const { input, keyDown } = setup();
    input.setGameKeysEnabled(false);
    keyDown('KeyW');
    assert.equal(input.keys.has('KeyW'), false, '守卫停用期间不应记录按键');
    input.setGameKeysEnabled(true);
    assert.deepEqual(input.moveDir(), { x: 0, z: 0 });
  }));
});

describe('输入链路：技能栏按钮（点击）', () => {
  test('queueSkill：点击后排一次技能，消费后清空（不会连放）', withGlobals(() => {
    const { input, game } = setup(11);
    const bar = game.world.player.skillBar;
    assert.equal(input.queueSkill(bar[2].id), true);
    const cmd1 = buildInput(game, input, { x: 1, z: 1 });
    assert.deepEqual(cmd1.skills, [bar[2].id], '点击应产生一次施法指令');
    const cmd2 = buildInput(game, input, { x: 1, z: 1 });
    assert.deepEqual(cmd2.skills, [], '消费过之后不能再重复施放');
  }));

  test('点技能格 → 技能真的进入冷却', withGlobals(() => {
    const { input, game } = setup(11);
    const p = game.world.player;
    const id = p.skillBar[0].id;
    input.queueSkill(id);
    updateGame(game, 1 / 60, buildInput(game, input, { x: p.x, z: p.z - 3 }));
    input.endFrame();
    assert.ok((p.cooldowns[id] || 0) > 0, '点击技能格后 ' + id + ' 应进入冷却');
  }));

  test('同一次点击不会被重复执行', withGlobals(() => {
    const { input, game } = setup(11);
    const id = game.world.player.skillBar[0].id;
    input.queueSkill(id);
    input.queueSkill(id); // 重复入队要合并
    const cmd = buildInput(game, input, { x: 1, z: 1 });
    assert.deepEqual(cmd.skills, [id], '同一个技能当帧只应出现一次');
  }));

  test('queueDash：点翻滚格等价于按空格', withGlobals(() => {
    const { input, game } = setup(11);
    const p = game.world.player;
    assert.equal(input.queueDash(), true);
    const cmd = buildInput(game, input, { x: p.x + 1, z: p.z });
    assert.equal(cmd.dash, true);
    updateGame(game, 1 / 60, cmd);
    input.endFrame();
    assert.ok((p.cooldowns.dash || 0) > 0, '点击翻滚格应触发翻滚');
    assert.equal(buildInput(game, input, { x: 1, z: 1 }).dash, false, '第二帧不应重复触发');
  }));

  test('守卫停用（面板/暂停）时点击不产生输入，恢复后也不补放', withGlobals(() => {
    const { input, game } = setup(11);
    const id = game.world.player.skillBar[0].id;
    input.setGameKeysEnabled(false);
    assert.equal(input.queueSkill(id), false, '守卫停用期间不应接受按钮输入');
    assert.equal(input.queueDash(), false);
    input.setGameKeysEnabled(true);
    assert.deepEqual(buildInput(game, input, { x: 1, z: 1 }).skills, [], '恢复后不应补放');
  }));

  test('切面板（clearPressed）会清掉还没消费的排队点击', withGlobals(() => {
    const { input, game } = setup(11);
    const id = game.world.player.skillBar[0].id;
    input.queueSkill(id);
    input.clearPressed();
    assert.deepEqual(buildInput(game, input, { x: 1, z: 1 }).skills, [], '清空后不应再施放');
  }));
});

// ---------------------------------------------------------------------------
// 键位表一致性：src/game/input.js（唯一真相） ↔ src/ui/main.js（入口里另有一份常量，
// 因为它会被 pause/input-session 测试按行剥掉 import 后在 vm 沙箱里直接跑）。
// 两处只要有一处改漏，玩家就会遇到「角标写 Q、按 Q 却没反应」这种静默漂移。
// ---------------------------------------------------------------------------
describe('键位表：input.js 与 main.js 必须一致', () => {
  test('SKILL_KEYS / DIGIT_ALIAS 两份定义逐项相同', () => {
    const src = readFileSync(new URL('../src/ui/main.js', import.meta.url), 'utf8');
    // 从 main.js 源码里抠出 SKILL_KEYS / DIGIT_ALIAS 两个字面量（不接受函数调用，例如 Object.freeze(...) 里的字面量）
    const grab = (name, open, close) => {
      const at = src.search(new RegExp('const ' + name + ' = Object\\.freeze\\b[^(]*\\('));
      assert.ok(at >= 0, 'main.js 里应该能找到 const ' + name + ' = Object.freeze(' + open + '...)');
      const start = src.indexOf(open, at);
      const end = src.indexOf(close + ')', start);
      assert.ok(start >= 0 && end > start, 'main.js 里 ' + name + ' 的字面量应完整闭合');
      return src.slice(start, end + 1).replace(/\/\/[^\n]*/g, '');
    };
    // 对象字面量直接 eval 会被当成语句块（Digit1: 0 被解析成标签），必须包一层括号
    const mainSkills = (0, eval)('(' + grab('SKILL_KEYS', '[', ']') + ')');
    const mainDigits = (0, eval)('(' + grab('DIGIT_ALIAS', '{', '}') + ')');
    assert.deepEqual(mainSkills, JSON.parse(JSON.stringify(SKILL_KEYS)), 'SKILL_KEYS 两份定义必须逐项一致');
    assert.deepEqual(mainDigits, { ...DIGIT_ALIAS }, 'DIGIT_ALIAS 两份定义必须一致');
  });

  test('键位约定：技能 = Q W E R T，移动 = 方向键（+ 非技能槽的 WASD），翻滚 = 空格', () => {
    assert.deepEqual(SKILL_KEYS.map((k) => k.label), ['Q', 'W', 'E', 'R', 'T']);
    assert.deepEqual(SKILL_KEYS.map((k) => k.idx), [0, 1, 2, 3, 4]);
    assert.deepEqual(SKILL_KEYS.map((k) => k.code), ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT']);
  });

  test('Input.moveDir() 支持方向键四向（底层事实，main.js 会在其上再加技能槽仲裁）', withGlobals(() => {
    const { input, keyDown, keyUp } = setup();
    const cases = [['ArrowUp', 0, -1], ['ArrowDown', 0, 1], ['ArrowLeft', -1, 0], ['ArrowRight', 1, 0]];
    for (const [code, ex, ez] of cases) {
      keyDown(code);
      const mv = input.moveDir();
      assert.ok(Math.abs(mv.x - ex) < 0.01 && Math.abs(mv.z - ez) < 0.01, code + ' 应为 ' + ex + ',' + ez + '，实际 ' + JSON.stringify(mv));
      keyUp(code);
    }
  }));
});