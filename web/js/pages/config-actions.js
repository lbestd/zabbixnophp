import { call } from '../api.js';
import { content, esc } from '../app.js';

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Actions</h2>
      <div class="toolbar">
        <input id="act-search" type="search" placeholder="Search…" style="width:180px">
      </div>
    </div>
    <div id="act-content"><p class="loading">Loading…</p></div>
  `;

  document.getElementById('act-search').addEventListener('input', filterRows);
  await loadActions();
}

async function loadActions() {
  const tc = document.getElementById('act-content');
  try {
    const actions = await call('action.get', { limit: 500 });
    if (!actions.length) { tc.innerHTML = '<p class="empty">No actions configured.</p>'; return; }

    const rows = actions.map(a => `
      <tr data-name="${esc(a.name.toLowerCase())}">
        <td>${esc(a.name)}</td>
        <td class="muted">${esc(a.eventsource_name)}</td>
        <td>${esc(a.esc_period)}</td>
        <td class="${parseInt(a.status)===0?'status-ok':'muted'}">${esc(a.status_name)}</td>
      </tr>`).join('');

    tc.innerHTML = `
      <table class="data-table" id="act-table">
        <thead><tr><th>Name</th><th>Event source</th><th>Escalation period</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted" style="font-size:0.82rem;margin-top:0.75rem">Actions are read-only. Edit in native Zabbix UI.</p>`;
  } catch(e) {
    tc.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function filterRows() {
  const q = document.getElementById('act-search')?.value.toLowerCase() || '';
  document.querySelectorAll('#act-table tr[data-name]').forEach(tr => {
    tr.style.display = !q || tr.dataset.name.includes(q) ? '' : 'none';
  });
}
