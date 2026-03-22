/**
 * Host items page — list of items for a given hostid.
 * URL: #/hosts/:hostid/items
 */
import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';

const VALUE_TYPE = ['Float', 'String', 'Log', 'Uint', 'Text'];
const STATE_LABEL = ['Normal', 'Not supported'];

export async function render(root, hostid) {
  const el = content();
  el.innerHTML = '<p class="loading">Loading…</p>';

  try {
    const [hosts, items] = await Promise.all([
      call('host.get', {
        hostids: [hostid],
        output: ['hostid', 'host', 'name', 'status'],
        selectInterfaces: ['main', 'useip', 'ip', 'dns', 'port'],
      }),
      call('item.get', {
        hostids: [hostid],
        output: 'extend',
        selectLastValues: true,
        sortfield: 'name',
        limit: 1000,
      }),
    ]);

    const host = hosts[0];
    if (!host) { el.innerHTML = '<p class="error">Host not found.</p>'; return; }

    el.innerHTML = renderPage(host, items);

    // click on item row → item history page
    el.querySelectorAll('tr[data-itemid]').forEach(tr => {
      tr.addEventListener('click', () => navigate(`/item?itemid=${tr.dataset.itemid}`));
    });

    // search filter (client-side)
    document.getElementById('item-search').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      el.querySelectorAll('tr[data-itemid]').forEach(tr => {
        tr.style.display = tr.dataset.name.toLowerCase().includes(q) ? '' : 'none';
      });
    });

  } catch (e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderPage(host, items) {
  const iface = (host.interfaces || []).find(i => i.main === '1') || host.interfaces?.[0];
  const addr = iface ? (iface.useip === '1' ? iface.ip : iface.dns) + ':' + iface.port : '';

  const rows = items.map(item => {
    const vt = parseInt(item.value_type);
    const state = parseInt(item.state);
    const isNumeric = vt === 0 || vt === 3;
    const stateClass = state === 1 ? ' class="status-dis"' : '';
    const lastval = item.lastvalue != null
      ? esc(String(item.lastvalue)) + (item.units ? ' ' + esc(item.units) : '')
      : '—';
    const lastclock = item.lastclock && item.lastclock !== '0'
      ? new Date(parseInt(item.lastclock) * 1000).toLocaleString()
      : '—';
    // only numeric items are clickable (have meaningful history graph)
    const clickable = isNumeric ? ' class="clickable"' : '';
    return `
      <tr data-itemid="${esc(item.itemid)}" data-name="${esc((item.name_resolved || item.name).toLowerCase())}"${clickable}>
        <td>${esc(item.name_resolved || item.name)}</td>
        <td><code>${esc(item.key_)}</code></td>
        <td${stateClass}>${STATE_LABEL[state] || state}</td>
        <td>${VALUE_TYPE[vt] || vt}${item.units ? ' / ' + esc(item.units) : ''}</td>
        <td>${lastval}</td>
        <td>${lastclock}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="page-header">
      <h2>
        <a href="#/hosts" class="breadcrumb">Hosts</a>
        <span class="sep">›</span>
        ${esc(host.name || host.host)}
        ${addr ? `<small class="host-addr">${esc(addr)}</small>` : ''}
      </h2>
      <div class="toolbar">
        <input id="item-search" type="search" placeholder="Filter items…">
        <span class="muted">${items.length} items</span>
      </div>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th><th>Key</th><th>State</th><th>Type / Units</th><th>Last value</th><th>Last check</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
