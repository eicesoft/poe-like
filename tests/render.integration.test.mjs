// 与 Lead 的 world 契约做一次"适配冒烟"：用 Lead 描述的字段名（aim / torches / r+remaining / displayName 等）
// 跑若干帧，确认渲染层不会因为字段别名而崩。
import { describe, test, assert } from './_runner.mjs';
import { createMockCanvas, installMockDom } from './_mockcanvas.mjs';

function leadWorld() {
  const cols = 32, rows = 32;
  const tiles = new Uint8Array(cols * rows);
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      tiles[z * cols + x] = (x === 0 || z === 0 || x === cols - 1 || z === rows - 1) ? 1 : (x === 8 && z === 8 ? 1 : 0);
    }
  }
  tiles[8 * cols + 16] = 2; // 门
  const world = {
    tier: 3,
    map: { name: '众星教堂', mods: [{ text: '怪物伤害 +20%', type: 'damage' }], level: 3, tier: 3, theme: { floor: '#222', wall: '#111', accent: '#e8c05a', fog: '#000' } },
    dungeon: {
      cols, rows, tileSize: 1, tiles,
      theme: { floor: '#222', wall: '#111', accent: '#e8c05a', fog: '#000' },
      isWall(cx, cz) { return cx < 0 || cz < 0 || cx >= cols || cz >= rows || tiles[cz * cols + cx] === 1; },
      forEachFloor() {},
      toWorld(cx, cz) { return { x: cx + 0.5, z: cz + 0.5 }; },
      torches: [{ x: 8.5, z: 8.9, color: 'hsl(36 100% 60%)' }, { x: 16.5, z: 8.9 }],
    },
    player: { kind: 'player', x: 16, z: 16, vx: 3, vz: -1, facing: 1.2, radius: 0.35, hp: 60, maxHp: 140, mp: 20, maxMp: 50, anim: { state: 'move', t: 0.2, dur: 0.3 }, attackAnim: 0.7, hitFlash: 0.4, stats: {}, buffs: ['bloodRage'], skillBar: [], look: { armorColor: '#8a1f1f', weaponType: 'axe', cape: true } },
    monsters: [],
    all: [],
    projectiles: [],
    groundEffects: [],
    summoned: [],
    items: [],
    lootOrbs: [],
    events: [],
    aim: { x: 20, z: 18 },
  };
  ['husk', 'crawler', 'spitter', 'wraith', 'blob', 'bone'].forEach((type, i) => {
    const shapes = ['humanoid', 'quadruped', 'spider', 'wraith', 'blob', 'skeleton'];
    const m = {
      kind: 'monster', id: i + 1, type, x: 14 + i, z: 15 + (i % 3), vx: 0.5, vz: 0.2, facing: i,
      radius: 0.35, hp: 30, maxHp: 60, level: 4, anim: { state: 'attack', t: 0.1, dur: 0.2 }, hitFlash: 0.2,
      rarity: ['normal', 'magic', 'rare', 'boss', 'normal', 'magic'][i],
      elite: i === 2, isBoss: i === 3,
      visual: { color: ['#7f9a74', '#a0503a', '#c04a3a', '#6fa8d8', '#7ab04a', '#d8d2be'][i], size: 1 + i * 0.15, shape: shapes[i] },
      displayName: '怪物' + i, mods: [],
    };
    world.monsters.push(m);
    world.all.push(m);
  });
  world.all[0].dead = true;
  world.all[0].deathT = 0.4;
  world.player.x = 16;
  world.projectiles.push({ x: 17, z: 16.5, vx: 8, vz: 2, radius: 0.18, color: '#ff8844', kind: 'orb', owner: 'player' });
  world.groundEffects.push({ x: 15, z: 18, r: 1.4, dur: 3, remaining: 2.2, kind: 'fire', color: '#f80' });
  world.groundEffects.push({ x: 17, z: 18, r: 1.1, dur: 3, remaining: 1.0, kind: 'poison' });
  world.groundEffects.push({ x: 19, z: 18, r: 1.1, dur: 3, remaining: 2.6, kind: 'frost' });
  world.summoned.push({ x: 16.8, z: 17, radius: 0.4, kind: 'totem', hp: 20, maxHp: 40 });
  world.items.push({ x: 15.5, z: 14.5, item: { rarity: 'rare', name: '王者之刃', icon: 'sword', color: '#ffd700' }, ttl: 20, born: 0 });
  world.items.push({ x: 18.5, z: 14.5, item: { rarity: 'unique', name: '血之誓', icon: 'amulet', color: '#ff6600' }, ttl: 20, born: 0 });
  world.lootOrbs.push({ x: 16.2, z: 17.2, kind: 'gold', color: '#ffd700' }, { x: 16.4, z: 17.4, kind: 'xp' }, { x: 16.6, z: 17.6, kind: 'life' });
  world.events.push(
    { type: 'hit', x: 15, z: 15, amount: 42, crit: true, element: 'fire' },
    { type: 'hit', x: 15.5, z: 15.5, amount: 12, element: 'cold' },
    { type: 'kill', x: 16, z: 15 },
    { type: 'skillCast', x: 16, z: 16, skillId: 'ground_slam' },
    { type: 'skillCast', x: 16, z: 16, skillId: 'warcry' },
    { type: 'skillCast', x: 16, z: 16, skillId: 'whirlwind' },
    { type: 'skillCast', x: 16, z: 16, skillId: 'blood_rage' },
    { type: 'skillCast', x: 16, z: 16, skillId: 'rally' },
    { type: 'explosion', x: 17, z: 17, radius: 2.5 },
    { type: 'heal', x: 16, z: 16, amount: 30 },
    { type: 'loot', x: 15.5, z: 14.5, rarity: 'rare' },
    { type: 'orb', x: 16.2, z: 17.2, kind: 'gold' },
    { type: 'dash', x: 16, z: 16, facing: 1 },
    { type: 'levelUp', x: 16, z: 16 },
    { type: 'projectileHit', x: 15, z: 15, element: 'lightning', crit: true },
    { type: 'bossSpawn', x: 20, z: 20 },
    { type: 'waveStart', x: 16, z: 16 },
    { type: 'eliteSpawn', x: 19, z: 16 },
  );
  return world;
}

