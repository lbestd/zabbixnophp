import { call } from '../api.js';
import { content, esc } from '../app.js';
import { groupPicker } from '../utils/group-picker.js';

const MTYPE = { 0: 'With data collection', 1: 'No data collection' };
const TAG_OP = { 0: 'Equals', 2: 'Contains', 3: 'Does not contain', 4: 'Starts with', 5: 'Ends with' };

function toDatetimeLocal(ts) {
  if (!ts || ts === '0') return '';
  const d = new Date(parseInt(ts) * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtPeriod(sec) {
  sec = parseInt(sec) || 0;
  if (sec >= 86400 && sec % 86400 === 0) return `${sec/86400}d`;
  if (sec >= 3600  && sec % 3600  === 0) return `${sec/3600}h`;
  return `${sec}s`;
}

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Maintenance</h2>
      <div class="toolbar">
        <button id="mnt-create-btn">+ New maintenance</button>
      </div>
    </div>
    <div class="filter-panel">
      <div class="filter-row">
        <input id="mnt-search" type="search" placeholder="Name…" style="width:180px">
        <select id="mnt-f-state">
          <option value="">Any state</option>
          <option value="active">Active</option>
          <option value="approaching">Approaching</option>
          <option value="expired">Expired</option>
        </select>
        <button class="btn-reset" id="mnt-reset">Reset</button>
      </div>
    </div>
    <div id="mnt-mass-bar" hidden style="margin-bottom:0.5rem;display:flex;gap:4px">
      <button id="mnt-mass-delete" class="btn-small btn-danger">Delete selected</button>
    </div>
    <div id="mnt-form-wrap" hidden></div>
    <div id="mnt-content"><p class="loading">Loading…</p></div>
  `;

  document.getElementById('mnt-search').addEventListener('input', filterRows);
  document.getElementById('mnt-f-state').addEventListener('change', filterRows);
  document.getElementById('mnt-create-btn').addEventListener('click', () => showForm());
  document.getElementById('mnt-reset').addEventListener('click', () => {
    document.getElementById('mnt-search').value = '';
    document.getElementById('mnt-f-state').value = '';
    filterRows();
  });
  document.getElementById('mnt-mass-delete').addEventListener('click', massDelete);

  await loadMaintenance();
}

function mntState(active_since, active_till) {
  const now = Math.floor(Date.now() / 1000);
  const since = parseInt(active_since) || 0;
  const till  = parseInt(active_till)  || 0;
  if (now < since) return 'approaching';
  if (now > till)  return 'expired';
  return 'active';
}

function updateMntMassBar() {
  const checked = document.querySelectorAll('#mnt-table .mnt-cb:checked').length;
  const bar = document.getElementById('mnt-mass-bar');
  if (bar) bar.hidden = checked === 0;
}

async function massDelete() {
  const ids = [...document.querySelectorAll('#mnt-table .mnt-cb:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} maintenance period(s)?`)) return;
  try {
    await call('maintenance.delete', { maintenanceids: ids });
    await loadMaintenance();
  } catch(e) { alert(e.message); }
}

