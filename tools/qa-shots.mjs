// =============================================================================
// QA：真机 Chrome 自动化验收（ESC 暂停 / 底部面板按钮 / 属性面板）
// -----------------------------------------------------------------------------
// 运行：node tools/qa-shots.mjs [--url=...] [--no-launch] [--profile=...] [--keep]
//
// 设计（重要，见 REPORT.md 的「环境」一节）：
//   本会话的 DSH 沙箱**禁止 Node 用 child_process 启动任何子进程**（spawn EPERM），
//   同时它拦截了 Chromium 用来创建子进程的命名管道，导致 chrome.exe / msedge.exe /
//   msedgewebview2.exe 一启动就在 mojo platform_channel 上 FATAL 退出（exit 0x80000005 / 13）。
//   因此本脚本把「浏览器启动」和「页面驱动」拆开：
//     - 启动由**外层命令行**完成（pwsh 的 Start-Process 可以启动浏览器，也能连上 DevTools 端口）：
//         $env:PORT=5190; node tools/serve.mjs            # 静态服务（后台作业）
//         [Diagnostics.Process]::Start( 浏览器 exe, 参数 --remote-debugging-port=9339 ... )
//         node tools/qa-shots.mjs --no-launch --url=http://127.0.0.1:9339
//     - 本脚本只用 Node 内置 WebSocket 直连 DevTools 协议（不依赖 puppeteer 的启动器）。
//   脚本自身**绝不调用 child_process**；需要子进程时直接报错并给出替代命令。
//
// 验收清单（与 task-5 对齐）：
//   A 启动/基线           B ESC 暂停 + 世界冻结 3s    C 暂停中打开属性面板仍暂停
//   D 底部 4 按钮逐个开关  E 键盘 K/P/C/E/Tab          F 暂停恢复后 WASD 移动
//   G DOM 不重复创建       H 无 console 错误           I 视觉重叠/溢出（DOM 几何）
//   两个视口：1280x720(DSF=1) 与 1920x1080(DSF=1)
// =============================================================================
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'tools', '_shots', 'panelbar');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 候选浏览器：Chrome 157（任务指定）→ Edge（同内核）→ Tabbit（Electron/Chromium，CLI 兜底）
const BROWSER_CANDIDATES = [
  { kind: 'chrome-cli', exe: CHROME },
  { kind: 'edge-cli', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { kind: 'tabbit-cli', exe: (process.env.LOCALAPPDATA || '') + '\\Tabbit\\Application\\Tabbit Browser.exe' },
];

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = (k) => argv.includes(`--${k}`);
const URL_BASE = arg('url-base', 'http://127.0.0.1:5190');
const AUTO_URL = `${URL_BASE}/index.html?autostart=1`;
const VIEWPORTS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

// -----------------------------------------------------------------------------
// 结果收集
// -----------------------------------------------------------------------------
const results = [];   // { id, name, status: PASS|FAIL|WARN|SKIP|BLOCKED, detail, shots: [] }
const notes = [];     // 自由文本（数值证据、异常）
function record(id, name, status, detail, shots = []) {
  results.push({ id, name, status, detail, shots });
  const mark = { PASS: '✓', FAIL: '✗', WARN: '!', SKIP: '-', BLOCKED: '×' }[status] || '?';
  console.log(`  ${mark} [${id}] ${name} — ${status}${detail ? ' · ' + detail : ''}`);
  return status;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const section = (t) => log(`\n=== ${t} ===`);

// -----------------------------------------------------------------------------
// 1) 启动浏览器（只有外部的 --launch-helper 分支会用到；本进程不 spawn 任何东西）
// -----------------------------------------------------------------------------
function browserArgs({ port, headless = true, profile, width = 1280, height = 720 }) {
  return [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    'about:blank',
  ];
}

function launchPlan() {
  const port = Number(arg('port', 9339));
  const profile = arg('profile', `${process.env.TEMP || 'C:\\Windows\\Temp'}\\poe-qa-chrome`);
  const win = BROWSER_CANDIDATES.map((b) => ({
    ...b,
    exists: existsSync(b.exe),
    args: browserArgs({ port, headless: !flag('headed'), profile }),
  }));
  return { port, profile, candidates: win.filter((c) => c.exists) };
}

if (flag('launch-plan')) {
  const plan = launchPlan();
  const out = { note: '本进程不 spawn 子进程；请用下面的 args 在外部启动浏览器', ...plan };
  const file = join(OUT_DIR, 'launch-plan.json');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(plan.candidates.length ? 0 : 4);
}

// -----------------------------------------------------------------------------
// 2) CDP 客户端（Node 内置 WebSocket）
// -----------------------------------------------------------------------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners) fn(msg);
    });
  }
  static async fromWsUrl(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket error: ' + wsUrl)), { once: true });
      setTimeout(() => rej(new Error('WebSocket open timeout: ' + wsUrl)), 15000);
    });
    return new CDP(ws);
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 页面（session）包装：evaluate / 截图 / 输入 / 页面错误收集 */
class Page {
  constructor(cdp, sessionId, viewport) {
    this.cdp = cdp;
    this.sid = sessionId;
    this.viewport = viewport;
    this.errors = [];     // { kind:'pageerror'|'console', text, ts }
    this._shotIndex = 0;
    this.tag = viewport ? viewport.name : 'x';
  }
  send(m, p) { return this.cdp.send(m, p, this.sid); }
  async eval(expr, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise,
      userGesture: true, includeCommandLineAPI: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval threw: ' + (d.exception?.description || d.text));
    }
    return r.result ? r.result.value : undefined;
  }
  async waitFor(expr, { timeout = 20000, label = expr } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await this.eval(expr)) return true; } catch { /* 页面可能还在加载 */ }
      await sleep(100);
    }
    throw new Error(`waitFor timeout (${timeout}ms): ${label}`);
  }
  async shot(name, { full = false } = {}) {
    mkdirSync(OUT_DIR, { recursive: true });
    this._shotIndex++;
    const file = `${this.tag}-${String(this._shotIndex).padStart(2, '0')}-${name}.png`;
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, fromSurface: true });
    writeFileSync(join(OUT_DIR, file), Buffer.from(r.data, 'base64'));
    return file;
  }
  // ---- 输入 ----
  async key(keyName, { code, keyDown = true, keyUp = true, waitAfter = 60 } = {}) {
    const map = KEYMAP[keyName] || KEYMAP.unknown;
    const c = code || map.code;
    const vk = map.vk;
    const params = {
      key: map.key, code: c, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      text: map.text || undefined, unmodifiedText: map.text || undefined,
    };
    if (keyDown) await this.send('Input.dispatchKeyEvent', { type: map.text ? 'keyDown' : 'rawKeyDown', ...params });
    if (keyUp) await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: map.key, code: c, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    if (waitAfter) await sleep(waitAfter);
  }
  async holdKey(keyName, ms) {
    await this.key(keyName, { keyDown: true, keyUp: false, waitAfter: 0 });
    await sleep(ms);
    await this.key(keyName, { keyDown: false, keyUp: true, waitAfter: 30 });
  }
  async mouseClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(20);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  }
  async clickSelector(sel) {
    const r = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; })()`);
    if (!r) throw new Error('clickSelector: not found ' + sel);
    await this.mouseClick(r.x, r.y);
    return r;
  }
}

// 键盘映射（CDP Input.dispatchKeyEvent 需要 key/code/vk 三者）
const KEYMAP = {
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  KeyW: { key: 'w', code: 'KeyW', vk: 87, text: 'w' },
  KeyA: { key: 'a', code: 'KeyA', vk: 65, text: 'a' },
  KeyS: { key: 's', code: 'KeyS', vk: 83, text: 's' },
  KeyD: { key: 'd', code: 'KeyD', vk: 68, text: 'd' },
  KeyK: { key: 'k', code: 'KeyK', vk: 75, text: 'k' },
  KeyP: { key: 'p', code: 'KeyP', vk: 80, text: 'p' },
  KeyC: { key: 'c', code: 'KeyC', vk: 67, text: 'c' },
  KeyE: { key: 'e', code: 'KeyE', vk: 69, text: 'e' },
  KeyM: { key: 'm', code: 'KeyM', vk: 77, text: 'm' },
  unknown: { key: '?', code: 'KeyQ', vk: 81 },
};

// -----------------------------------------------------------------------------
// 3) 页面内探针（一次性注入）：状态快照 + DOM 几何 + rAF 计数
// -----------------------------------------------------------------------------
const PROBE = `
window.__qa = (function () {
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const vis = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // 中心点命中的最上层元素必须还是它自己（排除被别的层挡住）
    const cx = Math.min(window.innerWidth - 1, Math.max(0, r.x + r.width / 2));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, r.y + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    return !!top && (top === el || el.contains(top) || top.contains(el));
  };
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
  const overlap = (a, b) => {
    if (!a || !b) return 0;
    const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? +(w * h).toFixed(1) : 0;
  };
  // rAF 帧计数：暂停期间页面仍在渲染（rAF 必须继续跑），但世界时间不能动
  const raf = { n: 0, last: 0 };
  (function tick(t) { raf.n++; raf.last = t; requestAnimationFrame(tick); })(0);
  // 屏幕上的「非画布」元素（用于重叠检测 + 溢出检测）
  const named = {
    topbar: '#topbar', charHead: '#char-head', mapInfo: '#map-info', statsPanel: '#stats-panel',
    skillbar: '#skillbar', log: '#log', helpHint: '#help-hint', lootBar: '#loot-bar',
    sfxToggle: '#sfx-toggle', skillNotify: '#skill-notify', panelBar: '#panel-bar',
    modal: '#modal', modalPanel: '.modal-panel', modalTitle: '#modal-title',
    pause: '#pause-menu', pauseCard: '.pause-card', death: '#death-screen',
    buffBar: '#buff-bar', combo: '#combo', banner: '#banner',
  };
  return {
    raf,
    get(sel) { return q(sel); },
    all(sel) { return qa(sel); },
    count(sel) { return qa(sel).length; },
    vis,
    rect,
    rectOf(sel) { return rect(q(sel)); },
    namedRects() { const o = {}; for (const k in named) o[k] = rect(q(named[k])); return o; },
    state() {
      const g = window.__game ? window.__game() : null;
      const game = g && g.game;
      if (!game) return { ok: false };
      const w = game.world, p = w.player;
      const mon = (w.monsters || []).map((m) => ({ x: +(+m.x).toFixed(4), z: +(+m.z).toFixed(4), hp: +(m.hp ?? 0).toFixed(4), dead: !!m.dead }));
      const cd = (p.skillBar || []).map((s) => (s && (s.cd ?? s.cooldown ?? s.cdLeft)) ?? null);
      return {
        ok: true,
        paused: game.paused === true,
        uiPaused: !!(g.ui && g.ui.paused),
        modalOpen: (g.ui && g.ui.modalOpen) || null,
        modalVisible: vis(q('#modal')),
        modalTitle: q('#modal-title') ? q('#modal-title').textContent.trim() : null,
        pauseVisible: vis(q('#pause-menu')),
        pauseCount: qa('#pause-menu').length,
        panelBarCount: qa('#panel-bar').length,
        panelBtnCount: qa('#panel-bar .panel-btn, #panel-bar button').length,
        activeBtns: qa('#panel-bar .panel-btn.active, #panel-bar button.active').map((b) => b.getAttribute('data-act') || b.textContent.trim()),
        world: {
          time: +(+w.time).toFixed(6),
          tick: w.tick ?? null,
          frame: w.frame ?? null,
        },
        player: { x: +(+p.x).toFixed(5), z: +(+p.z).toFixed(5), hp: +(+p.hp).toFixed(4), mp: +(+p.mp).toFixed(4), level: p.level },
        cooldowns: cd,
        monsters: mon,
        monsterCount: mon.length,
        monsterSig: JSON.stringify(mon),
        raf: raf.n,
        elementCount: document.getElementsByTagName('*').length,
        focusTag: document.activeElement ? (document.activeElement.tagName + (document.activeElement.id ? '#' + document.activeElement.id : '')) : null,
      };
    },
    // 世界「冻结指纹」：暂停 3 秒前后必须完全一致
    freezeFingerprint() {
      const g = window.__game(); const game = g.game; const w = game.world; const p = w.player;
      const s = window.__dbg && window.__dbg.stats ? window.__dbg.stats() : null;
      return {
        time: w.time,
        playerX: p.x, playerZ: p.z, hp: p.hp, mp: p.mp,
        cooldowns: JSON.stringify((p.skillBar || []).map((x) => (x && (x.cd ?? x.cooldown ?? x.cdLeft)) ?? null)),
        monsters: JSON.stringify((w.monsters || []).map((m) => [+m.x, +m.z, +m.hp, !!m.dead])),
        monsterCount: (w.monsters || []).length,
        statsMonsters: s ? s.monsters : null,
        projSig: JSON.stringify((w.projectiles || []).map((p2) => [+p2.x, +p2.z]).slice(0, 20)),
      };
    },
    // DOM 重叠/溢出体检（只看「屏幕可见」的元素）
    layout() {
      const R = {};
      for (const k in named) R[k] = { rect: rect(q(named[k])), vis: vis(q(named[k])) };
      const pairs = [];
      const keys = Object.keys(R).filter((k) => R[k].vis && R[k].rect);
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = keys[i], b = keys[j];
          // 父子包含关系不算重叠
          const ea = q(named[a]), eb = q(named[b]);
          if (ea && eb && (ea.contains(eb) || eb.contains(ea))) continue;
          const ar = R[a].rect, br = R[b].rect;
          const area = overlap(ar, br);
          if (area > 8) pairs.push({ a, b, area, ar, br });
        }
      }
      // 溢出屏幕
      const overflow = [];
      for (const k of Object.keys(R)) {
        if (!R[k].vis || !R[k].rect) continue;
        const r = R[k].rect;
        if (r.x < -0.5 || r.y < -0.5 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5) {
          overflow.push({ k, rect: r, vw: window.innerWidth, vh: window.innerHeight });
        }
      }
      // 文字被截断（scrollWidth > clientWidth 或 white-space/overflow 造成裁切）
      const clipped = [];
      const scan = (rootSel, label) => {
        const root = q(rootSel);
        if (!root || !vis(root)) return;
        const nodes = root.querySelectorAll('*');
        for (const n of nodes) {
          if (!n.firstChild || n.firstChild.nodeType !== 3) continue; // 只看直接放文本的节点
          const cs = getComputedStyle(n);
          if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis') {
            if (n.scrollWidth > n.clientWidth + 2 && n.clientWidth > 0) clipped.push({ root: label, sel: n.className || n.tagName, text: n.textContent.slice(0, 40), sw: n.scrollWidth, cw: n.clientWidth });
          }
        }
      };
      scan('#panel-bar', 'panel-bar');
      scan('#modal', 'modal');
      scan('#pause-menu', 'pause');
      scan('#stats-panel', 'stats-panel');
      return { named: R, overlaps: pairs, overflow, clipped, vw: window.innerWidth, vh: window.innerHeight };
    },
    panelButtons() {
      const bar = q('#panel-bar');
      if (!bar) return [];
      return Array.from(bar.querySelectorAll('button')).map((b) => {
        const r = b.getBoundingClientRect();
        return { act: b.getAttribute('data-act'), text: (b.textContent || '').trim(), title: b.title || b.getAttribute('aria-label'), active: b.classList.contains('active'), rect: rect(b), vis: vis(b) };
      });
    },
  };
})();
true;
`;

// -----------------------------------------------------------------------------
// 4) 连接 + 打开页面
// -----------------------------------------------------------------------------
async function connect(port) {
  let version = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      version = await res.json();
      break;
    } catch { await sleep(300); }
  }
  if (!version) throw new Error(`DevTools 端口 ${port} 未响应（浏览器没起来或已崩溃）`);
  const cdp = await CDP.fromWsUrl(version.webSocketDebuggerUrl);
  return { cdp, version };
}

/**
 * 用 CDP 自己开一个页面（Target.createTarget）。
 * 自带窗口时 Target 级 DevTools 可能被 BrowserContext 限制，失败则退到 /json/new HTTP 接口。
 */
async function openPage(cdp, port, viewport) {
  let targetId = null;
  try {
    const t = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = t.targetId;
  } catch (e) {
    // 退路：HTTP /json/new?url=（老式接口）
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() => null);
    if (res && res.ok) targetId = (await res.json()).id;
    else throw e;
  }
  const att = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, att.sessionId, viewport);
  page.targetId = targetId;
  cdp.on((msg) => {
    if (msg.sessionId !== att.sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      page.errors.push({ kind: 'pageerror', text: (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown exception', ts: Date.now() });
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      page.errors.push({ kind: 'console', text, ts: Date.now() });
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      page.errors.push({ kind: 'log', text: `[${msg.params.entry.source}] ${msg.params.entry.text}`, ts: Date.now() });
    }
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
    screenWidth: viewport.width, screenHeight: viewport.height,
  });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return page;
}

async function gotoGame(page, url) {
  await page.send('Page.navigate', { url });
  await page.waitFor('document.readyState === "complete"', { timeout: 30000, label: 'load' });
  await page.waitFor('!!(window.__game && window.__game().game)', { timeout: 30000, label: 'window.__game().game' });
  // 等首帧渲染 + HUD 出现
  await page.waitFor('!document.getElementById("hud").classList.contains("hidden")', { timeout: 15000, label: 'hud visible' });
  await sleep(800);
  await page.eval(PROBE);
}

// -----------------------------------------------------------------------------
// 5) 单项验收
// -----------------------------------------------------------------------------
async function ensurePaused(page) {
  const s = await page.eval('__qa.state()');
  if (!s.paused) { await page.key('Escape'); await sleep(250); }
  return page.eval('__qa.state()');
}

async function runViewport(ctx, vp) {
  const { cdp, port } = ctx;
  const page = await openPage(cdp, port, vp);
  const T = vp.name;
  const shots = [];
  section(`视口 ${T}（DSF=1）`);

  try {
    // ---------------- A 启动 ----------------
    try {
      await gotoGame(page, AUTO_URL);
      const st = await page.eval('__qa.state()');
      const shot = await page.shot('baseline');
      shots.push(shot);
      const layout0 = await page.eval('__qa.layout()');
      record(`${T}/A1`, '页面启动：window.__game().game 就绪 + HUD 可见', st.ok ? 'PASS' : 'FAIL',
        `paused=${st.paused} monsters=${st.monsterCount} player=(${st.player.x},${st.player.z})`, [shot]);
      record(`${T}/A2`, '底部 #panel-bar 存在且含 4 个按钮', (st.panelBarCount === 1 && st.panelBtnCount === 4) ? 'PASS' : 'FAIL',
        `#panel-bar=${st.panelBarCount} 按钮=${st.panelBtnCount}`, [shot]);
      const btns0 = await page.eval('__qa.panelButtons()');
      record(`${T}/A3`, '按钮文案为 属性/天赋/技能/装备', JSON.stringify(btns0.map((b) => b.text.replace(/\s+/g, ''))) === JSON.stringify(['属性C', '天赋P', '技能K', '装备E'].map((x) => x)) || btns0.map((b) => b.text.replace(/[A-Z]/g, '')).join('/') === '属性/天赋/技能/装备' ? 'PASS' : 'WARN',
        'texts=' + JSON.stringify(btns0.map((b) => ({ act: b.act, text: b.text, title: b.title }))), [shot]);
      notes.push({ viewport: T, kind: 'panel-buttons', value: btns0 });
    } catch (e) {
      record(`${T}/A0`, '页面启动', 'FAIL', String(e.message || e));
      return { page, shots, fatal: true };
    }

    // ---------------- B ESC 暂停 + 冻结 ----------------
    {
      const pre = await page.eval('__qa.state()');
      await page.key('Escape');
      await sleep(400);
      const s1 = await page.eval('__qa.state()');
      const fp1 = await page.eval('__qa.freezeFingerprint()');
      const shotPause = await page.shot('pause');
      shots.push(shotPause);
      record(`${T}/B1`, 'ESC → 暂停覆盖层可见', s1.pauseVisible ? 'PASS' : 'FAIL',
        `#pause-menu visible=${s1.pauseVisible} count=${s1.pauseCount}`, [shotPause]);
      record(`${T}/B2`, 'ESC → game.paused === true', s1.paused ? 'PASS' : 'FAIL', `game.paused=${s1.paused} ui.paused=${s1.uiPaused}`, [shotPause]);

      const rafBefore = (await page.eval('__qa.raf.n'));
      await sleep(3000);
      const s2 = await page.eval('__qa.state()');
      const fp2 = await page.eval('__qa.freezeFingerprint()');
      const rafAfter = (await page.eval('__qa.raf.n'));
      const diffs = [];
      for (const k of Object.keys(fp1)) {
        if (JSON.stringify(fp1[k]) !== JSON.stringify(fp2[k])) diffs.push(`${k}: ${JSON.stringify(fp1[k])} → ${JSON.stringify(fp2[k])}`);
      }
      const frozen = diffs.length === 0;
      record(`${T}/B3`, '暂停 3 秒：world.time / 玩家坐标 / HP/MP / 冷却 / 怪物坐标与血量 完全不变', frozen ? 'PASS' : 'FAIL',
        frozen ? `time=${fp1.time} monsters=${fp1.monsterCount} (3s 内 0 变化)` : diffs.join(' | '), [shotPause]);
      record(`${T}/B4`, '暂停中 requestAnimationFrame 仍在跑（渲染不停）', rafAfter - rafBefore > 20 ? 'PASS' : 'WARN',
        `rAF 帧数 +${rafAfter - rafBefore} / 3s`);
      const shotPause2 = await page.shot('pause-after-3s');
      shots.push(shotPause2);
      const layoutPause = await page.eval('__qa.layout()');
      notes.push({ viewport: T, kind: 'freeze', fp1, fp2, diffs });
      notes.push({ viewport: T, kind: 'pause-layout', value: layoutPause });
    }

    // ---------------- C 暂停中打开属性面板仍暂停 ----------------
    {
      let s = await page.eval('__qa.state()');
      if (!s.paused) { await page.key('Escape'); await sleep(300); s = await page.eval('__qa.state()'); }
      let opened = false;
      try {
        await page.clickSelector('#panel-bar [data-act="stats"], #panel-bar button:nth-child(1)');
        opened = true;
      } catch (e) {
        // 回退：直接调组件（记录到 notes，说明是脚本回退而非玩家路径）
        await page.eval('(() => { const g = window.__game(); const bar = g.ui && g.ui.panelBar; if (bar) bar.activate("stats"); })()');
        notes.push({ viewport: T, kind: 'fallback-click', msg: 'stats 按钮坐标点击失败，改用 panelBar.activate("stats")', err: String(e.message || e) });
      }
      await sleep(350);
      const s2 = await page.eval('__qa.state()');
      const shot = await page.shot('pause-stats');
      shots.push(shot);
      record(`${T}/C1`, '暂停中点击「属性」→ #modal 可见 + 标题=属性', (s2.modalVisible && /属性/.test(s2.modalTitle || '')) ? 'PASS' : 'FAIL',
        `modalVisible=${s2.modalVisible} title=${JSON.stringify(s2.modalTitle)} clickPath=${opened ? 'mouse' : 'api'}`, [shot]);
      record(`${T}/C2`, '暂停中打开属性面板后仍然暂停', (s2.paused && s2.uiPaused) ? 'PASS' : 'FAIL', `game.paused=${s2.paused} ui.paused=${s2.uiPaused}`, [shot]);
      // 暂停期间世界仍然冻结
      const fa = await page.eval('__qa.freezeFingerprint()');
      await sleep(1200);
      const fb = await page.eval('__qa.freezeFingerprint()');
      record(`${T}/C3`, '暂停 + 属性面板：1.2 秒内世界仍冻结', JSON.stringify(fa) === JSON.stringify(fb) ? 'PASS' : 'FAIL',
        JSON.stringify(fa) === JSON.stringify(fb) ? `time=${fa.time}` : 'fingerprint changed');
      const layoutStats = await page.eval('__qa.layout()');
      notes.push({ viewport: T, kind: 'pause-stats-layout', value: layoutStats });
      // ESC 关面板（仍暂停）
      await page.key('Escape');
      await sleep(300);
      const s3 = await page.eval('__qa.state()');
      record(`${T}/C4`, '暂停中首次 ESC：只关闭面板，仍暂停', (!s3.modalVisible && s3.paused) ? 'PASS' : 'FAIL',
        `modalVisible=${s3.modalVisible} paused=${s3.paused} pauseVisible=${s3.pauseVisible}`);
      // 再 ESC → 恢复
      await page.key('Escape');
      await sleep(400);
      const s4 = await page.eval('__qa.state()');
      const shotResume = await page.shot('resumed');
      shots.push(shotResume);
      record(`${T}/C5`, '第二次 ESC：恢复游戏（paused=false、暂停层隐藏）', (!s4.paused && !s4.pauseVisible) ? 'PASS' : 'FAIL',
        `paused=${s4.paused} pauseVisible=${s4.pauseVisible}`, [shotResume]);
      // 恢复后世界推进
      const f1 = await page.eval('__qa.freezeFingerprint()');
      await sleep(600);
      const f2 = await page.eval('__qa.freezeFingerprint()');
      record(`${T}/C6`, '恢复后 0.6 秒 world.time 继续推进', f2.time > f1.time ? 'PASS' : 'FAIL', `time ${f1.time} → ${f2.time}`);
    }

    // ---------------- D 底部 4 按钮逐个开关 ----------------
    {
      const expect = [
        { act: 'stats', file: 'panel-attributes', titleRe: /属性/ },
        { act: 'talents', file: 'panel-talents', titleRe: /天赋/ },
        { act: 'skills', file: 'panel-skills', titleRe: /技能/ },
        { act: 'equipment', file: 'panel-equipment', titleRe: /装备|背包/ },
      ];
      const btns = await page.eval('__qa.panelButtons()');
      const order = btns.map((b) => b.act).join(',');
      record(`${T}/D0`, '按钮顺序 = 属性/天赋/技能/装备', order === 'stats,talents,skills,equipment' ? 'PASS' : 'WARN', `data-act 顺序=${order}`);
      for (const [i, exp] of expect.entries()) {
        // 保证从干净状态开始
        await page.eval('(() => { const g = window.__game(); if (g.ui && g.ui.modalOpen) g.ui.closeModals(); })()');
        await sleep(120);
        let s;
        try {
          await page.clickSelector(`#panel-bar [data-act="${exp.act}"]`);
        } catch (e) {
          await page.eval(`(() => { const g = window.__game(); g.ui.panelBar.activate(${JSON.stringify(exp.act)}); })()`);
          notes.push({ viewport: T, kind: 'fallback-click', msg: `${exp.act} 点击失败改用 API`, err: String(e.message || e) });
        }
        await sleep(320);
        s = await page.eval('__qa.state()');
        const btnNow = await page.eval('__qa.panelButtons()');
        const actBtn = btnNow.find((b) => b.act === exp.act);
        const shot = await page.shot(exp.file);
        shots.push(shot);
        const ok = s.modalVisible && exp.titleRe.test(s.modalTitle || '') && actBtn && actBtn.active;
        record(`${T}/D${i + 1}`, `点击「${exp.act}」→ #modal 可见 + 标题 + 按钮 .active`, ok ? 'PASS' : 'FAIL',
          `modalVisible=${s.modalVisible} title=${JSON.stringify(s.modalTitle)} active=${JSON.stringify(s.activeBtns)} modalOpen=${s.modalOpen}`, [shot]);
        const layout = await page.eval('__qa.layout()');
        notes.push({ viewport: T, kind: `layout-${exp.act}`, value: layout });
        // 再点同一按钮 → 关闭
        await page.clickSelector(`#panel-bar [data-act="${exp.act}"]`).catch(async () => {
          await page.eval(`(() => { window.__game().ui.panelBar.activate(${JSON.stringify(exp.act)}); })()`);
        });
        await sleep(300);
        const s2 = await page.eval('__qa.state()');
        record(`${T}/D${i + 1}close`, `再次点击「${exp.act}」→ 关闭`, !s2.modalVisible ? 'PASS' : 'FAIL',
          `modalVisible=${s2.modalVisible} modalOpen=${s2.modalOpen} pauseVisible=${s2.pauseVisible}`);
      }
    }

    // ---------------- E 键盘 K/P/C/E/Tab ----------------
    {
      await page.eval('(() => { const g = window.__game(); if (g.ui && g.ui.modalOpen) g.ui.closeModals(); })()');
      await sleep(150);
      const keys = [
        { key: 'KeyK', act: 'skills', re: /技能/ },
        { key: 'KeyP', act: 'talents', re: /天赋/ },
        { key: 'KeyC', act: 'stats', re: /属性/ },
        { key: 'KeyE', act: 'equipment', re: /装备|背包/ },
      ];
      for (const [i, k] of keys.entries()) {
        await page.key(k.key);
        await sleep(300);
        const s = await page.eval('__qa.state()');
        const okOpen = s.modalVisible && k.re.test(s.modalTitle || '');
        record(`${T}/E${i + 1}a`, `${k.key.replace('Key', '')} 键打开对应面板`, okOpen ? 'PASS' : 'FAIL',
          `modalVisible=${s.modalVisible} title=${JSON.stringify(s.modalTitle)} modalOpen=${s.modalOpen} pauseVisible=${s.pauseVisible}`);
        if (!okOpen) {
          // 页面热键走 input 帧循环；帧循环暂停时可能不响应，记录下来继续
          notes.push({ viewport: T, kind: 'key-fail', key: k.key, state: s });
        }
        await page.key('Escape');
        await sleep(300);
        const s2 = await page.eval('__qa.state()');
        record(`${T}/E${i + 1}b`, `${k.key.replace('Key', '')} 面板 ESC 关闭`, !s2.modalVisible ? 'PASS' : 'FAIL',
          `modalVisible=${s2.modalVisible} paused=${s2.paused} pauseVisible=${s2.pauseVisible}`);
        if (s2.paused) { await page.key('Escape'); await sleep(250); } // 若误开暂停则恢复
      }
      // Tab：不应切换浏览器焦点（preventDefault），且能开技能面板
      // 注意：必须先注册捕获阶段的 keydown 监听，再发按键，然后读结果（window.__qaTab）
      const focusBefore = await page.eval('(() => { const a = document.activeElement; return a ? a.tagName + "#" + (a.id || "") : null })()');
      await page.eval('window.__qaTab = new Promise((res) => { const on = (e) => { if (e.key === "Tab") { window.removeEventListener("keydown", on, true); res({ prevented: e.defaultPrevented }); } }; window.addEventListener("keydown", on, true); setTimeout(() => res(null), 2000); }); true;');
      await page.key('Tab');
      await sleep(320);
      const tabRes = await page.eval('window.__qaTab');
      const sTab = await page.eval('__qa.state()');
      const focusAfter = await page.eval('(() => { const a = document.activeElement; return a ? a.tagName + "#" + (a.id || "") : null })()');
      record(`${T}/E5`, 'Tab 键：事件被 preventDefault（不切换浏览器焦点）', tabRes && tabRes.prevented ? 'PASS' : 'FAIL',
        `tabInfo=${JSON.stringify(tabRes)} focus ${focusBefore} → ${focusAfter}`);
      record(`${T}/E6`, 'Tab 键：打开技能面板', sTab.modalVisible && /技能/.test(sTab.modalTitle || '') ? 'PASS' : 'FAIL',
        `modalVisible=${sTab.modalVisible} title=${JSON.stringify(sTab.modalTitle)}`);
      const shotTab = await page.shot('tab-skills');
      shots.push(shotTab);
      await page.key('Escape');
      await sleep(250);
      const sAfter = await page.eval('__qa.state()');
      if (sAfter.paused) { await page.key('Escape'); await sleep(250); }
    }

    // ---------------- F 移动回归 ----------------
    {
      await page.eval('(() => { const g = window.__game(); if (g.ui && g.ui.modalOpen) g.ui.closeModals(); })()');
      const s0 = await page.eval('__qa.state()');
      if (s0.paused) { await page.key('Escape'); await sleep(400); }
      const a = await page.eval('(() => { const p = window.__game().game.world.player; return { x: p.x, z: p.z }; })()');
      await page.holdKey('KeyW', 1000);
      await sleep(250);
      const b = await page.eval('(() => { const p = window.__game().game.world.player; return { x: p.x, z: p.z }; })()');
      const dist = Math.hypot(b.x - a.x, b.z - a.z);
      record(`${T}/F1`, '暂停恢复后按住 W 1 秒 → 玩家移动 > 0.2', dist > 0.2 ? 'PASS' : 'FAIL',
        `dist=${dist.toFixed(3)} (${a.x.toFixed(2)},${a.z.toFixed(2)}) → (${b.x.toFixed(2)},${b.z.toFixed(2)})`);
      const shotWalk = await page.shot('after-walk');
      shots.push(shotWalk);
    }

    // ---------------- G DOM 泄漏 / 重复创建 ----------------
    {
      const before = await page.eval('__qa.state()');
      for (let i = 0; i < 20; i++) {
        await page.key('Escape'); // 开暂停
        await page.eval('__qa.get("#pause-menu") && true');
        await page.eval('(() => { const g = window.__game(); g.ui.panelBar.activate("stats"); })()');
        await sleep(40);
        await page.key('Escape'); // 关面板
        await sleep(40);
        await page.key('Escape'); // 恢复
        await sleep(40);
      }
      await sleep(400);
      const after = await page.eval('__qa.state()');
      const ok = after.pauseCount === 1 && after.panelBarCount === 1;
      record(`${T}/G1`, '20 轮暂停/面板开关后：#pause-menu 与 #panel-bar 各只有 1 个', ok ? 'PASS' : 'FAIL',
        `#pause-menu=${after.pauseCount} #panel-bar=${after.panelBarCount} 元素总数 ${before.elementCount} → ${after.elementCount}`);
      const dupStats = await page.eval(`(() => { const ids = {}; document.querySelectorAll('[id]').forEach((n) => { ids[n.id] = (ids[n.id] || 0) + 1; }); return Object.entries(ids).filter(([, c]) => c > 1); })()`);
      record(`${T}/G2`, '全页面没有重复 id', dupStats.length === 0 ? 'PASS' : 'FAIL', `重复 id: ${JSON.stringify(dupStats)}`);
      // 暂停中 rAF 仍在跑但 updateGame 不推进：用 world.time / 玩家坐标做代理
      const p1 = await page.eval('__qa.state()');
      if (!p1.paused) { await page.key('Escape'); await sleep(300); }
      const t1 = await page.eval('(() => ({ t: window.__game().game.world.time, x: window.__game().game.world.player.x }))()');
      const r1 = await page.eval('__qa.raf.n');
      await sleep(1000);
      const t2 = await page.eval('(() => ({ t: window.__game().game.world.time, x: window.__game().game.world.player.x }))()');
      const r2 = await page.eval('__qa.raf.n');
      record(`${T}/G3`, '暂停中 rAF 继续 + world.time 不推进', (r2 - r1 > 10 && t1.t === t2.t) ? 'PASS' : 'FAIL',
        `rAF +${r2 - r1}，time ${t1.t} → ${t2.t}`);
      await page.key('Escape');
      await sleep(300);
    }

    // ---------------- I 视觉重叠/溢出（汇总） ----------------
    {
      const s = await page.eval('__qa.state()');
      if (s.paused) { await page.key('Escape'); await sleep(300); }
      const layoutHud = await page.eval('__qa.layout()');
      const barRect = layoutHud.named.panelBar && layoutHud.named.panelBar.rect;
      const overlaps = layoutHud.overlaps || [];
      // 只关心与 panel-bar 相关的重叠（面板打开时的 #modal 覆盖 HUD 属于正常）
      const barOverlaps = overlaps.filter((o) => o.a === 'panelBar' || o.b === 'panelBar');
      record(`${T}/I1`, 'HUD 常态：底部按钮列不与技能栏/日志/静音键等重叠', barOverlaps.length === 0 ? 'PASS' : 'FAIL',
        barOverlaps.length ? JSON.stringify(barOverlaps) : `#panel-bar=${JSON.stringify(barRect)}`);
      record(`${T}/I2`, '无元素溢出视口', layoutHud.overflow.length === 0 ? 'PASS' : 'WARN', JSON.stringify(layoutHud.overflow));
      record(`${T}/I3`, '无文字被裁切', layoutHud.clipped.length === 0 ? 'PASS' : 'WARN', JSON.stringify(layoutHud.clipped.slice(0, 5)));
      notes.push({ viewport: T, kind: 'hud-layout', value: layoutHud });
    }

    // ---------------- H console 错误 ----------------
    {
      const errs = page.errors.slice();
      record(`${T}/H1`, 'pageerror / console.error / Log.error 数量 = 0', errs.length === 0 ? 'PASS' : 'FAIL',
        errs.length ? JSON.stringify(errs.slice(0, 6)) : '0 条');
      notes.push({ viewport: T, kind: 'console-errors', value: errs });
    }
  } catch (e) {
    record(`${T}/X`, '视口流程异常中断', 'FAIL', (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
    try { const f = await page.shot('crash-state'); shots.push(f); } catch { /* ignore */ }
  }

  // 关闭页面
  try { await cdp.send('Target.closeTarget', { targetId: page.targetId }); } catch { /* ignore */ }
  return { page, shots };
}

// -----------------------------------------------------------------------------
// 6) 浏览器启动（由脚本外部的 pwsh 提供；这里只报告失败原因）
// -----------------------------------------------------------------------------
async function explainLauncherFailure() {
  log('\n[launcher] DevTools 端口没起来。本脚本不能自己 spawn 浏览器（沙箱 EPERM）。');
  log('[launcher] 请用下面的命令在外部启动（pwsh）：');
  const plan = launchPlan();
  for (const c of plan.candidates) {
    log(`  [Diagnostics.Process]::Start("${c.exe}", '${c.args.join(' ')}')`);
  }
  log('[launcher] 已知崩溃原因：DSH 沙箱拦截 Chromium 的 mojo 命名管道创建，');
  log('[launcher]   FATAL mojo\\public\\cpp\\platform\\platform_channel.cc Check failed: 拒绝访问。(0x5)');
}

function writeReport({ version, viewportResults, t0, launcherError }) {
  mkdirSync(OUT_DIR, { recursive: true });
  const js = { ranAt: new Date().toISOString(), durationMs: Date.now() - t0, version, launcherError, results, notes };
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(js, null, 2));
  const count = (st) => results.filter((r) => r.status === st).length;
  const lines = [];
  lines.push('# QA 验收报告 · ESC 暂停 / 底部面板按钮 / 属性面板');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 时长：${((Date.now() - t0) / 1000).toFixed(1)}s`);
  lines.push(`- 浏览器：${version ? version.Browser + ' @ ' + version.userAgent : '（未启动）'}`);
  lines.push(`- 汇总：PASS ${count('PASS')} · FAIL ${count('FAIL')} · WARN ${count('WARN')} · SKIP ${count('SKIP')} · BLOCKED ${count('BLOCKED')}`);
  lines.push('');
  if (launcherError) {
    lines.push('> ⚠ 浏览器未启动：' + launcherError);
    lines.push('');
  }
  lines.push('## 明细');
  lines.push('');
  lines.push('| 项 | 说明 | 结果 | 证据 |');
  lines.push('|---|---|---|---|');
  for (const r of results) {
    const shots = r.shots.length ? r.shots.map((s) => `[${s}](./${s})`).join(' ') : '';
    const detail = String(r.detail || '').replace(/\|/g, '\\|');
    lines.push(`| ${r.id} | ${r.name} | **${r.status}** | ${detail}${shots ? '<br>' + shots : ''} |`);
  }
  writeFileSync(join(OUT_DIR, 'REPORT.md'), lines.join('\n') + '\n');
  writeFileSync(join(OUT_DIR, 'results-summary.md'), lines.slice(0, 12).join('\n') + '\n');
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------
const t0 = Date.now();
mkdirSync(OUT_DIR, { recursive: true });

// 清理本脚本上次留下的截图（只清自己命名的）
try {
  for (const f of readdirSync(OUT_DIR)) {
    if (/^(1280x720|1920x1080)-\d+-.*\.png$/.test(f) && !flag('keep')) {
      try { (await import('node:fs')).unlinkSync(join(OUT_DIR, f)); } catch { /* ignore */ }
    }
  }
} catch { /* ignore */ }

const port = Number(arg('port', 9339));
log(`[qa] out dir: ${OUT_DIR}`);
log(`[qa] target: ${AUTO_URL}`);
log(`[qa] devtools port: ${port}`);
record('ENV0', '运行环境：Node 版本 / 工作目录', 'PASS', `${process.version} · ${ROOT}`);

// 0) 开发服务是否在线（页面加载的硬前置）
try {
  const r = await fetch(`http://127.0.0.1:${Number(arg('serve-port', 5190))}/index.html`, { signal: AbortSignal.timeout(2000) });
  record('ENV1', '静态服务在线（node tools/serve.mjs）', r.ok ? 'PASS' : 'FAIL', `${URL_BASE}/index.html → ${r.status}`);
} catch (e) {
  record('ENV1', '静态服务在线（node tools/serve.mjs）', 'FAIL', String(e.message || e));
}

