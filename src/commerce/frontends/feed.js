let feedState = { status: 'active', country: '', search: '', offset: 0 };
let feedSequence = 0;
async function renderFeed() {
  const sequence = ++feedSequence;
  try {
    const [summary, page] = await Promise.all([
      fluid.call('orders.summary'),
      fluid.call('orders.list', {
        needsReview: true,
        reviewStatus: feedState.status,
        sort: 'priority',
        offset: feedState.offset,
        limit: 12,
        search: feedState.search,
        ...(feedState.country ? { country: feedState.country } : {}),
      }),
    ]);
    if (sequence !== feedSequence) return;
    root.innerHTML = `<div class="feed-layout"><div class="feed-main"><header class="view-intro"><div><div class="eyebrow">LESS SCANNING. MORE DOING.</div><h1>A little forward motion<span>.</span></h1><p>Same orders. Just the things worth a closer look.</p></div></header><div class="feed-summary"><div class="feed-count">${summary.openReviews + summary.inProgressReviews}<span>suggested reviews left</span></div><div class="review-progress"><span>${summary.resolvedReviews} of ${summary.needsReview} reviewed</span><div><i style="width:${summary.needsReview ? (summary.resolvedReviews / summary.needsReview) * 100 : 0}%"></i></div></div></div><div class="feed-toolbar"><div class="filter-tabs" role="tablist" aria-label="Feed filter">${[
      ['active', 'Up next'],
      ['in-progress', 'In progress'],
      ['resolved', 'Reviewed'],
    ]
      .map(
        ([id, label]) =>
          `<button role="tab" aria-selected="${feedState.status === id}" data-status="${id}" class="${feedState.status === id ? 'selected' : ''}">${label}</button>`,
      )
      .join(
        '',
      )}</div><select id="feed-country" aria-label="Filter feed by country"><option value="">Every country</option>${summary.countries.map((country) => `<option ${feedState.country === country ? 'selected' : ''}>${esc(country)}</option>`).join('')}</select></div><div class="action-feed">${page.orders
      .map((o) => {
        const r = o.reasons[0];
        return `<article class="action-card ${esc(r.code)}" data-order="${esc(o.id)}" data-review-status="${esc(o.review.status)}"><div class="action-symbol">${icon(r.code === 'cancellation' ? 'return' : 'receipt')}</div><div class="action-content"><div class="action-label"><span>${esc(r.code === 'cancellation' ? 'CREDIT NOTE' : r.code === 'pricing' ? 'PRICING EXCEPTION' : r.code === 'missing-customer' ? 'CUSTOMER REFERENCE' : 'LARGE ORDER')}</span>${statusBadge(o)}</div><h2>${esc(r.title)}</h2><p>${r.code === 'cancellation' ? `A recorded cancellation for ${money(Math.abs(o.netPence))}. Check the source lines and reconcile the credit.` : r.code === 'missing-customer' ? 'This invoice has no customer ID in the original data. Check the reference before using it in customer reporting.' : r.code === 'pricing' ? 'A line has a zero or negative unit price. Take a closer look before counting it as a normal sale.' : `An invoice worth ${money(o.netPence)} meets the demo’s £1,000 review threshold.`}</p><button class="linked-invoice" data-open="${esc(o.id)}">${icon('receipt')} Invoice #${esc(o.id)} <span>· ${esc(o.country)} · ${o.lineCount} lines</span> ${icon('arrow')}</button>${o.review.note ? `<blockquote>${esc(o.review.note)}</blockquote>` : ''}<div class="action-bottom"><span>${fullDate(o.date)}${o.reasons.length > 1 ? ` · +${o.reasons.length - 1} other reason${o.reasons.length > 2 ? 's' : ''}` : ''}</span><div><button class="button" data-open="${esc(o.id)}">View record</button><button class="button primary" data-resolve="${esc(o.id)}">${icon('check')} ${o.review.status === 'resolved' ? 'Reopen' : 'Mark reviewed'}</button></div></div></div></article>`;
      })
      .join(
        '',
      )}${!page.orders.length ? '<div class="empty-state"><b>A little breathing room.</b><p>No reviews in this view. Try another filter.</p></div>' : ''}</div><footer class="table-footer"><span>${page.total ? page.offset + 1 : 0}–${Math.min(page.offset + page.limit, page.total)} of ${page.total} suggested reviews</span><div><button class="button small" id="feed-prev" ${page.offset === 0 ? 'disabled' : ''}>Previous</button><button class="button small" id="feed-next" ${page.offset + page.limit >= page.total ? 'disabled' : ''}>Next ${icon('arrow')}</button></div></footer></div><aside class="feed-sidebar"><span class="eyebrow">A DIFFERENT WAY IN</span><h2>Your work.<br>A little clearer.</h2><p>These aren’t a second set of tasks. Each card points straight to an invoice in the order desk.</p><div class="sidebar-proof">${icon('check')} Same underlying records<br>${icon('check')} Same read and review access<br>${icon('check')} Changes shared across views</div><div class="sidebar-policy"><b>Suggested, not assumed.</b><p>Simple rules suggest reviews of historical transactions. Marking one reviewed adds a demo workflow status; the source stays intact.</p></div><small>Real source data<br>UCI Online Retail · CC BY 4.0<br>${date(summary.source.periodStart)}–${fullDate(summary.source.periodEnd)}</small></aside></div>`;
    root
      .querySelectorAll('[data-open]')
      .forEach(
        (button) =>
          (button.onclick = () => openOrder(button.dataset.open, true)),
      );
    root.querySelectorAll('[data-status]').forEach(
      (button) =>
        (button.onclick = () => {
          feedState.status = button.dataset.status;
          feedState.offset = 0;
          void renderFeed();
        }),
    );
    root.querySelectorAll('[data-resolve]').forEach(
      (button) =>
        (button.onclick = async () => {
          button.disabled = true;
          const order = page.orders.find(
            (o) => o.id === button.dataset.resolve,
          );
          await updateReview(
            order,
            order.review.status === 'resolved' ? 'open' : 'resolved',
          );
        }),
    );
    root.querySelector('#feed-country').onchange = (event) => {
      feedState.country = event.target.value;
      feedState.offset = 0;
      void renderFeed();
    };
    root.querySelector('#feed-prev').onclick = () => {
      feedState.offset = Math.max(0, feedState.offset - page.limit);
      void renderFeed();
    };
    root.querySelector('#feed-next').onclick = () => {
      feedState.offset += page.limit;
      void renderFeed();
    };
  } catch (error) {
    root.innerHTML = `<div class="error-state" role="alert">${esc(error.message)}</div>`;
  }
}
refreshView = renderFeed;
void renderFeed();
