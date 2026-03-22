import { call } from '../api.js';
import { content, esc } from '../app.js';
import { multiselect } from '../utils/multiselect.js';

const GUI_ACCESS_LABEL = ['System default', 'Internal', 'LDAP', 'Disabled'];

// Colour classes for GUI access values
function guiClass(val) {
  if (val === 1) return 'color:var(--sev-warn)';  // Internal → orange
  if (val === 3) return 'color:var(--danger)';     // Disabled → red
  return 'color:#4caf50';                           // System default / LDAP → green
}

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>User groups</h2>
      <div class="toolbar">
        <input id="ug-search" type="search" placeholder="Search…" style="width:180px">
        <button id="ug-create-btn">+ New group</button>
      </div>
    </div>
    <div id="ug-form-wrap" hidden></div>
    <div id="ug-content"><p class="loading">Loading…</p></div>
  `;
  document.getElementById('ug-search').addEventListener('input', filterRows);
  document.getElementById('ug-create-btn').addEventListener('click', () => showForm());
  await loadGroups();
}

// ── List ──────────────────────────────────────────────────────────────────────

async function loadGroups() {
  const tc = document.getElementById('ug-content');
  if (!tc) return;
  try {
    const groups = await call('usergroup.get', {
      selectUsers: ['userid', 'username', 'name', 'surname'],
      limit: 500,
    });

    if (!groups.length) { tc.innerHTML = '<p class="empty">No user groups.</p>'; return; }

    const rows = groups.map(g => {
      const users   = g.users || [];
      const members = users.slice(0, 5).map(u => {
        const full = [u.name, u.surname].filter(Boolean).join(' ') || u.username;
        return `<span class="tag">${esc(full)}</span>`;
      }).join('');
      const more    = users.length > 5 ? `<span class="muted"> +${users.length - 5}</span>` : '';

      const guiIdx  = parseInt(g.gui_access) || 0;
      const debug   = parseInt(g.debug_mode) === 1;
      const enabled = parseInt(g.users_status) === 0;

      return `
        <tr data-name="${esc(g.name.toLowerCase())}">
          <td>
            <a href="#" class="ug-edit-link" data-id="${esc(g.usrgrpid)}">${esc(g.name)}</a>
          </td>
          <td class="muted" style="text-align:center">${users.length}</td>
          <td>${members}${more}</td>
          <td style="${guiClass(guiIdx)}">${GUI_ACCESS_LABEL[guiIdx] || 'System default'}</td>
          <td>
            <a href="#" class="ug-toggle-debug" data-id="${esc(g.usrgrpid)}"
               data-val="${debug ? 0 : 1}"
               style="${debug ? 'color:var(--sev-warn)' : 'color:var(--muted)'}">
              ${debug ? 'Enabled' : 'Disabled'}
            </a>
          </td>
          <td>
            <a href="#" class="ug-toggle-status" data-id="${esc(g.usrgrpid)}"
               data-val="${enabled ? 1 : 0}"
               style="${enabled ? 'color:#4caf50' : 'color:var(--danger)'}">
              ${enabled ? 'Enabled' : 'Disabled'}
            </a>
          </td>
          <td class="row-actions">
            <button class="btn-small ug-edit-btn" data-id="${esc(g.usrgrpid)}">Edit</button>
            <button class="btn-small btn-danger ug-del-btn"
                    data-id="${esc(g.usrgrpid)}" data-name="${esc(g.name)}">Del</button>
          </td>
        </tr>`;
    }).join('');

    tc.innerHTML = `
      <table class="data-table" id="ug-table">
        <thead><tr>
          <th>Name</th>
          <th style="text-align:center">#</th>
          <th>Members</th>
          <th>Frontend access</th>
          <th>Debug mode</th>
          <th>Status</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    tc.addEventListener('click', async e => {
      const btn = e.target.closest('[data-id]');
      if (!btn) return;
      e.preventDefault();
      const id   = btn.dataset.id;
      const name = btn.dataset.name || '';
      if (btn.classList.contains('ug-edit-link') || btn.classList.contains('ug-edit-btn')) {
        await openEdit(id);
      } else if (btn.classList.contains('ug-del-btn')) {
        if (!confirm(`Delete group "${name}"?`)) return;
        try { await call('usergroup.delete', { usrgrpids: [id] }); await loadGroups(); }
        catch (ex) { alert(ex.message); }
      } else if (btn.classList.contains('ug-toggle-debug')) {
        try {
          await call('usergroup.update', { usrgrpid: id, debug_mode: parseInt(btn.dataset.val) });
          await loadGroups();
        } catch (ex) { alert(ex.message); }
      } else if (btn.classList.contains('ug-toggle-status')) {
        try {
          await call('usergroup.update', { usrgrpid: id, users_status: parseInt(btn.dataset.val) });
          await loadGroups();
        } catch (ex) { alert(ex.message); }
      }
    });
  } catch (e) {
    tc.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ── Edit form ─────────────────────────────────────────────────────────────────

async function openEdit(gid) {
  const groups = await call('usergroup.get', {
    usrgrpids:         [gid],
    selectUsers:       ['userid', 'username', 'name', 'surname'],
    selectRights:      true,
    selectTagFilters:  true,
  });
  if (groups[0]) showForm(groups[0]);
}

async function showForm(group = null) {
  const fw = document.getElementById('ug-form-wrap');
  if (!fw) return;
  fw.hidden = false;
  fw.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const isEdit = !!group;

  // Load reference data in parallel
  const [allUsers, allHostGroups, allTplGroups] = await Promise.all([
    call('user.get', { output: ['userid', 'username', 'name', 'surname'], limit: 1000 }).catch(() => []),
    call('hostgroup.get', { output: ['groupid', 'name'], limit: 1000 }).catch(() => []),
    call('templategroup.get', { output: ['groupid', 'name'], limit: 1000 }).catch(() => []),
  ]);

  const curRights   = group?.rights || [];
  const hostRights  = curRights.filter(r => r.type === '0');
  const tplRights   = curRights.filter(r => r.type === '1');
  const tagFilters  = group?.tag_filters || [];
  const curUserIds  = (group?.users || []).map(u => String(u.userid));

  const guiOpts = GUI_ACCESS_LABEL.map((label, i) =>
    `<option value="${i}"${parseInt(group?.gui_access) === i ? ' selected' : ''}>${label}</option>`
  ).join('');

  const hgOpts = allHostGroups.map(g =>
    `<option value="${esc(g.groupid)}">${esc(g.name)}</option>`
  ).join('');
  const tgOpts = allTplGroups.map(g =>
    `<option value="${esc(g.groupid)}">${esc(g.name)}</option>`
  ).join('');

  fw.innerHTML = `
    <div class="inline-form" style="max-width:820px">
      <h3>${isEdit ? `Edit: ${esc(group.name)}` : 'New user group'}</h3>

      <div class="tab-bar">
        <a href="#" class="tab-btn tab-active" data-panel="ug-panel-main">User group</a>
        <a href="#" class="tab-btn" data-panel="ug-panel-hp">Host permissions</a>
        <a href="#" class="tab-btn" data-panel="ug-panel-tp">Template permissions</a>
        <a href="#" class="tab-btn" data-panel="ug-panel-tf">Problem tag filter</a>
      </div>

      <!-- Tab 1: main settings -->
      <div id="ug-panel-main">
        <label class="form-wide">Group name *
          <input id="gf-name" value="${esc(group?.name || '')}" style="max-width:400px">
        </label>
        <label class="form-wide" style="margin-top:0.5rem">Users
          <div id="gf-users-ms"></div>
        </label>
        <div class="form-grid" style="margin-top:0.5rem">
          <label>Frontend access
            <select id="gf-gui" style="max-width:220px">${guiOpts}</select>
          </label>
          <label style="flex-direction:row;align-items:center;gap:0.4rem">
            <input id="gf-enabled" type="checkbox"
              ${parseInt(group?.users_status) === 0 ? 'checked' : ''}>
            Enabled
          </label>
          <label style="flex-direction:row;align-items:center;gap:0.4rem">
            <input id="gf-debug" type="checkbox"
              ${parseInt(group?.debug_mode) === 1 ? 'checked' : ''}>
            Debug mode
          </label>
        </div>
      </div>

      <!-- Tab 2: host permissions -->
      <div id="ug-panel-hp" hidden>
        <table class="data-table" id="hp-table" style="margin-bottom:0.5rem">
          <thead>
            <tr><th>Host groups</th><th>Permissions</th><th></th></tr>
          </thead>
          <tbody id="hp-body"></tbody>
          <tfoot>
            <tr><td colspan="3">
              <button type="button" id="hp-add-btn" class="btn-small" style="margin-top:4px">
                + Add
              </button>
            </td></tr>
          </tfoot>
        </table>
      </div>

      <!-- Tab 3: template permissions -->
      <div id="ug-panel-tp" hidden>
        <table class="data-table" id="tp-table" style="margin-bottom:0.5rem">
          <thead>
            <tr><th>Template groups</th><th>Permissions</th><th></th></tr>
          </thead>
          <tbody id="tp-body"></tbody>
          <tfoot>
            <tr><td colspan="3">
              <button type="button" id="tp-add-btn" class="btn-small" style="margin-top:4px">
                + Add
              </button>
            </td></tr>
          </tfoot>
        </table>
      </div>

      <!-- Tab 4: problem tag filter -->
      <div id="ug-panel-tf" hidden>
        <table class="data-table" id="tf-table" style="margin-bottom:0.5rem">
          <thead>
            <tr><th>Host groups</th><th>Tag</th><th>Value</th><th></th></tr>
          </thead>
          <tbody id="tf-body"></tbody>
          <tfoot>
            <tr><td colspan="4">
              <button type="button" id="tf-add-btn" class="btn-small" style="margin-top:4px">
                + Add
              </button>
            </td></tr>
          </tfoot>
        </table>
      </div>

      <div class="form-actions">
        <button id="gf-submit">${isEdit ? 'Update' : 'Add'}</button>
        ${isEdit ? '<button id="gf-delete" class="btn-alt">Delete</button>' : ''}
        <button id="gf-cancel">Cancel</button>
        <span id="gf-error" class="error" hidden></span>
      </div>
    </div>`;

  // ── Tab switching ──────────────────────────────────────────────────────────
  const panels = ['ug-panel-main', 'ug-panel-hp', 'ug-panel-tp', 'ug-panel-tf'];
  fw.querySelectorAll('.tab-btn[data-panel]').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      fw.querySelectorAll('.tab-btn[data-panel]').forEach(t => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');
      panels.forEach(id => { document.getElementById(id).hidden = (id !== tab.dataset.panel); });
    });
  });

  // ── Users multiselect ──────────────────────────────────────────────────────
  const msUsers = multiselect(
    document.getElementById('gf-users-ms'),
    allUsers,
    null,
    { idField: 'userid', nameField: 'username', placeholder: 'Add user…', selectedIds: curUserIds },
  );

  // ── Populate permission rows ───────────────────────────────────────────────
  for (const r of hostRights) addPermRow('hp-body', hgOpts, r.id, parseInt(r.permission));
  for (const r of tplRights)  addPermRow('tp-body', tgOpts, r.id, parseInt(r.permission));
  for (const tf of tagFilters) addTagFilterRow('tf-body', hgOpts, tf.groupid, tf.tag, tf.value);

  // ── "Add row" buttons ──────────────────────────────────────────────────────
  document.getElementById('hp-add-btn').addEventListener('click', () => addPermRow('hp-body', hgOpts));
  document.getElementById('tp-add-btn').addEventListener('click', () => addPermRow('tp-body', tgOpts));
  document.getElementById('tf-add-btn').addEventListener('click', () => addTagFilterRow('tf-body', hgOpts));

  // ── Cancel ─────────────────────────────────────────────────────────────────
  document.getElementById('gf-cancel').onclick = () => { fw.hidden = true; fw.innerHTML = ''; };

  // ── Delete ─────────────────────────────────────────────────────────────────
  if (isEdit) {
    document.getElementById('gf-delete').onclick = async () => {
      if (!confirm(`Delete group "${group.name}"?`)) return;
      const errEl = document.getElementById('gf-error');
      try {
        await call('usergroup.delete', { usrgrpids: [group.usrgrpid] });
        fw.hidden = true; fw.innerHTML = '';
        await loadGroups();
      } catch (ex) { errEl.textContent = ex.message; errEl.hidden = false; }
    };
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  document.getElementById('gf-submit').onclick = async () => {
    const errEl = document.getElementById('gf-error');
    errEl.hidden = true;

    const name = document.getElementById('gf-name').value.trim();
    if (!name) { errEl.textContent = 'Group name is required'; errEl.hidden = false; return; }

    const p = {
      name,
      gui_access:           parseInt(document.getElementById('gf-gui').value),
      users_status:         document.getElementById('gf-enabled').checked ? 0 : 1,
      debug_mode:           document.getElementById('gf-debug').checked ? 1 : 0,
      users:                msUsers.getIds().map(id => ({ userid: id })),
      hostgroup_rights:     collectPermRows('hp-body'),
      templategroup_rights: collectPermRows('tp-body'),
      tag_filters:          collectTagFilterRows('tf-body'),
    };

    try {
      if (isEdit) { p.usrgrpid = group.usrgrpid; await call('usergroup.update', p); }
      else await call('usergroup.create', p);
      fw.hidden = true; fw.innerHTML = '';
      await loadGroups();
    } catch (ex) { errEl.textContent = ex.message; errEl.hidden = false; }
  };
}

