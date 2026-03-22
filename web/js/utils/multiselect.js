/**
 * Generic chip-based multiselect widget.
 *
 * Usage:
 *   const ms = multiselect(containerEl, items, onChange, { idField, nameField, placeholder });
 *   ms.getIds()      → ['1', '2', ...]
 *   ms.setItems(arr) → replace available list (keeps valid selected items)
 *   ms.reset()       → clear selection
 */
export function multiselect(container, items = [], onChange = null, opts = {}) {
  const { idField = 'id', nameField = 'name', placeholder = 'Add…', selectedIds = [] } = opts;
  const selected = new Map(); // id → name
  let _items = items;

  // pre-populate initial selection
  for (const sid of selectedIds) {
    const item = items.find(x => String(x[idField]) === String(sid));
    if (item) selected.set(String(item[idField]), String(item[nameField]));
  }

  container.classList.add('group-picker');
  render();

  function render() {
    const chips = [...selected.entries()].map(([id, name]) =>
      `<span class="gp-chip" data-id="${esc(id)}">${esc(name)}<button type="button" class="gp-remove" data-id="${esc(id)}">×</button></span>`
    ).join('');

    container.innerHTML = `
      ${chips}
      <span class="gp-input-wrap">
        <input class="gp-input" type="text" placeholder="${esc(placeholder)}" autocomplete="off">
        <ul class="gp-dropdown" hidden></ul>
      </span>
    `;

    container.querySelectorAll('.gp-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selected.delete(btn.dataset.id);
        render();
        onChange?.();
      });
    });

    const input = container.querySelector('.gp-input');
    const dd    = container.querySelector('.gp-dropdown');

    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      const matches = _items.filter(item =>
        !selected.has(String(item[idField])) &&
        String(item[nameField]).toLowerCase().includes(q)
      ).slice(0, 30);
      if (!matches.length) { dd.hidden = true; return; }
      dd.innerHTML = matches.map(item =>
        `<li data-id="${esc(String(item[idField]))}" data-name="${esc(String(item[nameField]))}">${esc(String(item[nameField]))}</li>`
      ).join('');
      dd.hidden = false;
    });

    dd.addEventListener('mousedown', e => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      e.preventDefault();
      selected.set(li.dataset.id, li.dataset.name);
      render();
      container.querySelector('.gp-input')?.focus();
      onChange?.();
    });

    input.addEventListener('blur', () => { setTimeout(() => { dd.hidden = true; }, 150); });
    input.addEventListener('focus', () => { input.dispatchEvent(new Event('input')); });
  }

  return {
    getIds:   () => [...selected.keys()],
    getValue: () => [...selected.entries()].map(([id, name]) => ({ [idField]: id, [nameField]: name })),
    reset() { selected.clear(); render(); onChange?.(); },
    setItems(newItems) {
      _items = newItems;
      // remove selected items no longer in list
      const validIds = new Set(newItems.map(x => String(x[idField])));
      for (const id of [...selected.keys()]) {
        if (!validIds.has(id)) selected.delete(id);
      }
      render();
    },
  };
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
