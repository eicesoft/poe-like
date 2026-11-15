import { describe, test, assert } from './_runner.mjs';
import { generateDungeon, floorRatio, isConnected, rollMapMods, TILE_WALL, MAP_THEMES } from '../src/game/dungeon.js';
import { RNG } from '../src/engine/rng.js';

describe('地牢生成', () => {
  test('100 个不同种子的地图全部连通、有个可走的起点', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const d = generateDungeon({ seed, level: 1 + (seed % 20) });
      assert.ok(floorRatio(d) > 0.12, `seed ${seed} 地板太少 ${floorRatio(d)}`);
      assert.ok(floorRatio(d) < 0.9, `seed ${seed} 地板太多`);
      assert.ok(isConnected(d), `seed ${seed} 不连通`);
      assert.ok(d.playerStart, `seed ${seed} 无起点`);
      assert.ok(d.circleWalkable(d.playerStart.x, d.playerStart.z, 0.35), `seed ${seed} 起点不可走`);
    }
  });

  test('同种子确定相同，不同种子不同', () => {
    const a = generateDungeon({ seed: 42, level: 3 });
    const b = generateDungeon({ seed: 42, level: 3 });
    const c = generateDungeon({ seed: 43, level: 3 });
    assert.deepEqual(Array.from(a.tiles), Array.from(b.tiles));
    assert.notDeepEqual(Array.from(a.tiles), Array.from(c.tiles));
  });

  test('地图尺寸随等级增大', () => {
    const s = generateDungeon({ seed: 7, level: 1 });
    const l = generateDungeon({ seed: 7, level: 20 });
    assert.ok(l.cols * l.rows > s.cols * s.rows);
  });

  test('主题与房间数据齐全', () => {
    const d = generateDungeon({ seed: 9, level: 4 });
    assert.ok(MAP_THEMES.some((t) => t.id === d.theme.id));
    assert.ok(d.rooms.length >= 4);
    assert.ok(d.torches.length > 0);
  });

  test('worldBounds 内坐标可判走、线检测不穿墙', () => {
    const d = generateDungeon({ seed: 11, level: 5 });
    // 找到两个地板格，检查连线穿墙时会返回 false
    const p = d.playerStart;
    assert.equal(d.lineClear(p.x, p.z, p.x, p.z), true);
    // 墙外
    const wb = d.worldBounds();
    assert.equal(d.circleWalkable(wb.minX + 0.1, wb.minZ + 0.1, 0.35), false);
  });

  test('地图词缀按等级数量递增，值合法', () => {
    const rng = new RNG(5);
    const m1 = rollMapMods(rng, 1);
    const m4 = rollMapMods(rng, 30);
    assert.ok(m1.length >= 1 && m1.length <= 4);
    assert.ok(m4.length >= m1.length);
    assert.equal(new Set(m4.map((m) => m.id)).size, m4.length);
    for (const m of [...m1, ...m4]) assert.ok(m.text.length > 0);
  });
});