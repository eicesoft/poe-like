// 反推浏览器里的异常：renderer 有 2656 次错误的同时 drawn=0，
// 用"严格 ctx"扫描所有 draw* 入口在【各种边界输入】下是否会抛异常（NaN、undefined、死亡、Boss 等）。
import { Renderer } from '../src/render/renderer.js';
import { createGame, updateGame } from '../src/game/app.js';
import * as SP from '../src/render/sprites.js';

const bad = [];
function ctxStrict() {
  const grad = { addColorStop: () => {} };
  const t = { canvas: { width: 100, height: 100 }, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', imageSmoothingEnabled: true, filter: 'none', shadowBlur: 0, shadowColor: '#000', shadowOffsetX: 0, shadowOffsetY: 0 };
  for (const m of ['save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform', 'resetTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'fillText', 'strokeText', 'drawImage', 'setLineDash', 'getLineDash']) t[m] = () => {};
  t.createLinearGradient = (...a) => { if (a.some((v) => !Number.isFinite(v))) throw new Error('linearGradient NaN ' + a); return grad; };
  t.createRadialGradient = (...a) => { if (a.some((v) => !Number.isFinite(v))) throw new Error('radialGradient NaN ' + a); return grad; };
  t.createPattern = () => null;
  t.measureText = () => ({ width: 10 });
  return new Proxy(t, {
    get(o, k) { if (k in o) return o[k]; throw new Error('ctx.' + String(k) + ' 不存在'); },
    set(o, k, v) { if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('ctx.' + String(k) + ' 非法值 ' + String(v)); o[k] = v; return true; },
  });
}

// 1) 用真实游戏数据长跑，每帧严格渲染
const gradCanvas = {
  width: 1280, height: 720, clientWidth: 1280, clientHeight: 720,
  getContext: () => ctxStrict(), style: {},
};
globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener() {} };
globalThis.document = { createElement: () => gradCanvas, getElementById: () => null };
const game = createGame({ seed: 1997 });
const w = game.world, p = w.player;
const r = new Renderer(gradCanvas);
r.resize(1280, 720);
const errs = new Map();
for (let f = 0; f < 60 * 90; f++) {
  const a = f / 100;
  updateGame(game, 1 / 60, {
    move: { x: Math.cos(a), z: Math.sin(a) }, aim: { x: p.x + Math.cos(a) * 6, z: p.z + Math.sin(a) * 6 },
    attackHeld: f % 3 === 0, dash: f % 300 === 0,
    skills: f % 120 === 0 ? ['groundSlam', 'whirlwind', 'warcry', 'bloodRage', 'rally'] : [],
  });
  try { r._renderFrame(w, 1 / 60, w.time); } catch (e) { const k = e.message.slice(0, 120); if (!errs.has(k)) errs.set(k, String(e.stack).split('\n').slice(1, 4).join(' | ')); }
  // 每帧也核对一次 drawn
  if (r.stats.drawnEntities === 0 && w.monsters.length > 0 && f > 10) bad.push('f' + f + ' drawn=0 但有怪');
}
console.log('长跑异常种类:', errs.size);
for (const [k, s] of errs) console.log(' ✗', k, '\n    ', s);
console.log(bad.slice(0, 3).join('\n'));
console.log('最终 drawn =', r.stats.drawnEntities, 'monsters =', w.monsters.length, 'errors =', r.errorCount || 0);