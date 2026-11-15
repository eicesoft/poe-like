// 渲染层测试：纯逻辑（camera / particles / floatingText / screenFx / project）
// + 用 mock canvas 跑通 Renderer 全流程（无浏览器依赖）
import { describe, test, assert } from './_runner.mjs';
import { Camera } from '../src/render/camera.js';
import { project } from '../src/render/project.js';
import { ParticleSystem } from '../src/render/particles.js';
import { FloatingText } from '../src/render/floatingText.js';
import { ScreenFx } from '../src/render/screenFx.js';
import { EffectField, normalizeSkillId } from '../src/render/effects.js';
import { createMockCanvas, installMockDom } from './_mockcanvas.mjs';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('投影 project / Camera 世界↔屏幕互逆', () => {
  test('世界坐标 → 屏幕遵循 2.5D 公式', () => {
    const cam = { x: 0, y: 0, scale: 30, squash: 0.72, heightK: 0.9 };
    const v = { cx: 400, cy: 300 };
    const s = project(1, 2, 0, cam, v);
    assert.ok(near(s.x, 400 + 1 * 30), `sx=${s.x}`);
    assert.ok(near(s.y, 300 + 2 * 30 * 0.72), `sy=${s.y}`);
    const s2 = project(1, 2, 1, cam, v);
    assert.ok(near(s2.y, s.y - 1 * 30 * 0.9), '高度应使屏幕上移');
  });

  test('project 单调性：z 增加 → 屏幕 y 增加；x 增加 → 屏幕 x 增加', () => {
    const cam = { x: 3, y: -2, scale: 28 };
    const v = { cx: 640, cy: 360 };
    let prevY = -Infinity;
    for (let z = -10; z <= 10; z += 0.5) {
      const s = project(0.3, z, 0, cam, v);
      assert.ok(s.y > prevY, `z=${z} 时 y 未递增`);
      prevY = s.y;
    }
    let prevX = -Infinity;
    for (let x = -10; x <= 10; x += 0.5) {
      const s = project(x, 2, 0, cam, v);
      assert.ok(s.x > prevX);
      prevX = s.x;
    }
  });

  test('Camera.worldToScreen / screenToWorld 互逆', () => {
    const cam = new Camera({ viewW: 1280, viewH: 720 });
    cam.target(7.5, -3.25, 0); // dt=0 → 立即定位
    for (const [x, z] of [[0, 0], [10, 20], [-5.5, 3.125], [7.5, -3.25]]) {
      const s = cam.worldToScreen(x, z, 0);
      const w = cam.screenToWorld(s.x, s.y);
      assert.ok(near(w.x, x, 1e-9), `x ${w.x} != ${x}`);
      assert.ok(near(w.z, z, 1e-9), `z ${w.z} != ${z}`);
    }
    // 高度只影响 y
    const a = cam.worldToScreen(1, 1, 0);
    const b = cam.worldToScreen(1, 1, 2);
    assert.ok(near(a.x, b.x));
    assert.ok(b.y < a.y);
  });

  test('scale = clamp(viewW/34, 22, 40)，resize 后重算', () => {
    const cam = new Camera({ viewW: 1280, viewH: 720 });
    assert.ok(near(cam.scale, Math.min(40, Math.max(22, 1280 / 34))));
    cam.resize(600, 720);
    assert.equal(cam.scale, 22);
    cam.resize(4000, 720);
    assert.equal(cam.scale, 40);
  });

  test('shake 之后位置有偏移，update(dt) 后衰减', () => {
    const cam = new Camera({ viewW: 1280, viewH: 720 });
    cam.target(0, 0, 0);
    const base = cam.worldToScreen(1, 1, 0);
    cam.shake(12);
    cam.update(1 / 60);
    assert.ok(cam.shakeAmt > 0, '震动幅度应 > 0');
    const shook = cam.worldToScreen(1, 1, 0);
    assert.ok(Math.abs(shook.x - base.x) > 0.01 || Math.abs(shook.y - base.y) > 0.01, '震动应造成屏幕偏移');
    // 持续若干秒后应衰减为 0
    for (let i = 0; i < 120; i++) cam.update(1 / 60);
    assert.equal(cam.shakeAmt, 0);
    assert.equal(cam.shakeX, 0);
    const calm = cam.worldToScreen(1, 1, 0);
    assert.ok(near(calm.x, base.x, 1e-9) && near(calm.y, base.y, 1e-9));
  });

  test('相机平滑跟随（lerp），dt=0 时瞬时对齐', () => {
    const cam = new Camera({ viewW: 1280, viewH: 720 });
    cam.target(0, 0, 0);
    cam.target(10, 0, 1 / 60);
    assert.ok(cam.x > 0 && cam.x < 10, `lerp 后应在中间: ${cam.x}`);
    cam.target(10, 0, 0);
    assert.equal(cam.x, 10);
  });
});

