// Обработка фотографий (п. 5, шаг 6 ТЗ): автоповорот, миниатюры и полноразмерные копии,
// удаление EXIF/GPS, кэш уже обработанных файлов.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import exifr from 'exifr';

const VERSION = 1; // поменять, если изменились параметры ниже — кэш пересчитается
const SIZES = { thumb: 480, full: 2000 };

export async function processPhotos(lake, { cacheDir, outDir, log }) {
  const items = [];
  for (const file of lake.photos) {
    const name = path.basename(file);
    try {
      // Ключ кэша — по содержимому файла: на GitHub Actions дата изменения файлов при каждой выгрузке новая
      const id = crypto.createHash('sha1').update(`${VERSION}|${name}|`).update(fs.readFileSync(file)).digest('hex').slice(0, 12);
      const base = `${path.parse(name).name.replace(/[^\w.-]+/g, '_')}-${id}`;
      const cdir = path.join(cacheDir, lake.slug);
      const meta = path.join(cdir, `${base}.json`);
      const out = { thumb: `${base}-t.webp`, full: `${base}.webp`, fullJpg: `${base}.jpg` };

      let info;
      if (fs.existsSync(meta) && Object.values(out).every((f) => fs.existsSync(path.join(cdir, f)))) {
        info = JSON.parse(fs.readFileSync(meta, 'utf8'));
      } else {
        fs.mkdirSync(cdir, { recursive: true });
        let taken = null;
        try {
          const ex = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'] });
          taken = ex?.DateTimeOriginal || ex?.CreateDate || null;
        } catch { /* нет EXIF — не страшно */ }

        // .rotate() — автоповорот по EXIF; sharp по умолчанию не переносит метаданные (EXIF, GPS) в результат
        const img = sharp(file, { failOn: 'error' }).rotate();
        const full = img.clone().resize({ width: SIZES.full, height: SIZES.full, fit: 'inside', withoutEnlargement: true });
        const fullWebp = await full.clone().webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
        await fs.promises.writeFile(path.join(cdir, out.full), fullWebp.data);
        await full.clone().jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(cdir, out.fullJpg));
        await img.clone().resize({ width: SIZES.thumb, height: SIZES.thumb, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 72 }).toFile(path.join(cdir, out.thumb));

        info = { name, taken: taken ? new Date(taken).toISOString() : null, w: fullWebp.info.width, h: fullWebp.info.height };
        fs.writeFileSync(meta, JSON.stringify(info));
      }

      const dst = path.join(outDir, lake.slug);
      fs.mkdirSync(dst, { recursive: true });
      for (const f of Object.values(out)) fs.copyFileSync(path.join(cdir, f), path.join(dst, f));
      items.push({
        ...info,
        thumb: `photos/${lake.slug}/${out.thumb}`,
        full: `photos/${lake.slug}/${out.full}`,
        fullJpg: `photos/${lake.slug}/${out.fullJpg}`,
      });
    } catch (e) {
      const heic = /\.hei[cf]$/i.test(name);
      log.warn(lake.name, heic
        ? `фото «${name}»: формат HEIC не поддерживается библиотекой обработки — пропущено (сохраните как JPEG)`
        : `фото «${name}» не удалось обработать (${e.message.split('\n')[0]}) — пропущено`);
    }
  }

  // Порядок: по дате съёмки, без даты — по имени файла
  items.sort((a, b) => (a.taken && b.taken ? a.taken.localeCompare(b.taken) : a.taken ? -1 : b.taken ? 1 : 0)
    || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return items;
}
