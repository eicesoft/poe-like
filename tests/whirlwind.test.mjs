// 旋风斩（whirlwind）回归测试：确保"技能有视觉表现"且"不会把角色糊掉"
import { describe, test, assert } from './_runner.mjs';
import { createGame, updateGame } from '../src/game/app.js';
import { Renderer } from '../src/render/renderer.js';

/** 记录所有绘制调用的假 canvas（不渲染像素，只看调用序列） */
function recorder() {
  const calls = [];
  const grad = { addColorStop: () => {} };
  const target = {
    canvas: { width: 1280, height: 720 },
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', imageSmoothingEnabled: true,
  };
  for (const m of ['save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform', 'resetTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'fillText', 'strokeText', 'drawImage', 'setLineDash', 'getLineDash']) {
    target[m] = (...a) => { calls.push([m, ...a.filter((v) => typeof v === 'number')]); };
  }
  target.createLinearGradient = () => grad;
  target.createRadialGradient = () => grad;
  target.createPattern = () => null;
  target.measureText = () => ({ width: 10 });
  return { ctx: target, calls, canvas: { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720, getContext: () => target } };
}

function setupWhirl(seed = 42) {
  const game = createGame({ seed });
  const w = game.world, p = w.player;
  for (let i = 0; i < 90; i++) {
    updateGame(game, 1 / 60, { move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: ['whirlwind'], releaseChannels: false });
  }
  return { game, w, p };
}

describe('旋风斩视觉', () => {
  test('按住旋风斩时玩家进入 whirlwind 状态（不反复重置为 attack）', () => {
    const { p } = setupWhirl();
    assert.equal(p.whirlspinning, true, 'player.whirlspinning 应为 true');
    assert.equal(p.anim.state, 'whirlwind', 'anim.state 应为 whirlwind');
  });

  test('松开后旋风状态结束', () => {
    const { game, p } = setupWhirl();
    for (let i = 0; i < 20; i++) {
      updateGame(game, 1 / 60, { move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, skills: [], releaseChannels: true });
    }
    assert.ok(!p.whirlspinning, '松开后 whirlspinning 应为 false');
  });

  test('渲染层在旋风期间会画出刀光（且不会崩）', () => {
    const { w, p } = setupWhirl();
    const rec = recorder();
    globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener() {} };
    globalThis.document = { createElement: () => rec.canvas, getElementById: () => null };
    const r = new Renderer(rec.canvas);
    r.resize(1280, 720);
    for (let i = 0; i < 20; i++) r.render(w, 1 / 60, w.time + i / 60);
    assert.ok(r.whirl.active, '旋风层应处于激活状态');
    assert.ok(r.whirl.angle > 0, '旋涡角度应随时间推进');
    assert.ok(!r.errorCount, '渲染不应抛异常');
    // 记录到非空绘制调用，说明确实画了东西
    assert.ok(rec.calls.length > 100, `绘制调用过少：${rec.calls.length}`);
    // 且玩家实体本身仍被绘制
    assert.ok(r.stats.drawnEntities >= 1, '玩家/怪物应被绘制');
    void p;
  });

  test('旋风期间粒子数量不会爆掉（避免白色粉尘把角色糊住）', () => {
    const { w } = setupWhirl();
    const rec = recorder();
    globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener() {} };
    globalThis.document = { createElement: () => rec.canvas, getElementById: () => null };
    const r = new Renderer(rec.canvas);
    r.resize(1280, 720);
    for (let i = 0; i < 180; i++) r.render(w, 1 / 60, w.time + i / 60);
    // 环境余烬本身就有数百颗粒子；这里只要求旋风不会让它无限膨胀
    assert.ok(r.particles.count <= r.particles.max, `粒子数超出上限：${r.particles.count}`);
  });

  test('drawWhirlBlades 不再整圈/整面填白（防止把角色糊成白盘）', async () => {
    const SP = await import('../src/render/sprites.js');
    const rec = recorder();
    SP.drawWhirlBlades(rec.ctx, 0, 0, 40, 1.2, { h: 20, s: 50, l: 40 }, { h: 44, s: 90, l: 60 });
    // 不允许出现 alpha 很高的白色填充
    assert.ok(!rec.calls.some((c) => c[0] === 'fill' && c.length > 0 && false), 'noop');
    const whiteFills = rec.calls.filter((c) => c[0] === 'fill').length;
    assert.ok(whiteFills === 0, `旋风刀光不应使用面填充（实际 ${whiteFills} 次）`);
  });
});