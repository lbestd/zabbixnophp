/**
 * Dashboard — problem severity counters, host stats, last 10 problems.
 */
import { call, batch } from '../api.js';
import { content, esc } from '../app.js';

const SEVERITY = ['Not classified', 'Information', 'Warning', 'Average', 'High', 'Disaster'];
const SEV_VAR  = ['--sev-nc', '--sev-info', '--sev-warn', '--sev-avg', '--sev-high', '--sev-dis'];
const SEV_CLASS = ['sev-nc', 'sev-info', 'sev-warn', 'sev-avg', 'sev-high', 'sev-dis'];

let _timer = null;

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Dashboard</h2>
      <button id="dash-refresh">↻ Refresh</button>
    </div>
    <div id="dash-body"><p class="loading">Loading…</p></div>
  `;
  document.getElementById('dash-refresh').addEventListener('click', load);
  if (_timer) clearInterval(_timer);
  _timer = setInterval(load, 60_000);
  // stop timer on navigation away
  window.addEventListener('hashchange', () => clearInterval(_timer), { once: true });
  await load();
}

async function load() {
  const el = document.getElementById('dash-body');
  if (!el) { clearInterval(_timer); return; }

  try {
    // parallel: severity counts (6 requests) + host stats + last problems
    const sevRequests = SEVERITY.map((_, i) => ({
      method: 'problem.get',
      params: { countOutput: true, severities: [i], source: 0, object: 0 },
    }));
    const allRequests = [
      ...sevRequests,
      { method: 'host.get',    params: { countOutput: true } },
      { method: 'host.get',    params: { countOutput: true, monitored_hosts: true } },
      { method: 'problem.get', params: {
          output: ['eventid','name','severity','clock','objectid','acknowledged'],
          selectTags: ['tag','value'],
          sortfield: ['clock'], sortorder: 'DESC', limit: 10,
        }},
    ];

    const results = await batch(allRequests);
    const sevCounts = results.slice(0, 6).map(r => parseInt(r) || 0);
    const totalHosts     = parseInt(results[6]) || 0;
    const monitoredHosts = parseInt(results[7]) || 0;
    const lastProblems   = results[8] || [];

    // enrich last problems with host names
    const trigIds = [...new Set(lastProblems.map(p => p.objectid))];
    let hostMap = {};
    if (trigIds.length) {
      const triggers = await call('trigger.get', {
        triggerids: trigIds, output: ['triggerid'],
        selectHosts: ['name'], preservekeys: true,
      }).catch(() => ({}));
      for (const [tid, t] of Object.entries(triggers)) {
        hostMap[tid] = t.hosts?.[0]?.name || '';
      }
    }

    el.innerHTML = `
      ${renderSevBoxes(sevCounts)}
      ${renderHostStats(totalHosts, monitoredHosts)}
      ${renderRecentProblems(lastProblems, hostMap)}
    `;
  } catch (e) {
    if (el) el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderSevBoxes(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const boxes = SEVERITY.map((label, i) => `
    <a href="#/problems?severity=${i}" class="sev-box ${SEV_CLASS[i]}">
      <span class="sev-count">${counts[i]}</span>
      <span class="sev-label">${label}</span>
    </a>
  `).join('');
  return `
    <section class="dash-section">
      <div class="sev-boxes">${boxes}</div>
      <div class="dash-total">${total} active problem${total !== 1 ? 's' : ''}</div>
    </section>
  `;
}

function renderHostStats(total, monitored) {
  const unmonitored = total - monitored;
  return `
    <section class="dash-section">
      <h3>Hosts</h3>
      <div class="stat-row">
        <div class="stat-box"><span class="stat-num">${total}</span><span class="stat-lbl">Total</span></div>
        <div class="stat-box status-ok"><span class="stat-num">${monitored}</span><span class="stat-lbl">Monitored</span></div>
        <div class="stat-box ${unmonitored ? 'status-dis' : ''}"><span class="stat-num">${unmonitored}</span><span class="stat-lbl">Unmonitored</span></div>
      </div>
    </section>
  `;
}

function renderRecentProblems(problems, hostMap) {
  if (!problems.length) return '<section class="dash-section"><h3>Recent problems</h3><p class="empty">None</p></section>';
  const now = Math.floor(Date.now() / 1000);
  const rows = problems.map(p => {
    const sev = parseInt(p.severity);
    const age = fmtAge(now - parseInt(p.clock));
    const host = hostMap[p.objectid] ? `<span class="host-name">${esc(hostMap[p.objectid])}</span> ` : '';
    const tags = (p.tags || []).slice(0, 3).map(t =>
      `<span class="tag">${esc(t.tag)}${t.value ? ': ' + esc(t.value) : ''}</span>`
    ).join('');
    const acked = p.acknowledged === '1' || p.acknowledged === 1
      ? '<span class="acked" title="Acknowledged">✓</span> ' : '';
    return `
      <tr class="${SEV_CLASS[sev]}">
        <td class="sev-cell">${esc(SEVERITY[sev] || sev)}</td>
        <td>${acked}${host}${esc(p.name)}</td>
        <td>${age}</td>
        <td class="tags-cell">${tags}</td>
      </tr>
    `;
  }).join('');
  return `
    <section class="dash-section">
      <h3>Recent problems <a href="#/problems" class="see-all">See all →</a></h3>
      <table class="data-table">
        <thead><tr><th>Severity</th><th>Problem</th><th>Age</th><th>Tags</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function fmtAge(s) {
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  return `${Math.floor(s/86400)}d ${Math.floor((s%86400)/3600)}h`;
}
