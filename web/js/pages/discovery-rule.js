/**
 * Discovery rule submenu — 4 tabs:
 *   Items | Triggers | Graphs | Filter
 * URL: #/hosts/:hostid/discovery/:ruleid/:tab
 */
import { call } from '../api.js';
import { content, esc, navigate } from '../app.js';
import { showItemForm as _showItemForm, renderPreprocList, _parsePreprocFromItem } from '../utils/item-form.js';

const SEV_LABEL  = ['Not classified','Information','Warning','Average','High','Disaster'];
const SEV_CLASS  = ['sev-nc','sev-info','sev-warn','sev-avg','sev-high','sev-dis'];
const ITEM_TYPE  = {0:'Zabbix agent',2:'Trapper',5:'Internal',7:'Active agent',
  10:'External',11:'DB monitor',12:'IPMI',13:'SSH',14:'Telnet',
  15:'Calculated',17:'SNMP trap',18:'Dependent',19:'HTTP agent',20:'SNMP',21:'Script'};
const VALUE_TYPE = ['Float','String','Log','Uint','Text'];
const OPERATOR   = {8:'matches',9:'does not match',12:'exists',13:'does not exist'};

export async function render(root, hostid, ruleid, tab) {
  const el = content();
  el.innerHTML = '<p class="loading">Loading…</p>';

  try {
    const [hosts, rules] = await Promise.all([
      call('host.get', { hostids:[hostid], output:['hostid','name','host'] }),
      call('discoveryrule.get', { itemids:[ruleid], output:'extend',
        selectFilter: true, selectLLDMacroPaths: true,
        selectPreprocessing: ['type','params','error_handler','error_handler_params'] }),
    ]);
    const host = hosts[0];
    const rule = rules[0];
    if (!host || !rule) { el.innerHTML = '<p class="error">Not found.</p>'; return; }

    renderShell(el, host, rule, tab);

    if      (tab === 'rule')     await renderRule(rule, hostid);
    else if (tab === 'items')    await renderItems(hostid, ruleid);
    else if (tab === 'triggers') await renderTriggers(hostid, ruleid);
    else if (tab === 'graphs')   await renderGraphs(hostid, ruleid);
    else if (tab === 'filter')   await renderFilter(rule);
    else                         await renderRule(rule, hostid); // default
  } catch(e) {
    el.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

function renderShell(el, host, rule, activeTab) {
  const tabs = ['rule','items','triggers','graphs','filter'];
  const TAB_LABEL = { rule:'Rule', items:'Item prototypes', triggers:'Trigger prototypes', graphs:'Graph prototypes', filter:'Filter' };
  const tabHtml = tabs.map(t => `
    <a href="#/hosts/${esc(host.hostid)}/discovery/${esc(rule.itemid)}/${t}"
       class="tab-btn${t===activeTab?' tab-active':''}">${TAB_LABEL[t]||t}</a>
  `).join('');

  el.innerHTML = `
    <div class="page-header">
      <h2>
        <a href="#/hosts" class="breadcrumb">Hosts</a>
        <span class="sep">›</span>
        <a href="#/hosts/${esc(host.hostid)}/discovery" class="breadcrumb">${esc(host.name||host.host)}</a>
        <span class="sep">›</span>
        ${esc(rule.name_resolved||rule.name)}
      </h2>
    </div>
    <div class="tab-bar">${tabHtml}</div>
    <div id="tab-content"></div>
  `;
}

function tc() { return document.getElementById('tab-content'); }

// ── Rule edit ─────────────────────────────────────────────────────────────────

const NO_DELAY_LLD = new Set([2]); // Trapper (Dependent excluded from LLD)

async function renderRule(rule, hostid) {
  const el = tc();
  const type = parseInt(rule.type);
  let preprocSteps = _parsePreprocFromItem(rule);

  el.innerHTML = `
    <div class="inline-form">
      <div class="tab-bar" style="margin-bottom:12px">
        <a href="#" class="tab-btn tab-active" data-panel="rl-panel-rule">Rule</a>
        <a href="#" class="tab-btn" data-panel="rl-panel-preproc">Preprocessing</a>
      </div>

      <div id="rl-panel-rule">
        <label class="form-wide">Name *<input id="rl-name" value="${esc(rule.name||'')}"></label>
        <label class="form-wide">Key *<input id="rl-key" value="${esc(rule.key_||'')}"></label>
        <div class="form-grid">
          <label>Type
            <select id="rl-type">
              ${Object.entries(ITEM_TYPE).filter(([k]) => k !== '18').map(([v,l]) =>
                `<option value="${v}"${parseInt(v)===type?' selected':''}>${l}</option>`
              ).join('')}
            </select>
          </label>
          <label id="rl-delay-wrap"${NO_DELAY_LLD.has(type)?' hidden':''}>
            Interval<input id="rl-delay" value="${esc(rule.delay||'1h')}" style="width:7rem">
          </label>
          <label>Keep lost resources for
            <input id="rl-lifetime" value="${esc(rule.lifetime||'30d')}" style="width:7rem">
          </label>
        </div>
        <div id="rl-type-fields"></div>
        <label class="form-wide">Description
          <textarea id="rl-desc" rows="2">${esc(rule.description||'')}</textarea>
        </label>
        <label style="margin-top:4px"><input type="checkbox" id="rl-enabled"${parseInt(rule.status)===0?' checked':''}> Enabled</label>
      </div>

      <div id="rl-panel-preproc" hidden>
        <div id="rl-preproc-list"></div>
        <button type="button" id="rl-preproc-add" class="btn-small" style="margin:4px 0 1rem">+ Add step</button>
      </div>

      <div class="form-actions">
        <button id="rl-submit">Update</button>
        <span id="rl-error" class="error" hidden></span>
        <span id="rl-ok" class="status-ok" hidden style="margin-left:8px">Saved.</span>
      </div>
    </div>`;

  // Tab switching
  const panels = ['rl-panel-rule', 'rl-panel-preproc'];
  el.querySelectorAll('.tab-btn[data-panel]').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      el.querySelectorAll('.tab-btn[data-panel]').forEach(t => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');
      panels.forEach(id => { el.querySelector('#' + id).hidden = (id !== tab.dataset.panel); });
    });
  });

  renderRuleTypeFields(type, rule);
  renderPreprocList(el, preprocSteps, 'rl-preproc-list');

  el.querySelector('#rl-preproc-add').addEventListener('click', () => {
    preprocSteps.push({ type: 1, params: [], error_handler: 0, error_handler_params: '' });
    renderPreprocList(el, preprocSteps, 'rl-preproc-list');
  });

  document.getElementById('rl-type').addEventListener('change', () => {
    const t = parseInt(document.getElementById('rl-type').value);
    document.getElementById('rl-delay-wrap').hidden = NO_DELAY_LLD.has(t);
    renderRuleTypeFields(t, null);
  });

  document.getElementById('rl-submit').addEventListener('click', async () => {
    const errEl = document.getElementById('rl-error');
    const okEl  = document.getElementById('rl-ok');
    errEl.hidden = true; okEl.hidden = true;
    const p = collectRuleParams(rule.itemid);
    if (!p) return;
    p.preprocessing = preprocSteps.map(s => ({
      type:                 s.type,
      params:               s.params.join('\n'),
      error_handler:        s.error_handler,
      error_handler_params: s.error_handler_params,
    }));
    try {
      await call('discoveryrule.update', p);
      Object.assign(rule, p);
      okEl.hidden = false;
      setTimeout(() => { if (okEl) okEl.hidden = true; }, 2000);
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  });
}

