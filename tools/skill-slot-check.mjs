// DOM 桩验收：确认技能栏的 7 个格子**真的**绑上了 click，并且点下去会进输入队列。
// 覆盖 ui.js 的 _bindSkillSlots / _activateSkillSlot（纯浏览器侧逻辑，不需要 canvas）。
// 用法：node tools/skill-slot-check.mjs
import { createGame } from '../src/game/app.js';
import { SKILL_KEYS } from '../src/game/input.js';
import { installStubDOM } from '../tests/_pausehelpers.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${msg}${extra ? '\n    ' + extra : ''}\x1b[0m`); }
};

const dom = installStubDOM();
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const { GameUI } = await import('../src/ui/ui.js');
const game = createGame({ seed: 3 });
const ui = new GameUI(game);

// 假 Input：只记录 queueSkill / queueDash 被调了什么
const calls = { skills: [], dash: 0 };
const fakeInput = {
  queueSkill(id) { calls.skills.push(id); return true; },
  queueDash() { calls.dash++; return true; },
};
ui.input = fakeInput;

// #skill-notify 角标也会被追加到 #skillbar 里（ui.js _ensureSkillNotify），所以按 class 过滤
const slots = dom.byId.skillbar.children.filter((n) => String(n.className || '').split(/\s+/).includes('slot'));
console.log('\n\x1b[1m技能栏按钮绑定验算\x1b[0m');
ok(slots.length === 7, `技能栏有 7 个格子（实际 ${slots.length}）`);

const clickListeners = slots.map((s) => (s._listeners && s._listeners.click ? s._listeners.click.length : 0));
ok(clickListeners.every((n) => n > 0), '7 个格子都绑定了 click 监听器（实际：' + clickListeners.join(',') + '）');

// 点 1-5 号格子 → 对应技能 id
for (let i = 0; i < 5; i++) {
  const before = calls.skills.length;
  slots[i].dispatch('click', { target: slots[i] });
  const got = calls.skills.slice(before);
  ok(got.length === 1 && got[0] === game.world.player.skillBar[i].id, `点第 ${i + 1} 格 → queueSkill(${game.world.player.skillBar[i].id})`);
}

// 5 号格子（翻滚）
const dashBefore = calls.dash;
slots[5].dispatch('click', { target: slots[5] });
ok(calls.dash === dashBefore + 1, '点「空格」格 → queueDash');

// 面板打开 / 暂停时，点击不应施法
const skillsBefore = calls.skills.length;
ui.modalOpen = 'skills';
slots[0].dispatch('click', { target: slots[0] });
ok(calls.skills.length === skillsBefore, '面板打开时点技能格被忽略（modalOpen=skills）');
ui.modalOpen = null;
ui.paused = true;
slots[0].dispatch('click', { target: slots[0] });
ok(calls.skills.length === skillsBefore, '暂停时点技能格被忽略（paused=true）');
ui.paused = false;

// 悬停提示仍然工作（mouseenter 不能被 click 改写掉）
const hoverListeners = slots.map((s) => (s._listeners && s._listeners.mouseenter ? s._listeners.mouseenter.length : 0));
ok(hoverListeners.every((n) => n === 1), '悬停提示监听器未被破坏（每格 1 个）');

ok(slots[0].getAttribute('role') === 'button', '格子带 role=button（可访问性）');

// ---- 键位角标：HUD 上写的必须是真按的键（Q W E R T / 空格 / 🏕）----
// 注：HUD 更新由主循环（README 里的 ui.update）每帧驱动；这里显式调一次同步再断言。
if (typeof ui.syncSkillSlotLabels === 'function') ui.syncSkillSlotLabels();
const keyLabel = (slot) => {
  const keyEl = slot.querySelector('.key');
  return keyEl ? String(keyEl.textContent || '').trim() : '';
};
const labels = slots.map(keyLabel);
ok(labels.slice(0, 5).join('') === 'QWERT', `1~5 号格子角标为 Q W E R T（实际 ${labels.slice(0, 5).join(' ')}）`);
ok(labels[5] === '空格', `翻滚格子角标为「空格」（实际 ${labels[5]}）`);
// 角标来自输入层键位表（唯一真相），不是 index.html 里手写的数字
ok(SKILL_KEYS.map((k) => k.label).join('') === labels.slice(0, 5).join(''), '角标与 src/game/input.js 的 SKILL_KEYS 一致');
// 悬停提示里带上键名与技能名
const titles = slots.slice(0, 5).map((s) => String(s.title || ''));
ok(titles.every((t, i) => t.includes(SKILL_KEYS[i].label)), '每格 title 提示里都有对应键名（' + titles[0] + '）');
// 键位表是冻结的（防止运行时被意外改写 → 角标与逻辑漂移）
{
  let threw = false;
  try { SKILL_KEYS[0].label = 'Z'; } catch { threw = true; }
  const objFrozen = Object.isFrozen(SKILL_KEYS[0]);
  if (!objFrozen) SKILL_KEYS[0].label = 'Q'; // 万一没冻结，把自己改回去，别污染后续断言
  ok(threw || objFrozen, `SKILL_KEYS 不可被改写（冻结：数组 ${Object.isFrozen(SKILL_KEYS)} / 元素 ${objFrozen}）`);
  ok(SKILL_KEYS[0].label === 'Q', 'SKILL_KEYS[0].label 仍是 Q');
}

console.log(`\n\x1b[1m${fail === 0 ? '\x1b[32m' : '\x1b[31m'}通过 ${pass}，失败 ${fail}\x1b[0m\n`);
process.exit(fail ? 1 : 0);