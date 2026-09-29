// Разовая подготовка геоданных карты из OpenStreetMap (через Overpass API).
// Запуск: npm run map:data  →  map/data/geo.json
// Сырые ответы кэшируются в map/.cache/osm-*.json (повторный запуск не ходит в сеть).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = path.join(ROOT, 'map/.cache');
const OUT = path.join(ROOT, 'map/data/geo.json');

// Область данных с запасом относительно подложки (42.30–42.85 с. ш., 1.20–2.00 в. д.)
const BBOX = { s: 42.25, w: 1.10, n: 42.90, e: 2.10 };
const B = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;

const REL = { AD: 9407 };

const QUERIES = {
  andorra: `rel(${REL.AD});out geom;`,
  // Все участки госграниц в области; сторона определяется геометрически (см. ниже)
  border: `way[boundary=administrative][admin_level=2](${B});out geom;`,
  rivers: `way[waterway=river](${B});out geom;`,
  roads: `(way[highway=motorway](${B});way[highway=trunk](${B});way[highway=primary](${B}););out geom;`,
  roads2: `way[highway=secondary](${B});out geom;`,
  places: `(node[place=city](${B});node[place=town](${B});node[place=village](${B}););out;`,
  peaks: `node[natural=peak][ele](${B});out;`,
  lakes: `(way[natural=water](${B});rel[natural=water](${B}););out geom;`,
};

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(name, body) {
  const file = path.join(CACHE, `osm-${name}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const q = `[out:json][timeout:180];${body}`;
  let lastErr;
  for (const url of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ozera-andorry-map-prep/1.0' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(90_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        fs.writeFileSync(file, JSON.stringify(json));
        console.log(`  ${name}: ${json.elements.length} объектов`);
        return json;
      } catch (e) {
        lastErr = e;
        console.warn(`  ${name}: ${url} — ${e.message}, повтор…`);
        await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// ---------- геометрия ----------

const R5 = (v) => Math.round(v * 1e5) / 1e5;
const toLine = (geom) => geom.map((p) => [R5(p.lon), R5(p.lat)]);
const key = (p) => `${p[0]},${p[1]}`;

// Склейка отрезков в цепочки по общим концам
function stitch(lines) {
  const pool = lines.map((l) => l.slice());
  const out = [];
  while (pool.length) {
    let chain = pool.pop();
    let grown = true;
    while (grown) {
      grown = false;
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i];
        const a0 = key(chain[0]), a1 = key(chain[chain.length - 1]);
        const b0 = key(l[0]), b1 = key(l[l.length - 1]);
        if (a1 === b0) chain = chain.concat(l.slice(1));
        else if (a1 === b1) chain = chain.concat(l.slice(0, -1).reverse());
        else if (a0 === b1) chain = l.concat(chain.slice(1));
        else if (a0 === b0) chain = l.slice(1).reverse().concat(chain);
        else continue;
        pool.splice(i, 1);
        grown = true;
        break;
      }
    }
    out.push(chain);
  }
  return out;
}

// Упрощение Дугласа — Пекера (в градусах, с поправкой долготы на широту)
const COS = Math.cos((42.57 * Math.PI) / 180);
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = [pts[a][0] * COS, pts[a][1]];
    const [bx, by] = [pts[b][0] * COS, pts[b][1]];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-18;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * COS, py = pts[i][1];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * COS - ring[i][0] * COS) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(a / 2); // градусы² (≈ 1.23e4 км² на градус²)
}

const lineLen = (l) => l.reduce((s, p, i) => (i ? s + Math.hypot((p[0] - l[i - 1][0]) * COS, p[1] - l[i - 1][1]) : 0), 0);

// ---------- основная часть ----------

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

console.log('Загрузка данных OpenStreetMap…');
const raw = {};
for (const [name, q] of Object.entries(QUERIES)) raw[name] = await overpass(name, q);

const TOL = 0.00025; // ≈ 25 м

// Андорра — внешний контур
const adRel = raw.andorra.elements.find((e) => e.type === 'relation');
const adRings = stitch(adRel.members.filter((m) => m.type === 'way' && m.role === 'outer').map((m) => toLine(m.geometry)));
const andorra = adRings.sort((a, b) => ringArea(b) - ringArea(a))[0];
const isClosed = (l) => key(l[0]) === key(l[l.length - 1]);

// Участки госграниц: входящие в отношение «Андорра» — её граница, остальные — Франция—Испания
const adWayIds = new Set(adRel.members.filter((m) => m.type === 'way').map((m) => m.ref));
const borderWays = raw.border.elements.filter((e) => e.type === 'way' && e.geometry);
const frEs = stitch(borderWays.filter((e) => !adWayIds.has(e.id)).map((e) => toLine(e.geometry)));

// Тройные точки (FR/ES/AD) — концы франко-испанской границы, лежащие на контуре Андорры.
// Они делят контур Андорры на северную дугу (с Францией) и южную (с Испанией).
const ring = andorra.slice(0, -1);
const adIndex = new Map(ring.map((p, i) => [key(p), i]));
const tri = [...new Set(frEs.filter((l) => !isClosed(l)).flatMap((l) => [l[0], l[l.length - 1]])
  .map((p) => adIndex.get(key(p))).filter((i) => i !== undefined))].sort((a, b) => a - b);
if (tri.length !== 2) throw new Error(`Ожидалось 2 тройные точки на границе Андорры, найдено: ${tri.length}`);
const arcA = ring.slice(tri[0], tri[1] + 1);
const arcB = [...ring.slice(tri[1]), ...ring.slice(0, tri[0] + 1)];
const meanLat = (l) => l.reduce((s, p) => s + p[1], 0) / l.length;
const [frAdArc, esAdArc] = meanLat(arcA) > meanLat(arcB) ? [arcA, arcB] : [arcB, arcA];
const frAd = [frAdArc];
const esAd = [esAdArc];

// Граница Франции (с юга) в пределах области: Франция—Испания + Франция—Андорра одной цепочкой.
// Замкнутые кольца франко-испанской границы — эксклав Льивия (Испания).
const exclavesES = frEs.filter(isClosed);
const frSouth = stitch([...frEs.filter((l) => !isClosed(l)), ...frAd]).sort((a, b) => lineLen(b) - lineLen(a))[0];
if (frSouth[0][0] > frSouth[frSouth.length - 1][0]) frSouth.reverse();
// Полигон «Франция в пределах области»: южная граница + замыкание по северу
const francePoly = [...frSouth, [frSouth[frSouth.length - 1][0], 44], [frSouth[0][0], 44], frSouth[0]];

// Реки: склейка по имени
const riversByName = new Map();
for (const e of raw.rivers.elements) {
  if (e.type !== 'way') continue;
  const n = e.tags?.name || '';
  if (!riversByName.has(n)) riversByName.set(n, []);
  riversByName.get(n).push(toLine(e.geometry));
}
const rivers = [];
for (const [name, ls] of riversByName) for (const l of stitch(ls)) rivers.push({ name, coords: simplify(l, TOL) });

// Дороги: склейка по классу и номеру
const ROAD_CLASS = { motorway: 1, trunk: 1, primary: 2, secondary: 3 };
const roadsBy = new Map();
for (const e of [...raw.roads.elements, ...raw.roads2.elements]) {
  if (e.type !== 'way') continue;
  const cls = ROAD_CLASS[e.tags.highway];
  const k = `${cls}|${e.tags.ref || e.tags.name || e.id}`;
  if (!roadsBy.has(k)) roadsBy.set(k, []);
  roadsBy.get(k).push(toLine(e.geometry));
}
const roads = [];
for (const [k, ls] of roadsBy) {
  const [cls, ref] = k.split('|');
  for (const l of stitch(ls)) {
    const s = simplify(l, TOL * 1.5);
    if (lineLen(s) > 0.004) roads.push({ cls: +cls, ref, coords: s });
  }
}

const places = raw.places.elements.map((e) => ({
  name: e.tags.name, name_ru: e.tags['name:ru'] || null, place: e.tags.place,
  pop: +(e.tags.population || 0), lon: R5(e.lon), lat: R5(e.lat),
}));

const peaks = raw.peaks.elements
  .map((e) => ({ name: e.tags.name || null, name_ru: e.tags['name:ru'] || null, ele: parseFloat(String(e.tags.ele).replace(',', '.')), lon: R5(e.lon), lat: R5(e.lat) }))
  .filter((p) => p.ele > 0)
  .sort((a, b) => b.ele - a.ele);

// Озёра: внешние контуры площадью от ~0.02 км²
const lakes = [];
for (const e of raw.lakes.elements) {
  const rings = e.type === 'way' ? [toLine(e.geometry)]
    : stitch((e.members || []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => toLine(m.geometry)));
  for (const r of rings) {
    if (r.length < 4 || !isClosed(r)) continue;
    const area = ringArea(r) * 1.23e4;
    if (area < 0.02) continue;
    lakes.push({ name: e.tags?.name || null, km2: Math.round(area * 1000) / 1000, coords: simplify(r, TOL * 0.4) });
  }
}

const geo = {
  source: '© OpenStreetMap contributors, ODbL',
  bbox: BBOX,
  andorra: simplify(andorra, TOL * 0.6),
  borders: {
    fr_es: frEs.map((l) => simplify(l, TOL * 0.6)),
    fr_ad: frAd.map((l) => simplify(l, TOL * 0.6)),
    es_ad: esAd.map((l) => simplify(l, TOL * 0.6)),
  },
  country: { france: simplify(francePoly, TOL), spainExclaves: exclavesES.map((l) => simplify(l, TOL)) },
  rivers, roads, places, peaks, lakes,
};

fs.writeFileSync(OUT, JSON.stringify(geo));
console.log(`Готово: ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} КБ)`);
console.log(`  Андорра: ${geo.andorra.length} точек; границы FR-ES ${frEs.length}, FR-AD ${frAd.length}, ES-AD ${esAd.length} цепочек; эксклавов: ${exclavesES.length}`);
console.log(`  реки: ${rivers.length}, дороги: ${roads.length}, нас. пункты: ${places.length}, вершины: ${peaks.length}, озёра: ${lakes.length}`);