function renderRuleTypeFields(type, rule) {
  const el = document.getElementById('rl-type-fields');
  if (!el) return;
  let html = '<div class="form-grid form-type-fields">';

  if (type === 19) {
    html += `
      <label class="form-wide">URL *<input id="rl-url" value="${esc(rule?.url||'')}" placeholder="https://…"></label>
      <label>Method
        <select id="rl-method">
          ${['GET','POST','PUT','PATCH','DELETE','HEAD'].map((m,i) =>
            `<option value="${i}"${parseInt(rule?.request_method)===i?' selected':''}>${m}</option>`
          ).join('')}
        </select>
      </label>
      <label>Timeout<input id="rl-timeout" value="${esc(rule?.timeout||'3s')}" style="width:6rem"></label>
      <label>HTTP proxy<input id="rl-proxy" value="${esc(rule?.http_proxy||'')}"></label>
      <label class="form-wide">Headers<textarea id="rl-headers" rows="3" placeholder="Header: value">${esc(rule?.headers||'')}</textarea></label>
      <label class="form-wide">Request body<textarea id="rl-posts" rows="3">${esc(rule?.posts||'')}</textarea></label>
      <label>Body type
        <select id="rl-post-type">
          <option value="0"${parseInt(rule?.post_type)===0?' selected':''}>Raw</option>
          <option value="2"${parseInt(rule?.post_type)===2?' selected':''}>JSON</option>
          <option value="3"${parseInt(rule?.post_type)===3?' selected':''}>XML</option>
        </select>
      </label>
      <label><input type="checkbox" id="rl-follow"${parseInt(rule?.follow_redirects)!==0?' checked':''}> Follow redirects</label>
      <label><input type="checkbox" id="rl-verify-peer"${parseInt(rule?.verify_peer)===1?' checked':''}> Verify peer</label>
      <label><input type="checkbox" id="rl-verify-host"${parseInt(rule?.verify_host)===1?' checked':''}> Verify host</label>
      <label>Auth type
        <select id="rl-authtype">
          <option value="0"${parseInt(rule?.authtype)===0?' selected':''}>None</option>
          <option value="1"${parseInt(rule?.authtype)===1?' selected':''}>Basic</option>
          <option value="2"${parseInt(rule?.authtype)===2?' selected':''}>NTLM</option>
          <option value="3"${parseInt(rule?.authtype)===3?' selected':''}>Kerberos</option>
          <option value="4"${parseInt(rule?.authtype)===4?' selected':''}>Digest</option>
        </select>
      </label>
      <label>Username<input id="rl-username" value="${esc(rule?.username||'')}"></label>
      <label>Password<input id="rl-password" type="password" value=""></label>`;
  } else if (type === 20) {
    html += `<label class="form-wide">SNMP OID *<input id="rl-snmpoid" value="${esc(rule?.snmp_oid||'')}" placeholder=".1.3.6.1…"></label>`;
  } else if (type === 15) {
    html += `<label class="form-wide">Formula *<textarea id="rl-params" rows="3" placeholder="avg(/hostname/key,#5)">${esc(rule?.params||'')}</textarea></label>`;
  } else if (type === 13) {
    const isPub = parseInt(rule?.authtype) === 1;
    html += `
      <label>Auth type
        <select id="rl-authtype">
          <option value="0"${!isPub?' selected':''}>Password</option>
          <option value="1"${isPub?' selected':''}>Public key</option>
        </select>
      </label>
      <label>Username<input id="rl-username" value="${esc(rule?.username||'')}"></label>
      <label id="rl-pass-wrap"${isPub?' hidden':''}>Password<input id="rl-password" type="password" value=""></label>
      <label id="rl-pubkey-wrap"${isPub?'':' hidden'}>Public key file<input id="rl-pubkey" value="${esc(rule?.publickey||'')}"></label>
      <label id="rl-privkey-wrap"${isPub?'':' hidden'}>Private key file<input id="rl-privkey" value="${esc(rule?.privatekey||'')}"></label>
      <label class="form-wide">Commands<textarea id="rl-params" rows="4">${esc(rule?.params||'')}</textarea></label>`;
  } else if (type === 14) {
    html += `
      <label>Username<input id="rl-username" value="${esc(rule?.username||'')}"></label>
      <label>Password<input id="rl-password" type="password" value=""></label>
      <label class="form-wide">Commands<textarea id="rl-params" rows="4">${esc(rule?.params||'')}</textarea></label>`;
  } else if (type === 21) {
    html += `
      <label>Timeout<input id="rl-timeout" value="${esc(rule?.timeout||'3s')}" style="width:6rem"></label>
      <label class="form-wide">Script<textarea id="rl-params" rows="6">${esc(rule?.params||'')}</textarea></label>`;
  } else if (type === 11) {
    html += `
      <label>Username<input id="rl-username" value="${esc(rule?.username||'')}"></label>
      <label>Password<input id="rl-password" type="password" value=""></label>
      <label class="form-wide">SQL query<textarea id="rl-params" rows="4">${esc(rule?.params||'')}</textarea></label>`;
  } else if (type === 2) {
    html += `<label class="form-wide">Allowed hosts<input id="rl-trapper" value="${esc(rule?.trapper_hosts||'')}" placeholder="comma-separated IPs or CIDR"></label>`;
  }

  html += '</div>';
  el.innerHTML = html;

  if (type === 13) {
    document.getElementById('rl-authtype')?.addEventListener('change', e => {
      const isPub = e.target.value === '1';
      document.getElementById('rl-pass-wrap').hidden   = isPub;
      document.getElementById('rl-pubkey-wrap').hidden = !isPub;
      document.getElementById('rl-privkey-wrap').hidden = !isPub;
    });
  }
}

