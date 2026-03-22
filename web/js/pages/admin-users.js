import { call } from '../api.js';
import { content, esc } from '../app.js';
import { multiselect } from '../utils/multiselect.js';

const ROLE_TYPE = { '1': 'User', '2': 'Admin', '3': 'Super admin' };

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Users</h2>
      <div class="toolbar">
        <input id="usr-search" type="search" placeholder="Search…">
        <button id="usr-create-btn">+ New user</button>
      </div>
    </div>
    <div id="usr-mass-bar" hidden style="display:flex;gap:4px;align-items:center;margin-bottom:0.5rem">
      <button id="usr-mass-unblock" class="btn-small">Unblock</button>
      <button id="usr-mass-delete" class="btn-small btn-danger">Delete</button>
    </div>
    <div id="usr-form-wrap" hidden></div>
    <div id="usr-content"><p class="loading">Loading…</p></div>
  `;

  document.getElementById('usr-search').addEventListener('input', filterRows);
  document.getElementById('usr-create-btn').addEventListener('click', () => showForm());
  document.getElementById('usr-mass-unblock').addEventListener('click', massUnblock);
  document.getElementById('usr-mass-delete').addEventListener('click', massDelete);

  await loadUsers();
}

async function loadUsers() {
  const tc = document.getElementById('usr-content');
  if (!tc) return;
  try {
    const users = await call('user.get', { output: 'extend', selectUsrgrps: ['usrgrpid', 'name'], limit: 500 });
    if (!users.length) { tc.innerHTML = '<p class="empty">No users.</p>'; return; }

    const rows = users.map(u => {
      const groups   = (u.usrgrps || []).map(g => `<span class="tag">${esc(g.name)}</span>`).join('');
      const roleName = u.role_name || ROLE_TYPE[u.role_type] || `Role ${u.roleid}`;
      const loginOk  = parseInt(u.attempt_failed) === 0;
      return `
        <tr data-name="${esc(u.username.toLowerCase())}" data-userid="${esc(u.userid)}">
          <td class="cb-cell" onclick="event.stopPropagation()">
            <input type="checkbox" class="usr-cb" data-id="${esc(u.userid)}">
          </td>
          <td><a href="#" onclick="event.preventDefault();editUser('${esc(u.userid)}')">${esc(u.username)}</a></td>
          <td>${esc(u.name || '')}</td>
          <td>${esc(u.surname || '')}</td>
          <td class="muted" style="font-size:0.82rem">${esc(roleName)}</td>
          <td class="tags-cell">${groups || '<span class="muted">—</span>'}</td>
          <td class="${loginOk ? 'status-ok' : 'status-dis'}" style="font-size:0.82rem">
            ${loginOk ? 'Ok' : `${u.attempt_failed} failed`}
          </td>
          <td class="row-actions" onclick="event.stopPropagation()">
            <button class="btn-small" onclick="editUser('${esc(u.userid)}')">Edit</button>
            ${!loginOk ? `<button class="btn-small" onclick="unblockUser('${esc(u.userid)}')">Unblock</button>` : ''}
            <button class="btn-small btn-danger" onclick="deleteUser('${esc(u.userid)}','${esc(u.username)}')">Del</button>
          </td>
        </tr>`;
    }).join('');

    tc.innerHTML = `
      <table class="data-table" id="usr-table">
        <thead><tr>
          <th class="cb-cell"><input type="checkbox" id="usr-cb-all"></th>
          <th>Username</th><th>Name</th><th>Last name</th><th>Role</th><th>Groups</th><th>Login</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    document.getElementById('usr-cb-all')?.addEventListener('change', e => {
      tc.querySelectorAll('.usr-cb').forEach(cb => { cb.checked = e.target.checked; });
      updateMassBar();
    });
    tc.querySelectorAll('.usr-cb').forEach(cb => cb.addEventListener('change', updateMassBar));
  } catch (e) {
    tc.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function updateMassBar() {
  const n = document.querySelectorAll('#usr-table .usr-cb:checked').length;
  const bar = document.getElementById('usr-mass-bar');
  if (bar) bar.hidden = n === 0;
}

async function massUnblock() {
  const ids = [...document.querySelectorAll('#usr-table .usr-cb:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  try {
    for (const id of ids) await call('user.update', { userid: id, attempt_failed: 0 });
    await loadUsers();
  } catch(e) { alert(e.message); }
}

async function massDelete() {
  const ids = [...document.querySelectorAll('#usr-table .usr-cb:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} user(s)?`)) return;
  try { await call('user.delete', { userids: ids }); await loadUsers(); }
  catch(e) { alert(e.message); }
}

async function showForm(user = null) {
  const fw = document.getElementById('usr-form-wrap');
  if (!fw) return;
  fw.hidden = false;
  const isEdit = !!user;

  const [roles, allGroups] = await Promise.all([
    call('role.get', { output: ['roleid', 'name'] }).catch(() => []),
    call('usergroup.get', { output: ['usrgrpid', 'name'] }).catch(() => []),
  ]);

  const roleOpts = roles.map(r =>
    `<option value="${esc(r.roleid)}"${String(user?.roleid) === String(r.roleid) ? ' selected' : ''}>${esc(r.name)}</option>`
  ).join('');

  fw.innerHTML = `
    <div class="inline-form">
      <h3>${isEdit ? 'Edit user' : 'New user'}</h3>
      <label class="form-wide">Username *<input id="uf-uname" value="${esc(user?.username||'')}"></label>
      <label class="form-wide">Password ${isEdit ? '(leave blank to keep)' : '*'}<input id="uf-pass" type="password" autocomplete="new-password"></label>
      <div class="form-grid">
        <label>First name<input id="uf-name" value="${esc(user?.name||'')}"></label>
        <label>Last name<input id="uf-surn" value="${esc(user?.surname||'')}"></label>
        <label>Role<select id="uf-role">${roleOpts}</select></label>
      </div>
      <label class="form-wide">User groups<div id="uf-groups-ms"></div></label>
      <div class="form-actions">
        <button id="uf-submit">${isEdit ? 'Save' : 'Create'}</button>
        <button id="uf-cancel">Cancel</button>
        <span id="uf-error" class="error" hidden></span>
      </div>
    </div>`;

  const curGrpIds = (user?.usrgrps || []).map(g => String(g.usrgrpid));
  const msGroups = multiselect(
    document.getElementById('uf-groups-ms'), allGroups, null,
    { idField: 'usrgrpid', nameField: 'name', placeholder: 'Add group…', selectedIds: curGrpIds }
  );

  document.getElementById('uf-cancel').onclick = () => { fw.hidden = true; fw.innerHTML = ''; };
  document.getElementById('uf-submit').onclick = async () => {
    const errEl = document.getElementById('uf-error');
    errEl.hidden = true;
    const p = {
      username: document.getElementById('uf-uname').value.trim(),
      name:     document.getElementById('uf-name').value.trim(),
      surname:  document.getElementById('uf-surn').value.trim(),
      roleid:   document.getElementById('uf-role').value,
      usrgrps:  msGroups.getIds().map(id => ({ usrgrpid: id })),
    };
    const pass = document.getElementById('uf-pass').value;
    if (pass) p.passwd = pass;
    try {
      if (isEdit) { p.userid = user.userid; await call('user.update', p); }
      else {
        if (!pass) { errEl.textContent = 'Password required'; errEl.hidden = false; return; }
        await call('user.create', p);
      }
      fw.hidden = true; fw.innerHTML = '';
      await loadUsers();
    } catch(e) { errEl.textContent = e.message; errEl.hidden = false; }
  };
}

window.editUser = async (uid) => {
  const users = await call('user.get', { userids: [uid], output: 'extend', selectUsrgrps: ['usrgrpid', 'name'] });
  if (users[0]) showForm(users[0]);
};
window.deleteUser = async (uid, name) => {
  if (!confirm(`Delete user "${name}"?`)) return;
  try { await call('user.delete', { userids: [uid] }); await loadUsers(); }
  catch(e) { alert(e.message); }
};
window.unblockUser = async (uid) => {
  try { await call('user.update', { userid: uid, attempt_failed: 0 }); await loadUsers(); }
  catch(e) { alert(e.message); }
};

function filterRows() {
  const q = document.getElementById('usr-search')?.value.toLowerCase() || '';
  document.querySelectorAll('#usr-table tr[data-name]').forEach(tr => {
    tr.style.display = !q || tr.dataset.name.includes(q) ? '' : 'none';
  });
}
