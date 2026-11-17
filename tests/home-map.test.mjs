// 庇护所（家）回归测试：
//   · 新游戏从 tier 0 安全大厅开始，不刷怪、不掷地图词缀
//   · 仓库 / 商人 / 赌徒 / 战斗之门 四个交互点存在且可走
//   · F 互动接线、仓库存取与存档、商店购买、赌徒扣费
//   · T / 战斗之门：家 → 战斗地图，战斗地图 → 家（下一趟更深一层）
//   · 渲染层绘制交互物不抛异常
import { describe, test, assert } from './_runner.mjs';
import {
  createGame, updateGame, doPickup, doStashDeposit, doStashWithdraw,
  doBuyMerchantItem, doGamble, travelToNewMap, leaveCurrentMap, returnToHome, enterHome,
} from '../src/game/app.js';
import { isConnected, floorRatio } from '../src/game/dungeon.js';
import {
  merchantStock, merchantPrice, gambleCost, nearestHomeInteractable,
} from '../src/game/home.js';
import { makeSave, applySave } from '../src/game/save.js';
import { Renderer } from '../src/render/renderer.js';

function fakeItem(over = {}) {
  return {
    uid: over.uid || ('t' + Math.random().toString(36).slice(2, 9)),
    name: over.name || '测试装备',
    rarity: over.rarity || 'magic',
    rarityName: over.rarityName || '魔法',
    slot: over.slot || 'weapon',
    typeName: over.typeName || '剑',
    itemLevel: over.itemLevel || 5,
    levelReq: 1,
    icon: over.icon || '✦',
    stats: over.stats || { damageMult: 0.05 },
    ...over,
  };
}

/** 记录 UI 调用的桩：home 面板、toast、地图变化 */
function stubUI() {
  const calls = { panels: [], toasts: [], maps: 0, inv: 0 };
  return {
    calls,
    showHomePanel: (kind) => { calls.panels.push(kind); },
    closeModals() {},
    toast: (msg) => { calls.toasts.push(msg); },
    onInventoryChange() { calls.inv++; },
    onMapChange() { calls.maps++; },
    onEvents() {},
  };
}

function makeHomeGame(seed = 2024) {
  const game = createGame({ seed });
  game.ui = stubUI();
  return game;
}

function standAt(game, kind) {
  const p = game.world.player;
  const it = game.world.interactables.find((x) => x.kind === kind);
  p.x = it.x;
  p.z = it.z;
  return it;
}

describe('庇护所 · 地图与安全区', () => {
  test('新游戏进入 tier 0 的庇护所：四个交互点齐全，不刷怪', () => {
    const game = makeHomeGame();
    const w = game.world;
    assert.equal(w.tier, 0);
    assert.equal(w.map.isHome, true);
    assert.equal(w.map.tier, 0);
    assert.equal(w.map.name, '庇护所');
    assert.deepEqual(w.map.mods, []);
    assert.deepEqual(w.mapMods, {});
    assert.deepEqual(w.interactables.map((i) => i.kind), ['stash', 'merchant', 'gambler', 'portal']);
    assert.equal(w.dungeon.isHome, true);
    assert.equal(w.dungeon.bossRoom, null);
    assert.ok(w.dungeon.torches.length >= 8, '家应有火把照明');

    for (let i = 0; i < 60 * 5; i++) updateGame(game, 1 / 60, {});
    assert.equal(w.monsters.length, 0, '庇护所里不应刷怪');
    assert.equal(w.stats.waves, 0, '庇护所不处理波次');
    assert.equal(w.stats.aliveCap, 0);
  });

  test('家的地形连通、地面充足，玩家与交互点都站在可走位置', () => {
    const game = makeHomeGame(7);
    const d = game.world.dungeon;
    assert.equal(isConnected(d), true, '大厅必须连通');
    assert.ok(floorRatio(d) > 0.6, `地面比例应足够大（实际 ${floorRatio(d).toFixed(2)}）`);
    assert.ok(d.circleWalkable(d.playerStart.x, d.playerStart.z, 0.45), '出生点可走');
    for (const it of game.world.interactables) {
      assert.ok(d.circleWalkable(it.x, it.z, 0.45), `${it.name} 必须站在可走位置`);
      assert.ok(nearestHomeInteractable(game.world, it.x, it.z, 3.2), `${it.name} 应能被 F 选中`);
    }
  });

  test('战斗地图不会残留庇护所交互点', () => {
    const game = makeHomeGame(11);
    travelToNewMap(game);
    assert.equal(game.world.map.isHome, false);
    assert.equal(game.world.tier, 1);
    assert.deepEqual(game.world.interactables, []);
  });
});

