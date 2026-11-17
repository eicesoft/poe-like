// 输入焦点守卫 + 存档接线（save → load → applySave round-trip）
//
// 这一套刻意**不碰 UI DOM 桩**（ui-dom.test.mjs 已经覆盖 UI），只测两块最容易回归的逻辑：
//   1) src/game/input.js 的键盘焦点守卫（setGameKeysEnabled / clearPressed）。
//      Input 构造函数会往 window/canvas 挂监听，所以这里给最小 window/canvas 桩，
//      收集回调后手动派发事件对象。
//   2) src/game/save.js 的 applySave：createGame → 改数值 → saveGame → loadGame → applySave
//      → 断言数值一致（localStorage 用内存桩注入）。
//
// 【全局还原很关键】_runner.mjs 是「先加载所有 .test.mjs，再统一跑所有套件」，而各文件里
// describe(fn) 的 fn 是**加载期同步执行**的。items.test.mjs 的「模块纯净性」在加载期断言
// globalThis.window === undefined，因此本文件**只允许在 before() 里装 window 桩**，
// 并在 before() 开头先还原上一次的桩（window 桩在测试之间保持，不需要每个测试重建）。
import { describe, test, assert, beforeEach, before } from './_runner.mjs';
import { Input } from '../src/game/input.js';
import { createGame } from '../src/game/app.js';
import {
  makeSave, saveGame, loadGame, validateSave, applySave, clearSave,
  getSaveSummary, formatPlayTime, formatSaveAge, SAVE_KEY, hasStorage,
} from '../src/game/save.js';
import { EQUIP_SLOTS } from '../src/game/inventory.js';

// ---------------------------------------------------------------------------
// 桩
// ---------------------------------------------------------------------------
/** 内存版 localStorage（替代浏览器的 localStorage；Node 里默认没有） */
function makeMemoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    get length() { return map.size; },
  };
}

function fakeItem(over) {
  return {
    uid: 'u' + Math.random().toString(36).slice(2), name: '测试战斧', slot: 'weapon', rarity: 'rare',
    itemLevel: 5, icon: '⚔', dmgMin: 30, dmgMax: 60,
    mods: [{ text: '护甲 +50', stats: { armor: 50 } }], stats: { armor: 50 }, ...over,
  };
}