function _rlv(id) { return document.getElementById(id)?.value ?? ''; }
function _rlchk(id) { return document.getElementById(id)?.checked ? 1 : 0; }

function collectRuleTypeFields(type) {
  if (type === 19) return {
    url: _rlv('rl-url').trim(), request_method: parseInt(_rlv('rl-method')||'0'),
    timeout: _rlv('rl-timeout').trim()||'3s', http_proxy: _rlv('rl-proxy').trim(),
    headers: _rlv('rl-headers'), posts: _rlv('rl-posts'),
    post_type: parseInt(_rlv('rl-post-type')||'0'),
    follow_redirects: _rlchk('rl-follow'), verify_peer: _rlchk('rl-verify-peer'),
    verify_host: _rlchk('rl-verify-host'),
    authtype: parseInt(_rlv('rl-authtype')||'0'),
    username: _rlv('rl-username'), password: _rlv('rl-password'),
  };
  if (type === 20) return { snmp_oid: _rlv('rl-snmpoid').trim() };
  if (type === 15) return { params: _rlv('rl-params').trim() };
  if (type === 13) return {
    params: _rlv('rl-params'), authtype: parseInt(_rlv('rl-authtype')||'0'),
    username: _rlv('rl-username'), password: _rlv('rl-password'),
    publickey: _rlv('rl-pubkey').trim(), privatekey: _rlv('rl-privkey').trim(),
  };
  if (type === 14) return { params: _rlv('rl-params'), username: _rlv('rl-username'), password: _rlv('rl-password') };
  if (type === 21) return { params: _rlv('rl-params'), timeout: _rlv('rl-timeout').trim()||'3s' };
  if (type === 11) return { params: _rlv('rl-params'), username: _rlv('rl-username'), password: _rlv('rl-password') };
  if (type === 2)  return { trapper_hosts: _rlv('rl-trapper').trim() };
  return {};
}

function collectRuleParams(itemid) {
  const errEl = document.getElementById('rl-error');
  const name  = document.getElementById('rl-name')?.value.trim();
  const key   = document.getElementById('rl-key')?.value.trim();
  if (!name || !key) {
    errEl.textContent = 'Name and Key are required.'; errEl.hidden = false;
    return null;
  }
  const type = parseInt(document.getElementById('rl-type').value);
  const p = {
    itemid,
    name,
    key_:        key,
    type,
    status:      document.getElementById('rl-enabled')?.checked ? 0 : 1,
    lifetime:    document.getElementById('rl-lifetime')?.value.trim() || '30d',
    description: document.getElementById('rl-desc')?.value.trim() || '',
    ...collectRuleTypeFields(type),
  };
  if (!NO_DELAY_LLD.has(type)) {
    p.delay = document.getElementById('rl-delay')?.value.trim() || '1h';
  }
  return p;
}

// ── Item prototypes ───────────────────────────────────────────────────────────

async function renderItems(hostid, ruleid) {
  const el = tc();
  el.innerHTML = `
    <div class="tab-toolbar">
      <input id="ip-search" type="search" placeholder="Filter…">
      <button id="ip-create-btn">+ New item prototype</button>
    </div>
    <div id="ip-create-form" hidden></div>
    <div id="ip-list"><p class="loading">Loading…</p></div>
  `;
  document.getElementById('ip-search').addEventListener('input', () => filterRows('ip-list','ip-search'));
  document.getElementById('ip-create-btn').addEventListener('click', () => showItemProtoForm(hostid, ruleid));
  await loadItemPrototypes(hostid, ruleid);
}

