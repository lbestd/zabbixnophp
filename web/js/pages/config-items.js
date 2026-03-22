/**
 * Configuration › Items — global items list across all hosts
 * Route: #/config/items
 */
import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';
import { pagination } from '../utils/pagination.js';

const VALUE_TYPE  = ['Float', 'String', 'Log', 'Uint', 'Text'];
const STATE_LABEL = ['Normal', 'Not supported'];
const STATUS_LABEL = ['Enabled', 'Disabled'];
const ITEM_TYPE_LABEL = {
  '0': 'Zabbix agent', '2': 'Zabbix trapper', '3': 'Simple check',
  '5': 'Zabbix internal', '7': 'Zabbix agent (active)', '9': 'Web item',
  '10': 'External check', '11': 'Database monitor', '12': 'IPMI agent',
  '13': 'SSH agent', '14': 'Telnet agent', '15': 'Calculated',
  '16': 'JMX agent', '17': 'SNMP trap', '18': 'Dependent item',
  '19': 'HTTP agent', '20': 'SNMP agent', '21': 'Script',
};

const LS_KEY    = 'zbx.filter.config-items';
const PAGE_SIZE = 100;

let _sortField = 'name';
let _sortOrder = 'ASC';
let _allItems  = [];
let _pager     = null;

function saveFilters() {
  const f = {
    group:  document.getElementById('ci-group')?.value  || '',
    host:   document.getElementById('ci-host')?.value   || '',
    search: document.getElementById('ci-search')?.value || '',
    type:   document.getElementById('ci-type')?.value   || '',
    status: document.getElementById('ci-status')?.value || '',
  };
  localStorage.setItem(LS_KEY, JSON.stringify(f));
}

function restoreFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const el = id => document.getElementById(id);
    if (f.group  && el('ci-group'))  el('ci-group').value  = f.group;
    if (f.host   && el('ci-host'))   el('ci-host').value   = f.host;
    if (f.search && el('ci-search')) el('ci-search').value = f.search;
    if (f.type   && el('ci-type'))   el('ci-type').value   = f.type;
    if (f.status && el('ci-status')) el('ci-status').value = f.status;
  } catch (_) {}
}

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Items</h2>
    </div>
    <div class="filter-panel">
      <div class="filter-row">
        <select id="ci-group"><option value="">All groups</option></select>
        <select id="ci-host" disabled><option value="">All hosts</option></select>
        <input id="ci-search" type="search" placeholder="Search name…">
        <select id="ci-type">
          <option value="">Any type</option>
          ${Object.entries(ITEM_TYPE_LABEL).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
        </select>
        <select id="ci-status">
          <option value="">Any status</option>
          <option value="0">Enabled</option>
          <option value="1">Disabled</option>
        </select>
        <button class="btn-reset" id="ci-reset" title="Reset filters">Reset</button>
      </div>
    </div>
    <div id="ci-mass-bar" hidden style="display:flex;gap:4px;align-items:center;margin-bottom:0.5rem">
      <button id="ci-mass-enable"  class="btn-small">Enable</button>
      <button id="ci-mass-disable" class="btn-small">Disable</button>
      <button id="ci-mass-delete"  class="btn-small btn-danger">Delete</button>
    </div>
    <div id="ci-content"><p class="loading">Loading…</p></div>
    <div id="ci-pager"></div>
  `;

  _pager = pagination({ pageSize: PAGE_SIZE, onPage: loadItems });
  _pager.render(document.getElementById('ci-pager'));
  await loadGroups();
  restoreFilters();

  function filterLoad() { saveFilters(); _pager?.reset(); loadItems(); }
  const sel = id => document.getElementById(id);
  sel('ci-group').addEventListener('change', () => { saveFilters(); _pager?.reset(); onGroupChange(); });
  sel('ci-host').addEventListener('change',  filterLoad);
  sel('ci-search').addEventListener('input', () => { saveFilters(); filterRows(); });
  sel('ci-type').addEventListener('change',  () => { saveFilters(); filterRows(); });
  sel('ci-status').addEventListener('change',() => { saveFilters(); filterRows(); });
  sel('ci-reset').addEventListener('click',  resetFilters);
  sel('ci-mass-enable').addEventListener('click',  () => massAction('enable'));
  sel('ci-mass-disable').addEventListener('click', () => massAction('disable'));
  sel('ci-mass-delete').addEventListener('click',  () => massAction('delete'));

  // pre-fill hostid from URL if coming from hosts page
  const hostidParam = location.hash.match(/[?&]hostid=(\d+)/);
  if (hostidParam) {
    // wait for groups to load then select
    setTimeout(async () => {
      const hostSel = document.getElementById('ci-host');
      if (hostSel) { hostSel.value = hostidParam[1]; }
    }, 300);
  }

  await loadItems();
}

async function loadGroups() {
  const groups = await call('hostgroup.get', { output: ['groupid','name'] }).catch(() => []);
  const sel = document.getElementById('ci-group');
  if (!sel) return;
  groups.forEach(g => {
    const o = document.createElement('option');
    o.value = g.groupid; o.textContent = g.name;
    sel.appendChild(o);
  });
}

async function onGroupChange() {
  saveFilters();
  const groupid = document.getElementById('ci-group')?.value;
  const hostSel = document.getElementById('ci-host');
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
  await loadItems();
}

function resetFilters() {
  const el = id => document.getElementById(id);
  el('ci-group').value = ''; el('ci-host').innerHTML = '<option value="">All hosts</option>';
  el('ci-host').disabled = true; el('ci-search').value = '';
  el('ci-type').value = ''; el('ci-status').value = '';
  localStorage.removeItem(LS_KEY);
  loadItems();
}

async function loadItems() {
  const el = document.getElementById('ci-content');
  if (!el) return;
  el.innerHTML = '<p class="loading">Loading…</p>';

  const groupid = document.getElementById('ci-group')?.value;
  const hostid  = document.getElementById('ci-host')?.value;

  const params = {
    output: ['itemid','name','key_','type','value_type','status','state','delay','history','units','flags'],
    selectHosts: ['hostid','name'],
    webitems: false,
    flags: 0,    // normal items only (not LLD-created)
    sortfield: _sortField,
    sortorder: _sortOrder,
    limit: PAGE_SIZE,
    offset: _pager ? _pager.current() : 0,
  };
  if (groupid) params.groupids = [groupid];
  if (hostid)  params.hostids  = [hostid];

  try {
    _allItems = await call('item.get', params);
    renderTable(el);
  } catch(e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderTable(el) {
  const search = document.getElementById('ci-search')?.value.toLowerCase() || '';
  const typeF  = document.getElementById('ci-type')?.value;
  const statusF = document.getElementById('ci-status')?.value;

  const filtered = _allItems.filter(it => {
    if (search && !(it.name||'').toLowerCase().includes(search) &&
        !(it.key_||'').toLowerCase().includes(search)) return false;
    if (typeF   && it.type   !== typeF)   return false;
    if (statusF && it.status !== statusF) return false;
    return true;
  });

  if (!filtered.length) { el.innerHTML = '<p class="empty">No items found.</p>'; return; }

  const rows = filtered.map(it => {
    const vt    = parseInt(it.value_type);
    const host  = (it.hosts||[])[0];
    const isNum = vt === 0 || vt === 3;
    return `
      <tr data-id="${esc(it.itemid)}">
        <td class="cb-cell" onclick="event.stopPropagation()">
          <input type="checkbox" class="ci-cb" data-id="${esc(it.itemid)}">
        </td>
        <td>
          ${host ? `<a href="#/hosts/${esc(host.hostid)}/items"
            onclick="event.stopPropagation()">${esc(host.name||host.host)}</a>` : '—'}
        </td>
        <td>
          ${isNum
            ? `<a href="#/item?itemid=${esc(it.itemid)}" onclick="event.stopPropagation()">${esc(it.name)}</a>`
            : esc(it.name)}
        </td>
        <td class="val-cell" title="${esc(it.key_)}">${esc(it.key_)}</td>
        <td>${ITEM_TYPE_LABEL[it.type] || it.type}</td>
        <td>${VALUE_TYPE[vt]||vt}${it.units?' / '+esc(it.units):''}</td>
        <td>${esc(it.delay||'')}</td>
        <td class="${parseInt(it.status)===0?'':'status-dis'}">${STATUS_LABEL[parseInt(it.status)]||it.status}</td>
        <td class="${parseInt(it.state)===0?'':'status-dis'}">${STATE_LABEL[parseInt(it.state)]||it.state}</td>
        <td class="row-actions" onclick="event.stopPropagation()">
          <button class="btn-small ci-toggle" data-id="${esc(it.itemid)}" data-status="${esc(it.status)}">
            ${parseInt(it.status)===0?'Disable':'Enable'}
          </button>
          <button class="btn-small btn-danger ci-del" data-id="${esc(it.itemid)}" data-name="${esc(it.name)}">Del</button>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th class="cb-cell"><input type="checkbox" id="ci-cb-all"></th>
          <th class="sortable" data-field="hostname">Host</th>
          <th class="sortable" data-field="name">Name</th>
          <th>Key</th>
          <th>Type</th>
          <th>Value type</th>
          <th class="sortable" data-field="delay">Interval</th>
          <th class="sortable" data-field="status">Status</th>
          <th>State</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.querySelectorAll('th.sortable').forEach(th => {
    th.style.cursor = 'pointer';
    if (th.dataset.field === _sortField) th.classList.add(_sortOrder === 'ASC' ? 'sort-asc' : 'sort-desc');
    th.addEventListener('click', () => {
      if (_sortField === th.dataset.field) _sortOrder = _sortOrder === 'ASC' ? 'DESC' : 'ASC';
      else { _sortField = th.dataset.field; _sortOrder = 'ASC'; }
      loadItems();
    });
  });

  document.getElementById('ci-cb-all').addEventListener('change', e => {
    el.querySelectorAll('.ci-cb').forEach(c => c.checked = e.target.checked);
    updateMassBar();
  });
  el.querySelectorAll('.ci-cb').forEach(c => c.addEventListener('change', updateMassBar));

  el.querySelectorAll('.ci-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newStatus = parseInt(btn.dataset.status) === 0 ? 1 : 0;
      try {
        await call('item.update', { itemid: btn.dataset.id, status: newStatus });
        await loadItems();
      } catch(e) { alert(e.message); }
    });
  });

  el.querySelectorAll('.ci-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete item "${btn.dataset.name}"?`)) return;
      try {
        await call('item.delete', [btn.dataset.id]);
        await loadItems();
      } catch(e) { alert(e.message); }
    });
  });
}

function filterRows() {
  const el = document.getElementById('ci-content');
  if (!el) return;
  renderTable(el);
}

function updateMassBar() {
  const bar = document.getElementById('ci-mass-bar');
  if (!bar) return;
  const checked = document.querySelectorAll('.ci-cb:checked').length;
  bar.hidden = checked === 0;
}

async function massAction(action) {
  const ids = Array.from(document.querySelectorAll('.ci-cb:checked')).map(c => c.dataset.id);
  if (!ids.length) return;
  if (action === 'delete' && !confirm(`Delete ${ids.length} item(s)?`)) return;
  try {
    if (action === 'enable' || action === 'disable') {
      const status = action === 'enable' ? 0 : 1;
      for (const id of ids) await call('item.update', { itemid: id, status });
    }
    if (action === 'delete') await call('item.delete', ids);
    await loadItems();
  } catch(e) { alert(e.message); }
}