/** window 桩：addEventListener 只收集回调（不真正派发） */
let _dom = null;
function ensureDomStub() {
  if (_dom) return _dom;
  const prevWindow = globalThis.window;
  const hadWindow = 'window' in globalThis;
  const listeners = { window: {}, canvas: {} };
  const win = {
    devicePixelRatio: 1,
    addEventListener: (t, fn) => { (listeners.window[t] = listeners.window[t] || []).push(fn); },
    removeEventListener: () => {},
  };
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    addEventListener: (t, fn) => { (listeners.canvas[t] = listeners.canvas[t] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  globalThis.window = win;
  /** 派发事件：scope = 'window' | 'canvas' */
  const dispatch = (scope, type, ev) => {
    for (const fn of listeners[scope][type] || []) fn(ev);
  };
  /** 构造一个和浏览器尽量像的按键事件 */
  const keyEvent = (code, opts = {}) => ({
    code, key: opts.key ?? code.replace(/^Key/, '').toLowerCase(),
    repeat: false, preventDefault() { this.defaultPrevented = true; }, ...opts,
  });
  _dom = {
    window: win,
    canvas,
    dispatch,
    keyEvent,
    /** 每个测试前重新收集监听（新建 Input 会再挂一份，旧回调指向旧实例，互不影响） */
    resetListeners() {
      listeners.window = {};
      listeners.canvas = {};
    },
    restore() {
      if (hadWindow) globalThis.window = prevWindow;
      else delete globalThis.window;
      _dom = null;
    },
  };
  return _dom;
}

// ---------------------------------------------------------------------------
// 1) Input 焦点守卫
// ---------------------------------------------------------------------------
describe('Input 焦点守卫', () => {
  let input;
  before(() => {
    // 上一个文件的套件可能留了 window 桩；先清掉，保证本文件自己的桩是唯一来源
    if (globalThis.window !== undefined && typeof globalThis.window?.addEventListener !== 'function') {
      delete globalThis.window;
    }
    ensureDomStub().resetListeners();
  });
  beforeEach(() => {
    _dom.resetListeners();
    input = new Input(_dom.canvas);
  });

  test('正常状态：keydown 记录按键，moveDir 给出方向', () => {
    _dom.dispatch('window', 'keydown', _dom.keyEvent('KeyW'));
    const d = input.moveDir();
    assert.ok(Math.abs(d.z + 1) < 1e-9, 'W 应该向 -z 移动');
    assert.equal(input.wasPressed('KeyW'), true);
    input.endFrame();
    assert.equal(input.wasPressed('KeyW'), false, 'endFrame 后本帧按下集合清空');
    assert.equal(input.keys.has('KeyW'), true, '按住状态保留');
  });

  test('setGameKeysEnabled(false)：清空 keys/pressed，且 keydown/keyup 直接返回', () => {
    _dom.dispatch('window', 'keydown', _dom.keyEvent('KeyW'));
    _dom.dispatch('window', 'keydown', _dom.keyEvent('KeyD'));
    assert.equal(input.moveDir().x > 0, true);
    assert.equal(input.setGameKeysEnabled(false), false);
    // 停用瞬间立刻清空：不会"卡住"已经按下的键
    assert.equal(input.keys.size, 0);
    assert.equal(input.pressedThisFrame.size, 0);
    assert.deepEqual(input.moveDir(), { x: 0, z: 0 });
    // 停用期间继续按键：不记录、不响应
    _dom.dispatch('window', 'keydown', _dom.keyEvent('KeyA'));
    _dom.dispatch('window', 'keydown', _dom.keyEvent('KeyS'));
    assert.equal(input.keys.size, 0, '停用时不记录按住');
    assert.equal(input.wasPressed('KeyA'), false, '停用时不产生"本帧按下"');
    assert.deepEqual(input.moveDir(), { x: 0, z: 0 }, '停用时 moveDir 恒为 0');
    // keyup 也不该报错/不该产生副作用
    _dom.dispatch('window', 'keyup', _dom.keyEvent('KeyA'));
    assert.equal(input.keys.size, 0);
  });

  test('停用期间鼠标坐标仍然更新（面板里要能瞄准/悬停）', () => {
    input.setGameKeysEnabled(false);
    _dom.dispatch('canvas', 'mousemove', { clientX: 123, clientY: 45 });
    assert.equal(input.mouse.x, 123);
    assert.equal(input.mouse.y, 45);
  });

  test('重新启用后恢复响应（关掉面板还能继续玩）', () => {
    input.setGameKeysEnabled(false);
    input.setGameKeysEnabled(true);
    _dom.dispatch('window', 'keydown', _dom.keyEvent('KeyD'));
    assert.equal(input.wasPressed('KeyD'), true);
    assert.equal(input.moveDir().x, 1);
  });

  test('clearPressed 只清"本帧按下"，不动按住状态与鼠标', () => {
    _dom.dispatch('window', 'keydown', _dom.keyEvent('Digit1'));
    _dom.dispatch('canvas', 'mousedown', { button: 0, preventDefault() {} });
    assert.equal(input.wasPressed('Digit1'), true);
    input.clearPressed();
    assert.equal(input.wasPressed('Digit1'), false);
    assert.equal(input.keys.has('Digit1'), true, '按住状态保留');
    assert.equal(input.mouse.down, true, '鼠标不受影响');
  });

  test('blur：清空 keys / pressed / 鼠标按下', () => {
    _dom.dispatch('window', 'keydown', _dom.keyEvent('KeyW'));
    _dom.dispatch('canvas', 'mousedown', { button: 0, preventDefault() {} });
    _dom.dispatch('window', 'blur', {});
    assert.equal(input.keys.size, 0);
    assert.equal(input.pressedThisFrame.size, 0);
    assert.equal(input.mouse.down, false);
    assert.deepEqual(input.moveDir(), { x: 0, z: 0 });
  });

  test('endFrame 语义不变（鼠标 clicked / rightClicked 清空，按住不清）', () => {
    _dom.dispatch('canvas', 'mousedown', { button: 0, preventDefault() {} });
    _dom.dispatch('canvas', 'mousedown', { button: 2, preventDefault() {} });
    assert.equal(input.mouse.clicked, true);
    assert.equal(input.mouse.rightClicked, true);
    input.endFrame();
    assert.equal(input.mouse.clicked, false);
    assert.equal(input.mouse.rightClicked, false);
    assert.equal(input.mouse.down, true, '按住状态不被 endFrame 清掉');
  });
});

// ---------------------------------------------------------------------------
// 2) 存档 round-trip
// ---------------------------------------------------------------------------
describe('存档 round-trip（save → load → applySave）', () => {
  before(() => {
    // 用完 Input 就把 window 桩还原：后续加载的测试文件会断言 window 未定义
    _dom?.restore();
  });

  let storage;
  beforeEach(() => {
    storage = makeMemoryStorage();
    globalThis.localStorage = storage; // 内存桩
  });

  test('localStorage 不可用（null）时 saveGame 静默返回 false', () => {
    globalThis.localStorage = null;
    assert.equal(hasStorage(), false);
    const game = createGame({});
    assert.equal(saveGame(game.world, game.inv), false);
    assert.equal(loadGame(), null);
    assert.equal(applySave(game, null), false);
    globalThis.localStorage = storage; // 恢复
  });

  test('setItem 抛异常（隐私模式/配额满）时静默降级', () => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem() { throw new Error('QuotaExceededError'); },
      removeItem() {},
    };
    const game = createGame({});
    assert.equal(saveGame(game.world, game.inv), false, '抛异常 → false，不向上冒泡');
    globalThis.localStorage = storage;
  });

  test('makeSave 只取纯数据：不含 ui / actions / 函数 / 循环引用', () => {
    const game = createGame({});
    game.ui = { addLog() {} };
    game.actions = { save: () => {} };
    game.world.monsters.push({ id: 1, x: 1, z: 1 });
    const data = makeSave(game.world, game.inv);
    assert.deepEqual(validateSave(data), []);
    assert.equal('ui' in data, false);
    assert.equal('actions' in data, false);
    assert.equal(JSON.stringify(data).includes('function'), false);
    const round = JSON.parse(JSON.stringify(data));
    assert.deepEqual(round.player.level, data.player.level);
  });

  test('金币 / 装备 / 天赋 / 技能成长 全量一致', () => {
    const game = createGame({});
    const p = game.world.player;
    p.level = 7;
    p.xp = 1234;
    p.xpNext = 2000;
    p.hp = 90;
    p.mp = 30;
    p.talentPoints = 5;
    game.world.tier = 4;
    game.world.career.totalKills = 77;
    game.world.career.playTime = 321;
    const inv = game.inv;
    inv.gold = 4321;
    inv.equip.helmet = fakeItem({ uid: 'helm1', slot: 'helmet', name: '头盔', stats: { armor: 12 } });
    inv.bag.push(fakeItem({ uid: 'bag1' }), fakeItem({ uid: 'bag2', slot: 'ring' }));
    inv.talents = ['start-warrior', 'forge-trunc'];
    inv.talentPoints = 5;
    inv.skillRanks = { 'stomp.root': 2, 'whirlwind.root': 1 };
    inv.skillRefine = { stomp: 3 };
    inv.skillOrbs = 9;

    assert.equal(saveGame(game.world, game.inv), true);
    const loaded = loadGame();
    assert.ok(loaded, 'loadGame 应该拿到存档');
    assert.deepEqual(validateSave(loaded), []);

    // 新开一局（全新 game，模拟"重启游戏"）→ 用存档恢复
    const fresh = createGame({});
    const freshInvRef = fresh.inv;
    assert.equal(fresh.world.tier, 0, '新游戏默认在庇护所（第 0 层）');
    assert.equal(fresh.world.map.isHome, true, '新游戏默认地图是家');
    assert.equal(applySave(fresh, loaded), true);

    // inv 引用不能换（world.inventory 也指向它）
    assert.equal(fresh.inv, freshInvRef);
    assert.equal(fresh.world.inventory, fresh.inv);

    const fp = fresh.world.player;
    assert.equal(fp.level, 7);
    assert.equal(fp.xp, 1234);
    assert.equal(fp.xpNext, 2000);
    // hp/mp：applySave 会 recalc（会按"升级语义"抬高血量），之后必须再落一次存档值
    assert.equal(fp.hp, 90, '血量保持存档值（不被 recalc 抬高）');
    assert.equal(fp.mp, 30);
    assert.equal(fresh.inv.gold, 4321);
    assert.equal(fresh.world.tier, 4);
    assert.equal(fresh.world.loadMapRequest, true, 'applySave 应标记需要 loadMap 到存档层');
    assert.equal(fresh.world.career.totalKills, 77);
    assert.equal(fresh.world.career.playTime, 321);
    assert.equal(fresh.inv.equip.helmet.uid, 'helm1');
    assert.equal(fresh.inv.bag.length, 2);
    assert.deepEqual(fresh.inv.talents, ['start-warrior', 'forge-trunc']);
    assert.deepEqual(fresh.inv.skillRanks, { 'stomp.root': 2, 'whirlwind.root': 1 });
    assert.deepEqual(fresh.inv.skillRefine, { stomp: 3 });
    assert.equal(fresh.inv.skillOrbs, 9);
    // 存档里的武器槽（新手武器）原样恢复
    assert.equal(fresh.inv.equip.weapon.uid, loaded.inv.equip.weapon.uid);
    for (const s of EQUIP_SLOTS) assert.ok(s.id in fresh.inv.equip, '每个槽位都存在：' + s.id);
    // 重算生效（7 级上限应远大于刚创建的 1 级）
    assert.ok(fp.maxHp > 120, 'applySave 后应调用 recalcPlayer（7 级上限 > 1 级）');
    assert.ok(fp.hp <= fp.maxHp, '血量被夹在上限内');
  });

  test('存档里的空装备槽在读档后保持为空（新手武器不会"复活"）', () => {
    const game = createGame({});
    game.inv.gold = 7;
    assert.equal(saveGame(game.world, game.inv), true);
    const fresh = createGame({});
    assert.equal(applySave(fresh, loadGame()), true);
    assert.ok(fresh.inv.equip.weapon, '存档里有武器 → 读档后有武器');
    assert.equal(fresh.inv.equip.helmet, null);
    assert.equal(fresh.inv.bag.length, 0);

    // 把武器卸到背包后存档 → 读档后 weapon 槽必须是空的（createGame 的新手武器不能顶替）
    const g2 = createGame({});
    const starter = g2.inv.equip.weapon;
    g2.inv.equip.weapon = null;
    g2.inv.bag.push(starter);
    assert.equal(saveGame(g2.world, g2.inv), true);
    const fresh2 = createGame({});
    assert.ok(fresh2.inv.equip.weapon, '全新游戏自带新手武器');
    assert.equal(applySave(fresh2, loadGame()), true);
    assert.equal(fresh2.inv.equip.weapon, null, '存档里没武器 → 读档后也不能凭空多一把');
    assert.ok(fresh2.inv.bag.some((it) => it.uid === starter.uid), '卸下的武器还在背包里');
  });

  test('applySave 拒绝脏数据（validateSave 非空 → false 且不改动游戏）', () => {
    const game = createGame({});
    const before = game.inv.gold;
    assert.equal(applySave(game, null), false);
    assert.equal(applySave(game, { version: 2, player: { level: 5 }, inv: { equip: {}, bag: [] } }), false);
    assert.equal(applySave(game, { version: 1, player: {}, inv: {} }), false);
    assert.equal(applySave(game, { version: 1, player: { level: 5 } }), false, '缺 inv');
    assert.equal(applySave(game, undefined), false);
    assert.equal(applySave(null, { version: 1 }), false);
    assert.equal(game.inv.gold, before, '脏数据不能改动游戏状态');
    assert.equal(game.world.player.level, 1);
  });

  test('老存档（缺技能升级三件套）读档时兜底成空表 / 0', () => {
    const game = createGame({});
    game.inv.gold = 10;
    const data = makeSave(game.world, game.inv);
    delete data.inv.skillRanks;
    delete data.inv.skillRefine;
    delete data.inv.skillOrbs;
    storage.setItem(SAVE_KEY, JSON.stringify(data));
    const loaded = loadGame();
    assert.deepEqual(validateSave(loaded), [], '缺失不算错误');
    const fresh = createGame({});
    assert.equal(applySave(fresh, loaded), true);
    assert.deepEqual(fresh.inv.skillRanks, {});
    assert.deepEqual(fresh.inv.skillRefine, {});
    assert.equal(fresh.inv.skillOrbs, 0);
    assert.equal(fresh.inv.gold, 10);
  });

  test('死亡瞬间存档：读档后不会卡在尸体状态', () => {
    const game = createGame({});
    game.world.player.dead = true;
    game.world.player.alive = false;
    game.world.player.hp = 0;
    saveGame(game.world, game.inv);
    const fresh = createGame({});
    assert.equal(applySave(fresh, loadGame()), true);
    assert.equal(fresh.world.player.dead, false);
    assert.equal(fresh.world.player.alive, true);
    assert.ok(fresh.world.player.hp > 0, '应该半血复活');
  });

  test('clearSave 之后 loadGame 返回 null / 开始界面回到「进入神庙」', () => {
    const game = createGame({});
    assert.equal(saveGame(game.world, game.inv), true);
    assert.ok(loadGame());
    assert.ok(getSaveSummary(loadGame()));
    clearSave();
    assert.equal(loadGame(), null);
    assert.equal(getSaveSummary(null), null);
  });

  test('存档摘要：等级 / 层数 / 金币 / 游戏时长', () => {
    const game = createGame({});
    game.world.player.level = 9;
    game.world.tier = 3;
    game.inv.gold = 1500;
    game.world.career.playTime = 3725;
    const sum = getSaveSummary(makeSave(game.world, game.inv));
    assert.equal(sum.level, 9);
    assert.equal(sum.tier, 3);
    assert.equal(sum.gold, 1500);
    assert.equal(sum.playTime, 3725);
    assert.equal(formatPlayTime(3725), '1 小时 2 分');
    assert.equal(formatPlayTime(65), '1 分 5 秒');
    assert.equal(formatPlayTime(12), '12 秒');
    assert.equal(formatSaveAge(Date.now()), '刚刚');
    assert.equal(formatSaveAge(Date.now() - 5 * 60 * 1000), '5 分钟前');
    assert.equal(formatSaveAge(0), '');
  });
});