// 1) 连接浏览器
let version = null;
let cdp = null;
let launcherError = null;
try {
  ({ cdp, version } = await connect(port));
  record('ENV2', 'DevTools 已连接', 'PASS', `${version.Browser} · ${version['Protocol-Version']}`);
  await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  // 页面级交互需要焦点模拟（无头模式默认不派发部分事件）
} catch (e) {
  launcherError = String(e.message || e);
  record('ENV2', 'DevTools 已连接', 'BLOCKED', launcherError);
  await explainLauncherFailure();
  writeReport({ version, viewportResults: [], t0, launcherError });
  log('\n[qa] 结论：浏览器无法启动 → 真机验收 BLOCKED（详见 REPORT.md）');
  process.exit(5);
}

for (const vp of VIEWPORTS) {
  await runViewport({ cdp, port }, vp);
}

writeReport({ version, viewportResults: null, t0, launcherError: null });
const fails = results.filter((r) => r.status === 'FAIL');
log(`\n[qa] 完成：PASS ${results.filter((r) => r.status === 'PASS').length} / FAIL ${fails.length} / WARN ${results.filter((r) => r.status === 'WARN').length}`);
if (fails.length) log('[qa] 失败项：\n' + fails.map((f) => `  - ${f.id} ${f.name}: ${f.detail}`).join('\n'));
try { await cdp.send('Browser.close'); } catch { /* 由外部关闭 */ }
cdp.close();
process.exit(fails.length ? 1 : 0);