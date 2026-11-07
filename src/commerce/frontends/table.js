let tableState = {
  search: '',
  country: '',
  status: 'all',
  sort: 'date',
  offset: 0,
};
let tableSequence = 0;
async function renderTable() {
  const sequence = ++tableSequence;
  try {
    const [summary, page] = await Promise.all([
      fluid.call('orders.summary'),
      fluid.call('orders.list', {
        search: tableState.search,
        ...(tableState.country ? { country: tableState.country } : {}),
        reviewStatus: tableState.status,
        sort: tableState.sort,
        offset: tableState.offset,
        limit: 20,
      }),
    ]);
    if (sequence !== tableSequence) return;
    const focused = document.activeElement?.id;
    const selection =
      focused === 'order-search' ? document.activeElement.selectionStart : null;
    root.innerHTML = `<header class="view-intro"><div><div class="eyebrow">EVERY ORDER. THE FULL PICTURE.</div><h1>The order desk<span>.</span></h1><p>A little order for all the moving parts.</p></div><span class="view-stamp">${icon('receipt')} TABLE VIEW</span></header><div class="metrics"><section><span>Recorded sales</span><strong>${money(summary.salesPence)}</strong><small>Before ${money(Math.abs(summary.cancellationsPence))} in cancellations</small></section><section><span>Source invoices</span><strong>${number(summary.orders)}<em>across ${summary.countries.length} countries</em></strong><small>${number(summary.lineItems)} original line items</small></section><section class="metric-warm"><span>Suggested reviews</span><strong>${summary.openReviews + summary.inProgressReviews}<em>still to look at</em></strong><small>${summary.resolvedReviews} reviewed across every interface</small></section></div><div class="table-toolbar"><div class="filter-tabs" role="tablist" aria-label="Review filter">${[
      ['all', 'All orders'],
      ['active', 'To review'],
      ['resolved', 'Reviewed'],
    ]
      .map(
        ([id, label]) =>
          `<button role="tab" aria-selected="${tableState.status === id}" data-status="${id}" class="${tableState.status === id ? 'selected' : ''}">${label}${id === 'all' ? `<span>${summary.orders}</span>` : ''}</button>`,
      )
      .join(
        '',
      )}</div><label class="search-box">${icon('search')}<input id="order-search" aria-label="Search orders" placeholder="Find an order, product, country…" value="${esc(tableState.search)}"></label><select id="country-filter" aria-label="Filter orders by country"><option value="">All countries</option>${summary.countries.map((country) => `<option ${tableState.country === country ? 'selected' : ''}>${esc(country)}</option>`).join('')}</select><select id="order-sort" aria-label="Sort orders"><option value="date" ${tableState.sort === 'date' ? 'selected' : ''}>Newest first</option><option value="value" ${tableState.sort === 'value' ? 'selected' : ''}>Largest value</option><option value="priority" ${tableState.sort === 'priority' ? 'selected' : ''}>Review priority</option></select></div><div class="order-table-wrap"><table class="order-table"><thead><tr><th>Invoice / order</th><th>Customer</th><th>Country</th><th>Source date</th><th class="numeric">Recorded value</th><th>Shared review</th><th></th></tr></thead><tbody>${page.orders.map((o) => `<tr data-order="${esc(o.id)}" data-review-status="${esc(o.review.status)}"><td><button class="order-id" data-open="${esc(o.id)}">#${esc(o.id)}</button><small>${esc(o.preview.toLowerCase())}${o.lineCount ? ` · ${o.lineCount} lines` : ''}</small></td><td class="muted">${esc(o.customerId || 'Not recorded')}</td><td>${esc(o.country)}</td><td class="muted">${date(o.date)}</td><td class="numeric ${o.netPence < 0 ? 'negative' : ''}">${money(o.netPence)}${o.kind === 'cancellation' ? '<small>Cancellation</small>' : ''}</td><td>${statusBadge(o)}</td><td><button class="icon-button" aria-label="Open invoice ${esc(o.id)}" data-open="${esc(o.id)}">${icon('arrow')}</button></td></tr>`).join('')}</tbody></table>${!page.orders.length ? '<div class="empty-state">No invoices match. Try another search or filter.</div>' : ''}</div><footer class="table-footer"><span>${page.total ? `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)}` : '0'} of ${number(page.total)} invoices</span><span class="historical">Historical source · ${date(summary.source.periodStart)}–${fullDate(summary.source.periodEnd)}</span><div><button class="button small" id="previous-page" ${page.offset === 0 ? 'disabled' : ''}>Previous</button><button class="button small" id="next-page" ${page.offset + page.limit >= page.total ? 'disabled' : ''}>Next ${icon('arrow')}</button></div></footer>`;
    root
      .querySelectorAll('[data-open]')
      .forEach(
        (button) =>
          (button.onclick = () => openOrder(button.dataset.open, true)),
      );
    root.querySelectorAll('[data-status]').forEach(
      (button) =>
        (button.onclick = () => {
          tableState.status = button.dataset.status;
          tableState.offset = 0;
          void renderTable();
        }),
    );
    let debounce;
    root.querySelector('#order-search').oninput = (event) => {
      tableState.search = event.target.value;
      tableState.offset = 0;
      clearTimeout(debounce);
      debounce = setTimeout(renderTable, 180);
    };
    root.querySelector('#country-filter').onchange = (event) => {
      tableState.country = event.target.value;
      tableState.offset = 0;
      void renderTable();
    };
    root.querySelector('#order-sort').onchange = (event) => {
      tableState.sort = event.target.value;
      tableState.offset = 0;
      void renderTable();
    };
    root.querySelector('#previous-page').onclick = () => {
      tableState.offset = Math.max(0, tableState.offset - page.limit);
      void renderTable();
    };
    root.querySelector('#next-page').onclick = () => {
      tableState.offset += page.limit;
      void renderTable();
    };
    if (focused === 'order-search') {
      const input = root.querySelector('#order-search');
      input.focus();
      input.setSelectionRange(selection, selection);
    }
  } catch (error) {
    root.innerHTML = `<div class="error-state" role="alert">${esc(error.message)}</div>`;
  }
}
refreshView = renderTable;
void renderTable();
