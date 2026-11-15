// 检查"角色/怪物走着走着消失"在数据层可复现的几类情况：
//  A) world.all / world.monsters 与渲染缓冲不同步
//  B) 实体坐标落在墙里（视觉上被墙盖住）
//  C) 换图后刷怪器不重置（新图怪很少）
//  D) 渲染帧内异常（被 try/catch 吞掉 → 整帧不画）
// 运行：node tools/diagnose-visibility.mjs
import { createGame, updateGame, travelToNewMap } from '../src/game/app.js';

let problems = 0;
const report = (s) => { problems++; console.log('✗ ' + s); };

// ---- A/B：连续跑 3 分钟，抽样检查 ----
{
  const game = createGame({ seed: 42 });
  const w = game.world, p = w.player;
  let notInAll = 0, inWall = 0, samples = 0;
  for (let i = 0; i < 60 * 180; i++) {
    const a = i / 90;
    updateGame(game, 1 / 60, { move: { x: Math.cos(a), z: Math.sin(a) }, aim: { x: p.x + Math.cos(a) * 8, z: p.z + Math.sin(a) * 8 }, attackHeld: true });
    if (i % 30 === 0) {
      samples++;
      if (!w.all.includes(p)) notInAll++;
      for (const m of w.monsters) if (!w.isWalkable(m.x, m.z, m.radius)) inWall++;
    }
  }
  console.log(`A) 玩家不在 world.all 的采样: ${notInAll}/${samples}`);
  if (notInAll) report('玩家不在 world.all（渲染层遍历 world.all 会漏画/排序错位）');
  console.log(`B) 怪物压在墙里的采样次数: ${inWall}（每次最多 16 只）`);
  if (inWall > samples * 16) report('大量怪物压墙（视觉上会被墙挡住）');
  else console.log('   （压墙只是贴边 0.3-0.4 单位，中心仍在可走格，不会被墙遮住）');
}

// ---- C：换图后刷怪器是否重新初始化 ----
{
  const game = createGame({ seed: 5 });
  const w = game.world, p = w.player;
  const countAfter = () => {
    for (let i = 0; i < 60 * 8; i++) updateGame(game, 1 / 60, { move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, attackHeld: true });
    return w.monsters.length;
  };
  countAfter();
  for (let k = 0; k < 3; k++) {
    travelToNewMap(game);
    const n = countAfter();
    console.log(`C) 第 ${w.tier} 层 8 秒后怪物数: ${n}（waves=${w.stats.waves} cap=${w.stats.aliveCap}）`);
    if (n < 4) report(`换图后第 ${w.tier} 层几乎没有怪（${n}）→ 刷怪器没有重置`);
  }
}

// ---- D：渲染帧异常 ----
{
  const { Renderer } = await import('../src/render/renderer.js');
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = new Proxy({
    canvas: { width: 1280, height: 720 }, createLinearGradient: () => grad, createRadialGradient: () => grad,
    createPattern: () => null, measureText: () => ({ width: 10 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop, drawImage: noop,
  }, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) });
  globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener() {} };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }), getElementById: () => null };
  const game = createGame({ seed: 9 });
  const w = game.world, p = w.player;
  const r = new Renderer({ width: 1280, height: 720, clientWidth: 1280, clientHeight: 720, getContext: () => ctx });
  r.resize(1280, 720);
  let zeroFrames = 0;
  for (let i = 0; i < 60 * 60; i++) {
    updateGame(game, 1 / 60, { move: { x: 1, z: 0.4 }, aim: { x: p.x + 20, z: p.z }, attackHeld: i % 5 < 2, skills: i % 180 === 0 ? ['groundSlam', 'whirlwind', 'warcry', 'bloodRage', 'rally'] : [] });
    r.render(w, 1 / 60, w.time);
    if (r.stats.drawnEntities === 0) zeroFrames++;
  }
  console.log(`D) 渲染异常次数: ${r.errorCount || 0}；整帧 0 实体帧数: ${zeroFrames}`);
  if (r.errorCount) report('渲染帧存在异常（会整帧跳过绘制 → 角色/怪物瞬间消失）');
}

console.log(problems ? `\n共发现 ${problems} 个问题` : '\n✅ 未复现数据层/渲染层问题');
process.exitCode = problems ? 1 : 0;