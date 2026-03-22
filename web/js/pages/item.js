/**
 * Item history page with inline SVG line chart.
 * URL: #/item?itemid=<id>[&from=<unix>&till=<unix>][&period=<secs>]
 *   or #/item?itemids=1,2,3[&stacked=1][&from=...&till=...]
 */
import { call } from '../api.js';
import { content, esc } from '../app.js';

const PRESETS = [
  { label: '1h',  secs: 3600 },
  { label: '3h',  secs: 10800 },
  { label: '6h',  secs: 21600 },
  { label: '1d',  secs: 86400 },
  { label: '7d',  secs: 604800 },
  { label: '30d', secs: 2592000 },
];

const VT_NUMERIC = [0, 3];  // float, uint
const COLORS = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'];

function itemIdsFromHash() {
  // multi: ?itemids=1,2,3
  const m = location.hash.match(/[?&]itemids=([0-9,]+)/);
  if (m) return m[1].split(',').filter(Boolean);
  // single: ?itemid=123
  const s = location.hash.match(/[?&]itemid=(\d+)/);
  return s ? [s[1]] : [];
}

function isStacked() {
  return /[?&]stacked=1/.test(location.hash);
}

function rangeFromHash() {
  const h = location.hash;
  const fromM = h.match(/[?&]from=(\d+)/);
  const tillM = h.match(/[?&]till=(\d+)/);
  if (fromM && tillM) return { from: parseInt(fromM[1]), till: parseInt(tillM[1]) };
  const periodM = h.match(/[?&]period=(\d+)/);
  const now = Math.floor(Date.now() / 1000);
  const secs = periodM ? parseInt(periodM[1]) : 3600;
  return { from: now - secs, till: now };
}

function setRange(from, till) {
  let base = location.hash.replace(/[?&](period|from|till)=[^&]*/g, '').replace(/[?&]$/, '');
  location.hash = base + (base.includes('?') ? '&' : '?') + `from=${from}&till=${till}`;
}

function toDatetimeLocal(ts) {
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function render(root) {
  const el = content();
  const ids = itemIdsFromHash();
  if (!ids.length) { el.innerHTML = '<p class="error">No itemid.</p>'; return; }

  el.innerHTML = '<p class="loading">Loading…</p>';

  try {
    const items = await call('item.get', { itemids: ids, output: 'extend' });
    if (!items.length) { el.innerHTML = '<p class="error">Item not found.</p>'; return; }
    // Preserve order from URL
    const ordered = ids.map(id => items.find(it => it.itemid === id)).filter(Boolean);
    renderPage(el, ordered);
    await loadChart(ordered);
  } catch (e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderPage(el, items) {
  const { from, till } = rangeFromHash();
  const presetBtns = PRESETS.map(p =>
    `<button class="period-btn" data-secs="${p.secs}">${p.label}</button>`
  ).join('');

  const isSingle = items.length === 1;
  const stacked  = isStacked();
  const item     = items[0];

  const title = isSingle
    ? esc(item.name_resolved || item.name)
    : `Graph <span class="muted" style="font-size:0.8rem">${items.length} items${stacked ? ', stacked' : ''}</span>`;

  const meta = isSingle ? `
    <div class="item-meta">
      <span>Key: <code>${esc(item.key_)}</code></span>
      <span>Units: ${esc(item.units || '—')}</span>
      <span>Value type: ${valueTypeName(item.value_type)}</span>
    </div>` : '';

  el.innerHTML = `
    <div class="page-header"><h2>${title}</h2></div>
    <div class="time-range-picker">
      <div class="trp-presets">${presetBtns}</div>
      <div class="trp-inputs">
        <label>From<input type="datetime-local" id="trp-from" value="${toDatetimeLocal(from)}"></label>
        <label>To<input type="datetime-local" id="trp-till" value="${toDatetimeLocal(till)}"></label>
        <button id="trp-apply">Apply</button>
      </div>
    </div>
    ${meta}
    <div id="chart-wrap" class="chart-wrap"></div>
    <div id="history-table"></div>
  `;

  el.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const now = Math.floor(Date.now() / 1000);
      const f = now - parseInt(btn.dataset.secs);
      setRange(f, now);
      document.getElementById('trp-from').value = toDatetimeLocal(f);
      document.getElementById('trp-till').value = toDatetimeLocal(now);
      loadChart(items);
    });
  });

  document.getElementById('trp-apply').addEventListener('click', () => {
    const f = Math.floor(new Date(document.getElementById('trp-from').value).getTime() / 1000);
    const t = Math.floor(new Date(document.getElementById('trp-till').value).getTime() / 1000);
    if (f && t && t > f) { setRange(f, t); loadChart(items); }
  });
}

