// Координаты из ссылок Google Maps: раскрытие коротких ссылок + кэш data/geocache.json (п. 5, шаг 3 ТЗ)

import fs from 'node:fs';
import path from 'node:path';

const num = '(-?\\d{1,3}\\.\\d+)';
const PATTERNS = [
  new RegExp(`!3d${num}!4d${num}`, 'g'), // точка места (точнее всего; берём последнее вхождение)
  new RegExp(`/(?:search|place)/${num},\\+?\\s*${num}`, 'g'),
  new RegExp(`[?&](?:q|query|destination|daddr)=${num},\\+?\\s*${num}`, 'g'),
  new RegExp(`[?&](?:ll|sll|center)=${num},\\+?\\s*${num}`, 'g'),
  new RegExp(`@${num},${num}`, 'g'), // центр экрана — наименее точно
];

export function coordsFromUrl(url) {
  let s = url;
  try { s = decodeURIComponent(url); } catch { /* оставляем как есть */ }
  for (const re of PATTERNS) {
    const all = [...s.matchAll(re)];
    if (all.length) {
      const m = all[all.length - 1];
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
  }
  return null;
}

async function resolve(url) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const direct = coordsFromUrl(current);
    if (direct) return direct;
    const r = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ozera-andorry-build)' },
      signal: AbortSignal.timeout(15000),
    });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { current = new URL(loc, current).href; continue; }
    // Страница без редиректа: ищем координаты в разметке
    const body = await r.text();
    const m = coordsFromUrl(body.slice(0, 200000));
    if (m) return m;
    break;
  }
  return null;
}

export class GeoCache {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    this.dirty = false;
  }

  async get(url) {
    if (!url) return null;
    const hit = this.data[url];
    if (hit) return { lat: hit.lat, lon: hit.lon };
    const direct = coordsFromUrl(url);
    const c = direct || (await resolve(url));
    if (c) {
      this.data[url] = { lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), resolved: new Date().toISOString().slice(0, 10) };
      this.dirty = true;
    }
    return c;
  }

  save() {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(this.data).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(this.file, JSON.stringify(sorted, null, 2) + '\n');
  }
}