describe('庇护所 · F 互动与地图循环', () => {
  test('靠近仓库 / 商人 / 赌徒按 F 打开对应面板', () => {
    const game = makeHomeGame(31);
    for (const kind of ['stash', 'merchant', 'gambler']) {
      standAt(game, kind);
      const hit = doPickup(game);
      assert.equal(hit && hit.kind, kind, `${kind} 应被 F 选中`);
      assert.equal(game.ui.calls.panels.at(-1), kind);
    }
  });

  test('战斗之门：家 → 第 1 层；T 回城后下一趟第 2 层', () => {
    const game = makeHomeGame(32);
    standAt(game, 'portal');
    const map = doPickup(game);
    assert.equal(map.isHome, false);
    assert.equal(game.world.tier, 1);

    // 战斗地图里 T / 🏕 = 回庇护所，并记住下一层
    leaveCurrentMap(game);
    assert.equal(game.world.map.isHome, true);
    assert.equal(game.world.tier, 0);
    assert.equal(game.world.homeNextTier, 2);

    // 再次穿过战斗之门 → 第 2 层
    standAt(game, 'portal');
    doPickup(game);
    assert.equal(game.world.tier, 2);
    assert.equal(game.world.map.isHome, false);
  });

  test('returnToHome 不推进层数（死亡撤退），leaveCurrentMap 才推进', () => {
    const game = makeHomeGame(33);
    travelToNewMap(game);
    assert.equal(game.world.tier, 1);
    returnToHome(game);
    assert.equal(game.world.tier, 0);
    assert.equal(game.world.homeNextTier, 1, '撤退重打当前层');
  });

  test('读档也先进入庇护所：历史层数保留为战斗之门目标', () => {
    const game = makeHomeGame(34);
    travelToNewMap(game); // 第 1 层
    travelToNewMap(game); // 第 2 层
    game.inv.gold = 4321;
    const saved = makeSave(game.world, game.inv);
    assert.equal(saved.world.tier, 2);

    const fresh = createGame({ seed: 34 });
    fresh.ui = stubUI();
    assert.equal(applySave(fresh, saved), true);
    assert.equal(fresh.world.tier, 2, 'applySave 先记录存档层数');

    // 启动流程：无论存档在哪一层，都先回家
    enterHome(fresh, fresh.world.tier);
    assert.equal(fresh.world.map.isHome, true);
    assert.equal(fresh.world.tier, 0);
    assert.equal(fresh.world.homeNextTier, 2, '战斗之门应通往历史进度层');
    assert.equal(fresh.inv.gold, 4321, '历史进度（金币）不能丢');

    leaveCurrentMap(fresh);
    assert.equal(fresh.world.map.isHome, false);
    assert.equal(fresh.world.tier, 2, '穿过战斗之门回到存档层');
  });

  test('在家存档：读档后仍在家，且保留战斗之门目标层', () => {
    const game = makeHomeGame(35);
    game.world.homeNextTier = 6;
    const saved = makeSave(game.world, game.inv);

    const fresh = createGame({ seed: 35 });
    fresh.ui = stubUI();
    assert.equal(applySave(fresh, saved), true);
    enterHome(fresh, 0); // tier 0：保留存档里的 homeNextTier
    assert.equal(fresh.world.map.isHome, true);
    assert.equal(fresh.world.homeNextTier, 6);
    leaveCurrentMap(fresh);
    assert.equal(fresh.world.tier, 6);
  });
});

