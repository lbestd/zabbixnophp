import { call } from '../api.js';
import { content, esc } from '../app.js';
import { groupPicker } from '../utils/group-picker.js';

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Templates</h2>
    </div>
    <div class="tab-toolbar" style="margin-bottom:10px">
      <input id="tpl-search" type="search" placeholder="Name…" style="width:180px">
      <select id="tpl-group"><option value="">All groups</option></select>
      <button id="tpl-create-btn">+ New template</button>
      <span id="tpl-mass-bar" hidden style="display:flex;gap:4px;margin-left:8px">
        <button id="tpl-mass-delete" class="btn-small btn-danger">Delete</button>
      </span>
    </div>
    <div id="tpl-form-area" hidden></div>
    <div id="tpl-content"><p class="loading">Loading…</p></div>
  `;

  let allGroups = [];
  try {
    allGroups = await call('hostgroup.get', { output: ['groupid', 'name'], sortfield: 'name' }).catch(() => []);
    const sel = document.getElementById('tpl-group');
    allGroups.forEach(g => {
      const o = document.createElement('option');
      o.value = g.groupid; o.textContent = g.name;
      sel.appendChild(o);
    });
  } catch(_) {}

  document.getElementById('tpl-search').addEventListener('input', filterRows);
  document.getElementById('tpl-group').addEventListener('change', loadTemplates);
  document.getElementById('tpl-mass-delete').addEventListener('click', massDelete);
  document.getElementById('tpl-create-btn').addEventListener('click', () => showForm(null, allGroups));

  await loadTemplates();
}

async function loadTemplates() {
  const tc = document.getElementById('tpl-content');
  if (!tc) return;
  tc.innerHTML = '<p class="loading">Loading…</p>';

  const groupid = document.getElementById('tpl-group')?.value;

  try {
    const params = {
      output: 'extend',
      selectParentTemplates: ['templateid', 'name', 'host'],
      limit: 2000,
    };
    if (groupid) params.groupids = [groupid];

    const templates = await call('template.get', params);
    renderTable(tc, templates);
  } catch (e) {
    tc.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderTable(tc, templates) {
  if (!templates.length) { tc.innerHTML = '<p class="empty">No templates found.</p>'; return; }

  const rows = templates.map(t => {
    const linked = (t.parentTemplates || []).map(p => esc(p.name || p.host)).join(', ');
    const ic  = parseInt(t.item_count)     || 0;
    const trc = parseInt(t.trigger_count)  || 0;
    const dc  = parseInt(t.discovery_count)|| 0;
    const hc  = parseInt(t.host_count)     || 0;
    return `
      <tr data-name="${esc((t.name || t.host).toLowerCase())}" data-id="${esc(t.templateid)}">
        <td class="cb-cell" onclick="event.stopPropagation()">
          <input type="checkbox" class="tpl-cb" data-id="${esc(t.templateid)}">
        </td>
        <td>
          <strong class="tpl-name-link" data-id="${esc(t.templateid)}" style="cursor:pointer;color:var(--link)">${esc(t.name || t.host)}</strong>
          <br><small class="muted"><code>${esc(t.host)}</code></small>
        </td>
        <td class="muted" style="text-align:center">${hc || '—'}</td>
        <td style="text-align:center">
          ${ic ? `<a href="#/hosts/${esc(t.templateid)}/items" class="count-link">${ic}</a>` : '—'}
        </td>
        <td style="text-align:center">
          ${trc ? `<a href="#/hosts/${esc(t.templateid)}/triggers" class="count-link">${trc}</a>` : '—'}
        </td>
        <td style="text-align:center">
          ${dc ? `<a href="#/hosts/${esc(t.templateid)}/discovery" class="count-link">${dc}</a>` : '—'}
        </td>
        <td class="muted" style="font-size:0.82rem">${linked || '—'}</td>
        <td class="row-actions">
          <button class="btn-small tpl-edit-btn" data-id="${esc(t.templateid)}">Edit</button>
        </td>
      </tr>`;
  }).join('');

  tc.innerHTML = `
    <table class="data-table" id="tpl-table">
      <thead><tr>
        <th class="cb-cell"><input type="checkbox" id="tpl-cb-all"></th>
        <th>Name</th>
        <th title="Linked hosts">Hosts</th>
        <th title="Items count">Items</th>
        <th title="Triggers count">Triggers</th>
        <th title="Discovery rules">Discovery</th>
        <th>Linked templates</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  document.getElementById('tpl-cb-all')?.addEventListener('change', e => {
    tc.querySelectorAll('.tpl-cb').forEach(cb => { cb.checked = e.target.checked; });
    updateMassBar();
  });
  tc.querySelectorAll('.tpl-cb').forEach(cb => cb.addEventListener('change', updateMassBar));

  // name links + edit buttons both open the form
  async function openTplForm(templateid) {
    const allGroups = await call('hostgroup.get', { output: ['groupid', 'name'], sortfield: 'name' }).catch(() => []);
    const tpls = await call('template.get', {
      templateids: [templateid],
      output: 'extend',
      selectGroups: ['groupid', 'name'],
      selectParentTemplates: ['templateid', 'name', 'host'],
    }).catch(() => []);
    if (tpls[0]) showForm(tpls[0], allGroups);
  }
  tc.querySelectorAll('.tpl-name-link').forEach(link => {
    link.addEventListener('click', e => { e.stopPropagation(); openTplForm(link.dataset.id); });
  });
  tc.querySelectorAll('.tpl-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openTplForm(btn.dataset.id); });
  });

  filterRows();
}

function filterRows() {
  const q = document.getElementById('tpl-search')?.value.toLowerCase() || '';
  document.querySelectorAll('#tpl-table tr[data-name]').forEach(tr => {
    tr.style.display = !q || tr.dataset.name.includes(q) ? '' : 'none';
  });
}

