// 真实世界渲染预览：用 createGame 生成的真实地牢与怪物，软件光栅器输出 PNG。
// 用法：node tools/preview-real.mjs [seed] [tier] [seconds]
import { writeFileSync, mkdirSync } from 'node:fs';
import { Renderer } from '../src/render/renderer.js';
import { renderPng } from '../tests/raster.mjs';
import { createGame, updateGame, clearEvents } from '../src/game/app.js';

const seed = Number(process.argv[2] || 42);
const tier = Number(process.argv[3] || 1);
const seconds = Number(process.argv[4] || 6);
mkdirSync('tools/_shots', { recursive: true });

const game = createGame({ seed, tier });
const w = game.world;
const p = w.player;
// 模拟若干秒，让怪物刷出来并靠近
const dt = 1 / 60;
for (let i = 0; i < 60 * seconds; i++) {
  let best = null, bd = 1e9;
  for (const m of w.monsters) { if (m.dead) continue; const d = Math.hypot(m.x - p.x, m.z - p.z); if (d < bd) { bd = d; best = m; } }
  updateGame(game, dt, {
    move: best && bd > 1.9 ? { x: (best.x - p.x) / bd, z: (best.z - p.z) / bd } : { x: 0, z: 0 },
    aim: best ? { x: best.x, z: best.z } : { x: p.x + 1, z: p.z },
    attackHeld: !!best && bd < 2.3,
    // [Lead] 1 号技能已从「裂地斩 groundSlam」换成「战争践踏 stomp」，预览要跟上主线技能
    skills: i % 150 === 0 ? ['stomp', 'warcry', 'whirlwind'] : [],
  });
}

const shots = [];
for (const task of ['idle', 'combat']) {
  const { png, renderer } = await renderPng(Renderer, w, {
    w: 1440, h: 810, frames: 24, dt,
    onFrame(i, r) {
      r.cam.target(p.x, p.z, 0, w.aim);
      if (task === 'combat') {
        // 触发一些战斗特效
        if (i === 3) r.emit({ type: 'skillCast', x: p.x, z: p.z, skillId: 'stomp' });
        // 践踏专属表现（落地扩张盘/裂纹/眩晕星/护甲辉光）：旧脚本只发 skillCast，
        // 换成 stomp 后要同时发 stomp 事件，否则预览图里看不到新技能的核心视觉。
        if (i === 4) r.emit({ type: 'stomp', x: p.x, z: p.z, r: 3.6, radius: 3.6, hits: 3, stunned: 3, armor: 33, dur: 4, level: 1, color: '#ffb347' });
        if (i === 5) r.emit({ type: 'stun', x: p.x + 1.6, z: p.z + 0.8, target: { x: p.x + 1.6, z: p.z + 0.8, height: 1.6 }, dur: 1.5 });
        if (i === 6) r.emit({ type: 'hit', x: p.x + 1.2, z: p.z + 0.4, amount: 96, crit: true, element: 'fire' });
        if (i === 9) r.emit({ type: 'skillCast', x: p.x, z: p.z, skillId: 'whirlwind' });
        if (i === 12) r.emit({ type: 'hit', x: p.x - 1.1, z: p.z + 1.0, amount: 33, element: 'cold' });
        if (i === 16) r.emit({ type: 'skillCast', x: p.x, z: p.z, skillId: 'warcry' });
      }
    },
  });
  const out = `tools/_shots/real-${task}.png`;
  writeFileSync(out, png);
  shots.push({ out, monsters: w.monsters.length, particles: renderer.particles.size, texts: renderer.text.activeCount, drawn: renderer.stats.drawnEntities, err: renderer.errorCount || 0, kb: Math.round(png.length / 1024) });
}
console.log(JSON.stringify({ seed, tier, map: w.map.name, monsters: w.monsters.length, player: { x: p.x, z: p.z, hp: p.hp, level: p.level }, shots }, null, 2));