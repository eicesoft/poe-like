// 运行全部测试套件
import { runAll } from './_runner.mjs';
// 定时器隔离：任何测试里残留的 setTimeout（旧 DOM 桩里 requestAnimationFrame 就是这么实现的）
// 都会在进程退出前被取消，避免 "Cannot read properties of undefined (reading 'classList')" 这类
// "进程结束后才触发" 的崩溃。必须在 import 任何 UI 模块之前加载。
import { clearTrackedTimers } from './_skillhelpers.mjs';

const files = (await import('node:fs')).readdirSync(new URL('.', import.meta.url))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

for (const f of files) {
  await import(new URL(f, import.meta.url).href);
}

const result = await runAll();
// 清理所有还没触发的定时器（幂等；只影响测试期间创建的那些）
clearTrackedTimers();
const code = result.fail ? 1 : 0;
process.exitCode = code;
// 部分 UI / DOM 桩测试会留下未关闭的 I/O 句柄，Node 在测试全部跑完后仍不会自动退出，
// 进而卡住 `npm test` 与链式执行的 `npm run verify`。测试结果此时已全部写完，
// 等 stdout 刷干净后显式退出（40ms 兜底，避免管道异常时永远等不到回调）。
let exited = false;
const exitOnce = () => { if (!exited) { exited = true; process.exit(code); } };
process.stdout.write('', exitOnce);
setTimeout(exitOnce, 40);