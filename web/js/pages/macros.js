/**
 * Administration › Macros — global macros CRUD
 * Route: #/admin/macros
 */
import { call } from '../api.js';
import { content, esc } from '../app.js';

const MACRO_TYPE = ['Text', 'Secret', 'Vault secret'];

export async function render(root) {
  const el = content();
  el.innerHTML = `
    <div class="page-header">
      <h2>Global macros</h2>
      <button id="gm-create-btn">+ New macro</button>
    </div>
    <div id="gm-create-form" hidden></div>
    <div id="gm-list"><p class="loading">Loading…</p></div>
  `;

  document.getElementById('gm-create-btn').addEventListener('click', () => showForm());
  await loadMacros();
}

async function loadMacros() {
  const el = document.getElementById('gm-list');
  if (!el) return;
  const macros = await call('globalmacro.get', { output: 'extend' });
  if (!macros.length) { el.innerHTML = '<p class="empty">No global macros.</p>'; return; }

  const rows = macros.map(m => {
    const isSecret = parseInt(m.type) === 1;
    return `
      <tr>
        <td><code>${esc(m.macro)}</code></td>
        <td>${isSecret ? '••••••••' : esc(m.value)}</td>
        <td>${MACRO_TYPE[parseInt(m.type)] || m.type}</td>
        <td class="muted">${esc(m.description)}</td>
        <td class="row-actions">
          <button class="btn-small" data-edit="${esc(m.globalmacroid)}"
            data-macro="${esc(m.macro)}" data-value="${esc(isSecret ? '' : m.value)}"
            data-type="${esc(m.type)}" data-desc="${esc(m.description)}">Edit</button>
          <button class="btn-small btn-danger" data-del="${esc(m.globalmacroid)}" data-macro="${esc(m.macro)}">Del</button>
        </td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Macro</th><th>Value</th><th>Type</th><th>Description</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.querySelectorAll('button[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => showForm(
      btn.dataset.edit, btn.dataset.macro, btn.dataset.value,
      btn.dataset.type, btn.dataset.desc,
    ));
  });
  el.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete macro "${btn.dataset.macro}"?`)) return;
      try {
        await call('globalmacro.delete', { globalmacroids: [btn.dataset.del] });
        await loadMacros();
      } catch(e) { alert(e.message); }
    });
  });
}

function showForm(macroid = null, macro = '', value = '', type = '0', desc = '') {
  const el = document.getElementById('gm-create-form');
  if (!el) return;
  el.hidden = false;
  const isEdit = !!macroid;
  el.innerHTML = `
    <div class="inline-form" style="max-width:520px">
      <h3>${isEdit ? 'Edit macro' : 'New macro'}</h3>
      <div class="form-grid">
        <label>Macro * <small>(e.g. {$NAME})</small>
          <input id="gmf-macro" value="${esc(macro)}" placeholder="{$MACRO_NAME}">
        </label>
        <label>Type
          <select id="gmf-type">
            ${MACRO_TYPE.map((l,i)=>`<option value="${i}"${parseInt(type)===i?' selected':''}>${l}</option>`).join('')}
          </select>
        </label>
        <label class="form-wide">Value<input id="gmf-value" value="${esc(value)}"></label>
        <label class="form-wide">Description<input id="gmf-desc" value="${esc(desc)}"></label>
      </div>
      <div class="form-actions">
        <button id="gmf-submit">${isEdit ? 'Save' : 'Create'}</button>
        <button id="gmf-cancel">Cancel</button>
        <span id="gmf-error" class="error" hidden></span>
      </div>
    </div>`;

  // Auto-uppercase macro name as you type
  document.getElementById('gmf-macro').addEventListener('input', e => {
    const inp = e.target, pos = inp.selectionStart;
    inp.value = inp.value.toUpperCase();
    inp.setSelectionRange(pos, pos);
  });

  // Toggle value field type based on macro type
  function updateValueField() {
    const t   = parseInt(document.getElementById('gmf-type').value);
    const inp = document.getElementById('gmf-value');
    if (!inp) return;
    if (t === 1) { inp.type = 'password'; inp.placeholder = ''; }
    else if (t === 2) { inp.type = 'text'; inp.placeholder = 'vault:path/to/secret'; }
    else { inp.type = 'text'; inp.placeholder = ''; }
  }
  document.getElementById('gmf-type').addEventListener('change', updateValueField);
  updateValueField();

  document.getElementById('gmf-cancel').onclick = () => { el.hidden = true; el.innerHTML = ''; };
  document.getElementById('gmf-submit').onclick = async () => {
    const errEl = document.getElementById('gmf-error');
    errEl.hidden = true;
    const p = {
      macro:       document.getElementById('gmf-macro').value.trim().toUpperCase(),
      value:       document.getElementById('gmf-value').value,
      type:        parseInt(document.getElementById('gmf-type').value),
      description: document.getElementById('gmf-desc').value.trim(),
    };
    try {
      if (isEdit) { p.globalmacroid = macroid; await call('globalmacro.update', p); }
      else await call('globalmacro.create', p);
      el.hidden = true; el.innerHTML = '';
      await loadMacros();
    } catch(e) {
      errEl.textContent = e.message; errEl.hidden = false;
    }
  };
}
