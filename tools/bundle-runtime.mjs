// 运行时模板：兼容模块内提前 `__end()`（会结束当前模块），并在最外层统一清理
export const RUNTIME = (chunks, modCount, entryId) => `(function(){"use strict";
const __live = [];
const __finished = [];
const __pending = [];
const __stack = [];
let __cur = -1;
${chunks.join('')}
function __mod(id, exp, req, ready, end) {
  switch (id) {${Array.from({ length: modCount }, (_, i) => `\n    case ${i}: return mod_${i}(exp, req, ready, end);`).join('')}
    default: throw new Error('module ' + id + ' missing');
  }
}
function __flush(id) {
  const exp = __live[id];
  if (!exp || __finished[id]) return;
  const pend = __pending[id];
  if (pend) { for (const k in pend) { if (exp[k] === undefined) exp[k] = pend[k]; } __pending[id] = null; }
  exp.__running = false;
  __finished[id] = true;
}
function __start(id) {
  id = +id;
  if (__finished[id]) return;
  const exp = __live[id] || (__live[id] = {});
  if (exp.__running) return;
  exp.__running = true;
  const prev = __cur;
  __cur = id;
  __stack.push(id);
  try {
    __mod(id, exp, __req, __ready, __end);
    __flush(id);            // 正常执行完毕（若已提前 __end 则空操作）
  } catch (e) {
    __flush(id);
    throw e;
  } finally {
    __stack.pop();
    __cur = prev;
  }
}
function __end() { if (__cur >= 0) __flush(__cur); }   // 模块内提前结束
function __ready(name, value) {
  const id = __cur;
  if (id < 0) return value;
  const exp = __live[id];
  if (value !== undefined) exp[name] = value;
  (__pending[id] || (__pending[id] = {}))[name] = value;
  return value;
}
function __settle(id) { __start(id); return __live[id]; }
function __dget(m, k) { for (let i = 0; i < __live.length; i++) if (__live[i] === m) __settle(i); return m[k]; }
function __req(id) { id = +id; if (!__live[id]) __live[id] = {}; __start(id); return __live[id]; }
try { __start(${entryId}); } catch (e) { console.error('[bundle] 启动异常', (e && e.stack) || e); }
})();
`;