// ── Permission row helpers ────────────────────────────────────────────────────

function addPermRow(bodyId, groupOpts, selectedGid = '', perm = 0) {
  const body = document.getElementById(bodyId);
  if (!body) return;

  // Unique name for the radio group in this row
  const rname = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="perm-group-sel" style="max-width:300px">${groupOpts}</select>
    </td>
    <td style="white-space:nowrap">
      <label style="margin-right:0.75rem;cursor:pointer">
        <input type="radio" name="${rname}" value="3"> Read-write
      </label>
      <label style="margin-right:0.75rem;cursor:pointer">
        <input type="radio" name="${rname}" value="2"> Read
      </label>
      <label style="cursor:pointer">
        <input type="radio" name="${rname}" value="0" checked> Deny
      </label>
    </td>
    <td>
      <button type="button" class="btn-small btn-danger perm-del-btn">Remove</button>
    </td>`;

  body.appendChild(tr);

  if (selectedGid) tr.querySelector('.perm-group-sel').value = String(selectedGid);

  // Set checked radio
  const permVal = (perm === 3 || perm === 2) ? String(perm) : '0';
  const radio = tr.querySelector(`input[value="${permVal}"]`);
  if (radio) radio.checked = true;

  tr.querySelector('.perm-del-btn').addEventListener('click', () => tr.remove());
}

function addTagFilterRow(bodyId, groupOpts, selectedGid = '', tag = '', value = '') {
  const body = document.getElementById(bodyId);
  if (!body) return;

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="tf-group-sel" style="max-width:220px">${groupOpts}</select>
    </td>
    <td><input type="text" class="tf-tag" value="${esc(tag)}" placeholder="Tag name" style="width:140px"></td>
    <td><input type="text" class="tf-value" value="${esc(value)}" placeholder="Tag value" style="width:140px"></td>
    <td>
      <button type="button" class="btn-small btn-danger tf-del-btn">Remove</button>
    </td>`;

  body.appendChild(tr);

  if (selectedGid) tr.querySelector('.tf-group-sel').value = String(selectedGid);
  tr.querySelector('.tf-del-btn').addEventListener('click', () => tr.remove());
}

function collectPermRows(bodyId) {
  const body = document.getElementById(bodyId);
  if (!body) return [];
  return [...body.querySelectorAll('tr')].flatMap(tr => {
    const gid  = tr.querySelector('.perm-group-sel')?.value;
    const perm = tr.querySelector('input[type=radio]:checked')?.value;
    return gid && perm ? [{ id: gid, permission: parseInt(perm) }] : [];
  });
}

function collectTagFilterRows(bodyId) {
  const body = document.getElementById(bodyId);
  if (!body) return [];
  return [...body.querySelectorAll('tr')].flatMap(tr => {
    const gid   = tr.querySelector('.tf-group-sel')?.value;
    const tag   = tr.querySelector('.tf-tag')?.value.trim() ?? '';
    const value = tr.querySelector('.tf-value')?.value.trim() ?? '';
    return gid ? [{ groupid: gid, tag, value }] : [];
  });
}

// ── Search filter ─────────────────────────────────────────────────────────────

function filterRows() {
  const q = document.getElementById('ug-search')?.value.toLowerCase() || '';
  document.querySelectorAll('#ug-table tbody tr[data-name]').forEach(tr => {
    tr.style.display = !q || tr.dataset.name.includes(q) ? '' : 'none';
  });
}
