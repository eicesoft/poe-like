// 旋风斩"停止后不应残留"回归测试
import { describe, test, assert } from './_runner.mjs';
import { createGame, updateGame, clearEvents } from '../src/game/app.js';
import { Renderer } from '../src/render/renderer.js';

function recorder() {
  const grad = { addColorStop: () => {} };
  const target = {
    canvas: { width: 1280, height: 720 },
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', imageSmoothingEnabled: true,
  };
  for (const m of ['save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform', 'resetTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'fillText', 'strokeText', 'drawImage', 'setLineDash', 'getLineDash']) target[m] = () => {};
  target.createLinearGradient = () => grad;
  target.createRadialGradient = () => grad;
  target.createPattern = () => null;
  target.measureText = () => ({ width: 10 });
  return { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720, getContext: () => target };
}

function makeRig(seed = 42) {
  const game = createGame({ seed });
  const w = game.world, p = w.player;
  globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener() {} };
  globalThis.document = { createElement: () => recorder(), getElementById: () => null };
  const r = new Renderer(recorder());
  r.resize(1280, 720);
  const dt = 1 / 60;
  const step = (input) => {
    updateGame(game, dt, input);
    for (const e of w.events) r.emit(e);
    clearEvents(w);
    r.render(w, dt, w.time);
  };
  return { game, w, p, r, step };
}

describe('旋风斩：停止后不残留', () => {
  test('松开后 0.15 秒内刀光完全消失', () => {
    const { p, r, step } = makeRig();
    for (let i = 0; i < 40; i++) step({ move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: ['whirlwind'], releaseChannels: false });
    assert.ok(r.whirl.active, '按住时应有旋风视觉');
    r.whirl.angle = 0; // 基准
    let gone = -1;
    for (let i = 0; i < 30; i++) {
      step({ move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: [], releaseChannels: true });
      if (!r.whirl.active) { gone = i; break; }
    }
    assert.ok(gone >= 0, '松开后旋风必须结束');
    assert.ok(gone <= 9, `松手后残留太久：${gone} 帧（>0.15s）`);
  });

  test('松开后旋涡角度冻结（不再旋转）', () => {
    const { p, r, step } = makeRig();
    for (let i = 0; i < 40; i++) step({ move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: ['whirlwind'], releaseChannels: false });
    step({ move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: [], releaseChannels: true });
    const a0 = r.whirl.angle;
    for (let i = 0; i < 3; i++) step({ move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: [], releaseChannels: true });
    assert.ok(Math.abs(r.whirl.angle - a0) < 1e-9, '松手后不应继续旋转');
  });

  test('whirl 持续事件不会给渲染层"续命"', () => {
    const { p, r, step } = makeRig();
    for (let i = 0; i < 20; i++) step({ move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: ['whirlwind'], releaseChannels: false });
    // 松手，但仍手动灌入核心的 whirl 事件（模拟事件滞后）
    for (let i = 0; i < 12; i++) {
      r.emit({ type: 'whirl', x: p.x, z: p.z, radius: 2.4, dt: 1 / 60 });
      step({ move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: [], releaseChannels: true });
    }
    assert.ok(!r.whirl.active, 'whirl 事件不应让旋风一直停留');
  });
});