/* These renderers have no data source of their own: every record comes from Fluid. */
const root = document.getElementById('commerce');
const overlay = document.getElementById('overlay');
const money = (pence) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(
    pence / 100,
  );
const number = (value) => new Intl.NumberFormat('en-GB').format(value);
const date = (value) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
    new Date(value),
  );
const fullDate = (value) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const icon = (name) => {
  const paths = {
    arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    receipt:
      '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z"/><path d="M8 8h8m-8 4h8m-8 4h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    return: '<path d="M8 5 3 10l5 5m-5-5h12a6 6 0 0 1 0 12"/>',
  };
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.receipt}</svg>`;
};
const statusLabel = (order) =>
  !order.reasons.length
    ? 'No review needed'
    : { open: 'To review', 'in-progress': 'In progress', resolved: 'Reviewed' }[
        order.review.status
      ];
const statusBadge = (order) =>
  `<span class="status ${!order.reasons.length ? 'clear' : order.review.status}"><i></i>${esc(statusLabel(order))}</span>`;
let toastTimer;
function toast(value) {
  const target = document.getElementById('toast');
  target.textContent = value;
  target.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (target.className = ''), 4500);
}
let refreshView = async () => {};
let currentDetail;
async function updateReview(order, status, note) {
  try {
    await fluid.call('reviews.update', {
      id: order.id,
      status,
      expectedVersion: order.review.version,
      ...(note === undefined ? {} : { note }),
    });
    toast(
      status === 'resolved'
        ? `Invoice ${order.id} reviewed. Every view is updated.`
        : `Invoice ${order.id} updated for everyone.`,
    );
    await refreshView();
    return true;
  } catch (error) {
    toast(error.message);
    await refreshView();
    return false;
  }
}
async function openOrder(id, focus = false) {
  try {
    const detail = await fluid.call('orders.get', { id });
    currentDetail = id;
    const o = detail.order;
    overlay.innerHTML = `<div class="drawer-backdrop"><section class="order-drawer" role="dialog" aria-modal="true" aria-label="Invoice ${esc(o.id)}"><div class="drawer-top"><span class="eyebrow">THE RECORD BEHIND THE TASK</span><button aria-label="Close invoice" class="icon-button" id="close-detail">${icon('close')}</button></div><div class="drawer-title"><div><h2>Invoice #${esc(o.id)}</h2><p>${esc(o.country)} · ${fullDate(o.date)} · ${o.lineCount} source lines</p></div><strong class="amount ${o.netPence < 0 ? 'negative' : ''}">${money(o.netPence)}</strong></div><div class="record-meta"><span>Customer <b>${esc(o.customerId || 'Not recorded')}</b></span>${statusBadge(o)}</div>${o.reasons.length ? `<div class="review-reasons">${o.reasons.map((r) => `<div><b>${esc(r.title)}</b><p>${esc(r.detail)}</p></div>`).join('')}</div><label class="note-label">Shared review note<textarea id="review-note" rows="3" maxlength="2000" placeholder="Leave context for the next person…">${esc(o.review.note)}</textarea></label><div class="review-actions"><button class="button" id="save-note">Save note</button><button class="button" id="start-review">${o.review.status === 'in-progress' ? 'Reopen' : 'Start review'}</button><button class="button primary" id="resolve-review">${icon('check')} ${o.review.status === 'resolved' ? 'Reopen review' : 'Mark reviewed'}</button></div><p class="last-update">${o.review.lastActor ? `Last changed by ${esc(o.review.lastActor)} · revision ${o.review.version}` : 'Review workflow added by this demo. Original transaction is unchanged.'}</p>` : `<p class="all-clear">No review rule matched this invoice.</p>`}<div class="lines-heading"><h3>Original line items</h3><span>GBP · immutable source records</span></div><div class="line-items">${detail.items.map((item) => `<div class="source-line"><div><b>${esc(item.description || 'Unlabelled item')}</b><small>SKU ${esc(item.stockCode)} · spreadsheet row ${item.sourceRow}</small></div><span>${number(item.quantity)} × ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 4 }).format(item.unitPriceMicros / 1000000)}</span><strong class="${item.linePence < 0 ? 'negative' : ''}">${money(item.linePence)}</strong></div>`).join('')}</div><footer class="source-footnote">Source: UCI Online Retail · Daqing Chen · CC BY 4.0<br>Recorded transaction date, quantities and values are preserved. No refund or customer message is sent.</footer></section></div>`;
    overlay.querySelector('#close-detail').onclick = closeOrder;
    overlay.querySelector('.drawer-backdrop').onclick = (event) => {
      if (event.target.className === 'drawer-backdrop') closeOrder();
    };
    if (o.reasons.length) {
      const save = async (status) => {
        const note = overlay.querySelector('#review-note').value;
        overlay
          .querySelectorAll('.review-actions button')
          .forEach((b) => (b.disabled = true));
        const saved = await updateReview(o, status, note);
        currentDetail = undefined;
        await openOrder(id);
        if (!saved && overlay.querySelector('#review-note'))
          overlay.querySelector('#review-note').value = note;
      };
      overlay.querySelector('#save-note').onclick = () => save(o.review.status);
      overlay.querySelector('#start-review').onclick = () =>
        save(o.review.status === 'in-progress' ? 'open' : 'in-progress');
      overlay.querySelector('#resolve-review').onclick = () =>
        save(o.review.status === 'resolved' ? 'open' : 'resolved');
    }
    if (focus) overlay.querySelector('#close-detail').focus();
  } catch (error) {
    toast(error.message);
  }
}
function closeOrder() {
  currentDetail = undefined;
  overlay.replaceChildren();
}
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeOrder();
});
let pendingRefresh = false;
fluid.subscribe(() => {
  if (pendingRefresh) return;
  pendingRefresh = true;
  setTimeout(async () => {
    pendingRefresh = false;
    await refreshView();
  }, 25);
});
