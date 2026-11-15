// 构建：产出可双击运行的单文件 index-standalone.html。
// 本环境（DSH 沙箱）禁止 Node 派生 esbuild 服务进程，因此这里实现了一个轻量 ESM 打包器：
//   - 支持静态 import（具名/星号/默认/副作用）、export（声明式 + 导出列表 + 默认 + export *）
//   - 支持循环依赖（模块先拿占位表，模块执行完成后回填）
// 用法：node tools/build.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME } from './bundle-runtime.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** @type {Map<string, {code:string, deps:string[], exports:{name:string,local:string}[]}>} */
const modules = new Map();

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) throw new Error('仅支持相对路径 import：' + spec);
  let p = resolve(dirname(fromFile), spec);
  if (!p.endsWith('.js')) p += '.js';
  if (!existsSync(p)) throw new Error('找不到模块 ' + spec + '（from ' + fromFile + '）');
  return p;
}

/** 第一遍：解析单文件，import 用 "__REQ(spec)" 占位，稍后统一换编号 */
function parse(absPath) {
  let code = readFileSync(absPath, 'utf8');
  const deps = [];
  const depRef = (spec) => {
    const target = resolveSpec(absPath, spec);
    if (!deps.includes(target)) deps.push(target);
    return '__REQ(' + JSON.stringify(target) + ')';
  };
  const exports = [];
  const note = (n) => exports.push({ name: n, local: n });
  const named = (spec, parts) => parts.map((s) => {
    const [orig, alias] = s.split(/\s+as\s+/).map((x) => x.trim());
    const local = alias || orig;
    return 'let ' + local + ' = __dget(' + depRef(spec) + ", '" + orig + "');";
  }).join(' ');

  code = code.replace(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?/g, (m, ns, spec) => 'const ' + ns + ' = ' + depRef(spec) + ';');
  code = code.replace(/import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/g, (m, def, names, spec) => {
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
    return 'const ' + def + ' = ' + depRef(spec) + '.default; ' + named(spec, parts);
  });
  code = code.replace(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/g, (m, names, spec) => {
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean);
    return named(spec, parts);
  });
  code = code.replace(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?/g, (m, def, spec) => 'const ' + def + ' = ' + depRef(spec) + '.default;');
  code = code.replace(/import\s+['"]([^'"]+)['"];?/g, (m, spec) => depRef(spec) + ';');

  code = code.replace(/export\s+\*\s+from\s+['"]([^'"]+)['"];?/g, (m, spec) => 'Object.assign(__exports, ' + depRef(spec) + ');');
  code = code.replace(/export\s+(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, (m, as, n) => { note(n); return (as || '') + 'function ' + n; });
  code = code.replace(/export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, (m, n) => { note(n); return 'class ' + n; });
  code = code.replace(/export\s+(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g, (m, kw, n) => { note(n); return kw + ' ' + n; });
  code = code.replace(/export\s*\{([\s\S]*?)\}\s*;?/g, (m, names) => {
    const pairs = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [orig, alias] = s.split(/\s+as\s+/).map((x) => x.trim());
      exports.push({ name: (alias || orig).trim(), local: orig.trim() });
      return JSON.stringify((alias || orig).trim()) + ': ' + orig.trim();
    });
    return 'Object.assign(__exports, { ' + pairs.join(', ') + ' });';
  });
  code = code.replace(/export\s+default\s+/g, '__exports.default = ');
  return { code, deps, exports };
}

/** 第二遍：把 import 占位替换成模块编号 */
function emit(absPath, ids) {
  const rec = modules.get(absPath);
  let code = rec.code.replace(/__REQ\("((?:[^"\\]|\\.)*)"\)/g, (m, spec) => {
    const resolved = JSON.parse('"' + spec + '"');
    const target = resolved.startsWith('.') ? resolveSpec(absPath, resolved) : resolved;
    const id = ids.get(target);
    if (id === undefined) throw new Error('未分配编号：' + target);
    return '__req(' + id + ')';
  });
  const ready = rec.exports
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => "__ready(" + JSON.stringify(e.name) + ", typeof " + e.local + " !== 'undefined' ? " + e.local + ' : undefined);')
    .join('\n  ');
  code = 'try {\n  ' + code.split('\n').join('\n  ') + '\n  ' + ready + '\n} finally { __end(); }';
  return code;
}

function collect(absPath) {
  if (modules.has(absPath)) return;
  modules.set(absPath, { code: '', deps: [], exports: [] });
  const rec = parse(absPath);
  modules.set(absPath, rec);
  for (const d of rec.deps) collect(d);
}

const entry = join(ROOT, 'src/ui/main.js');
collect(entry);

// 统一编号：依赖后序（被依赖的先初始化）
const order = [];
const ids = new Map();
const visiting = new Set();
function visit(p) {
  if (ids.has(p) || visiting.has(p)) return;
  visiting.add(p);
  for (const d of modules.get(p).deps) visit(d);
  visiting.delete(p);
  ids.set(p, order.length);
  order.push(p);
}
visit(entry);

const chunks = order.map((p) => {
  const rel = relative(ROOT, p).split('\\').join('/');
  return '// ---- [' + ids.get(p) + '] ' + rel + ' ----\nfunction mod_' + ids.get(p) + '(__exports, __req, __ready, __end) {\n' + emit(p, ids) + '\n}\n';
});
const bundle = RUNTIME(chunks, order.length, ids.get(entry));

const css = readFileSync(join(ROOT, 'src/ui/style.css'), 'utf8');
let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
// 用函数替换，避免 $' / $$ 等特殊替换模式污染输出
html = html.replace('<link rel="stylesheet" href="./src/ui/style.css" />', () => '<style>\n' + css + '\n</style>');
html = html.replace('<script type="module" src="./src/ui/main.js"></script>', () => '<script>\n' + bundle + '\n</script>');
html = html.replace('<title>POE-like · 魂火远征</title>', () => '<title>POE-like · 魂火远征（单文件版）</title>');
if (!html.includes('</body>') || !html.includes('<script>\n(function(){')) throw new Error('HTML 注入失败：请检查 index.html 模板占位符');

mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist/game.js'), bundle, 'utf8');
writeFileSync(join(ROOT, 'index-standalone.html'), html, 'utf8');
console.log('[build] 模块 ' + order.length + ' 个，bundle ' + Math.round(bundle.length / 1024) + ' KB，单文件 ' + Math.round(html.length / 1024) + ' KB');
console.log('[build] 输出：index-standalone.html（双击即可玩）');
