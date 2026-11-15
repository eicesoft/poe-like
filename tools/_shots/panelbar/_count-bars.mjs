// 精确计数：在真实 #hud 子树里数 #panel-bar 出现次数（每个 GameUI 实例各算一次）。
const doc = { _byId: new Map() };
function mk(tag) {
  const n = {
    tagName: (tag || 'div').toUpperCase(), id: '', className: '', children: [], parentNode: null, style: {}, _attrs: {}, _listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') { this.id = String(v); this._attrs.id = this.id; } },
    getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, focus() {},
    getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); },
    getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 720, right: 1280, bottom: 720 }; },
    width: 1280, height: 720, clientWidth: 1280, clientHeight: 720, textContent: '',
  };
  return n;
}
const body = mk('body'); doc.body = body;
doc.createElement = (t) => mk(t);
doc.getElementById = (id) => { let found = null; const walk = (n) => { for (const c of (n.children || [])) { if (!found && c.id === id) found = c; walk(c); } }; walk(body); return found; };
doc.querySelector = () => null; doc.querySelectorAll = () => []; doc.addEventListener = () => {};
const app = mk('div'); app.id = 'app'; body.appendChild(app);
for (const id of ['game', 'hud', 'topbar', 'char-head', 'avatar', 'char-name', 'char-level', 'bar-hp', 'txt-hp', 'bar-mp', 'txt-mp', 'bar-xp', 'txt-xp', 'map-info', 'map-name', 'map-mods', 'map-progress', 'kill-count', 'wave-count', 'stats-panel', 'skillbar', 'log', 'combo', 'loot-bar', 'loot-items', 'help-hint', 'tooltip', 'banner', 'damage-layer', 'modal', 'modal-title', 'modal-body', 'modal-foot', 'modal-close', 'start-screen', 'loading', 'btn-start']) {
  const n = mk(id === 'game' ? 'canvas' : 'div'); n.id = id; app.appendChild(n);
}
globalThis.document = doc;
globalThis.window = { addEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, location: { search: '' } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { GameUI } = await import(new URL('../../../src/ui/ui.js', import.meta.url).href);
const mkGame = () => ({
  world: { time: 0, tier: 1, map: { name: 'x', tier: 1, level: 1, theme: {} }, stats: { kills: 0, waves: 0 }, monsters: [], projectiles: [], all: [], player: { x: 0, z: 0, hp: 100, maxHp: 100, mp: 5, maxMp: 5, level: 1, xp: 0, skillBar: [], stats: {}, gear: {} } },
  inv: { talentPoints: 0, skillPoints: { total: 0 }, equipment: {}, skillRefine: {} },
  stats: { xp: { xpMax: 100 } }, actions: {},
});
const countIn = (root, id) => { let n = 0; const walk = (x) => { for (const c of x.children) { if (c.id === id) n++; walk(c); } }; walk(root); return n; };
const hud = doc.getElementById('hud');
const ui = new GameUI(mkGame());
const n1 = countIn(hud, 'panel-bar');
const ui2 = new GameUI(mkGame()); // 第二个实例：模拟 HMR / 重复初始化
const n2 = countIn(hud, 'panel-bar');
// 第三、四个实例：面板打开期间 / 暂停期间再实例化（最容易叠两个的场景）
// 【桩限制】openPanel('stats') 需要 #modal 等静态节点：这里只验证"接管"，不驱动面板 UI，
// 所以直接用 modalOpen 标记模拟"面板开着"。
ui.modalOpen = 'stats';
const ui3 = new GameUI(mkGame());
const n3 = countIn(hud, 'panel-bar');
const game4 = mkGame();
game4.paused = true;
const ui4 = new GameUI(game4);
ui4.paused = true;
if (typeof ui4._showPauseChrome === 'function') {
  try { ui4._showPauseChrome(); } catch { /* 桩里没有 #pause 宿主时忽略 */ }
}
const n4 = countIn(hud, 'panel-bar');
const pauseCount = (() => { let n = 0; const walk = (x) => { for (const c of x.children) { if (c.id === 'pause-menu') n++; walk(c); } }; walk(body); return n; })();
console.log(JSON.stringify({ afterFirstUI: n1, afterSecondUI: n2, afterThirdWithPanelOpen: n3, afterFourthWhilePaused: n4, pauseMenuCount: pauseCount, hudChildren: hud.children.map((c) => c.id || c.className) }, null, 2));
// 退出码语义：只有多出来的那一列才算 FAIL（第 2 个实例触发 G1 旧 bug 时为 2 → exit 1）
process.exitCode = (n1 === 1 && n2 === 1 && n3 === 1 && n4 === 1 && pauseCount <= 1) ? 0 : 1;