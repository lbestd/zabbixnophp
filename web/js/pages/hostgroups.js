/**
 * Configuration › Host groups — CRUD
 * Route: #/config/hostgroups
 */
import { call } from '../api.js';
import { content, esc } from '../app.js';

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Host groups</h2>
      <div class="toolbar">
        <span id="hg-mass-bar" hidden style="display:flex;gap:4px">
          <button id="hg-mass-delete" class="btn-small btn-danger">Delete selected</button>
        </span>
        <button id="hg-create-btn">+ New group</button>
      </div>
    </div>
    <div class="filter-panel">
      <div class="filter-row">
        <input id="hg-search" type="search" placeholder="Name…" style="width:200px">
        <button class="btn-reset" id="hg-reset">Reset</button>
      </div>
    </div>
    <div id="hg-create-form" hidden></div>
    <div id="hg-list"><p class="loading">Loading…</p></div>
  `;

  document.getElementById('hg-create-btn').addEventListener('click', () => showForm());
  document.getElementById('hg-mass-delete').addEventListener('click', massDelete);
  document.getElementById('hg-search').addEventListener('input', filterGroups);
  document.getElementById('hg-reset').addEventListener('click', () => {
    document.getElementById('hg-search').value = '';
    filterGroups();
  });
  await loadGroups();
}

function updateMassBar() {
  const checked = document.querySelectorAll('#hg-list .hg-cb:checked').length;
  const bar = document.getElementById('hg-mass-bar');
  if (bar) bar.hidden = checked === 0;
}

async function massDelete() {
  const ids = [...document.querySelectorAll('#hg-list .hg-cb:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} group(s)?`)) return;
  try {
    await call('hostgroup.delete', { groupids: ids });
    await loadGroups();
  } catch(e) { alert(e.message); }
}

async function loadGroups() {
  const el = document.getElementById('hg-list');
  if (!el) return;
  const groups = await call('hostgroup.get', { output: ['groupid','name'], selectHosts: ['hostid'] });
  if (!groups.length) { el.innerHTML = '<p class="empty">No host groups.</p>'; return; }

  const rows = groups.map(g => `
    <tr data-name="${esc(g.name.toLowerCase())}">
      <td class="cb-cell"><input type="checkbox" class="hg-cb" data-id="${esc(g.groupid)}"></td>
      <td>${esc(g.name)}</td>
      <td>${(g.hosts||[]).length}</td>
      <td class="row-actions">
        <button class="btn-small" data-edit="${esc(g.groupid)}" data-name="${esc(g.name)}">Edit</button>
        <button class="btn-small btn-danger" data-del="${esc(g.groupid)}" data-name="${esc(g.name)}">Del</button>
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th class="cb-cell"><input type="checkbox" id="hg-cb-all"></th>
        <th>Name</th><th>Hosts</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  document.getElementById('hg-cb-all')?.addEventListener('change', e => {
    el.querySelectorAll('.hg-cb').forEach(cb => { cb.checked = e.target.checked; });
    updateMassBar();
  });
  el.querySelectorAll('.hg-cb').forEach(cb => cb.addEventListener('change', updateMassBar));

  el.querySelectorAll('button[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => showForm(btn.dataset.edit, btn.dataset.name));
  });
  el.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete group "${btn.dataset.name}"?`)) return;
      try {
        await call('hostgroup.delete', { groupids: [btn.dataset.del] });
        await loadGroups();
      } catch(e) { alert(e.message); }
    });
  });

  filterGroups();
}

function filterGroups() {
  const q = document.getElementById('hg-search')?.value.toLowerCase() || '';
  document.querySelectorAll('#hg-list tr[data-name]').forEach(tr => {
    tr.style.display = (!q || tr.dataset.name.includes(q)) ? '' : 'none';
  });
}

function showForm(groupid = null, currentName = '') {
  const el = document.getElementById('hg-create-form');
  if (!el) return;
  el.hidden = false;
  const isEdit = !!groupid;
  el.innerHTML = `
    <div class="inline-form" style="max-width:420px">
      <h3>${isEdit ? 'Edit group' : 'New group'}</h3>
      <div class="form-grid">
        <label class="form-wide">Name *<input id="hgf-name" value="${esc(currentName)}"></label>
      </div>
      <div class="form-actions">
        <button id="hgf-submit">${isEdit ? 'Save' : 'Create'}</button>
        <button id="hgf-cancel">Cancel</button>
        <span id="hgf-error" class="error" hidden></span>
      </div>
    </div>`;

  document.getElementById('hgf-cancel').onclick = () => { el.hidden = true; el.innerHTML = ''; };
  document.getElementById('hgf-submit').onclick = async () => {
    const errEl = document.getElementById('hgf-error');
    errEl.hidden = true;
    const name = document.getElementById('hgf-name').value.trim();
    if (!name) { errEl.textContent = 'Name is required'; errEl.hidden = false; return; }
    try {
      if (isEdit) await call('hostgroup.update', { groupid, name });
      else        await call('hostgroup.create', { name });
      el.hidden = true; el.innerHTML = '';
      await loadGroups();
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  };
}
