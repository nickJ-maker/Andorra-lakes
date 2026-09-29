// Удаление GPS-координат из оригиналов фото в lakes/ (запускается из publish.bat перед отправкой).
// Фото не пересжимаются: удаляются только метаданные с координатами, остальное (дата, ориентация) сохраняется.
// Запуск: npm run strip-gps

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';
import piexif from 'piexifjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAKES = path.join(ROOT, 'lakes');
const XMP_GPS = /exif:GPS(Latitude|Longitude)|GPSLatitude|GPSLongitude/;

// JPEG: сегменты APP1 с XMP, содержащие координаты, удаляются целиком
function dropJpegXmpGps(buf) {
  const parts = [buf.subarray(0, 2)];
  let i = 2, changed = false;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xda) break; // начало данных изображения
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    const isXmp = marker === 0xe1 && seg.subarray(4, 33).toString('latin1').startsWith('http://ns.adobe.com/xap/1.0/');
    if (isXmp && XMP_GPS.test(seg.toString('latin1'))) changed = true;
    else parts.push(seg);
    i += 2 + len;
  }
  if (!changed) return null;
  parts.push(buf.subarray(i));
  return Buffer.concat(parts);
}

function stripJpeg(buf) {
  let out = buf, changed = false;
  const bin = buf.toString('binary');
  const exif = (() => { try { return piexif.load(bin); } catch { return null; } })();
  if (exif && (Object.keys(exif.GPS || {}).length || exif['0th']?.[piexif.ImageIFD.GPSTag] !== undefined)) {
    exif.GPS = {};
    delete exif['0th'][piexif.ImageIFD.GPSTag];
    out = Buffer.from(piexif.insert(piexif.dump(exif), bin), 'binary');
    changed = true;
  }
  const noXmp = dropJpegXmpGps(out);
  if (noXmp) { out = noXmp; changed = true; }
  return changed ? out : null;
}

// PNG: удаляются чанки eXIf и текстовые чанки с XMP-координатами
function stripPng(buf) {
  const parts = [buf.subarray(0, 8)];
  let i = 8, changed = false;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const chunk = buf.subarray(i, i + 12 + len);
    const drop = type === 'eXIf' || (['iTXt', 'tEXt', 'zTXt'].includes(type) && XMP_GPS.test(chunk.toString('latin1')));
    if (drop) changed = true; else parts.push(chunk);
    i += 12 + len;
  }
  return changed ? Buffer.concat(parts) : null;
}

// WebP: удаляются чанки EXIF и XMP, флаги в заголовке VP8X сбрасываются
function stripWebp(buf) {
  if (buf.subarray(0, 4).toString() !== 'RIFF' || buf.subarray(8, 12).toString() !== 'WEBP') return null;
  const parts = [];
  let i = 12, changed = false;
  while (i + 8 <= buf.length) {
    const type = buf.subarray(i, i + 4).toString('latin1');
    const len = buf.readUInt32LE(i + 4);
    const chunk = Buffer.from(buf.subarray(i, i + 8 + len + (len & 1)));
    if (type === 'EXIF' || type === 'XMP ') changed = true;
    else {
      if (type === 'VP8X') chunk[8] &= ~(0x08 | 0x04); // флаги EXIF и XMP
      parts.push(chunk);
    }
    i += 8 + len + (len & 1);
  }
  if (!changed) return null;
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8);
  return Buffer.concat([head, body]);
}

const STRIP = { '.jpg': stripJpeg, '.jpeg': stripJpeg, '.png': stripPng, '.webp': stripWebp };

// WebP exifr не читает — любой блок EXIF/XMP в WebP считается потенциально содержащим координаты
function webpHasMeta(buf) {
  if (buf.subarray(0, 4).toString() !== 'RIFF' || buf.subarray(8, 12).toString() !== 'WEBP') return false;
  for (let i = 12; i + 8 <= buf.length; ) {
    const type = buf.subarray(i, i + 4).toString('latin1');
    if (type === 'EXIF' || type === 'XMP ') return true;
    const len = buf.readUInt32LE(i + 4);
    i += 8 + len + (len & 1);
  }
  return false;
}

async function hasGps(file, buf) {
  if (path.extname(file).toLowerCase() === '.webp') return webpHasMeta(buf);
  const g = await exifr.gps(file).catch(() => null);
  return !!(g && (g.latitude || g.longitude)) || XMP_GPS.test(buf.toString('latin1'));
}

let checked = 0, cleaned = 0;
const problems = [];
if (fs.existsSync(LAKES)) {
  for (const dir of fs.readdirSync(LAKES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(LAKES, dir.name))) {
      const file = path.join(LAKES, dir.name, f);
      const ext = path.extname(f).toLowerCase();
      if (/\.hei[cf]$/.test(ext)) { problems.push(`${dir.name}/${f}: формат HEIC — GPS не удалить, сохраните фото как JPEG`); continue; }
      const strip = STRIP[ext];
      if (!strip) continue;
      checked++;
      const buf = fs.readFileSync(file);
      if (!(await hasGps(file, buf))) continue;
      try {
        const out = strip(buf);
        if (!out) throw new Error('координаты не найдены в известных блоках метаданных');
        fs.writeFileSync(file, out);
        if (await hasGps(file, out)) throw new Error('после очистки координаты всё ещё читаются');
        cleaned++;
        console.log(`  GPS удалён: ${dir.name}/${f}`);
      } catch (e) {
        fs.writeFileSync(file, buf); // возвращаем исходный файл без изменений
        problems.push(`${dir.name}/${f}: ${e.message}`);
      }
    }
  }
}

console.log(`Проверено фото: ${checked}, очищено от GPS: ${cleaned}`);
if (problems.length) {
  console.log('\nНе удалось очистить:');
  for (const p of problems) console.log('  ✖ ' + p);
  process.exit(1);
}
