/**
 * Chip-based group picker.
 * Usage:
 *   const picker = groupPicker(containerEl, allGroups, selectedGroupIds);
 *   picker.getValue() → [{groupid: "123"}, ...]
 */
export function groupPicker(container, allGroups, selectedIds = []) {
  const selected = new Map(); // groupid → name
  selectedIds.forEach(id => {
    const g = allGroups.find(x => String(x.groupid) === String(id));
    if (g) selected.set(String(g.groupid), g.name);
  });

  container.classList.add('group-picker');
  render();

  function render() {
    const chips = [...selected.entries()].map(([id, name]) =>
      `<span class="gp-chip" data-id="${id}">${escHtml(name)}<button type="button" class="gp-remove" data-id="${id}">×</button></span>`
    ).join('');

    container.innerHTML = `
      ${chips}
      <span class="gp-input-wrap">
        <input class="gp-input" type="text" placeholder="Add group…" autocomplete="off">
        <ul class="gp-dropdown" hidden></ul>
      </span>
    `;

    container.querySelectorAll('.gp-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selected.delete(btn.dataset.id);
        render();
      });
    });

    const input = container.querySelector('.gp-input');
    const dd    = container.querySelector('.gp-dropdown');

    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      const matches = allGroups.filter(g =>
        !selected.has(String(g.groupid)) &&
        g.name.toLowerCase().includes(q)
      ).slice(0, 20);
      if (!matches.length || !q) { dd.hidden = true; return; }
      dd.innerHTML = matches.map(g =>
        `<li data-id="${g.groupid}" data-name="${escHtml(g.name)}">${escHtml(g.name)}</li>`
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
    });

    input.addEventListener('blur', () => { setTimeout(() => { dd.hidden = true; }, 150); });
    input.addEventListener('focus', () => { if (input.value) input.dispatchEvent(new Event('input')); });
  }

  return {
    getValue: () => [...selected.keys()].map(id => ({ groupid: id })),
    getIds:   () => [...selected.keys()],
  };
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
