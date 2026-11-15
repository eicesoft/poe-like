// 估算 #help-hint 的真实渲染宽度（混合宽度）：CJK/全角 = 1em，ASCII ≈ 0.62em，再加 letter-spacing 0.06em。
// 用来判断它和居中的 #skillbar 是否真的在竖向上打架。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const m = html.match(/<div id="help-hint">([\s\S]*?)<\/div>/);
const text = m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
const fontSize = Number(process.argv[2] || 11);
const ls = 0.06;
let em = 0;
for (const ch of text) em += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.62;

// 横向：居中元素，x = (W - width)/2
const W = Number(process.argv[3] || 1280);
const H = Number(process.argv[4] || 720);
const w = Math.round(em * fontSize * (1 + ls));
const hintRect = { x: Math.round((W - w) / 2), y: H - 6 - Math.ceil(fontSize * 1.25), w, h: Math.ceil(fontSize * 1.25) };
// #skillbar：bottom:18，7×52 + 6×7 + 2×9 + 2 = 426 宽、68 高
const skillRect = { x: Math.round((W - 426) / 2), y: H - 18 - 68, w: 426, h: 68 };
const ovY = Math.min(hintRect.y + hintRect.h, skillRect.y + skillRect.h) - Math.max(hintRect.y, skillRect.y);
const ovX = Math.min(hintRect.x + hintRect.w, skillRect.x + skillRect.w) - Math.max(hintRect.x, skillRect.x);
console.log(JSON.stringify({
  text, chars: [...text].length, estEm: +em.toFixed(1),
  hintRect, skillRect,
  overlapY: ovY > 0 ? ovY : null,
  overlapX: ovX > 0 ? ovX : null,
  verdict: (ovY > 0 && ovX > 0)
    ? `竖向上重叠 ${ovY}px、横向上重叠 ${ovX}px → #skillbar 的底边会压住 #help-hint 的上沿（既有问题）`
    : '不重叠',
  note: '#skillbar 是半透明+blur 的卡片 → 被压在下面的文字仍会透出来一点，但属于"既有 HUD 布局"问题，与本次三件事无关',
}, null, 2));