describe('ParticleSystem 对象池与上限', () => {
  test('spawn 5000 次后 size <= max', () => {
    const ps = new ParticleSystem(200);
    for (let i = 0; i < 5000; i++) ps.spawnBurst(0, 0, { count: 1, speed: 1 });
    assert.ok(ps.size <= ps.max, `size=${ps.size} max=${ps.max}`);
    assert.equal(ps.size, 200);
  });

  test('生命周期结束的粒子在 update 后被回收', () => {
    const ps = new ParticleSystem(64);
    ps.spawnBurst(0, 0, { count: 20, life: 0.1, speed: 0.5 });
    assert.equal(ps.size, 20);
    ps.update(0.05);
    assert.equal(ps.size, 20, '未到寿命不应回收');
    ps.update(0.2);
    assert.equal(ps.size, 0, '过期粒子应全部回收');
  });

  test('reset 清空池子；部分回收保留存活粒子', () => {
    const ps = new ParticleSystem(32);
    ps.spawn({ x: 0, z: 0, life: 0.1 });
    ps.spawn({ x: 0, z: 0, life: 5 });
    ps.update(0.2);
    assert.equal(ps.size, 1);
    ps.reset();
    assert.equal(ps.size, 0);
  });

  test('粒子随速度移动 / forEach 可遍历', () => {
    const ps = new ParticleSystem(16);
    ps.spawn({ x: 0, z: 0, vx: 2, vz: 0, life: 1, drag: 0 });
    ps.update(0.5);
    let seen = null;
    ps.forEach((p) => { seen = p; });
    assert.ok(seen && seen.x > 0.5, `应向右移动: ${seen && seen.x}`);
    assert.ok(seen.t > 0 && seen.t < 1);
  });
});

describe('FloatingText 生命周期', () => {
  test('上限 60，超出覆盖最老的', () => {
    const ft = new FloatingText(60);
    for (let i = 0; i < 100; i++) ft.add(i, 0, String(i), { kind: 'damage' });
    assert.equal(ft.size, 60);
    const texts = [];
    ft.forEach((t) => texts.push(t.text));
    assert.equal(texts.length, 60);
    assert.ok(texts.includes('99'));
    assert.ok(!texts.includes('0'));
  });

  test('update 后到期消失、alpha 渐隐、上升', () => {
    const ft = new FloatingText(60);
    ft.add(0, 0, '42', { kind: 'damage', life: 0.5 });
    let y0 = 0;
    ft.forEach((t) => { y0 = t.h; });
    ft.update(0.2);
    assert.equal(ft.size, 1);
    let y1 = 0, a1 = 1;
    ft.forEach((t) => { y1 = t.h; a1 = t.alpha; });
    assert.ok(y1 > y0, '飘字应上升');
    assert.ok(a1 <= 1);
    ft.update(0.5);
    assert.equal(ft.size, 0, '超过寿命应消失');
  });

  test('暴击样式更大', () => {
    const ft = new FloatingText(10);
    ft.add(0, 0, '100', { kind: 'crit', crit: true });
    ft.add(0, 0, '10', { kind: 'damage' });
    const sizes = [];
    ft.forEach((t) => sizes.push(t.size));
    assert.ok(Math.max(...sizes) > Math.min(...sizes));
  });
});

