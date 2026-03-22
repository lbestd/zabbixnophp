/**
 * Tag filter widget — multi-row tag conditions with And/Or evaltype.
 * Usage:
 *   const tf = tagFilter(containerEl, onChange);
 *   tf.matches(itemTags) → bool          (client-side)
 *   tf.getApiParams()    → {tags, evaltype}  (server-side via problem.get)
 */

const TAG_OPS = [
  { value: '0', label: 'Contains' },
  { value: '1', label: 'Equals' },
  { value: '4', label: 'Exists' },
  { value: '5', label: 'Does not exist' },
  { value: '2', label: 'Does not contain' },
  { value: '3', label: 'Does not equal' },
];

function e(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function tagFilter(containerEl, onChange) {
  let rows = [];
  let evaltype = 0; // 0=And/Or, 2=Or

  function render() {
    containerEl.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:0.85rem;color:var(--muted);white-space:nowrap">Tags</span>
        <select id="tfw-eval" style="width:80px">
          <option value="0">And/Or</option>
          <option value="2">Or</option>
        </select>
        <button type="button" id="tfw-add" class="btn-small">+ Add</button>
        <div id="tfw-rows" style="display:flex;flex-direction:column;gap:3px;margin-top:2px;width:100%"></div>
      </div>`;

    containerEl.querySelector('#tfw-eval').addEventListener('change', ev => {
      evaltype = parseInt(ev.target.value);
      if (onChange) onChange();
    });
    containerEl.querySelector('#tfw-add').addEventListener('click', () => {
      rows.push({ tag: '', operator: '0', value: '' });
      renderRows();
      if (onChange) onChange();
    });
    renderRows();
  }

  function renderRows() {
    const el = containerEl.querySelector('#tfw-rows');
    if (!el) return;
    if (!rows.length) { el.innerHTML = ''; return; }
    el.innerHTML = rows.map((r, i) => {
      const hideVal = r.operator === '4' || r.operator === '5';
      return `
        <div style="display:flex;gap:4px;align-items:center">
          <input class="tfw-tag" data-idx="${i}" value="${e(r.tag)}" placeholder="tag" style="width:110px">
          <select class="tfw-op" data-idx="${i}">
            ${TAG_OPS.map(o => `<option value="${o.value}"${r.operator===o.value?' selected':''}>${o.label}</option>`).join('')}
          </select>
          <input class="tfw-val" data-idx="${i}" value="${e(r.value)}" placeholder="value"
                 style="width:110px${hideVal?';display:none':''}">
          <button type="button" class="btn-small btn-danger tfw-rem" data-idx="${i}">×</button>
        </div>`;
    }).join('');

    el.querySelectorAll('.tfw-tag').forEach(inp =>
      inp.addEventListener('input', () => { rows[+inp.dataset.idx].tag = inp.value; if (onChange) onChange(); }));
    el.querySelectorAll('.tfw-op').forEach(sel =>
      sel.addEventListener('change', () => {
        const idx = +sel.dataset.idx;
        rows[idx].operator = sel.value;
        const v = el.querySelector(`.tfw-val[data-idx="${idx}"]`);
        if (v) v.style.display = (sel.value === '4' || sel.value === '5') ? 'none' : '';
        if (onChange) onChange();
      }));
    el.querySelectorAll('.tfw-val').forEach(inp =>
      inp.addEventListener('input', () => { rows[+inp.dataset.idx].value = inp.value; if (onChange) onChange(); }));
    el.querySelectorAll('.tfw-rem').forEach(btn =>
      btn.addEventListener('click', () => {
        rows.splice(+btn.dataset.idx, 1); renderRows(); if (onChange) onChange();
      }));
  }

  function matchRow(f, itemTags) {
    const fTag = f.tag.toLowerCase();
    const fVal = f.value.toLowerCase();
    const op   = f.operator;

    if (op === '5') {
      return !itemTags.some(t => !fTag || t.tag.toLowerCase().includes(fTag));
    }
    return itemTags.some(t => {
      const tTag = t.tag.toLowerCase();
      if (fTag && !tTag.includes(fTag)) return false;
      const tVal = (t.value || '').toLowerCase();
      if (op === '4') return true;
      if (op === '0') return tVal.includes(fVal);
      if (op === '1') return tVal === fVal;
      if (op === '2') return !tVal.includes(fVal);
      if (op === '3') return tVal !== fVal;
      return true;
    });
  }

  render();

  return {
    isEmpty: () => rows.length === 0,

    reset() { rows = []; evaltype = 0; render(); if (onChange) onChange(); },

    matches(itemTags) {
      if (!rows.length) return true;
      const results = rows.map(f => matchRow(f, itemTags));
      return evaltype === 2 ? results.some(Boolean) : results.every(Boolean);
    },

    // For server-side: problem.get tags param
    getApiParams() {
      if (!rows.length) return {};
      return {
        evaltype,
        tags: rows
          .filter(r => r.tag.trim() || r.operator === '4' || r.operator === '5')
          .map(r => ({ tag: r.tag, value: r.value, operator: parseInt(r.operator) })),
      };
    },
  };
}
