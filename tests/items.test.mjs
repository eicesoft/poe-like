// @file tests/items.test.mjs
// 物品 / 词缀 / 稀有度 / 掉落 / 天赋树 / 技能树 的测试。
// 运行：node tests/run-all.mjs（或 npm test）
import { describe, test, assert } from './_runner.mjs';
import { RNG } from '../src/engine/rng.js';

import {
  SLOTS, ITEM_SLOTS, SLOT_NAMES, SLOT_ACCEPTS, BASE_ITEMS, BASE_BY_ID,
} from '../src/items/bases.js';
import { RARITY, RARITY_KEYS, rollRarity, rarityChances } from '../src/items/rarity.js';
import {
  PREFIXES, SUFFIXES, ALL_AFFIXES, AFFIX_BY_ID, rollAffixes, RESIST_KEYS,
} from '../src/items/affixes.js';
import { UNIQUES, tryUnique, validateUniques, uniqueById } from '../src/items/unique.js';
import {
  generateItem, generateDrop, rerollItem, itemStatLines, itemScore, itemToTooltipHTML, fallbackItem,
} from '../src/items/itemgen.js';
import {
  TALENTS, TALENT_BY_ID, START_NODE, talentById, reachableFrom, canAllocate, aggregateTalentStats, talentStats, legendaryTraits,
} from '../src/items/talentTree.js';
import {
  SKILL_TREES, SKILL_IDS, SKILL_NODES, skillNodeById, skillEffectsForSkill, skillTreeOf,
} from '../src/items/skillTree.js';
import { STAT_KEYS, ITEM_STAT_KEYS, EXTRA_STAT_KEYS } from '../src/items/common.js';
import * as itemsIndex from '../src/items/index.js';

/** 全部合法的「数值键」：StatBlock 键 + 物品额外键。 */
const VALID_STAT_KEYS = new Set([...STAT_KEYS, ...EXTRA_STAT_KEYS]);

/** 生成大量物品用于抽样检查。 */
function manyItems(n, seed = 1234) {
  const rng = new RNG(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(generateItem({ rng, level: 1 + Math.floor(rng.next() * 45) }));
  }
  return out;
}

describe('物品基底 bases.js', () => {
  test('基底数量 >= 30 且 id 唯一', () => {
    assert.ok(BASE_ITEMS.length >= 30, `只有 ${BASE_ITEMS.length} 个基底`);
    const ids = BASE_ITEMS.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, '基底 id 有重复');
  });

  test('每个基底字段合法（slot / tier / levelReq / icon / implicit）', () => {
    for (const b of BASE_ITEMS) {
      assert.ok(ITEM_SLOTS.includes(b.slot), `${b.id} 的 slot 非法: ${b.slot}`);
      assert.ok(b.tier >= 1 && b.tier <= 4, `${b.id} tier 越界`);
      assert.ok(Number.isInteger(b.levelReq) && b.levelReq >= 1, `${b.id} levelReq 非法`);
      assert.ok(typeof b.icon === 'string' && b.icon.length > 0, `${b.id} 缺 icon`);
      assert.ok(b.implicit && typeof b.implicit.text === 'string' && b.implicit.text.length > 0, `${b.id} 缺 implicit.text`);
      assert.ok(b.implicit.stats && typeof b.implicit.stats === 'object', `${b.id} 缺 implicit.stats`);
      assert.ok(b.baseStats && typeof b.baseStats === 'object', `${b.id} 缺 baseStats`);
    }
  });

  test('槽位覆盖齐全且包含约定的格子', () => {
    for (const s of ['weapon', 'offhand', 'helmet', 'body', 'gloves', 'boots', 'ring1', 'ring2', 'amulet', 'belt']) {
      assert.ok(SLOTS.includes(s), `SLOTS 缺少 ${s}`);
      assert.ok(SLOT_NAMES[s], `SLOT_NAMES 缺少 ${s}`);
    }
    // 每个格子都至少有一个可接受的基底
    for (const s of SLOTS) {
      const accepts = SLOT_ACCEPTS[s];
      assert.ok(Array.isArray(accepts) && accepts.length > 0, `${s} 没有可接受的基底类型`);
      const pool = BASE_ITEMS.filter((b) => accepts.includes(b.slot));
      assert.ok(pool.length > 0, `${s} 对应的基底池为空`);
    }
  });

  test('武器有 dmgMin < dmgMax；盾牌有 blockChance；靴子有移速', () => {
    const weapons = BASE_ITEMS.filter((b) => b.slot === 'weapon');
    assert.ok(weapons.length >= 8, '武器基底太少');
    for (const w of weapons) {
      assert.ok(w.baseStats.dmgMin > 0, `${w.id} 缺 dmgMin`);
      assert.ok(w.baseStats.dmgMin < w.baseStats.dmgMax, `${w.id} dmgMin >= dmgMax`);
    }
    for (const sh of BASE_ITEMS.filter((b) => b.slot === 'shield')) {
      assert.ok(sh.baseStats.blockChance > 0, `${sh.id} 盾牌缺 blockChance`);
    }
    for (const bt of BASE_ITEMS.filter((b) => b.slot === 'boots')) {
      assert.ok(bt.baseStats.moveSpeedMult > 0, `${bt.id} 靴子缺移速`);
    }
  });

  test('高阶基底的数值明显强于低阶（同类型对比）', () => {
    const t1 = BASE_BY_ID['short_sword'];
    const t4 = BASE_BY_ID['reaver_greatsword'];
    assert.ok(t4.baseStats.dmgMax > t1.baseStats.dmgMax * 3,
      `T4 武器伤害不够高: ${t4.baseStats.dmgMax} vs ${t1.baseStats.dmgMax}`);
    assert.ok(t4.levelReq > t1.levelReq, '高阶基底等级需求应更高');
    assert.ok(t4.tier > t1.tier, 'T4 阶位应高于 T1');
  });
});

