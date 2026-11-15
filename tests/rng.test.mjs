import { describe, test, assert } from './_runner.mjs';
import { RNG, hashString } from '../src/engine/rng.js';

describe('RNG 确定性', () => {
  test('相同种子产生相同序列', () => {
    const a = new RNG(12345);
    const b = new RNG(12345);
    for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  });
  test('不同种子产生不同序列', () => {
    const a = new RNG(1);
    const b = new RNG(2);
    assert.notEqual(a.next(), b.next());
  });
  test('next() 在 [0,1)', () => {
    const r = new RNG(99);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      assert.ok(v >= 0 && v < 1);
    }
  });
  test('区间分布大致均匀', () => {
    const r = new RNG(7);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(r.range(0, 1) * 10)]++;
    for (const b of buckets) assert.ok(b > 800 && b < 1200, `bucket=${b}`);
  });
  test('int() 返回闭区间整数', () => {
    const r = new RNG(3);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(1, 5);
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 5);
      seen.add(v);
    }
    assert.equal(seen.size, 5);
  });
  test('pick / shuffle 不破坏原数组', () => {
    const r = new RNG(5);
    const arr = [1, 2, 3, 4, 5];
    const s = r.shuffle(arr);
    assert.deepEqual(arr, [1, 2, 3, 4, 5]);
    assert.equal(s.length, 5);
    for (const v of arr) assert.ok(s.includes(v));
  });
  test('weighted 偏好高权重', () => {
    const r = new RNG(11);
    let hi = 0;
    for (let i = 0; i < 1000; i++) if (r.weighted([{ weight: 1, v: 'a' }, { weight: 9, v: 'b' }]).v === 'b') hi++;
    assert.ok(hi > 850 && hi < 950, `hi=${hi}`);
  });
  test('hashString 稳定', () => {
    assert.equal(hashString('abc'), hashString('abc'));
    assert.notEqual(hashString('abc'), hashString('abd'));
  });
});