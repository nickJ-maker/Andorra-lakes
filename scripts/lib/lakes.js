// Сканирование папки lakes/ и разбор файла «points on the map.txt» (п. 4 ТЗ)

import fs from 'node:fs';
import path from 'node:path';

export const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
const TXT_NAME = 'points on the map.txt';
const KNOWN_KEYS = ['start point', 'end point', 'route', 'coords', 'label', 'cover'];

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

// «Estany de l'Isla» → «estany-de-lisla»
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`´ʼ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'lake';
}

// UTF-8 (с BOM и без) или Windows-1251
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

export function parsePoints(text, warn) {
  const data = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) { warn(`непонятная строка «${line}» — пропущена`); continue; }
    const k = line.slice(0, i).trim().toLowerCase().replace(/\s+/g, ' ');
    const v = line.slice(i + 1).trim();
    if (!KNOWN_KEYS.includes(k)) { warn(`неизвестный ключ «${k}» — пропущен`); continue; }
    data[k] = v;
  }
  return data;
}

export function parseCoords(v) {
  const m = String(v || '').match(/(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1].replace(',', '.')), lon = parseFloat(m[2].replace(',', '.'));
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat, lon };
}

export function komootId(url) {
  const m = String(url || '').match(/komoot\.[a-z.]+\/(?:[a-z-]+\/)?tour\/(\d+)/i);
  return m ? m[1] : null;
}

export function scanLakes(lakesDir, log) {
  if (!fs.existsSync(lakesDir)) return [];
  const lakes = [];
  const dirs = fs.readdirSync(lakesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'ru'));

  const slugs = new Set();
  for (const name of dirs) {
    const dir = path.join(lakesDir, name);
    const warn = (msg) => log.warn(name, msg);
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name);
    const txt = files.find((f) => f.toLowerCase() === TXT_NAME);
    if (!txt) { warn(`нет файла «${TXT_NAME}» — озеро пропущено`); continue; }

    const info = parsePoints(decodeText(fs.readFileSync(path.join(dir, txt))), warn);
    let slug = slugify(name);
    for (let n = 2; slugs.has(slug); n++) slug = `${slugify(name)}-${n}`;
    slugs.add(slug);

    const photos = files.filter((f) => PHOTO_EXT.includes(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
    const label = (info.label || '').toLowerCase();
    if (info.label && !['left', 'right', 'top', 'bottom'].includes(label)) warn(`label: «${info.label}» — допустимо left / right / top / bottom`);
    let coords = null;
    if (info.coords) {
      coords = parseCoords(info.coords);
      if (!coords) warn(`coords: не удалось разобрать «${info.coords}» (нужно, например, «42.6034, 1.5712»)`);
    }

    lakes.push({
      name, slug, dir, photos,
      start: info['start point'] || null,
      end: info['end point'] || null,
      route: info.route || null,
      manualCoords: coords,
      label: ['left', 'right', 'top', 'bottom'].includes(label) ? label : null,
      cover: info.cover || null,
    });
  }
  return lakes;
}
