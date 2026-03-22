/**
 * Shared item/item-prototype form logic.
 */
import { call } from '../api.js';
import { esc } from '../app.js';

export const ITEM_TYPE = {
  0:'Zabbix agent', 2:'Trapper', 5:'Internal', 7:'Active agent',
  10:'External', 11:'DB monitor', 12:'IPMI', 13:'SSH', 14:'Telnet',
  15:'Calculated', 17:'SNMP trap', 18:'Dependent', 19:'HTTP agent',
  20:'SNMP', 21:'Script',
};
// LLD rules support same types except Dependent (18)
export const LLD_ITEM_TYPE = Object.fromEntries(
  Object.entries(ITEM_TYPE).filter(([k]) => k !== '18')
);
export const VALUE_TYPE  = ['Float','String','Log','Uint','Text'];
export const NO_DELAY    = new Set([2, 18]); // Trapper, Dependent

// Preprocessing step type definitions
// paramLabels: names of params (joined with \n in DB), textarea: use textarea
const PREPROC_TYPE = {
  1:  { name: 'Custom multiplier',              paramLabels: ['Multiplier'] },
  2:  { name: 'Right trim',                     paramLabels: ['Characters'] },
  3:  { name: 'Left trim',                      paramLabels: ['Characters'] },
  4:  { name: 'Regular expression',             paramLabels: ['Pattern', 'Output'] },
  5:  { name: 'Boolean to decimal',             paramLabels: [] },
  6:  { name: 'Octal to decimal',               paramLabels: [] },
  7:  { name: 'Hex to decimal',                 paramLabels: [] },
  8:  { name: 'Simple change',                  paramLabels: [] },
  9:  { name: 'Change per second',              paramLabels: [] },
  10: { name: 'XML XPath',                      paramLabels: ['XPath'] },
  11: { name: 'JSONPath',                       paramLabels: ['Path'] },
  12: { name: 'In range',                       paramLabels: ['Min', 'Max'] },
  13: { name: 'Matches regular expression',     paramLabels: ['Pattern'] },
  14: { name: 'Does not match regex',           paramLabels: ['Pattern'] },
  15: { name: 'Check for error in JSON',        paramLabels: ['Path'] },
  16: { name: 'Check for error in XML',         paramLabels: ['XPath'] },
  17: { name: 'Check for error using regex',    paramLabels: ['Pattern', 'Output'] },
  18: { name: 'Discard unchanged',              paramLabels: [] },
  19: { name: 'Discard unchanged with heartbeat', paramLabels: ['Heartbeat (sec)'] },
  20: { name: 'JavaScript',                     paramLabels: ['Script'], textarea: true },
  21: { name: 'Prometheus pattern',             paramLabels: ['Pattern'] },
  22: { name: 'Prometheus to JSON',             paramLabels: ['Pattern'] },
  24: { name: 'Replace',                        paramLabels: ['Search string', 'Replacement'] },
  26: { name: 'XML to JSON',                    paramLabels: [] },
};
const ERROR_HANDLER_LABEL = ['Original error','Discard value','Set value to','Set error to'];

