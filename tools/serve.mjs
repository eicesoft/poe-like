// Tiny parallel-safe dev server: static files + on-the-fly ESM→bundle transpile.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.env.PORT || 5178);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let esbuild = null;
async function getEsbuild() {
  if (esbuild) return esbuild;
  esbuild = await import('esbuild');
  return esbuild;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path === '') path = '/index.html';
    if (url.searchParams.get('bundle') === '1') {
      // Bundle the entry module with esbuild so older browsers work without import maps.
      const entry = normalize(join(ROOT, path.replace(/^\//, '')));
      const { build } = await getEsbuild();
      const out = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'iife',
        minify: false,
        target: 'es2020',
        logLevel: 'silent',
      });
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      res.end(out.outputFiles[0].text);
      return;
    }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404);
      return res.end('not found: ' + path);
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e && e.stack ? e.stack : e));
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  // Warm up esbuild so the first bundle request is fast.
  getEsbuild().catch(() => {});
  console.log(`[poe-like] dev server: http://127.0.0.1:${PORT}/`);
});