// ---------------------------------------------------------------------------
// 3) main.js 的"全局状态写法规约"
// ---------------------------------------------------------------------------
// tests/pause.test.mjs 会把 src/ui/main.js 剥成裸函数在 vm 沙箱里跑，并用
// `get game() { return fakeGame; }` 这类**不可写**访问器注入同名全局。踩过三个坑：
//   ① `let game = null` → 模块作用域遮蔽注入的全局，frame() 读到 null（updateGame 一帧都没跑）；
//   ② 裸赋值 `game = x` → 单文件包（外部环境被当成"全局词法环境"）抛 ReferenceError，启动即崩；
//   ③ 沙箱里写注入的 getter 会抛。
// 所以约定：**读**用裸名字，**写**统一 setState()；input 必须真实声明且用 var（let 有 TDZ 坑）。
describe('main.js 全局状态写法规约', () => {
  test('game/ui/renderer/running/lastT/acc/input 不声明；写操作走 setState；纯赋值不出现', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/ui/main.js', import.meta.url), 'utf8');
    const globals = ['game', 'ui', 'renderer', 'running', 'lastT', 'acc'];
    for (const name of globals) {
      const decl = new RegExp(`^\\s*(?:let|const|var)\\s+${name}\\b`, 'm');
      assert.equal(decl.test(src), false, `${name} 不能在模块里声明（会遮蔽 vm 沙箱注入的同名全局）`);
    }
    assert.ok(/^var input = null;/m.test(src), 'input 必须用 var 声明（用 let 会有 TDZ 坑，沙箱里也没有注入）');
    // 裸赋值：对**未声明**的 game/ui/renderer… 仍一律禁止（打包环境会 ReferenceError）。
    // 【例外】input 是本文件里用 var 真实声明过的局部状态（沙箱也不注入它），
    // 裸赋值完全合法 —— 实测 vm 里 `var input` 之后裸赋值不会抛。
    for (const name of globals) {
      const bare = new RegExp(`^\\s*${name}\\s*(?:\\+=|-=|=)(?!=)`, 'm');
      assert.equal(bare.test(src), false, `${name} 不能裸赋值（单文件包里会 ReferenceError），应走 setState()`);
    }
    // 【关键回归】input 是局部变量，必须真的被赋上 Input 实例。
    // 曾经只写 setState('input', ...)，全局有了、局部还是 null →
    // readInput() 走"没有输入"的降级分支 → 移动/普攻/技能/翻滚全部失灵，且不报错。
    assert.ok(/^\s*input\s*=\s*getState\('input'\)/m.test(src),
      'input 必须显式回写（input = getState(\'input\')），否则 readInput 永远读到 null');
    // 至少要有一次真实写入走适配器（否则游戏永远启动不了）
    assert.ok(/setState\('game', createGame\(\{[^}]*\}\)\)/.test(src), 'startGame 里应通过 setState 写 game');
    assert.ok(/function setState\(/.test(src) && /function getState\(/.test(src), 'setState/getState 适配器应存在');
  });
});

