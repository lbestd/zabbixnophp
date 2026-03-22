import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';
import { groupPicker } from '../utils/group-picker.js';
import { tagFilter } from '../utils/tag-filter.js';
import { pagination } from '../utils/pagination.js';

const STATUS_LABEL = ['Monitored', 'Unmonitored'];
const AVAIL  = ['unknown', 'ok', 'dis'];
const IFACE_TYPE = {1:'ZBX', 2:'SNMP', 3:'IPMI', 4:'JMX'};
const SEV_CLASS  = ['sev-nc', 'sev-info', 'sev-warn', 'sev-avg', 'sev-high', 'sev-dis'];
const LS_KEY    = 'zbx.filter.hosts';
const PAGE_SIZE = 100;
let _tagFilter  = null;
let _sortField  = 'name';
let _sortOrder  = 'ASC';
let _pager      = null;

function saveFilters() {
  const f = {
    search: document.getElementById('host-search')?.value  || '',
    group:  document.getElementById('group-filter')?.value || '',
    status: document.getElementById('status-filter')?.value || '',
    maint:  document.getElementById('host-show-maint')?.checked ? '1' : '0',
  };
  localStorage.setItem(LS_KEY, JSON.stringify(f));
}

function restoreFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const el = id => document.getElementById(id);
    if (f.search && el('host-search'))  el('host-search').value  = f.search;
    if (f.group  && el('group-filter')) el('group-filter').value = f.group;
    if (f.status && el('status-filter')) el('status-filter').value = f.status;
    if (f.maint !== undefined && el('host-show-maint'))
      el('host-show-maint').checked = f.maint !== '0';
  } catch (_) {}
}

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Hosts</h2>
      <div class="toolbar">
        <button id="host-create-btn">+ New host</button>
      </div>
    </div>
    <div class="filter-panel">
      <div class="filter-row">
        <input id="host-search" type="search" placeholder="Search…">
        <select id="group-filter"><option value="">All groups</option></select>
        <select id="status-filter">
          <option value="">Any status</option>
          <option value="0">Monitored</option>
          <option value="1">Unmonitored</option>
        </select>
        <label style="white-space:nowrap"><input type="checkbox" id="host-show-maint" checked> Show in maintenance</label>
        <button class="btn-reset" id="host-reset" title="Reset filters">Reset</button>
      </div>
      <div id="host-tag-filter" style="margin-top:6px"></div>
    </div>
    <div id="host-mass-wrap" style="margin-bottom:0.5rem">
      <span id="host-mass-bar" hidden style="display:flex;gap:4px;align-items:center">
        <button id="host-mass-enable" class="btn-small">Enable</button>
        <button id="host-mass-disable" class="btn-small">Disable</button>
        <button id="host-mass-delete" class="btn-small btn-danger">Delete</button>
      </span>
    </div>
    <div id="host-create-form" hidden></div>
    <div id="hosts-content"><p class="loading">Loading…</p></div>
    <div id="hosts-pager"></div>
  `;

  _pager = pagination({ pageSize: PAGE_SIZE, onPage: loadHosts });
  _pager.render(document.getElementById('hosts-pager'));
  loadGroups().then(restoreFilters);

  _tagFilter = tagFilter(document.getElementById('host-tag-filter'), filterHostRows);

  function filterLoad() { saveFilters(); _pager?.reset(); loadHosts(); }
  document.getElementById('host-search').addEventListener('input', filterLoad);
  document.getElementById('group-filter').addEventListener('change', filterLoad);
  document.getElementById('status-filter').addEventListener('change', filterLoad);
  document.getElementById('host-show-maint').addEventListener('change', () => { saveFilters(); filterHostRows(); });
  document.getElementById('host-create-btn').addEventListener('click', showCreateForm);
  document.getElementById('host-mass-enable').addEventListener('click', () => massHostAction('enable'));
  document.getElementById('host-mass-disable').addEventListener('click', () => massHostAction('disable'));
  document.getElementById('host-mass-delete').addEventListener('click', () => massHostAction('delete'));
  document.getElementById('host-reset').addEventListener('click', () => {
    document.getElementById('host-search').value = '';
    document.getElementById('group-filter').value = '';
    document.getElementById('status-filter').value = '';
    document.getElementById('host-show-maint').checked = true;
    _tagFilter?.reset();
    localStorage.removeItem(LS_KEY);
    _pager?.reset();
    loadHosts();
  });

  await loadHosts();
}

async function loadGroups() {
  const groups = await call('hostgroup.get', { output: ['groupid', 'name'] }).catch(() => []);
  const sel = document.getElementById('group-filter');
  if (!sel) return;
  groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.groupid;
    opt.textContent = g.name;
    sel.appendChild(opt);
  });
}

async function loadHosts() {
  const el = document.getElementById('hosts-content');
  if (!el) return;
  el.innerHTML = '<p class="loading">Loading…</p>';

  const search   = document.getElementById('host-search')?.value || '';
  const groupid  = document.getElementById('group-filter')?.value || '';
  const statusFl = document.getElementById('status-filter')?.value ?? '';

  const params = {
    output: ['hostid', 'host', 'name', 'status', 'maintenance_status'],
    sortfield: _sortField, sortorder: _sortOrder,
    selectInterfaces:      ['interfaceid', 'main', 'type', 'useip', 'ip', 'dns', 'port', 'available'],
    selectGroups:          ['groupid', 'name'],
    selectParentTemplates: ['templateid', 'name'],
    selectTags:            ['tag', 'value'],
    limit: PAGE_SIZE,
    offset: _pager ? _pager.current() : 0,
  };
  if (search)           params.search  = { name: search };
  if (groupid)          params.groupids = [groupid];
  if (statusFl !== '')  params.filter   = { status: [parseInt(statusFl)] };

  try {
    const hosts = await call('host.get', params);

    let probMap = {};
    if (hosts.length) {
      const probs = await call('problem.get', {
        hostids: hosts.map(h => h.hostid),
        output: ['eventid', 'severity'],
        selectHosts: ['hostid'],
        limit: 3000,
      }).catch(() => []);
      for (const p of probs) {
        const hid = p.hosts?.[0]?.hostid;
        if (!hid) continue;
        if (!probMap[hid]) probMap[hid] = {};
        const sev = parseInt(p.severity);
        probMap[hid][sev] = (probMap[hid][sev] || 0) + 1;
      }
    }

    el.innerHTML = renderTable(hosts, probMap);

    el.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const f = th.dataset.field;
        if (_sortField === f) _sortOrder = _sortOrder === 'ASC' ? 'DESC' : 'ASC';
        else { _sortField = f; _sortOrder = 'ASC'; }
        loadHosts();
      });
    });

    el.querySelectorAll('tr[data-hostid]').forEach(tr => {
      tr.addEventListener('click', () => navigate(`/hosts/${tr.dataset.hostid}/items`));
    });
    el.querySelectorAll('button[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete host "${btn.dataset.name}"?`)) return;
        try {
          await call('host.delete', { hostids: [btn.dataset.del] });
          await loadHosts();
        } catch(e) { alert(e.message); }
      });
    });
    document.getElementById('hosts-cb-all')?.addEventListener('change', e => {
      el.querySelectorAll('.host-cb').forEach(cb => { cb.checked = e.target.checked; });
      updateHostMassBar();
    });
    el.querySelectorAll('.host-cb').forEach(cb => cb.addEventListener('change', updateHostMassBar));

    filterHostRows();
  } catch (e) {
    el.innerHTML = `<p class="error">Failed to load: ${esc(e.message)}</p>`;
  }
}

