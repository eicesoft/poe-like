// 为「暂停卡片」合成一份与 DOM 一致的预览：不改 tools/hud-preview.mjs，
// 而是生成一份副本，把 drawPauseOverlay 的按钮文案/数量换成 src/ui/pause.js 里 ACTIONS 的真实值
// （8 个：继续游戏 / 属性 / 天赋 / 技能 / 装备 / 音效 / 保存游戏 / 返回主菜单）。
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('tools/hud-preview.mjs', 'utf8');
const pauseSrc = readFileSync('src/ui/pause.js', 'utf8');
const block = pauseSrc.slice(pauseSrc.indexOf('const ACTIONS = ['), pauseSrc.indexOf('];', pauseSrc.indexOf('const ACTIONS = [')) + 2);
const acts = [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
if (acts.length !== 8) throw new Error('pause.js ACTIONS 解析失败: ' + acts.length);

const REPLACEMENTS = [
  // 面板按钮列：CSS 最终形态（左下横排 44×44）
  ['  const w = 58, h = 50, gap = 8, pad = 5;\n  const boxW = w + pad * 2 + 2, boxH = btns.length * h + (btns.length - 1) * gap + pad * 2 + 2;\n  const bx = VIEW_W - 14 - boxW, by = VIEW_H - 328 - boxH;',
    '  const w = 44, h = 44, gap = 8, pad = 4;\n  const boxW = btns.length * w + (btns.length - 1) * gap + pad * 2 + 2, boxH = h + pad * 2 + 2;\n  const bx = 14, by = VIEW_H - 19 - boxH;'],
  ['    const x = bx + 1 + pad, y = by + 1 + pad + i * (h + gap);', '    const x = bx + 1 + pad + i * (w + gap), y = by + 1 + pad;'],
  ['    const cx = x + w / 2, cy = y + 20;', '    const cx = x + w / 2, cy = y + 16;'],
  // 地图卡居中、属性卡贴右、掉落条 right14/bottom96、静音键 right14/bottom20
  ['hudCard(cv, 440, 12, 300, 74);', 'hudCard(cv, Math.round(VIEW_W / 2 - 150), 12, 300, 74);'],
  ['hudCard(cv, 1000, 12, 266, 314);', 'hudCard(cv, VIEW_W - 12 - 266, 12, 266, 314);'],
  ['hudCard(cv, 926, 578, 340, 46);', 'hudCard(cv, VIEW_W - 14 - 340, VIEW_H - 96 - 46, 340, 46);'],
  ['cv.rrect(VIEW_W - 14 - 34, VIEW_H - 310 - 34, 34, 34, 4, \'#12141c\', 1);', 'cv.rrect(VIEW_W - 14 - 34, VIEW_H - 20 - 34, 34, 34, 4, \'#12141c\', 1);'],
  ['cv.stroke(VIEW_W - 14 - 34, VIEW_H - 310 - 34, 34, 34, 4, LINE, 1);', 'cv.stroke(VIEW_W - 14 - 34, VIEW_H - 20 - 34, 34, 34, 4, LINE, 1);'],
  ['cv.circle(VIEW_W - 14 - 17, VIEW_H - 310 - 17, 5, GOLD, 0.9);', 'cv.circle(VIEW_W - 14 - 17, VIEW_H - 20 - 17, 5, GOLD, 0.9);'],
  // 暂停卡片：按钮文案换成 pause.js 的真实 8 个，并按真实作用标明 primary/danger（ASCII 点阵字体画不了中文）
  ["  const labels = ['RESUME  ESC', 'STATS  C', 'TALENTS  P', 'SKILLS  K', 'EQUIP  E', 'SFX  M', 'SAVE', 'QUIT  (CONFIRM)'];",
    `  const labels = ${JSON.stringify(acts.map((a, i) => `${['RESUME  ESC', 'STATS  C', 'TALENTS  P', 'SKILLS  K', 'EQUIP  E', 'SFX  M', 'SAVE', 'QUIT (CONFIRM)'][i]}  // #${i + 1} ${a}`))};`],
  ["    const hover = i === 0;", "    const hover = i === 0; const isDanger = i === 7;"],
  ["    cv.vgrad(x, y, w, h, hover ? '#3a2f1a' : '#1a1d28', hover ? '#241b0c' : '#0b0c12', 1);",
    "    cv.vgrad(x, y, w, h, hover ? '#3a2f1a' : (isDanger ? '#2a1414' : '#1a1d28'), hover ? '#241b0c' : (isDanger ? '#180a0a' : '#0b0c12'), 1);"],
  ["    cv.stroke(x, y, w, h, 3, hover ? GOLD : '#4d4634', 1);", "    cv.stroke(x, y, w, h, 3, hover ? GOLD : (isDanger ? '#7a3a32' : '#4d4634'), 1);"],
  ["    const x = cx + 30 + (i % 2) * 232;", "    const x = cx + Math.round(cw * 30 / 520) + (i % 2) * Math.round(cw * 232 / 520);"],
  ["    const w = 220, h = 44;", "    const w = Math.round(cw * 220 / 520), h = 44;"],
];

function build(w, h, outDir) {
  let out = src
    .replace(/const VIEW_W = \d+;/, `const VIEW_W = ${w};`)
    .replace(/const VIEW_H = \d+;/, `const VIEW_H = ${h};`)
    .replaceAll("from '../src/", "from '../../../src/")
    .replaceAll("from '../tests/", "from '../../../tests/")
    .replace("const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');", "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');")
    .replace("const OUT = join(ROOT, 'tools/_shots/hud');", `const OUT = join(ROOT, 'tools/_shots/panelbar/${outDir}');`);
  let hit = 0;
  for (const [a, b] of REPLACEMENTS) {
    if (out.includes(a)) { out = out.replace(a, b); hit++; }
    else console.warn('未命中:', a.slice(0, 70));
  }
  const file = `tools/_shots/panelbar/_hud-${w}.mjs`;
  writeFileSync(file, out);
  console.log(`ok ${w}x${h} → ${outDir}（替换 ${hit}/${REPLACEMENTS.length}；暂停按钮 ${acts.length} 个：${acts.join('/')}）`);
}

build(1280, 720, 'hud-1280');
build(1920, 1080, 'hud-1920');