export function showItemForm(containerEl, hostid, item, opts) {
  containerEl.hidden = false;
  const isEdit  = !!(item?.itemid);
  const curType = parseInt(item?.type ?? 0);

  // Init mutable state for preprocessing and tags
  let preprocSteps = _parsePreprocFromItem(item);
  let itemTags     = (item?.tags || []).map(t => ({ tag: t.tag, value: t.value || '' }));

  containerEl.innerHTML = `
    <div class="inline-form">
      <h3>${esc(opts.title || (isEdit ? 'Edit item' : 'New item'))}</h3>
      ${item?.templatehostid && item.templatehostid !== '0'
        ? `<div class="form-note">Inherited from template. <a href="#/hosts/${esc(item.templatehostid)}/${
            opts.extraParams?.ruleid && item.templateRuleid && item.templateRuleid !== '0'
              ? `discovery/${esc(item.templateRuleid)}/items?open=${esc(item.templateid)}`
              : `items/${esc(item.templateid)}`
          }">Edit in template →</a></div>`
        : ''}
      <div class="tab-bar" style="margin-bottom:12px">
        <a href="#" class="tab-btn tab-active" data-panel="if-panel-item">Item</a>
        <a href="#" class="tab-btn" data-panel="if-panel-preproc">Preprocessing</a>
        <a href="#" class="tab-btn" data-panel="if-panel-tags">Tags</a>
      </div>

      <div id="if-panel-item">
        <label class="form-wide">Name *<input id="if-name" value="${esc(item?.name_resolved||item?.name||'')}"></label>
        <label class="form-wide">Key *<input id="if-key" value="${esc(item?.key_||'')}"></label>
        <div class="form-grid">
          <label>Type
            <select id="if-type">
              ${Object.entries(ITEM_TYPE).map(([v,l])=>`<option value="${v}"${parseInt(item?.type)===parseInt(v)?' selected':''}>${l}</option>`).join('')}
            </select>
          </label>
          <label>Value type
            <select id="if-vtype">
              ${VALUE_TYPE.map((l,i)=>`<option value="${i}"${parseInt(item?.value_type)===i?' selected':''}>${l}</option>`).join('')}
            </select>
          </label>
          <label id="if-delay-wrap"${NO_DELAY.has(curType)?' hidden':''}>
            Interval<input id="if-delay" value="${esc(item?.delay||'60s')}" style="width:7rem">
          </label>
          <label>History<input id="if-history" value="${esc(item?.history||'31d')}" style="width:7rem"></label>
          <label>Trends<input id="if-trends" value="${esc(item?.trends||'365d')}" style="width:7rem"></label>
          <label>Units<input id="if-units" value="${esc(item?.units||'')}"></label>
          <label>Value mapping
            <select id="if-valuemapid">
              <option value="">— None —</option>
            </select>
          </label>
        </div>
        <div id="if-type-fields"></div>
        <label class="form-wide">Description
          <textarea id="if-desc" rows="2">${esc(item?.description||'')}</textarea>
        </label>
        <div style="display:flex;gap:1.5rem;margin-top:6px">
          <label><input type="checkbox" id="if-enabled"${parseInt(item?.status??0)===0?' checked':''}> Enabled</label>
          ${opts.extraParams?.ruleid
            ? `<label><input type="checkbox" id="if-discover"${parseInt(item?.discover??0)===0?' checked':''}> Discover</label>`
            : ''}
        </div>
      </div>

      <div id="if-panel-preproc" hidden>
        <div id="if-preproc-list"></div>
        <button type="button" id="if-preproc-add" class="btn-small" style="margin:4px 0 1rem">+ Add step</button>
      </div>

      <div id="if-panel-tags" hidden>
        <div id="if-tags-list"></div>
        <button type="button" id="if-tag-add" class="btn-small" style="margin:4px 0 1rem">+ Add tag</button>
      </div>

      <div class="form-actions">
        <button id="if-submit">${isEdit ? 'Save' : 'Create'}</button>
        ${isEdit ? '<button id="if-clone" type="button">Clone</button>' : ''}
        <button id="if-cancel">Cancel</button>
        <span id="if-error" class="error" hidden></span>
      </div>
    </div>`;

  // Tab switching
  const panels = ['if-panel-item', 'if-panel-preproc', 'if-panel-tags'];
  containerEl.querySelectorAll('.tab-btn[data-panel]').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      containerEl.querySelectorAll('.tab-btn[data-panel]').forEach(t => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');
      panels.forEach(id => { containerEl.querySelector('#' + id).hidden = (id !== tab.dataset.panel); });
    });
  });

  renderTypeFields(curType, item, hostid);
  renderPreprocList(containerEl, preprocSteps);
  renderTagsList(containerEl, itemTags);

  // Load value maps async and populate select
  call('valuemap.get', { output: ['valuemapid', 'name'] }).then(maps => {
    const sel = containerEl.querySelector('#if-valuemapid');
    if (!sel) return;
    const curVmid = String(item?.valuemapid || '');
    maps.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.valuemapid;
      opt.textContent = m.name;
      if (String(m.valuemapid) === curVmid) opt.selected = true;
      sel.appendChild(opt);
    });
  }).catch(() => {});

  containerEl.querySelector('#if-type').addEventListener('change', e => {
    const t = parseInt(e.target.value);
    containerEl.querySelector('#if-delay-wrap').hidden = NO_DELAY.has(t);
    renderTypeFields(t, null, hostid);
  });
  containerEl.querySelector('#if-preproc-add').addEventListener('click', () => {
    preprocSteps.push({ type: 1, params: [], error_handler: 0, error_handler_params: '' });
    renderPreprocList(containerEl, preprocSteps);
  });
  containerEl.querySelector('#if-tag-add').addEventListener('click', () => {
    itemTags.push({ tag: '', value: '' });
    renderTagsList(containerEl, itemTags);
  });
  containerEl.querySelector('#if-cancel').onclick = () => {
    containerEl.hidden = true; containerEl.innerHTML = '';
  };
  containerEl.querySelector('#if-clone')?.addEventListener('click', () => {
    const type = parseInt(containerEl.querySelector('#if-type').value);
    const cloned = {
      ...item,
      itemid: null, templatehostid: '0', templateid: '0', templateRuleid: '0',
      name:        containerEl.querySelector('#if-name').value.trim(),
      key_:        containerEl.querySelector('#if-key').value.trim(),
      type,
      value_type:  parseInt(containerEl.querySelector('#if-vtype').value),
      delay:       containerEl.querySelector('#if-delay')?.value.trim() || item?.delay || '60s',
      history:     containerEl.querySelector('#if-history').value.trim(),
      trends:      containerEl.querySelector('#if-trends').value.trim(),
      units:       containerEl.querySelector('#if-units').value.trim(),
      valuemapid:  containerEl.querySelector('#if-valuemapid').value || '0',
      description: containerEl.querySelector('#if-desc').value.trim(),
      status:      containerEl.querySelector('#if-enabled')?.checked ? 0 : 1,
      tags:        itemTags.map(t => ({...t})),
      preprocessing: preprocSteps.map(s => ({...s, params: [...s.params]})),
      ..._collectTypeFields(type),
    };
    showItemForm(containerEl, hostid, cloned, { ...opts, title: `Clone of ${cloned.name || 'item'}` });
  });
  containerEl.querySelector('#if-submit').onclick = () =>
    _submit(containerEl, hostid, isEdit ? item : null, opts, preprocSteps, itemTags);
}

// ── Preprocessing ─────────────────────────────────────────────────────────────

export function _parsePreprocFromItem(item) {
  if (!item?.preprocessing?.length) return [];
  return item.preprocessing.map(pp => {
    const type = parseInt(pp.type);
    const typeDef = PREPROC_TYPE[type] || { paramLabels: [] };
    const paramsStr = Array.isArray(pp.params) ? pp.params.join('\n') : (pp.params || '');
    const parts = paramsStr.split('\n');
    return {
      type,
      params: typeDef.paramLabels.map((_, i) => parts[i] || ''),
      error_handler: parseInt(pp.error_handler || 0),
      error_handler_params: pp.error_handler_params || '',
    };
  });
}

export function renderPreprocList(containerEl, steps, listId = 'if-preproc-list') {
  const el = containerEl.querySelector('#' + listId);
  if (!el) return;
  if (!steps.length) {
    el.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No preprocessing steps.</p>';
    return;
  }
  el.innerHTML = steps.map((step, idx) => {
    const typeDef = PREPROC_TYPE[step.type] || { name: `Type ${step.type}`, paramLabels: [] };
    const typeOpts = Object.entries(PREPROC_TYPE).map(([v, t]) =>
      `<option value="${v}"${step.type === parseInt(v) ? ' selected' : ''}>${t.name}</option>`
    ).join('');
    const paramInputs = typeDef.paramLabels.map((label, pi) =>
      typeDef.textarea
        ? `<label style="font-size:0.82rem;margin-top:4px">${label}<textarea class="pp-param" data-idx="${idx}" data-pi="${pi}" rows="4" style="width:100%">${esc(step.params[pi] || '')}</textarea></label>`
        : `<label style="font-size:0.82rem">${label}<input class="pp-param" data-idx="${idx}" data-pi="${pi}" value="${esc(step.params[pi] || '')}" style="width:100%"></label>`
    ).join('');
    const ehOpts = ERROR_HANDLER_LABEL.map((l, i) =>
      `<option value="${i}"${step.error_handler === i ? ' selected' : ''}>${l}</option>`
    ).join('');
    const ehParams = step.error_handler >= 2
      ? `<input class="pp-eh-params" data-idx="${idx}" value="${esc(step.error_handler_params)}" style="width:180px" placeholder="value">`
      : '';
    return `
      <div class="preproc-step" data-idx="${idx}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span class="muted" style="font-size:0.8rem;min-width:18px;text-align:right">${idx + 1}</span>
          <select class="pp-type" data-idx="${idx}" style="flex:1">${typeOpts}</select>
          <button type="button" class="btn-small btn-danger pp-remove" data-idx="${idx}" style="padding:0.1rem 0.4rem">×</button>
        </div>
        ${paramInputs ? `<div style="padding-left:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px">${paramInputs}</div>` : ''}
        <div style="padding-left:24px;display:flex;align-items:center;gap:6px;margin-top:4px">
          <label style="font-size:0.82rem;display:flex;align-items:center;gap:4px">On fail
            <select class="pp-eh" data-idx="${idx}">${ehOpts}</select>
          </label>
          ${ehParams}
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.pp-type').forEach(sel => sel.addEventListener('change', () => {
    const idx = parseInt(sel.dataset.idx);
    steps[idx].type = parseInt(sel.value);
    steps[idx].params = [];
    renderPreprocList(containerEl, steps, listId);
  }));
  el.querySelectorAll('.pp-param').forEach(inp => inp.addEventListener('input', () => {
    const idx = parseInt(inp.dataset.idx), pi = parseInt(inp.dataset.pi);
    steps[idx].params[pi] = inp.value;
  }));
  el.querySelectorAll('.pp-eh').forEach(sel => sel.addEventListener('change', () => {
    const idx = parseInt(sel.dataset.idx);
    steps[idx].error_handler = parseInt(sel.value);
    renderPreprocList(containerEl, steps, listId);
  }));
  el.querySelectorAll('.pp-eh-params').forEach(inp => inp.addEventListener('input', () => {
    steps[parseInt(inp.dataset.idx)].error_handler_params = inp.value;
  }));
  el.querySelectorAll('.pp-remove').forEach(btn => btn.addEventListener('click', () => {
    steps.splice(parseInt(btn.dataset.idx), 1);
    renderPreprocList(containerEl, steps, listId);
  }));
}