async function loadMaintenance() {
  const tc = document.getElementById('mnt-content');
  try {
    const items = await call('maintenance.get', {
      output: 'extend',
      limit: 500,
      selectHosts: ['hostid', 'name'],
      selectGroups: ['groupid', 'name'],
    });
    if (!items.length) { tc.innerHTML = '<p class="empty">No maintenance periods.</p>'; return; }

    const rows = items.map(m => {
      const since   = m.active_since !== '0' ? new Date(parseInt(m.active_since)*1000).toLocaleString() : '—';
      const till    = m.active_till  !== '0' ? new Date(parseInt(m.active_till) *1000).toLocaleString() : '—';
      const hcount  = (m.hosts  || []).length;
      const gcount  = (m.groups || []).length;
      const scope   = hcount || gcount
        ? [hcount ? `${hcount} host(s)` : '', gcount ? `${gcount} group(s)` : ''].filter(Boolean).join(', ')
        : '—';
      const state   = mntState(m.active_since, m.active_till);
      const stateLabel = { active: 'Active', approaching: 'Approaching', expired: 'Expired' };
      const stateCls   = state === 'active' ? 'status-ok' : state === 'approaching' ? '' : 'muted';
      return `
        <tr data-name="${esc(m.name.toLowerCase())}" data-state="${state}">
          <td class="cb-cell"><input type="checkbox" class="mnt-cb" data-id="${esc(m.maintenanceid)}"></td>
          <td>${esc(m.name)}</td>
          <td class="muted">${MTYPE[m.maintenance_type] || m.maintenance_type}</td>
          <td class="${stateCls}" style="font-size:0.82rem">${stateLabel[state]}</td>
          <td class="muted" style="font-size:0.82rem">${since}</td>
          <td class="muted" style="font-size:0.82rem">${till}</td>
          <td class="muted" style="font-size:0.82rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title="${esc(m.description||'')}">${esc(m.description||'')}</td>
          <td class="muted">${esc(scope)}</td>
          <td class="row-actions">
            <button class="btn-small" onclick="editMaintenance('${esc(m.maintenanceid)}')">Edit</button>
            <button class="btn-small btn-danger" onclick="deleteMaintenance('${esc(m.maintenanceid)}','${esc(m.name)}')">Del</button>
          </td>
        </tr>`;
    }).join('');

    tc.innerHTML = `
      <table class="data-table" id="mnt-table">
        <thead><tr>
          <th class="cb-cell"><input type="checkbox" id="mnt-cb-all"></th>
          <th>Name</th><th>Type</th><th>State</th><th>Active since</th><th>Active till</th><th>Description</th><th>Scope</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    document.getElementById('mnt-cb-all')?.addEventListener('change', e => {
      tc.querySelectorAll('.mnt-cb').forEach(cb => { cb.checked = e.target.checked; });
      updateMntMassBar();
    });
    tc.querySelectorAll('.mnt-cb').forEach(cb => cb.addEventListener('change', updateMntMassBar));
  } catch(e) {
    tc.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function showForm(m = null) {
  const fw = document.getElementById('mnt-form-wrap');
  fw.hidden = false;
  const isEdit = !!m;

  // Load groups and hosts for pickers
  const [allGroups, allHosts] = await Promise.all([
    call('hostgroup.get', { output: ['groupid', 'name'] }).catch(() => []),
    call('host.get', { output: ['hostid', 'name'], monitored_hosts: true, limit: 2000 }).catch(() => []),
  ]);

  // Mutable state
  let mTags     = (m?.tags     || []).map(t => ({ tag: t.tag, operator: String(t.operator ?? 2), value: t.value || '' }));
  let mPeriods  = (m?.timeperiods || []).map(tp => ({
    timeperiod_type: String(tp.timeperiod_type ?? 0),
    start_date:      tp.start_date && tp.start_date !== '0' ? String(tp.start_date) : '',
    start_time:      String(tp.start_time || 0),
    period:          String(tp.period || 3600),
    every:           String(tp.every  || 1),
    dayofweek:       String(tp.dayofweek || 0),
    day:             String(tp.day  || 1),
    month:           String(tp.month || 0),
  }));

  fw.innerHTML = `
    <div class="inline-form" style="max-width:680px">
      <h3>${isEdit ? 'Edit maintenance' : 'New maintenance'}</h3>

      <label class="form-wide">Name *<input id="mf-name" value="${esc(m?.name||'')}"></label>
      <div class="form-grid">
        <label>Type
          <select id="mf-type">
            <option value="0"${parseInt(m?.maintenance_type)===0?' selected':''}>With data collection</option>
            <option value="1"${parseInt(m?.maintenance_type)===1?' selected':''}>No data collection</option>
          </select>
        </label>
        <label>Active since<input type="datetime-local" id="mf-since" value="${toDatetimeLocal(m?.active_since)}"></label>
        <label>Active till<input type="datetime-local" id="mf-till" value="${toDatetimeLocal(m?.active_till)}"></label>
      </div>

      <h4 style="margin:1rem 0 0.4rem">Hosts</h4>
      <div id="mf-hosts-picker"></div>

      <h4 style="margin:1rem 0 0.4rem">Host groups</h4>
      <div id="mf-groups-picker"></div>

      <h4 style="margin:1rem 0 0.4rem">Time periods</h4>
      <div id="mf-periods-list"></div>
      <button type="button" id="mf-period-add" class="btn-small" style="margin:4px 0 1rem">+ Add period</button>

      <h4 style="margin:0.5rem 0 0.4rem">Problem tags (filter)</h4>
      <div id="mf-tags-list"></div>
      <button type="button" id="mf-tag-add" class="btn-small" style="margin:4px 0 1rem">+ Add tag</button>

      <label class="form-wide">Description
        <textarea id="mf-desc" rows="2">${esc(m?.description||'')}</textarea>
      </label>
      <div class="form-actions">
        <button id="mf-submit">${isEdit ? 'Save' : 'Create'}</button>
        <button id="mf-cancel">Cancel</button>
        <span id="mf-error" class="error" hidden></span>
      </div>
    </div>`;

  // ── Hosts picker ──
  const curHostIds = (m?.hosts || []).map(h => String(h.hostid));
  const hostPicker = _hostPicker(
    document.getElementById('mf-hosts-picker'), allHosts, curHostIds
  );

  // ── Groups picker ──
  const curGids = (m?.groups || []).map(g => String(g.groupid));
  const grpPicker = groupPicker(
    document.getElementById('mf-groups-picker'), allGroups, curGids
  );

  // ── Time periods ──
  const PERIOD_TYPE_LABEL = ['One-time period', '', 'Daily', 'Weekly', 'Monthly'];
  const DOW_NAMES  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const MON_NAMES  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function secToHHMM(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  function hhmmToSec(str) {
    const [h, m] = str.split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60;
  }

  function renderOnePeriod(p, i) {
    const ptype    = parseInt(p.timeperiod_type || 0);
    const periodH  = Math.max(1, Math.floor(parseInt(p.period || 3600) / 3600));
    const startHHMM = secToHHMM(parseInt(p.start_time || 0));
    const everyN   = parseInt(p.every || 1);
    const dow      = parseInt(p.dayofweek || 0);
    const mon      = parseInt(p.month || 0);
    const day      = parseInt(p.day || 1);

    const typeSelect = `<select class="mfp-type" data-idx="${i}" style="font-size:0.82rem">
      <option value="0"${ptype===0?' selected':''}>One-time period</option>
      <option value="2"${ptype===2?' selected':''}>Daily</option>
      <option value="3"${ptype===3?' selected':''}>Weekly</option>
      <option value="4"${ptype===4?' selected':''}>Monthly</option>
    </select>`;

    let fields = '';
    if (ptype === 0) {
      const dt = p.start_date && p.start_date !== '0' ? toDatetimeLocal(p.start_date) : '';
      fields = `<label style="font-size:0.82rem">Start
        <input type="datetime-local" class="mfp-start" data-idx="${i}" value="${esc(dt)}" style="font-size:0.82rem">
      </label>`;
    } else {
      if (ptype === 2) {
        fields += `<label style="font-size:0.82rem">Every <input type="number" class="mfp-every" data-idx="${i}" value="${everyN}" min="1" style="width:4rem;font-size:0.82rem"> day(s)</label>`;
      } else if (ptype === 3) {
        const dowChecks = DOW_NAMES.map((d,b)=>
          `<label style="font-size:0.78rem"><input type="checkbox" class="mfp-dow" data-idx="${i}" data-bit="${1<<b}" ${dow&(1<<b)?'checked':''}> ${d}</label>`
        ).join('');
        fields += `<label style="font-size:0.82rem">Every <input type="number" class="mfp-every" data-idx="${i}" value="${everyN}" min="1" style="width:4rem;font-size:0.82rem"> week(s)</label>`;
        fields += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${dowChecks}</div>`;
      } else if (ptype === 4) {
        const monChecks = MON_NAMES.map((m,b)=>
          `<label style="font-size:0.78rem"><input type="checkbox" class="mfp-mon" data-idx="${i}" data-bit="${1<<b}" ${mon&(1<<b)?'checked':''}> ${m}</label>`
        ).join('');
        fields += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${monChecks}</div>`;
        fields += `<label style="font-size:0.82rem;margin-top:4px">Day of month
          <input type="number" class="mfp-day" data-idx="${i}" value="${day}" min="1" max="31" style="width:4rem;font-size:0.82rem">
        </label>`;
      }
      fields += `<label style="font-size:0.82rem">At <input type="time" class="mfp-stime" data-idx="${i}" value="${secToHHMM(parseInt(p.start_time||0))}" style="font-size:0.82rem"></label>`;
    }
    fields += `<label style="font-size:0.82rem">Duration (h)
      <input type="number" class="mfp-dur" data-idx="${i}" value="${periodH}" min="1" style="width:5rem;font-size:0.82rem">
    </label>`;

    return `
      <div class="iface-row" style="margin-bottom:6px;flex-wrap:wrap;gap:6px;align-items:flex-start">
        ${typeSelect}
        ${fields}
        <button type="button" class="btn-small btn-danger mfp-rem" data-idx="${i}" style="align-self:flex-end;margin-top:2px">×</button>
      </div>`;
  }

  function renderPeriods() {
    const el = document.getElementById('mf-periods-list');
    if (!el) return;
    if (!mPeriods.length) {
      el.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No periods defined.</p>';
      return;
    }
    el.innerHTML = mPeriods.map(renderOnePeriod).join('');

    el.querySelectorAll('.mfp-type').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx);
        mPeriods[idx].timeperiod_type = sel.value;
        renderPeriods();
      });
    });
    el.querySelectorAll('.mfp-start').forEach(inp => inp.addEventListener('change', () => {
      const val = inp.value ? Math.floor(new Date(inp.value).getTime()/1000) : 0;
      mPeriods[parseInt(inp.dataset.idx)].start_date = String(val);
    }));
    el.querySelectorAll('.mfp-dur').forEach(inp => inp.addEventListener('change', () => {
      mPeriods[parseInt(inp.dataset.idx)].period = String(parseInt(inp.value || 1) * 3600);
    }));
    el.querySelectorAll('.mfp-every').forEach(inp => inp.addEventListener('change', () => {
      mPeriods[parseInt(inp.dataset.idx)].every = inp.value;
    }));
    el.querySelectorAll('.mfp-stime').forEach(inp => inp.addEventListener('change', () => {
      mPeriods[parseInt(inp.dataset.idx)].start_time = String(hhmmToSec(inp.value));
    }));
    el.querySelectorAll('.mfp-dow').forEach(cb => cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.idx), bit = parseInt(cb.dataset.bit);
      let v = parseInt(mPeriods[idx].dayofweek || 0);
      mPeriods[idx].dayofweek = String(cb.checked ? v | bit : v & ~bit);
    }));
    el.querySelectorAll('.mfp-mon').forEach(cb => cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.idx), bit = parseInt(cb.dataset.bit);
      let v = parseInt(mPeriods[idx].month || 0);
      mPeriods[idx].month = String(cb.checked ? v | bit : v & ~bit);
    }));
    el.querySelectorAll('.mfp-day').forEach(inp => inp.addEventListener('change', () => {
      mPeriods[parseInt(inp.dataset.idx)].day = inp.value;
    }));
    el.querySelectorAll('.mfp-rem').forEach(btn => {
      btn.addEventListener('click', () => { mPeriods.splice(parseInt(btn.dataset.idx), 1); renderPeriods(); });
    });
  }
  renderPeriods();

  document.getElementById('mf-period-add').addEventListener('click', () => {
    mPeriods.push({ timeperiod_type: '0', start_date: '', start_time: '0', period: '3600', every: '1', dayofweek: '0', day: '1', month: '0' });
    renderPeriods();
  });

  // ── Tags ──
  function renderTags() {
    const el = document.getElementById('mf-tags-list');
    if (!el) return;
    if (!mTags.length) {
      el.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No tag filters.</p>';
      return;
    }
    el.innerHTML = mTags.map((t, i) => `
      <div class="iface-row" style="margin-bottom:4px">
        <input class="mft-tag" data-idx="${i}" value="${esc(t.tag)}" placeholder="tag" style="width:130px">
        <select class="mft-op" data-idx="${i}" style="width:160px">
          ${Object.entries(TAG_OP).map(([v,l])=>`<option value="${v}"${t.operator===v?' selected':''}>${l}</option>`).join('')}
        </select>
        <input class="mft-val" data-idx="${i}" value="${esc(t.value)}" placeholder="value" style="flex:1">
        <button type="button" class="btn-small btn-danger mft-rem" data-idx="${i}">×</button>
      </div>`).join('');
    el.querySelectorAll('.mft-tag').forEach(inp => inp.addEventListener('input', () => { mTags[parseInt(inp.dataset.idx)].tag = inp.value; }));
    el.querySelectorAll('.mft-op').forEach(sel => sel.addEventListener('change', () => { mTags[parseInt(sel.dataset.idx)].operator = sel.value; }));
    el.querySelectorAll('.mft-val').forEach(inp => inp.addEventListener('input', () => { mTags[parseInt(inp.dataset.idx)].value = inp.value; }));
    el.querySelectorAll('.mft-rem').forEach(btn => btn.addEventListener('click', () => { mTags.splice(parseInt(btn.dataset.idx), 1); renderTags(); }));
  }
  renderTags();

  document.getElementById('mf-tag-add').addEventListener('click', () => {
    mTags.push({ tag: '', operator: '2', value: '' });
    renderTags();
  });

  document.getElementById('mf-cancel').onclick = () => { fw.hidden = true; fw.innerHTML = ''; };
  document.getElementById('mf-submit').onclick = async () => {
    const errEl = document.getElementById('mf-error');
    errEl.hidden = true;
    const sinceVal = document.getElementById('mf-since').value;
    const tillVal  = document.getElementById('mf-till').value;
    const p = {
      name:             document.getElementById('mf-name').value.trim(),
      maintenance_type: parseInt(document.getElementById('mf-type').value),
      description:      document.getElementById('mf-desc').value,
      active_since:     sinceVal ? Math.floor(new Date(sinceVal).getTime()/1000) : 0,
      active_till:      tillVal  ? Math.floor(new Date(tillVal).getTime()/1000)  : 0,
      hostids:  hostPicker.getValue(),
      groupids: grpPicker.getValue().map(g => g.groupid),
      tags:     mTags.filter(t => t.tag.trim()).map(t => ({
        tag: t.tag, operator: parseInt(t.operator), value: t.value,
      })),
      timeperiods: mPeriods.map(p => ({
        timeperiod_type: parseInt(p.timeperiod_type || 0),
        start_date:      parseInt(p.start_date || 0),
        start_time:      parseInt(p.start_time  || 0),
        period:          parseInt(p.period       || 3600),
        every:           parseInt(p.every        || 1),
        dayofweek:       parseInt(p.dayofweek    || 0),
        day:             parseInt(p.day          || 1),
        month:           parseInt(p.month        || 0),
      })),
    };
    try {
      if (isEdit) { p.maintenanceid = m.maintenanceid; await call('maintenance.update', p); }
      else await call('maintenance.create', p);
      fw.hidden = true; fw.innerHTML = '';
      await loadMaintenance();
    } catch(e) { errEl.textContent = e.message; errEl.hidden = false; }
  };
}

// Simple host multi-picker (chip-based, like groupPicker)
function _hostPicker(container, allHosts, selectedIds = []) {
  const selected = new Map();
  selectedIds.forEach(id => {
    const h = allHosts.find(x => String(x.hostid) === String(id));
    if (h) selected.set(String(h.hostid), h.name || h.host);
  });

  container.classList.add('group-picker');
  render();

  function render() {
    const chips = [...selected.entries()].map(([id, name]) =>
      `<span class="gp-chip" data-id="${id}">${escH(name)}<button type="button" class="gp-remove" data-id="${id}">×</button></span>`
    ).join('');
    container.innerHTML = `
      ${chips}
      <span class="gp-input-wrap">
        <input class="gp-input" type="text" placeholder="Add host…" autocomplete="off">
        <ul class="gp-dropdown" hidden></ul>
      </span>`;
    container.querySelectorAll('.gp-remove').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); selected.delete(btn.dataset.id); render(); });
    });
    const input = container.querySelector('.gp-input');
    const dd    = container.querySelector('.gp-dropdown');
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      const matches = allHosts.filter(h =>
        !selected.has(String(h.hostid)) && (h.name||h.host||'').toLowerCase().includes(q)
      ).slice(0, 20);
      if (!matches.length || !q) { dd.hidden = true; return; }
      dd.innerHTML = matches.map(h =>
        `<li data-id="${h.hostid}" data-name="${escH(h.name||h.host)}">${escH(h.name||h.host)}</li>`
      ).join('');
      dd.hidden = false;
    });
    dd.addEventListener('mousedown', e => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      e.preventDefault();
      selected.set(li.dataset.id, li.dataset.name);
      render();
      container.querySelector('.gp-input')?.focus();
    });
    input.addEventListener('blur', () => { setTimeout(() => { dd.hidden = true; }, 150); });
  }

  return { getValue: () => [...selected.keys()] };
}

window.editMaintenance = async (mid) => {
  const items = await call('maintenance.get', {
    maintenanceids: [mid],
    selectHosts: ['hostid', 'name'],
    selectGroups: ['groupid', 'name'],
    selectTags: true,
    selectTimeperiods: true,
  });
  if (items[0]) showForm(items[0]);
};

window.deleteMaintenance = async (mid, name) => {
  if (!confirm(`Delete maintenance "${name}"?`)) return;
  try { await call('maintenance.delete', { maintenanceids: [mid] }); location.reload(); }
  catch(e) { alert(e.message); }
};

function filterRows() {
  const q      = document.getElementById('mnt-search')?.value.toLowerCase() || '';
  const fState = document.getElementById('mnt-f-state')?.value || '';
  document.querySelectorAll('#mnt-table tr[data-name]').forEach(tr => {
    const ok = (!q || tr.dataset.name.includes(q)) &&
               (!fState || tr.dataset.state === fState);
    tr.style.display = ok ? '' : 'none';
  });
}

function escH(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