// ---------------------------------------------------------------------------
// 4) 快捷键路由表（静态契约：main.js 的 HOTKEYS 是唯一真相）
// ---------------------------------------------------------------------------
describe('快捷键路由表', () => {
  test('main.js 里不再有第二套面板快捷键（Tab 只走 HOTKEYS 一条路径）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/ui/main.js', import.meta.url), 'utf8');
    // 旧的 window 捕获阶段 toggleSkills 必须已删除（否则一次 Tab 会开关两次）
    assert.equal(/addEventListener\('keydown',\s*\(e\)\s*=>\s*\{[\s\S]{0,200}toggleSkills/.test(src), false);
    // 路由表存在且覆盖契约要求的所有键
    const keys = ['Escape', 'KeyC', 'KeyP', 'KeyK', 'KeyI', 'KeyE', 'Tab', 'KeyM', 'KeyR', 'KeyT'];
    for (const k of keys) {
      assert.ok(src.includes(k + ':'), 'HOTKEYS 应该包含 ' + k);
    }
    // 面板路由统一走 openPanelRoute / ui.openPanel
    assert.ok(src.includes('openPanelRoute'), '应使用统一入口 openPanelRoute');
    assert.ok(src.includes("typeof ui.openPanel === 'function'"), '应对 ui.openPanel 判型兜底');
    assert.ok(src.includes("typeof ui.handleEscape === 'function'"), '应对 ui.handleEscape 判型兜底');
    // 存档接线
    assert.ok(src.includes('saveGame'), '应调用 saveGame');
    assert.ok(src.includes('applySave'), '应调用 applySave');
  });
});

