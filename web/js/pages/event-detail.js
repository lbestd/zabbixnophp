/**
 * Event detail — #/events/:eventid
 * Shows event info, acknowledge history, ack form.
 */
import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';

const SEV_LABEL = ['Not classified','Information','Warning','Average','High','Disaster'];
const SEV_CLASS = ['sev-nc','sev-info','sev-warn','sev-avg','sev-high','sev-dis'];

// action bitmask labels
const ACK_ACTION = [
  [2,  'Acknowledged'],
  [4,  'Message'],
  [1,  'Closed'],
  [8,  'Severity changed'],
  [16, 'Unacknowledged'],
  [32, 'Suppressed'],
  [64, 'Unsuppressed'],
];

export async function render(root, eventid) {
  const el = content();
  el.innerHTML = '<p class="loading">Loading…</p>';

  try {
    const events = await call('event.get', {
      eventids:           [eventid],
      output:             'extend',
      selectTags:         ['tag','value'],
      selectAcknowledges: ['acknowledgeid','userid','clock','message','action','new_severity'],
    });
    const ev = events[0];
    if (!ev) { el.innerHTML = '<p class="error">Event not found.</p>'; return; }

    // resolve trigger description
    let trigDesc = '', hostName = '', hostid = '';
    const triggers = await call('trigger.get', {
      triggerids: [ev.objectid], output: ['description'],
      selectHosts: ['hostid','name'], limit: 1,
    }).catch(() => []);
    if (triggers[0]) {
      trigDesc = triggers[0].description || '';
      const h = triggers[0].hosts?.[0];
      if (h) { hostName = h.name; hostid = h.hostid; }
    }

    const sev   = parseInt(ev.severity);
    const time  = new Date(parseInt(ev.clock) * 1000).toLocaleString();
    const acked = ev.acknowledged === '1' || ev.acknowledged === 1;
    const tags  = (ev.tags || []).map(t =>
      `<span class="tag">${esc(t.tag)}${t.value ? ': '+esc(t.value) : ''}</span>`
    ).join(' ');

    // Resolve userids → usernames
    const ackList = ev.acknowledges || [];
    const uids = [...new Set(ackList.map(a => a.userid).filter(Boolean))];
    let userMap = {};
    if (uids.length) {
      const users = await call('user.get', { userids: uids, output: ['userid','username','name','surname'] }).catch(() => []);
      users.forEach(u => { userMap[String(u.userid)] = u.username || `${u.name} ${u.surname}`.trim() || u.userid; });
    }

    const acksHtml = buildAckTimeline(ackList, userMap);

    el.innerHTML = `
      <div class="page-header">
        <h2>
          <a href="#/problems" class="breadcrumb">Problems</a>
          <span class="sep">›</span>
          Event #${esc(eventid)}
        </h2>
      </div>

      <div class="event-card surface-box">
        <div class="event-header ${SEV_CLASS[sev] || ''}">
          <span class="sev-badge">${esc(SEV_LABEL[sev] || sev)}</span>
          <span class="event-name">${esc(ev.name || trigDesc)}</span>
        </div>
        <dl class="event-meta">
          <dt>Host</dt>
          <dd>${hostid
            ? `<a href="#/hosts/${esc(hostid)}/items">${esc(hostName)}</a>`
            : esc(hostName||'—')}</dd>
          <dt>Trigger</dt>
          <dd>${esc(trigDesc||'—')}</dd>
          <dt>Time</dt>
          <dd>${time}</dd>
          <dt>Status</dt>
          <dd>${acked ? '<span class="status-ok">Acknowledged</span>' : '<span class="sev-dis">Not acknowledged</span>'}</dd>
          ${tags ? `<dt>Tags</dt><dd>${tags}</dd>` : ''}
        </dl>
      </div>

      <h3 style="margin:1.5rem 0 0.75rem">Acknowledge history</h3>
      <div id="ack-timeline">
        ${acksHtml || '<p class="empty">No acknowledges yet.</p>'}
      </div>

      <div id="ack-form-area">
        ${!acked ? `
          <div class="inline-form" style="max-width:520px;margin-top:1rem">
            <h3>Acknowledge</h3>
            <div class="form-grid">
              <label class="form-wide">Message (optional)
                <input id="ack-msg" placeholder="Enter message…">
              </label>
              <label>Severity change
                <select id="ack-sev">
                  <option value="-1">— no change —</option>
                  ${SEV_LABEL.map((l,i) => `<option value="${i}">${l}</option>`).join('')}
                </select>
              </label>
              <label><input type="checkbox" id="ack-close"> Close problem</label>
              <label><input type="checkbox" id="ack-suppress"> Suppress</label>
            </div>
            <div class="form-actions">
              <button id="ack-submit">Acknowledge</button>
              <span id="ack-error" class="error" hidden></span>
            </div>
          </div>` : ''}
      </div>
    `;

    document.getElementById('ack-submit')?.addEventListener('click', async () => {
      const errEl = document.getElementById('ack-error');
      errEl.hidden = true;
      const msg      = document.getElementById('ack-msg').value.trim();
      const close    = document.getElementById('ack-close').checked;
      const suppress = document.getElementById('ack-suppress').checked;
      const newSev   = parseInt(document.getElementById('ack-sev').value);
      let action = 2; // acknowledge
      if (msg)       action |= 4;   // message
      if (close)     action |= 1;   // close
      if (suppress)  action |= 32;  // suppress
      if (newSev >= 0) action |= 8; // severity change
      const p = { eventids: [eventid], action, message: msg };
      if (newSev >= 0) p.new_severity = newSev;
      try {
        await call('event.acknowledge', p);
        // reload page
        await render(root, eventid);
      } catch(e) {
        errEl.textContent = e.message; errEl.hidden = false;
      }
    });

  } catch(e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function buildAckTimeline(acks, userMap = {}) {
  if (!acks.length) return '';
  const rows = acks.map(a => {
    const time     = new Date(parseInt(a.clock) * 1000).toLocaleString();
    const username = userMap[String(a.userid)] || `#${a.userid}`;
    const actions  = ACK_ACTION
      .filter(([bit]) => (parseInt(a.action) & bit) !== 0)
      .map(([, label]) => label).join(', ') || '—';
    const sevChange = (parseInt(a.action) & 8) && a.new_severity != null
      ? ` → ${SEV_LABEL[parseInt(a.new_severity)] || a.new_severity}` : '';
    return `
      <tr>
        <td>${time}</td>
        <td>${esc(username)}</td>
        <td>${esc(actions)}${esc(sevChange)}</td>
        <td class="muted">${esc(a.message||'')}</td>
      </tr>`;
  }).join('');
  return `
    <table class="data-table">
      <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}