// ── Tags ──────────────────────────────────────────────────────────────────────

function renderTagsList(containerEl, tags) {
  const el = containerEl.querySelector('#if-tags-list');
  if (!el) return;
  if (!tags.length) {
    el.innerHTML = '<p class="muted" style="font-size:0.82rem;margin:0 0 4px">No tags.</p>';
    return;
  }
  el.innerHTML = tags.map((t, idx) => `
    <div class="iface-row" style="margin-bottom:4px">
      <input class="tag-name" data-idx="${idx}" value="${esc(t.tag)}" placeholder="tag name" style="width:150px">
      <input class="tag-value" data-idx="${idx}" value="${esc(t.value)}" placeholder="value (optional)" style="flex:1">
      <button type="button" class="btn-small btn-danger tag-remove" data-idx="${idx}">×</button>
    </div>`).join('');

  el.querySelectorAll('.tag-name').forEach(inp => inp.addEventListener('input', () => {
    tags[parseInt(inp.dataset.idx)].tag = inp.value;
  }));
  el.querySelectorAll('.tag-value').forEach(inp => inp.addEventListener('input', () => {
    tags[parseInt(inp.dataset.idx)].value = inp.value;
  }));
  el.querySelectorAll('.tag-remove').forEach(btn => btn.addEventListener('click', () => {
    tags.splice(parseInt(btn.dataset.idx), 1);
    renderTagsList(containerEl, tags);
  }));
}