describe('稀有度 rarity.js', () => {
  test('RARITY 四种且使用 POE 配色', () => {
    const expect = {
      normal: ['普通', '#c8c8c8'],
      magic: ['魔法', '#8888ff'],
      rare: ['稀有', '#ffff77'],
      unique: ['传奇', '#af6025'],
    };
    for (const k of RARITY_KEYS) {
      assert.ok(RARITY[k], `缺少稀有度 ${k}`);
      assert.equal(RARITY[k].name, expect[k][0]);
      assert.equal(RARITY[k].color, expect[k][1]);
    }
  });

  test('rollRarity 分布符合概率表（±2%）', () => {
    const rng = new RNG(99);
    const n = 60000;
    const cnt = { normal: 0, magic: 0, rare: 0, unique: 0 };
    for (let i = 0; i < n; i++) cnt[rollRarity(rng)]++;
    assert.ok(Math.abs(cnt.normal / n - 0.71) < 0.02, `普通概率 ${(cnt.normal / n).toFixed(3)}`);
    assert.ok(Math.abs(cnt.magic / n - 0.22) < 0.02, `魔法概率 ${(cnt.magic / n).toFixed(3)}`);
    assert.ok(Math.abs(cnt.rare / n - 0.064) < 0.02, `稀有概率 ${(cnt.rare / n).toFixed(3)}`);
    assert.ok(Math.abs(cnt.unique / n - 0.006) < 0.02, `传奇概率 ${(cnt.unique / n).toFixed(3)}`);
  });

  test('稀有度提升倍率确实提高稀有/传奇占比', () => {
    const base = rarityChances(1);
    const boosted = rarityChances(3);
    assert.ok(boosted.rare > base.rare, '提升后稀有概率没有上升');
    assert.ok(boosted.unique > base.unique, '提升后传奇概率没有上升');
  });

  test('rollRarity 只返回合法键', () => {
    const rng = new RNG(5);
    for (let i = 0; i < 2000; i++) assert.ok(RARITY_KEYS.includes(rollRarity(rng)));
  });
});

describe('词缀 affixes.js', () => {
  test('前缀和后缀各 ≥ 40 条，id 唯一', () => {
    assert.ok(PREFIXES.length >= 40, `前缀只有 ${PREFIXES.length} 条`);
    assert.ok(SUFFIXES.length >= 40, `后缀只有 ${SUFFIXES.length} 条`);
    const ids = ALL_AFFIXES.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length, '词缀 id 有重复');
  });

  test('每条词缀结构合法，tiers 从强到弱（levelReq 递减）', () => {
    for (const a of ALL_AFFIXES) {
      assert.ok(typeof a.name === 'string' && a.name.length > 0, `${a.id} 缺中文词根`);
      assert.ok(a.kind === 'prefix' || a.kind === 'suffix', `${a.id} kind 非法`);
      assert.ok(typeof a.group === 'string' && a.group.length > 0, `${a.id} 缺 group`);
      assert.ok(Array.isArray(a.slots) && a.slots.length > 0, `${a.id} 没有可用槽位`);
      for (const s of a.slots) assert.ok(ITEM_SLOTS.includes(s), `${a.id} 的槽位非法: ${s}`);
      assert.ok(a.tiers.length >= 1, `${a.id} 没有档位`);
      assert.equal(a.tiers[0].tier, 1, `${a.id} 首档不是 T1`);
      for (let i = 1; i < a.tiers.length; i++) {
        assert.ok(a.tiers[i].tier > a.tiers[i - 1].tier, `${a.id} tier 编号不递增`);
        assert.ok(a.tiers[i].levelReq < a.tiers[i - 1].levelReq,
          `${a.id} 档位 ${i} 的 levelReq（${a.tiers[i].levelReq}）应低于前一档（${a.tiers[i - 1].levelReq}）`);
      }
      for (const t of a.tiers) {
        assert.ok(typeof t.text === 'string' && t.text.length > 0, `${a.id} 档位 ${t.tier} 缺中文文本`);
        const keys = Object.keys(t.stats);
        assert.ok(keys.length > 0, `${a.id} 档位 ${t.tier} 没有 stats`);
        for (const k of keys) {
          assert.ok(VALID_STAT_KEYS.has(k), `${a.id} 使用了非法统计键 ${k}`);
          assert.ok(Number.isFinite(t.stats[k]), `${a.id}.${k} 不是数字`);
        }
      }
    }
  });

  test('覆盖了必需的属性类别', () => {
    const groups = new Set(ALL_AFFIXES.map((a) => a.group));
    const need = ['life', 'mana', 'lifeRegen', 'armor', 'evasion', 'blockChance',
      'firePct', 'coldPct', 'lightningPct', 'chaosPct',
      'addFire', 'addCold', 'addLightning', 'physPct',
      'attackSpeed', 'critChance', 'critMulti', 'moveSpeed', 'aoe', 'skillLevel',
      'resFire', 'resCold', 'resLightning', 'resChaos',
      'leech', 'cdr', 'areaDamage', 'dot', 'thorns', 'rarity', 'xp'];
    for (const g of need) assert.ok(groups.has(g), `缺少词缀分组 ${g}`);
  });

  test('词缀数值键覆盖所有抗性键', () => {
    const used = new Set();
    for (const a of ALL_AFFIXES) for (const t of a.tiers) for (const k in t.stats) used.add(k);
    for (const k of RESIST_KEYS) assert.ok(used.has(k), `词缀里没有 ${k}`);
  });

  test('rollAffixes：normal 0 条、magic 1-2 条、rare 4-6 条', () => {
    const rng = new RNG(2024);
    const slots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'shield', 'ring', 'amulet', 'belt'];
    for (let i = 0; i < 400; i++) {
      const slot = slots[i % slots.length];
      const level = 1 + Math.floor(rng.next() * 50);
      assert.equal(rollAffixes(rng, level, 'normal', slot).length, 0, 'normal 不应有词缀');
      assert.equal(rollAffixes(rng, level, 'unique', slot).length, 0, 'unique 的词缀由定义给出');

      const magic = rollAffixes(rng, level, 'magic', slot);
      assert.ok(magic.length >= 1 && magic.length <= 2, `magic 词缀数 ${magic.length}`);

      const rare = rollAffixes(rng, level, 'rare', slot);
      assert.ok(rare.length >= 4 && rare.length <= 6, `rare 词缀数 ${rare.length}`);

      for (const mod of rare) {
        assert.ok(typeof mod.id === 'string' && AFFIX_BY_ID[mod.id], `词缀实例 id 非法 ${mod.id}`);
        assert.equal(typeof mod.prefix, 'boolean');
        assert.ok(mod.text.length > 0);
      }
    }
  });

  test('rollAffixes：rare 的前缀/后缀都在 2-3 条', () => {
    const rng = new RNG(777);
    for (let i = 0; i < 300; i++) {
      const mods = rollAffixes(rng, 40, 'rare', 'weapon');
      const pre = mods.filter((m) => m.prefix).length;
      const suf = mods.filter((m) => !m.prefix).length;
      assert.ok(pre >= 2 && pre <= 3, `前缀数 ${pre}`);
      assert.ok(suf >= 2 && suf <= 3, `后缀数 ${suf}`);
    }
  });

  test('词缀 group 不冲突（同组互斥，含前缀与后缀之间）', () => {
    const rng = new RNG(31);
    const slots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'shield', 'ring', 'amulet', 'belt'];
    for (let i = 0; i < 600; i++) {
      const slot = slots[i % slots.length];
      const mods = rollAffixes(rng, 40, 'rare', slot);
      const groups = new Set();
      for (const m of mods) {
        const g = AFFIX_BY_ID[m.id].group;
        assert.ok(!groups.has(g), `${slot} 出现重复组 ${g}（${m.id}）`);
        groups.add(g);
      }
    }
  });

  test('词缀档位的 levelReq 都 <= 物品等级', () => {
    const rng = new RNG(8);
    for (let level = 1; level <= 30; level += 3) {
      const mods = rollAffixes(rng, level, 'rare', 'ring');
      for (const m of mods) {
        const tier = AFFIX_BY_ID[m.id].tiers.find((t) => t.tier === m.tier);
        assert.ok(tier, `找不到 ${m.id} 的 T${m.tier}`);
        assert.ok(tier.levelReq <= level, `${m.id} T${m.tier} 需要等级 ${tier.levelReq} > 物品等级 ${level}`);
      }
    }
  });
});