describe('伤害数字：打怪 / 自己受伤', () => {
  test('玩家受到的伤害 → 红色负数飘字（-X）', async () => {
    const { Renderer } = await import('../src/render/renderer.js');
    const r = new Renderer(null);
    const player = { x: 4, z: 4, kind: 'player' };
    r.lastPlayer = player;
    r.emit({ type: 'hit', x: 4, z: 4, amount: 37, target: player, targetIsPlayer: true });
    const out = [];
    r.text.forEach((ft) => out.push(ft));
    assert.equal(out.length, 1, `应出 1 条飘字，实际 ${out.length}`);
    assert.equal(out[0].text, '-37', '自己受伤应带负号');
    assert.equal(out[0].kind, 'playerHurt', '自己受伤用红色 playerHurt 样式');
  });

  test('玩家的普通攻击 / 技能伤害 → 怪物头顶数字（暴击更大）', async () => {
    const { Renderer } = await import('../src/render/renderer.js');
    const r = new Renderer(null);
    r.emit({ type: 'hit', x: 8, z: 8, amount: 42, element: 'physical' });
    r.emit({ type: 'hit', x: 8, z: 8, amount: 120, crit: true, element: 'fire' });
    const out = [];
    r.text.forEach((ft) => out.push(ft));
    assert.equal(out.length, 2);
    assert.equal(out[0].text, '42');
    assert.equal(out[1].text, '120');
    assert.ok(out[1].size > out[0].size, '暴击数字应更大');
  });

  test('core 的 hit+crit 成对事件只出一个数字（不翻倍）', async () => {
    const { Renderer } = await import('../src/render/renderer.js');
    const r = new Renderer(null);
    r.time = 3;
    // core 在暴击时先推 hit(crit:true)，紧接着推同一份数据的 crit
    r.emit({ type: 'hit', x: 1, z: 1, amount: 88, crit: true });
    r.emit({ type: 'crit', x: 1, z: 1, amount: 88, crit: true });
    assert.equal(r.text.activeCount, 1, '同一次暴击不能出两个数字');
    // 单独到来的 crit（旧 caller）仍然显示
    const r2 = new Renderer(null);
    r2.time = 5;
    r2.emit({ type: 'crit', x: 1, z: 1, amount: 9 });
    assert.equal(r2.text.activeCount, 1);
  });

  test('荆棘反伤 / 血性狂暴失血也显示数字（玩家侧为负号）', async () => {
    const { Renderer } = await import('../src/render/renderer.js');
    const r = new Renderer(null);
    const player = { kind: 'player' };
    r.lastPlayer = player;
    r.emit({ type: 'thorns', x: 2, z: 2, amount: 12, target: player });
    r.emit({ type: 'drain', x: 2, z: 2, amount: 3, target: player });
    const out = [];
    r.text.forEach((ft) => out.push(ft));
    assert.equal(out.length, 2);
    assert.equal(out[0].text, '-12');
    assert.equal(out[1].text, '-3');
    assert.ok(out.every((ft) => ft.kind === 'playerHurt'));
  });
});

describe('ScreenFx 慢动作 / 闪光 / 震动', () => {
  test('慢动作在时间后恢复 1.0', () => {
    const fx = new ScreenFx();
    assert.equal(fx.timeScale(), 1);
    fx.slowMo(0.5, 0.25);
    fx.update(0.1);
    assert.ok(near(fx.timeScale(), 0.25, 1e-6), `ts=${fx.timeScale()}`);
    fx.update(0.6);
    assert.equal(fx.timeScale(), 1, '慢动作结束后应恢复 1.0');
  });

  test('闪光有强度并在 dur 后清除', () => {
    const fx = new ScreenFx();
    fx.flash('red', 0.5, 0.2);
    assert.equal(fx.flashes.length, 1);
    let maxA = 0;
    fx.forEachFlash((f, a) => { maxA = Math.max(maxA, a); });
    assert.ok(maxA > 0 && maxA <= 0.5);
    fx.update(0.25);
    assert.equal(fx.flashes.length, 0);
  });

  test('shake 请求可被消费清零', () => {
    const fx = new ScreenFx();
    fx.shake(5);
    fx.shake(3);
    assert.equal(fx.consumeShake(), 8);
    assert.equal(fx.consumeShake(), 0);
  });

  test('hurt / chroma 随时间衰减', () => {
    const fx = new ScreenFx();
    fx.hurtScreen(1);
    fx.chromaPulse(1);
    fx.update(0.2);
    assert.ok(fx.hurt < 1 && fx.hurt > 0);
    assert.ok(fx.chroma < 1);
    for (let i = 0; i < 100; i++) fx.update(0.1);
    assert.equal(fx.hurt, 0);
    assert.equal(fx.chroma, 0);
  });

  test('技能 id 归一化', () => {
    assert.equal(normalizeSkillId('ground_slam'), 'groundSlam');
    assert.equal(normalizeSkillId('Whirlwind'), 'whirlwind');
    assert.equal(normalizeSkillId('warcry'), 'warcry');
  });
});