function updateMassBar() {
  const checked = document.querySelectorAll('#tpl-table .tpl-cb:checked').length;
  const bar = document.getElementById('tpl-mass-bar');
  if (bar) bar.hidden = checked === 0;
}

async function massDelete() {
  const ids = [...document.querySelectorAll('#tpl-table .tpl-cb:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} template(s)? This will unlink them from all hosts.`)) return;
  try {
    await call('template.delete', { templateids: ids });
    await loadTemplates();
  } catch(e) { alert(e.message); }
}

async function showForm(template, allGroups) {
  const area = document.getElementById('tpl-form-area');
  if (!area) return;

  const isEdit = !!template;
  const curGids = isEdit ? (template.groups || []).map(g => String(g.groupid)) : [];

  // fetch all templates for parent-template picker (exclude self)
  const allTpls = await call('template.get', { output: ['templateid', 'host', 'name'], limit: 2000 }).catch(() => []);
  let parentTpls = isEdit ? (template.parentTemplates || []).map(t => ({ ...t })) : [];

  area.hidden = false;
  area.innerHTML = `
    <div class="inline-form" style="max-width:600px;margin-bottom:16px">
      <h3>${isEdit ? 'Edit template' : 'New template'}</h3>
      <table class="host-form-table">
        <tr>
          <th>Technical name *</th>
          <td><input id="tf-host" value="${esc(template?.host || '')}" style="width:300px"></td>
        </tr>
        <tr>
          <th>Visible name</th>
          <td><input id="tf-name" value="${esc(template?.name || '')}" style="width:300px" placeholder="(same as technical name)"></td>
        </tr>
        <tr>
          <th>Template groups *</th>
          <td><div id="tf-groups-picker"></div></td>
        </tr>
        <tr>
          <th>Linked templates</th>
          <td>
            <div id="tf-parent-list" style="margin-bottom:4px"></div>
            <div style="position:relative;display:inline-block">
              <input id="tf-tpl-search" type="search" placeholder="type to link…" style="width:260px">
              <div id="tf-tpl-drop" class="tpl-dropdown" hidden></div>
            </div>
          </td>
        </tr>
      </table>
      <div class="form-actions" style="margin-top:12px">
        <button id="tf-submit">${isEdit ? 'Update' : 'Create'}</button>
        <button id="tf-cancel">Cancel</button>
        <span id="tf-error" class="error" hidden></span>
      </div>
    </div>`;

  const picker = groupPicker(document.getElementById('tf-groups-picker'), allGroups, curGids);

  // parent templates list
  function renderParentList() {
    const pl = document.getElementById('tf-parent-list');
    if (!pl) return;
    if (!parentTpls.length) { pl.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No linked templates.</p>'; return; }
    pl.innerHTML = parentTpls.map((t, i) => `
      <div class="iface-row" style="margin-bottom:4px">
        <span style="flex:1">${esc(t.name || t.host)}</span>
        <button type="button" class="btn-small btn-danger pt-rem" data-idx="${i}">×</button>
      </div>`).join('');
    pl.querySelectorAll('.pt-rem').forEach(btn =>
      btn.addEventListener('click', () => { parentTpls.splice(parseInt(btn.dataset.idx), 1); renderParentList(); })
    );
  }
  renderParentList();

  const tplSearch = document.getElementById('tf-tpl-search');
  const tplDrop   = document.getElementById('tf-tpl-drop');
  tplSearch.addEventListener('input', () => {
    const q = tplSearch.value.toLowerCase();
    if (!q) { tplDrop.hidden = true; return; }
    const selfId = template?.templateid;
    const matches = allTpls
      .filter(t => (t.name || t.host).toLowerCase().includes(q)
        && String(t.templateid) !== String(selfId)
        && !parentTpls.find(p => String(p.templateid) === String(t.templateid)))
      .slice(0, 15);
    if (!matches.length) { tplDrop.hidden = true; return; }
    tplDrop.innerHTML = matches.map(t =>
      `<div class="tpl-item" data-id="${esc(t.templateid)}" data-host="${esc(t.host)}" data-name="${esc(t.name)}">${esc(t.name || t.host)}</div>`
    ).join('');
    tplDrop.hidden = false;
  });
  tplDrop.addEventListener('click', e => {
    const item = e.target.closest('.tpl-item');
    if (!item) return;
    parentTpls.push({ templateid: item.dataset.id, host: item.dataset.host, name: item.dataset.name });
    tplSearch.value = ''; tplDrop.hidden = true;
    renderParentList();
  });
  document.addEventListener('click', e => {
    if (!tplSearch.contains(e.target) && !tplDrop.contains(e.target)) tplDrop.hidden = true;
  }, { capture: true, once: false });

  document.getElementById('tf-cancel').onclick = () => { area.hidden = true; area.innerHTML = ''; };
  document.getElementById('tf-submit').onclick = async () => {
    const errEl = document.getElementById('tf-error');
    errEl.hidden = true;
    const host = document.getElementById('tf-host').value.trim();
    const name = document.getElementById('tf-name').value.trim();
    const groups = picker.getValue();
    if (!host) { errEl.textContent = 'Technical name required.'; errEl.hidden = false; return; }
    if (!groups.length) { errEl.textContent = 'At least one group required.'; errEl.hidden = false; return; }
    try {
      const p = {
        host,
        name: name || host,
        groups,
        templates: parentTpls.map(t => ({ templateid: t.templateid })),
      };
      if (isEdit) {
        p.templateid = template.templateid;
        await call('template.update', p);
      } else {
        await call('template.create', p);
      }
      area.hidden = true; area.innerHTML = '';
      await loadTemplates();
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  };
}