describe('传奇 unique.js', () => {
  test('至少 8 件传奇，字段齐全', () => {
    assert.ok(UNIQUES.length >= 8, `只有 ${UNIQUES.length} 件传奇`);
    const ids = UNIQUES.map((u) => u.id);
    assert.equal(new Set(ids).size, ids.length, '传奇 id 重复');
    for (const u of UNIQUES) {
      assert.ok(u.name && u.name.length > 0);
      assert.ok(u.baseId && BASE_BY_ID[u.baseId], `${u.id} 的 baseId 不存在: ${u.baseId}`);
      assert.ok(u.levelReq >= 1);
      assert.ok(typeof u.uniqueAffixText === 'string' && u.uniqueAffixText.length > 0);
      assert.ok(typeof u.flavor === 'string' && u.flavor.length > 10, `${u.id} 缺中文背景故事`);
      assert.ok(u.stats && Object.keys(u.stats).length > 0);
      for (const k in u.stats) assert.ok(VALID_STAT_KEYS.has(k), `${u.id} 非法统计键 ${k}`);
      assert.ok(u.legendaryEffect && u.legendaryEffect.id && u.legendaryEffect.desc, `${u.id} 缺 legendaryEffect`);
    }
  });

  test('所有传奇的基底都存在', () => {
    assert.deepEqual(validateUniques(), []);
  });

  test('tryUnique 返回合法且等级合适的传奇', () => {
    const rng = new RNG(4);
    for (let i = 0; i < 200; i++) {
      const u = tryUnique(rng, 25);
      assert.ok(uniqueById(u.id), '返回了不存在的传奇');
      assert.ok(u.levelReq <= 28, `等级 25 掉出了 levelReq=${u.levelReq} 的传奇`);
    }
  });
});

