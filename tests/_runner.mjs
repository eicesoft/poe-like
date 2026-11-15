// 极简测试框架 — 无外部依赖，纯 node 运行。
import assert from 'node:assert/strict';
export { assert };

const suites = [];
let current = null;

export function describe(name, fn) {
  const prev = current;
  current = { name, tests: [], beforeEach: null, before: null };
  suites.push(current);
  fn();
  current = prev;
}

export function beforeEach(fn) {
  if (current) current.beforeEach = fn;
}

/**
 * 套件级初始化（每个套件跑一次，早于该套件的第一个测试）。
 * 用途：需要在「本套件所有测试之前」而不是「每个测试之前」做一次的事情，
 * 比如装/拆 DOM 桩（每个测试都重建既浪费又会泄漏全局对象）。
 */
export function before(fn) {
  if (current) current.before = fn;
}

export function test(name, fn) {
  if (!current) describe('default', () => test(name, fn));
  else current.tests.push({ name, fn });
}

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m',
};

export async function runAll() {
  let pass = 0, fail = 0;
  const failures = [];
  const t0 = Date.now();
  for (const s of suites) {
    console.log(`\n${C.cyan}${C.bold}▸ ${s.name}${C.reset}`);
    if (s.before) {
      // 套件级初始化失败 → 该套件所有测试都记为失败（不要静默跳过）
      try {
        await s.before();
      } catch (e) {
        for (const t of s.tests) {
          fail++;
          failures.push({ suite: s.name, test: t.name, err: e });
          console.log(`  ${C.red}✗ ${t.name}${C.reset}`);
          console.log(`    ${C.yellow}before 失败：${e && e.message ? e.message.split('\n').slice(0, 4).join('\n    ') : e}${C.reset}`);
        }
        continue;
      }
    }
    for (const t of s.tests) {
      try {
        if (s.beforeEach) await s.beforeEach();
        await t.fn();
        pass++;
        console.log(`  ${C.green}✓${C.reset} ${t.name}`);
      } catch (e) {
        fail++;
        failures.push({ suite: s.name, test: t.name, err: e });
        console.log(`  ${C.red}✗ ${t.name}${C.reset}`);
        console.log(`    ${C.yellow}${e && e.message ? e.message.split('\n').slice(0, 6).join('\n    ') : e}${C.reset}`);
      }
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\n${C.bold}${fail === 0 ? C.green : C.red}共 ${pass + fail} 项测试，通过 ${pass}，失败 ${fail}（${dt}s）${C.reset}`);
  if (failures.length) {
    console.log(`\n${C.gray}失败详情:${C.reset}`);
    for (const f of failures) console.log(` - [${f.suite}] ${f.test}\n   ${f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 4).join('\n   ') : f.err}`);
  }
  return { pass, fail, failures };
}