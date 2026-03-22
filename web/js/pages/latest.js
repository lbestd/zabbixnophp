/**
 * Latest data — last values for all items on a host.
 * URL: #/latest
 * Auto-refresh every 30s.
 */
import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';
import { tagFilter } from '../utils/tag-filter.js';
import { multiselect } from '../utils/multiselect.js';

let _timer      = null;
let _tagFilter  = null;
let _msGroups   = null;
let _msHosts    = null;
let _selected   = new Set(); // itemids of checked numeric rows

function hostidFromHash() {
  const m = location.hash.match(/[?&]hostid=(\d+)/);
  return m ? m[1] : '';
}

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Latest data</h2>
      <span class="muted" id="lat-updated" style="font-size:0.8rem"></span>
    </div>
    <div class="filter-panel">
      <div class="lat-filter-grid">
        <div class="lat-filter-col">
          <div class="filter-field">
            <label>Host groups</label>
            <div id="lat-ms-groups" style="min-width:280px"></div>
          </div>
          <div class="filter-field">
            <label>Hosts</label>
            <div id="lat-ms-hosts" style="min-width:280px"></div>
          </div>
          <div class="filter-field">
            <label for="lat-search">Name</label>
            <input id="lat-search" type="search" placeholder="filter by name…" style="width:220px">
          </div>
        </div>
        <div class="lat-filter-col">
          <div class="filter-field">
            <label>Tags</label>
            <div id="lat-tag-filter"></div>
          </div>
          <div class="filter-field">
            <label>State</label>
            <span class="radio-group">
              <label><input type="radio" name="lat-state" value="" checked> All</label>
              <label><input type="radio" name="lat-state" value="0"> Normal</label>
              <label><input type="radio" name="lat-state" value="1"> Not supported</label>
            </span>
          </div>
          <div class="filter-field">
            <label>Show details</label>
            <input type="checkbox" id="lat-details">
          </div>
          <div class="filter-field">
            <label>Show items without data</label>
            <input type="checkbox" id="lat-nodata" checked>
          </div>
        </div>
      </div>
      <div class="filter-actions">
        <button id="lat-apply" class="btn-accent">Apply</button>
        <button class="btn-reset" id="lat-reset">Reset</button>
      </div>
    </div>
    <div id="lat-content"><p class="empty">Select a host to see latest data.</p></div>
  `;

  if (_timer) clearInterval(_timer);
  window.addEventListener('hashchange', () => clearInterval(_timer), { once: true });

  _tagFilter = tagFilter(document.getElementById('lat-tag-filter'), null);

  const groups = await call('hostgroup.get', { output: ['groupid', 'name'], sortfield: 'name' }).catch(() => []);
  _msGroups = multiselect(
    document.getElementById('lat-ms-groups'), groups, onGroupChange,
    { idField: 'groupid', nameField: 'name', placeholder: 'Add group…' }
  );

  const presetHostId = hostidFromHash();
  const allHosts = await call('host.get', { output: ['hostid', 'name'], monitored_hosts: true, sortfield: 'name' }).catch(() => []);
  _msHosts = multiselect(
    document.getElementById('lat-ms-hosts'), allHosts, null,
    { idField: 'hostid', nameField: 'name', placeholder: 'Add host…',
      selectedIds: presetHostId ? [presetHostId] : [] }
  );

  if (presetHostId) await applyFilters();

  document.getElementById('lat-search').addEventListener('input', filterTable);
  document.querySelectorAll('input[name="lat-state"]').forEach(r =>
    r.addEventListener('change', filterTable)
  );
  document.getElementById('lat-details').addEventListener('change', toggleDetails);
  document.getElementById('lat-nodata').addEventListener('change', filterTable);
  document.getElementById('lat-apply').addEventListener('click', applyFilters);
  document.getElementById('lat-reset').addEventListener('click', resetFilters);
}

async function onGroupChange() {
  if (!_msHosts) return;
  const groupIds = _msGroups?.getIds() ?? [];
  const params = { output: ['hostid', 'name'], monitored_hosts: true, sortfield: 'name' };
  if (groupIds.length) params.groupids = groupIds;
  const hosts = await call('host.get', params).catch(() => []);
  _msHosts.setItems(hosts);
}

async function applyFilters() {
  const hostIds = _msHosts?.getIds() ?? [];
  if (_timer) clearInterval(_timer);
  if (!hostIds.length) {
    document.getElementById('lat-content').innerHTML =
      '<p class="empty">Select a host to see latest data.</p>';
    return;
  }
  await loadData(hostIds);
  _timer = setInterval(() => {
    const ids = _msHosts?.getIds() ?? [];
    if (ids.length) loadData(ids); else clearInterval(_timer);
  }, 30_000);
}

function resetFilters() {
  _msGroups?.reset();
  _msHosts?.reset();
  document.getElementById('lat-search').value = '';
  document.getElementById('lat-details').checked = false;
  document.getElementById('lat-nodata').checked = true;
  const allRadio = document.querySelector('input[name="lat-state"][value=""]');
  if (allRadio) allRadio.checked = true;
  _tagFilter?.reset();
  if (_timer) { clearInterval(_timer); _timer = null; }
  document.getElementById('lat-content').innerHTML =
    '<p class="empty">Select a host to see latest data.</p>';
}

async function loadData(hostIds) {
  const el = document.getElementById('lat-content');
  if (!el) { clearInterval(_timer); return; }
  if (!el.querySelector('table')) el.innerHTML = '<p class="loading">Loading…</p>';

  const stateEl  = document.querySelector('input[name="lat-state"]:checked');
  const stateVal = stateEl ? stateEl.value : '';

  try {
    const params = {
      hostids:   hostIds,
      output:    ['itemid', 'name', 'key_', 'value_type', 'units', 'delay',
                  'lastclock', 'lastvalue', 'prevvalue', 'state', 'name_resolved'],
      selectTags: ['tag', 'value'],
      sortfield:  'name',
      limit:      2000,
    };
    if (stateVal !== '') params.filter = { state: parseInt(stateVal) };

    const items = await call('item.get', params);

    // Re-render table + mass bar
    _selected.clear();
    el.innerHTML = renderTable(items);
    el.insertAdjacentHTML('beforeend', `
      <div id="lat-mass-bar" class="lat-mass-bar">
        <button id="lat-btn-graph" class="btn-alt" disabled>Display graph</button>
        <button id="lat-btn-stacked" class="btn-alt" disabled>Display stacked graph</button>
      </div>
    `);

    document.getElementById('lat-updated').textContent =
      'Updated ' + new Date().toLocaleTimeString();

    // Wire up select-all checkbox
    document.getElementById('lat-chk-all')?.addEventListener('change', e => {
      el.querySelectorAll('#lat-table .lat-chk-row').forEach(c => {
        if (c.closest('tr').style.display !== 'none') c.checked = e.target.checked;
      });
      updateMassBar();
    });

    // Wire up row checkboxes
    el.querySelectorAll('.lat-chk-row').forEach(c => {
      c.addEventListener('change', updateMassBar);
      c.addEventListener('click', e => e.stopPropagation());
    });

    // Wire up mass action buttons
    document.getElementById('lat-btn-graph').addEventListener('click', () => {
      const ids = [..._selected].join(',');
      if (ids) navigate(`/item?itemids=${ids}`);
    });
    document.getElementById('lat-btn-stacked').addEventListener('click', () => {
      const ids = [..._selected].join(',');
      if (ids) navigate(`/item?itemids=${ids}&stacked=1`);
    });

    toggleDetails();
    filterTable();

    // Row click → single item graph
    el.querySelectorAll('tr[data-itemid]').forEach(tr => {
      const vt = parseInt(tr.dataset.vt);
      if (vt === 0 || vt === 3) {
        tr.classList.add('clickable');
        tr.addEventListener('click', () => navigate(`/item?itemid=${tr.dataset.itemid}`));
      }
    });
  } catch (e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderTable(items) {
  if (!items.length) return '<p class="empty">No items.</p>';
  const rows = items.map(item => {
    const vt    = parseInt(item.value_type);
    const isNum = vt === 0 || vt === 3;
    const lv    = item.lastvalue ?? '';
    const lc    = item.lastclock && item.lastclock !== '0'
      ? new Date(parseInt(item.lastclock) * 1000).toLocaleString()
      : '—';
    const val   = isNum && lv !== '' ? fmtNum(parseFloat(lv), item.units) : esc(String(lv));
    const stale = item.lastclock && (Date.now() / 1000 - parseInt(item.lastclock)) > 600;
    const state = parseInt(item.state);
    const pv    = item.prevvalue ?? '';
    let change  = '—';
    if (isNum && lv !== '' && pv !== '') {
      const diff = parseFloat(lv) - parseFloat(pv);
      change = (diff >= 0 ? '+' : '') + fmtNum(diff, item.units);
    }
    const tags    = (item.tags || []).map(t =>
      `<span class="tag">${esc(t.tag)}${t.value ? ': ' + esc(t.value) : ''}</span>`
    ).join('');
    const rawTags = (item.tags || []).map(t => ({ tag: t.tag, value: t.value || '' }));
    return `
      <tr data-itemid="${esc(item.itemid)}" data-vt="${vt}"
          data-name="${esc((item.name_resolved || item.name).toLowerCase())}"
          data-rawtags="${esc(JSON.stringify(rawTags))}"
          data-hasdata="${item.lastclock && item.lastclock !== '0' ? '1' : '0'}"
          class="${state === 1 ? 'row-unsupported' : ''}">
        <td style="width:16px;padding-right:0">
          <input type="checkbox" class="lat-chk-row"
            data-itemid="${esc(item.itemid)}"
            ${isNum ? 'data-isgraph="1"' : ''}>
        </td>
        <td class="overflow-ellipsis">${esc(item.name_resolved || item.name)}${isNum ? `<a class="graph-link" href="#/item?itemid=${esc(item.itemid)}" onclick="event.stopPropagation()" title="View graph">↗</a>` : ''}</td>
        <td class="col-details" hidden><code class="muted">${esc(item.key_)}</code></td>
        <td class="col-details" hidden><span class="muted">${esc(item.delay || '')}</span></td>
        <td class="${stale ? 'muted' : ''}" style="white-space:nowrap">${lc}</td>
        <td class="val-cell${stale ? ' muted' : ''}" title="${esc(String(lv))}">${val}</td>
        <td class="muted" style="font-size:0.82rem;white-space:nowrap">${esc(change)}</td>
        <td class="tags-cell">${tags}</td>
      </tr>
    `;
  }).join('');
  return `
    <table class="data-table" id="lat-table">
      <thead>
        <tr>
          <th style="width:16px;padding-right:0"><input type="checkbox" id="lat-chk-all" title="Select all"></th>
          <th style="width:38%">Name</th>
          <th class="col-details" hidden>Key</th>
          <th class="col-details" hidden>Interval</th>
          <th style="width:13%">Last check</th>
          <th style="width:13%">Last value</th>
          <th style="width:10%">Change</th>
          <th>Tags</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function updateMassBar() {
  _selected.clear();
  document.querySelectorAll('#lat-table .lat-chk-row:checked[data-isgraph="1"]').forEach(c => {
    _selected.add(c.dataset.itemid);
  });
  const n    = _selected.size;
  const btnG = document.getElementById('lat-btn-graph');
  const btnS = document.getElementById('lat-btn-stacked');
  if (btnG) btnG.disabled = n < 1;
  if (btnS) btnS.disabled = n < 2;
}