async function loadItemPrototypes(hostid, ruleid) {
  const el = document.getElementById('ip-list');
  if (!el) return;
  const items = await call('itemprototype.get', {
    discoveryids: [ruleid], output: 'extend',
    selectPreprocessing: ['type','params','error_handler','error_handler_params'],
    selectTags: ['tag','value'],
  });
  if (!items.length) { el.innerHTML = '<p class="empty">No item prototypes.</p>'; return; }

  const itemMap = new Map(items.map(item => [item.itemid, item]));

  const rows = items.map(item => {
    const vt      = parseInt(item.value_type);
    const fromTpl = item.templateid && item.templateid !== '0';
    return `
      <tr data-name="${esc((item.name_resolved||item.name).toLowerCase())}">
        <td>
          <button class="link-btn ip-open" data-itemid="${esc(item.itemid)}">${esc(item.name_resolved||item.name)}</button>
          ${fromTpl ? '<span class="badge-tpl" title="Inherited from template">T</span>' : ''}
        </td>
        <td><code>${esc(item.key_)}</code></td>
        <td>${ITEM_TYPE[parseInt(item.type)]||item.type}</td>
        <td>${VALUE_TYPE[vt]||vt}${item.units?' / '+esc(item.units):''}</td>
        <td>${esc(item.delay)}</td>
        <td class="${parseInt(item.status)===0?'status-ok':'muted'}">${parseInt(item.status)===0?'Enabled':'Disabled'}</td>
        <td class="row-actions">
          <button class="btn-small ip-open" data-itemid="${esc(item.itemid)}">Edit</button>
          ${!fromTpl?`<button class="btn-small btn-danger ip-del"
                         data-itemid="${esc(item.itemid)}" data-ruleid="${esc(ruleid)}"
                         data-hostid="${esc(hostid)}" data-name="${esc(item.name)}">Del</button>`:''}
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Key</th><th>Type</th><th>Value type</th><th>Interval</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.querySelectorAll('.ip-open').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = itemMap.get(btn.dataset.itemid);
      if (item) {
        showItemProtoForm(hostid, ruleid, item);
        document.getElementById('ip-create-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });

  // Auto-open prototype when navigated here via ?open={itemid} (e.g. "Edit in template" link)
  const openId = new URLSearchParams(location.hash.replace(/^[^?]*\??/, '')).get('open');
  if (openId && itemMap.has(openId)) {
    showItemProtoForm(hostid, ruleid, itemMap.get(openId));
    document.getElementById('ip-create-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  el.querySelectorAll('.ip-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete item prototype "${btn.dataset.name}"?`)) return;
      try {
        await call('itemprototype.delete', { itemids: [btn.dataset.itemid] });
        await loadItemPrototypes(btn.dataset.hostid, btn.dataset.ruleid);
      } catch(e) { alert(e.message); }
    });
  });
}

function showItemProtoForm(hostid, ruleid, item = null) {
  const el = document.getElementById('ip-create-form');
  if (!el) return;
  _showItemForm(el, hostid, item, {
    title:       item ? 'Edit item prototype' : 'New item prototype',
    createFn:    p  => call('itemprototype.create', p),
    updateFn:    p  => call('itemprototype.update', p),
    extraParams: { ruleid },
    onSuccess:   () => loadItemPrototypes(hostid, ruleid),
  });
}

// ── Trigger prototypes ────────────────────────────────────────────────────────

async function renderTriggers(hostid, ruleid) {
  const el = tc();
  el.innerHTML = `
    <div class="tab-toolbar">
      <input id="tp-search" type="search" placeholder="Filter…">
      <button id="tp-create-btn">+ New trigger prototype</button>
    </div>
    <div id="tp-create-form" hidden></div>
    <div id="tp-list"><p class="loading">Loading…</p></div>
  `;
  document.getElementById('tp-search').addEventListener('input', () => filterRows('tp-list','tp-search'));
  document.getElementById('tp-create-btn').addEventListener('click', () => {
    const formEl = document.getElementById('tp-create-form');
    showTriggerProtoForm(formEl, hostid, ruleid);
  });
  await loadTriggerPrototypes(hostid, ruleid);
}

