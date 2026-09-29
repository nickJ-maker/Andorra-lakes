/* «Озёра Андорры» — карта, список, окно озера, лайтбокс. Без фреймворков. */
(() => {
  'use strict';

  const DATA = window.LAKES_DATA;
  const M = DATA.map;
  const lakes = DATA.lakes;
  const bySlug = new Map(lakes.map((l) => [l.slug, l]));
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isFinePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

  const mapEl = $('map');
  const gGeo = $('geo');
  const gLabels = $('labels');
  const gMarkers = $('markers');
  const tooltip = $('tooltip');

  // ================= Карта: вид, масштаб, перетаскивание =================

  let W = 0, H = 0;
  let k = 1, tx = 0, ty = 0, minK = 0.1, maxK = 4;
  let userMoved = false;
  let layoutK = null;

  function measure() {
    const r = mapEl.getBoundingClientRect();
    W = r.width; H = r.height;
    minK = Math.min(W / M.width, H / M.height);
    maxK = Math.max(4, minK * 4);
  }

  function fitView(rect, pad) {
    const [x0, y0, x1, y1] = rect;
    const p = pad ?? Math.min(40, Math.min(W, H) * 0.06);
    const nk = clamp(Math.min((W - 2 * p) / (x1 - x0), (H - 2 * p) / (y1 - y0)), minK, maxK);
    return { k: nk, tx: W / 2 - ((x0 + x1) / 2) * nk, ty: H / 2 - ((y0 + y1) / 2) * nk };
  }

  function clampView(v) {
    const mw = M.width * v.k, mh = M.height * v.k;
    v.tx = mw <= W ? (W - mw) / 2 : clamp(v.tx, W - mw, 0);
    v.ty = mh <= H ? (H - mh) / 2 : clamp(v.ty, H - mh, 0);
    return v;
  }

  let raf = 0;
  function setView(v) {
    v = clampView({ k: clamp(v.k, minK, maxK), tx: v.tx, ty: v.ty });
    k = v.k; tx = v.tx; ty = v.ty;
    if (!raf) raf = requestAnimationFrame(render);
  }

  function render() {
    raf = 0;
    gGeo.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(5)})`);
    const t = `translate(${tx.toFixed(2)} ${ty.toFixed(2)})`;
    gLabels.setAttribute('transform', t);
    gMarkers.setAttribute('transform', t);
    if (k !== layoutK) { layout(); updateScale(); }
    if (hotLake && !tooltip.hidden) placeTooltip(hotLake);
  }

  // Раскладка подписей зависит от масштаба и (для подписей озёр) от видимой области:
  // при смене масштаба — сразу, после перетаскивания — с небольшой задержкой
  let relayoutTimer = 0;
  function relayoutSoon() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => { layoutK = null; setView({ k, tx, ty }); }, 120);
  }

  function zoomAt(factor, cx, cy, animate) {
    const nk = clamp(k * factor, minK, maxK);
    const target = { k: nk, tx: cx - (cx - tx) * (nk / k), ty: cy - (cy - ty) * (nk / k) };
    userMoved = true;
    animate ? animateTo(target) : setView(target);
  }

  let anim = 0;
  function animateTo(target, ms = 260) {
    cancelAnimationFrame(anim);
    const from = { k, tx, ty };
    const to = clampView({ k: clamp(target.k, minK, maxK), tx: target.tx, ty: target.ty });
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setView(to);
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      // интерполяция масштаба в логарифме — плавнее
      const kk = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
      setView({ k: kk, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e });
      if (p < 1) anim = requestAnimationFrame(step);
      else relayoutSoon();
    };
    anim = requestAnimationFrame(step);
  }

  function defaultView() { return fitView(M.view); }

  $('zoomIn').addEventListener('click', () => zoomAt(1.6, W / 2, H / 2, true));
  $('zoomOut').addEventListener('click', () => zoomAt(1 / 1.6, W / 2, H / 2, true));
  $('zoomReset').addEventListener('click', () => { userMoved = false; animateTo(defaultView(), 380); });

  mapEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = mapEl.getBoundingClientRect();
    const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    zoomAt(Math.exp(-clamp(d, -300, 300) * 0.0022), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  mapEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.marker, .zoom, .map-foot, .to-list')) return;
    const r = mapEl.getBoundingClientRect();
    zoomAt(e.shiftKey ? 1 / 2 : 2, e.clientX - r.left, e.clientY - r.top, true);
  });

  // Перетаскивание и pinch-жест (Pointer Events)
  const pointers = new Map();
  let gesture = null;
  let dragged = false;

  function startGesture() {
    const pts = [...pointers.values()];
    if (pts.length === 1) gesture = { type: 'pan', x: pts[0].x, y: pts[0].y, tx, ty };
    else if (pts.length >= 2) {
      const [a, b] = pts;
      gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k, tx, ty };
    } else gesture = null;
  }

  mapEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.zoom, .map-foot, .to-list, .tooltip')) return;
    const r = mapEl.getBoundingClientRect();
    pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (pointers.size === 1) dragged = false;
    cancelAnimationFrame(anim);
    startGesture();
  });

  window.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const r = mapEl.getBoundingClientRect();
    pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    const pts = [...pointers.values()];
    if (gesture.type === 'pan' && pts.length === 1) {
      const dx = pts[0].x - gesture.x, dy = pts[0].y - gesture.y;
      if (!dragged && Math.hypot(dx, dy) < 5) return;
      if (!dragged) { dragged = true; mapEl.classList.add('dragging'); hideTooltip(); }
      userMoved = true;
      setView({ k, tx: gesture.tx + dx, ty: gesture.ty + dy });
    } else if (gesture.type === 'pinch' && pts.length >= 2) {
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const nk = clamp(gesture.k * (d / gesture.d), minK, maxK);
      dragged = true; userMoved = true;
      setView({ k: nk, tx: cx - (gesture.cx - gesture.tx) * (nk / gesture.k), ty: cy - (gesture.cy - gesture.ty) * (nk / gesture.k) });
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!pointers.size) {
      mapEl.classList.remove('dragging');
      if (dragged) relayoutSoon();
    }
    startGesture();
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  // Клик после перетаскивания не должен открывать озеро
  mapEl.addEventListener('click', (e) => {
    if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; }
  }, true);

  // ================= Подписи и точки-озёра =================

  const ctx = document.createElement('canvas').getContext('2d');
  const widthCache = new Map();
  function textWidth(text, font, spacingEm = 0, size = 14) {
    const key = font + '|' + text;
    let w = widthCache.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width + spacingEm * size * text.length;
      widthCache.set(key, w);
    }
    return w;
  }
  const FONT = '"Old Standard TT", "Times New Roman", serif';

  // Точки-озёра: создаются один раз, позиции обновляются при смене масштаба
  const markers = new Map();
  for (const lake of lakes) {
    if (!lake.xy) continue;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'marker');
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${lake.name}${lake.countryName ? ', ' + lake.countryName : ''} — открыть`);
    g.dataset.slug = lake.slug;
    g.innerHTML =
      '<line class="leader" x1="0" y1="0" x2="0" y2="0" visibility="hidden"/>' +
      '<circle class="halo" r="13"/>' +
      '<g transform="translate(-12 -14.6)">' +
      '<path class="drop" d="M12 2.5C12 2.5 5 10.2 5 14.6A7 7 0 0 0 19 14.6C19 10.2 12 2.5 12 2.5Z"/>' +
      '<path class="wave" d="M8.3 15.2c1.2-.9 2.4-.9 3.7 0s2.5.9 3.7 0"/>' +
      '<path class="wave" d="M8.9 18c1-.7 2-.7 3.1 0s2.1.7 3.1 0"/></g>' +
      `<text class="m-label">${esc(lake.name)}</text>`;
    gMarkers.appendChild(g);
    markers.set(lake.slug, { g, lake, text: g.querySelector('text'), leader: g.querySelector('.leader') });
  }

  const LABEL_STYLE = {
    country: { font: `700 17px ${FONT}`, size: 17, spacing: 0.42, h: 18 },
    place1: { font: `700 14.5px ${FONT}`, size: 14.5, h: 15 },
    place2: { font: `400 13px ${FONT}`, size: 13, h: 14 },
    place3: { font: `400 12px ${FONT}`, size: 12, h: 13 },
    peak: { font: `italic 400 11.5px ${FONT}`, size: 11.5, h: 12 },
    river: { font: `italic 400 12px ${FONT}`, size: 12, spacing: 0.12, h: 12 },
    lake: { font: `700 14.5px ${FONT}`, size: 14.5, h: 15 },
  };

  function layout() {
    layoutK = k;
    const boxes = [];
    const PAD = 2;
    const hits = (b) => boxes.some((o) => b.x0 < o.x1 + PAD && b.x1 + PAD > o.x0 && b.y0 < o.y1 + PAD && b.y1 + PAD > o.y0);
    const box = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
    // видимая область в координатах слоя подписей — подписи озёр по возможности не уходят за край
    const inView = (b) => b.x0 >= -tx + 6 && b.x1 <= -tx + W - 6 && b.y0 >= -ty + 6 && b.y1 <= -ty + H - 6;

    // 1) значки озёр — неприкосновенны
    const lakeItems = [...markers.values()].map((m) => ({ ...m, sx: m.lake.xy[0] * k, sy: m.lake.xy[1] * k }));
    for (const m of lakeItems) boxes.push(box(m.sx - 10, m.sy - 13, m.sx + 10, m.sy + 11));

    // 2) подписи озёр — всегда видны: перебор позиций, при нехватке места — выноска
    const st = LABEL_STYLE.lake;
    const ORDER = ['right', 'left', 'top', 'bottom', 'tr', 'br', 'tl', 'bl'];
    for (const m of lakeItems) {
      const w = textWidth(m.lake.name, st.font);
      const { sx, sy } = m;
      const cand = (pos) => {
        switch (pos) {
          case 'right': return { x: sx + 14, y: sy + 5, a: 'start' };
          case 'left': return { x: sx - 14, y: sy + 5, a: 'end' };
          case 'top': return { x: sx, y: sy - 18, a: 'middle' };
          case 'bottom': return { x: sx, y: sy + 27, a: 'middle' };
          case 'tr': return { x: sx + 9, y: sy - 13, a: 'start' };
          case 'br': return { x: sx + 9, y: sy + 23, a: 'start' };
          case 'tl': return { x: sx - 9, y: sy - 13, a: 'end' };
          case 'bl': return { x: sx - 9, y: sy + 23, a: 'end' };
        }
      };
      const bOf = (c) => {
        const x0 = c.a === 'start' ? c.x : c.a === 'end' ? c.x - w : c.x - w / 2;
        return box(x0 - 2, c.y - st.h + 2, x0 + w + 2, c.y + 4);
      };
      const order = m.lake.label ? [m.lake.label, ...ORDER.filter((p) => p !== m.lake.label)] : ORDER;
      let chosen = null, leader = null;
      const markerVisible = inView(box(sx - 1, sy - 1, sx + 1, sy + 1));
      // проходы: сначала только позиции внутри экрана, затем любые
      for (const needView of markerVisible ? [true, false] : [false]) {
        for (const pos of order) {
          const c = cand(pos), b = bOf(c);
          if (!hits(b) && (!needView || inView(b))) { chosen = c; boxes.push(b); break; }
        }
        if (chosen) break;
        // выноска: подпись отодвигается и соединяется с точкой линией
        outer: for (const r of [40, 58, 80, 105]) {
          for (let i = 0; i < 12; i++) {
            const ang = (i / 12) * Math.PI * 2;
            const cx = sx + Math.cos(ang) * r, cy = sy + Math.sin(ang) * r;
            const a = Math.cos(ang) > 0.3 ? 'start' : Math.cos(ang) < -0.3 ? 'end' : 'middle';
            const c = { x: cx, y: cy + 5, a };
            const b = bOf(c);
            if (!hits(b) && (!needView || inView(b))) {
              chosen = c; boxes.push(b);
              const ex = a === 'start' ? cx - 2 : a === 'end' ? cx + 2 : cx;
              const ey = a === 'middle' ? (Math.sin(ang) > 0 ? cy - 8 : cy + 8) : cy;
              leader = { x1: Math.cos(ang) * 12, y1: Math.sin(ang) * 12, x2: ex - sx, y2: ey - sy };
              break outer;
            }
          }
        }
        if (chosen) break;
      }
      if (!chosen) { chosen = cand('right'); boxes.push(bOf(chosen)); }
      m.g.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);
      m.text.setAttribute('x', (chosen.x - sx).toFixed(1));
      m.text.setAttribute('y', (chosen.y - sy).toFixed(1));
      m.text.setAttribute('text-anchor', chosen.a);
      if (leader) {
        for (const [a, v] of Object.entries(leader)) m.leader.setAttribute(a, v.toFixed(1));
        m.leader.setAttribute('visibility', 'visible');
      } else m.leader.setAttribute('visibility', 'hidden');
    }

    // 3) прочие подписи — по приоритету, пересекающиеся скрываются
    let out = '';
    for (const L of M.labels) {
      const sx = L.x * k, sy = L.y * k;
      if (L.type === 'country') {
        const s = LABEL_STYLE.country, w = textWidth(L.text, s.font, s.spacing, s.size);
        const b = box(sx - w / 2, sy - s.h / 2 - 2, sx + w / 2, sy + s.h / 2);
        if (hits(b)) continue;
        boxes.push(b);
        out += `<text class="l-country" x="${sx.toFixed(1)}" y="${(sy + 6).toFixed(1)}" text-anchor="middle">${esc(L.text)}</text>`;
      } else if (L.type === 'place') {
        const s = LABEL_STYLE['place' + L.rank] || LABEL_STYLE.place2, w = textWidth(L.text, s.font);
        const r = L.rank === 1 ? 4.5 : 3.5;
        const sym = box(sx - r - 1, sy - r - 1, sx + r + 1, sy + r + 1);
        if (hits(sym)) continue;
        const opts = [
          { b: box(sx + r + 2, sy - s.h / 2 - 1, sx + r + 4 + w, sy + s.h / 2 + 1), x: sx + r + 3, a: 'start' },
          { b: box(sx - r - 4 - w, sy - s.h / 2 - 1, sx - r - 2, sy + s.h / 2 + 1), x: sx - r - 3, a: 'end' },
          { b: box(sx - w / 2, sy - r - 3 - s.h, sx + w / 2, sy - r - 2), x: sx, a: 'middle', y: sy - r - 5 },
          { b: box(sx - w / 2, sy + r + 2, sx + w / 2, sy + r + 3 + s.h), x: sx, a: 'middle', y: sy + r + s.h },
        ];
        const o = opts.find((o) => !hits(o.b));
        if (!o) continue;
        boxes.push(sym, o.b);
        out += `<circle class="s-town r${L.rank}" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${r}"/>` +
          `<text class="l-place r${L.rank}" x="${o.x.toFixed(1)}" y="${(o.y ?? sy + s.size * 0.34).toFixed(1)}" text-anchor="${o.a}">${esc(L.text)}</text>`;
      } else if (L.type === 'peak') {
        const s = LABEL_STYLE.peak;
        const full = `${L.text} ${L.ele}`;
        const w = textWidth(full, s.font);
        const sym = box(sx - 5, sy - 5, sx + 5, sy + 4);
        if (hits(sym)) continue;
        const opts = [
          { b: box(sx + 6, sy - s.h / 2 - 1, sx + 8 + w, sy + s.h / 2 + 1), x: sx + 7, a: 'start' },
          { b: box(sx - 8 - w, sy - s.h / 2 - 1, sx - 6, sy + s.h / 2 + 1), x: sx - 7, a: 'end' },
          { b: box(sx - w / 2, sy + 5, sx + w / 2, sy + 6 + s.h), x: sx, a: 'middle', y: sy + 5 + s.h },
        ];
        const o = opts.find((o) => !hits(o.b));
        if (!o) continue;
        boxes.push(sym, o.b);
        out += `<path class="s-peak" d="M${sx.toFixed(1)} ${(sy - 4.5).toFixed(1)}l4.5 8h-9z"/>` +
          `<text class="l-peak" x="${o.x.toFixed(1)}" y="${(o.y ?? sy + 4).toFixed(1)}" text-anchor="${o.a}">${esc(L.text)} <tspan class="ele">${L.ele}</tspan></text>`;
      } else if (L.type === 'river') {
        const s = LABEL_STYLE.river, w = textWidth(L.text, s.font, s.spacing, s.size);
        const a = (L.angle * Math.PI) / 180;
        const hw = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * s.h) / 2;
        const hh = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * s.h) / 2;
        const b = box(sx - hw, sy - hh, sx + hw, sy + hh);
        if (hits(b)) continue;
        boxes.push(b);
        out += `<text class="l-river" x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" dy="4" text-anchor="middle" transform="rotate(${L.angle} ${sx.toFixed(1)} ${sy.toFixed(1)})">${esc(L.text)}</text>`;
      }
    }
    gLabels.innerHTML = out;
  }

  // Масштабная линейка «в старинном стиле»
  function updateScale() {
    const mpp = M.metersPerUnit / k; // метров на пиксель экрана
    const target = mpp * 120;
    const nice = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];
    let v = nice[0];
    for (const n of nice) if (n <= target) v = n;
    const len = v / mpp;
    const seg = 4;
    const unit = v >= 1000 ? 'км' : 'м';
    const fmt = (m) => (v >= 1000 ? String(+(m / 1000).toFixed(2)).replace('.', ',') : String(Math.round(m)));
    let rects = '';
    for (let i = 0; i < seg; i++) rects += `<rect x="${((len / seg) * i).toFixed(1)}" y="16" width="${(len / seg).toFixed(1)}" height="5" class="${i % 2 ? 'sb-b' : 'sb-a'}"/>`;
    $('scalebar').innerHTML =
      `<svg width="${(len + 26).toFixed(0)}" height="24" viewBox="-6 0 ${(len + 26).toFixed(0)} 24">` +
      `${rects}<text x="0" y="12" text-anchor="middle">0</text>` +
      `<text x="${(len / 2).toFixed(1)}" y="12" text-anchor="middle">${fmt(v / 2)}</text>` +
      `<text x="${len.toFixed(1)}" y="12" text-anchor="middle">${fmt(v)}</text>` +
      `<text x="${(len + 6).toFixed(1)}" y="21">${unit}</text></svg>`;
  }

  // ================= Подсветка и подсказка =================

  let hotLake = null;
  const rows = new Map();

  function setHot(lake, on, raise) {
    const m = markers.get(lake.slug);
    if (m) m.g.classList.toggle('hot', on);
    rows.get(lake.slug)?.classList.toggle('hot', on);
    // поверх остальных точек; только при наведении — перестановка узла во время нажатия «съедает» клик
    if (on && raise && m && m.g.nextSibling) m.g.parentNode.appendChild(m.g);
  }

  function coverThumb(lake) {
    return lake.cover != null && lake.photos[lake.cover] ? lake.photos[lake.cover].thumb : null;
  }

  function showTooltip(lake) {
    hotLake = lake;
    const img = coverThumb(lake);
    tooltip.innerHTML = (img ? `<img src="${esc(img)}" alt="">` : '') +
      `<b>${esc(lake.name)}</b>${lake.countryName ? `<span>${esc(lake.countryName)}</span>` : ''}`;
    tooltip.hidden = false;
    placeTooltip(lake);
  }
  function placeTooltip(lake) {
    const x = tx + lake.xy[0] * k, y = ty + lake.xy[1] * k;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let left = x + 18, top = y - th - 14;
    if (left + tw > W - 8) left = x - tw - 18;
    if (top < 8) top = y + 20;
    tooltip.style.left = clamp(left, 8, W - tw - 8) + 'px';
    tooltip.style.top = clamp(top, 8, H - th - 8) + 'px';
  }
  function hideTooltip() { tooltip.hidden = true; hotLake = null; }

  for (const [slug, m] of markers) {
    const lake = m.lake;
    m.g.addEventListener('pointerenter', (e) => {
      setHot(lake, true, !pointers.size);
      if (e.pointerType === 'mouse' && !pointers.size) showTooltip(lake);
    });
    m.g.addEventListener('pointerleave', () => { setHot(lake, false); hideTooltip(); });
    m.g.addEventListener('focus', () => { setHot(lake, true); if (isFinePointer) showTooltip(lake); });
    m.g.addEventListener('blur', () => { setHot(lake, false); hideTooltip(); });
    m.g.addEventListener('click', () => { hideTooltip(); openLake(slug, m.g); });
    m.g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLake(slug, m.g); }
    });
  }

  // ================= Список озёр =================

  const list = $('lakeList');
  const sorted = [...lakes].sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }));
  for (const lake of sorted) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lake-row';
    const img = coverThumb(lake);
    btn.innerHTML = (img ? `<img src="${esc(img)}" alt="" loading="lazy" width="72" height="54">` : '<span class="noimg"></span>') +
      `<span><span class="name">${esc(lake.name)}</span><span class="meta">${esc(lake.countryName || '')}` +
      `${lake.xy ? '' : '<span class="badge">нет на карте</span>'}</span></span>`;
    btn.addEventListener('click', () => openLake(lake.slug, btn));
    btn.addEventListener('pointerenter', () => setHot(lake, true, true));
    btn.addEventListener('pointerleave', () => setHot(lake, false));
    btn.addEventListener('focus', () => setHot(lake, true));
    btn.addEventListener('blur', () => setHot(lake, false));
    li.appendChild(btn);
    list.appendChild(li);
    rows.set(lake.slug, btn);
  }

  $('toList').addEventListener('click', (e) => {
    e.preventDefault();
    $('listTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ================= Окно озера и адреса #/lake/<slug> =================

  const modal = $('modal');
  const dialog = modal.querySelector('.modal-dialog');
  const baseTitle = document.title;
  let current = null;
  let openedInApp = false;
  let returnFocus = null;

  function openLake(slug, origin) {
    returnFocus = origin || null;
    openedInApp = true;
    const hash = '#/lake/' + slug;
    if (location.hash === hash) route(); else location.hash = hash;
  }

  function requestClose() {
    if (!current) return;
    if (openedInApp && history.length > 1) history.back();
    else {
      history.replaceState(null, '', location.pathname + location.search);
      closeModal();
    }
  }

  function route() {
    const m = location.hash.match(/^#\/lake\/([^/?#]+)/);
    const lake = m && bySlug.get(decodeURIComponent(m[1]));
    if (lake) showModal(lake);
    else if (current) closeModal();
  }
  window.addEventListener('hashchange', route);

  function lockScroll(on) { document.documentElement.classList.toggle('locked', on); }

  function showModal(lake) {
    if (current === lake) return;
    closeLightbox(true);
    current = lake;
    $('mTitle').textContent = lake.name;
    const c = $('mCountry');
    c.textContent = lake.countryName || '';
    c.hidden = !lake.countryName;

    const links = [];
    if (lake.links.start) links.push(['📍', 'Начало маршрута', lake.links.start]);
    if (lake.links.end) links.push(['🏞', 'Озеро на карте', lake.links.end]);
    if (lake.links.route) links.push(['🥾', 'Маршрут в Komoot', lake.links.route]);
    $('mLinks').innerHTML = links.map(([i, t, href]) =>
      `<a href="${esc(href)}" target="_blank" rel="noopener"><span aria-hidden="true">${i}</span>${t}</a>`).join('');

    const g = $('mGallery');
    g.innerHTML = lake.photos.length
      ? lake.photos.map((p, i) =>
        `<button type="button" data-i="${i}" aria-label="Открыть фото ${i + 1} из ${lake.photos.length}">` +
        `<img src="${esc(p.thumb)}" alt="${esc(lake.name)} — фото ${i + 1}" loading="lazy" width="${Math.round(p.w * 0.24)}" height="${Math.round(p.h * 0.24)}"></button>`).join('')
      : '<p class="m-empty">Фотографии этого озера скоро появятся</p>';

    const kSec = $('mKomoot'), frame = $('mKomootFrame');
    frame.innerHTML = '';
    if (lake.komoot) {
      kSec.hidden = false;
      // iframe загружается только при открытии окна
      frame.innerHTML = `<iframe src="${esc(lake.komoot.embed)}" title="Карта маршрута к озеру ${esc(lake.name)} в Komoot" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      $('mKomootNote').innerHTML = `Если карта маршрута не отображается — <a href="${esc(lake.links.route)}" target="_blank" rel="noopener">откройте маршрут в Komoot</a>.`;
    } else kSec.hidden = true;

    document.title = `${lake.name} — ${baseTitle.split(' — ')[0]}`;
    if (modal.hidden) {
      modal.hidden = false;
      lockScroll(true);
    }
    dialog.scrollTop = 0;
    dialog.focus({ preventScroll: true });
  }

  function closeModal() {
    if (!current) return;
    const lake = current;
    current = null;
    closeLightbox(true);
    modal.hidden = true;
    $('mKomootFrame').innerHTML = ''; // останавливаем загрузку Komoot
    lockScroll(false);
    document.title = baseTitle;
    openedInApp = false;
    const target = returnFocus && document.contains(returnFocus) ? returnFocus : (markers.get(lake.slug)?.g || rows.get(lake.slug));
    returnFocus = null;
    target?.focus({ preventScroll: true });
  }

  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) requestClose();
    const b = e.target.closest('.m-gallery button');
    if (b) openLightbox(+b.dataset.i, b);
  });

  // Удержание фокуса внутри открытого окна
  function trapFocus(e, root) {
    const f = [...root.querySelectorAll('a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root.querySelector('[tabindex="-1"]'))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ================= Лайтбокс =================

  const lb = $('lightbox');
  const lbImg = $('lbImg'), lbSource = $('lbSource');
  let lbIndex = 0, lbReturn = null;

  function openLightbox(i, origin) {
    if (!current || !current.photos.length) return;
    lbReturn = origin;
    lb.hidden = false;
    showPhoto(i);
    $('lbClose').focus({ preventScroll: true });
  }
  function showPhoto(i) {
    const photos = current.photos;
    lbIndex = (i + photos.length) % photos.length;
    const p = photos[lbIndex];
    lbImg.classList.add('loading');
    lbImg.onload = () => lbImg.classList.remove('loading');
    lbSource.srcset = p.full;
    lbImg.src = p.fullJpg;
    lbImg.alt = `${current.name} — фото ${lbIndex + 1}`;
    $('lbCount').textContent = `${lbIndex + 1} / ${photos.length}`;
    const multi = photos.length > 1;
    $('lbPrev').hidden = !multi; $('lbNext').hidden = !multi;
    // предзагрузка соседних фото
    if (multi) for (const d of [1, -1]) {
      const n = photos[(lbIndex + d + photos.length) % photos.length];
      const pre = new Image();
      pre.src = supportsWebp ? n.full : n.fullJpg;
    }
  }
  function closeLightbox(silent) {
    if (lb.hidden) return;
    lb.hidden = true;
    lbImg.removeAttribute('src');
    if (!silent && lbReturn && document.contains(lbReturn)) lbReturn.focus({ preventScroll: true });
    lbReturn = null;
  }
  const supportsWebp = document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp');

  $('lbPrev').addEventListener('click', (e) => { e.stopPropagation(); showPhoto(lbIndex - 1); });
  $('lbNext').addEventListener('click', (e) => { e.stopPropagation(); showPhoto(lbIndex + 1); });
  $('lbClose').addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });

  // Свайп и клик по фону
  let sw = null;
  lb.addEventListener('pointerdown', (e) => { sw = { x: e.clientX, y: e.clientY, t: e.target }; });
  lb.addEventListener('pointerup', (e) => {
    if (!sw) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    const start = sw; sw = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.2) { showPhoto(lbIndex + (dx < 0 ? 1 : -1)); return; }
    if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) { closeLightbox(); return; }
    if (Math.hypot(dx, dy) < 8 && start.t === e.target && !e.target.closest('img, button')) closeLightbox();
  });

  // ================= Клавиатура =================

  document.addEventListener('keydown', (e) => {
    if (!lb.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
      else if (e.key === 'ArrowLeft') showPhoto(lbIndex - 1);
      else if (e.key === 'ArrowRight') showPhoto(lbIndex + 1);
      else if (e.key === 'Tab') trapFocus(e, lb);
      return;
    }
    if (current) {
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); }
      else if (e.key === 'Tab') trapFocus(e, dialog);
      return;
    }
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.key === '+' || e.key === '=') zoomAt(1.6, W / 2, H / 2, true);
    else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.6, W / 2, H / 2, true);
  });

  // ================= Запуск =================

  function init() {
    measure();
    setView(defaultView());
    new ResizeObserver(() => {
      const cx = (W / 2 - tx) / k, cy = (H / 2 - ty) / k; // центр в координатах карты
      measure();
      if (!userMoved) setView(defaultView());
      else setView({ k, tx: W / 2 - cx * k, ty: H / 2 - cy * k });
      layoutK = null;
    }).observe(mapEl);
    // после загрузки шрифтов ширины подписей меняются — пересчитываем раскладку
    document.fonts?.ready.then(() => { widthCache.clear(); layoutK = null; setView({ k, tx, ty }); });
    route();
  }
  init();
})();