function toggleDetails() {
  const show = document.getElementById('lat-details')?.checked;
  document.querySelectorAll('#lat-table .col-details').forEach(el => {
    el.hidden = !show;
  });
}

function filterTable() {
  const q      = document.getElementById('lat-search')?.value.toLowerCase() || '';
  const nodata = document.getElementById('lat-nodata')?.checked ?? true;
  document.querySelectorAll('#lat-table tr[data-itemid]').forEach(tr => {
    const nameOk = !q || tr.dataset.name.includes(q);
    const dataOk = nodata || tr.dataset.hasdata === '1';
    let tagOk = true;
    if (_tagFilter && !_tagFilter.isEmpty()) {
      const rawTags = tr.dataset.rawtags ? JSON.parse(tr.dataset.rawtags) : [];
      tagOk = _tagFilter.matches(rawTags);
    }
    tr.style.display = (nameOk && tagOk && dataOk) ? '' : 'none';
  });
}

function fmtNum(v, units) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  let s, u = units || '';
  if      (abs >= 1e9) { s = (v / 1e9).toFixed(2); u = 'G' + u; }
  else if (abs >= 1e6) { s = (v / 1e6).toFixed(2); u = 'M' + u; }
  else if (abs >= 1e3) { s = (v / 1e3).toFixed(2); u = 'K' + u; }
  else                 { s = v.toFixed(abs < 1 ? 4 : 2); }
  return esc(s + (u ? ' ' + u : ''));
}