describe('庇护所 · 仓库 / 商人 / 赌徒', () => {
  test('仓库：存入 / 取出保持物品实例，存档可持久化', () => {
    const game = makeHomeGame(41);
    const item = fakeItem({ uid: 'stash-sword' });
    game.inv.bag.push(item);

    const dep = doStashDeposit(game, 0);
    assert.equal(dep, item);
    assert.equal(game.inv.bag.length, 0);
    assert.equal(game.inv.stash.length, 1);
    assert.equal(game.inv.stash[0], item);

    const saved = makeSave(game.world, game.inv);
    assert.equal(saved.inv.stash.length, 1);
    assert.equal(saved.inv.stash[0].uid, 'stash-sword');

    const fresh = createGame({ seed: 41 });
    const invRef = fresh.inv;
    assert.equal(applySave(fresh, saved), true);
    assert.equal(fresh.inv, invRef, '读档不能替换 inv 引用');
    assert.equal(fresh.inv.stash.length, 1);
    assert.equal(fresh.inv.stash[0].uid, 'stash-sword');

    const wd = doStashWithdraw(game, 0);
    assert.equal(wd, item);
    assert.equal(game.inv.stash.length, 0);
    assert.equal(game.inv.bag.length, 1);

    // 仓库满 / 背包满时拒绝，不丢物品
    game.inv.stashSize = 1;
    game.inv.stash.push(fakeItem({ uid: 'a' }));
    game.inv.bag.push(fakeItem({ uid: 'b' }));
    assert.equal(doStashDeposit(game, 0), null, '仓库满应拒绝');
    assert.equal(game.inv.bag.length, 2);
    game.inv.bagSize = game.inv.bag.length;
    assert.equal(doStashWithdraw(game, 0), null, '背包满应拒绝');
    assert.equal(game.inv.stash.length, 1);
  });

  test('商人：库存 8 件、购买扣金币并进背包；金币不足 / 背包满不扣款', () => {
    const game = makeHomeGame(51);
    const stock = merchantStock(game.world);
    assert.equal(stock.length, 8);
    const first = stock[0];
    const price = merchantPrice(first);
    assert.ok(price > 0);

    game.inv.gold = price - 1;
    const poor = doBuyMerchantItem(game, 0);
    assert.equal(poor.ok, false);
    assert.equal(poor.reason, 'gold');
    assert.equal(game.inv.gold, price - 1);
    assert.equal(stock.length, 8);

    game.inv.gold = price * 3;
    const bagBefore = game.inv.bag.length;
    const bought = doBuyMerchantItem(game, 0);
    assert.equal(bought.ok, true);
    assert.equal(bought.price, price);
    assert.equal(game.inv.gold, price * 3 - price);
    assert.equal(stock.length, 7);
    assert.equal(game.inv.bag.length, bagBefore + 1);
    assert.equal(game.inv.bag.at(-1), first);

    game.inv.bagSize = game.inv.bag.length;
    game.inv.gold = 999999;
    const full = doBuyMerchantItem(game, 0);
    assert.equal(full.ok, false);
    assert.equal(full.reason, 'bag');
    assert.equal(game.inv.gold, 999999);
  });

  test('赌徒：扣赌注并可能给一件装备；金币/背包不足不扣款', () => {
    const game = makeHomeGame(61);
    const cost = gambleCost(game.world.player);
    game.inv.gold = cost - 1;
    const poor = doGamble(game);
    assert.equal(poor.ok, false);
    assert.equal(poor.reason, 'gold');
    assert.equal(game.inv.gold, cost - 1);

    game.inv.gold = cost;
    const bagBefore = game.inv.bag.length;
    const r = doGamble(game);
    assert.equal(r.ok, true);
    assert.equal(r.cost, cost);
    assert.equal(game.inv.gold, 0);
    assert.ok(r.item === null || game.inv.bag.length === bagBefore + 1, '要么空手，要么进包一件');
    if (r.item) {
      assert.ok(['magic', 'rare', 'unique'].includes(r.item.rarity), '赌徒只会翻出魔法以上');
      assert.equal(game.inv.bag.at(-1), r.item);
    }

    game.inv.gold = cost;
    game.inv.bagSize = game.inv.bag.length;
    const full = doGamble(game);
    assert.equal(full.ok, false);
    assert.equal(full.reason, 'bag');
    assert.equal(game.inv.gold, cost);
  });
});

describe('庇护所 · 渲染冒烟', () => {
  test('_drawHomeInteractables 画完四个交互点且不抛异常（含门户光柱）', () => {
    const game = makeHomeGame(71);
    game.world.player.x = game.world.interactables[3].x;
    game.world.player.z = game.world.interactables[3].z;
    const calls = [];
    const target = {
      globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
      lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    };
    for (const m of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'fill', 'stroke', 'fillText', 'strokeText']) {
      target[m] = (...a) => calls.push(m);
    }
    const grad = { addColorStop() {} };
    target.createRadialGradient = () => grad;
    target.createLinearGradient = () => grad;

    const cam = {
      scale: 32,
      squash: 0.62,
      worldToScreen(x, z, h, out = {}) { out.x = 400 + x; out.y = 300 + z; return out; },
    };
    const r = new Renderer(null);
    r.w = 1280;
    r.h = 720;
    r.time = 1.25;
    r._drawHomeInteractables(target, cam, game.world);
    assert.ok(calls.filter((m) => m === 'fillText').length >= 4, '每个交互点至少画一个图标/名称');
    assert.ok(calls.includes('stroke'), '门户/光环应有描边');
  });
});