// 单次浏览器启动尝试（供 qa-shots 与人工排查使用）。
// 注意：本文件会 spawn 子进程 —— 在 DSH 沙箱下会拿到 spawn EPERM / 浏览器 mojo FATAL，
// 这是「环境能力探针」，不是 QA 通过/失败判据。qa-shots.mjs 自身绝不 spawn。
//
// 用法：node tools/_shots/panelbar/_attempt.mjs <url> [out.png]
//   变量：CDP_EXE（浏览器路径）、CDP_PORT、CDP_PROFILE
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CHROME = process.env.CDP_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = process.env.CDP_PORT || '9351';
const PROF = process.env.CDP_PROFILE || `${process.env.TEMP}\\poe-qa-attempt`;
const URL = process.argv[2] || 'about:blank';
const OUT = process.argv[3] || null;

const child = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run', '--disable-crash-reporter', '--disable-breakpad',
  `--user-data-dir=${PROF}`, `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });
child.on('error', (e) => console.log('spawn err ' + e.code));
let info = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    info = await res.json();
    break;
  } catch { /* 还没起来 */ }
}
if (!info) {
  console.log('CHROME_DEAD exited=' + child.exitCode + ' (expect 0xC0000005/0x80000005 under sandbox)');
  process.exit(3);
}
console.log('CHROME_UP ' + info.Browser);
try {
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const t = await send('Target.createTarget', { url: 'about:blank' });
  const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
  const sid = a.result.sessionId;
  await send('Page.enable', {}, sid);
  await send('Page.navigate', { url: URL }, sid);
  await new Promise((r) => setTimeout(r, 1200));
  const ev = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, sid);
  console.log('EVAL ' + JSON.stringify(ev.result?.result?.value ?? ev.result));
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
  if (OUT && shot.result?.data) { writeFileSync(OUT, Buffer.from(shot.result.data, 'base64')); console.log('SHOT ' + OUT); }
  else console.log('SHOT_FAIL ' + JSON.stringify(shot.error || 'no data'));
  ws.close();
  console.log('OK');
} catch (e) {
  console.log('ERR ' + (e && e.message));
  process.exitCode = 2;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 300));
  process.exit();
}