describe('EffectField 特效池', () => {
  test('环/闪电/残影生命周期与池上限', () => {
    const ef = new EffectField(4, 4, 4, 2);
    for (let i = 0; i < 20; i++) ef.ring(0, 0, { dur: 0.1, r1: 2 });
    assert.ok(ef.rings.filter((r) => r.active).length <= 4);
    ef.update(0.2);
    assert.equal(ef.rings.filter((r) => r.active).length, 0);
    const c = ef.crack(1, 1, { radius: 2, branches: 4 });
    assert.ok(c.segs.length > 0 && c.segs.length % 4 === 0);
  });
});

describe('Renderer 无 DOM 环境与 mock canvas 冒烟', () => {
  test('renderer.js 可在 Node 中 import（顶层不访问 document/window）', async () => {
    const mod = await import('../src/render/renderer.js');
    assert.equal(typeof mod.Renderer, 'function');
    assert.equal(typeof mod.default, 'function');
  });

  test('new Renderer(null) 不崩溃，render 静默返回', async () => {
    const { Renderer } = await import('../src/render/renderer.js');
    const r = new Renderer(null);
    r.resize(800, 600);
    r.render({ player: { x: 0, z: 0, hp: 10, maxHp: 10 } }, 0.016, 0.016);
    r.flash('red', 0.3, 0.2);
    r.shake(4);
    r.shockwave(0, 0, 30);
    r.slowMo(0.2, 0.3);
    assert.ok(r.particles.size >= 0);
  });

  test('完整世界数据在 mock canvas 上跑 30 帧不抛异常', async () => {
    const uninstall = installMockDom();
    try {
      const { Renderer } = await import('../src/render/renderer.js');
      const canvas = createMockCanvas(960, 600);
      const r = new Renderer(canvas);
      r.resize(960, 600);
      const cols = 40, rows = 40;
      const tiles = new Uint8Array(cols * rows);
      for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
        const edge = x < 4 || z < 4 || x > cols - 5 || z > rows - 5;
        tiles[z * cols + x] = edge ? 1 : (x === 20 && z === 10 ? 1 : 0);
      }
      const world = {
        player: { x: 20, z: 20, facing: 0.4, vx: 1, vz: 0.5, hp: 40, maxHp: 100, radius: 0.35, hitFlash: 0.3, attackAnim: 0.5, anim: { state: 'cast', t: 0.1, dur: 0.4 }, look: { armorColor: '#b23a26', weaponType: 'axe', cape: true } },
        monsters: [],
        all: [],
        projectiles: [],
        groundEffects: [],
        summoned: [{ x: 22, z: 20, radius: 0.4, kind: 'totem', hp: 10, maxHp: 20 }],
        items: [{ x: 19, z: 22, item: { rarity: 'unique', icon: 'axe', name: '血斧' }, born: 0 }],
        lootOrbs: [{ x: 21, z: 19, kind: 'gold', vx: 0, vz: 0 }, { x: 18, z: 18, kind: 'xp' }],
        events: [],
        map: { name: '测试', mods: [], level: 1, isBoss: false },
        dungeon: { tiles, cols, rows, tileSize: 1, isWall: (cx, cz) => tiles[cz * cols + cx] === 1 },
        cameraTarget: { x: 24, z: 24 },
      };
      const shapes = ['humanoid', 'quadruped', 'spider', 'wraith', 'skeleton', 'blob'];
      const rarities = ['normal', 'magic', 'rare', 'boss'];
      for (let i = 0; i < 18; i++) {
        const m = {
          id: i, type: 'mon' + i, name: '怪', x: 16 + (i % 6) * 1.2, z: 17 + Math.floor(i / 6) * 1.3,
          facing: i * 0.3, radius: 0.35, hp: 60, maxHp: 100, dead: false, rarity: rarities[i % 4],
          visual: { color: i % 2 ? '#7f9a74' : '#c04a3a', size: 0.9 + (i % 3) * 0.3, shape: shapes[i % 6] },
          hitFlash: (i % 3) * 0.3, anim: { state: 'idle' }, level: 5,
        };
        world.all.push(m);
        world.monsters.push(m);
      }
      world.all[0].dead = true;
      world.all[0].deathT = 0.3;
      for (let i = 0; i < 4; i++) {
        world.projectiles.push({ x: 20 + i, z: 19 + i, vx: 10, vz: 3, radius: 0.15, color: 'hsl(30 100% 60%)', kind: ['arrow', 'orb', 'bolt', 'orb_aoe'][i], team: 'monster' });
        world.groundEffects.push({ x: 18 + i, z: 22, radius: 1.2, color: 24, kind: ['fire', 'poison', 'void', 'frost'][i], t: 1, dur: 4 });
      }
      const evts = [
        { type: 'hit', x: 20, z: 20, amount: 123, crit: true, element: 'fire' },
        { type: 'kill', x: 21, z: 21, rarity: 'boss' },
        { type: 'skillCast', x: 20, z: 20, skillId: 'ground_slam' },
        { type: 'skillCast', x: 20, z: 20, skillId: 'whirlwind' },
        { type: 'skillCast', x: 20, z: 20, skillId: 'warcry' },
        { type: 'skillCast', x: 20, z: 20, skillId: 'blood_rage' },
        { type: 'skillCast', x: 20, z: 20, skillId: 'rally' },
        { type: 'explosion', x: 22, z: 22, radius: 3 },
        { type: 'bossSpawn', x: 24, z: 20 },
        { type: 'levelUp', x: 20, z: 20 },
        { type: 'loot', x: 20, z: 20, rarity: 'unique' },
        { type: 'heal', x: 20, z: 20, amount: 55 },
        { type: 'projectileHit', x: 21, z: 21, element: 'lightning' },
        { type: 'dash', x: 20, z: 20, facing: 1 },
        { type: 'spawn', x: 25, z: 25 },
        { type: 'eliteSpawn', x: 25, z: 25 },
        { type: 'bossKilled', x: 25, z: 25 },
        { type: 'waveStart', x: 20, z: 20 },
        { type: 'unknownEvent', x: 20, z: 20 },
      ];
      let t = 0;
      for (let f = 0; f < 30; f++) {
        t += 1 / 60;
        for (const e of evts) if ((f + e.type.length) % 7 === 0) r.emit(e);
        r.render(world, 1 / 60, t);
        // 事件不清空（渲染器只读）
        assert.ok(Array.isArray(world.events));
      }
      assert.ok(r.particles.size > 0, '应产生粒子');
      assert.ok(r.particles.size <= r.particles.max);
      assert.ok(r.text.activeCount > 0, '应有飘字');
      assert.ok(r.text.activeCount <= 60);
      assert.ok(r.stats.drawnEntities > 0, '应绘制实体');
      // 画质切换 + 离屏层重建
      r.setQuality('low');
      r.render(world, 1 / 60, t);
      r.setQuality(2);
      r.resize(400, 300);
      r.render(world, 1 / 60, t);
      // 无 player / 无 dungeon 也不能崩
      r.render({}, 1 / 60, t);
      r.render(null, 1 / 60, t);
      r.render({ player: { x: 0, z: 0, hp: 1, maxHp: 100 } }, 1 / 60, t);
    } finally {
      uninstall();
    }
  });

  test('render 不修改 world（只读契约）', async () => {
    const uninstall = installMockDom();
    try {
      const { Renderer } = await import('../src/render/renderer.js');
      const r = new Renderer(createMockCanvas(400, 300));
      r.resize(400, 300);
      const world = {
        player: { x: 0, z: 0, hp: 50, maxHp: 100, facing: 0 },
        all: [{ id: 1, x: 1, z: 1, radius: 0.35, hp: 5, maxHp: 10, visual: { shape: 'blob', color: '#7ab04a' } }],
        events: [{ type: 'hit', x: 0, z: 0, amount: 5 }, { type: 'kill', x: 0, z: 0 }],
      };
      const before = JSON.stringify({ p: world.player, a: world.all, e: world.events });
      r.render(world, 1 / 60, 0.016);
      const after = JSON.stringify({ p: world.player, a: world.all, e: world.events });
      assert.equal(before, after);
      assert.equal(world.events.length, 2, 'events 不应被清空');
    } finally {
      uninstall();
    }
  });
});