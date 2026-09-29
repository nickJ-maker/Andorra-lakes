// Сборка сайта «Озёра Андорры»: lakes/ → dist/  (п. 5 ТЗ)
// Запуск: npm run build

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLakes, komootId } from './lib/lakes.js';
import { GeoCache } from './lib/geocode.js';
import { processPhotos } from './lib/photos.js';
import { loadMap, countryOf, COUNTRIES, renderBaseSvg, buildLabels } from './lib/mapdata.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => path.join(ROOT, ...p);

export async function build({ quiet = false } = {}) {
  const t0 = Date.now();
  const warnings = [];
  const log = {
    warn: (lake, msg) => warnings.push({ lake, msg }),
    info: (msg) => { if (!quiet) console.log('  ' + msg); },
  };

  const DIST = P('dist');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(P('dist/photos'), { recursive: true });

  const map = loadMap(ROOT);
  const geocache = new GeoCache(P('data/geocache.json'));
  const found = scanLakes(P('lakes'), log);

  const lakes = [];
  for (const lake of found) {
    const warn = (msg) => log.warn(lake.name, msg);

    // Координаты: coords: → кэш → раскрытие ссылки «end point»
    let coords = lake.manualCoords, coordsSource = coords ? 'manual' : null;
    if (!coords && lake.end) {
      try {
        coords = await geocache.get(lake.end);
        if (coords) coordsSource = 'end point';
      } catch (e) { warn(`не удалось раскрыть ссылку end point (${e.message})`); }
    }
    if (!coords) warn('нет координат — озеро будет в списке с пометкой «нет на карте». Добавьте в txt строку вида «coords: 42.6034, 1.5712»');

    let start = null;
    if (lake.start) {
      try { start = await geocache.get(lake.start); } catch { /* используется только на будущее */ }
    }

    let xy = null;
    if (coords) {
      if (map.inside(coords.lon, coords.lat)) xy = map.project(coords.lon, coords.lat).map((v) => Math.round(v * 10) / 10);
      else warn(`координаты ${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)} вне области карты — точка не нарисована (нужно расширить подложку, п. 6.3 ТЗ)`);
    }
    const country = coords ? countryOf(map, coords.lon, coords.lat) : null;

    const kid = komootId(lake.route);
    if (lake.route && !kid) warn(`ссылка route не похожа на маршрут Komoot (${lake.route}) — встроенная карта не будет показана`);
    if (!lake.route) warn('нет ссылки route (Komoot)');
    if (!lake.start) warn('нет ссылки start point');
    if (!lake.end) warn('нет ссылки end point');

    const photos = await processPhotos(lake, { cacheDir: P('.cache/photos'), outDir: P('dist/photos'), log });
    if (!photos.length) warn('нет фотографий — вместо галереи будет заглушка');
    let cover = 0;
    if (lake.cover) {
      const i = photos.findIndex((p) => p.name.toLowerCase() === lake.cover.toLowerCase());
      if (i >= 0) cover = i; else warn(`cover: фото «${lake.cover}» не найдено — обложкой будет первое фото`);
    }

    lakes.push({
      name: lake.name,
      slug: lake.slug,
      country,
      countryName: country ? COUNTRIES[country].name : null,
      lat: coords ? +coords.lat.toFixed(6) : null,
      lon: coords ? +coords.lon.toFixed(6) : null,
      coordsSource,
      start: start ? { lat: +start.lat.toFixed(6), lon: +start.lon.toFixed(6) } : null,
      xy,
      label: lake.label,
      links: { start: lake.start, end: lake.end, route: lake.route },
      komoot: kid ? { id: kid, embed: `https://www.komoot.com/tour/${kid}/embed?profile=1` } : null,
      cover: photos.length ? cover : null,
      photos: photos.map(({ thumb, full, fullJpg, w, h }) => ({ thumb, full, fullJpg, w, h })),
    });
  }
  geocache.save();

  if (!lakes.length) {
    printReport({ lakes, warnings, t0 });
    throw new Error('В папке lakes/ не найдено ни одного озера с файлом «points on the map.txt» — сборка остановлена.');
  }

  // Область карты по умолчанию: Андорра с приграничьем, расширенная до всех озёр
  const view = map.config.defaultView;
  const pts = [[view.w, view.s], [view.e, view.n], ...lakes.filter((l) => l.xy).map((l) => [l.lon, l.lat])];
  const pad = 0.03;
  const [vx0, vy0] = map.project(Math.min(...pts.map((p) => p[0])) - pad, Math.max(...pts.map((p) => p[1])) + pad);
  const [vx1, vy1] = map.project(Math.max(...pts.map((p) => p[0])) + pad, Math.min(...pts.map((p) => p[1])) - pad);
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));

  const data = {
    title: 'Озёра Андорры',
    built: new Date().toISOString(),
    map: {
      width: map.W, height: map.H,
      metersPerUnit: map.metersPerUnit,
      view: [clamp(vx0, map.W), clamp(vy0, map.H), clamp(vx1, map.W), clamp(vy1, map.H)],
      labels: buildLabels(map, log),
    },
    lakes,
  };

  // Ассеты
  fs.copyFileSync(P('map/relief.webp'), P('dist/relief.webp'));
  for (const f of fs.readdirSync(P('site'))) {
    if (f === 'index.html') continue;
    fs.cpSync(P('site', f), P('dist', f), { recursive: true });
  }
  fs.writeFileSync(P('dist/lakes.json'), JSON.stringify(data));

  // Страница: векторный слой карты и данные встраиваются в HTML (один запрос вместо трёх)
  const baseSvg = renderBaseSvg(map);
  const ogImage = lakes.find((l) => l.photos.length)?.photos[lakes.find((l) => l.photos.length).cover]?.fullJpg || 'og.jpg';
  // Абсолютный адрес сайта (для og:image): SITE_URL или адрес GitHub Pages по имени репозитория
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  const siteUrl = process.env.SITE_URL || (owner && repo ? `https://${owner.toLowerCase()}.github.io/${repo}/` : '');
  const html = fs.readFileSync(P('site/index.html'), 'utf8')
    .replace('{{SITE_URL}}', siteUrl)
    .replace('<!--MAP_GEO-->', baseSvg)
    .replaceAll('{{MAP_W}}', String(map.W))
    .replaceAll('{{MAP_H}}', String(map.H))
    .replace('{{OG_IMAGE}}', fs.existsSync(P('site/og.jpg')) ? 'og.jpg' : ogImage)
    .replace('{{BUILD}}', Date.now().toString(36))
    .replace('<!--DATA-->', `<script>window.LAKES_DATA=${JSON.stringify(data).replace(/</g, '\\u003c')};</script>`);
  fs.writeFileSync(P('dist/index.html'), html);
  fs.writeFileSync(P('dist/.nojekyll'), '');

  printReport({ lakes, warnings, t0, quiet });
  return { lakes, warnings };
}

function printReport({ lakes, warnings, t0, quiet }) {
  const onMap = lakes.filter((l) => l.xy).length;
  console.log(`\nОзёр найдено: ${lakes.length} (на карте: ${onMap}), фото: ${lakes.reduce((s, l) => s + l.photos.length, 0)}, за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  if (warnings.length) {
    console.log(`\nПредупреждения (${warnings.length}):`);
    const by = new Map();
    for (const w of warnings) { if (!by.has(w.lake)) by.set(w.lake, []); by.get(w.lake).push(w.msg); }
    for (const [lake, msgs] of by) {
      console.log(`  ⚠ ${lake}`);
      for (const m of msgs) console.log(`      – ${m}`);
    }
    // Аннотации для GitHub Actions — видны в интерфейсе запуска
    if (process.env.GITHUB_ACTIONS) for (const w of warnings) console.log(`::warning title=${w.lake}::${w.msg}`);
  } else if (!quiet) console.log('Предупреждений нет.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((e) => { console.error('\n✖ ' + e.message); process.exit(1); });
}