// ── Data loading ───────────────────────────────────────────────────────────────

async function loadChart(items) {
  const wrap   = document.getElementById('chart-wrap');
  const histEl = document.getElementById('history-table');
  if (!wrap) return;
  wrap.innerHTML = '<p class="loading">Loading data…</p>';
  if (histEl) histEl.innerHTML = '';

  const { from, till } = rangeFromHash();
  const period  = till - from;
  const stacked = isStacked();

  try {
    const series = await Promise.all(items.map(async item => {
      const vt        = parseInt(item.value_type);
      const isNumeric = VT_NUMERIC.includes(vt);
      const histType  = vt === 3 ? 3 : (isNumeric ? 0 : 1);
      const useTrends = period >= 86400 && isNumeric;
      let points;

      if (useTrends) {
        const rows = await call('trend.get', {
          itemids: [item.itemid], time_from: from, time_till: till,
          history: histType, sortorder: 'ASC', limit: 1000,
        });
        points = rows.map(r => ({
          t: parseInt(r.clock), v: parseFloat(r.value_avg),
          min: parseFloat(r.value_min), max: parseFloat(r.value_max),
        }));
      } else {
        const rows = await call('history.get', {
          itemids: [item.itemid], time_from: from, time_till: till,
          history: histType, sortorder: 'ASC', limit: 2000,
        });
        points = rows.map(r => ({ t: parseInt(r.clock), v: parseFloat(r.value) }));
      }
      return { item, points, isNumeric, useTrends: useTrends && points.length > 0 };
    }));

    const hasData = series.some(s => s.points.length > 0);
    if (!hasData) {
      wrap.innerHTML = '<p class="empty">No data for this period.</p>';
      return;
    }

    wrap.innerHTML = '';

    if (items.length === 1) {
      // Single item: existing behavior
      const { item, points, isNumeric, useTrends } = series[0];
      if (isNumeric && points.length) wrap.appendChild(renderSvgChart(points, item.units, useTrends));
      if (histEl) histEl.innerHTML = renderHistoryTable(points, item, useTrends);
    } else {
      // Multi-item: multi-series chart
      const numSeries = series.filter(s => s.isNumeric && s.points.length > 0);
      if (numSeries.length) wrap.appendChild(renderSvgMulti(numSeries, stacked));
    }
  } catch (e) {
    wrap.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ── Nearest value helper ───────────────────────────────────────────────────────

function nearestValue(pts, t) {
  if (!pts.length) return 0;
  let lo = 0, hi = pts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid + 1; else hi = mid; }
  const a = pts[lo], b = pts[lo - 1];
  if (!a) return b.v;
  if (!b) return a.v;
  return Math.abs(a.t - t) <= Math.abs(b.t - t) ? a.v : b.v;
}

// ── Multi-series SVG Chart ─────────────────────────────────────────────────────

function renderSvgMulti(seriesList, stacked) {
  const W = 900, H = 300, PAD = { top: 16, right: 16, bottom: 36, left: 72 };
  const gW = W - PAD.left - PAD.right;
  const gH = H - PAD.top  - PAD.bottom;

  const allTs = seriesList.flatMap(s => s.points.map(p => p.t));
  const tMin  = Math.min(...allTs), tMax = Math.max(...allTs);
  const tRange = tMax - tMin || 1;
  const px = t => PAD.left + ((t - tMin) / tRange) * gW;

  let py, vMin, vMax, stackedData = null;

  if (stacked) {
    // Build time-aligned stacked data (union of all timestamps, nearest-neighbor fill)
    const times   = [...new Set(allTs)].sort((a, b) => a - b);
    const aligned = seriesList.map(s => times.map(t => nearestValue(s.points, t)));
    // cumul[ti][si] = cumulative sum of series 0..si at time index ti
    const cumul = times.map((_, ti) => {
      let sum = 0;
      return seriesList.map((_, si) => { sum += aligned[si][ti]; return sum; });
    });
    vMin = 0;
    vMax = Math.max(...cumul.map(row => row[row.length - 1])) || 1;
    const vRange = vMax - vMin;
    py = v => PAD.top + gH - ((v - vMin) / vRange) * gH;
    stackedData = { times, cumul };
  } else {
    const allVals = seriesList.flatMap(s => s.points.map(p => p.v));
    vMin = Math.min(...allVals);
    vMax = Math.max(...allVals);
    const vRange = vMax - vMin || 1;
    py = v => PAD.top + gH - ((v - vMin) / vRange) * gH;
  }

  const firstUnits = seriesList[0]?.item?.units || '';

  const gridLines = Array.from({ length: 6 }, (_, i) => {
    const v = vMin + ((vMax - vMin) * i / 5);
    const y = py(v);
    return `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W - PAD.right}" y2="${y.toFixed(1)}" class="grid-line"/>
            <text x="${PAD.left - 6}" y="${(y + 4).toFixed(1)}" class="axis-label">${fmtVal(v, firstUnits)}</text>`;
  }).join('');

  const xLabels = Array.from({ length: 5 }, (_, i) => {
    const t = tMin + (tRange * i / 4);
    return `<text x="${px(t).toFixed(1)}" y="${H - 6}" class="axis-label">${fmtTime(t)}</text>`;
  }).join('');

  let seriesSvg = '';

  if (stacked) {
    const { times, cumul } = stackedData;
    // Draw from last series to first so first sits on top visually
    for (let si = seriesList.length - 1; si >= 0; si--) {
      const color  = COLORS[si % COLORS.length];
      const topPts = times.map((t, ti) =>
        `${px(t).toFixed(1)},${py(cumul[ti][si]).toFixed(1)}`);
      const basePts = times.slice().reverse().map((t, ri) => {
        const ti  = times.length - 1 - ri;
        const bas = si > 0 ? cumul[ti][si - 1] : 0;
        return `${px(t).toFixed(1)},${py(bas).toFixed(1)}`;
      });
      seriesSvg += `<polygon points="${[...topPts, ...basePts].join(' ')}"
        fill="${color}" fill-opacity="0.75" stroke="${color}" stroke-width="0.5"/>`;
    }
  } else {
    for (let si = 0; si < seriesList.length; si++) {
      const { points } = seriesList[si];
      const color = COLORS[si % COLORS.length];
      if (!points.length) continue;
      const linePts = points.map(p =>
        `${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`).join(' ');
      const areaPts = [
        `${px(points[0].t).toFixed(1)},${py(vMin).toFixed(1)}`,
        ...points.map(p => `${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`),
        `${px(points[points.length - 1].t).toFixed(1)},${py(vMin).toFixed(1)}`,
      ].join(' ');
      seriesSvg += `<polygon points="${areaPts}" fill="${color}" fill-opacity="0.15"/>`;
      seriesSvg += `<polyline points="${linePts}" stroke="${color}" fill="none" stroke-width="1.5" stroke-linejoin="round"/>`;
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart-svg');
  svg.innerHTML = `
    ${gridLines}${xLabels}${seriesSvg}
    <line id="chart-xhair" x1="-1" x2="-1" y1="${PAD.top}" y2="${H - PAD.bottom}" class="chart-crosshair"/>
    <rect id="chart-overlay" x="${PAD.left}" y="${PAD.top}" width="${gW}" height="${gH}"
          fill="transparent" style="cursor:crosshair"/>
  `;

  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.style.display = 'none';

  const overlay = svg.querySelector('#chart-overlay');
  const xhair   = svg.querySelector('#chart-xhair');

  overlay.addEventListener('mousemove', e => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const sp = pt.matrixTransform(svg.getScreenCTM().inverse());
    const t  = tMin + ((sp.x - PAD.left) / gW) * tRange;
    xhair.setAttribute('x1', sp.x.toFixed(1));
    xhair.setAttribute('x2', sp.x.toFixed(1));

    const lines = [`<b>${fmtTime(Math.round(t))}</b>`];
    seriesList.forEach((s, si) => {
      const color = COLORS[si % COLORS.length];
      const v     = nearestValue(s.points, t);
      const name  = s.item.name_resolved || s.item.name;
      lines.push(`<span style="color:${color}">■</span> ${esc(name)}: ${fmtVal(v, s.item.units)}`);
    });

    const wr = svg.closest('.chart-wrap').getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = (e.clientX - wr.left + 14) + 'px';
    tip.style.top  = (e.clientY - wr.top  - 14) + 'px';
    tip.innerHTML  = lines.join('<br>');
  });

  overlay.addEventListener('mouseleave', () => {
    xhair.setAttribute('x1', '-1'); xhair.setAttribute('x2', '-1');
    tip.style.display = 'none';
  });

  // Legend
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = seriesList.map((s, si) => {
    const color = COLORS[si % COLORS.length];
    const name  = s.item.name_resolved || s.item.name;
    return `<span class="legend-item">
      <span class="legend-color" style="background:${color}"></span>${esc(name)}
    </span>`;
  }).join('');

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.appendChild(svg);
  wrap.appendChild(tip);
  wrap.appendChild(legend);
  return wrap;
}

// ── Single-series SVG Chart ────────────────────────────────────────────────────

function renderSvgChart(points, units, isTrend) {
  const W = 900, H = 260, PAD = { top: 16, right: 16, bottom: 36, left: 72 };
  const gW = W - PAD.left - PAD.right;
  const gH = H - PAD.top  - PAD.bottom;

  const ts   = points.map(p => p.t);
  const vals = points.map(p => p.v);
  const tMin = Math.min(...ts),  tMax = Math.max(...ts);
  let   vMin = Math.min(...vals), vMax = Math.max(...vals);

  if (isTrend) {
    vMin = Math.min(vMin, ...points.map(p => p.min));
    vMax = Math.max(vMax, ...points.map(p => p.max));
  }

  const vRange = vMax - vMin || 1;
  const tRange = tMax - tMin || 1;

  const px = t => PAD.left + ((t - tMin) / tRange) * gW;
  const py = v => PAD.top  + gH - ((v - vMin) / vRange) * gH;

  const gridLines = Array.from({length: 6}, (_, i) => {
    const v = vMin + (vRange * i / 5);
    const y = py(v);
    return `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W - PAD.right}" y2="${y.toFixed(1)}" class="grid-line"/>
            <text x="${PAD.left - 6}" y="${(y + 4).toFixed(1)}" class="axis-label">${fmtVal(v, units)}</text>`;
  }).join('');

  const xLabels = Array.from({length: 5}, (_, i) => {
    const t = tMin + (tRange * i / 4);
    const x = px(t);
    return `<text x="${x.toFixed(1)}" y="${H - 6}" class="axis-label">${fmtTime(t)}</text>`;
  }).join('');

  const linePts = points.map(p => `${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`).join(' ');
  const areaPts = [
    `${px(points[0].t).toFixed(1)},${py(vMin).toFixed(1)}`,
    ...points.map(p => `${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`),
    `${px(points[points.length - 1].t).toFixed(1)},${py(vMin).toFixed(1)}`,
  ].join(' ');

  let band = '';
  if (isTrend) {
    const bandPts = [
      ...points.map(p => `${px(p.t).toFixed(1)},${py(p.min).toFixed(1)}`),
      ...points.slice().reverse().map(p => `${px(p.t).toFixed(1)},${py(p.max).toFixed(1)}`),
    ].join(' ');
    band = `<polygon points="${bandPts}" class="chart-band"/>`;
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart-svg');
  svg.innerHTML = `
    ${gridLines}${xLabels}${band}
    <polygon points="${areaPts}" class="chart-area"/>
    <polyline points="${linePts}" class="chart-line"/>
    <line id="chart-xhair" x1="-1" x2="-1" y1="${PAD.top}" y2="${H - PAD.bottom}" class="chart-crosshair"/>
    <circle id="chart-dot" cx="-100" cy="-100" r="4" class="chart-dot"/>
    <rect x="${PAD.left}" y="${PAD.top}" width="${gW}" height="${gH}" fill="transparent" style="cursor:crosshair" id="chart-overlay"/>
  `;

  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  tip.style.display = 'none';

  const overlay  = svg.querySelector('#chart-overlay');
  const xhair    = svg.querySelector('#chart-xhair');
  const dot      = svg.querySelector('#chart-dot');

  overlay.addEventListener('mousemove', e => {
    const pt  = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt  = pt.matrixTransform(svg.getScreenCTM().inverse());
    const mouseX = svgPt.x;

    const t       = tMin + ((mouseX - PAD.left) / gW) * tRange;
    const nearest = points.reduce((best, p) =>
      Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best, points[0]);

    const cx = px(nearest.t).toFixed(1);
    const cy = py(nearest.v).toFixed(1);
    xhair.setAttribute('x1', cx); xhair.setAttribute('x2', cx);
    dot.setAttribute('cx', cx);   dot.setAttribute('cy', cy);

    const wrapRect = svg.closest('.chart-wrap').getBoundingClientRect();
    const tx = e.clientX - wrapRect.left + 14;
    const ty = e.clientY - wrapRect.top  - 14;
    tip.style.display = 'block';
    tip.style.left    = tx + 'px';
    tip.style.top     = ty + 'px';
    let label = `${fmtTime(nearest.t)} — ${fmtVal(nearest.v, units)}`;
    if (isTrend) label += ` (min ${fmtVal(nearest.min, units)}, max ${fmtVal(nearest.max, units)})`;
    tip.textContent = label;
  });

  overlay.addEventListener('mouseleave', () => {
    xhair.setAttribute('x1', '-1'); xhair.setAttribute('x2', '-1');
    dot.setAttribute('cx', '-100'); dot.setAttribute('cy', '-100');
    tip.style.display = 'none';
  });

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.appendChild(svg);
  wrap.appendChild(tip);
  return wrap;
}

// ── History table + CSV export ─────────────────────────────────────────────────

function renderHistoryTable(points, item, isTrend) {
  const isNum  = VT_NUMERIC.includes(parseInt(item.value_type));
  const recent = points.slice(-50).reverse();
  const rows   = recent.map(p => {
    const dt    = new Date(p.t * 1000).toLocaleString();
    const val   = isNum ? fmtVal(p.v, item.units) : String(p.v);
    const extra = isTrend
      ? `<td>${fmtVal(p.min, item.units)}</td><td>${fmtVal(p.max, item.units)}</td>`
      : '';
    return `<tr><td>${esc(dt)}</td><td>${esc(val)}</td>${extra}</tr>`;
  }).join('');

  const extraHead = isTrend ? '<th>Min</th><th>Max</th>' : '';
  const id = `hist-tbl-${Date.now()}`;

  const csvRows = recent.map(p => {
    const dt  = new Date(p.t * 1000).toISOString();
    const val = isNum ? p.v : String(p.v);
    return isTrend ? `${dt},${val},${p.min},${p.max}` : `${dt},${val}`;
  });
  const csvHeader = isTrend ? 'Time,Value,Min,Max' : 'Time,Value';
  const csvData   = [csvHeader, ...csvRows].join('\n');

  setTimeout(() => {
    document.getElementById(`csv-btn-${id}`)?.addEventListener('click', () => {
      const blob = new Blob([csvData], { type: 'text/csv' });
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `${item.key_ || 'history'}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }, 0);

  return `
    <div class="section-header">
      <h3>Recent values</h3>
      <button id="csv-btn-${id}" class="btn-small">Export CSV</button>
    </div>
    <table class="data-table" id="${id}">
      <thead><tr><th>Time</th><th>Value</th>${extraHead}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtVal(v, units) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  let s, u = units || '';
  if      (abs >= 1e9) { s = (v / 1e9).toFixed(2); u = 'G' + u; }
  else if (abs >= 1e6) { s = (v / 1e6).toFixed(2); u = 'M' + u; }
  else if (abs >= 1e3) { s = (v / 1e3).toFixed(2); u = 'K' + u; }
  else                 { s = v.toFixed(abs < 1 ? 4 : 2); }
  return s + (u ? ' ' + u : '');
}

function fmtTime(ts) {
  const d   = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getDate()}.${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function valueTypeName(vt) {
  return ['Float', 'String', 'Log', 'Unsigned int', 'Text'][parseInt(vt)] || vt;
}
