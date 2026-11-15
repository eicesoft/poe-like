// 交互链路验收（不依赖浏览器）：用真实 Input + 真实 core + DOM 桩，
// 把「按 W 移动 / 按 1 放技能 / 空格翻滚 / 点技能格子施法」全部跑一遍并断言结果。
// 用法：node tools/input-check.mjs
import { createGame, updateGame } from '../src/game/app.js';
import { Input, SKILL_KEYS } from '../src/game/input.js';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${msg}${extra ? '\n    ' + extra : ''}\x1b[0m`); }
};

// ---- 最小 window / canvas 桩 ----
const listeners = {};
globalThis.window = {
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: () => {},
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, performance,
  location: { search: '' },
};
globalThis.document = { getElementById: () => null, body: { classList: { add() {}, remove() {} } }, addEventListener() {} };
const canvasListeners = {};
const canvas = {
  addEventListener: (t, fn) => { (canvasListeners[t] = canvasListeners[t] || []).push(fn); },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  clientWidth: 1280, clientHeight: 720,
};
const fire = (t, e = {}) => { for (const fn of (listeners[t] || []).slice()) fn({ type: t, preventDefault() {}, stopPropagation() {}, ...e }); };
const fireCanvas = (t, e = {}) => { for (const fn of (canvasListeners[t] || []).slice()) fn({ type: t, preventDefault() {}, stopPropagation() {}, ...e }); };

const KEY = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyQ: 'q', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyF: 'f', Digit1: '1', Digit2: '2', Space: ' ' };
const down = (code) => fire('keydown', { code, key: KEY[code] ?? code });
const up = (code) => fire('keyup', { code, key: KEY[code] ?? code });

const game = createGame({ seed: 42 });
const input = new Input(canvas);
const p = game.world.player;

/** 与 main.js readInput() 同语义（方向键移动 + QWERT 技能 + 数字键别名） */
function cmd() {
  const skills = [];
  const bar = p.skillBar || [];
  let any = false;
  for (let i = 0; i < SKILL_KEYS.length; i++) if (input.keys.has(SKILL_KEYS[i].code)) { skills.push(bar[i] && bar[i].id); any = true; }
  for (let i = 0; i < 5; i++) if (input.keys.has('Digit' + (i + 1))) { skills.push(bar[i] && bar[i].id); any = true; }
  for (const id of input.takeQueuedSkills()) skills.push(id);
  const rmb = !!input.mouse.rightDown;
  if (rmb && bar[1] && bar[1].id === 'whirlwind') { skills.push('whirlwind'); any = true; }
  const dash = input.wasPressed('Space') || input.takeQueuedDash();
  return { move: moveDir(), aim: { x: p.x, z: p.z - 3 }, attackHeld: !!input.mouse.down, skills: skills.filter(Boolean), dash, releaseChannels: !any && !input.mouse.down && !rmb };
}
/** 与 main.js playerMoveDir() 同语义：W 只有在不是技能槽时才算移动键 */
function moveDir() {
  let x = 0, z = 0;
  const down_ = (c) => input.keys.has(c);
  const wMoves = !(p.skillBar[1] && p.skillBar[1].id);
  if (down_('ArrowUp') || (down_('KeyW') && wMoves)) z -= 1;
  if (down_('ArrowDown') || down_('KeyS')) z += 1;
  if (down_('ArrowLeft') || down_('KeyA')) x -= 1;
  if (down_('ArrowRight') || down_('KeyD')) x += 1;
  const l = Math.hypot(x, z);
  if (l > 0) { x /= l; z /= l; }
  return { x, z };
}
function step(n) {
  for (let i = 0; i < n; i++) { updateGame(game, 1 / 60, cmd()); input.endFrame(); }
}

console.log('\n\x1b[1m输入与交互链路验算\x1b[0m');
console.log(`场景：第 ${game.world.tier} 层 · 角色 (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);

// ---- 1) 键盘移动 ----
console.log('\n▸ 键盘移动（方向键 / WASD）');
{
  const x0 = p.x, z0 = p.z;
  down('ArrowUp');
  ok(cmd().move.z === -1, '按 ↑ → 方向 (0,-1)');
  step(30);
  const moved = Math.hypot(p.x - x0, p.z - z0);
  ok(moved > 0.5, '按住 ↑ 0.5s → 角色位移 ' + moved.toFixed(2));
  up('ArrowUp');
  const x1 = p.x, z1 = p.z;
  step(20);
  ok(Math.hypot(p.x - x1, p.z - z1) < 0.3, '松开 ↑ → 停下（位移 ' + Math.hypot(p.x - x1, p.z - z1).toFixed(2) + '）');
  // 四向方向键
  for (const [code, ex, ez] of [['ArrowUp', 0, -1], ['ArrowDown', 0, 1], ['ArrowLeft', -1, 0], ['ArrowRight', 1, 0]]) {
    down(code);
    const mv = cmd().move;
    ok(Math.abs(mv.x - ex) < 1e-9 && Math.abs(mv.z - ez) < 1e-9, `按 ${code} → 方向 (${ex},${ez})`);
    up(code);
  }
  // W 是 2 号技能键，按住它不该移动；A/S/D 仍然可以移动
  down('KeyW');
  const wm = cmd().move;
  ok(wm.z === 0, '按住 W（2 号技能键）不移动');
  up('KeyW');
  down('KeyD');
  ok(cmd().move.x === 1, '按 D → 方向 (1,0)（A/S/D 仍可移动）');
  up('KeyD');
}

// ---- 2) 键盘技能（Q W E R T）----
console.log('\n▸ 键盘技能（Q W E R T）');
{
  for (let i = 0; i < SKILL_KEYS.length; i++) {
    const code = SKILL_KEYS[i].code;
    const inst = p.skillBar[i];
    if (!inst) continue;
    // 等前摇结束，保证每次按键都真的能结算
    for (let k = 0; k < 60 && (p.castLock || 0) > 0; k++) step(1);
    p.cooldowns[inst.id] = 0;
    down(code);
    const seen = cmd().skills.includes(inst.id);
    step(2);
    up(code);
    step(1); // 松开那一帧：持续施法（旋风斩）在这里结算成冷却
    // 非持续技能：按下即进冷却；旋风斩这类 channel 技能：按住旋转、松开后才进冷却
    const fired = (p.cooldowns[inst.id] || 0) > 0 || !!(inst.active || inst.holding);
    ok(seen && fired,
      `按 ${SKILL_KEYS[i].label} → ${inst.id} 生效（冷却 ${(p.cooldowns[inst.id] || 0).toFixed(2)}s${inst.channel ? ' · 按住持续' : ''}）`);
  }
  for (let k = 0; k < 60 && (p.castLock || 0) > 0; k++) step(1);
  for (let k = 0; k < 60 && (input.keys.size > 0); k++) step(1);
  p.cooldowns.dash = 0;
  down('Space');
  step(2);
  up('Space');
  ok((p.cooldowns.dash || 0) > 0, `按空格 → 翻滚冷却 ${(p.cooldowns.dash || 0).toFixed(2)}s`);
}

// ---- 2b) 数字键别名 ----
console.log('\n▸ 数字键 1-5（旧习惯，仍然可用）');
{
  // 先让所有持续施法/前摇结束（旋风斩按住会一直持续）→ 用一个非持续技能验证
  for (let k = 0; k < 60 && (p.castLock || 0) > 0; k++) step(1);
  const idx = SKILL_KEYS.findIndex((k) => p.skillBar[k.idx] && !p.skillBar[k.idx].channel);
  const inst = p.skillBar[idx >= 0 ? idx : 0];
  p.cooldowns[inst.id] = 0;
  down('Digit' + (inst ? idx + 1 : 1));
  const seen = cmd().skills.includes(inst.id);
  step(2);
  up('Digit' + (idx + 1));
  ok(seen && (p.cooldowns[inst.id] || 0) > 0, `按 ${idx + 1} → ${inst.id} 进入冷却 ${(p.cooldowns[inst.id] || 0).toFixed(2)}s`);
}

// ---- 3) 点技能格子（按钮）----
console.log('\n▸ 技能栏按钮（鼠标点击）');
{
  // 等前摇（castLock）结束：上一步按 1 触发的 stomp 带 0.3s 施法锁，
  // 锁住期间 tryCast 会直接 return false —— 这是设计行为，不是"点击无效"。
  for (let i = 0; i < 40 && (p.castLock || 0) > 0; i++) step(1);
  // 前面用 Q~T 把 5 个技能都放过一轮，蓝量/冷却可能还没回满：这里先把 3 号技能补齐
  const id = p.skillBar[2].id;
  p.mp = p.maxMp;
  p.cooldowns[id] = 0;
  ok(input.queueSkill(id), `点击 3 号格子 → queueSkill(${id})`);
  step(2);
  ok((p.cooldowns[id] || 0) > 0, `点击后 ${id} 进入冷却 ${(p.cooldowns[id] || 0).toFixed(2)}s ${p.mp < p.maxMp ? '（蓝量 ' + Math.round(p.mp) + '/' + Math.round(p.maxMp) + '）' : ''}`);
  const cd1 = p.cooldowns[id];
  step(10);
  ok(p.cooldowns[id] <= cd1, '只施放一次（不会每帧连放）');
  // 翻滚：等前摇结束再点
  for (let i = 0; i < 40 && (p.castLock || 0) > 0; i++) step(1);
  p.cooldowns.dash = 0;
  input.queueDash();
  step(2);
  ok((p.cooldowns.dash || 0) > 0, '点击翻滚格子 → 翻滚生效');
}

// ---- 4) 面板打开时点击不应施法 ----
console.log('\n▸ 焦点守卫');
{
  const id = p.skillBar[0].id;
  p.cooldowns[id] = 0;
  input.setGameKeysEnabled(false);
  ok(input.queueSkill(id) === false, '面板打开时点击技能格被忽略');
  down('ArrowUp');
  ok(cmd().move.z === 0, '面板打开时按 ↑ 不移动');
  up('ArrowUp');
  down('KeyQ');
  ok(cmd().skills.length === 0, '面板打开时按 Q 不放技能');
  up('KeyQ');
  input.setGameKeysEnabled(true);
  ok(input.queueSkill(id) === true, '关闭面板后点击恢复');
}

// ---- 5) 鼠标瞄准 ----
console.log('\n▸ 鼠标');
{
  fireCanvas('mousemove', { clientX: 1280, clientY: 360 });
  ok(input.mouse.x === 1280 && input.mouse.y === 360, `mousemove 坐标 = (${input.mouse.x}, ${input.mouse.y})`);
  fireCanvas('mousedown', { button: 0, clientX: 1280, clientY: 360 });
  ok(input.mouse.down === true, '左键按下被记录');
  fire('mouseup', { button: 0 });
  ok(input.mouse.down === false, '左键松开被记录');
  fireCanvas('mousedown', { button: 2 });
  ok(input.mouse.rightDown === true, '右键按下（持续施法）被记录');
  fire('mouseup', { button: 2 });
  ok(input.mouse.rightDown === false, '右键松开被记录');
}

console.log(`\n\x1b[1m${fail === 0 ? '\x1b[32m' : '\x1b[31m'}通过 ${pass}，失败 ${fail}\x1b[0m\n`);
process.exitCode = fail ? 1 : 0;
// 显式退出：core 里可能留下定时器/句柄
setTimeout(() => process.exit(fail ? 1 : 0), 50).unref?.();