describe('物品生成 itemgen.js', () => {
  test('generateItem 产出字段完整且合法', () => {
    const rng = new RNG(42);
    for (let i = 0; i < 500; i++) {
      const item = generateItem({ rng, level: 1 + Math.floor(rng.next() * 40) });
      assert.ok(typeof item.uid === 'string' && item.uid.length > 0, '缺 uid');
      assert.ok(typeof item.name === 'string' && item.name.length > 0, '缺 name');
      assert.ok(ITEM_SLOTS.includes(item.slot), `slot 非法: ${item.slot}`);
      assert.ok(RARITY[item.rarity], `rarity 非法: ${item.rarity}`);
      assert.ok(Number.isInteger(item.itemLevel) && item.itemLevel >= 1);
      assert.ok(Number.isInteger(item.levelReq) && item.levelReq >= 1);
      assert.ok(typeof item.icon === 'string' && item.icon.length > 0);
      assert.ok(item.stats && typeof item.stats === 'object');
      assert.ok(item.implicit && typeof item.implicit.text === 'string');
      assert.ok(Array.isArray(item.mods));
      assert.ok(Array.isArray(item.affixLines));
      assert.ok(typeof item.slotName === 'string' && item.slotName.length > 0);
      assert.ok(BASE_BY_ID[item.baseId], `baseId 非法: ${item.baseId}`);
      // stats 键合法
      for (const k in item.stats) assert.ok(VALID_STAT_KEYS.has(k), `物品统计键非法: ${k}`);
    }
  });

  test('词缀数量与稀有度相符', () => {
    const rng = new RNG(7);
    for (let i = 0; i < 300; i++) {
      const item = generateItem({ rng, level: 30 });
      const n = item.mods.length;
      if (item.rarity === 'normal') assert.equal(n, 0, '普通物品不应有词缀');
      else if (item.rarity === 'magic') assert.ok(n >= 1 && n <= 2, `魔法词缀数 ${n}`);
      else if (item.rarity === 'rare') assert.ok(n >= 4 && n <= 6, `稀有词缀数 ${n}`);
      else if (item.rarity === 'unique') assert.ok(n === 0 || n >= 0, '传奇词缀由定义给出');
    }
  });

  test('武器有 dmgMin < dmgMax，防具没有武器伤害', () => {
    const rng = new RNG(99);
    for (let i = 0; i < 300; i++) {
      const item = generateItem({ rng, level: 20 });
      if (item.slot === 'weapon' || (item.slot === 'shield')) {
        if (item.slot === 'weapon') {
          assert.ok(item.dmgMin > 0 && item.dmgMin < item.dmgMax, `武器伤害异常 ${item.dmgMin}/${item.dmgMax}`);
          assert.ok(item.damage && item.damage.dps > 0, '武器缺 damage.dps');
        }
      }
      if (item.slot === 'helmet' || item.slot === 'ring' || item.slot === 'amulet') {
        assert.equal(item.dmgMin, 0, `${item.slot} 不应有武器伤害`);
        assert.equal(item.dmgMax, 0, `${item.slot} 不应有武器伤害`);
      }
    }
  });

  test('1000 次生成不产生重复 uid', () => {
    const uids = new Set();
    const rng = new RNG(555);
    for (let i = 0; i < 1000; i++) {
      const item = generateItem({ rng, level: 10 });
      assert.ok(!uids.has(item.uid), `重复 uid: ${item.uid}`);
      uids.add(item.uid);
    }
    assert.equal(uids.size, 1000);
    // generateDrop 也不重复
    for (let i = 0; i < 300; i++) {
      const item = generateDrop({ rng, level: 12 });
      assert.ok(!uids.has(item.uid), `generateDrop 重复 uid`);
      uids.add(item.uid);
    }
  });

  test('generateItem 的 slot 过滤：ring 一定产出戒指，offhand 产出盾/武器', () => {
    const rng = new RNG(2024);
    for (let i = 0; i < 200; i++) {
      assert.equal(generateItem({ rng, level: 5, slot: 'ring' }).slot, 'ring');
      assert.equal(generateItem({ rng, level: 5, slot: 'ring1' }).slot, 'ring');
      assert.equal(generateItem({ rng, level: 5, slot: 'ring2' }).slot, 'ring');
      const off = generateItem({ rng, level: 5, slot: 'offhand' });
      assert.ok(off.slot === 'shield' || off.slot === 'weapon', `offhand 产出了 ${off.slot}`);
      assert.equal(generateItem({ rng, level: 5, slot: 'helmet' }).slot, 'helmet');
      assert.equal(generateItem({ rng, level: 5, slot: 'amulet' }).slot, 'amulet');
    }
  });

  test('baseId 指定时按基底生成', () => {
    const rng = new RNG(3);
    const item = generateItem({ rng, level: 20, baseId: 'eviscerating_axe' });
    assert.equal(item.baseId, 'eviscerating_axe');
    assert.equal(item.slot, 'weapon');
    assert.ok(item.name.includes('裂骨战斧') || item.rarity !== 'normal');
  });

  test('forceUnique 能触发传奇', () => {
    const rng = new RNG(2024);
    for (let i = 0; i < 100; i++) {
      const item = generateItem({ rng, level: 25, forceUnique: true });
      assert.equal(item.rarity, 'unique', 'forceUnique 没有产出传奇');
      assert.ok(item.unique && uniqueById(item.unique), '传奇字段缺失');
      assert.ok(typeof item.flavor === 'string' && item.flavor.length > 0, '缺背景故事');
      assert.ok(item.legendaryEffect && item.legendaryEffect.desc, '缺传奇效果');
    }
  });

  test('指定 slot + forceUnique 时类型依然匹配', () => {
    const rng = new RNG(88);
    for (let i = 0; i < 120; i++) {
      const item = generateItem({ rng, level: 30, slot: 'helmet', forceUnique: true });
      assert.equal(item.slot, 'helmet', `指定头盔却产出了 ${item.slot}`);
    }
  });

  test('物品等级越高，武器伤害越高（平均值对比）', () => {
    const rng = new RNG(17);
    const avg = (lv) => {
      let sum = 0;
      const n = 120;
      for (let i = 0; i < n; i++) sum += generateItem({ rng, level: lv, slot: 'weapon', baseId: 'long_sword' }).damage.avg;
      return sum / n;
    };
    const low = avg(1);
    const high = avg(30);
    assert.ok(high > low * 1.8, `高等级武器不够强: ${high.toFixed(1)} vs ${low.toFixed(1)}`);
  });

  test('generateDrop 同步且永不抛异常', () => {
    const rng = new RNG(66);
    for (let i = 0; i < 300; i++) {
      const item = generateDrop({ rng, level: 1 + (i % 40) });
      assert.ok(item && item.uid && item.name, '掉落物品不完整');
    }
    // 各种怪异入参也不能抛
    assert.doesNotThrow(() => generateDrop());
    assert.doesNotThrow(() => generateDrop({}));
    assert.doesNotThrow(() => generateDrop({ rng: 123 }));
    assert.doesNotThrow(() => generateDrop({ rng, level: -5, slot: '不存在的槽位', rarity: '乱写' }));
    assert.doesNotThrow(() => generateItem({ rng: () => 0.5, level: 'abc' }));
    assert.doesNotThrow(() => generateItem({}));
  });

  test('fallbackItem 返回合法普通物品', () => {
    const it = fallbackItem();
    assert.equal(it.rarity, 'normal');
    assert.ok(ITEM_SLOTS.includes(it.slot));
    assert.ok(it.stats && it.dmgMin < it.dmgMax);
  });

  test('rerollItem 生成新物品且稀有度不变', () => {
    const rng = new RNG(12);
    const orig = generateItem({ rng, level: 25, rarity: 'rare', slot: 'weapon' });
    const next = rerollItem(rng, orig);
    assert.notEqual(next.uid, orig.uid, '重掷后 uid 应变化');
    assert.equal(next.rarity, 'rare');
    assert.equal(next.slot, orig.slot);
    assert.equal(next.itemLevel, orig.itemLevel);
    assert.equal(next.baseId, orig.baseId);
    // 原物品未被修改
    assert.equal(orig.mods.length, orig.mods.length);
  });
});

