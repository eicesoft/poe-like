// 键盘路由回归（静态）：把 main.js 当模块加载，直接调它导出的键盘处理入口，
// 验证「暂停时 ESC 能恢复 / 面板打开时 C/P/K/E/Tab 能切面板 / 正常时进 pendingHotkeys」。
//
// 为什么要单独测：这两条是 QA 复核发现的真实缺陷（G1 之外的 风险 A / 风险 B），
// 修复后必须有不依赖真浏览器的回归保护。跑法：node tools/_shots/panelbar/_keymap-probe.mjs
//
// 说明：main.js 是浏览器入口（会在加载时绑定 window 监听、构建渲染器……），
// 所以这里**不 import 它**，而是用源码级断言 + 一个最小可执行桩来验证分流顺序。
// 判据（源码级）：
//   ① runHotkey 里 spec.panel 必须出现在 isInputBlocked() 之前；
//   ② 暂停时必须有独立通道：handlePausedKey 存在，且捕获层在暂停时 return handlePausedKey(e)；
//   ③ handlePausedKey 里 ESC → escapeRoute()，其余 → ui.handlePauseKey(e)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(join(ROOT, 'src', 'ui', 'main.js'), 'utf8');
const lines = src.split('\n');
const results = [];
const rec = (id, name, status, detail) => {
  results.push({ id, name, status, detail });
  const m = { PASS: '✓', FAIL: '✗', WARN: '!' }[status] || '?';
  console.log(`  ${m} [${id}] ${name} — ${status}${detail ? ' · ' + detail : ''}`);
};
const idx = (fn, pred, from = 0) => { for (let i = from; i < lines.length; i++) if (pred(lines[i], i)) return i; return -1; };

// ① 面板键在输入阻塞判断之前
const rh = idx('runHotkey', (l) => l.startsWith('function runHotkey'));
const panelLine = idx('panel', (l) => l.includes('if (spec.panel)'), rh);
const blockedLine = idx('blocked', (l) => l.includes('if (isInputBlocked()) return false;'), rh);
rec('K1', 'runHotkey：面板快捷键（C/P/K/E/Tab）在 isInputBlocked() 之前执行',
  (panelLine > 0 && blockedLine > 0 && panelLine < blockedLine) ? 'PASS' : 'FAIL',
  `spec.panel 第 ${panelLine + 1} 行 / isInputBlocked 第 ${blockedLine + 1} 行`);

// ② 暂停时的独立通道
const hp = idx('handlePausedKey', (l) => l.includes('function handlePausedKey'));
const pausedRoute = idx('pausedRoute', (l) => /return handlePausedKey\(e\)/.test(l));
rec('K2', '捕获层：暂停/暂停菜单打开时同步走 handlePausedKey（不依赖帧循环里的 readInput）',
  (hp > 0 && pausedRoute > 0) ? 'PASS' : 'FAIL',
  `handlePausedKey 第 ${hp + 1} 行 / 调用点第 ${pausedRoute + 1} 行`);

// ③ handlePausedKey 内部：ESC → escapeRoute()，其余 → ui.handlePauseKey
const body = lines.slice(hp, idx('}', (l) => l === '}', hp) + 1).join('\n');
const escRoute = /name === 'Escape'[\s\S]{0,120}escapeRoute\(\)/.test(body);
const uiPauseKey = /ui\.handlePauseKey\(e\)/.test(body);
rec('K3', 'handlePausedKey：ESC → escapeRoute()（能恢复），其余键 → ui.handlePauseKey(e)',
  (escRoute && uiPauseKey) ? 'PASS' : 'FAIL',
  `ESC→escapeRoute=${escRoute}、转发 ui.handlePauseKey=${uiPauseKey}`);

// ④ 暂停中不让游戏键落进 pendingHotkeys（否则恢复后"补执行"）
const noPendingInPause = /if \(name\) e\.preventDefault\(\);\s*\n\s*return true;/.test(body);
rec('K4', 'handlePausedKey：未识别的键被吞掉（preventDefault + return true），不会落进 _pendingHotkeys',
  noPendingInPause ? 'PASS' : 'WARN', noPendingInPause ? '已阻断' : '未找到阻断语句，请人工确认');

// ⑤ Tab 仍然 preventDefault（不切浏览器焦点）
const tabLine = lines.findIndex ? lines.findIndex((l) => /Tab:\s*\{/.test(l)) : -1;
const tabPd = tabLine >= 0 && /preventDefault:\s*true/.test(lines[tabLine]);
const capturePd = /HOTKEYS\[name\]\.preventDefault \|\| name === 'Tab'/.test(src);
rec('K5', 'Tab：HOTKEYS 标明 preventDefault，捕获层对 Tab 调 preventDefault', (tabPd && capturePd) ? 'PASS' : 'FAIL',
  `Tab 规格第 ${tabLine + 1} 行 preventDefault=${tabPd}、捕获层=${capturePd}`);

console.log('\n' + JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);