function filterHostRows() {
  const showMaint = document.getElementById('host-show-maint')?.checked ?? true;
  document.querySelectorAll('#hosts-table tr[data-hostid]').forEach(tr => {
    const maintOk = showMaint || tr.dataset.maint !== '1';
    let tagOk = true;
    if (_tagFilter && !_tagFilter.isEmpty()) {
      const rawTags = tr.dataset.rawtags ? JSON.parse(tr.dataset.rawtags) : [];
      tagOk = _tagFilter.matches(rawTags);
    }
    tr.style.display = (maintOk && tagOk) ? '' : 'none';
  });
}

function availIcons(interfaces) {
  if (!interfaces?.length) return '<span class="muted">—</span>';
  const byType = {};
  for (const iface of interfaces) {
    const t = parseInt(iface.type);
    const prev = byType[t] ? parseInt(byType[t].available) : -1;
    const cur  = parseInt(iface.available);
    if (cur === 2 || prev === -1 || (prev !== 2 && cur !== 1)) byType[t] = iface;
    else if (cur === 1 && prev !== 2) byType[t] = iface;
  }
  const avLabels = ['?', 'ok', 'err'];
  return Object.entries(byType).sort((a,b) => a[0]-b[0]).map(([t, iface]) => {
    const avail  = parseInt(iface.available);
    const label  = IFACE_TYPE[t] || `T${t}`;
    const cls    = avail === 1 ? 'avail-ok' : avail === 2 ? 'avail-dis' : 'avail-unk';
    const addr   = iface.useip === '1' ? iface.ip : iface.dns;
    const tip    = `${label}: ${addr}:${iface.port} (${avLabels[avail]||'?'})`;
    return `<span class="avail-badge ${cls}" title="${esc(tip)}">${label}</span>`;
  }).join('');
}