async function loadTriggerPrototypes(hostid, ruleid) {
  const el = document.getElementById('tp-list');
  if (!el) return;
  const triggers = await call('triggerprototype.get', { discoveryids:[ruleid], output:'extend', selectTags:['tag','value'], expandExpression: true });
  if (!triggers.length) { el.innerHTML = '<p class="empty">No trigger prototypes.</p>'; return; }

  const triggerMap = new Map(triggers.map(t => [t.triggerid, t]));

  const rows = triggers.map(t => {
    const sev = parseInt(t.priority);
    const fromTpl = t.templateid && t.templateid !== '0';
    return `
      <tr data-name="${esc(t.description.toLowerCase())}">
        <td class="${SEV_CLASS[sev]||''} sev-cell">${SEV_LABEL[sev]||sev}</td>
        <td>
          <button class="link-btn tp-open" data-triggerid="${esc(t.triggerid)}">${esc(t.description)}</button>
          ${fromTpl ? '<span class="badge-tpl" title="Inherited from template">T</span>' : ''}
        </td>
        <td class="muted" style="font-size:.8em;max-width:300px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis"
            title="${esc(t.expression)}">${esc(t.expression)}</td>
        <td class="${parseInt(t.status)===0?'status-ok':'muted'}">${parseInt(t.status)===0?'Enabled':'Disabled'}</td>
        <td class="row-actions">
          <button class="btn-small tp-open" data-triggerid="${esc(t.triggerid)}">Edit</button>
          ${!fromTpl?`<button class="btn-small btn-danger tp-del"
                         data-triggerid="${esc(t.triggerid)}" data-ruleid="${esc(ruleid)}"
                         data-hostid="${esc(hostid)}" data-name="${esc(t.description)}">Del</button>`:''}
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Severity</th><th>Description</th><th>Expression</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.querySelectorAll('.tp-open').forEach(btn => {
    btn.addEventListener('click', () => {
      const trigger = triggerMap.get(btn.dataset.triggerid);
      if (trigger) {
        const formEl = document.getElementById('tp-create-form');
        showTriggerProtoForm(formEl, hostid, ruleid, trigger, {
          onSuccess: () => loadTriggerPrototypes(hostid, ruleid),
        });
        formEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });

  el.querySelectorAll('.tp-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete trigger prototype "${btn.dataset.name}"?`)) return;
      try {
        await call('triggerprototype.delete', { triggerids:[btn.dataset.triggerid] });
        await loadTriggerPrototypes(btn.dataset.hostid, btn.dataset.ruleid);
      } catch(e) { alert(e.message); }
    });
  });

  // Auto-open trigger prototype when navigated via ?open={triggerid}
  const openId = new URLSearchParams(location.hash.replace(/^[^?]*\??/, '')).get('open');
  if (openId && triggerMap.has(openId)) {
    const formEl = document.getElementById('tp-create-form');
    showTriggerProtoForm(formEl, hostid, ruleid, triggerMap.get(openId), {
      onSuccess: () => loadTriggerPrototypes(hostid, ruleid),
    });
    formEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function showTriggerProtoForm(containerEl, hostid, ruleid, trigger = null, { onSuccess, onCancel } = {}) {
  const el = containerEl;
  if (!el) return;
  el.hidden = false;
  const isEdit = !!(trigger?.triggerid);
  let tpfTags = (trigger?.tags || []).map(t => ({ tag: t.tag, value: t.value || '' }));

  el.innerHTML = `
    <div class="inline-form">
      <h3>${isEdit?'Edit trigger prototype':'New trigger prototype'}</h3>
      ${trigger?.templatehostid && trigger.templatehostid !== '0'
        ? `<div class="form-note">Inherited from template. <a href="#/hosts/${esc(trigger.templatehostid)}/discovery/${esc(trigger.templateRuleid)}/triggers?open=${esc(trigger.templateid)}">Edit in template →</a></div>`
        : ''}
      <div class="tab-bar" style="margin-bottom:12px">
        <a href="#" class="tab-btn tab-active" data-tpanel="tpf-panel-main">Trigger</a>
        <a href="#" class="tab-btn" data-tpanel="tpf-panel-tags">Tags</a>
      </div>

      <div id="tpf-panel-main">
        <div class="form-grid">
          <label class="form-wide">Description *<input id="tpf-desc" value="${esc(trigger?.description||'')}"></label>
          <label class="form-wide">Expression *<textarea id="tpf-expr" rows="4" style="font-family:monospace;font-size:0.82rem" placeholder="last(/host/key[{#MACRO}]) > threshold">${esc(trigger?.expression||'')}</textarea></label>
          <label>Severity
            <select id="tpf-prio">
              ${SEV_LABEL.map((l,i)=>`<option value="${i}"${parseInt(trigger?.priority)===i?' selected':''}>${l}</option>`).join('')}
            </select>
          </label>
          <label>Recovery mode
            <select id="tpf-rec">
              <option value="0"${parseInt(trigger?.recovery_mode)===0?' selected':''}>Expression</option>
              <option value="2"${parseInt(trigger?.recovery_mode)===2?' selected':''}>None</option>
              <option value="1"${parseInt(trigger?.recovery_mode)===1?' selected':''}>Recovery expression</option>
            </select>
          </label>
          <label>PROBLEM event generation
            <select id="tpf-corr-mode">
              <option value="0"${parseInt(trigger?.correlation_mode)!==1?' selected':''}>Single</option>
              <option value="1"${parseInt(trigger?.correlation_mode)===1?' selected':''}>Multiple</option>
            </select>
          </label>
          <label><input type="checkbox" id="tpf-manual-close"${parseInt(trigger?.manual_close)===1?' checked':''}> Allow manual close</label>
        </div>
        <div id="tpf-rec-wrap" style="${parseInt(trigger?.recovery_mode)===1?'':'display:none'}">
          <label class="form-wide">Recovery expression<textarea id="tpf-rec-expr" rows="3" style="font-family:monospace;font-size:0.82rem">${esc(trigger?.recovery_expression||'')}</textarea></label>
        </div>
        <div class="form-grid">
          <label class="form-wide">Event name<input id="tpf-ename" value="${esc(trigger?.event_name||'')}"></label>
          <label class="form-wide">Operational data<input id="tpf-opdata" value="${esc(trigger?.opdata||'')}"></label>
          <label class="form-wide">URL name<input id="tpf-url-name" value="${esc(trigger?.url_name||'')}" placeholder="Link label (optional)"></label>
          <label class="form-wide">URL<input id="tpf-url" value="${esc(trigger?.url||'')}" placeholder="https://…"></label>
        </div>
        <div style="display:flex;gap:1.5rem;margin-top:6px">
          <label><input type="checkbox" id="tpf-enabled"${parseInt(trigger?.status??0)===0?' checked':''}> Enabled</label>
          <label><input type="checkbox" id="tpf-discover"${parseInt(trigger?.discover??0)===0?' checked':''}> Discover</label>
        </div>
      </div>

      <div id="tpf-panel-tags" hidden>
        <div id="tpf-tags-list"></div>
        <button type="button" id="tpf-tag-add" class="btn-small" style="margin:4px 0 1rem">+ Add tag</button>
      </div>

      <div class="form-actions">
        <button id="tpf-submit">${isEdit?'Save':'Create'}</button>
        ${isEdit ? '<button id="tpf-clone" type="button">Clone</button>' : ''}
        <button id="tpf-cancel">Cancel</button>
        <span id="tpf-error" class="error" hidden></span>
      </div>
    </div>`;

  // Tab switching
  el.querySelectorAll('.tab-btn[data-tpanel]').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      el.querySelectorAll('.tab-btn[data-tpanel]').forEach(t => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');
      ['tpf-panel-main','tpf-panel-tags'].forEach(id => {
        el.querySelector('#'+id).hidden = (id !== tab.dataset.tpanel);
      });
    });
  });

  function renderTpfTags() {
    const listEl = el.querySelector('#tpf-tags-list');
    if (!listEl) return;
    if (!tpfTags.length) {
      listEl.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No tags.</p>';
    } else {
      listEl.innerHTML = tpfTags.map((t, idx) => `
        <div class="iface-row" style="margin-bottom:4px">
          <input class="tpf-tag-name" data-idx="${idx}" value="${esc(t.tag)}" placeholder="tag name" style="width:150px">
          <input class="tpf-tag-value" data-idx="${idx}" value="${esc(t.value)}" placeholder="value (optional)" style="flex:1">
          <button type="button" class="btn-small btn-danger tpf-tag-rem" data-idx="${idx}">×</button>
        </div>`).join('');
      listEl.querySelectorAll('.tpf-tag-name').forEach(inp =>
        inp.addEventListener('input', () => { tpfTags[parseInt(inp.dataset.idx)].tag = inp.value; }));
      listEl.querySelectorAll('.tpf-tag-value').forEach(inp =>
        inp.addEventListener('input', () => { tpfTags[parseInt(inp.dataset.idx)].value = inp.value; }));
      listEl.querySelectorAll('.tpf-tag-rem').forEach(btn =>
        btn.addEventListener('click', () => { tpfTags.splice(parseInt(btn.dataset.idx), 1); renderTpfTags(); }));
    }
  }
  renderTpfTags();
  el.querySelector('#tpf-tag-add').addEventListener('click', () => {
    tpfTags.push({ tag: '', value: '' }); renderTpfTags();
  });

  document.getElementById('tpf-rec').addEventListener('change', e =>
    document.getElementById('tpf-rec-wrap').style.display = e.target.value==='1' ? '' : 'none'
  );
  const hide = () => { el.hidden=true; el.innerHTML=''; };
  document.getElementById('tpf-clone')?.addEventListener('click', () => {
    const cloned = {
      ...trigger,
      triggerid: null, templatehostid: '0', templateid: '0', templateRuleid: '0',
      description:         document.getElementById('tpf-desc').value.trim(),
      expression:          document.getElementById('tpf-expr').value.trim(),
      priority:            parseInt(document.getElementById('tpf-prio').value),
      status:              document.getElementById('tpf-enabled').checked ? 0 : 1,
      recovery_mode:       parseInt(document.getElementById('tpf-rec').value),
      recovery_expression: document.getElementById('tpf-rec-expr').value.trim(),
      correlation_mode:    parseInt(document.getElementById('tpf-corr-mode').value),
      event_name:          document.getElementById('tpf-ename').value.trim(),
      opdata:              document.getElementById('tpf-opdata').value.trim(),
      url_name:            document.getElementById('tpf-url-name').value.trim(),
      url:                 document.getElementById('tpf-url').value.trim(),
      manual_close:        document.getElementById('tpf-manual-close').checked ? 1 : 0,
      discover:            document.getElementById('tpf-discover').checked ? 0 : 1,
      tags:                tpfTags.map(t => ({...t})),
    };
    showTriggerProtoForm(el, hostid, ruleid, cloned, { onSuccess, onCancel });
  });
  document.getElementById('tpf-cancel').onclick = () => { hide(); if (onCancel) onCancel(); };
  document.getElementById('tpf-submit').onclick = async () => {
    const errEl = document.getElementById('tpf-error'); errEl.hidden=true;
    const p = {
      description:         document.getElementById('tpf-desc').value.trim(),
      expression:          document.getElementById('tpf-expr').value.trim(),
      priority:            parseInt(document.getElementById('tpf-prio').value),
      status:              document.getElementById('tpf-enabled').checked ? 0 : 1,
      recovery_mode:       parseInt(document.getElementById('tpf-rec').value),
      recovery_expression: document.getElementById('tpf-rec-expr').value.trim(),
      correlation_mode:    parseInt(document.getElementById('tpf-corr-mode').value),
      event_name:          document.getElementById('tpf-ename').value.trim(),
      opdata:              document.getElementById('tpf-opdata').value.trim(),
      url_name:            document.getElementById('tpf-url-name').value.trim(),
      url:                 document.getElementById('tpf-url').value.trim(),
      manual_close:        document.getElementById('tpf-manual-close').checked ? 1 : 0,
      discover:            document.getElementById('tpf-discover').checked ? 0 : 1,
      tags:                tpfTags.filter(t => t.tag.trim()),
    };
    try {
      if (trigger?.triggerid) { p.triggerid=trigger.triggerid; await call('triggerprototype.update',p); }
      else                   { p.ruleid = ruleid;             await call('triggerprototype.create',p); }
      hide();
      if (onSuccess) onSuccess(); else await loadTriggerPrototypes(hostid, ruleid);
    } catch(e) { errEl.textContent=e.message; errEl.hidden=false; }
  };
}