// ---------------------------------------------------------------------------
// 5) 快捷键分流回归（QA 复核确认过的两个真实缺陷）
// ---------------------------------------------------------------------------
// 做法：把 src/ui/main.js 剥掉 import 后在 vm 沙箱里执行，用**假 window / 假 ui / 假 game**
// 还原真实布局——沙箱里放一套「测试自己的」全局（main.js 的 game/ui/input 读的就是这些名字），
// 和 pause.test.mjs 用的是同一套思路，但这里不需要真实游戏循环。
/** 把 main.js 剥成裸函数集合，返回可在沙箱里执行的脚本 */
async function loadMainHarness() {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const src = fs.readFileSync(new URL('../src/ui/main.js', import.meta.url), 'utf8');
  const stripped = src
    .replace(/^import[\s\S]*?from\s*'[^']+';?$/gm, '')
    .replace(/^if \(typeof location !== 'undefined'[\s\S]*?startGame\(\);$/m, '')
    .replace(/^window\.__game = [\s\S]*$/m, '');
  return {
    vm,
    script: new vm.Script(
      '(function(){ ' + stripped + '\n return { handleKeydown, runHotkey, readInput, isInputBlocked, isWorldPaused, keyRole, playerMoveDir,'
      + ' setInput: (v) => { input = v; },'
      + ' info: () => ({ pending: Array.from(_pendingHotkeys), running }) }; })()',
      { filename: 'main-stripped.js' },
    ),
  };
}

/** 假 ui：记录调用；openPanel/togglePause 都按真实 ui.js 的语义简化实现 */
function makeFakeUI(game) {
  const calls = { openPanel: [], escape: 0, closeModals: 0, pauseKey: [], toggleSfx: 0, addLog: [] };
  const ui = {
    modalOpen: null,
    paused: false,
    calls,
    openPanel(kind) { calls.openPanel.push(kind); return ui.modalOpen; },
    handleEscape() {
      calls.escape++;
      if (ui.modalOpen) { ui.modalOpen = null; calls.closeModals++; return 'panel'; }
      ui.paused = !ui.paused; game.paused = ui.paused;
      return ui.paused ? 'paused' : 'resumed';
    },
    closeModals() { calls.closeModals++; ui.modalOpen = null; },
    isPaused() { return !!(ui.paused || game.paused); },
    isPauseMenuOpen() { return !!(ui.pauseMenuOpen && !ui.modalOpen); },
    toggleSfx() { calls.toggleSfx++; },
    addLog(m) { calls.addLog.push(m); },
    onMapChange() {},
    handlePauseKey(e) {
      calls.pauseKey.push(e.key || e.code);
      return true; // 与真实 ui.js 一致：暂停时游戏键一律吞掉
    },
  };
  return ui;
}

/** 造一个最小沙箱：window 收集 keydown、document/window.__dbg 可写 */
function makeSandbox(script, vm, { running = true, ui = null, game = null, input = null } = {}) {
  const listeners = {};
  const win = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    devicePixelRatio: 1,
  };
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    window: win,
    document: { getElementById: () => null, body: { classList: { add() {}, remove() {} } }, addEventListener() {} },
    // main.js 读的隐式全局（沙箱注入 = 测试里的假对象）
    game, ui, input,
    running,
    performance,
    location: { search: '' },
    URLSearchParams,
    Math, Date, JSON, Number, String, Object, Array, Set, Map, Promise, Error, Boolean, isFinite, parseInt, parseFloat,
  };
  Object.setPrototypeOf(sb, null); // 避免继承 Node 的 global（防止污染 running/ui 等）
  const api = script.runInNewContext(sb);
  // main.js 在剥掉 import 后的裸函数里用 `var input` 保存 Input 实例（见 main.js 顶部注释），
  // 所以直接塞进沙箱全局是读不到的；必须通过 harness 暴露的 setInput 写回模块内变量，
  // 否则 readInput() 永远走"没有输入"的降级分支（这正是本测试要守住的回归）。
  if (input && typeof api.setInput === 'function') api.setInput(input);
  /** 派发一个 keydown（走真实注册的捕获监听） */
  const NAMED = /^(?:Arrow|Enter|Escape|Tab|Space|Backspace|Delete|Home|End|Page|Shift|Control|Alt)/;
  const key = (name, opts = {}) => {
    const isCode = name.length > 1; // 'KeyP' / 'ArrowDown' / 'Digit2' / 'Escape'
    const e = {
      code: isCode ? name : 'Key' + name.toUpperCase(),
      // 与浏览器一致：Escape/Tab/Arrow* 这种"命名键"的 e.key 原样保留，只有 KeyX/DigitN 才是字符
      key: opts.key !== undefined ? opts.key
        : !isCode ? name
          : NAMED.test(name) ? name
            : name.startsWith('Key') ? name.slice(3).toLowerCase()
              : name.startsWith('Digit') ? name.slice(5) : name,
      repeat: false,
      target: null,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...opts,
    };
    for (const fn of listeners.keydown || []) fn(e);
    return e;
  };
  return { api, sandbox: sb, vm, key, listeners };
}