async function showCreateForm() {
  const el = document.getElementById('host-create-form');
  if (!el) return;
  el.hidden = false;

  const allGroups = await call('hostgroup.get', { output: ['groupid','name'] }).catch(() => []);

  el.innerHTML = `
    <div class="inline-form">
      <h3>New host</h3>
      <div class="form-grid">
        <label>Host name *<input id="ch-host" placeholder="hostname"></label>
        <label>Visible name<input id="ch-name" placeholder="(optional)"></label>
        <label>IP address<input id="ch-ip" value="127.0.0.1"></label>
        <label>Port<input id="ch-port" value="10050"></label>
        <label>Status
          <select id="ch-status">
            <option value="0">Monitored</option>
            <option value="1">Unmonitored</option>
          </select>
        </label>
        <label class="form-wide">Groups<div id="ch-groups-picker"></div></label>
      </div>
      <div class="form-actions">
        <button id="ch-submit">Create</button>
        <button id="ch-cancel">Cancel</button>
        <span id="ch-error" class="error" hidden></span>
      </div>
    </div>`;

  const picker = groupPicker(document.getElementById('ch-groups-picker'), allGroups, []);

  document.getElementById('ch-cancel').onclick = () => { el.hidden = true; el.innerHTML = ''; };
  document.getElementById('ch-submit').onclick = async () => {
    const errEl = document.getElementById('ch-error');
    errEl.hidden = true;
    const host   = document.getElementById('ch-host').value.trim();
    const name   = document.getElementById('ch-name').value.trim();
    const ip     = document.getElementById('ch-ip').value.trim();
    const port   = document.getElementById('ch-port').value.trim();
    const status = parseInt(document.getElementById('ch-status').value);
    const groups = picker.getValue();
    if (!host) { errEl.textContent = 'Host name is required'; errEl.hidden = false; return; }
    try {
      const res = await call('host.create', {
        host, name, status, groups,
        interfaces: [{ type:1, main:1, useip:1, ip, dns:'', port }],
      });
      el.hidden = true; el.innerHTML = '';
      navigate(`/hosts/${res.hostids[0]}/items`);
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  };
}

function updateHostMassBar() {
  const checked = document.querySelectorAll('#hosts-table .host-cb:checked').length;
  const bar = document.getElementById('host-mass-bar');
  if (bar) bar.hidden = checked === 0;
}

async function massHostAction(action) {
  const ids = [...document.querySelectorAll('#hosts-table .host-cb:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  try {
    if (action === 'delete') {
      if (!confirm(`Delete ${ids.length} host(s)?`)) return;
      await call('host.delete', { hostids: ids });
    } else {
      const status = action === 'enable' ? 0 : 1;
      for (const id of ids) await call('host.update', { hostid: id, status });
    }
    await loadHosts();
  } catch(e) { alert(e.message); }
}

function probBadges(hostid, probMap) {
  const counts = probMap[hostid] || {};
  const badges = [5, 4, 3, 2, 1, 0]
    .filter(s => counts[s] > 0)
    .map(s => `<a class="prob-badge ${SEV_CLASS[s]}" href="#/problems?hostid=${esc(hostid)}&severity=${s}" onclick="event.stopPropagation()">${counts[s]}</a>`);
  return badges.length ? badges.join('') : '<span class="muted">—</span>';
}

function renderTable(hosts, probMap = {}) {
  if (!hosts.length) return '<p class="empty">No hosts found.</p>';
  const rows = hosts.map(h => {
    const groups    = (h.groups || []).map(g => esc(g.name)).join(', ');
    const templates = (h.parentTemplates || []).map(t => esc(t.name)).join(', ');
    const statusOk  = h.status === '0' || h.status === 0;
    const inMaint   = parseInt(h.maintenance_status) === 1;
    const rawTags   = (h.tags || []).map(t => ({ tag: t.tag, value: t.value || '' }));
    const tagsHtml  = rawTags.map(t =>
      `<span class="tag">${esc(t.tag)}${t.value ? ': ' + esc(t.value) : ''}</span>`
    ).join('');
    return `
      <tr data-hostid="${esc(h.hostid)}" class="clickable"
          data-maint="${inMaint ? '1' : '0'}"
          data-rawtags="${esc(JSON.stringify(rawTags))}">
        <td class="cb-cell" onclick="event.stopPropagation()"><input type="checkbox" class="host-cb" data-id="${esc(h.hostid)}"></td>
        <td>${esc(h.name || h.host)}${inMaint ? ' <span class="badge-tpl" title="In maintenance">M</span>' : ''}</td>
        <td style="white-space:nowrap">${availIcons(h.interfaces)}</td>
        <td class="${statusOk ? 'status-ok' : 'status-dis'}">${STATUS_LABEL[parseInt(h.status)] || h.status}</td>
        <td class="muted" style="font-size:0.82rem">${groups}</td>
        <td class="muted" style="font-size:0.82rem">${templates || '—'}</td>
        <td>${probBadges(h.hostid, probMap)}</td>
        <td class="tags-cell">${tagsHtml}</td>
        <td class="row-actions" onclick="event.stopPropagation()">
          <a class="btn-small" href="#/latest?hostid=${esc(h.hostid)}" onclick="event.stopPropagation()">Latest</a>
          <button class="btn-small btn-danger" data-del="${esc(h.hostid)}" data-name="${esc(h.name||h.host)}">Del</button>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <table class="data-table" id="hosts-table">
      <thead><tr>
        <th class="cb-cell"><input type="checkbox" id="hosts-cb-all"></th>
        <th class="sortable" data-field="name">Name${_sortField==='name'?(_sortOrder==='ASC'?' ▲':' ▼'):''}</th>
        <th>Availability</th>
        <th class="sortable" data-field="status">Status${_sortField==='status'?(_sortOrder==='ASC'?' ▲':' ▼'):''}</th>
        <th>Groups</th><th>Templates</th><th>Problems</th><th>Tags</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
