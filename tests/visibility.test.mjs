// 回归测试：玩家"走着走着丢失/卡死"相关的修复
//   1) world.all 必须始终包含玩家（渲染层/查询依赖）
//   2) 存活期间"按住方向键 + 攻击"不应出现长时间原地不动
//   3) 换图后刷怪器必须重置（新图会持续刷怪）
//   4) 死亡复活后必须能正常移动（不会被旧状态/墙内位置锁死）
import { describe, test, assert } from './_runner.mjs';
import { createGame, updateGame, revivePlayer, travelToNewMap, unstickPlayer } from '../src/game/app.js';

describe('可见性 / 移动回归', () => {
  test('world.all 始终包含玩家（含换图后）', () => {
    const game = createGame({ seed: 42 });
    const w = game.world, p = w.player;
    assert.ok(w.all.includes(p), '初始 world.all 应包含玩家');
    for (let i = 0; i < 120; i++) updateGame(game, 1 / 60, { move: { x: 1, z: 0 }, aim: { x: p.x + 3, z: p.z } });
    assert.ok(w.all.includes(p), '运行后仍在');
    travelToNewMap(game);
    assert.ok(w.all.includes(p), '换图后仍在');
    assert.equal(w.monsters.filter((m) => m === p).length, 0, '玩家不应被当成怪物重复登记');
  });

  test('按住方向键 + 攻击：存活期间不出现 >0.5s 的原地不动', () => {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, -0.707]];
    for (const seed of [21, 7]) {
      for (const d of dirs) {
        const game = createGame({ seed });
        const w = game.world, p = w.player;
        let prevX = p.x, prevZ = p.z, stuck = 0, maxStuck = 0;
        for (let i = 0; i < 60 * 20; i++) {
          updateGame(game, 1 / 60, { move: { x: d[0], z: d[1] }, aim: { x: p.x + d[0] * 2, z: p.z + d[1] * 2 }, attackHeld: true });
          const moved = Math.hypot(p.x - prevX, p.z - prevZ);
          prevX = p.x; prevZ = p.z;
          if (!p.dead && moved < 0.001) { stuck++; maxStuck = Math.max(maxStuck, stuck); } else stuck = 0;
        }
        assert.ok(maxStuck < 30, `seed=${seed} dir=(${d}) 最长不动 ${(maxStuck / 60).toFixed(2)}s`);
      }
    }
  });

  test('压墙时 unstickPlayer 会把实体推到合法位置', () => {
    const game = createGame({ seed: 5 });
    const w = game.world, p = w.player;
    // 人为把玩家塞进墙里
    let found = false;
    for (let z = 2; z < w.dungeon.rows - 2 && !found; z++) {
      for (let x = 2; x < w.dungeon.cols - 2 && !found; x++) {
        if (w.dungeon.get(x, z) === 1) { p.x = x + 0.5; p.z = z + 0.5; found = true; }
      }
    }
    assert.ok(found, '地图里应有墙');
    const fixed = unstickPlayer(w, p);
    assert.ok(fixed, '应执行脱困');
    assert.ok(w.dungeon.circleWalkable(p.x, p.z, p.radius ?? 0.45), '脱困后碰撞圆完全可走');
  });

  test('换图后刷怪器重置，新地图会持续刷怪', () => {
    const game = createGame({ seed: 5 });
    const w = game.world, p = w.player;
    for (let k = 0; k < 2; k++) {
      travelToNewMap(game);
      for (let i = 0; i < 60 * 6; i++) updateGame(game, 1 / 60, { move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z }, attackHeld: true });
      assert.ok(w.monsters.length >= 4, `第 ${w.tier} 层应刷出怪物（实际 ${w.monsters.length}）`);
      assert.ok(w.stats.waves >= 1);
    }
  });

  test('复活后可以正常移动，且角色站在可走位置', () => {
    const game = createGame({ seed: 11 });
    const w = game.world, p = w.player;
    // 故意把玩家打到濒死
    p.hp = 1;
    for (let i = 0; i < 60 * 20 && !p.dead; i++) updateGame(game, 1 / 60, { move: { x: 0, z: 0 }, aim: { x: p.x + 3, z: p.z } });
    if (!p.dead) { p.hp = 0; p.dead = true; }
    revivePlayer(game);
    assert.ok(!p.dead, '复活后应为存活');
    assert.ok(w.dungeon.circleWalkable(p.x, p.z, p.radius ?? 0.45), '复活位置必须可走');
    const x0 = p.x, z0 = p.z;
    for (let i = 0; i < 30; i++) updateGame(game, 1 / 60, { move: { x: 1, z: 0 }, aim: { x: p.x + 3, z: p.z } });
    assert.ok(Math.hypot(p.x - x0, p.z - z0) > 0.1, '复活后 0.5 秒内应能移动');
  });
});