describe('快捷键分流回归（面板不被阻塞 / 暂停可恢复）', () => {
  let harness;
  before(async () => { harness = await loadMainHarness(); });

  test('BUG1：面板已打开时 runHotkey(\'KeyP\') 仍然切到天赋面板（不再被 isInputBlocked 挡掉）', () => {
    const game = createGame({});
    const ui = makeFakeUI(game);
    const env = makeSandbox(harness.script, harness.vm, { running: true, ui, game });
    // 模拟"属性面板正开着"
    ui.modalOpen = 'stats';
    assert.equal(env.api.isInputBlocked(), true, '面板打开时输入确实被阻塞（角色不该动）');

    // 老实现在这里会直接 return false（面板键永远到不了 openPanelRoute）
    assert.equal(env.api.runHotkey('KeyP'), true, '面板打开时 P 必须仍然有效');
    assert.deepEqual(ui.calls.openPanel, ['talents'], '应调用 ui.openPanel(\'talents\')');

    // 同一套逻辑对 C / K / I / Tab 都成立。
    // 【键位变更】E 现在是「3 号技能键」，只有当 3 号格子被清空时才退回背包快捷键（见 legacyHotkey）；
    // 所以这里改用没被技能占用的 F（拾取）验证「非面板类热键」的另一条通道。
    ui.calls.openPanel.length = 0;
    for (const k of ['KeyC', 'KeyK', 'KeyI', 'Tab']) assert.equal(env.api.runHotkey(k), true, k + ' 在面板打开时必须有效');
    assert.deepEqual(ui.calls.openPanel, ['stats', 'skills', 'inventory', 'skills']);
  });

  test('键位：E/R/T 让给技能槽、F 拾取，且 Q~T 与方向键的仲裁符合"方向键移动 + QWERT 技能"', () => {
    const game = createGame({});
    const ui = makeFakeUI(game);
    const input = { keys: new Set() };
    const env = makeSandbox(harness.script, harness.vm, { running: true, ui, game, input });
    // 默认技能栏 5 格都有技能 → Q W E R T 全是技能键
    for (const k of ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT']) {
      assert.equal(env.api.keyRole(k), 'skill', k + ' 默认应是技能键');
    }
    // 方向键是移动键；W 让给技能后不再移动
    assert.equal(env.api.keyRole('ArrowUp'), 'move');
    assert.equal(env.api.keyRole('ArrowDown'), 'move');
    assert.equal(env.api.keyRole('ArrowLeft'), 'move');
    assert.equal(env.api.keyRole('ArrowRight'), 'move');
    assert.equal(env.api.keyRole('KeyA'), 'move');
    assert.equal(env.api.keyRole('KeyS'), 'move');
    assert.equal(env.api.keyRole('KeyD'), 'move');
    // F 拾取：不占技能键
    assert.equal(env.api.keyRole('KeyF'), 'legacy');
    // 3 号格子清空后：E 退回背包快捷键、W 仍在（2 号格子有技能）
    game.world.player.skillBar[2] = null;
    assert.equal(env.api.keyRole('KeyE'), 'legacy');
    assert.equal(env.api.keyRole('KeyW'), 'skill');
  });

  test('键位：input 只按方向键 → readInput 给出移动向量（角色真的会走）', () => {
    const game = createGame({});
    const ui = makeFakeUI(game);
    // 【注意】沙箱里的 input 用**沙箱自己的** Set（main.js 里 `input.keys instanceof Set` 判型）。
    // 这里把按键集合定义成沙箱求值的表达式，确保容器类型与 main.js 看到的一致。
    const input = {
      keys: null, // 下面换成沙箱内自己的 Set（见 useKeys）
      mouse: { x: 0, y: 0, down: false, rightDown: false },
      wasPressed: () => false,
      takeQueuedSkills: () => [],
      takeQueuedDash: () => false,
      clearPressed: () => {},
      endFrame: () => {},
    };
    const env = makeSandbox(harness.script, harness.vm, { running: true, ui, game, input });
    // main.js 用 `input.keys instanceof Set` 判型，而 vm 沙箱有自己的 Set 内建，
    // 直接塞 Node 的 Set 会被判成"不是集合"→ 移动恒为 0（真实浏览器里不存在这个问题）。
    // 所以按键集合必须在沙箱里创建。
    const useKeys = (...codes) => {
      const s = harness.vm.runInContext('new Set()', env.sandbox);
      for (const c of codes) s.add(c);
      input.keys = s;
    };
    useKeys('ArrowDown', 'ArrowRight');
    const cmd = env.api.readInput({ x: 0, z: 0 });
    // 【不要用 deepEqual 比较沙箱返回对象】返回值由 vm 沙箱里的 Object/Array 构造，
    // 与 Node 侧字面量原型不同，node:assert/strict 会判失败；逐字段比较才稳定。
    assert.ok(cmd.move.x > 0 && cmd.move.z > 0, '↓ + → 应得到右下方向的单位向量，实际 ' + JSON.stringify(cmd.move));
    assert.ok(Math.abs(Math.hypot(cmd.move.x, cmd.move.z) - 1) < 1e-9, '方向已归一化');
    // 按住 W（2 号技能键）不应产生移动
    useKeys('KeyW');
    const cmd2 = env.api.readInput({ x: 0, z: 0 });
    assert.equal(cmd2.move.x, 0, '按住 W 不该移动（W 是 2 号技能）');
    assert.equal(cmd2.move.z, 0, '按住 W 不该移动（W 是 2 号技能）');
    assert.equal(cmd2.skills.length, 1, '按住 W 应施放 1 个技能');
    assert.equal(cmd2.skills[0], 'whirlwind', '按住 W 应施放 2 号技能（旋风斩）');
  });

  test('BUG1：面板打开时"世界动作"热键仍被拦住（R 拾取 / T 换图不在面板里误触发）', () => {
    const game = createGame({});
    const ui = makeFakeUI(game);
    const env = makeSandbox(harness.script, harness.vm, { running: true, ui, game });
    ui.modalOpen = 'skills';
    const tierBefore = game.world.tier;
    assert.equal(env.api.runHotkey('KeyT'), false, '面板里按 T 不该换图');
    assert.equal(env.api.runHotkey('KeyR'), false, '面板里按 R 不该拾取');
    assert.equal(game.world.tier, tierBefore, '地图层数不变');
  });

  test('BUG2：暂停时捕获层按 ESC 同步走到 escapeRoute（不依赖 readInput / frame 推进）', () => {
    const game = createGame({});
    const ui = makeFakeUI(game);
    const env = makeSandbox(harness.script, harness.vm, { running: true, ui, game });
    // 进入暂停：ui 与 game 双写（真实 ui.js 的 togglePause 就是这么做的）
    ui.paused = true;
    game.paused = true;
    ui.pauseMenuOpen = true;

    const e = env.key('Escape');
    assert.equal(e.defaultPrevented, true, 'ESC 应 preventDefault');
    assert.equal(ui.calls.escape, 1, '暂停时 ESC 必须同步调用 handleEscape（readInput 不会来消费队列）');
    assert.equal(ui.paused, false, 'ESC 后应该解除暂停');
    assert.equal(game.paused, false);
    // 关键：没有被塞进等待 readInput 消费的队列（暂停时 readInput 根本不跑，入队=石沉大海）
    assert.deepEqual(env.api.info().pending, [], '暂停期间的 ESC 不能留在 pendingHotkeys 里');
  });

  test('BUG2：暂停中面板打开时 ESC 只关面板（暂停保持），再按一次才恢复游戏', () => {
    const game = createGame({});
    const ui = makeFakeUI(game);
    const env = makeSandbox(harness.script, harness.vm, { running: true, ui, game });
    ui.paused = true;
    game.paused = true;
    ui.modalOpen = 'talents';

    env.key('Escape');
    assert.equal(ui.modalOpen, null, '第一次 ESC 关面板');
    assert.equal(ui.paused, true, '关面板后仍然暂停（恢复要再按一次 ESC）');
    env.key('Escape');
    assert.equal(ui.paused, false, '第二次 ESC 恢复游戏');
    assert.equal(ui.calls.escape, 2);
  });

  test('BUG2：暂停时其它键交给 ui.handlePauseKey（返回值=true 才吞掉，避免与暂停菜单双触发）', () => {
    const game = createGame({});
    const ui = makeFakeUI(game);
    const env = makeSandbox(harness.script, harness.vm, { running: true, ui, game });
    ui.paused = true;
    game.paused = true;
    for (const code of ['ArrowDown', 'Enter', 'Digit2', 'KeyW']) {
      const e = env.key(code);
      assert.equal(e.defaultPrevented, true, code + ' 在暂停时应被吞掉');
    }
    assert.deepEqual(ui.calls.pauseKey, ['ArrowDown', 'Enter', '2', 'w'], '每个键都应转交给 handlePauseKey');
    assert.deepEqual(env.api.info().pending, [], '暂停时的按键绝不能进入游戏热键队列');
  });

  test('正常游戏中：热键入队、由 flushHotkeys 消费一次（不在捕获层直接执行）', () => {
    const game = createGame({});
    const ui = makeFakeUI(game);
    const env = makeSandbox(harness.script, harness.vm, { running: true, ui, game });
    env.key('KeyP');
    assert.deepEqual(env.api.info().pending, ['KeyP'], '正常态先入队');
    assert.deepEqual(ui.calls.openPanel, [], '捕获层自己不能执行（否则会和 readInput 双触发）');
    // 与 readInput 中"执行队列"等价的一步
    for (const name of env.api.info().pending.slice()) env.api.runHotkey(name);
    assert.deepEqual(ui.calls.openPanel, ['talents'], '消费后恰好触发一次');
  });
});