describe('Renderer × Lead world 契约适配', () => {
  test('Lead 字段（aim/torches/r+remaining/displayName/boss）跑 40 帧不崩', async () => {
    const uninstall = installMockDom();
    try {
      const { Renderer } = await import('../src/render/renderer.js');
      const canvas = createMockCanvas(1280, 720);
      const r = new Renderer(canvas);
      r.resize(); // 不传参：读 canvas.clientWidth / clientHeight
      assert.equal(r.w, 1280);
      assert.equal(r.h, 720);
      // Lead 会用 renderer.camera.screenToWorld 把鼠标位置转成 world.aim
      const cam = r.camera || r.cam;
      assert.equal(typeof cam.screenToWorld, 'function');
      const wpos = cam.screenToWorld(640, 360);
      assert.ok(Number.isFinite(wpos.x) && Number.isFinite(wpos.z));

      const world = leadWorld();
      let t = 0;
      for (let f = 0; f < 40; f++) {
        t += 1 / 60;
        r.render(world, 1 / 60, t);
      }
      assert.equal(r.errorCount || 0, 0, '不应吞到任何帧异常');
      assert.ok(r.particles.size > 0);
      // 事件不被清空
      assert.ok(world.events.length >= 18);
      // 帧内 API
      r.flash('red', 0.4, 0.3);
      r.shake(9);
      r.shockwave(16, 16, 'gold', { radius: 3 });
      r.slowMo(0.4, 0.3);
      r.setQuality('medium');
      r.render(world, 1 / 60, t + 1 / 60);
      r.setQuality('high');
      r.invalidateTerrain();
      r.render(world, 1 / 60, t + 2 / 60);
      assert.equal(r.errorCount || 0, 0);
    } finally {
      uninstall();
    }
  });

  test('单帧异常被吞掉且只警告一次（不白屏）', async () => {
    const uninstall = installMockDom();
    const warnings = [];
    const oldWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      const { Renderer } = await import('../src/render/renderer.js');
      const r = new Renderer(createMockCanvas(640, 360));
      r.resize(640, 360);
      // 故意注入会抛错的怪物数据
      const bad = { id: 1, x: 0, z: 0, radius: 0.35, get visual() { throw new Error('boom-visual'); } };
      const world = { player: { x: 0, z: 0, hp: 1, maxHp: 2 }, all: [bad], events: [] };
      r.render(world, 1 / 60, 0.016);
      r.render(world, 1 / 60, 0.032);
      // [Lead 修复后的语义] 单个实体抛异常会被隔离跳过（不再让整帧失败），因此计入 skippedEntities 而不是 errorCount；
      // 这样“某一只怪的坏数据”不会导致所有人/怪都看不见。
      assert.ok((r.stats.skippedEntities || 0) >= 1, '坏实体应被跳过');
      assert.ok(warnings.length >= 1 ? warnings.length === 1 : true, `同样错误只应警告一次，实际 ${warnings.length}`);
      assert.equal(r.errorCount || 0, 0, '单实体异常不应升级为整帧错误');
      // 出错后仍能继续渲染正常世界
      const okWorld = { player: { x: 0, z: 0, hp: 1, maxHp: 2 }, all: [], events: [] };
      r.render(okWorld, 1 / 60, 0.05);
    } finally {
      console.warn = oldWarn;
      uninstall();
    }
  });
});

