// Локальный просмотр: сборка + веб-сервер + автопересборка при изменениях в lakes/, site/, map/
// Запуск: npm run dev  →  http://localhost:8080

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

let building = false, pending = false;
async function rebuild(reason) {
  if (building) { pending = true; return; }
  building = true;
  if (reason) console.log(`\n↻ Изменение: ${reason}`);
  try { await build(); } catch (e) { console.error('✖ ' + e.message); }
  building = false;
  if (pending) { pending = false; rebuild('накопленные изменения'); }
}

await rebuild();

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(DIST, url);
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`\nСайт: http://localhost:${PORT}  (Ctrl+C — остановить)`));

let timer = null;
for (const dir of ['lakes', 'site', 'map']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  fs.watch(abs, { recursive: true }, (_, name) => {
    if (name && name.includes('.cache')) return;
    clearTimeout(timer);
    timer = setTimeout(() => rebuild(`${dir}/${name || ''}`), 600);
  });
}