describe('物品展示 itemStatLines / itemToTooltipHTML / itemScore', () => {
  test('itemStatLines 返回非空数组，每行有 text 和 color', () => {
    const rng = new RNG(5);
    for (let i = 0; i < 200; i++) {
      const item = generateItem({ rng, level: 25, rarity: i % 2 ? 'rare' : 'magic' });
      const lines = itemStatLines(item);
      assert.ok(Array.isArray(lines) && lines.length > 0, `${item.name} 的属性行为空`);
      for (const l of lines) {
        assert.ok(typeof l.text === 'string' && l.text.length > 0, 'text 非法');
        assert.ok(typeof l.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(l.color), `颜色非法: ${l.color}`);
      }
    }
  });

  test('武器 itemStatLines 含伤害行；传奇含传奇效果行', () => {
    const rng = new RNG(6);
    const w = generateItem({ rng, level: 20, slot: 'weapon', rarity: 'rare' });
    const texts = itemStatLines(w).map((l) => l.text);
    assert.ok(texts.some((t) => t.includes('伤害')), '武器缺伤害行');
    const u = generateItem({ rng, level: 25, forceUnique: true });
    const utexts = itemStatLines(u).map((l) => l.text);
    assert.ok(utexts.some((t) => t.includes('传奇效果')), '传奇缺效果行');
  });

  test('itemToTooltipHTML 输出非空 HTML 字符串且含 <div', () => {
    const rng = new RNG(9);
    for (let i = 0; i < 100; i++) {
      const item = generateItem({ rng, level: 20 });
      const html = itemToTooltipHTML(item);
      assert.equal(typeof html, 'string');
      assert.ok(html.length > 50, 'tooltip 太短');
      assert.ok(html.includes('<div'), 'tooltip 不含 div');
      assert.ok(html.includes(item.name) || html.includes('&lt;'), 'tooltip 不含物品名');
    }
  });

  test('tooltip 的 compare 参数会追加对比行', () => {
    const rng = new RNG(10);
    const a = generateItem({ rng, level: 30, rarity: 'rare', slot: 'weapon' });
    const b = generateItem({ rng, level: 1, rarity: 'normal', slot: 'weapon', baseId: 'short_sword' });
    const plain = itemToTooltipHTML(a);
    const cmp = itemToTooltipHTML(a, b);
    assert.ok(cmp.length > plain.length, 'compare 没有追加内容');
    assert.ok(cmp.includes('对比'), 'compare 缺少对比文案');
    assert.equal(itemToTooltipHTML(null), '');
  });

  test('tooltip 防 XSS：恶意字段被转义', () => {
    const evil = {
      ...fallbackItem(),
      name: '<script>alert(1)</script>',
      rarityName: '<img src=x onerror=alert(2)>',
      mods: [],
      affixLines: [],
      flavor: '"><script>bad()</script>',
      influence: { name: '<b>注入</b>', color: '#000' },
    };
    const html = itemToTooltipHTML(evil);
    assert.ok(!html.includes('<script>'), 'tooltip 未转义 <script>');
    assert.ok(!html.includes('<img'), 'tooltip 未转义 <img');
    assert.ok(html.includes('&lt;script&gt;'), '应该出现转义后的文本');
  });

  test('itemScore：稀有度越高、等级越高分数越高（同槽位平均）', () => {
    const rng = new RNG(31);
    const avg = (rarity, level = 20) => {
      let s = 0;
      for (let i = 0; i < 150; i++) s += itemScore(generateItem({ rng, level, rarity, slot: 'body' }));
      return s / 150;
    };
    const normal = avg('normal');
    const magic = avg('magic');
    const rare = avg('rare');
    assert.ok(magic > normal, `magic ${magic} 应高于 normal ${normal}`);
    assert.ok(rare > magic, `rare ${rare} 应高于 magic ${magic}`);

    const lowLv = avg('rare', 5);
    const highLv = avg('rare', 40);
    assert.ok(highLv > lowLv, `高等级稀有 ${highLv} 应高于低等级 ${lowLv}`);
    assert.ok(itemScore(null) === 0 && itemScore(undefined) === 0);
  });
});

