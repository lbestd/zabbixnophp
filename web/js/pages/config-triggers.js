/**
 * Configuration › Triggers — global triggers list across all hosts
 * Route: #/config/triggers
 */
import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';
import { pagination } from '../utils/pagination.js';

const SEVERITY  = ['Not classified', 'Information', 'Warning', 'Average', 'High', 'Disaster'];
const SEV_CLASS = ['sev-nc', 'sev-info', 'sev-warn', 'sev-avg', 'sev-high', 'sev-dis'];
const STATUS_LABEL = ['Enabled', 'Disabled'];

const LS_KEY    = 'zbx.filter.config-triggers';
const PAGE_SIZE = 100;

let _sortField = 'description';
let _sortOrder = 'ASC';
let _pager     = null;

function saveFilters() {
  const f = {
    group:  document.getElementById('ct-group')?.value  || '',
    host:   document.getElementById('ct-host')?.value   || '',
    search: document.getElementById('ct-search')?.value || '',
    status: document.getElementById('ct-status')?.value || '',
    sev:    document.getElementById('ct-sev')?.value    || '',
  };
  localStorage.setItem(LS_KEY, JSON.stringify(f));
}

function restoreFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const el = id => document.getElementById(id);
    if (f.group  && el('ct-group'))  el('ct-group').value  = f.group;
    if (f.host   && el('ct-host'))   el('ct-host').value   = f.host;
    if (f.search && el('ct-search')) el('ct-search').value = f.search;
    if (f.status && el('ct-status')) el('ct-status').value = f.status;
    if (f.sev    && el('ct-sev'))    el('ct-sev').value    = f.sev;
  } catch (_) {}
}

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Triggers</h2>
    </div>
    <div class="filter-panel">
      <div class="filter-row">
        <select id="ct-group"><option value="">All groups</option></select>
        <select id="ct-host" disabled><option value="">All hosts</option></select>
        <input id="ct-search" type="search" placeholder="Search name…">
        <select id="ct-status">
          <option value="">Any status</option>
          <option value="0">Enabled</option>
          <option value="1">Disabled</option>
        </select>
        <select id="ct-sev">
          <option value="">Any severity</option>
          ${SEVERITY.map((s,i)=>`<option value="${i}">${s}</option>`).join('')}
        </select>
        <button class="btn-reset" id="ct-reset" title="Reset filters">Reset</button>
      </div>
    </div>
    <div id="ct-mass-bar" hidden style="display:flex;gap:4px;align-items:center;margin-bottom:0.5rem">
      <button id="ct-mass-enable"  class="btn-small">Enable</button>
      <button id="ct-mass-disable" class="btn-small">Disable</button>
      <button id="ct-mass-delete"  class="btn-small btn-danger">Delete</button>
    </div>
    <div id="ct-content"><p class="loading">Loading…</p></div>
    <div id="ct-pager"></div>
  `;

  _pager = pagination({ pageSize: PAGE_SIZE, onPage: loadTriggers });
  _pager.render(document.getElementById('ct-pager'));
  await loadGroups();
  restoreFilters();

  function filterLoad() { saveFilters(); _pager?.reset(); loadTriggers(); }
  const sel = id => document.getElementById(id);
  sel('ct-group').addEventListener('change', () => { saveFilters(); _pager?.reset(); onGroupChange(); });
  sel('ct-host').addEventListener('change',  filterLoad);
  sel('ct-search').addEventListener('input', () => { saveFilters(); filterRows(); });
  sel('ct-status').addEventListener('change',() => { saveFilters(); filterRows(); });
  sel('ct-sev').addEventListener('change',   () => { saveFilters(); filterRows(); });
  sel('ct-reset').addEventListener('click',  resetFilters);
  sel('ct-mass-enable').addEventListener('click',  () => massAction('enable'));
  sel('ct-mass-disable').addEventListener('click', () => massAction('disable'));
  sel('ct-mass-delete').addEventListener('click',  () => massAction('delete'));

  await loadTriggers();
}

async function loadGroups() {
  const groups = await call('hostgroup.get', { output: ['groupid','name'] }).catch(() => []);
  const sel = document.getElementById('ct-group');
  if (!sel) return;
  groups.forEach(g => {
    const o = document.createElement('option');
    o.value = g.groupid; o.textContent = g.name;
    sel.appendChild(o);
  });
}

async function onGroupChange() {
  saveFilters();
  const groupid = document.getElementById('ct-group')?.value;
  const hostSel = document.getElementById('ct-host');
  if (!hostSel) return;
  hostSel.innerHTML = '<option value="">All hosts</option>';
  hostSel.disabled = true;
  if (groupid) {
    const hosts = await call('host.get', {
      output: ['hostid','name'], groupids: [groupid],
    }).catch(() => []);
    hosts.forEach(h => {
      const o = document.createElement('option');
      o.value = h.hostid; o.textContent = h.name || h.host;
      hostSel.appendChild(o);
    });
    hostSel.disabled = false;
  }
  await loadTriggers();
}

function resetFilters() {
  const el = id => document.getElementById(id);
  el('ct-group').value = ''; el('ct-host').innerHTML = '<option value="">All hosts</option>';
  el('ct-host').disabled = true; el('ct-search').value = '';
  el('ct-status').value = ''; el('ct-sev').value = '';
  localStorage.removeItem(LS_KEY);
  loadTriggers();
}

let _allTriggers = [];

async function loadTriggers() {
  const el = document.getElementById('ct-content');
  if (!el) return;
  el.innerHTML = '<p class="loading">Loading…</p>';

  const groupid = document.getElementById('ct-group')?.value;
  const hostid  = document.getElementById('ct-host')?.value;

  const params = {
    output: ['triggerid','description','expression','status','priority','value','flags'],
    selectHosts: ['hostid','name'],
    expandExpression: true,
    sortfield: _sortField,
    sortorder: _sortOrder,
    limit: PAGE_SIZE,
    offset: _pager ? _pager.current() : 0,
  };
  if (groupid) params.groupids = [groupid];
  if (hostid)  params.hostids  = [hostid];

  try {
    _allTriggers = await call('trigger.get', params);
    renderTable(el);
  } catch(e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderTable(el) {
  const search = document.getElementById('ct-search')?.value.toLowerCase() || '';
  const status = document.getElementById('ct-status')?.value;
  const sev    = document.getElementById('ct-sev')?.value;

  const filtered = _allTriggers.filter(t => {
    if (search && !(t.description||'').toLowerCase().includes(search)) return false;
    if (status !== '' && status !== undefined && t.status !== status) return false;
    if (sev    !== '' && sev    !== undefined && t.priority !== sev)  return false;
    return true;
  });

  if (!filtered.length) { el.innerHTML = '<p class="empty">No triggers found.</p>'; return; }

  const rows = filtered.map(t => {
    const sev  = parseInt(t.priority);
    const host = (t.hosts||[])[0];
    const expr = (t.expression||'').length > 60
      ? t.expression.slice(0,60)+'…' : t.expression;
    return `
      <tr data-id="${esc(t.triggerid)}" data-status="${esc(t.status)}" data-sev="${esc(t.priority)}">
        <td class="cb-cell" onclick="event.stopPropagation()">
          <input type="checkbox" class="ct-cb" data-id="${esc(t.triggerid)}">
        </td>
        <td>
          ${host ? `<a href="#/hosts/${esc(host.hostid)}/triggers" onclick="event.stopPropagation()">${esc(host.name||host.host)}</a>` : '—'}
        </td>
        <td>
          <a href="#/hosts/${esc(host?.hostid||0)}/triggers/${esc(t.triggerid)}"
             onclick="event.stopPropagation()">${esc(t.description)}</a>
        </td>
        <td class="val-cell" title="${esc(t.expression)}">${esc(expr)}</td>
        <td><span class="badge ${SEV_CLASS[sev]}">${SEVERITY[sev]||sev}</span></td>
        <td class="${parseInt(t.status)===0?'':'status-dis'}">${STATUS_LABEL[parseInt(t.status)]||t.status}</td>
        <td class="row-actions" onclick="event.stopPropagation()">
          <button class="btn-small ct-toggle" data-id="${esc(t.triggerid)}" data-status="${esc(t.status)}">
            ${parseInt(t.status)===0?'Disable':'Enable'}
          </button>
          <button class="btn-small btn-danger ct-del" data-id="${esc(t.triggerid)}" data-name="${esc(t.description)}">Del</button>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th class="cb-cell"><input type="checkbox" id="ct-cb-all"></th>
          <th class="sortable" data-field="hostname">Host</th>
          <th class="sortable" data-field="description">Name</th>
          <th>Expression</th>
          <th class="sortable" data-field="priority">Severity</th>
          <th class="sortable" data-field="status">Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  // sort headers
  el.querySelectorAll('th.sortable').forEach(th => {
    th.style.cursor = 'pointer';
    if (th.dataset.field === _sortField) th.classList.add(_sortOrder === 'ASC' ? 'sort-asc' : 'sort-desc');
    th.addEventListener('click', () => {
      if (_sortField === th.dataset.field) _sortOrder = _sortOrder === 'ASC' ? 'DESC' : 'ASC';
      else { _sortField = th.dataset.field; _sortOrder = 'ASC'; }
      loadTriggers();
    });
  });

  // select-all checkbox
  document.getElementById('ct-cb-all').addEventListener('change', e => {
    el.querySelectorAll('.ct-cb').forEach(c => c.checked = e.target.checked);
    updateMassBar();
  });
  el.querySelectorAll('.ct-cb').forEach(c => c.addEventListener('change', updateMassBar));

  el.querySelectorAll('.ct-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newStatus = parseInt(btn.dataset.status) === 0 ? 1 : 0;
      try {
        await call('trigger.update', { triggerid: btn.dataset.id, status: newStatus });
        await loadTriggers();
      } catch(e) { alert(e.message); }
    });
  });

  el.querySelectorAll('.ct-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete trigger "${btn.dataset.name}"?`)) return;
      try {
        await call('trigger.delete', [btn.dataset.id]);
        await loadTriggers();
      } catch(e) { alert(e.message); }
    });
  });
}

function filterRows() {
  const el = document.getElementById('ct-content');
  if (!el) return;
  renderTable(el);
}

function updateMassBar() {
  const bar = document.getElementById('ct-mass-bar');
  if (!bar) return;
  const checked = document.querySelectorAll('.ct-cb:checked').length;
  bar.hidden = checked === 0;
}

async function massAction(action) {
  const ids = Array.from(document.querySelectorAll('.ct-cb:checked')).map(c => c.dataset.id);
  if (!ids.length) return;
  if (action === 'delete' && !confirm(`Delete ${ids.length} trigger(s)?`)) return;
  try {
    if (action === 'enable' || action === 'disable') {
      const status = action === 'enable' ? 0 : 1;
      for (const id of ids) await call('trigger.update', { triggerid: id, status });
    }
    if (action === 'delete') await call('trigger.delete', ids);
    await loadTriggers();
  } catch(e) { alert(e.message); }
}
