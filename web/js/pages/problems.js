import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';
import { tagFilter } from '../utils/tag-filter.js';
import { pagination } from '../utils/pagination.js';

const SEVERITY  = ['Not classified', 'Information', 'Warning', 'Average', 'High', 'Disaster'];
const SEV_CLASS = ['sev-nc', 'sev-info', 'sev-warn', 'sev-avg', 'sev-high', 'sev-dis'];
const LS_KEY    = 'zbx.filter.problems';
const PAGE_SIZE = 100;
let _tagFilter  = null;
let _sortField  = 'eventid';
let _sortOrder  = 'DESC';
let _lastProblems = [];
let _pager = null;

function saveFilters() {
  const f = {
    group:   document.getElementById('prob-group')?.value    || '',
    sev:     document.getElementById('sev-filter')?.value   || '0',
    age:     document.getElementById('prob-age')?.value      || '',
    ageUnit: document.getElementById('prob-age-unit')?.value || '3600',
    unacked: document.getElementById('unacked-only')?.checked ? '1' : '0',
    maint:   document.getElementById('show-maintenance')?.checked ? '1' : '0',
  };
  localStorage.setItem(LS_KEY, JSON.stringify(f));
}

function restoreFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const el = id => document.getElementById(id);
    if (f.group   && el('prob-group'))        el('prob-group').value        = f.group;
    if (f.sev     && el('sev-filter'))        el('sev-filter').value        = f.sev;
    if (f.age     && el('prob-age'))          el('prob-age').value          = f.age;
    if (f.ageUnit && el('prob-age-unit'))     el('prob-age-unit').value     = f.ageUnit;
    if (el('unacked-only'))      el('unacked-only').checked      = f.unacked === '1';
    if (f.maint !== undefined && el('show-maintenance'))
                                 el('show-maintenance').checked  = f.maint !== '0';
  } catch (_) {}
}