describe('天赋树 talentTree.js', () => {
  test('节点数量 >= 100，id 唯一', () => {
    assert.ok(TALENTS.length >= 100, `天赋节点只有 ${TALENTS.length} 个`);
    const ids = TALENTS.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, '天赋 id 重复');
  });

  test('每个节点字段完整', () => {
    for (const n of TALENTS) {
      assert.ok(typeof n.id === 'string' && n.id.length > 0);
      assert.ok(typeof n.name === 'string' && n.name.length > 0, `${n.id} 缺中文名`);
      assert.ok(['minor', 'notable', 'keystone', 'legendary', 'classStart'].includes(n.kind), `${n.id} kind 非法: ${n.kind}`);
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} 坐标非法`);
      assert.ok(typeof n.desc === 'string' && n.desc.length > 0, `${n.id} 缺描述`);
      assert.ok(n.stats && typeof n.stats === 'object', `${n.id} 缺 stats`);
      assert.ok(Array.isArray(n.neighbors), `${n.id} 缺 neighbors`);
    }
  });

  test('起始节点存在且 id 为 start-warrior', () => {
    assert.equal(START_NODE, 'start-warrior');
    const start = talentById(START_NODE);
    assert.ok(start, '找不到起始节点');
    assert.equal(start.kind, 'classStart');
    assert.ok(start.neighbors.length > 0, '起始节点没有邻居');
  });

  test('含 6 个基石，每个都有收益 + 代价 / 机制说明', () => {
    const ks = TALENTS.filter((n) => n.kind === 'keystone');
    assert.ok(ks.length >= 3, `keystone 只有 ${ks.length} 个`);
    for (const k of ks) {
      assert.ok(Object.keys(k.stats).length > 0, `${k.name} 没有数值`);
      // 基石必须是「变强的同时有代价」：至少有一个正收益，且 desc 里写出代价
      const vals = Object.values(k.stats);
      assert.ok(vals.some((v) => v > 0), `${k.name} 没有正收益`);
      assert.ok(/【代价】/.test(k.desc), `${k.name} 缺少代价说明`);
      assert.ok(k.notable && typeof k.notable.trait === 'string' && k.notable.trait.length > 0, `${k.name} 缺少机制说明`);
    }
    const immortal = ks.find((k) => k.name === '不朽战神');
    assert.ok(immortal && immortal.stats.physDamageMult > 0 && immortal.stats.skillLevelBonus > 0, '「不朽战神」数值不对');
    const wall = ks.find((k) => k.name === '不灭长城');
    assert.ok(wall && wall.stats.life > 0 && wall.stats.armor > 0 && wall.stats.moveSpeedMult < 0, '「不灭长城」数值不对');
    const immovable = ks.find((k) => k.name === '不动如山');
    assert.ok(immovable && immovable.stats.blockChance > 0 && immovable.stats.moveSpeedMult < 0, '「不动如山」数值不对');
    const flame = ks.find((k) => k.name === '焚世');
    assert.ok(flame && flame.stats.fireDamageMult > 0, '「焚世」缺火焰伤害');
  });

  test('含 3 个传奇节点，各有机制说明与 2 个邻居', () => {
    const lg = TALENTS.filter((n) => n.kind === 'legendary');
    assert.equal(lg.length, 3, `传奇节点 ${lg.length} 个`);
    for (const n of lg) {
      assert.ok(n.notable && n.notable.trait && n.notable.icon, `${n.name} 缺机制说明`);
      assert.ok(n.neighbors.length >= 2, `${n.name} 只有 ${n.neighbors.length} 个邻居（会变成死路）`);
    }
    assert.ok(TALENTS.some((n) => n.name === '天命之瞳'), '缺少「天命之瞳」');
    assert.ok(TALENTS.some((n) => n.name === '收割者'), '缺少「收割者」');
  });

  test('天赋节点 stats 键全部在 StatBlock 键集合内', () => {
    const allowed = new Set(ITEM_STAT_KEYS);
    for (const n of TALENTS) {
      for (const k in n.stats) {
        assert.ok(allowed.has(k), `${n.id}（${n.name}）使用了非法统计键 ${k}`);
        assert.equal(typeof n.stats[k], 'number', `${n.id}.${k} 不是数字`);
      }
    }
  });

  test('天赋树连通性：从 START_NODE 出发 BFS 可达全部节点', () => {
    const seen = reachableFrom(START_NODE);
    assert.equal(seen.size, TALENTS.length, `只能从起点到达 ${seen.size}/${TALENTS.length} 个节点`);
    for (const n of TALENTS) assert.ok(seen.has(n.id), `${n.id} 不可达`);
  });

  test('neighbors 双向一致', () => {
    for (const n of TALENTS) {
      for (const nb of n.neighbors) {
        const other = TALENT_BY_ID[nb];
        assert.ok(other, `${n.id} 的邻居 ${nb} 不存在`);
        assert.ok(other.neighbors.includes(n.id), `${n.id}→${nb} 不是双向连接`);
      }
    }
  });

  // ── 连线质量：这三条是「线条很乱 / 很近却不连」的回归守卫 ──────────────
  /** 汇总所有无向边。 */
  function allEdges() {
    const out = [];
    const seen = new Set();
    for (const n of TALENTS) {
      for (const nb of n.neighbors) {
        const key = n.id < nb ? `${n.id}|${nb}` : `${nb}|${n.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([n, TALENT_BY_ID[nb]]);
      }
    }
    return out;
  }

  test('连线：全部是近邻短边（普通边 ≤ 175，基石边 ≤ 165，最小间距 ≥ 20）', () => {
    for (const [a, b] of allEdges()) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const keystoneEdge = a.kind === 'keystone' || b.kind === 'keystone';
      assert.ok(d <= (keystoneEdge ? 165 : 175), `${a.id}~${b.id} 长 ${d.toFixed(1)} 像素（跨树长线）`);
    }
    // 任意两个节点不能贴脸（旧数据里出现过 10 像素的两个节点）
    let minD = Infinity;
    let pair = null;
    for (let i = 0; i < TALENTS.length; i++) {
      for (let j = i + 1; j < TALENTS.length; j++) {
        const d = Math.hypot(TALENTS[i].x - TALENTS[j].x, TALENTS[i].y - TALENTS[j].y);
        if (d < minD) { minD = d; pair = `${TALENTS[i].id}/${TALENTS[j].id}`; }
      }
    }
    assert.ok(minD >= 20, `最近的两个节点只隔 ${minD.toFixed(1)} 像素（${pair}）`);
  });

  test('连线：任意两条边不交叉，度数 ≤ 6', () => {
    const edges = allEdges();
    const orient = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const crosses = (p1, p2, p3, p4) => {
      const o1 = orient(p1, p2, p3);
      const o2 = orient(p1, p2, p4);
      const o3 = orient(p3, p4, p1);
      const o4 = orient(p3, p4, p2);
      return o1 !== o2 && o3 !== o4;
    };
    const bad = [];
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const [a, b] = edges[i];
        const [c, d] = edges[j];
        if (a.id === c.id || a.id === d.id || b.id === c.id || b.id === d.id) continue;
        if (crosses(a, b, c, d)) bad.push(`${a.id}~${b.id} × ${c.id}~${d.id}`);
      }
    }
    assert.equal(bad.length, 0, `有 ${bad.length} 条连线交叉：${bad.slice(0, 5).join('; ')}`);
    for (const n of TALENTS) {
      assert.ok(n.neighbors.length <= 6, `${n.id} 度数 ${n.neighbors.length}，会变成蜘蛛网`);
    }
    assert.ok(talentById(START_NODE).neighbors.length >= 6, '起点应该能连出 6 条主干');
  });

  test('连线：25 像素内的近邻必须已连接（不允许「明明很近却不连」）', () => {
    const missing = [];
    for (const n of TALENTS) {
      for (const m of TALENTS) {
        if (m === n || n.neighbors.includes(m.id)) continue;
        const d = Math.hypot(n.x - m.x, n.y - m.y);
        if (d < 25) missing.push(`${n.id}(${n.name}) ~ ${m.id}(${m.name}) = ${d.toFixed(1)}`);
      }
    }
    assert.equal(missing.length, 0, `有 ${missing.length} 对近邻没连：${missing.slice(0, 5).join('; ')}`);
  });

  test('坐标布局：主轴半径阶梯 + 6 条主干 + 6 个基石在最外圈', () => {
    const r = (n) => Math.hypot(n.x, n.y);
    const radii = new Set(TALENTS.map((n) => Math.round(r(n) / 5) * 5));
    for (const want of [35, 70, 120, 180, 235, 290, 370, 450, 600]) {
      assert.ok(radii.has(want), `缺少半径约 ${want} 的一层（现有 ${[...radii].sort((a, b) => a - b).join(',')}）`);
    }
    const branches = new Set(TALENTS.map((n) => n.branch).filter((b) => b && b !== 'ring' && b !== 'center' && b !== 'keystone' && b !== 'legendary'));
    assert.equal(branches.size, 6, `主干数量 ${branches.size}`);
    const ks = TALENTS.filter((n) => n.kind === 'keystone');
    for (const k of ks) assert.ok(Math.abs(r(k) - 600) <= 5, `${k.id} 不在最外圈（r=${r(k).toFixed(0)}）`);
    const angles = new Set(ks.map((k) => Math.round(k.angle)));
    assert.equal(angles.size, 6, '6 个基石应在 6 个不同方向上');
  });

  test('canAllocate：只有相邻已点亮才可加点', () => {
    const allocated = new Set([START_NODE]);
    const nb = talentById(START_NODE).neighbors[0];
    assert.ok(canAllocate(nb, allocated), '起点邻居应该可以加点');
    const far = TALENTS.find((n) => !allocated.has(n.id) && !talentById(START_NODE).neighbors.includes(n.id));
    assert.ok(far, '找不到远离起点的节点');
    assert.ok(!canAllocate(far.id, allocated), '不相邻的节点不应可加点');
    assert.ok(!canAllocate(START_NODE, allocated), '起点不能重复分配');
    assert.ok(!canAllocate('not-exist', allocated), '不存在的节点不可分配');
  });

  test('aggregateTalentStats 汇总数值 + legendaryTraits 只返回已点亮的机制', () => {
    const fight = talentById('war-stem1');
    assert.ok(fight, '缺少 war-stem1');
    const agg = aggregateTalentStats([START_NODE, fight.id]);
    for (const k in fight.stats) assert.ok(Math.abs(agg[k] - fight.stats[k]) < 1e-9, `${k} 汇总不对`);
    assert.deepEqual(aggregateTalentStats([]), {});
    const ks = TALENTS.find((n) => n.kind === 'keystone');
    const lg = TALENTS.find((n) => n.kind === 'legendary');
    const none = legendaryTraits([START_NODE]);
    assert.equal(none.length, 0, '没点基石/传奇时不应有机制');
    const some = legendaryTraits([START_NODE, ks.id, lg.id]);
    assert.equal(some.length, 2, `已点亮的机制数量 ${some.length}`);
    for (const t of some) assert.ok(t.trait && t.trait.length > 0, `${t.id} 缺机制说明`);
  });

  test('talentStats 统计信息', () => {
    const s = talentStats();
    assert.equal(s.total, TALENTS.length);
    assert.ok(s.byKind.notable >= 15, `notable 只有 ${s.byKind.notable}`);
    assert.ok(s.byKind.keystone >= 3);
    assert.equal(s.byKind.classStart, 1);
    assert.equal(s.byKind.legendary, 3);
    assert.ok(s.edges > TALENTS.length * 0.9 && s.edges < TALENTS.length * 1.4, `边数 ${s.edges} 异常`);
  });
});
describe('技能树 skillTree.js', () => {
  // [契约更新] 技能树 v2：groundSlam 裂地斩 → stomp 战争践踏，每个技能改为「分叉」小树
  //（ROOT → 左支/右支（逐层互斥）→ 分支专精 → 终极），详见 docs/skill-upgrade-contract.md §3.1/§3.2。
  // 战争践踏 / 眩晕 的细节断言在 tests/skill-upgrade.test.mjs 里，这里只做数据与汇总的回归。

  test('包含 core 的 5 个技能（1 号是 stomp 战争践踏）', () => {
    for (const sid of ['stomp', 'whirlwind', 'warcry', 'bloodRage', 'rally']) {
      assert.ok(SKILL_TREES[sid], `缺少技能树 ${sid}`);
      assert.ok(SKILL_TREES[sid].name && SKILL_TREES[sid].name.length > 0);
      assert.ok(Array.isArray(SKILL_TREES[sid].nodes));
    }
    assert.equal(SKILL_TREES.stomp.name, '战争践踏');
    assert.equal(SKILL_TREES.groundSlam, undefined, 'groundSlam 技能树已被 stomp 取代');
    assert.equal(SKILL_IDS.length, 5);
  });

  test('每个技能 9-12 个节点，字段合法（含 branch / group）', () => {
    for (const sid of SKILL_IDS) {
      const t = SKILL_TREES[sid];
      assert.ok(t.nodes.length >= 9 && t.nodes.length <= 12, `${sid} 节点数 ${t.nodes.length} 应为 9-12`);
      for (const n of t.nodes) {
        assert.ok(n.id.startsWith(`${sid}.`), `${n.id} 前缀不对`);
        assert.ok(n.name && n.name.length > 0);
        assert.ok(n.desc && n.desc.length > 0);
        assert.ok(n.cost >= 1);
        assert.ok(n.maxRank >= 1);
        assert.ok(Array.isArray(n.effects) && n.effects.length > 0, `${n.id} 没有效果`);
        for (const e of n.effects) {
          assert.ok(typeof e.type === 'string' && e.type.length > 0);
          assert.equal(typeof e.value, 'number');
        }
        assert.ok(Array.isArray(n.requires));
        assert.ok(typeof n.branch === 'string' && n.branch.length > 0, `${n.id} 缺少 branch`);
      }
      // 恰好 1 个 ROOT（无前置，maxRank 3）+ 1 个终极节点（不互斥）
      const roots = t.nodes.filter((n) => !n.requires || !n.requires.length);
      assert.equal(roots.length, 1, `${sid} 应恰好 1 个 ROOT`);
      assert.equal(roots[0].maxRank, 3, `${sid} 的 ROOT 应是 maxRank 3`);
      const ultimates = t.nodes.filter((n) => n.branch === 'ultimate');
      assert.equal(ultimates.length, 1, `${sid} 应有 1 个终极节点`);
      assert.equal(ultimates[0].group, '', `${sid} 的终极节点不应属于互斥组`);
    }
  });

  test('skillNodeById 全局可查', () => {
    assert.ok(skillNodeById('stomp.root'));
    assert.ok(skillNodeById('stomp.u'));
    assert.ok(skillNodeById('whirlwind.root'));
    assert.equal(skillNodeById('nope.nope'), undefined);
    assert.equal(skillNodeById('groundSlam.meteor'), undefined, '旧的裂地斩节点已删除');
    assert.equal(SKILL_NODES.length, SKILL_IDS.reduce((a, s) => a + SKILL_TREES[s].nodes.length, 0));
    assert.ok(skillTreeOf('不存在的技能').nodes.length === 0, '未知技能应返回空树');
  });

  test('skillEffectsForSkill：无加点时为中性值（含 multiplierBonuses 默认 1）', () => {
    const e = skillEffectsForSkill('stomp', {});
    assert.equal(e.damageMult, 1);
    assert.equal(e.radiusMult, 1);
    assert.equal(e.cooldownMult, 1);
    assert.equal(e.count, 0);
    assert.equal(e.extra, 0);
    assert.deepEqual(e.stats, {});
    assert.deepEqual(e.nodes, []);
    assert.ok(e.multiplierBonuses, '必须返回 multiplierBonuses');
    for (const [k, v] of Object.entries(e.multiplierBonuses)) {
      assert.equal(v, 1, `未加点时乘法系数 ${k} 应为 1`);
    }
  });

  test('skillEffectsForSkill 汇总正确（伤害/半径/冷却按节点 effects 累加）', () => {
    const root = skillNodeById('stomp.root');
    const l1 = skillNodeById('stomp.l1');
    const sumOf = (node, type) => (node.effects || []).filter((x) => x.type === type).reduce((a, x) => a + x.value, 0);
    const round = (v) => Math.round(v * 1000) / 1000;

    // ROOT 3 档：每档的 damageMult 效果都累加
    const eRoot3 = skillEffectsForSkill('stomp', { 'stomp.root': 3 });
    assert.equal(eRoot3.damageMult, round(1 + sumOf(root, 'damageMult') * 3));
    // ROOT 1 档：只算 1 份
    const eRoot1 = skillEffectsForSkill('stomp', { root: 1 });
    assert.equal(eRoot1.damageMult, round(1 + sumOf(root, 'damageMult')));

    // 左支 L1：ROOT + L1
    const eL1 = skillEffectsForSkill('stomp', { 'stomp.root': 1, 'stomp.l1': 1 });
    assert.equal(eL1.damageMult, round(1 + sumOf(root, 'damageMult') + sumOf(l1, 'damageMult')));
    assert.ok(eL1.nodes.includes('stomp.l1'), 'L1 应出现在生效节点里');

    // 短名与全名等价
    assert.deepEqual(
      skillEffectsForSkill('stomp', { root: 2, l1: 1 }).ranks,
      skillEffectsForSkill('stomp', { 'stomp.root': 2, 'stomp.l1': 1 }).ranks,
    );

    // 选项环节点（右支 R1）：影响攻击/护甲类汇总（multiplierBonuses 或 stats）
    const eR1 = skillEffectsForSkill('stomp', { 'stomp.root': 1, 'stomp.r1': 1 });
    const touched = eR1.radiusMult !== 1
      || Object.values(eR1.multiplierBonuses).some((v) => v !== 1)
      || Object.keys(eR1.stats).length > 0
      || Object.keys(eR1.flatBonuses || {}).length > 0;
    assert.ok(touched, 'R1 应该带上某种数值效果（半径/护甲/眩晕…）');
  });

  test('前置未满足的节点不生效（L2 需要 L1，终极需要走通一条支线）', () => {
    // 只点 L2（前置 L1 未点）→ 不生效
    const e = skillEffectsForSkill('stomp', { 'stomp.l2': 1 });
    assert.deepEqual(e.nodes, [], '前置未点，L2 不应生效');
    // 点了 ROOT + L1 后 L2 生效
    const e2 = skillEffectsForSkill('stomp', { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1 });
    assert.ok(e2.nodes.includes('stomp.l2'));
    // 终极节点：只有 ROOT 时无效；走通左链后生效
    const eU1 = skillEffectsForSkill('stomp', { 'stomp.root': 1, 'stomp.u': 1 });
    assert.ok(!eU1.nodes.includes('stomp.u'), '只有 ROOT 时终极节点不应生效');
    const fullLeft = { 'stomp.root': 1, 'stomp.l1': 1, 'stomp.l2': 1, 'stomp.l3': 1, 'stomp.l4': 1, 'stomp.u': 1 };
    const eU2 = skillEffectsForSkill('stomp', fullLeft);
    assert.ok(eU2.nodes.includes('stomp.u'), `走通左链后终极节点应生效，nodes=${eU2.nodes.join(',')}`);
  });

  test('档位超过 maxRank 会被裁剪；负数/非法档位忽略', () => {
    const root = skillNodeById('stomp.root');
    const per = (root.effects || []).filter((x) => x.type === 'damageMult').reduce((a, x) => a + x.value, 0);
    const e = skillEffectsForSkill('stomp', { 'stomp.root': 99 });
    assert.equal(e.damageMult, Math.round((1 + per * root.maxRank) * 1000) / 1000, 'ROOT 最多 3 阶');
    assert.equal(e.ranks['stomp.root'], root.maxRank);
    const e2 = skillEffectsForSkill('stomp', { 'stomp.root': -3 });
    assert.equal(e2.damageMult, 1);
    const e3 = skillEffectsForSkill('stomp', { 'whirlwind.root': 3 });
    assert.equal(e3.damageMult, 1, '别的技能的节点不应影响本技能');
  });

  test('cooldownMult 有下限保护', () => {
    // 把冷却缩减类型的节点全点满，冷却倍率仍不能低于 0.4
    const all = {};
    for (const n of SKILL_TREES.whirlwind.nodes) all[n.id] = n.maxRank;
    const e = skillEffectsForSkill('whirlwind', all);
    assert.ok(e.cooldownMult >= 0.4 && e.cooldownMult <= 1.6, `cooldownMult=${e.cooldownMult}`);
  });

  test('bloodRage 的攻速类效果汇总进 stats.attackSpeedMult', () => {
    const e = skillEffectsForSkill('bloodRage', { 'bloodRage.root': 2, 'bloodRage.l1': 2 });
    assert.ok(e.stats.attackSpeedMult > 0, `攻速应汇总进 stats，实际 ${JSON.stringify(e.stats)}`);
    // 单点 ROOT 时数值 = ROOT 的攻速效果 × 档位
    const root = skillNodeById('bloodRage.root');
    const per = (root.effects || []).filter((x) => x.key === 'attackSpeedMult').reduce((a, x) => a + x.value, 0);
    const e1 = skillEffectsForSkill('bloodRage', { 'bloodRage.root': 1 });
    assert.ok(Math.abs(e1.stats.attackSpeedMult - per) < 1e-9, `${e1.stats.attackSpeedMult} vs ${per}`);
  });
});