// ── Graph prototypes ──────────────────────────────────────────────────────────

async function renderGraphs(hostid, ruleid) {
  const el = tc();
  el.innerHTML = '<p class="loading">Loading…</p>';
  const graphs = await call('graphprototype.get', {
    discoveryids:[ruleid], output:'extend', selectGraphItems: true,
  });
  if (!graphs.length) { el.innerHTML = '<p class="empty">No graph prototypes.</p>'; return; }

  const rows = graphs.map(g => {
    const items = (g.gitems||[]).map(i => esc(i.name)).join(', ');
    return `
      <tr>
        <td>${esc(g.name)}</td>
        <td>${g.width} × ${g.height}</td>
        <td>${esc(g.graphtype_name||'Normal')}</td>
        <td class="muted" style="max-width:300px">${items}</td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Size</th><th>Type</th><th>Items</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Filter (LLD expression + macro paths) ────────────────────────────────────

const EVAL_LABEL = ['And/Or', 'And', 'Or', 'Custom expression'];

function computeFormula(conditions, evaltype) {
  if (!conditions.length) return '';
  const labels = conditions.map((_, i) => String.fromCharCode(65 + i)); // A, B, C...
  if (evaltype === 0) {
    // Group by macro, OR within group, AND between groups
    const groups = {};
    conditions.forEach((c, i) => {
      const k = c.macro.toUpperCase();
      (groups[k] = groups[k] || []).push(labels[i]);
    });
    const parts = Object.values(groups).map(g => g.length > 1 ? `(${g.join(' or ')})` : g[0]);
    return parts.join(' and ');
  }
  if (evaltype === 1) return labels.join(' and ');
  if (evaltype === 2) return labels.join(' or ');
  return ''; // custom — user writes it
}

async function renderFilter(rule) {
  const el = tc();
  const itemid = rule.itemid;
  let conditions  = (rule.filter?.conditions || []).map(c => ({
    macro: c.macro, operator: parseInt(c.operator), value: c.value || '',
  }));
  let macroPaths = (rule.lld_macro_paths || []).map(m => ({
    lld_macro: m.lld_macro, path: m.path,
  }));
  let evaltype = parseInt(rule.filter?.evaltype ?? 0);
  let formula  = rule.filter?.formula || '';

  el.innerHTML = `
    <div style="max-width:720px;padding-top:8px">
      <h3 style="margin:0 0 10px">Filter</h3>

      <div class="form-grid" style="margin-bottom:10px">
        <label>Type of calculation
          <select id="flt-evaltype">
            ${EVAL_LABEL.map((l,i)=>`<option value="${i}"${i===evaltype?' selected':''}>${l}</option>`).join('')}
          </select>
        </label>
        <label id="flt-formula-wrap" style="${evaltype===3?'':'display:none'}">Custom expression
          <input id="flt-formula" value="${esc(formula)}" style="width:340px">
        </label>
        <span id="flt-formula-display" class="muted" style="font-size:0.85rem;align-self:center;${evaltype===3?'display:none':''}"></span>
      </div>

      <div id="flt-conds-wrap">
        <table class="data-table" id="flt-conds-table" style="margin-bottom:6px">
          <thead><tr><th style="width:2rem">Label</th><th>Macro</th><th>Operator</th><th>Value</th><th></th></tr></thead>
          <tbody id="flt-conds-body"></tbody>
        </table>
        <button type="button" id="flt-cond-add" class="btn-small">+ Add condition</button>
      </div>

      <h3 style="margin:1.5rem 0 8px">LLD macros</h3>
      <table class="data-table" id="flt-mp-table" style="margin-bottom:6px">
        <thead><tr><th>LLD macro</th><th>JSONPath / XPath</th><th></th></tr></thead>
        <tbody id="flt-mp-body"></tbody>
      </table>
      <button type="button" id="flt-mp-add" class="btn-small">+ Add macro path</button>

      <div class="form-actions" style="margin-top:1.5rem">
        <button id="flt-save">Save</button>
        <span id="flt-error" class="error" hidden></span>
      </div>
    </div>`;

  function renderConditions() {
    const body = document.getElementById('flt-conds-body');
    if (!body) return;
    if (!conditions.length) {
      body.innerHTML = '<tr><td colspan="5" class="muted empty">No conditions.</td></tr>';
    } else {
      body.innerHTML = conditions.map((c, i) => {
        const label = String.fromCharCode(65 + i);
        const hideVal = c.operator === 12 || c.operator === 13;
        return `
          <tr data-idx="${i}">
            <td class="muted" style="font-weight:600">${label}</td>
            <td><input class="cond-macro" data-idx="${i}" value="${esc(c.macro)}" placeholder="{#MACRO}" style="width:160px"></td>
            <td><select class="cond-op" data-idx="${i}">
              ${Object.entries(OPERATOR).map(([v,l])=>`<option value="${v}"${c.operator===parseInt(v)?' selected':''}>${l}</option>`).join('')}
            </select></td>
            <td><input class="cond-val" data-idx="${i}" value="${esc(c.value)}"
                 style="width:200px${hideVal?';display:none':''}" placeholder="regex…"></td>
            <td><button type="button" class="btn-small btn-danger cond-rem" data-idx="${i}">×</button></td>
          </tr>`;
      }).join('');
    }
    body.querySelectorAll('.cond-macro').forEach(inp =>
      inp.addEventListener('input', () => { conditions[parseInt(inp.dataset.idx)].macro = inp.value; updateFormula(); }));
    body.querySelectorAll('.cond-op').forEach(sel =>
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx);
        const op = parseInt(sel.value);
        conditions[idx].operator = op;
        const valInp = body.querySelector(`.cond-val[data-idx="${idx}"]`);
        if (valInp) valInp.style.display = (op === 12 || op === 13) ? 'none' : '';
        updateFormula();
      }));
    body.querySelectorAll('.cond-val').forEach(inp =>
      inp.addEventListener('input', () => { conditions[parseInt(inp.dataset.idx)].value = inp.value; }));
    body.querySelectorAll('.cond-rem').forEach(btn =>
      btn.addEventListener('click', () => { conditions.splice(parseInt(btn.dataset.idx), 1); renderConditions(); updateFormula(); }));
  }

  function renderMacroPaths() {
    const body = document.getElementById('flt-mp-body');
    if (!body) return;
    if (!macroPaths.length) {
      body.innerHTML = '<tr><td colspan="3" class="muted empty">No macro paths.</td></tr>';
    } else {
      body.innerHTML = macroPaths.map((m, i) => `
        <tr data-idx="${i}">
          <td><input class="mp-macro" data-idx="${i}" value="${esc(m.lld_macro)}" placeholder="{#MACRO}" style="width:180px"></td>
          <td><input class="mp-path"  data-idx="${i}" value="${esc(m.path)}" placeholder="$.macro" style="width:280px"></td>
          <td><button type="button" class="btn-small btn-danger mp-rem" data-idx="${i}">×</button></td>
        </tr>`).join('');
    }
    body.querySelectorAll('.mp-macro').forEach(inp =>
      inp.addEventListener('input', () => { macroPaths[parseInt(inp.dataset.idx)].lld_macro = inp.value; }));
    body.querySelectorAll('.mp-path').forEach(inp =>
      inp.addEventListener('input', () => { macroPaths[parseInt(inp.dataset.idx)].path = inp.value; }));
    body.querySelectorAll('.mp-rem').forEach(btn =>
      btn.addEventListener('click', () => { macroPaths.splice(parseInt(btn.dataset.idx), 1); renderMacroPaths(); }));
  }

  function updateFormula() {
    const disp = document.getElementById('flt-formula-display');
    if (!disp) return;
    const f = computeFormula(conditions, evaltype);
    disp.textContent = f ? `Expression: ${f}` : '';
  }

  document.getElementById('flt-evaltype').addEventListener('change', e => {
    evaltype = parseInt(e.target.value);
    const isCustom = evaltype === 3;
    document.getElementById('flt-formula-wrap').style.display   = isCustom ? '' : 'none';
    document.getElementById('flt-formula-display').style.display = isCustom ? 'none' : '';
    updateFormula();
  });

  document.getElementById('flt-cond-add').addEventListener('click', () => {
    conditions.push({ macro: '', operator: 8, value: '' });
    renderConditions(); updateFormula();
  });
  document.getElementById('flt-mp-add').addEventListener('click', () => {
    macroPaths.push({ lld_macro: '', path: '' });
    renderMacroPaths();
  });

  document.getElementById('flt-save').addEventListener('click', async () => {
    const errEl = document.getElementById('flt-error');
    errEl.hidden = true;
    const customFormula = document.getElementById('flt-formula')?.value.trim() || '';
    try {
      await call('discoveryrule.update', {
        itemid,
        filter: {
          evaltype,
          formula:    evaltype === 3 ? customFormula : '',
          conditions: conditions.filter(c => c.macro.trim()),
        },
        lld_macro_paths: macroPaths.filter(m => m.lld_macro.trim()),
      });
      // refresh rule data
      const rules = await call('discoveryrule.get', {
        itemids:[itemid], output:'extend', selectFilter:true, selectLLDMacroPaths:true,
      });
      const updated = rules[0];
      if (updated) {
        conditions  = (updated.filter?.conditions || []).map(c => ({
          macro: c.macro, operator: parseInt(c.operator), value: c.value || '',
        }));
        macroPaths = (updated.lld_macro_paths || []).map(m => ({
          lld_macro: m.lld_macro, path: m.path,
        }));
        evaltype = parseInt(updated.filter?.evaltype ?? 0);
        formula  = updated.filter?.formula || '';
        document.getElementById('flt-evaltype').value = evaltype;
        document.getElementById('flt-formula').value  = formula;
        const isCustom = evaltype === 3;
        document.getElementById('flt-formula-wrap').style.display   = isCustom ? '' : 'none';
        document.getElementById('flt-formula-display').style.display = isCustom ? 'none' : '';
      }
      renderConditions(); renderMacroPaths(); updateFormula();
      errEl.textContent = ''; errEl.hidden = true;
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  });

  renderConditions();
  renderMacroPaths();
  updateFormula();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function filterRows(listId, searchId) {
  const q = document.getElementById(searchId)?.value.toLowerCase() || '';
  document.querySelectorAll(`#${listId} tr[data-name]`).forEach(tr => {
    tr.style.display = tr.dataset.name.includes(q) ? '' : 'none';
  });
}