// ── Type-specific fields ──────────────────────────────────────────────────────

function renderTypeFields(type, item, hostid) {
  const el = document.getElementById('if-type-fields');
  if (!el) return;
  let html = '<div class="form-grid form-type-fields">';

  if (type === 19) {
    html += `
      <label class="form-wide">URL *<input id="if-url" value="${esc(item?.url||'')}" placeholder="https://…"></label>
      <label>Method
        <select id="if-method">
          ${['GET','POST','PUT','PATCH','DELETE','HEAD'].map((m,i)=>`<option value="${i}"${parseInt(item?.request_method)===i?' selected':''}>${m}</option>`).join('')}
        </select>
      </label>
      <label>Timeout<input id="if-timeout" value="${esc(item?.timeout||'3s')}" style="width:6rem"></label>
      <label>HTTP proxy<input id="if-proxy" value="${esc(item?.http_proxy||'')}"></label>
      <label class="form-wide">Headers<textarea id="if-headers" rows="3" placeholder="Accept: application/json&#10;X-Token: value">${esc(item?.headers||'')}</textarea></label>
      <label class="form-wide">Request body<textarea id="if-posts" rows="3">${esc(item?.posts||'')}</textarea></label>
      <label>Body type
        <select id="if-post-type">
          <option value="0"${parseInt(item?.post_type)===0?' selected':''}>Raw</option>
          <option value="2"${parseInt(item?.post_type)===2?' selected':''}>JSON</option>
          <option value="3"${parseInt(item?.post_type)===3?' selected':''}>XML</option>
        </select>
      </label>
      <label>Retrieve
        <select id="if-retrieve">
          <option value="0"${parseInt(item?.retrieve_mode)===0?' selected':''}>Body</option>
          <option value="1"${parseInt(item?.retrieve_mode)===1?' selected':''}>Headers</option>
          <option value="2"${parseInt(item?.retrieve_mode)===2?' selected':''}>Both</option>
        </select>
      </label>
      <label><input type="checkbox" id="if-follow"${parseInt(item?.follow_redirects)!==0?' checked':''}> Follow redirects</label>
      <label><input type="checkbox" id="if-verify-peer"${parseInt(item?.verify_peer)===1?' checked':''}> Verify peer</label>
      <label><input type="checkbox" id="if-verify-host"${parseInt(item?.verify_host)===1?' checked':''}> Verify host</label>
      <label>Auth type
        <select id="if-authtype">
          <option value="0"${parseInt(item?.authtype)===0?' selected':''}>None</option>
          <option value="1"${parseInt(item?.authtype)===1?' selected':''}>Basic</option>
          <option value="2"${parseInt(item?.authtype)===2?' selected':''}>NTLM</option>
          <option value="3"${parseInt(item?.authtype)===3?' selected':''}>Kerberos</option>
          <option value="4"${parseInt(item?.authtype)===4?' selected':''}>Digest</option>
        </select>
      </label>
      <label>Username<input id="if-username" value="${esc(item?.username||'')}"></label>
      <label>Password<input id="if-password" type="password" value=""></label>`;
  } else if (type === 20) {
    html += `<label class="form-wide">SNMP OID *<input id="if-snmp-oid" value="${esc(item?.snmp_oid||'')}" placeholder=".1.3.6.1…"></label>`;
  } else if (type === 15) {
    html += `<label class="form-wide">Formula *<textarea id="if-params" rows="3" placeholder="avg(/hostname/key,#5)">${esc(item?.params||'')}</textarea></label>`;
  } else if (type === 18) {
    html += `<label class="form-wide">Master item *<select id="if-master-item"><option value="">Loading…</option></select></label>`;
    call('item.get', { hostids:[hostid], output:['itemid','name','key_'], limit:1000 })
      .then(items => {
        const sel = document.getElementById('if-master-item');
        if (!sel) return;
        sel.innerHTML = items.map(i =>
          `<option value="${esc(i.itemid)}"${i.itemid===item?.master_itemid?' selected':''}>${esc(i.name||i.key_)}</option>`
        ).join('');
      }).catch(()=>{});
  } else if (type === 13) {
    html += `
      <label>Auth type
        <select id="if-authtype">
          <option value="0"${parseInt(item?.authtype)===0?' selected':''}>Password</option>
          <option value="1"${parseInt(item?.authtype)===1?' selected':''}>Public key</option>
        </select>
      </label>
      <label>Username<input id="if-username" value="${esc(item?.username||'')}"></label>
      <label>Password<input id="if-password" type="password" value=""></label>
      <label class="form-wide">Commands<textarea id="if-params" rows="4">${esc(item?.params||'')}</textarea></label>`;
  } else if (type === 14) {
    html += `
      <label>Username<input id="if-username" value="${esc(item?.username||'')}"></label>
      <label>Password<input id="if-password" type="password" value=""></label>
      <label class="form-wide">Commands<textarea id="if-params" rows="4">${esc(item?.params||'')}</textarea></label>`;
  } else if (type === 21) {
    html += `
      <label>Timeout<input id="if-timeout" value="${esc(item?.timeout||'3s')}" style="width:6rem"></label>
      <label class="form-wide">Script<textarea id="if-params" rows="6">${esc(item?.params||'')}</textarea></label>`;
  } else if (type === 11) {
    html += `
      <label>Username<input id="if-username" value="${esc(item?.username||'')}"></label>
      <label>Password<input id="if-password" type="password" value=""></label>
      <label class="form-wide">SQL query<textarea id="if-params" rows="4">${esc(item?.params||'')}</textarea></label>`;
  } else if (type === 2) {
    html += `<label class="form-wide">Allowed hosts<input id="if-trapper-hosts" value="${esc(item?.trapper_hosts||'')}" placeholder="comma-separated IPs or CIDR"></label>`;
  }

  html += '</div>';
  el.innerHTML = html;
}

