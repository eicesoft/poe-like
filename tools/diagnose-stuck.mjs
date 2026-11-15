// 移动卡死诊断：连续模拟"移动+攻击"，统计"活着但原地不动"的时长。
// 说明：角色死亡后本来就不会移动，所以只统计存活期间的卡死。
import { createGame, updateGame } from '../src/game/app.js';

export function simulateStuck(seed, seconds, input) {
  const g = createGame({ seed });
  const w = g.world, p = w.player;
  const dt = 1 / 60;
  let prevX = p.x, prevZ = p.z, stuck = 0, maxStuck = 0, worst = null;
  for (let i = 0; i < 60 * seconds; i++) {
    updateGame(g, dt, input(p, i));
    const moved = Math.hypot(p.x - prevX, p.z - prevZ);
    prevX = p.x; prevZ = p.z;
    if (!p.dead && moved < 0.001) {
      stuck++;
      if (stuck > maxStuck) { maxStuck = stuck; worst = { t: i / 60, x: p.x, z: p.z }; }
    } else stuck = 0;
  }
  return { maxStuck, worst, world: w, player: p };
}

const dirs = [[0.707, -0.707], [1, 0], [0, 1], [-1, 0], [0, -1], [-0.707, 0.707]];
let bad = 0;
const rows = [];
for (const seed of [21, 42, 7, 123]) {
  for (const d of dirs) {
    const r = simulateStuck(seed, 30, (p) => ({ move: { x: d[0], z: d[1] }, aim: { x: p.x + d[0] * 2, z: p.z + d[1] * 2 }, attackHeld: true }));
    const s = r.maxStuck / 60;
    if (s > 0.5) bad++;
    rows.push(`seed=${seed} dir=(${d[0]},${d[1]}) 存活期最长不动 ${s.toFixed(2)}s 死了=${r.player.dead}${s > 0.5 ? '  <== 卡住' : ''}`);
  }
}
console.log(rows.join('\n'));
console.log(bad ? `\n共 ${bad} 组出现 >0.5s 的存活期卡死` : '\n✅ 存活期间无 >0.5s 的卡死');
process.exitCode = bad ? 1 : 0;