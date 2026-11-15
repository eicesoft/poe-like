// @file tests/pause.test.mjs
// ESC 暂停系统 + 暂停菜单（src/ui/pause.js + ui.js 的暂停状态机 + main.js 的 frame()）
//
// 分两层：
//   A. 暂停菜单 / ESC 状态机（可复用的迷你 DOM 桩 + 真实 createGame()）
//        - ESC 语义：有面板 → 关面板；没面板 → 打开暂停；已暂停 → 继续
//        - 暂停中打开属性/天赋面板不解除暂停；关面板回到暂停菜单；ESC 再按一次才继续
//        - 「继续游戏 / 音效 / 保存（不可用 disabled）」按钮回调
//        - 返回主菜单的二次确认（2.5s 内第二次才执行，超时自动复原）
//        - 键盘焦点：↑↓/Tab 循环、Enter 触发当前焦点按钮；暂停时游戏热键被吞
//        - DOM 弱桩（standalone 同款：querySelector 返回新节点、classList 空实现）不抛异常
//   B. 主循环冻结（读真实的 src/ui/main.js 源码，剥掉 import/启动语句后执行帧函数）
//        - 暂停 3 秒：world.time / 怪物坐标 / 血量 / 冷却 / 子弹 / 粒子数量逐位不变
//        - renderer 收到的 dt 必须是「极小正数」而不是 0（0 会被 renderer 改回 1/60）
//        - 恢复后世界继续推进；暂停期间累计的时间不会补帧
import { describe, test, assert, beforeEach } from './_runner.mjs';
import { createGame } from '../src/game/app.js';
import { openSkills } from '../src/ui/skill-ui.js';
import * as appMod from '../src/game/app.js';
import {
  installStubDOM, makeGame, loadUI, withSaveSpy,
} from './_pausehelpers.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// A. ESC 状态机
// ═══════════════════════════════════════════════════════════════════════════
describe('ESC 暂停状态机', () => {
  let dom, game, ui;

  beforeEach(async () => {
    const UI = await loadUI();
    dom = installStubDOM();
    game = makeGame();
    ui = new UI(game);
    game.ui = ui;
  });

  test('初始化：未暂停、没有暂停菜单 DOM（惰性创建）', () => {
    assert.equal(ui.isPaused(), false);
    assert.equal(game.paused, false);
    assert.equal(dom.document.getElementById('pause-menu'), null, '第一次暂停之前不建 DOM');
    assert.equal(ui.pauseMenu, null);
  });

  test('ESC #1：打开暂停菜单并冻结世界（game.paused / game.pauseReason）', () => {
    assert.equal(ui.handleEscape(), 'paused');
    assert.equal(ui.isPaused(), true);
    assert.equal(game.paused, true, 'game.paused 是契约字段（updateGame 里判它）');
    assert.equal(game.pauseReason, 'menu');
    const menu = dom.document.getElementById('pause-menu');
    assert.ok(menu, '暂停菜单 DOM 已创建');
    assert.ok(menu.classList.contains('show'), '覆盖层可见');
    assert.ok(!menu.classList.contains('hidden'));
    assert.ok(ui.pauseMenu && ui.pauseMenu.isOpen === true);
    // 画面去饱和：canvas 挂类
    assert.ok(dom.byId.game.classList.contains('paused-canvas'), 'canvas 去饱和类');
    assert.ok(dom.app.classList.contains('paused'), '#app 暂停类');
  });

  test('ESC #2：关闭暂停菜单并继续（画布恢复原样）', () => {
    ui.handleEscape();
    assert.equal(ui.handleEscape(), 'resumed');
    assert.equal(ui.isPaused(), false);
    assert.equal(game.paused, false);
    assert.equal(game.pauseReason, null);
    const menu = dom.document.getElementById('pause-menu');
    assert.ok(menu.classList.contains('hidden'));
    assert.ok(!menu.classList.contains('show'));
    assert.equal(dom.byId.game.classList.contains('paused-canvas'), false, '去饱和已移除');
    assert.equal(dom.app.classList.contains('paused'), false);
  });

  test('ESC 幂等/往返：连开连关 5 次状态始终正确，DOM 不重复创建', () => {
    for (let i = 0; i < 5; i++) {
      ui.handleEscape();
      assert.equal(ui.isPaused(), true);
      ui.handleEscape();
      assert.equal(ui.isPaused(), false);
    }
    assert.equal(dom.document.querySelectorAll('#pause-menu').length, 1, '#pause-menu 只有一个');
  });

  test('有面板打开时 ESC 只关面板，不会顺手打开暂停菜单', () => {
    ui.openModal('inventory');
    assert.equal(ui.handleEscape(), 'panel');
    assert.equal(ui.modalOpen, null);
    assert.equal(ui.isPaused(), false, '关掉面板不应该触发暂停');
  });

  test('暂停中打开面板：不解除暂停，暂停卡片让位；关面板后回到暂停菜单', () => {
    ui.handleEscape();
    assert.equal(ui.isPaused(), true);
    // 暂停菜单里点「装备」→ 面板打开，暂停保持
    ui.pauseMenu.activate('equipment');
    assert.equal(ui.modalOpen, 'inventory');
    assert.equal(ui.isPaused(), true, '打开面板不解除暂停');
    assert.equal(game.paused, true);
    assert.equal(ui._pauseShown, false, '暂停卡片让位给面板');
    assert.equal(ui.pauseMenu.paused, true, '暂停菜单知道自己处于暂停态（只是让位）');
    assert.ok(dom.byId.game.classList.contains('paused-canvas'), '画面仍然去饱和');
    // ESC：第一下只关面板（回到暂停菜单），第二下才继续
    assert.equal(ui.handleEscape(), 'panel');
    assert.equal(ui.modalOpen, null);
    assert.equal(ui.isPaused(), true, '关掉最后一个面板仍然暂停');
    assert.equal(ui._pauseShown, true, '暂停卡片重新出现');
    assert.equal(ui.handleEscape(), 'resumed');
    assert.equal(ui.isPaused(), false);
  });

  test('暂停中打开属性/天赋/技能面板都可以，并且暂停保持', () => {
    ui.handleEscape();
    for (const act of ['stats', 'talents', 'skills']) {
      ui.pauseMenu.activate(act);
      assert.ok(ui.modalOpen, `${act} 面板应打开`);
      assert.equal(ui.isPaused(), true, `${act}：暂停保持`);
      ui.closeModals();
      assert.equal(ui.isPaused(), true, `${act}：关面板后仍然暂停`);
    }
  });

  test('暂停时面板开着也能正常渲染技能树（真实 openSkills）', () => {
    ui.handleEscape();
    ui.openPanel('skills');
    openSkills(ui);
    assert.equal(ui.isPaused(), true);
    assert.ok(ui.el.modalBody.children.length > 0, '技能树 DOM 已渲染');
    // 收尾：talent-ui 里有一次 rAF/setTimeout 的 resize 回调会读 window.removeEventListener，
    // 留着不关会在测试进程末尾触发、把整个 run-all 打崩（指针落到别的套件上就更难查）。
    ui.closeModals();
    ui.togglePause(false);
  });

  test('togglePause 幂等；暂停菜单的「继续游戏」按钮执行 togglePause(false)', () => {
    assert.equal(ui.togglePause(true), true);
    assert.equal(ui.togglePause(true), true, '重复打开无副作用');
    assert.equal(ui.togglePause(false), false);
    assert.equal(ui.togglePause(false), false, '重复关闭无副作用');
    ui.handleEscape();
    ui.pauseMenu.activate('resume');
    assert.equal(ui.isPaused(), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. 暂停菜单的按钮回调
// ═══════════════════════════════════════════════════════════════════════════
describe('暂停菜单按钮', () => {
  let dom, game, ui;

  beforeEach(async () => {
    const UI = await loadUI();
    dom = installStubDOM();
    game = makeGame();
    ui = new UI(game);
    game.ui = ui;
    ui.handleEscape();
  });

  test('8 个按钮都有 data-act / title / aria-label', () => {
    const btns = dom.document.querySelectorAll('.pause-btn');
    assert.equal(btns.length, 8, '继续/属性/天赋/技能/装备/音效/保存/退出');
    const acts = btns.map((b) => b.getAttribute('data-act'));
    assert.deepEqual(acts.sort(), ['equipment', 'quit', 'resume', 'save', 'sfx', 'skills', 'stats', 'talents']);
    for (const b of btns) {
      assert.ok(b.getAttribute('aria-label'), `${b.getAttribute('data-act')} 有 aria-label`);
      assert.ok(b.getAttribute('title'), `${b.getAttribute('data-act')} 有 title`);
    }
    assert.ok(ui.pauseMenu.summaryText().includes('Lv.'), '摘要包含等级');
  });

  test('每个按钮的 .pb-ico 都是内联 SVG，且 8 个 act 齐全（无 emoji 图标）', async () => {
    const UI = await loadUI();
    const dom = installStubDOM();
    const game = makeGame();
    const ui = new UI(game);
    game.ui = ui;
    ui.handleEscape();
    const html = dom.document.getElementById('pause-menu').innerHTML;
    // ① 8 个 act 齐全
    const acts = (html.match(/data-act="([a-z]+)"/g) || []).map((s) => s.slice(10, -1));
    assert.deepEqual(acts.sort(), ['equipment', 'quit', 'resume', 'save', 'sfx', 'skills', 'stats', 'talents']);
    // ② 每个按钮都有 <span class="pb-ico"> 且内含 <svg
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
    assert.equal(buttons.length, 8, '一共 8 个按钮');
    for (const b of buttons) {
      const act = (b.match(/data-act="([a-z]+)"/) || [])[1];
      assert.ok(/<span class="pb-ico">\s*<svg/.test(b), `${act} 的 .pb-ico 内含 <svg`);
      assert.ok(/viewBox="0 0 24 24"/.test(b), `${act} 使用 24×24 viewBox`);
      assert.ok(/stroke="currentColor"/.test(b) && /fill="none"/.test(b), `${act} 用 currentColor + fill:none`);
      assert.ok(/stroke-width="1\.6"/.test(b), `${act} 描边 1.6`);
      assert.ok(/stroke-linecap="round"/.test(b), `${act} 圆头线帽`);
      assert.ok(/aria-hidden="true"/.test(b) && /focusable="false"/.test(b), `${act} 图标对读屏隐藏`);
    }
    // ③ 按钮区不再有 emoji / 符号图标（旧实现是 ▶ ◈ ✦ ✧ ⬢ 🔊 ❖ ⏹）
    //    只看 <button> 内部：卡片标题的 ❖（.pause-mark）是有意保留的装饰符，不在此列。
    const buttonText = buttons.join("");
    assert.ok(!/[\u25B6\u25C8\u2726\u2727\u2B22\u23F9\u2756\uD83D\uDD0A\uD83D\uDD07]/u.test(buttonText), '按钮区不再有 emoji/符号图标');
    // ④ 静音时切到「喇叭+叉」版本（同样是内联 SVG）
    const sfxIcoBefore = ui.pauseMenu.buttons.sfx.querySelector('.pb-ico').innerHTML;
    ui.pauseMenu.activate('sfx');
    const sfxIcoAfter = ui.pauseMenu.buttons.sfx.querySelector('.pb-ico').innerHTML;
    assert.ok(sfxIcoAfter.includes('<svg'), '静音态仍然是 svg');
    assert.notEqual(sfxIcoAfter, sfxIcoBefore, '静音态换成了叉号版本');
    assert.ok(!/[🔊🔇]/u.test(sfxIcoAfter), '不再使用 emoji 表示音效状态');
    ui.pauseMenu.activate('sfx');
  });

  test('点击「天赋」按钮（真实事件）打开天赋面板且保持暂停', () => {
    const btn = dom.document.querySelectorAll('.pause-btn').find((b) => b.getAttribute('data-act') === 'talents');
    const root = dom.document.getElementById('pause-menu');
    // 模拟浏览器冒泡：点击事件在根节点上被委托处理器接到
    root.dispatch('click', { target: btn });
    assert.equal(ui.modalOpen, 'talents');
    assert.equal(ui.isPaused(), true);
  });

  test('音效按钮调用 ui.toggleSfx()', () => {
    let n = 0;
    ui.toggleSfx = () => { n++; return true; };
    ui.pauseMenu.activate('sfx');
    assert.equal(n, 1);
    ui.pauseMenu.activate('sfx');
    assert.equal(n, 2);
  });

  test('保存按钮：有 game.actions.save 时可用，点击调用它并写日志', () => {
    const calls = withSaveSpy(game, true);
    ui.pauseMenu.render(true);
    const btn = ui.pauseMenu.buttons.save;
    assert.equal(btn.disabled !== true && btn.getAttribute('disabled') == null, true, '可用');
    assert.equal(ui.pauseMenu.activate('save'), true);
    assert.equal(calls(), 1);
    assert.ok(ui.logText(7).join('').includes('保存'));
  });

  test('保存按钮：没有 game.actions.save 时 disabled 且显示「存档不可用」', () => {
    delete game.actions.save;
    ui.pauseMenu.render(true);
    const btn = ui.pauseMenu.buttons.save;
    assert.equal(btn.getAttribute('disabled') != null || btn.disabled === true, true, 'disabled');
    const text = btn.querySelector('.pb-text');
    assert.equal(text.textContent, '存档不可用');
    assert.equal(ui.pauseMenu.activate('save'), false, '不可用时点击无效');
  });

  test('返回主菜单需要二次确认：第一次只进入确认态，2.5s 后自动复原', async () => {
    let quitCalls = 0;
    game.actions.quitToMenu = () => { quitCalls++; return true; };
    const btn = ui.pauseMenu.buttons.quit;
    assert.equal(ui.pauseMenu.activate('quit'), false, '第一次：只进入确认');
    assert.equal(quitCalls, 0, '还没有真的退出');
    assert.equal(ui.pauseMenu.isConfirming, true);
    assert.equal(btn.querySelector('.pb-text').textContent, '确认退出？');
    // 等待超时自动复原
    await new Promise((r) => setTimeout(r, 2600));
    assert.equal(ui.pauseMenu.isConfirming, false, '2.5s 后复原');
    assert.equal(btn.querySelector('.pb-text').textContent, '返回主菜单');
    assert.equal(quitCalls, 0);
  });

  test('返回主菜单二次确认：2.5s 内点第二次才真正执行', () => {
    let quitCalls = 0;
    game.actions.quitToMenu = () => { quitCalls++; return true; };
    ui.pauseMenu.activate('quit');
    assert.equal(ui.pauseMenu.activate('quit'), true);
    assert.equal(quitCalls, 1);
    assert.equal(ui.pauseMenu.isConfirming, false, '执行后清掉确认态');
    assert.equal(ui.pauseMenu.buttons.quit.querySelector('.pb-text').textContent, '返回主菜单');
  });

  test('关闭暂停菜单会清掉确认态（不会带着确认态再次打开）', () => {
    ui.pauseMenu.activate('quit');
    assert.equal(ui.pauseMenu.isConfirming, true);
    ui.togglePause(false);
    assert.equal(ui.pauseMenu.isConfirming, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. 键盘
// ═══════════════════════════════════════════════════════════════════════════
describe('暂停菜单键盘', () => {
  let dom, game, ui;

  beforeEach(async () => {
    const UI = await loadUI();
    dom = installStubDOM();
    game = makeGame();
    ui = new UI(game);
    game.ui = ui;
    ui.handleEscape();
  });

  test('打开时焦点在「继续游戏」，↓/↑ 循环，Tab 与 Shift+Tab 反向', () => {
    assert.equal(ui.pauseMenu.focusedAct, 'resume');
    ui.pauseMenu.handleKey({ key: 'ArrowDown' });
    assert.equal(ui.pauseMenu.focusedAct, 'stats');
    ui.pauseMenu.handleKey({ key: 'ArrowUp' });
    assert.equal(ui.pauseMenu.focusedAct, 'resume');
    ui.pauseMenu.handleKey({ key: 'ArrowUp' });
    assert.notEqual(ui.pauseMenu.focusedAct, 'resume', '↑ 从第一个绕回最后一个');
    ui.pauseMenu.handleKey({ key: 'ArrowDown' });
    assert.equal(ui.pauseMenu.focusedAct, 'resume');
  });

  test('Enter 触发当前焦点按钮；被禁用（存档不可用）的按钮不会被触发', () => {
    let sfx = 0;
    ui.toggleSfx = () => { sfx++; return true; };
    // 移到「继续游戏」以外的按钮：resume → stats → talents ...
    const acts = ui.pauseMenu.focusables.map((b) => b.getAttribute('data-act'));
    assert.deepEqual(acts.sort(), ['equipment', 'quit', 'resume', 'save', 'sfx', 'skills', 'stats', 'talents'], '全部 8 个按钮都可聚焦（存档可用时）');
    // 让存档不可用，再检查它是否还在可聚焦列表里
    delete game.actions.save;
    ui.pauseMenu.render(true);
    assert.equal(ui.pauseMenu.focusables.some((b) => b.getAttribute('data-act') === 'save'), false, '禁用按钮被跳过');
    // 音效按钮：聚焦后按 Enter
    ui.pauseMenu._focusIdx = ui.pauseMenu.focusables.findIndex((b) => b.getAttribute('data-act') === 'sfx');
    assert.ok(ui.pauseMenu.handleKey({ key: 'Enter' }), 'Enter 被消费');
    assert.equal(sfx, 1);
  });

  test('暂停时游戏热键被吞；ESC 走状态机；面板打开时方向键交给面板', () => {
    assert.equal(ui.handlePauseKey({ key: 'KeyW' }), true, 'W 被吞');
    assert.equal(ui.handlePauseKey({ key: 'w', code: 'KeyW' }), true, 'w（e.key）被吞');
    assert.equal(ui.handlePauseKey({ key: '2', code: 'Digit2' }), true, '数字键被吞（key=2 / code=Digit2）');
    assert.equal(ui.handlePauseKey({ key: 'Digit2' }), true, '仅有 code 形式的数字键也被吞');
    assert.equal(ui.handlePauseKey({ key: 'm', code: 'KeyM' }), true, 'M 被吞（暂停菜单里有音效按钮）');
    // 空格＝按下当前高亮的按钮（暂停菜单的桌面 UI 习惯）。
    // 先按 ↓ 移到「属性」（不依赖初始索引），再按空格：应该打开属性面板而不是继续游戏。
    assert.equal(ui.pauseMenu.handleKey({ key: 'ArrowDown' }), true, '方向键被暂停菜单消费');
    assert.equal(ui.pauseMenu.focusedAct, 'stats');
    assert.equal(ui.handlePauseKey({ key: ' ' }), true, '空格被暂停菜单消费（而非翻页）');
    assert.equal(ui.modalOpen, 'stats', '空格触发了当前高亮的「属性」按钮');
    assert.equal(ui.isPaused(), true, '打开属性面板后仍暂停');
    ui.closeModals();
    assert.equal(ui.isPaused(), true, '关掉面板后仍然暂停');
    // 回到「继续游戏」再按空格 → 等同于点「继续游戏」
    // （focusables[0] 一定是「继续游戏」；用索引直接定位，避免环形移动方向的歧义）
    ui.pauseMenu._focusIdx = 0;
    assert.equal(ui.pauseMenu.focusedAct, 'resume');
    assert.equal(ui.handlePauseKey({ key: ' ' }), true);
    assert.equal(ui.isPaused(), false, '空格在「继续游戏」上 = 继续');
    // 再暂停一次：ESC 走状态机关闭
    ui.handleEscape();
    assert.equal(ui.isPaused(), true);
    assert.equal(ui.handlePauseKey({ key: 'Escape' }), true);
    assert.equal(ui.isPaused(), false, 'ESC 已经让游戏继续');
    assert.equal(ui.handlePauseKey({ key: 'KeyW' }), false, '未暂停时不接管');
    // 面板打开时的暂停：↑↓ 只移动暂停菜单焦点，其它键不拦（留给面板）
    ui.handleEscape(); // A→暂停
    ui.openModal('talents'); // 面板压在暂停菜单上（暂停保持）
    assert.equal(ui.isPaused(), true, '打开面板不解除暂停');
    assert.equal(ui.handlePauseKey({ key: 'KeyW' }), false, '面板里按键交给面板');
    assert.equal(ui.handlePauseKey({ key: 'Escape' }), true, '面板里 ESC 仍然被状态机接管');
    assert.equal(ui.modalOpen, null, 'ESC 先只关面板');
    assert.equal(ui.isPaused(), true, '关掉面板后仍然暂停');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. 弱 DOM（standalone 同款桩）必须静默降级
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// D0. 单实例接管 + 样式段落存在性（回归：曾被并发整文件写覆盖过）
// ═══════════════════════════════════════════════════════════════════════════
describe('暂停菜单：单实例接管 & 样式段落', () => {
  test('第二个 GameUI 实例接管现有的 #pause-menu，不新建第二份，也不双触发', async () => {
    const UI = await loadUI();
    const dom = installStubDOM();
    const gameA = makeGame();
    const uiA = new UI(gameA);
    gameA.ui = uiA;
    uiA.handleEscape();
    const menuA = dom.document.getElementById('pause-menu');
    assert.ok(menuA, '第一张暂停卡已创建');
    // 第二个 UI（模拟重开游戏 / 第二个 GameUI 实例）
    const gameB = makeGame();
    const uiB = new UI(gameB);
    gameB.ui = uiB;
    uiB.handleEscape();
    const cards = dom.document.querySelectorAll('#pause-menu');
    assert.equal(cards.length, 1, '页面上只有一张暂停卡');
    assert.equal(dom.document.getElementById('pause-menu'), menuA, '复用同一个节点（不是新建的）');
    assert.equal(uiB.pauseMenu.root, menuA, '第二个实例接管了旧节点');
    // 计数点击：只能被触发一次
    let sfxCount = 0;
    uiA.toggleSfx = () => { sfxCount += 1; return true; };
    uiB.toggleSfx = () => { sfxCount += 1; return true; };
    const btn = uiB.pauseMenu.buttons.sfx;
    menuA.dispatch('click', { target: btn });
    assert.equal(sfxCount, 1, '旧实例的监听已解绑，点击只触发一次');
    // 旧实例仍可正常收尾（胶水层切换 UI 时不会被卡住）
    assert.doesNotThrow(() => uiA.togglePause(false));
  });

  test('音效按钮：静音后 .off / svg 叉号 / 文案切换，再点恢复（回归：曾读不存在的 ui._muted）', async () => {
    const UI = await loadUI();
    const dom = installStubDOM();
    // 【防串测】sfx.js 的静音状态是**模块级全局**（localStorage 侧），别的用例可能已经把它翻转过。
    // 这里用 ui.isSfxMuted 钩子把起点钉死在「未静音」，否则本用例会随执行顺序间歇失败
    // （QA 复跑 8 次里出现过 1 次：静音按钮一开始就是 .off）。收尾也按同一钩子还原。
    const sfxMod = await import('../src/ui/sfx.js');
    let muted = false;
    const game = makeGame();
    const ui = new UI(game);
    ui.isSfxMuted = () => muted;
    ui.toggleSfx = () => { muted = !muted; return muted; };
    game.ui = ui;
    // 记录进入前真实的全局静音状态，结束时还原（不影响其它套件）
    const wasMuted = typeof sfxMod.isMuted === 'function' ? !!sfxMod.isMuted() : false;
    try {
      ui.handleEscape();
      const btn = ui.pauseMenu.buttons.sfx;
      assert.equal(btn.classList.contains('off'), false, '默认不静音');
      ui.pauseMenu.activate('sfx');
      assert.equal(btn.classList.contains('off'), true, '静音后加 .off（CSS 用它做灰化）');
      assert.ok(btn.querySelector('.pb-ico').innerHTML.includes('<svg'), '静音图标是内联 svg');
      assert.ok(!/[🔇🔊\uD83D\uDD07\uD83D\uDD0A]/u.test(btn.querySelector('.pb-ico').textContent), '静音图标不再是 emoji');
      assert.equal(btn.querySelector('.pb-text').textContent, '音效关闭');
      ui.pauseMenu.activate('sfx');
      assert.equal(btn.classList.contains('off'), false, '再点一次恢复');
      assert.ok(btn.querySelector('.pb-ico').innerHTML.includes('<svg'), '恢复后图标仍是内联 svg');
      assert.equal(btn.querySelector('.pb-text').textContent, '音效开启');
      assert.ok(dom.document.getElementById('pause-menu'), '暂停菜单仍在');
    } finally {
      if (typeof sfxMod.isMuted === 'function' && !!sfxMod.isMuted() !== wasMuted) {
        try { sfxMod.toggleMute(); } catch { /* 桩环境可能没有 AudioContext */ }
      }
    }
  });

  test('单例语义：接管挂在别的宿主上的旧卡片（移动而非新建），任何节点都不被删除', async () => {
    const UI = await loadUI();
    const dom = installStubDOM();
    // 模拟"上一任实例的卡片挂在 #hud 上"（宿主与本实例不同）
    const prior = dom.document.createElement('div');
    prior.id = 'pause-menu';
    prior.className = 'pause-overlay';
    prior._pauseOwner = { fake: 'other-ui' };
    dom.byId.hud.appendChild(prior);
    const game = makeGame();
    const ui = new UI(game);
    game.ui = ui;
    ui.handleEscape();
    // 不新建第二张：接管并挪到本实例宿主（#app）下
    assert.equal(ui.pauseMenu.root, prior, '接管的是旧节点（没有新建）');
    assert.equal(prior.parentNode, dom.app, '旧卡片被移动到 #app 下');
    // 注：测试桩的 appendChild 不会从旧父节点摘除（真实 DOM 下 appendChild 即自动移走）。
    // 所以这里用「节点身份」判定：页面里出现的每一个 #pause-menu 都必须是同一个 prior 节点，
    // 不能出现第二张卡。
    const cards = dom.document.querySelectorAll('#pause-menu');
    assert.ok(cards.length >= 1, '能查到暂停卡');
    assert.ok(cards.every((c) => c === prior), '所有命中的都是同一个节点（没有新建第二张）');
    assert.equal(dom.document.getElementById('pause-menu'), prior, 'getElementById 也指向它');
    assert.ok(prior.classList.contains('show'), '接管后能正常显示');
  });

  test('src/ui/style.css 里 PAUSE 段落存在且覆盖关键选择器（防止再被整文件覆盖）', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(new URL('../src/ui/style.css', import.meta.url), 'utf8');
    assert.ok(css.includes('/* ===== PAUSE (src/ui/pause.js) ===== */'), '段落标记必须存在（grep 用）');
    for (const sel of ['.pause-overlay', '.pause-overlay.show', '.pause-card', '.pause-corner', '.pause-grid',
      '.pause-btn.primary', '.pause-btn.danger', '.pb-ico', '.pb-kbd', '.pause-foot', 'paused-canvas', '#app.paused']) {
      assert.ok(css.includes(sel), `style.css 缺少暂停相关选择器：${sel}`);
    }
    // z-index 契约：覆盖层 65 < #modal 70
    assert.ok(/\.pause-overlay\s*\{[^}]*z-index:\s*65/.test(css), '暂停覆盖层 z-index 必须是 65');
    // 去饱和滤镜（恢复时无闪烁，靠 transition）
    assert.ok(/canvas#game\.paused-canvas\s*\{[^}]*grayscale\(0?\.35\)/.test(css), '要给出 grayscale(0.35)');
    assert.ok(/canvas#game\s*\{[^}]*transition:\s*filter/.test(css), 'canvas 需要有 filter 过渡');
    // 花括号平衡
    const open = (css.match(/\{/g) || []).length;
    const close = (css.match(/\}/g) || []).length;
    assert.equal(open, close, `style.css 花括号不平衡：${open} vs ${close}`);
  });
});

describe('暂停菜单：弱 DOM 降解', () => {
  test('classList 全是空实现、querySelector 返回新节点：开关/渲染不抛异常', async () => {
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const mk = () => ({
      style: {}, dataset: {}, children: [], id: '', className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, getAttribute: () => null, appendChild(c) { return c; }, remove() {},
      querySelector: () => mk(), querySelectorAll: () => [], addEventListener() {}, focus() {},
    });
    const ids = { app: mk(), hud: mk(), game: mk(), modal: mk() };
    ids['modal-title'] = mk();
    ids['modal-body'] = mk();
    ids['modal-foot'] = mk();
    globalThis.document = {
      body: mk(),
      createElement: () => mk(),
      getElementById: (id) => ids[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    };
    globalThis.window = { addEventListener() {}, removeEventListener() {}, document: globalThis.document, innerWidth: 1440, innerHeight: 810 };
    try {
      const PauseMenuMod = await import('../src/ui/pause.js');
      const fakeUI = { game: makeGame(), addLog() {}, toggleSfx() {}, modalOpen: null };
      const menu = new PauseMenuMod.PauseMenu(fakeUI);
      fakeUI.pauseMenu = menu;
      fakeUI.paused = false;
      fakeUI.togglePause = (on) => { fakeUI.paused = on === undefined ? !fakeUI.paused : !!on; return fakeUI.paused; };
      fakeUI.closeModals = () => { fakeUI.modalOpen = null; };
      assert.doesNotThrow(() => menu.open());
      assert.doesNotThrow(() => menu.render(true));
      assert.doesNotThrow(() => menu.activate('sfx'));
      assert.doesNotThrow(() => menu.activate('stats'));
      assert.doesNotThrow(() => menu.handleKey({ key: 'ArrowDown' }));
      assert.doesNotThrow(() => menu.activate('save'));
      assert.doesNotThrow(() => menu.close());
      // 弱桩的 querySelector 每次返回"新节点"：这里允许拿到节点（禁/启用状态一律保守处理），
      // 唯一硬要求是**不抛异常**、开关调用都能走通。
      assert.ok(Array.isArray(menu.focusables));
    } finally {
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. 主循环冻结（执行真实的 main.js frame()）
// ═══════════════════════════════════════════════════════════════════════════
/** 把 main.js 剥成「裸函数集合」：去掉 import 行与末尾的启动语句，返回上下文对象 */
async function loadFrameHarness() {
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const src = fs.readFileSync(new URL('../src/ui/main.js', import.meta.url), 'utf8');
  const stripped = src
    .replace(/^import[\s\S]*?from\s*'[^']+';?$/gm, '')
    // 只保留到 frame() 为止：frame() 之后是启动/事件绑定（btn-start、window.__dbg、autostart），测试不需要
    .replace(/\/\/ -+\r?\n\/\/ 事件绑定[\s\S]*$/, '');
  assert.ok(stripped.includes('function frame(now)'), 'main.js 里应该有 frame()');
  assert.ok(!/^import /m.test(stripped), 'import 已剥离');
  // 生成一个「返回帧函数 + 内部状态读取器」的脚本。
  // 【状态用 globalThis 读】main.js 顶层的 game/renderer/input/ui/running/... 是**隐式全局**
  // （见 main.js 头部「进程内状态不在这里声明」的说明），所以读取一律走 globalThis；
  // 而且 vm 的每个脚本在 sandbox 上有独立词法作用域，帧函数与读取器必须由同一个脚本产出。
  const script = new vm.Script(`(function(){ ${stripped}\n return {`
    + ` frame,`
    + ` getState: () => ({ running: globalThis.running, acc: globalThis.acc, lastT: globalThis.lastT }),`
    + ` setLastT: (v) => { globalThis.lastT = v; },`
    + ` setAppend: (fn) => { globalThis.__frame = fn; }`
    + ` }; })()`);
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    getAim: () => ({ x: 0, z: 0 }),
    updateGame: null,
    readInput: null,
    performance,
    Math, Date, JSON, Number, String, Object, Array, Set, Map, Promise, Error, Boolean, isFinite, parseInt, parseFloat,
  };
  Object.assign(sandbox, {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    requestAnimationFrame: () => {},
    URLSearchParams: globalThis.URLSearchParams,
  });
  return { script, stripped, sandbox, makeContext };
}

/** 构造一次「已开始的游戏」上下文（不启动真实 rAF 循环） */
function makeContext(script, { quiet = true } = {}) {
  const fakeGame = makeGame();
  const calls = { updateGame: 0, renderDt: [], renderTime: [], uiDt: [], events: [] };
  const renderer = {
    timeScale: () => 1,
    render(world, dt, time) { calls.renderDt.push(dt); calls.renderTime.push(time); },
    emitFromEvent(evt) { calls.events.push(evt); },
  };
  let ui = null;
  // 【注意】ctx 里 game / ui / renderer 用 getter 暴露：main.js 的裸变量（`let game`）与 ctx 属性是
  // 两套存储，函数体会读 ctx 上的同名属性。用 getter 保证两边永远指向同一个对象，
  // 且 ctx.ui 不能是数据属性（否则下面给 let ui 赋值会和它打架）。
  const ctx = {
    canvas: { clientWidth: 1440, clientHeight: 810 },
    get game() { return fakeGame; },
    get ui() { return ui; },
    get renderer() { return renderer; },
    running: true,
    lastT: 0,
    acc: 0,
    frameCount: 0,
    fps: 60,
    fpsTimer: 0,
    STEP: 1 / 60,
    PAUSE_RENDER_DT: 1e-6,
    updateGame: (g, dt, inp) => {
      calls.updateGame++;
      if (g.paused) return; // 与真实 app.js 的守卫一致
      appMod.updateGame(g, dt, inp || { move: { x: 0, z: 0 } });
    },
    readInput: () => ({ move: { x: 0, z: 0 }, aim: { x: 0, z: 0 }, attackHeld: false, skills: [], dash: false, releaseChannels: true }),
    getAim: () => ({ x: 0, z: 0 }),
    watchLevel: () => {},
    clearEvents: (w) => appMod.clearEvents(w),
    requestAnimationFrame: () => {},
    tickAutoSave: () => {},
    fallbackRenderer: () => renderer,
    console: { log() {}, warn() {}, error: quiet ? () => {} : console.error },
    performance,
    document: { getElementById: () => null },
    location: { search: '' },
    URLSearchParams,
    Math, Date, JSON, Number, String, Object, Array, Set, Map, Promise, Error, Boolean,
  };
  // 极简 UI：只提供 frame() 需要的接口（暂停状态机本身在 A 组已经测过）
  ui = {
    paused: false,
    game: fakeGame,
    isPaused() { return !!(this.paused || fakeGame.paused); },
    setFps() {},
    update(dt) { calls.uiDt.push(dt); },
  };
  // 隐式全局：main.js 里 `running = true` 写的是 sandbox 上的同名属性，这里先建好访问器；
  // 注意 sandbox 里所有状态名都不能再以「带名字的复合赋值/声明」出现（见 main.js 头部说明）——
  // 所以 ctx 只当初始值来源，真正被读写的永远是 sandbox 上的这一份。
  ctx.lastT = 0;
  ctx.acc = 0;
  // 【只剥 import，不剥 input 的声明】main.js 里 `let input = null` 是**正常声明**（浏览器端必须声明），
// 所以沙箱跑起来的是一份全新的 input 状态：frame() 里的 `input.endFrame()` / `input.wasPressed`
// 全靠它的判空保护。这里在沙箱全局上放一份最小的 Input 桩，模拟「游戏已经启动、input 已注入」。
  // 沙箱里没有真 Input，这里放一份最小桩，否则帧尾的 input.endFrame() 会崩。
  ctx.__input = {
    mouse: { x: 0, y: 0, down: false, rightDown: false },
    keys: new Set(),
    endFrame() {},
    clearPressed() {},
    setGameKeysEnabled() { return true; },
    moveDir() { return { x: 0, z: 0 }; },
    wasPressed() { return false; },
  };
  return { ctx, fakeGame, calls, ui, renderer };
}

describe('主循环：暂停时世界完全冻结', () => {
  let harness;
  beforeEach(async () => { harness = await loadFrameHarness(); });

  /**
   * 跑 n 帧。时间戳只来自 rAF，frame() 内部自己维护 lastT；
   * 这里**不能**每帧重置 ctx.lastT（那会让每帧的 realDt 都变成 0，世界根本不推进）。
   */
  function runFrames(n, startMs, ctx, compiled) {
    let now = startMs + 1000 / 60;
    // lastT 是 main.js 的隐式全局 → 必须通过沙箱脚本写，直接改 ctx 只值初始化时有效
    if (compiled && typeof compiled.setLastT === 'function') compiled.setLastT(startMs);
    for (let i = 0; i < n; i++) {
      ctx.frame(now);
      now += 1000 / 60;
    }
    return now;
  }

  test('暂停 3 秒：world.time / 怪物坐标 / 血量 / 冷却 / 子弹 / 粒子逐位不变', () => {
    const { ctx, fakeGame, calls, ui } = makeContext(harness.script, harness.sandbox);
    const compiled = harness.script.runInNewContext(ctx);
    assert.ok(compiled && typeof compiled.frame === 'function', 'frame 已导出');
    const frameFn = compiled.frame;
    ctx.frame = frameFn;
    const world = fakeGame.world;
    // 先正常跑 60 帧，让世界里产生运动/冷却/粒子
    const p = world.player;
    if (p.skillBar && p.skillBar[0]) p.cooldowns = { ...(p.cooldowns || {}), [p.skillBar[0].id]: 3 };
    let now = runFrames(60, 1000, ctx, compiled);
    assert.ok(calls.updateGame > 0, '暂停前 updateGame 在推进');
    const before = {
      time: world.time,
      career: world.career.playTime,
      playerX: p.x, playerZ: p.z, hp: p.hp,
      monsterCount: world.monsters.length,
      monsters: world.monsters.slice(0, 20).map((m) => [m.x, m.z, m.hp, m.state]),
      cooldowns: JSON.stringify(p.cooldowns || {}),
      projectiles: (world.projectiles || []).length,
      orbs: (world.lootOrbs || world.orbs || []).length,
    };
    assert.ok(before.time > 0, '暂停前世界时间在走');
    // 暂停（模拟 ESC 已经按过：ui.paused / game.paused 都被置位）
    ui.paused = true;
    fakeGame.paused = true;
    const updateCallsAtPause = calls.updateGame;
    const dtAtPause = calls.renderDt.length;
    now = runFrames(180, now, ctx, compiled); // 3 秒 ≈ 180 帧
    const after = {
      time: world.time,
      career: world.career.playTime,
      playerX: p.x, playerZ: p.z, hp: p.hp,
      monsterCount: world.monsters.length,
      monsters: world.monsters.slice(0, 20).map((m) => [m.x, m.z, m.hp, m.state]),
      cooldowns: JSON.stringify(p.cooldowns || {}),
      projectiles: (world.projectiles || []).length,
      orbs: (world.lootOrbs || world.orbs || []).length,
    };
    assert.equal(after.time, before.time, 'world.time 完全不变');
    assert.equal(after.career, before.career, '游玩时长不增加');
    assert.equal(after.playerX, before.playerX);
    assert.equal(after.playerZ, before.playerZ);
    assert.equal(after.hp, before.hp);
    assert.equal(after.monsterCount, before.monsterCount, '怪物数量不变（没有刷怪/死亡）');
    assert.deepEqual(after.monsters, before.monsters, '怪物坐标/血量/状态逐位不变');
    assert.equal(after.cooldowns, before.cooldowns, '冷却不推进');
    assert.equal(after.projectiles, before.projectiles, '子弹不变');
    assert.equal(after.orbs, before.orbs, '掉落/魂火不变');
    assert.equal(calls.updateGame, updateCallsAtPause, '暂停期间根本不调用 updateGame');
    // 渲染照常：每帧都画，但 dt 是「极小正数」（不能是 0 —— renderer 会把它当没传改成 1/60）
    const pausedDts = calls.renderDt.slice(dtAtPause);
    assert.equal(pausedDts.length, 180, '每帧仍然渲染');
    assert.ok(pausedDts.every((d) => d > 0 && d <= 1e-5), `暂停时渲染 dt 必须极小且为正，实际 ${JSON.stringify(pausedDts.slice(0, 3))}`);
    assert.ok(calls.renderTime.slice(-1)[0] === before.time, '渲染时间戳用 world.time（冻结值）');
    // HUD 仍在更新（暂停菜单要刷摘要），但时间步长为 0
    assert.ok(calls.uiDt.slice(-180).every((d) => d === 0), '暂停时 ui.update(0)');
    // 恢复：世界继续推进
    ui.paused = false;
    fakeGame.paused = false;
    runFrames(30, now, ctx, compiled);
    assert.ok(world.time > before.time, '恢复后世界时间继续增长');
    assert.ok(calls.updateGame > updateCallsAtPause, '恢复后 updateGame 继续被调用');
    const resumeDts = calls.renderDt.slice(-30);
    assert.ok(resumeDts.some((d) => d > 0.001), '恢复后渲染 dt 回到真实帧时间');
  });

  test('暂停期间累计的时间不会在恢复后补帧（acc 被清零）', () => {
    const { ctx, fakeGame, ui } = makeContext(harness.script, harness.sandbox);
    const compiled = harness.script.runInNewContext(ctx);
    ctx.frame = compiled.frame;
    ctx.frame = compiled.frame;
    const world = fakeGame.world;
    // 先跑几帧，让 acc 处于中间状态
    let now = runFrames(5, 1000, ctx, compiled);
    ui.paused = true;
    fakeGame.paused = true;
    const tPaused = world.time;
    // 暂停 2 秒
    now = runFrames(120, now, ctx, compiled);
    assert.equal(world.time, tPaused, "暂停期间世界时间不动");
    ui.paused = false;
    fakeGame.paused = false;
    // 恢复后只应推进 ~1 步，而不是把暂停期间累计的 2 秒一次性补上。
    // （固定步长累加器 acc 在暂停时被清零；恢复后第一帧 16.7ms → 1 步 = 1/60）
    const before = world.time;
    runFrames(2, now, ctx, compiled);
    const advanced = world.time - before;
    assert.ok(advanced > 0 && advanced <= (1 / 60) + 1e-9, `恢复后单帧最多推进 1 步，实际 ${advanced}`);
  });

  test('固定步长渲染：每帧只推进 1/60 步（暂停不会让固定时间步长变大）', () => {
    const { ctx, fakeGame } = makeContext(harness.script, harness.sandbox);
    const compiled = harness.script.runInNewContext(ctx);
    ctx.frame = compiled.frame;
    const world = fakeGame.world;
    const t0 = world.time;
    runFrames(30, 1000, ctx, compiled);
    const advanced = world.time - t0;
    // 30 帧 × 1/60 ≈ 0.5 秒（允许 ±2 步的取整误差）
    assert.ok(Math.abs(advanced - 0.5) < 4 / 60, `30 帧应推进约 0.5s，实际 ${advanced.toFixed(3)}`);
    assert.equal(ctx.STEP, 1 / 60);
  });

  test('世界事件逐帧喂给 renderer（伤害数字的来源），消费后清空且不重复', () => {
    const { ctx, fakeGame, calls } = makeContext(harness.script, harness.sandbox);
    const compiled = harness.script.runInNewContext(ctx);
    ctx.frame = compiled.frame;
    const world = fakeGame.world;
    // 一条打在自己身上、一条打在怪物身上：两者都要到达渲染层
    world.events.push(
      { type: 'hit', x: 1, z: 1, amount: 23, targetIsPlayer: true },
      { type: 'hit', x: 2, z: 1, amount: 41, targetIsPlayer: false },
    );
    let now = runFrames(1, 1000, ctx, compiled);
    const ours = (e) => e.type === 'hit' && (e.amount === 23 || e.amount === 41);
    const seen = calls.events.filter(ours);
    assert.equal(seen.length, 2, `两条 hit 都应喂给 renderer，实际 ${seen.length}`);
    assert.equal(world.events.length, 0, '事件在 render 之后被清空');
    // 下一帧不能把上一帧的事件再播一遍（否则伤害数字会翻倍）
    const before = calls.events.length;
    now = runFrames(1, now, ctx, compiled);
    assert.equal(calls.events.slice(before).filter(ours).length, 0, '旧事件不应重复喂给渲染层');
  });
});