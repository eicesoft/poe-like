// 检查浏览器启动能力（纯诊断，不 spawn 任何东西）。
// 用法：node tools/qa-browser-probe.mjs [port]
const port = Number(process.argv[2] || 9339);
const deadline = Date.now() + 6000;
let last = null;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    last = { ok: true, body: await r.json() };
    break;
  } catch (e) {
    last = { ok: false, err: e.cause ? String(e.cause.code || e.cause.message) : String(e.message) };
    await new Promise((res) => setTimeout(res, 300));
  }
}
console.log(JSON.stringify({ port, devtools: last }, null, 2));
process.exit(last && last.ok ? 0 : 2);