function _collectTypeFields(type) {
  const v   = id => document.getElementById(id)?.value ?? '';
  const chk = id => document.getElementById(id)?.checked ? 1 : 0;
  if (type === 19) return {
    url: v('if-url').trim(), request_method: parseInt(v('if-method')||'0'),
    timeout: v('if-timeout').trim()||'3s', http_proxy: v('if-proxy').trim(),
    headers: v('if-headers'), posts: v('if-posts'),
    post_type: parseInt(v('if-post-type')||'0'),
    retrieve_mode: parseInt(v('if-retrieve')||'0'),
    follow_redirects: chk('if-follow'), verify_peer: chk('if-verify-peer'),
    verify_host: chk('if-verify-host'),
    authtype: parseInt(v('if-authtype')||'0'),
    username: v('if-username'), password: v('if-password'),
  };
  if (type === 20) return { snmp_oid: v('if-snmp-oid').trim() };
  if (type === 15) return { params: v('if-params').trim() };
  if (type === 18) return { master_itemid: v('if-master-item') };
  if (type === 13) return { params: v('if-params'), authtype: parseInt(v('if-authtype')||'0'), username: v('if-username'), password: v('if-password') };
  if (type === 14) return { params: v('if-params'), username: v('if-username'), password: v('if-password') };
  if (type === 21) return { params: v('if-params'), timeout: v('if-timeout').trim()||'3s' };
  if (type === 11) return { params: v('if-params'), username: v('if-username'), password: v('if-password') };
  if (type === 2)  return { trapper_hosts: v('if-trapper-hosts').trim() };
  return {};
}

