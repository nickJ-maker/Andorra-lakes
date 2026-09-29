// Разовая подготовка растровой подложки рельефа в стиле старой туристической карты.
// Источник: Copernicus DEM GLO-30 (© DLR e.V. 2010–2014 и © Airbus Defence and Space GmbH 2014–2018,
// предоставлено в рамках программы COPERNICUS Европейским союзом и ЕКА).
// Запуск: npm run map:relief  →  map/relief.webp + map/relief.json
//
// Тайл DEM скачивается один раз в map/.cache:
//   https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N42_00_E001_00_DEM/Copernicus_DSM_COG_10_N42_00_E001_00_DEM.tif

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFile } from 'geotiff';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TILE = 'Copernicus_DSM_COG_10_N42_00_E001_00_DEM';
const SRC = path.join(ROOT, 'map/.cache', `${TILE}.tif`);

// Область подложки (п. 6.3 ТЗ) и размер растра
const EXTENT = { w: 1.20, e: 2.00, s: 42.30, n: 42.85 };
const OUT_W = Number(process.env.RELIEF_WIDTH || 2400);
const LAT0 = (EXTENT.s + EXTENT.n) / 2;
const COS0 = Math.cos((LAT0 * Math.PI) / 180);
const OUT_H = Math.round((OUT_W * (EXTENT.n - EXTENT.s)) / ((EXTENT.e - EXTENT.w) * COS0));