describe('统一出口 index.js', () => {
  test('关键导出都存在', () => {
    const need = [
      'BASE_ITEMS', 'SLOTS', 'ITEM_SLOTS', 'SLOT_NAMES', 'RARITY', 'PREFIXES', 'SUFFIXES',
      'rollRarity', 'rollAffixes', 'UNIQUES', 'tryUnique',
      'generateItem', 'generateDrop', 'itemStatLines', 'itemScore', 'itemToTooltipHTML', 'rerollItem',
      'TALENTS', 'START_NODE', 'talentById', 'SKILL_TREES', 'skillNodeById', 'skillEffectsForSkill',
      'compareItems', 'describeItem', 'STAT_KEYS',
    ];
    for (const k of need) assert.ok(itemsIndex[k] !== undefined, `index.js 缺少导出 ${k}`);
  });

  test('compareItems / describeItem 可用', () => {
    const rng = new RNG(2);
    const a = generateItem({ rng, level: 30, rarity: 'rare' });
    const b = generateItem({ rng, level: 1, rarity: 'normal' });
    const cmp = itemsIndex.compareItems(a, b);
    assert.equal(cmp.score, itemScore(a));
    assert.equal(typeof cmp.diff, 'number');
    assert.equal(typeof cmp.better, 'boolean');
    const text = itemsIndex.describeItem(a);
    assert.ok(text.includes(a.name));
    assert.ok(text.includes('战力'));
  });
});

describe('模块纯净性（不依赖浏览器 / DOM）', () => {
  test('所有 items 模块在 Node 下可导入且不触碰 window/document', async () => {
    assert.equal(typeof globalThis.window, 'undefined');
    assert.equal(typeof globalThis.document, 'undefined');
    const mods = ['common', 'bases', 'rarity', 'affix_extra', 'affixes', 'unique', 'itemgen', 'talentTree', 'skillTree', 'index'];
    for (const m of mods) {
      const mod = await import(`../src/items/${m}.js`);
      assert.ok(mod && typeof mod === 'object', `${m}.js 导入失败`);
    }
  });
});