async function _submit(containerEl, hostid, item, opts, preprocSteps, itemTags) {
  const errEl = containerEl.querySelector('#if-error');
  errEl.hidden = true;
  const type = parseInt(containerEl.querySelector('#if-type').value);
  const p = {
    hostid,
    name:        containerEl.querySelector('#if-name').value.trim(),
    key_:        containerEl.querySelector('#if-key').value.trim(),
    type,
    value_type:  parseInt(containerEl.querySelector('#if-vtype').value),
    history:     containerEl.querySelector('#if-history').value.trim(),
    trends:      containerEl.querySelector('#if-trends').value.trim(),
    units:        containerEl.querySelector('#if-units').value.trim(),
    valuemapid:   containerEl.querySelector('#if-valuemapid').value || '0',
    description:  containerEl.querySelector('#if-desc').value.trim(),
    status:       containerEl.querySelector('#if-enabled')?.checked ? 0 : 1,
    ...(containerEl.querySelector('#if-discover') !== null
      ? { discover: containerEl.querySelector('#if-discover').checked ? 0 : 1 }
      : {}),
    preprocessing: preprocSteps.map(s => ({
      type:                 s.type,
      params:               s.params.join('\n'),
      error_handler:        s.error_handler,
      error_handler_params: s.error_handler_params,
    })),
    tags: itemTags.filter(t => t.tag.trim()),
    ...(opts.extraParams || {}),
    ..._collectTypeFields(type),
  };
  if (!NO_DELAY.has(type)) {
    p.delay = containerEl.querySelector('#if-delay').value.trim();
  }
  try {
    if (item?.itemid) { p.itemid = item.itemid; await opts.updateFn(p); }
    else              { await opts.createFn(p); }
    containerEl.hidden = true; containerEl.innerHTML = '';
    await opts.onSuccess();
  } catch(e) {
    errEl.textContent = e.message; errEl.hidden = false;
  }
}