if (!fs.existsSync(SRC)) {
  const url = `https://copernicus-dem-30m.s3.amazonaws.com/${TILE}/${TILE}.tif`;
  console.log(`Скачивание DEM: ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(SRC), { recursive: true });
  fs.writeFileSync(SRC, Buffer.from(await r.arrayBuffer()));
}

console.log(`Чтение DEM…`);
const tiff = await fromFile(SRC);
const image = await tiff.getImage();
const [bx0, by0, bx1, by1] = image.getBoundingBox();
const iw = image.getWidth(), ih = image.getHeight();
const toPx = (lon) => ((lon - bx0) / (bx1 - bx0)) * iw;
const toPy = (lat) => ((by1 - lat) / (by1 - by0)) * ih;
const win = [
  Math.max(0, Math.floor(toPx(EXTENT.w)) - 2), Math.max(0, Math.floor(toPy(EXTENT.n)) - 2),
  Math.min(iw, Math.ceil(toPx(EXTENT.e)) + 2), Math.min(ih, Math.ceil(toPy(EXTENT.s)) + 2),
];
const [dem] = await image.readRasters({ window: win });
const dw = win[2] - win[0], dh = win[3] - win[1];

// Билинейная выборка высоты
function sample(lon, lat) {
  const x = Math.min(dw - 1.001, Math.max(0, toPx(lon) - win[0] - 0.5));
  const y = Math.min(dh - 1.001, Math.max(0, toPy(lat) - win[1] - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i = y0 * dw + x0;
  return (dem[i] * (1 - fx) + dem[i + 1] * fx) * (1 - fy) + (dem[i + dw] * (1 - fx) + dem[i + dw + 1] * fx) * fy;
}

console.log(`Пересчёт в сетку ${OUT_W}×${OUT_H}…`);
let z = new Float32Array(OUT_W * OUT_H);
for (let j = 0; j < OUT_H; j++) {
  const lat = EXTENT.n - ((j + 0.5) / OUT_H) * (EXTENT.n - EXTENT.s);
  for (let i = 0; i < OUT_W; i++) {
    const lon = EXTENT.w + ((i + 0.5) / OUT_W) * (EXTENT.e - EXTENT.w);
    const v = sample(lon, lat);
    z[j * OUT_W + i] = v > -100 ? v : 0;
  }
}

// Лёгкое сглаживание (3×3) — мягче отмывка, меньше «шума» DEM
function blur(src) {
  const dst = new Float32Array(src.length);
  for (let j = 0; j < OUT_H; j++) for (let i = 0; i < OUT_W; i++) {
    let s = 0, n = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= OUT_W || y >= OUT_H) continue;
      s += src[y * OUT_W + x]; n++;
    }
    dst[j * OUT_W + i] = s / n;
  }
  return dst;
}
const zs = blur(z);

// Шаг сетки в метрах
const DX = ((EXTENT.e - EXTENT.w) / OUT_W) * 111320 * COS0;
const DY = ((EXTENT.n - EXTENT.s) / OUT_H) * 110574;

// Послойная окраска: долины — приглушённая зелень, склоны — беж и сепия, гребни — светлый камень
const TINT = [
  [0, [190, 194, 148]], [900, [194, 196, 149]], [1300, [207, 205, 158]], [1700, [224, 214, 170]],
  [2100, [226, 206, 162]], [2500, [212, 184, 140]], [2850, [214, 194, 160]], [3200, [236, 228, 208]],
];
function tint(e) {
  if (e <= TINT[0][0]) return TINT[0][1];
  for (let k = 1; k < TINT.length; k++) {
    if (e <= TINT[k][0]) {
      const [e0, c0] = TINT[k - 1], [e1, c1] = TINT[k];
      const t = (e - e0) / (e1 - e0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return TINT[TINT.length - 1][1];
}

const SHADOW = [86, 58, 36];
const LIGHT = [252, 246, 228];
const CONTOUR = [120, 78, 44];
const LIGHTS = [ // [азимут, высота, вес] — многонаправленная отмывка, основной свет с северо-запада
  [315, 45, 0.6], [270, 45, 0.2], [0, 45, 0.2],
];
const lights = LIGHTS.map(([az, alt, w]) => {
  const a = ((360 - az + 90) * Math.PI) / 180, h = (alt * Math.PI) / 180;
  return { lx: Math.cos(h) * Math.cos(a), ly: Math.cos(h) * Math.sin(a), lz: Math.sin(h), w };
});
const FLAT = Math.sin(Math.PI / 4);

console.log('Отмывка и окраска…');
const rgb = Buffer.alloc(OUT_W * OUT_H * 3);
const at = (i, j) => zs[Math.min(OUT_H - 1, Math.max(0, j)) * OUT_W + Math.min(OUT_W - 1, Math.max(0, i))];
const EXAG = 1.6; // вертикальное преувеличение для выразительности
for (let j = 0; j < OUT_H; j++) {
  for (let i = 0; i < OUT_W; i++) {
    const dzdx = (at(i + 1, j) - at(i - 1, j)) / (2 * DX);
    const dzdy = (at(i, j - 1) - at(i, j + 1)) / (2 * DY); // ось y на север
    const nx = -dzdx * EXAG, ny = -dzdy * EXAG, nz = 1;
    const nl = Math.hypot(nx, ny, nz);
    let s = 0;
    for (const L of lights) s += L.w * Math.max(0, (nx * L.lx + ny * L.ly + nz * L.lz) / nl);
    const f = s / FLAT;

    const e = zs[j * OUT_W + i];
    let c = tint(e);
    if (f < 1) { const t = Math.min(1, (1 - f) * 0.75); c = c.map((v, k) => v + (SHADOW[k] - v) * t); }
    else { const t = Math.min(1, (f - 1) * 0.9); c = c.map((v, k) => v + (LIGHT[k] - v) * t); }

    // Горизонтали через 200 м (утолщённые — через 1000 м), со сглаживанием по градиенту
    const gpx = Math.hypot(dzdx * DX, dzdy * DY) + 1e-6; // м на пиксель
    const step = 200;
    const d = Math.abs(((e % step) + step) % step - step / 2);
    const dist = (step / 2 - d) / gpx; // расстояние до горизонтали в пикселях
    const idx = Math.abs(Math.round(e / step) * step) % 1000 === 0;
    const width = idx ? 0.9 : 0.55;
    const alpha = Math.max(0, Math.min(1, width + 0.5 - dist)) * (idx ? 0.45 : 0.22) * Math.min(1, gpx / 6);
    if (alpha > 0) c = c.map((v, k) => v + (CONTOUR[k] - v) * alpha);

    const o = (j * OUT_W + i) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
}

const outImg = path.join(ROOT, 'map/relief.webp');
await sharp(rgb, { raw: { width: OUT_W, height: OUT_H, channels: 3 } })
  .webp({ quality: Number(process.env.RELIEF_Q || 62), effort: 6, smartSubsample: true })
  .toFile(outImg);

// Высоты для справки/отладки не сохраняем — только параметры проекции
const meta = { extent: EXTENT, width: OUT_W, height: OUT_H, lat0: LAT0, projection: 'equirectangular (cos lat0)' };
fs.writeFileSync(path.join(ROOT, 'map/relief.json'), JSON.stringify(meta, null, 2));
console.log(`Готово: map/relief.webp ${OUT_W}×${OUT_H}, ${(fs.statSync(outImg).size / 1024).toFixed(0)} КБ`);