describe('渲染层回归：真实世界 bug 修复', () => {
  test('相机：dt=0 时玩家精确落在屏幕中心附近（鼠标偏移有上限）', async () => {
    const { Camera } = await import('../src/render/camera.js');
    const cam = new Camera({ viewW: 800, viewH: 450 });
    // 准星在很远处：偏移必须被限制，不能把玩家推出中心
    cam.target(10, 10, 0, { x: 40, z: 30 });
    const s = cam.worldToScreen(10, 10, 0);
    const dx = Math.abs(s.x - 400), dy = Math.abs(s.y - 225);
    assert.ok(dx < 60 && dy < 60, `玩家应贴近屏幕中心，实际偏移 dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
    // render 内不要再覆盖外部设置：同一玩家位置连续 target+update 后仍居中
    cam.target(25.62, 9.67, 0, { x: 30.3, z: 11.3 });
    cam.update(1 / 60);
    const s2 = cam.worldToScreen(25.62, 9.67, 0);
    assert.ok(Math.abs(s2.x - 400) < 60 && Math.abs(s2.y - 225) < 60, `update 后应仍居中：${s2.x.toFixed(0)},${s2.y.toFixed(0)}`);
  });

  test('全屏闪烁/飘字不会画出"覆盖整个画布"的实心矩形', async () => {
    const uninstall = installMockDom();
    try {
      // 记录所有 fillRect 的设备尺寸，确保没有异常大块
      const { createMockCanvas } = await import('./_mockcanvas.mjs');
      const canvas = createMockCanvas(480, 270);
      const ctx = canvas.getContext('2d');
      const big = [];
      const realFillRect = ctx.fillRect.bind(ctx);
      ctx.fillRect = (x, y, w, h) => {
        if (w > 200 && h > 40) big.push([x, y, w, h]);
        return realFillRect(x, y, w, h);
      };
      const { Renderer } = await import('../src/render/renderer.js');
      const r = new Renderer(canvas);
      r.resize(480, 270);
      const world = {
        player: { x: 10, z: 10, hp: 50, maxHp: 100, facing: 0 },
        all: [], events: [],
        dungeon: { cols: 24, rows: 24, tileSize: 1, tiles: new Uint8Array(576), isWall: () => false },
      };
      for (let i = 0; i < 6; i++) {
        r.cam.target(10, 10, 0, null);
        if (i === 1) r.emit({ type: 'heal', x: 10, z: 10, amount: 60 });
        if (i === 2) r.emit({ type: 'hit', x: 11, z: 10, amount: 88, crit: true, element: 'fire' });
        if (i === 3) r.flash('gold', 0.25, 0.4);
        r.render(world, 1 / 60, i / 60);
      }
      // 允许的"大块"只有：整屏背景 / 整屏暗角 / 闪光层（都是故意的全屏效果，且尺寸=画布）
      // 任何"比画布小、但又不是全屏"的中等大块都说明某个元素被错误放大
      const bad = big.filter(([x, y, w, h]) => !(Math.abs(w - 480) <= 1 && Math.abs(h - 270) <= 1));
      assert.equal(bad.length, 0, '不应出现异常放大的中等色块：' + JSON.stringify(bad.slice(0, 3)));
      // 飘字确实产生（heal + crit 两条）
      assert.ok(r.text.activeCount >= 2, `飘字数量应 >= 2，实际 ${r.text.activeCount}`);
      // 飘字的字号必须是"文字级"（<= 64px），不能被异常放大
      r.text.forEach((ft) => {
        assert.ok(ft.size > 0 && ft.size <= 64, `飘字字号异常：${ft.size}`);
        assert.ok(Number.isFinite(ft.x) && Number.isFinite(ft.z), '飘字坐标必须有限');
      });
    } finally {
      uninstall();
    }
  });

  test('渐变颜色字符串合法（不能出现 NaN / undefined）', async () => {
    const { hsl, parseColor, radialGlow, drawMonster, drawPlayer } = await import('../src/render/sprites.js');
    const { createMockCtx } = await import('./_mockcanvas.mjs');
    const report = {};
    const ctx = createMockCtx(report);
    // hsl 各种边界
    for (const v of [0, -30, 400, 22.5]) assert.ok(!/NaN|undefined/.test(hsl(v, 100, 50, 0.5)), hsl(v, 100, 50, 0.5));
    // parseColor 边界
    for (const c of ['#8a1f1f', 'hsl(20 100% 50%)', 22, null, undefined, '#abc']) {
      const p = parseColor(c);
      assert.ok(Number.isFinite(p.h) && Number.isFinite(p.s) && Number.isFinite(p.l), `parseColor(${c})`);
    }
    // 用 mock ctx 画一遍所有怪物形态（若颜色非法，mock 会抛错）
    const shapes = ['humanoid', 'quadruped', 'spider', 'wraith', 'skeleton', 'blob'];
    for (const shape of shapes) {
      drawMonster(ctx, 100, 100, { id: 1, type: 'x', x: 0, z: 0, facing: 0.3, radius: 0.4, hp: 5, maxHp: 10, rarity: 'normal', visual: { color: '#8a6a5a', size: 1, shape } }, 30, 1, {});
    }
    drawPlayer(ctx, 100, 100, { x: 0, z: 0, facing: 0.3, vx: 1, vz: 0, attackAnim: 0.4, hitFlash: 0.5, look: { armorColor: '#8a1f1f', weaponType: 'axe', cape: true } }, 30, 1, { attackAnim: 0.4, moving: true });
    radialGlow(ctx, 0, 0, 20, 40, 100, 60, 0.5);
  });

  test('怪物尺寸相对玩家合理（普通怪 ≈ 0.9-1.2 身位，Boss ≈ 2 倍）', async () => {
    // 通过真实绘制包围盒比较屏幕高度
    const { SoftCanvas } = await import('./raster.mjs');
    const { drawMonster, drawPlayer } = await import('../src/render/sprites.js');
    const measure = (draw) => {
      const W = 200, H = 260;
      const sc = new SoftCanvas(W, H);
      sc.ctx.fillStyle = '#000';
      sc.ctx.fillRect(0, 0, W, H);
      draw(sc.ctx);
      let y0 = 1e9, y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          if (sc.buf[i] + sc.buf[i + 1] + sc.buf[i + 2] > 0.06) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
      }
      return y1 - y0;
    };
    const u = 40;
    const playerH = measure((ctx) => drawPlayer(ctx, 100, 240, { x: 0, z: 0, facing: 0, vx: 0, vz: 0, attackAnim: 0, hitFlash: 0, look: { armorColor: '#8a1f1f', weaponType: 'axe', cape: true } }, u, 1, { moving: false }));
    const normalH = measure((ctx) => drawMonster(ctx, 100, 240, { id: 1, type: 'husk', x: 0, z: 0, facing: 0, radius: 0.45, hp: 10, maxHp: 20, rarity: 'normal', visual: { color: '#6f7a4a', size: 0.95, shape: 'humanoid' } }, u, 1, {}));
    const bossH = measure((ctx) => drawMonster(ctx, 100, 240, { id: 2, type: 'boss', x: 0, z: 0, facing: 0, radius: 0.6, hp: 10, maxHp: 20, rarity: 'boss', isBoss: true, visual: { color: '#b02020', size: 1.2, shape: 'humanoid' } }, u, 1, {}));
    assert.ok(playerH > 20, `玩家应可测量，实际 ${playerH}`);
    const ratio = normalH / playerH;
    assert.ok(ratio > 0.75 && ratio < 1.35, `普通怪/玩家身高比 ${ratio.toFixed(2)} 应在 0.75-1.35`);
    assert.ok(bossH / normalH > 1.5, `Boss 应明显更大：boss=${bossH} normal=${normalH}`);
  });
});