function minSevFromHash() {
  const m = location.hash.match(/[?&]severity=(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

function hostidFromHash() {
  const m = location.hash.match(/[?&]hostid=(\d+)/);
  return m ? m[1] : '';
}

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Problems</h2>
    </div>
    <div class="filter-panel" id="prob-filter-panel"></div>
    <div id="prob-mass-form" hidden></div>
    <div id="prob-content"><p class="loading">Loading…</p></div>
    <div id="prob-pager"></div>
  `;
  _pager = pagination({ pageSize: PAGE_SIZE, onPage: loadProblems });
  _pager.render(document.getElementById('prob-pager'));
  await renderFilterPanel(minSevFromHash());
  await loadProblems();
}

async function renderFilterPanel(initSev = 0) {
  const fp = document.getElementById('prob-filter-panel');

  const groups = await call('hostgroup.get', { output: ['groupid', 'name'] }).catch(() => []);
  const groupOpts = groups.map(g =>
    `<option value="${esc(g.groupid)}">${esc(g.name)}</option>`
  ).join('');

  fp.innerHTML = `
    <div class="filter-row">
      <select id="prob-group"><option value="">All groups</option>${groupOpts}</select>
      <select id="prob-host" disabled><option value="">All hosts</option></select>
      <input id="prob-name" type="search" placeholder="Problem name…">
      <label>Min severity:
        <select id="sev-filter">
          ${SEVERITY.map((s, i) => `<option value="${i}"${i === initSev ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
      </label>
      <label>Age less than:
        <input id="prob-age" type="number" min="1" style="width:50px" placeholder="—">
        <select id="prob-age-unit">
          <option value="60">m</option>
          <option value="3600" selected>h</option>
          <option value="86400">d</option>
        </select>
      </label>
      <label><input type="checkbox" id="unacked-only"> Unacknowledged</label>
      <label><input type="checkbox" id="show-maintenance" checked> Show maintenance</label>
      <button id="prob-refresh">↻ Refresh</button>
      <button id="prob-csv" class="btn-small" title="Export visible rows to CSV">CSV</button>
      <button class="btn-reset" id="prob-reset" title="Reset filters">Reset</button>
    </div>
    <div id="prob-tag-filter" style="margin-top:6px"></div>
    <div class="filter-actions" id="prob-mass-bar" hidden>
      <span id="prob-mass-count" class="muted" style="font-size:0.85rem"></span>
      <button id="prob-mass-ack-btn" class="btn-small">Mass acknowledge</button>
    </div>
  `;

  function filterLoad() { saveFilters(); _pager?.reset(); loadProblems(); }
  restoreFilters();
  document.getElementById('prob-group').addEventListener('change', () => { saveFilters(); _pager?.reset(); onGroupChange(); });
  document.getElementById('prob-host').addEventListener('change', filterLoad);
  document.getElementById('prob-name').addEventListener('input', filterByName);
  document.getElementById('sev-filter').addEventListener('change', filterLoad);
  document.getElementById('prob-age').addEventListener('change', filterLoad);
  document.getElementById('prob-age-unit').addEventListener('change', filterLoad);
  document.getElementById('unacked-only').addEventListener('change', filterLoad);
  document.getElementById('show-maintenance').addEventListener('change', () => { saveFilters(); filterByName(); });
  document.getElementById('prob-refresh').addEventListener('click', loadProblems);
  document.getElementById('prob-csv').addEventListener('click', exportCsv);
  document.getElementById('prob-reset').addEventListener('click', resetFilters);
  _tagFilter = tagFilter(document.getElementById('prob-tag-filter'), () => { _pager?.reset(); loadProblems(); });
  document.getElementById('prob-mass-ack-btn').addEventListener('click', showMassAckForm);
}

function resetFilters() {
  const el = id => document.getElementById(id);
  el('prob-group').value = '';
  el('prob-host').innerHTML = '<option value="">All hosts</option>';
  el('prob-host').disabled = true;
  el('prob-name').value = '';
  el('sev-filter').value = '0';
  el('prob-age').value = '';
  el('prob-age-unit').value = '3600';
  el('unacked-only').checked = false;
  el('show-maintenance').checked = true;
  _tagFilter?.reset();
  loadProblems();
}

async function onGroupChange() {
  const groupid = document.getElementById('prob-group')?.value;
  const hostSel = document.getElementById('prob-host');
  if (!hostSel) return;

  hostSel.innerHTML = '<option value="">All hosts</option>';
  hostSel.disabled = true;

  if (groupid) {
    const hosts = await call('host.get', {
      output: ['hostid', 'name'],
      groupids: [groupid],
      monitored_hosts: true,
    }).catch(() => []);
    hosts.forEach(h => {
      const o = document.createElement('option');
      o.value = h.hostid; o.textContent = h.name || h.host;
      hostSel.appendChild(o);
    });
    hostSel.disabled = false;
  }

  await loadProblems();
}

async function loadProblems() {
  const el = document.getElementById('prob-content');
  if (!el) return;
  el.innerHTML = '<p class="loading">Loading…</p>';
  hideMassAckForm();

  const minSev      = parseInt(document.getElementById('sev-filter')?.value ?? 0);
  const unackedOnly = document.getElementById('unacked-only')?.checked ?? false;
  const groupid     = document.getElementById('prob-group')?.value;
  const hostid      = document.getElementById('prob-host')?.value || hostidFromHash();
  const ageVal      = parseInt(document.getElementById('prob-age')?.value || '') || 0;
  const ageUnit     = parseInt(document.getElementById('prob-age-unit')?.value || 3600);
  const severities  = Array.from({ length: 6 - minSev }, (_, i) => i + minSev);

  try {
    const params = {
      output: 'extend',
      severities,
      selectTags: ['tag', 'value'],
      sortfield: [_sortField], sortorder: _sortOrder,
      limit: PAGE_SIZE,
      offset: _pager ? _pager.current() : 0,
    };
    if (unackedOnly)   params.acknowledged = false;
    if (groupid)       params.groupids = [groupid];
    if (hostid)        params.hostids  = [hostid];
    if (ageVal > 0)    params.time_from = Math.floor(Date.now() / 1000) - ageVal * ageUnit;
    if (_tagFilter && !_tagFilter.isEmpty()) {
      const tp = _tagFilter.getApiParams();
      if (tp.tags?.length) { params.tags = tp.tags; params.evaltype = tp.evaltype; }
    }

    const problems = await call('problem.get', params);

    if (!problems.length) {
      _lastProblems = [];
      el.innerHTML = '<p class="empty">No problems found.</p>';
      return;
    }

    const trigIds = [...new Set(problems.map(p => p.objectid))];
    const hostMap = await resolveTriggerHosts(trigIds);
    problems.forEach(p => {
      const info = hostMap[p.objectid] || {};
      p._host = info.name || '';
      p._maintenance = info.maintenance || false;
      p._opdata = info.opdata || '';
    });
    _lastProblems = problems;

    el.innerHTML = renderTable(problems);
    el.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const f = th.dataset.field;
        if (_sortField === f) _sortOrder = _sortOrder === 'DESC' ? 'ASC' : 'DESC';
        else { _sortField = f; _sortOrder = 'DESC'; }
        loadProblems();
      });
    });
    attachAckHandlers(el);
    attachCheckboxHandlers(el);
    el.querySelectorAll('tr[data-eventid]').forEach(tr => {
      tr.addEventListener('click', () => navigate(`/events/${tr.dataset.eventid}`));
    });

    filterByName();
  } catch (e) {
    el.innerHTML = `<p class="error">Failed to load: ${esc(e.message)}</p>`;
  }
}

