import { call } from '../api.js';
import { content, esc } from '../app.js';

const ACTION_OPTS = [
  ['' , 'All actions'], ['0','Add'], ['1','Update'], ['2','Delete'],
  ['4','Login'], ['5','Failed login'], ['3','Logout'],
];

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header"><h2>Audit log</h2></div>
    <div class="filter-panel">
      <div class="filter-row">
        <label>Action
          <select id="al-action">
            ${ACTION_OPTS.map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
        </label>
        <label>From<input type="datetime-local" id="al-from"></label>
        <label>To<input type="datetime-local" id="al-till"></label>
        <button id="al-apply">Apply</button>
        <button id="al-reset" class="btn-muted">Reset</button>
      </div>
    </div>
    <div id="al-content"><p class="loading">Loading…</p></div>
  `;

  document.getElementById('al-apply').addEventListener('click', loadLog);
  document.getElementById('al-reset').addEventListener('click', () => {
    document.getElementById('al-action').value = '';
    document.getElementById('al-from').value = '';
    document.getElementById('al-till').value = '';
    loadLog();
  });

  await loadLog();
}

async function loadLog() {
  const tc = document.getElementById('al-content');
  tc.innerHTML = '<p class="loading">Loading…</p>';

  const actionVal = document.getElementById('al-action')?.value;
  const fromVal   = document.getElementById('al-from')?.value;
  const tillVal   = document.getElementById('al-till')?.value;

  const params = { limit: 200 };
  if (actionVal !== '') params.action = actionVal;
  if (fromVal) params.time_from = Math.floor(new Date(fromVal).getTime() / 1000);
  if (tillVal) params.time_till = Math.floor(new Date(tillVal).getTime() / 1000);

  try {
    const rows = await call('auditlog.get', params);
    if (!rows.length) { tc.innerHTML = '<p class="empty">No audit records.</p>'; return; }

    const trs = rows.map(r => `
      <tr>
        <td style="white-space:nowrap;font-size:0.82rem">${esc(new Date(parseInt(r.clock)*1000).toLocaleString())}</td>
        <td>${esc(r.username)}</td>
        <td class="muted">${esc(r.ip)}</td>
        <td>${esc(r.action_name)}</td>
        <td>${esc(r.resource_name)}</td>
        <td>${esc(r.resourcename)}</td>
        <td class="muted" style="font-size:0.8rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.details)}">${esc(r.details)}</td>
      </tr>`).join('');

    tc.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Time</th><th>User</th><th>IP</th><th>Action</th><th>Resource type</th><th>Resource</th><th>Details</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>`;
  } catch(e) {
    tc.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
