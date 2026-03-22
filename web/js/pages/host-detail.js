/**
 * Host detail — tabbed: Items | Triggers | Discovery | Edit
 * Routes:
 *   #/hosts/:id/items
 *   #/hosts/:id/triggers
 *   #/hosts/:id/discovery
 *   #/hosts/:id/edit
 */
import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';
import { groupPicker } from '../utils/group-picker.js';
import { showItemForm as _showItemForm, ITEM_TYPE, VALUE_TYPE } from '../utils/item-form.js';

// ITEM_TYPE and VALUE_TYPE imported from item-form.js
const SEV_LABEL   = ['Not classified','Information','Warning','Average','High','Disaster'];
const SEV_CLASS   = ['sev-nc','sev-info','sev-warn','sev-avg','sev-high','sev-dis'];
const STATE_LABEL = ['Normal','Not supported'];

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function render(root, hostid, tab) {
  const el = content();
  el.innerHTML = '<p class="loading">Loading…</p>';

  try {
    const hosts = await call('host.get', {
      hostids: [hostid],
      output: ['hostid','host','name','status','description'],
      selectInterfaces: ['interfaceid','main','type','useip','ip','dns','port','available'],
      selectGroups: ['groupid','name'],
      selectParentTemplates: ['templateid','host','name'],
      selectTags: ['tag','value'],
    });
    const host = hosts[0];
    if (!host) { el.innerHTML = '<p class="error">Host not found.</p>'; return; }

    renderShell(el, host, tab);

    if      (tab === 'items')     await renderItems(hostid);
    else if (tab === 'triggers')  await renderTriggers(hostid);
    else if (tab === 'discovery') await renderDiscovery(hostid);
    else if (tab === 'macros')    await renderMacros(hostid);
    else if (tab === 'edit')      await renderEdit(host);

  } catch(e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderShell(el, host, activeTab) {
  const iface = (host.interfaces||[]).find(i=>i.main==='1') || host.interfaces?.[0];
  const addr  = iface ? (iface.useip==='1' ? iface.ip : iface.dns) + ':' + iface.port : '';
  const tabs  = ['items','triggers','discovery','macros','edit'];
  const tabHtml = tabs.map(t => `
    <a href="#/hosts/${esc(host.hostid)}/${t}"
       class="tab-btn${t===activeTab?' tab-active':''}">${tabLabel(t)}</a>
  `).join('');

  el.innerHTML = `
    <div class="page-header">
      <h2>
        <a href="#/hosts" class="breadcrumb">Hosts</a>
        <span class="sep">›</span>
        ${esc(host.name||host.host)}
        ${addr ? `<small class="host-addr">${esc(addr)}</small>` : ''}
      </h2>
    </div>
    <div class="tab-bar">${tabHtml}</div>
    <div id="tab-content"></div>
  `;
}

function tabLabel(t) {
  return {items:'Items',triggers:'Triggers',discovery:'Discovery',macros:'Macros',edit:'Edit host'}[t]||t;
}

function tc() { return document.getElementById('tab-content'); }

// ─── Items tab ───────────────────────────────────────────────────────────────

async function renderItems(hostid) {
  const el = tc();
  el.innerHTML = `
    <div class="tab-toolbar">
      <input id="item-search" type="search" placeholder="Filter by name…" style="width:180px">
      <select id="item-f-type" title="Type"><option value="">Any type</option>
        ${Object.entries(ITEM_TYPE).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}
      </select>
      <select id="item-f-vtype" title="Value type"><option value="">Any value type</option>
        ${VALUE_TYPE.map((l,i)=>`<option value="${i}">${l}</option>`).join('')}
      </select>
      <select id="item-f-state" title="State">
        <option value="">Any state</option>
        <option value="0">Normal</option>
        <option value="1">Not supported</option>
      </select>
      <select id="item-f-status" title="Status">
        <option value="">Any status</option>
        <option value="0">Enabled</option>
        <option value="1">Disabled</option>
      </select>
      <button id="item-create-btn">+ New item</button>
      <span id="item-mass-bar" hidden style="display:flex;gap:4px;margin-left:8px">
        <button id="item-mass-enable" class="btn-small">Enable</button>
        <button id="item-mass-disable" class="btn-small">Disable</button>
        <button id="item-mass-clear" class="btn-small">Clear history</button>
        <button id="item-mass-delete" class="btn-small btn-danger">Delete</button>
      </span>
    </div>
    <div id="item-create-form" hidden></div>
    <div id="items-list"><p class="loading">Loading…</p></div>
  `;
  document.getElementById('item-search').addEventListener('input', filterItemRows);
  document.getElementById('item-f-type').addEventListener('change', filterItemRows);
  document.getElementById('item-f-vtype').addEventListener('change', filterItemRows);
  document.getElementById('item-f-state').addEventListener('change', filterItemRows);
  document.getElementById('item-f-status').addEventListener('change', filterItemRows);
  document.getElementById('item-create-btn').addEventListener('click', () => showItemForm(hostid));
  document.getElementById('item-mass-enable').addEventListener('click', () => massItemAction(hostid, 'enable'));
  document.getElementById('item-mass-disable').addEventListener('click', () => massItemAction(hostid, 'disable'));
  document.getElementById('item-mass-clear').addEventListener('click', () => massItemAction(hostid, 'clear'));
  document.getElementById('item-mass-delete').addEventListener('click', () => massItemAction(hostid, 'delete'));
  await loadItems(hostid);
}

function updateItemMassBar(hostid) {
  const checked = document.querySelectorAll('#items-list .row-cb:checked').length;
  const bar = document.getElementById('item-mass-bar');
  if (bar) bar.hidden = checked === 0;
}

async function massItemAction(hostid, action) {
  const ids = [...document.querySelectorAll('#items-list .row-cb:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  try {
    if (action === 'delete') {
      if (!confirm(`Delete ${ids.length} item(s)?`)) return;
      await call('item.delete', { itemids: ids });
    } else if (action === 'clear') {
      if (!confirm(`Clear history and trends for ${ids.length} item(s)?`)) return;
      await call('history.clear', { itemids: ids });
      return; // no need to reload items list
    } else {
      for (const id of ids) await call('item.update', { itemid: id, status: action === 'enable' ? 0 : 1 });
    }
    await loadItems(hostid);
  } catch(e) { alert(e.message); }
}

async function loadItems(hostid) {
  const el = document.getElementById('items-list');
  if (!el) return;
  const items = await call('item.get', {
    hostids: [hostid], output: 'extend', sortfield: 'name', limit: 2000,
    selectPreprocessing: ['type'],
    selectTags: ['tag', 'value'],
    selectDiscoveryRule: ['itemid', 'name'],
    selectLastValues: true,
  });
  if (!items.length) { el.innerHTML = '<p class="empty">No items.</p>'; return; }

  // Resolve template names for inherited items (templatehostid = host ID of the template)
  const tplIds = [...new Set(items.filter(i => i.templatehostid && i.templatehostid !== '0').map(i => i.templatehostid))];
  const tplNames = {};
  if (tplIds.length) {
    const tpls = await call('host.get', { hostids: tplIds, output: ['hostid','name','host'] }).catch(() => []);
    for (const t of tpls) tplNames[t.hostid] = t.name || t.host;
  }

  const rows = items.map(item => {
    const vt = parseInt(item.value_type);
    const lv = item.lastvalue ?? '';
    const lc = item.lastclock && item.lastclock!=='0'
      ? new Date(parseInt(item.lastclock)*1000).toLocaleTimeString() : '—';
    const val = (vt===0||vt===3) && lv!=='' ? fmtNum(parseFloat(lv), item.units) : esc(String(lv));
    const fromTpl = item.templatehostid && item.templatehostid !== '0';
    const isLLD   = parseInt(item.flags) === 4;
    const ppCount = (item.preprocessing || []).length;
    const tplName = fromTpl ? (tplNames[item.templatehostid] || 'T') : '';
    const dr      = item.discoveryRule;
    const badge   = isLLD
      ? (dr
          ? `<a href="#/hosts/${esc(hostid)}/discovery/${esc(dr.itemid)}/items" class="badge-lld" title="Discovery rule: ${esc(dr.name)}">LLD: ${esc(dr.name)}</a>`
          : `<a href="#/hosts/${esc(hostid)}/discovery" class="badge-lld" title="Created by LLD rule">LLD</a>`)
      : fromTpl
      ? `<a href="#/hosts/${esc(item.templatehostid)}/items" class="badge-tpl" title="Inherited from: ${esc(tplName)}">${esc(tplName)}</a>`
      : '';
    const ppBadge = ppCount ? `<span class="badge-pp" title="${ppCount} preprocessing step(s)">PP${ppCount}</span>` : '';
    const typeStr   = parseInt(item.type);
    const statusStr = parseInt(item.status);
    const stateVal  = parseInt(item.state);
    const errTip    = item.error ? ` title="${esc(item.error)}"` : '';
    const infoCell  = stateVal === 1
      ? `<span class="status-dis" style="font-size:0.75rem;cursor:default"${errTip}>! unsupported</span>`
      : '';
    const tagsHtml  = (item.tags || []).map(t =>
      `<span class="tag">${esc(t.tag)}${t.value ? ': ' + esc(t.value) : ''}</span>`
    ).join('');
    return `
      <tr data-name="${esc((item.name_resolved||item.name).toLowerCase())}"
          data-itemid="${esc(item.itemid)}"
          data-type="${typeStr}"
          data-vtype="${vt}"
          data-state="${stateVal}"
          data-status="${statusStr}">
        <td class="cb-cell" onclick="event.stopPropagation()"><input type="checkbox" class="row-cb" data-id="${esc(item.itemid)}"></td>
        <td>${badge}${esc(item.name_resolved||item.name)}${ppBadge}</td>
        <td><code>${esc(item.key_)}</code></td>
        <td>${ITEM_TYPE[typeStr]||item.type}</td>
        <td>${VALUE_TYPE[vt]||vt}${item.units?' / '+esc(item.units):''}</td>
        <td>${esc(item.delay||'—')}</td>
        <td>${esc(item.history||'—')}</td>
        <td class="muted" style="font-size:0.82rem">${esc(item.trends||'—')}</td>
        <td>${val}</td>
        <td>${lc}</td>
        <td class="tags-cell">${tagsHtml}</td>
        <td>${infoCell}</td>
        <td class="row-actions">
          ${(vt===0||vt===3)?`<a href="#/item?itemid=${esc(item.itemid)}" class="btn-small" onclick="event.stopPropagation()">Graph</a>`:''}
          <a href="#/hosts/${esc(hostid)}/items/${esc(item.itemid)}" class="btn-small" onclick="event.stopPropagation()">Edit</a>
          ${!fromTpl && !isLLD ? `<button class="btn-small btn-danger" onclick="event.stopPropagation();deleteItem('${esc(item.itemid)}','${esc(item.name)}')">Del</button>` : ''}
          <button class="btn-small" onclick="event.stopPropagation();toggleItem('${esc(item.itemid)}',${item.status})">${statusStr===0?'Disable':'Enable'}</button>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th class="cb-cell"><input type="checkbox" id="items-cb-all"></th>
        <th>Name</th><th>Key</th><th>Type</th><th>Value type</th><th>Interval</th><th>History</th><th>Trends</th><th>Last value</th><th>Last check</th><th>Tags</th><th>Info</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  // select-all + mass actions
  document.getElementById('items-cb-all')?.addEventListener('change', e => {
    el.querySelectorAll('.row-cb').forEach(cb => { cb.checked = e.target.checked; });
    updateItemMassBar(hostid);
  });
  el.querySelectorAll('.row-cb').forEach(cb => cb.addEventListener('change', () => updateItemMassBar(hostid)));

  // row click → item detail page
  el.querySelectorAll('tr[data-itemid]').forEach(tr => {
    tr.classList.add('clickable');
    tr.addEventListener('click', e => {
      if (e.target.closest('.cb-cell, .row-actions')) return;
      navigate(`/hosts/${hostid}/items/${tr.dataset.itemid}`);
    });
  });
}

function showItemForm(hostid, item = null) {
  const el = document.getElementById('item-create-form');
  if (!el) return;
  _showItemForm(el, hostid, item, {
    title:      item ? 'Edit item' : 'New item',
    createFn:   p => call('item.create', p),
    updateFn:   p => call('item.update', p),
    onSuccess:  () => loadItems(hostid),
  });
}

// expose to inline onclick
window.deleteItem = async (itemid, name) => {
  if (!confirm(`Delete item "${name}"?`)) return;
  try {
    await call('item.delete', { itemids:[itemid] });
    await loadItems(document.querySelector('[data-itemid]')?.closest('[data-hostid]')
      ?.dataset.hostid || itemid);
  } catch(e) { alert(e.message); }
};
window.toggleItem = async (itemid, status) => {
  try {
    await call('item.update', { itemid, status: status===0||status==='0' ? 1 : 0 });
    // reload current tab
    location.reload();
  } catch(e) { alert(e.message); }
};

// ─── Triggers tab ────────────────────────────────────────────────────────────

async function renderTriggers(hostid) {
  const el = tc();
  el.innerHTML = `
    <div class="tab-toolbar">
      <input id="trig-search" type="search" placeholder="Filter by name…" style="width:180px">
      <select id="trig-f-sev" title="Severity">
        <option value="">Any severity</option>
        ${SEV_LABEL.map((l,i)=>`<option value="${i}">${l}</option>`).join('')}
      </select>
      <select id="trig-f-status" title="Status">
        <option value="">Any status</option>
        <option value="0">Enabled</option>
        <option value="1">Disabled</option>
      </select>
      <select id="trig-f-state" title="State">
        <option value="">Any state</option>
        <option value="0">OK</option>
        <option value="1">Problem</option>
      </select>
      <button id="trig-create-btn">+ New trigger</button>
      <span id="trig-mass-bar" hidden style="display:flex;gap:4px;margin-left:8px">
        <button id="trig-mass-enable" class="btn-small">Enable</button>
        <button id="trig-mass-disable" class="btn-small">Disable</button>
        <button id="trig-mass-delete" class="btn-small btn-danger">Delete</button>
      </span>
    </div>
    <div id="trig-create-form" hidden></div>
    <div id="triggers-list"><p class="loading">Loading…</p></div>
  `;
  document.getElementById('trig-search').addEventListener('input', filterTrigRows);
  document.getElementById('trig-f-sev').addEventListener('change', filterTrigRows);
  document.getElementById('trig-f-status').addEventListener('change', filterTrigRows);
  document.getElementById('trig-f-state').addEventListener('change', filterTrigRows);
  document.getElementById('trig-create-btn').addEventListener('click', () => {
    const formEl = document.getElementById('trig-create-form');
    showTriggerForm(formEl, hostid, null, {
      onSuccess: () => { formEl.hidden = true; formEl.innerHTML = ''; loadTriggers(hostid); },
      onCancel:  () => { formEl.hidden = true; formEl.innerHTML = ''; },
    });
  });
  document.getElementById('trig-mass-enable').addEventListener('click', () => massTrigAction(hostid, 'enable'));
  document.getElementById('trig-mass-disable').addEventListener('click', () => massTrigAction(hostid, 'disable'));
  document.getElementById('trig-mass-delete').addEventListener('click', () => massTrigAction(hostid, 'delete'));
  await loadTriggers(hostid);
}

function updateTrigMassBar(hostid) {
  const checked = document.querySelectorAll('#triggers-list .trig-cb:checked').length;
  const bar = document.getElementById('trig-mass-bar');
  if (bar) bar.hidden = checked === 0;
}

async function massTrigAction(hostid, action) {
  const ids = [...document.querySelectorAll('#triggers-list .trig-cb:checked')].map(cb => cb.dataset.id);
  if (!ids.length) return;
  try {
    if (action === 'delete') {
      if (!confirm(`Delete ${ids.length} trigger(s)?`)) return;
      await call('trigger.delete', { triggerids: ids });
    } else {
      for (const id of ids) await call('trigger.update', { triggerid: id, status: action === 'enable' ? 0 : 1 });
    }
    await loadTriggers(hostid);
  } catch(e) { alert(e.message); }
}

async function loadTriggers(hostid) {
  const el = document.getElementById('triggers-list');
  if (!el) return;
  const triggers = await call('trigger.get', {
    hostids: [hostid], output: 'extend', limit: 1000,
    selectTags: ['tag', 'value'],
    expandExpression: true,
  });
  if (!triggers.length) { el.innerHTML = '<p class="empty">No triggers.</p>'; return; }

  // Resolve template names for inherited triggers using templatehostid (not templateid!)
  const trigTplHostIds = [...new Set(triggers.filter(t => t.templatehostid && t.templatehostid !== '0').map(t => t.templatehostid))];
  const trigTplNames = {};
  if (trigTplHostIds.length) {
    const tpls = await call('host.get', { hostids: trigTplHostIds, output: ['hostid','name','host'] }).catch(() => []);
    for (const t of tpls) trigTplNames[t.hostid] = t.name || t.host;
  }

  const rows = triggers.map(t => {
    const sev = parseInt(t.priority);
    const fromTpl = t.templatehostid && t.templatehostid !== '0';
    const tplName = fromTpl ? (trigTplNames[t.templatehostid] || 'T') : '';
    const tBadge  = fromTpl
      ? `<a href="#/hosts/${esc(t.templatehostid)}/triggers" class="badge-tpl" title="Inherited from: ${esc(tplName)}">${esc(tplName)}</a>`
      : '';
    const ok = parseInt(t.value)===0;
    // Truncate expression for display
    const exprTrunc = t.expression && t.expression.length > 60
      ? esc(t.expression.slice(0, 60)) + '…'
      : esc(t.expression || '');
    const tagsHtml = (t.tags || []).map(tag =>
      `<span class="tag">${esc(tag.tag)}${tag.value ? ': ' + esc(tag.value) : ''}</span>`
    ).join('');
    return `
      <tr data-name="${esc(t.description.toLowerCase())}"
          data-severity="${parseInt(t.priority)}"
          data-status="${parseInt(t.status)}"
          data-value="${parseInt(t.value)}">
        <td class="cb-cell" onclick="event.stopPropagation()"><input type="checkbox" class="trig-cb" data-id="${esc(t.triggerid)}"></td>
        <td class="${SEV_CLASS[sev]||''} sev-cell">${SEV_LABEL[sev]||sev}</td>
        <td>${tBadge}${esc(t.description)}</td>
        <td class="muted" style="font-size:0.8rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${esc(t.expression||'')}">${exprTrunc}</td>
        <td class="${ok?'status-ok':'sev-dis'}">${ok?'OK':'PROBLEM'}</td>
        <td class="${parseInt(t.status)===0?'status-ok':'muted'}">${parseInt(t.status)===0?'Enabled':'Disabled'}</td>
        <td class="tags-cell">${tagsHtml}</td>
        <td class="row-actions">
          <a href="#/hosts/${esc(hostid)}/triggers/${esc(t.triggerid)}" class="btn-small" onclick="event.stopPropagation()">Edit</a>
          ${!fromTpl ? `<button class="btn-small btn-danger" onclick="event.stopPropagation();deleteTrigger('${esc(t.triggerid)}','${esc(t.description)}')">Del</button>` : ''}
          <button class="btn-small" onclick="event.stopPropagation();toggleTrigger('${esc(t.triggerid)}',${t.status})">${parseInt(t.status)===0?'Disable':'Enable'}</button>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th class="cb-cell"><input type="checkbox" id="trigs-cb-all"></th>
        <th>Severity</th><th>Description</th><th>Expression</th><th>Value</th><th>Status</th><th>Tags</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  document.getElementById('trigs-cb-all')?.addEventListener('change', e => {
    el.querySelectorAll('.trig-cb').forEach(cb => { cb.checked = e.target.checked; });
    updateTrigMassBar(hostid);
  });
  el.querySelectorAll('.trig-cb').forEach(cb => cb.addEventListener('change', () => updateTrigMassBar(hostid)));

  // row click → trigger detail page
  el.querySelectorAll('tr[data-name]').forEach(tr => {
    tr.classList.add('clickable');
    tr.addEventListener('click', e => {
      if (e.target.closest('.cb-cell, .row-actions')) return;
      const trigid = tr.querySelector('.trig-cb')?.dataset.id;
      if (trigid) navigate(`/hosts/${hostid}/triggers/${trigid}`);
    });
  });
}

function showTriggerForm(containerEl, hostid, trigger = null, opts = {}) {
  const el = containerEl;
  if (!el) return;
  el.hidden = false;
  const isEdit = !!(trigger?.triggerid);
  el.innerHTML = `
    <div class="inline-form">
      <h3>${isEdit ? 'Edit trigger' : 'New trigger'}</h3>
      ${trigger?.templatehostid && trigger.templatehostid !== '0'
        ? `<div class="form-note">Inherited from template. <a href="#/hosts/${esc(trigger.templatehostid)}/triggers/${esc(trigger.templateid)}">Edit in template →</a></div>`
        : ''}
      <div class="form-grid">
        <label class="form-wide">Description *<input id="tf-desc" value="${esc(trigger?.description||'')}"></label>
        <label class="form-wide">Expression *
          <textarea id="tf-expr" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder="last(/hostname/key[]) > threshold">${esc(trigger?.expression||'')}</textarea>
        </label>
        <label>Severity
          <select id="tf-prio">
            ${SEV_LABEL.map((l,i)=>`<option value="${i}"${parseInt(trigger?.priority)===i?' selected':''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Recovery mode
          <select id="tf-rec">
            <option value="0"${parseInt(trigger?.recovery_mode)===0?' selected':''}>Expression</option>
            <option value="2"${parseInt(trigger?.recovery_mode)===2?' selected':''}>None</option>
            <option value="1"${parseInt(trigger?.recovery_mode)===1?' selected':''}>Recovery expression</option>
          </select>
        </label>
        <label>PROBLEM event generation
          <select id="tf-corr-mode">
            <option value="0"${parseInt(trigger?.correlation_mode)!==1?' selected':''}>Single</option>
            <option value="1"${parseInt(trigger?.correlation_mode)===1?' selected':''}>Multiple</option>
          </select>
        </label>
        <label><input type="checkbox" id="tf-manual-close"${parseInt(trigger?.manual_close)===1?' checked':''}> Manual close</label>
      </div>
      <div id="tf-rec-expr-wrap" style="${parseInt(trigger?.recovery_mode)===1?'':'display:none'}">
        <label class="form-wide">Recovery expression<textarea id="tf-rec-expr" rows="3" style="font-family:monospace;font-size:0.82rem">${esc(trigger?.recovery_expression||'')}</textarea></label>
      </div>
      <label class="form-wide">Event name (optional)<input id="tf-ename" value="${esc(trigger?.event_name||'')}"></label>
      <label class="form-wide">Operational data<input id="tf-opdata" value="${esc(trigger?.opdata||'')}"></label>
      <label class="form-wide">URL name<input id="tf-url-name" value="${esc(trigger?.url_name||'')}" placeholder="Link label (optional)"></label>
      <label class="form-wide">URL<input id="tf-url" value="${esc(trigger?.url||'')}" placeholder="https://…"></label>
      <h4 style="margin:0.75rem 0 0.4rem">Tags</h4>
      <div id="tf-tags-list"></div>
      <button type="button" id="tf-tag-add" class="btn-small" style="margin:4px 0 0.75rem">+ Add tag</button>
      <h4 style="margin:0.75rem 0 0.4rem">Dependencies</h4>
      <div id="tf-deps-list"></div>
      <button type="button" id="tf-dep-add" class="btn-small" style="margin:4px 0 0.75rem">+ Add dependency</button>
      <div class="form-actions">
        <button id="tf-submit">${isEdit ? 'Save' : 'Create'}</button>
        ${isEdit ? '<button id="tf-clone" type="button">Clone</button>' : ''}
        <button id="tf-cancel">Cancel</button>
        <span id="tf-error" class="error" hidden></span>
      </div>
    </div>`;

  document.getElementById('tf-rec').addEventListener('change', e => {
    document.getElementById('tf-rec-expr-wrap').style.display =
      e.target.value === '1' ? '' : 'none';
  });
  // Tags management
  let tfTags = (trigger?.tags || []).map(t => ({ tag: t.tag, value: t.value || '' }));
  function renderTfTags() {
    const tl = document.getElementById('tf-tags-list');
    if (!tl) return;
    if (!tfTags.length) { tl.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No tags.</p>'; return; }
    tl.innerHTML = tfTags.map((t, i) => `
      <div class="iface-row" style="margin-bottom:4px">
        <input class="tft-name" data-idx="${i}" value="${esc(t.tag)}" placeholder="tag" style="width:150px">
        <input class="tft-val" data-idx="${i}" value="${esc(t.value)}" placeholder="value" style="flex:1">
        <button type="button" class="btn-small btn-danger tft-rem" data-idx="${i}">×</button>
      </div>`).join('');
    tl.querySelectorAll('.tft-name').forEach(inp => inp.addEventListener('input', () => { tfTags[parseInt(inp.dataset.idx)].tag = inp.value; }));
    tl.querySelectorAll('.tft-val').forEach(inp => inp.addEventListener('input', () => { tfTags[parseInt(inp.dataset.idx)].value = inp.value; }));
    tl.querySelectorAll('.tft-rem').forEach(btn => btn.addEventListener('click', () => { tfTags.splice(parseInt(btn.dataset.idx), 1); renderTfTags(); }));
  }
  renderTfTags();
  document.getElementById('tf-tag-add').addEventListener('click', () => { tfTags.push({ tag: '', value: '' }); renderTfTags(); });

  // Dependencies management
  let tfDeps = (trigger?.dependencies || []).map(d => ({ triggerid: String(d.triggerid), description: d.description || String(d.triggerid) }));
  function renderTfDeps() {
    const dl = document.getElementById('tf-deps-list');
    if (!dl) return;
    if (!tfDeps.length) { dl.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No dependencies.</p>'; return; }
    dl.innerHTML = tfDeps.map((d, i) => `
      <div class="iface-row" style="margin-bottom:4px">
        <span style="flex:1;font-size:0.875rem">${esc(d.description)}</span>
        <button type="button" class="btn-small btn-danger tfd-rem" data-idx="${i}">×</button>
      </div>`).join('');
    dl.querySelectorAll('.tfd-rem').forEach(btn =>
      btn.addEventListener('click', () => { tfDeps.splice(parseInt(btn.dataset.idx), 1); renderTfDeps(); }));
  }
  renderTfDeps();
  document.getElementById('tf-dep-add').addEventListener('click', async () => {
    const allTriggers = await call('trigger.get', {
      hostids: [hostid], output: ['triggerid', 'description'], limit: 500,
    }).catch(() => []);
    const currentId = trigger?.triggerid ? String(trigger.triggerid) : null;
    const already   = new Set(tfDeps.map(d => d.triggerid));
    const available = allTriggers.filter(t => String(t.triggerid) !== currentId && !already.has(String(t.triggerid)));
    if (!available.length) { alert('No other triggers available.'); return; }
    const dl = document.getElementById('tf-deps-list');
    const pickerEl = document.createElement('div');
    pickerEl.style.cssText = 'margin-bottom:4px;display:flex;gap:4px;';
    pickerEl.innerHTML = `
      <select id="tf-dep-picker" style="flex:1">
        ${available.map(t => `<option value="${esc(t.triggerid)}">${esc(t.description)}</option>`).join('')}
      </select>
      <button type="button" class="btn-small" id="tf-dep-pick-ok">Add</button>
      <button type="button" class="btn-small" id="tf-dep-pick-cancel">✕</button>`;
    dl.appendChild(pickerEl);
    pickerEl.querySelector('#tf-dep-pick-cancel').addEventListener('click', () => pickerEl.remove());
    pickerEl.querySelector('#tf-dep-pick-ok').addEventListener('click', () => {
      const sel = pickerEl.querySelector('#tf-dep-picker');
      tfDeps.push({ triggerid: sel.value, description: sel.options[sel.selectedIndex].text });
      pickerEl.remove();
      renderTfDeps();
    });
  });

  document.getElementById('tf-clone')?.addEventListener('click', () => {
    const cloned = {
      ...trigger,
      triggerid: null, templatehostid: '0', templateid: '0', templateRuleid: '0',
      description:         document.getElementById('tf-desc').value.trim(),
      expression:          document.getElementById('tf-expr').value.trim(),
      priority:            parseInt(document.getElementById('tf-prio').value),
      recovery_mode:       parseInt(document.getElementById('tf-rec').value),
      recovery_expression: document.getElementById('tf-rec-expr').value.trim(),
      event_name:          document.getElementById('tf-ename').value.trim(),
      opdata:              document.getElementById('tf-opdata').value.trim(),
      url_name:            document.getElementById('tf-url-name').value.trim(),
      url:                 document.getElementById('tf-url').value.trim(),
      manual_close:        document.getElementById('tf-manual-close').checked ? 1 : 0,
      tags:                tfTags.map(t => ({...t})),
      dependencies:        [...tfDeps],
    };
    showTriggerForm(el, hostid, cloned, opts);
  });
  document.getElementById('tf-cancel').onclick = () => {
    if (opts.onCancel) { opts.onCancel(); return; }
    el.hidden = true; el.innerHTML = '';
  };
  document.getElementById('tf-submit').onclick = async () => {
    const errEl = document.getElementById('tf-error');
    errEl.hidden = true;
    const p = {
      description:         document.getElementById('tf-desc').value.trim(),
      expression:          document.getElementById('tf-expr').value.trim(),
      priority:            parseInt(document.getElementById('tf-prio').value),
      recovery_mode:       parseInt(document.getElementById('tf-rec').value),
      recovery_expression: document.getElementById('tf-rec-expr').value.trim(),
      event_name:          document.getElementById('tf-ename').value.trim(),
      opdata:              document.getElementById('tf-opdata').value.trim(),
      correlation_mode:    parseInt(document.getElementById('tf-corr-mode').value),
      manual_close:        document.getElementById('tf-manual-close').checked ? 1 : 0,
      url_name:            document.getElementById('tf-url-name').value.trim(),
      url:                 document.getElementById('tf-url').value.trim(),
      tags:                tfTags.filter(t => t.tag.trim()),
      dependencies:        tfDeps.map(d => ({ triggerid: d.triggerid })),
    };
    try {
      if (trigger?.triggerid) { p.triggerid = trigger.triggerid; await call('trigger.update', p); }
      else await call('trigger.create', p);
      if (opts.onSuccess) { opts.onSuccess(); return; }
      el.hidden = true; el.innerHTML = '';
      await loadTriggers(hostid);
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  };
}

window.deleteTrigger = async (triggerid, name) => {
  if (!confirm(`Delete trigger "${name}"?`)) return;
  try { await call('trigger.delete', { triggerids:[triggerid] }); location.reload(); }
  catch(e) { alert(e.message); }
};
window.toggleTrigger = async (triggerid, status) => {
  try {
    await call('trigger.update', { triggerid, status: parseInt(status)===0 ? 1 : 0 });
    location.reload();
  } catch(e) { alert(e.message); }
};

// ─── Discovery tab ───────────────────────────────────────────────────────────

async function renderDiscovery(hostid) {
  const el = tc();
  el.innerHTML = '<p class="loading">Loading…</p>';

  const rules = await call('discoveryrule.get', { hostids:[hostid], output:'extend' });
  if (!rules.length) { el.innerHTML = '<p class="empty">No discovery rules.</p>'; return; }

  const rows = rules.map(r => {
    return `
      <tr class="clickable" data-href="#/hosts/${esc(hostid)}/discovery/${esc(r.itemid)}/rule">
        <td>${esc(r.name_resolved||r.name)}</td>
        <td><code>${esc(r.key_)}</code></td>
        <td>${ITEM_TYPE[parseInt(r.type)]||r.type}</td>
        <td>${esc(r.delay)}</td>
        <td class="${parseInt(r.status)===0?'status-ok':'muted'}">${parseInt(r.status)===0?'Enabled':'Disabled'}</td>
        <td class="${parseInt(r.state)===0?'':'sev-dis'}">${STATE_LABEL[parseInt(r.state)]||r.state}</td>
        <td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${esc(r.error)}">${esc(r.error||'')}</td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Key</th><th>Type</th><th>Interval</th><th>Status</th><th>State</th><th>Error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.querySelectorAll('tr[data-href]').forEach(tr => {
    tr.addEventListener('click', () => navigate(tr.dataset.href.replace(/^#/, '')));
  });
}

// ─── Edit host tab ───────────────────────────────────────────────────────────

const IFACE_TYPE = { 1: 'Agent', 2: 'SNMP', 3: 'IPMI', 4: 'JMX' };

async function renderEdit(host) {
  const el = tc();

  const [allGroups, allTemplates] = await Promise.all([
    call('hostgroup.get', { output: ['groupid', 'name'] }),
    call('template.get',  { output: ['templateid', 'host', 'name'], limit: 1000 }).catch(() => []),
  ]);
  const curGids = (host.groups || []).map(g => String(g.groupid));

  let ifaceList  = (host.interfaces || []).map(i => ({ ...i }));
  let tplList    = (host.parentTemplates || []).map(t => ({ ...t }));
  let hostTags   = (host.tags || []).map(t => ({ tag: t.tag, value: t.value || '' }));
  const toClear  = new Set(); // templateids to "unlink and clear"

  const isEnabled = parseInt(host.status) === 0;

  // ── shell with inner tabs ──
  el.innerHTML = `
    <div class="tab-bar" style="margin-bottom:0;border-bottom:1px solid var(--border)">
      <a href="#" class="tab-btn tab-active" id="edt-tab-host">Host</a>
      <a href="#" class="tab-btn" id="edt-tab-tags">Tags</a>
    </div>
    <div class="inline-form" style="max-width:660px;margin-top:16px">

      <!-- HOST PANEL -->
      <div id="edt-panel-host">
        <table class="host-form-table">
          <tr>
            <th>Host name *</th>
            <td><input id="eh-host" value="${esc(host.host)}" style="width:320px"></td>
          </tr>
          <tr>
            <th>Visible name</th>
            <td><input id="eh-name" value="${esc(host.name || '')}" style="width:320px"></td>
          </tr>
          <tr>
            <th>Templates</th>
            <td>
              <div id="eh-tpl-list" style="margin-bottom:6px"></div>
              <div style="position:relative;display:inline-block">
                <input id="eh-tpl-search" type="search" placeholder="type to search…" style="width:260px">
                <div id="eh-tpl-dropdown" class="tpl-dropdown" hidden></div>
              </div>
            </td>
          </tr>
          <tr>
            <th>Host groups *</th>
            <td><div id="eh-groups-picker"></div></td>
          </tr>
          <tr>
            <th>Interfaces</th>
            <td>
              <div id="eh-iface-list"></div>
              <button type="button" id="eh-iface-add" class="btn-small" style="margin-top:6px">+ Add</button>
              <div id="eh-iface-form" hidden></div>
            </td>
          </tr>
          <tr>
            <th>Description</th>
            <td><textarea id="eh-desc" rows="4" style="width:320px">${esc(host.description || '')}</textarea></td>
          </tr>
          <tr>
            <th>Enabled</th>
            <td><input type="checkbox" id="eh-enabled"${isEnabled ? ' checked' : ''}></td>
          </tr>
        </table>
      </div>

      <!-- TAGS PANEL -->
      <div id="edt-panel-tags" hidden>
        <div id="eh-tags-list"></div>
        <button type="button" id="eh-tag-add" class="btn-small" style="margin:6px 0">+ Add tag</button>
      </div>

      <div class="form-actions" style="margin-top:16px">
        <button id="eh-submit">Update</button>
        <button id="eh-cancel" onclick="history.back()">Cancel</button>
        <span id="eh-error" class="error" hidden></span>
      </div>
    </div>`;

  // ── inner tab switching ──
  document.getElementById('edt-tab-host').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('edt-panel-host').hidden = false;
    document.getElementById('edt-panel-tags').hidden = true;
    document.getElementById('edt-tab-host').classList.add('tab-active');
    document.getElementById('edt-tab-tags').classList.remove('tab-active');
  });
  document.getElementById('edt-tab-tags').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('edt-panel-host').hidden = true;
    document.getElementById('edt-panel-tags').hidden = false;
    document.getElementById('edt-tab-host').classList.remove('tab-active');
    document.getElementById('edt-tab-tags').classList.add('tab-active');
  });

  // ── templates ──
  function refreshTplList() {
    const tl = document.getElementById('eh-tpl-list');
    if (!tl) return;
    if (!tplList.length) { tl.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0">No linked templates.</p>'; return; }
    tl.innerHTML = tplList.map((t, idx) => `
      <div class="iface-row" style="margin-bottom:4px">
        <span>${esc(t.name || t.host)}</span>
        <button type="button" class="btn-small tpl-unlink" data-idx="${idx}" data-tid="${esc(t.templateid)}">Unlink</button>
        <button type="button" class="btn-small btn-danger tpl-unlink-clear" data-idx="${idx}" data-tid="${esc(t.templateid)}">Unlink and clear</button>
      </div>`).join('');
    tl.querySelectorAll('.tpl-unlink').forEach(btn =>
      btn.addEventListener('click', () => {
        toClear.delete(btn.dataset.tid);
        tplList.splice(parseInt(btn.dataset.idx), 1);
        refreshTplList();
      })
    );
    tl.querySelectorAll('.tpl-unlink-clear').forEach(btn =>
      btn.addEventListener('click', () => {
        toClear.add(btn.dataset.tid);
        tplList.splice(parseInt(btn.dataset.idx), 1);
        refreshTplList();
      })
    );
  }
  refreshTplList();

  const tplSearch = document.getElementById('eh-tpl-search');
  const tplDrop   = document.getElementById('eh-tpl-dropdown');
  tplSearch.addEventListener('input', () => {
    const q = tplSearch.value.toLowerCase();
    if (!q) { tplDrop.hidden = true; return; }
    const matches = allTemplates
      .filter(t => (t.name || t.host).toLowerCase().includes(q) && !tplList.find(x => x.templateid === t.templateid))
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
    tplList.push({ templateid: item.dataset.id, host: item.dataset.host, name: item.dataset.name });
    tplSearch.value = ''; tplDrop.hidden = true;
    refreshTplList();
  });
  document.addEventListener('click', e => {
    if (!tplSearch.contains(e.target) && !tplDrop.contains(e.target)) tplDrop.hidden = true;
  }, { capture: true });

  // ── groups picker ──
  const picker = groupPicker(document.getElementById('eh-groups-picker'), allGroups, curGids);

  // ── interfaces ──
  function renderIfacesHtml() {
    if (!ifaceList.length) return '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No interfaces.</p>';
    return `<table class="data-table" style="margin-bottom:4px"><thead><tr>
      <th>Type</th><th>IP address</th><th>DNS name</th><th>Connect to</th><th>Port</th><th>Default</th><th></th>
    </tr></thead><tbody>` + ifaceList.map((i, idx) => {
      const typeLabel = IFACE_TYPE[parseInt(i.type)] || i.type;
      const connTo    = parseInt(i.useip) === 1 ? 'IP' : 'DNS';
      const def       = i.main === '1' || i.main === 1;
      return `<tr>
        <td class="muted">${typeLabel}</td>
        <td>${esc(i.ip || '')}</td>
        <td>${esc(i.dns || '')}</td>
        <td>${connTo}</td>
        <td>${esc(i.port || '')}</td>
        <td>${def ? '★' : ''}</td>
        <td class="row-actions">
          <button class="btn-small iface-edit" data-idx="${idx}">Edit</button>
          <button class="btn-small btn-danger iface-remove" data-idx="${idx}">Remove</button>
        </td>
      </tr>`;
    }).join('') + '</tbody></table>';
  }

  function refreshIfaceList() {
    document.getElementById('eh-iface-list').innerHTML = renderIfacesHtml();
    document.querySelectorAll('.iface-remove').forEach(btn =>
      btn.addEventListener('click', async () => {
        const idx   = parseInt(btn.dataset.idx);
        const iface = ifaceList[idx];
        if (iface.interfaceid) {
          try {
            const cnt = await call('item.get', {
              hostids: [host.hostid],
              filter: { interfaceid: [iface.interfaceid] },
              countOutput: true,
            });
            if (parseInt(cnt) > 0 &&
                !confirm(`${cnt} item(s) use this interface. Remove anyway?`)) return;
          } catch(_) { /* non-blocking — proceed */ }
        }
        ifaceList.splice(idx, 1);
        refreshIfaceList();
      })
    );
    document.querySelectorAll('.iface-edit').forEach(btn =>
      btn.addEventListener('click', () => showIfaceForm(parseInt(btn.dataset.idx)))
    );
  }
  refreshIfaceList();

  function showIfaceForm(editIdx = -1) {
    const iface = editIdx >= 0 ? ifaceList[editIdx] : { type:1, useip:1, ip:'', dns:'', port:'10050', main: ifaceList.length===0?1:0 };
    const form  = document.getElementById('eh-iface-form');
    form.hidden = false;
    form.innerHTML = `
      <div style="padding:10px;border:1px solid var(--border);margin-top:8px;max-width:420px">
        <table class="host-form-table" style="margin-bottom:8px">
          <tr><th>Type</th><td>
            <select id="if-type">
              ${Object.entries(IFACE_TYPE).map(([v,l])=>`<option value="${v}"${parseInt(iface.type)===parseInt(v)?' selected':''}>${l}</option>`).join('')}
            </select>
          </td></tr>
          <tr><th>IP address</th><td><input id="if-ip" value="${esc(iface.ip||'')}"></td></tr>
          <tr><th>DNS name</th><td><input id="if-dns" value="${esc(iface.dns||'')}"></td></tr>
          <tr><th>Connect to</th><td>
            <label><input type="radio" name="if-useip" value="1"${parseInt(iface.useip)===1?' checked':''}> IP</label>
            <label style="margin-left:10px"><input type="radio" name="if-useip" value="0"${parseInt(iface.useip)===0?' checked':''}> DNS</label>
          </td></tr>
          <tr><th>Port *</th><td><input id="if-port" value="${esc(iface.port||'10050')}" style="width:100px"></td></tr>
          <tr><th>Default</th><td><input type="checkbox" id="if-main"${(iface.main==='1'||iface.main===1||ifaceList.length===0)?' checked':''}></td></tr>
        </table>
        <div class="form-actions">
          <button type="button" id="if-ok">OK</button>
          <button type="button" id="if-cancel">Cancel</button>
        </div>
      </div>`;
    document.getElementById('if-cancel').onclick = () => { form.hidden = true; form.innerHTML = ''; };
    document.getElementById('if-ok').onclick = () => {
      const entry = {
        type:  parseInt(document.getElementById('if-type').value),
        useip: parseInt(document.querySelector('input[name="if-useip"]:checked')?.value ?? 1),
        ip:    document.getElementById('if-ip').value.trim(),
        dns:   document.getElementById('if-dns').value.trim(),
        port:  document.getElementById('if-port').value.trim(),
        main:  document.getElementById('if-main').checked ? 1 : 0,
      };
      if (entry.main) ifaceList.forEach(i => { i.main = 0; });
      if (editIdx >= 0) ifaceList[editIdx] = entry;
      else              ifaceList.push(entry);
      form.hidden = true; form.innerHTML = '';
      refreshIfaceList();
    };
  }
  document.getElementById('eh-iface-add').addEventListener('click', () => showIfaceForm());

  // ── tags (Tags panel) ──
  function refreshTagsList() {
    const tl = document.getElementById('eh-tags-list');
    if (!tl) return;
    if (!hostTags.length) {
      tl.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No tags.</p>';
      return;
    }
    tl.innerHTML = `<table class="data-table" style="width:auto"><thead><tr><th>Name</th><th>Value</th><th></th></tr></thead><tbody>` +
      hostTags.map((t, i) => `
        <tr>
          <td><input class="eht-tag" data-idx="${i}" value="${esc(t.tag)}" placeholder="tag" style="width:180px"></td>
          <td><input class="eht-val" data-idx="${i}" value="${esc(t.value)}" placeholder="value" style="width:220px"></td>
          <td><button type="button" class="btn-small btn-danger eht-rem" data-idx="${i}">Remove</button></td>
        </tr>`).join('') + '</tbody></table>';
    tl.querySelectorAll('.eht-tag').forEach(inp => inp.addEventListener('input', () => { hostTags[parseInt(inp.dataset.idx)].tag = inp.value; }));
    tl.querySelectorAll('.eht-val').forEach(inp => inp.addEventListener('input', () => { hostTags[parseInt(inp.dataset.idx)].value = inp.value; }));
    tl.querySelectorAll('.eht-rem').forEach(btn => btn.addEventListener('click', () => { hostTags.splice(parseInt(btn.dataset.idx), 1); refreshTagsList(); }));
  }
  refreshTagsList();
  document.getElementById('eh-tag-add').addEventListener('click', () => { hostTags.push({ tag: '', value: '' }); refreshTagsList(); });

  // ── save ──
  document.getElementById('eh-submit').onclick = async () => {
    const errEl = document.getElementById('eh-error');
    errEl.hidden = true;
    try {
      const updateParams = {
        hostid:      host.hostid,
        host:        document.getElementById('eh-host').value.trim(),
        name:        document.getElementById('eh-name').value.trim(),
        status:      document.getElementById('eh-enabled').checked ? 0 : 1,
        description: document.getElementById('eh-desc').value.trim(),
        groups:      picker.getValue(),
        templates:   tplList.map(t => ({ templateid: t.templateid })),
        interfaces:  ifaceList,
        tags:        hostTags.filter(t => t.tag.trim()),
      };
      if (toClear.size) {
        updateParams.templates_clear = [...toClear].map(tid => ({ templateid: tid }));
      }
      await call('host.update', updateParams);
      navigate(`/hosts/${host.hostid}/items`);
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  };
}

// ─── Macros tab ──────────────────────────────────────────────────────────────

const MACRO_TYPE_LABEL = ['Text', 'Secret', 'Vault secret'];

async function renderMacros(hostid) {
  const el = tc();
  el.innerHTML = `
    <div class="tab-toolbar">
      <button id="mac-create-btn">+ New macro</button>
    </div>
    <div id="mac-create-form" hidden></div>
    <div id="mac-list"><p class="loading">Loading…</p></div>
  `;
  document.getElementById('mac-create-btn').addEventListener('click', () => showMacroForm(hostid));
  await loadMacros(hostid);
}

async function loadMacros(hostid) {
  const el = document.getElementById('mac-list');
  if (!el) return;
  const macros = await call('usermacro.get', { hostids: [hostid], output: 'extend' });
  if (!macros.length) { el.innerHTML = '<p class="empty">No macros defined.</p>'; return; }

  const rows = macros.map(m => {
    const isSecret = parseInt(m.type) === 1;
    return `
      <tr>
        <td><code>${esc(m.macro)}</code></td>
        <td>${isSecret ? '••••••••' : esc(m.value)}</td>
        <td>${MACRO_TYPE_LABEL[parseInt(m.type)] || m.type}</td>
        <td class="muted">${esc(m.description || '')}</td>
        <td class="row-actions">
          <button class="btn-small" data-mac-edit="${esc(m.hostmacroid)}">Edit</button>
          <button class="btn-small btn-danger" data-mac-del="${esc(m.hostmacroid)}" data-macro="${esc(m.macro)}">Del</button>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Macro</th><th>Value</th><th>Type</th><th>Description</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.querySelectorAll('button[data-mac-edit]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const m = macros.find(x => x.hostmacroid === btn.dataset.macEdit);
      if (m) showMacroForm(hostid, m);
    });
  });
  el.querySelectorAll('button[data-mac-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete macro "${btn.dataset.macro}"?`)) return;
      try {
        await call('usermacro.delete', { hostmacroids: [btn.dataset.macDel] });
        await loadMacros(hostid);
      } catch(e) { alert(e.message); }
    });
  });
}

function showMacroForm(hostid, macro = null) {
  const el = document.getElementById('mac-create-form');
  if (!el) return;
  el.hidden = false;
  const isEdit = !!macro;
  el.innerHTML = `
    <div class="inline-form" style="max-width:520px">
      <h3>${isEdit ? 'Edit macro' : 'New macro'}</h3>
      <div class="form-grid">
        <label>Macro * <small>({$NAME})</small>
          <input id="mf-macro" value="${esc(macro?.macro||'')}" placeholder="{$MACRO_NAME}">
        </label>
        <label>Type
          <select id="mf-type">
            ${MACRO_TYPE_LABEL.map((l,i)=>`<option value="${i}"${parseInt(macro?.type)===i?' selected':''}>${l}</option>`).join('')}
          </select>
        </label>
        <label class="form-wide">Value<input id="mf-value" value="${esc(parseInt(macro?.type)===1?'':macro?.value||'')}"></label>
        <label class="form-wide">Description<input id="mf-desc" value="${esc(macro?.description||'')}"></label>
      </div>
      <div class="form-actions">
        <button id="mf-submit">${isEdit ? 'Save' : 'Create'}</button>
        <button id="mf-cancel">Cancel</button>
        <span id="mf-error" class="error" hidden></span>
      </div>
    </div>`;

  document.getElementById('mf-cancel').onclick = () => { el.hidden = true; el.innerHTML = ''; };
  document.getElementById('mf-submit').onclick = async () => {
    const errEl = document.getElementById('mf-error');
    errEl.hidden = true;
    const p = {
      macro:       document.getElementById('mf-macro').value.trim().toUpperCase(),
      value:       document.getElementById('mf-value').value,
      type:        parseInt(document.getElementById('mf-type').value),
      description: document.getElementById('mf-desc').value.trim(),
    };
    try {
      if (isEdit) { p.hostmacroid = macro.hostmacroid; await call('usermacro.update', p); }
      else { p.hostid = hostid; await call('usermacro.create', p); }
      el.hidden = true; el.innerHTML = '';
      await loadMacros(hostid);
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function filterItemRows() {
  const q      = document.getElementById('item-search')?.value.toLowerCase() || '';
  const fType   = document.getElementById('item-f-type')?.value || '';
  const fVtype  = document.getElementById('item-f-vtype')?.value || '';
  const fState  = document.getElementById('item-f-state')?.value || '';
  const fStatus = document.getElementById('item-f-status')?.value || '';
  document.querySelectorAll('#items-list tr[data-name]').forEach(tr => {
    const visible =
      (!q      || tr.dataset.name.includes(q))            &&
      (!fType  || tr.dataset.type   === fType)             &&
      (!fVtype || tr.dataset.vtype  === fVtype)            &&
      (!fState || tr.dataset.state  === fState)            &&
      (!fStatus|| tr.dataset.status === fStatus);
    tr.style.display = visible ? '' : 'none';
  });
}

function filterTrigRows() {
  const q       = document.getElementById('trig-search')?.value.toLowerCase() || '';
  const fSev    = document.getElementById('trig-f-sev')?.value || '';
  const fStatus = document.getElementById('trig-f-status')?.value || '';
  const fState  = document.getElementById('trig-f-state')?.value || '';
  document.querySelectorAll('#triggers-list tr[data-name]').forEach(tr => {
    const visible =
      (!q       || tr.dataset.name.includes(q))         &&
      (!fSev    || tr.dataset.severity === fSev)         &&
      (!fStatus || tr.dataset.status   === fStatus)      &&
      (!fState  || tr.dataset.value    === fState);
    tr.style.display = visible ? '' : 'none';
  });
}

function fmtNum(v, units) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  let s, u = units || '';
  if      (abs >= 1e9) { s = (v/1e9).toFixed(2); u = 'G'+u; }
  else if (abs >= 1e6) { s = (v/1e6).toFixed(2); u = 'M'+u; }
  else if (abs >= 1e3) { s = (v/1e3).toFixed(2); u = 'K'+u; }
  else                 { s = v.toFixed(abs<1?4:2); }
  return esc(s + (u ? ' '+u : ''));
}

// ─── Item detail page ─────────────────────────────────────────────────────────

export async function renderItemDetail(root, hostid, itemid) {
  const el = content();
  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const [hosts, items] = await Promise.all([
      call('host.get', { hostids: [hostid], output: ['hostid', 'host', 'name'] }),
      call('item.get', {
        itemids: [itemid], output: 'extend',
        selectPreprocessing: ['type', 'params', 'error_handler', 'error_handler_params'],
        selectTags: ['tag', 'value'],
      }),
    ]);
    const host = hosts[0];
    const item = items[0];
    if (!host || !item) { el.innerHTML = '<p class="error">Not found.</p>'; return; }

    el.innerHTML = `
      <div class="page-header">
        <h2>
          <a href="#/hosts/${esc(hostid)}/items" class="breadcrumb">${esc(host.name || host.host)}</a>
          <span class="sep">›</span>
          <a href="#/hosts/${esc(hostid)}/items" class="breadcrumb">Items</a>
          <span class="sep">›</span>
          ${esc(item.name_resolved || item.name)}
        </h2>
      </div>
      <div id="item-detail-form"></div>
    `;

    const formEl = document.getElementById('item-detail-form');
    _showItemForm(formEl, hostid, item, {
      title:     'Edit item',
      createFn:  p => call('item.create', p),
      updateFn:  p => call('item.update', p),
      onSuccess: () => navigate(`/hosts/${hostid}/items`),
    });
    // override Cancel to navigate back
    const cancelBtn = formEl.querySelector('#if-cancel');
    if (cancelBtn) cancelBtn.onclick = () => navigate(`/hosts/${hostid}/items`);
  } catch(e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ─── Trigger detail page ──────────────────────────────────────────────────────

export async function renderTriggerDetail(root, hostid, triggerid) {
  const el = content();
  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const [hosts, triggers] = await Promise.all([
      call('host.get', { hostids: [hostid], output: ['hostid', 'host', 'name'] }),
      call('trigger.get', {
        triggerids: [triggerid], output: 'extend',
        selectTags: ['tag', 'value'],
        selectDependencies: ['triggerid', 'description'],
        expandExpression: true,
      }),
    ]);
    const host    = hosts[0];
    const trigger = triggers[0];
    if (!host || !trigger) { el.innerHTML = '<p class="error">Not found.</p>'; return; }

    el.innerHTML = `
      <div class="page-header">
        <h2>
          <a href="#/hosts/${esc(hostid)}/triggers" class="breadcrumb">${esc(host.name || host.host)}</a>
          <span class="sep">›</span>
          <a href="#/hosts/${esc(hostid)}/triggers" class="breadcrumb">Triggers</a>
          <span class="sep">›</span>
          ${esc(trigger.description)}
        </h2>
      </div>
      <div id="trigger-detail-form" hidden></div>
    `;

    const formEl = document.getElementById('trigger-detail-form');
    showTriggerForm(formEl, hostid, trigger, {
      onSuccess: () => navigate(`/hosts/${hostid}/triggers`),
      onCancel:  () => navigate(`/hosts/${hostid}/triggers`),
    });
  } catch(e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