async function resolveTriggerHosts(triggerIds) {
  if (!triggerIds.length) return {};
  const triggers = await call('trigger.get', {
    triggerids: triggerIds,
    output: ['triggerid', 'opdata'],
    selectHosts: ['hostid', 'name', 'maintenance_status'],
    preservekeys: true,
  }).catch(() => ({}));
  const map = {};
  for (const [tid, t] of Object.entries(triggers)) {
    const h = t.hosts?.[0];
    if (h) map[tid] = { name: h.name || h.host, maintenance: parseInt(h.maintenance_status) === 1, opdata: t.opdata || '' };
  }
  return map;
}

function filterByName() {
  const q         = document.getElementById('prob-name')?.value.toLowerCase() || '';
  const showMaint = document.getElementById('show-maintenance')?.checked ?? true;
  document.querySelectorAll('#prob-content tr[data-eventid]').forEach(tr => {
    const show = (!q || tr.dataset.name?.includes(q)) &&
                 (showMaint || tr.dataset.maint !== '1');
    tr.style.display = show ? '' : 'none';
    const next = tr.nextElementSibling;
    if (next?.classList.contains('ack-form-row') && !show) {
      next.style.display = 'none';
    }
  });
}

function renderTable(problems) {
  const now = Math.floor(Date.now() / 1000);
  const rows = problems.map(p => {
    const sev      = parseInt(p.severity);
    const resolved = p.r_eventid && p.r_eventid !== '0';
    const rClock   = resolved ? parseInt(p.r_clock) : 0;
    const duration = resolved
      ? fmtAge(rClock - parseInt(p.clock))
      : fmtAge(now - parseInt(p.clock));
    const acked    = p.acknowledged === '1' || p.acknowledged === 1;
    const tags     = (p.tags || []).map(t =>
      `<span class="tag">${esc(t.tag)}${t.value ? ': ' + esc(t.value) : ''}</span>`
    ).join('');
    const nameSearch = (p._host + ' ' + p.name).toLowerCase();
    const timeStr    = new Date(parseInt(p.clock) * 1000).toLocaleString();
    return `
      <tr class="${SEV_CLASS[sev] || ''} clickable${resolved ? ' row-resolved' : ''}" data-eventid="${esc(p.eventid)}"
          data-name="${esc(nameSearch)}"
          data-maint="${p._maintenance ? '1' : '0'}">
        <td class="cb-cell" onclick="event.stopPropagation()">
          <input type="checkbox" class="prob-cb" data-eventid="${esc(p.eventid)}">
        </td>
        <td class="muted" style="white-space:nowrap;font-size:0.82rem">${esc(timeStr)}</td>
        <td class="sev-cell">${esc(SEVERITY[sev] || sev)}</td>
        <td class="host-col muted">${esc(p._host)}</td>
        <td class="prob-col">${esc(p.name)}${p._opdata ? ` <span class="opdata">(${esc(p._opdata)})</span>` : ''}</td>
        <td style="white-space:nowrap">${duration}${resolved ? ' <span class="badge-resolved">R</span>' : ''}</td>
        <td class="ack-cell" onclick="event.stopPropagation()">
          ${acked
            ? '<span class="acked" title="Acknowledged">✓</span>'
            : `<button class="btn-ack" data-eventid="${esc(p.eventid)}">Ack</button>`
          }
        </td>
        <td class="tags-cell">${tags}</td>
      </tr>
      <tr class="ack-form-row" id="ack-form-${esc(p.eventid)}" hidden>
        <td colspan="8">
          <div class="ack-form">
            <input type="text" class="ack-msg" placeholder="Message (optional)" data-eventid="${esc(p.eventid)}">
            <button class="btn-ack-submit" data-eventid="${esc(p.eventid)}">Confirm</button>
            <button class="btn-ack-cancel" data-eventid="${esc(p.eventid)}">Cancel</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  function sortTh(label, field) {
    const active = _sortField === field;
    const arrow  = active ? (_sortOrder === 'ASC' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-field="${field}" style="cursor:pointer">${label}${arrow}</th>`;
  }
  return `
    <table class="data-table">
      <thead>
        <tr>
          <th class="cb-cell"><input type="checkbox" id="prob-cb-all"></th>
          ${sortTh('Time','clock')}${sortTh('Severity','severity')}<th>Host</th><th>Problem</th><th>Duration</th><th>Ack</th><th>Tags</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function attachCheckboxHandlers(el) {
  document.getElementById('prob-cb-all')?.addEventListener('change', e => {
    el.querySelectorAll('.prob-cb').forEach(cb => { cb.checked = e.target.checked; });
    updateMassBar();
  });
  el.querySelectorAll('.prob-cb').forEach(cb => cb.addEventListener('change', updateMassBar));
}

function updateMassBar() {
  const checked = document.querySelectorAll('#prob-content .prob-cb:checked').length;
  const bar     = document.getElementById('prob-mass-bar');
  const count   = document.getElementById('prob-mass-count');
  if (bar) bar.hidden = checked === 0;
  if (count) count.textContent = checked ? `${checked} selected` : '';
}

function showMassAckForm() {
  const formEl = document.getElementById('prob-mass-form');
  if (!formEl) return;
  formEl.hidden = false;
  formEl.innerHTML = `
    <div class="inline-form" style="max-width:520px;margin-bottom:12px">
      <h3 style="margin:0 0 10px">Mass acknowledge</h3>
      <div class="form-grid">
        <label class="form-wide">Message
          <input id="mass-ack-msg" type="text" placeholder="Acknowledgement message (optional)">
        </label>
        <label>Action
          <select id="mass-ack-action">
            <option value="2">Acknowledge</option>
            <option value="6">Acknowledge + add message</option>
            <option value="1">Close problem</option>
          </select>
        </label>
      </div>
      <div class="form-actions">
        <button id="mass-ack-submit">Apply</button>
        <button id="mass-ack-cancel">Cancel</button>
        <span id="mass-ack-error" class="error" hidden></span>
      </div>
    </div>`;

  document.getElementById('mass-ack-cancel').onclick = hideMassAckForm;
  document.getElementById('mass-ack-submit').onclick = async () => {
    const ids = [...document.querySelectorAll('#prob-content .prob-cb:checked')].map(cb => cb.dataset.eventid);
    if (!ids.length) return;
    const action = parseInt(document.getElementById('mass-ack-action').value);
    const msg    = document.getElementById('mass-ack-msg').value.trim();
    const errEl  = document.getElementById('mass-ack-error');
    errEl.hidden = true;
    try {
      await call('event.acknowledge', { eventids: ids, action, message: msg });
      hideMassAckForm();
      await loadProblems();
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  };
}

function hideMassAckForm() {
  const formEl = document.getElementById('prob-mass-form');
  if (formEl) { formEl.hidden = true; formEl.innerHTML = ''; }
}

function attachAckHandlers(el) {
  el.querySelectorAll('.btn-ack').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const eid = btn.dataset.eventid;
      const formRow = document.getElementById(`ack-form-${eid}`);
      if (formRow) formRow.hidden = false;
      btn.disabled = true;
    });
  });

  el.querySelectorAll('.btn-ack-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const eid = btn.dataset.eventid;
      const formRow = document.getElementById(`ack-form-${eid}`);
      if (formRow) formRow.hidden = true;
      const ackBtn = el.querySelector(`.btn-ack[data-eventid="${eid}"]`);
      if (ackBtn) ackBtn.disabled = false;
    });
  });

  el.querySelectorAll('.btn-ack-submit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const eid = btn.dataset.eventid;
      const msg = el.querySelector(`.ack-msg[data-eventid="${eid}"]`)?.value || '';
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await call('event.acknowledge', {
          eventids: [eid],
          action: 6,
          message: msg,
        });
        const row = el.querySelector(`tr[data-eventid="${eid}"]`);
        const ackCell = row?.querySelector('.ack-cell');
        if (ackCell) ackCell.innerHTML = '<span class="acked" title="Acknowledged">✓</span>';
        const formRow = document.getElementById(`ack-form-${eid}`);
        if (formRow) formRow.hidden = true;
      } catch (e) {
        btn.textContent = 'Confirm';
        btn.disabled = false;
        alert(`Acknowledge failed: ${e.message}`);
      }
    });
  });
}

function exportCsv() {
  if (!_lastProblems.length) { alert('No problems to export.'); return; }
  const now = Math.floor(Date.now() / 1000);
  // only export visible rows
  const visibleIds = new Set();
  document.querySelectorAll('#prob-content tr[data-eventid]').forEach(tr => {
    if (tr.style.display !== 'none') visibleIds.add(tr.dataset.eventid);
  });
  const rows = _lastProblems.filter(p => visibleIds.has(p.eventid));
  if (!rows.length) { alert('No visible rows to export.'); return; }

  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Time','Severity','Host','Problem','Duration','Acknowledged','Tags'];
  const lines  = [header.join(',')];
  for (const p of rows) {
    const sev      = parseInt(p.severity);
    const resolved = p.r_eventid && p.r_eventid !== '0';
    const rClock   = resolved ? parseInt(p.r_clock) : 0;
    const dur      = fmtAge(resolved ? rClock - parseInt(p.clock) : now - parseInt(p.clock));
    const tags     = (p.tags || []).map(t => t.tag + (t.value ? ':' + t.value : '')).join('; ');
    lines.push([
      escape(new Date(parseInt(p.clock) * 1000).toLocaleString()),
      escape(SEVERITY[sev] || sev),
      escape(p._host),
      escape(p.name + (p._opdata ? ' (' + p._opdata + ')' : '')),
      escape(dur + (resolved ? ' [R]' : '')),
      escape(p.acknowledged === '1' ? 'Yes' : 'No'),
      escape(tags),
    ].join(','));
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `problems_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

function fmtAge(s) {
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
