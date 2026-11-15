import { describe, test, assert } from './_runner.mjs';
import { aggregateMapMods } from '../src/game/world.js';
import {
  createInventory, equipStats, itemStats, equipItem, unequipItem, addToBag,
  nearestDrop, pickupDrop, sortBag, sellItem, EQUIP_SLOTS, SLOT_ACCEPTS,
} from '../src/game/inventory.js';
import { makeSave, validateSave } from '../src/game/save.js';

function fakeItem(over) {
  return { uid: 'u' + Math.random(), name: '测试物品', slot: 'weapon', rarity: 'normal', itemLevel: 1, icon: '⚔', dmgMin: 10, dmgMax: 20, stats: {}, mods: [], ...over };
}

describe('地图词缀汇总', () => {
  test('同类词缀叠加，vision 单独记录', () => {
    const m = aggregateMapMods([
      { type: 'monsterLife', value: 0.4 },
      { type: 'monsterLife', value: 0.2 },
      { type: 'vision', value: -1 },
    ]);
    assert.ok(Math.abs(m.monsterLife - 0.6) < 1e-9);
    assert.equal(m.vision, -1);
  });
});

describe('背包与装备', () => {
  test('装备后统计生效，卸下后移除', () => {
    const inv = createInventory();
    const w = fakeItem({ stats: { armor: 50 } });
    addToBag(inv, w);
    const prev = equipItem(inv, w);
    assert.equal(prev, null);
    assert.equal(inv.equip.weapon, w);
    assert.equal(inv.bag.length, 0);
    assert.equal(equipStats(inv).armor, 50);
    assert.equal(equipStats(inv).dmgMin, 10);
    assert.ok(unequipItem(inv, 'weapon'));
    assert.equal(inv.equip.weapon, null);
    assert.equal(inv.bag.length, 1);
  });
  test('替换装备时旧装备回到背包', () => {
    const inv = createInventory();
    const a = fakeItem({ stats: { armor: 10 } });
    const b = fakeItem({ stats: { armor: 20 } });
    // 主槽与副手都先占满（避免武器自动去 offhand 空槽），再换 b → 应替换 weapon 并返回 a
    inv.equip.weapon = a;
    inv.equip.offhand = fakeItem({ slot: 'shield', name: '副手盾' });
    addToBag(inv, b);
    const prev = equipItem(inv, b);
    assert.equal(prev, a);
    assert.equal(inv.equip.weapon, b);
    assert.ok(inv.bag.includes(a), '旧装备应自动回到背包');
    assert.ok(!inv.bag.includes(b));
  });
  test('主槽空时先填空槽而不是替换', () => {
    const inv = createInventory();
    const a = fakeItem();
    equipItem(inv, a);
    const offhandBefore = inv.equip.offhand;
    assert.equal(offhandBefore, null);
    const b = fakeItem();
    addToBag(inv, b);
    equipItem(inv, b);
    // 武器还能进 offhand（双手/副手武器），因此不会立刻替换武器
    assert.equal(inv.equip.weapon, a);
    assert.equal(inv.equip.offhand, b);
  });
  test('戒指可以进两个槽，盾牌只能进副手', () => {
    const inv = createInventory();
    const r1 = fakeItem({ slot: 'ring' });
    const r2 = fakeItem({ slot: 'ring' });
    equipItem(inv, r1);
    equipItem(inv, r2);
    assert.equal(inv.equip.ring1, r1);
    assert.equal(inv.equip.ring2, r2);
    const sh = fakeItem({ slot: 'shield' });
    equipItem(inv, sh);
    assert.equal(inv.equip.offhand, sh);
    assert.ok(SLOT_ACCEPTS.offhand.includes('shield'));
  });
  test('不兼容槽位拒绝装备', () => {
    const inv = createInventory();
    const ring = fakeItem({ slot: 'ring' });
    assert.equal(equipItem(inv, ring, 'helmet'), null);
  });
  test('背包满时不增加', () => {
    const inv = createInventory();
    inv.bagSize = 2;
    assert.ok(addToBag(inv, fakeItem()));
    assert.ok(addToBag(inv, fakeItem()));
    assert.equal(addToBag(inv, fakeItem()), false);
  });
  test('拾取最近掉落物', () => {
    const inv = createInventory();
    const world = { items: [{ x: 10, z: 10, item: fakeItem() }, { x: 0.5, z: 0.5, item: fakeItem({ name: '近' }) }] };
    const near = nearestDrop(world, 0, 0, 2);
    assert.equal(near.item.name, '近');
    assert.ok(pickupDrop(world, inv, near));
    assert.equal(world.items.length, 1);
    assert.equal(inv.bag.length, 1);
  });
  test('排序：稀有优先', () => {
    const inv = createInventory();
    inv.bag = [fakeItem({ rarity: 'normal' }), fakeItem({ rarity: 'unique' }), fakeItem({ rarity: 'rare' })];
    sortBag(inv);
    assert.deepEqual(inv.bag.map((i) => i.rarity), ['unique', 'rare', 'normal']);
  });
  test('出售给金币', () => {
    const inv = createInventory();
    const v = sellItem(inv, fakeItem({ itemLevel: 10, rarity: 'rare' }));
    assert.ok(v > 0);
    assert.equal(inv.gold, v);
  });
  test('itemStats 合并基础/词缀/隐式', () => {
    const s = itemStats({
      stats: { armor: 10 }, mods: [{ stats: { armor: 5, life: 20 } }], implicit: { stats: { critChance: 0.1 } },
    });
    assert.equal(s.armor, 15);
    assert.equal(s.life, 20);
    assert.equal(s.critChance, 0.1);
  });
});

describe('存档', () => {
  test('makeSave → validateSave 通过', () => {
    const inv = createInventory();
    const world = { player: { name: 'x', level: 3, xp: 5, xpNext: 10, hp: 5, mp: 3, baseStats: {}, look: {} }, tier: 2, career: {}, seed: 1 };
    const sv = makeSave(world, inv);
    assert.deepEqual(validateSave(sv), []);
    assert.equal(sv.world.tier, 2);
    assert.ok('weapon' in sv.inv.equip);
  });
  test('非法存档被拒', () => {
    assert.ok(validateSave(null).length > 0);
    assert.ok(validateSave({ version: 2 }).length > 0);
  });
});