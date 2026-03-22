/**
 * Administration › Proxies — read-only list
 * Route: #/admin/proxies
 */
import { call } from '../api.js';
import { content, esc } from '../app.js';

const MODE_LABEL = { '0': 'Active', '1': 'Passive' };

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Proxies</h2>
    </div>
    <div id="proxy-content"><p class="loading">Loading…</p></div>
  `;
  await loadProxies();
}

async function loadProxies() {
  const el = document.getElementById('proxy-content');
  if (!el) return;
  try {
    const proxies = await call('proxy.get', { output: 'extend', limit: 500 });
    if (!proxies.length) {
      el.innerHTML = '<p class="empty">No proxies configured.</p>';
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const rows = proxies.map(p => {
      const lastaccess = parseInt(p.lastaccess);
      let lastSeen = 'Never';
      if (lastaccess > 0) {
        const diff = now - lastaccess;
        if (diff < 60)        lastSeen = `${diff}s ago`;
        else if (diff < 3600) lastSeen = `${Math.floor(diff / 60)}m ago`;
        else if (diff < 86400) lastSeen = `${Math.floor(diff / 3600)}h ago`;
        else                  lastSeen = new Date(lastaccess * 1000).toLocaleDateString();
      }
      const statusClass = lastaccess > 0 && now - lastaccess < 120 ? 'status-ok' : 'status-dis';
      return `
        <tr>
          <td>${esc(p.name)}</td>
          <td>${MODE_LABEL[p.operating_mode] || p.operating_mode}</td>
          <td class="${statusClass}">${lastSeen}</td>
          <td>${esc(p.hosts_count || '0')}</td>
          <td class="muted">${esc(p.description)}</td>
        </tr>`;
    }).join('');

    el.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Mode</th>
            <th>Last seen</th>
            <th>Hosts</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch (e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
