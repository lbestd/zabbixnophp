/**
 * Simple page-based pagination helper.
 *
 * Usage:
 *   const pager = pagination({ pageSize: 100, onPage: loadData });
 *   pager.render(containerEl);   // renders controls into container
 *   pager.setTotal(count);       // call after knowing total count
 *   pager.current()              // current 0-based offset
 *   pager.reset()                // go back to page 0
 */

export function pagination({ pageSize = 100, onPage } = {}) {
  let _page   = 0;
  let _total  = null;  // null = unknown
  let _el     = null;

  function pages() {
    return _total != null ? Math.ceil(_total / pageSize) : null;
  }

  function render(el) {
    _el = el;
    update();
  }

  function update() {
    if (!_el) return;
    const totalPages = pages();
    const from  = _page * pageSize + 1;
    const to    = _total != null
      ? Math.min((_page + 1) * pageSize, _total)
      : (_page + 1) * pageSize;
    const info  = _total != null
      ? `${from}–${to} of ${_total}`
      : `${from}–${to}`;

    _el.innerHTML = `
      <div class="pagination">
        <button class="pg-prev btn-small" ${_page === 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="pg-info muted" style="font-size:0.85rem">${info}</span>
        <button class="pg-next btn-small" ${totalPages != null && _page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
      </div>`;

    _el.querySelector('.pg-prev').addEventListener('click', () => { _page--; onPage(); update(); });
    _el.querySelector('.pg-next').addEventListener('click', () => { _page++; onPage(); update(); });
  }

  return {
    render,
    setTotal(n) { _total = n; update(); },
    current() { return _page * pageSize; },
    pageSize,
    reset() { _page = 0; update(); },
    update,
  };
}
