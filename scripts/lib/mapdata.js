// Карта: проекция, определение страны, векторный слой SVG и подписи (п. 6.2–6.3 ТЗ)

import fs from 'node:fs';
import path from 'node:path';

export function loadMap(root) {
  const relief = JSON.parse(fs.readFileSync(path.join(root, 'map/relief.json'), 'utf8'));
  const geo = JSON.parse(fs.readFileSync(path.join(root, 'map/data/geo.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'map/config.json'), 'utf8'));
  const { extent: E, width: W, height: H } = relief;

  const project = (lon, lat) => [((lon - E.w) / (E.e - E.w)) * W, ((E.n - lat) / (E.n - E.s)) * H];
  const inside = (lon, lat) => lon >= E.w && lon <= E.e && lat >= E.s && lat <= E.n;
  // Метров в одной единице карты (по горизонтали на средней широте)
  const metersPerUnit = ((E.e - E.w) / W) * 111320 * Math.cos((relief.lat0 * Math.PI) / 180);

  return { relief, geo, config, project, inside, metersPerUnit, W, H };
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const COUNTRIES = {
  AD: { name: 'Андорра', flag: '🇦🇩' },
  FR: { name: 'Франция', flag: '🇫🇷' },
  ES: { name: 'Испания', flag: '🇪🇸' },
};

// Страна по координатам: Андорра → эксклавы Испании (Льивия) → Франция (к северу от границы) → Испания
export function countryOf(map, lon, lat) {
  const { geo } = map;
  if (lon < geo.bbox.w || lon > geo.bbox.e || lat < geo.bbox.s || lat > geo.bbox.n) return null;
  if (pointInRing(lon, lat, geo.andorra)) return 'AD';
  if (geo.country.spainExclaves.some((r) => pointInRing(lon, lat, r))) return 'ES';
  if (pointInRing(lon, lat, geo.country.france)) return 'FR';
  return 'ES';
}

const f1 = (v) => Math.round(v * 10) / 10;
function pathD(map, coords, close = false) {
  let d = '';
  let prev = null;
  for (const [lon, lat] of coords) {
    const [x, y] = map.project(lon, lat).map(f1);
    if (prev && prev[0] === x && prev[1] === y) continue;
    d += (d ? 'L' : 'M') + x + ' ' + y;
    prev = [x, y];
  }
  return d + (close ? 'Z' : '');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// Векторный слой: всё, что масштабируется вместе с картой (подписи — отдельно, в интерфейсе)
export function renderBaseSvg(map) {
  const { geo, config, W, H } = map;
  const cfg = config.style || {};
  const parts = [];

  // Приглушение территорий соседних стран: прямоугольник с «дыркой» Андорры
  parts.push(`<path class="m-neighbours" fill-rule="evenodd" d="M0 0H${W}V${H}H0Z${pathD(map, geo.andorra, true)}"/>`);

  // Озёра (контуры из OSM)
  const lakeD = geo.lakes.map((l) => pathD(map, l.coords, true)).join('');
  parts.push(`<path class="m-water" d="${lakeD}"/>`);

  // Реки: крупные — толще
  const major = new Set(cfg.majorRivers || []);
  const rivers = { major: [], minor: [] };
  for (const r of geo.rivers) (major.has(r.name) ? rivers.major : rivers.minor).push(pathD(map, r.coords));
  parts.push(`<path class="m-river m-river-minor" d="${rivers.minor.join('')}"/>`);
  parts.push(`<path class="m-river m-river-major" d="${rivers.major.join('')}"/>`);

  // Дороги: класс 1 — магистрали, 2 — основные, 3 — второстепенные
  for (const cls of [3, 2, 1]) {
    const d = geo.roads.filter((r) => r.cls === cls).map((r) => pathD(map, r.coords)).join('');
    if (!d) continue;
    if (cls < 3) parts.push(`<path class="m-road-casing m-road-casing-${cls}" d="${d}"/>`);
    parts.push(`<path class="m-road m-road-${cls}" d="${d}"/>`);
  }

  // Границы: лента вдоль границы Андорры + пунктир госграниц
  const adBorder = pathD(map, geo.andorra, true);
  const frEs = geo.borders.fr_es.map((l) => pathD(map, l)).join('');
  parts.push(`<path class="m-border-ribbon" d="${adBorder}"/>`);
  parts.push(`<path class="m-border" d="${adBorder}${frEs}"/>`);

  return `<g class="m-geo">\n${parts.join('\n')}\n</g>`;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, "'");

// Подписи карты (рисуются в интерфейсе с постоянным размером шрифта и скрытием пересечений)
export function buildLabels(map, log) {
  const { geo, config } = map;
  const labels = [];
  const add = (lon, lat, extra) => {
    if (!map.inside(lon, lat)) return;
    const [x, y] = map.project(lon, lat);
    labels.push({ x: f1(x), y: f1(y), ...extra });
  };

  for (const c of config.countries || []) add(c.lon, c.lat, { type: 'country', text: c.label, pr: 100 });

  for (const p of config.places || []) {
    const cand = geo.places.filter((g) => norm(g.name) === norm(p.osm));
    if (!cand.length) { log.info(`карта: населённый пункт «${p.osm}» не найден в данных OSM`); continue; }
    const g = cand.sort((a, b) => b.pop - a.pop)[0];
    add(g.lon, g.lat, { type: 'place', text: p.label, rank: p.rank, pr: 90 - p.rank * 10 });
  }

  for (const p of config.peaks || []) {
    const cand = geo.peaks.filter((g) => g.name && norm(g.name).includes(norm(p.osm)));
    if (!cand.length) { log.info(`карта: вершина «${p.osm}» не найдена в данных OSM`); continue; }
    const g = cand.sort((a, b) => b.ele - a.ele)[0];
    add(g.lon, g.lat, { type: 'peak', text: p.label, ele: Math.round(g.ele), pr: 55 - (p.rank || 1) * 5 });
  }

  // Подпись реки: ближайшая к заданной точке вершина русла, поворот — по направлению русла
  for (const r of config.riverLabels || []) {
    const [px, py] = map.project(r.lon, r.lat);
    let best = null;
    for (const rv of geo.rivers) {
      if (!r.rivers.includes(rv.name)) continue;
      const pts = rv.coords.map(([lon, lat]) => map.project(lon, lat));
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - px, pts[i][1] - py);
        if (!best || d < best.d) best = { d, pts, i };
      }
    }
    if (!best) { log.info(`карта: река «${r.label}» не найдена в данных OSM`); continue; }
    const { pts, i } = best;
    const a = pts[Math.max(0, i - 3)], b = pts[Math.min(pts.length - 1, i + 3)];
    let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    labels.push({ type: 'river', text: r.label, x: f1(pts[i][0]), y: f1(pts[i][1]), angle: Math.round(angle), pr: 20 });
  }

  return labels.sort((a, b) => b.pr - a.pr);
}
