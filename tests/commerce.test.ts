import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHost } from '../src/core/host';
import { fileStorage } from '../src/core/storage';
import {
  APP_ID,
  PROTOCOL_VERSION,
  type Frontend,
  type CommerceSummary,
  type RetailOrderDetail,
  type RetailOrderPage,
} from '../src/protocol/index';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Source-free test artifacts exercise the real native host, not a renderer mock.
const frontends: Frontend[] = [
  ['commerce-table', 'Order desk'],
  ['commerce-feed', 'Action feed'],
].map(([id, name]) => ({
  id,
  name,
  description: '',
  author: 'Test',
  html: '<h1>Commerce client</h1>',
  appId: APP_ID,
  protocol: PROTOCOL_VERSION,
  permissions: ['orders:read', 'reviews:write'],
  version: 1,
  builtin: true,
  updatedAt: '',
}));
const options = { frontends, tasks: [] };
async function setup(t: TestContext) {
  const host = await createHost(options);
  t.after(() => host.close());
  return {
    host,
    table: await host.openSession('commerce-table'),
    feed: await host.openSession('commerce-feed'),
  };
}
test('commerce: real invoice lines reconcile to exact totals with original source lineage', async (t) => {
  const { host, table } = await setup(t);
  const summary = (await host.call(table, 'orders.summary')) as CommerceSummary;
  assert.equal(summary.source.fullLineCount, 541909);
  assert.equal(summary.lineItems, 9735);
  assert.equal(summary.orders, 500);
  assert.equal(summary.source.license, 'CC BY 4.0');
  assert.equal(
    summary.netPence,
    summary.salesPence + summary.cancellationsPence,
  );
  assert.equal(
    summary.source.workbookSha256,
    '43465a06f2ccf7c8b5bd2892bc7defb52f97487934fe93b16ae4c3936424676d',
  );
  const detail = (await host.call(table, 'orders.get', {
    id: '536365',
  })) as RetailOrderDetail;
  assert.equal(detail.order.lineCount, 7);
  assert.equal(detail.order.netPence, 13912);
  assert.equal(detail.order.units, 40);
  assert.equal(detail.items[0].sourceRow, 2);
  assert.equal(detail.items[0].linePence, 1530);
  const credit = (await host.call(table, 'orders.get', {
    id: 'C536379',
  })) as RetailOrderDetail;
  assert.equal(credit.order.netPence, -2750);
  assert.equal(credit.order.kind, 'cancellation');
  assert.ok(credit.order.reasons.some((r) => r.code === 'cancellation'));
  let sum = 0,
    invoices = 0;
  for (let offset = 0; offset < 500; offset += 100) {
    const page = (await host.call(table, 'orders.list', {
      limit: 100,
      offset,
    })) as RetailOrderPage;
    invoices += page.orders.length;
    sum += page.orders.reduce((n, o) => n + o.netPence, 0);
  }
  assert.equal(invoices, 500);
  assert.equal(sum, summary.netPence);
});
test('commerce: table and feed share review state while historical source stays unchanged', async (t) => {
  const { host, table, feed } = await setup(t);
  const before = (await host.call(table, 'orders.get', {
    id: 'C536379',
  })) as RetailOrderDetail;
  const originalSummary = (await host.call(
    table,
    'orders.summary',
  )) as CommerceSummary;
  const revision = (await host.snapshot()).revision;
  await host.call(feed, 'reviews.update', {
    id: before.order.id,
    status: 'resolved',
    expectedVersion: 0,
    note: 'Checked against the original credit note.',
  });
  const after = (await host.call(table, 'orders.get', {
    id: before.order.id,
  })) as RetailOrderDetail;
  assert.deepEqual(after.items, before.items);
  assert.equal(after.order.netPence, before.order.netPence);
  assert.equal(after.order.review.status, 'resolved');
  assert.equal(
    after.order.review.note,
    'Checked against the original credit note.',
  );
  assert.equal(after.order.review.lastActor, 'Action feed');
  const active = (await host.call(feed, 'orders.list', {
    reviewStatus: 'active',
    search: before.order.id,
  })) as RetailOrderPage;
  assert.equal(active.total, 0);
  const summary = (await host.call(table, 'orders.summary')) as CommerceSummary;
  assert.equal(summary.resolvedReviews, originalSummary.resolvedReviews + 1);
  assert.equal(summary.netPence, originalSummary.netPence);
  assert.equal((await host.snapshot()).revision, revision + 1);
});
test('commerce: concurrent clients cannot overwrite a newer review', async (t) => {
  const { host, table, feed } = await setup(t);
  const updates = await Promise.allSettled([
    host.call(table, 'reviews.update', {
      id: 'C536379',
      status: 'in-progress',
      expectedVersion: 0,
    }),
    host.call(feed, 'reviews.update', {
      id: 'C536379',
      status: 'resolved',
      expectedVersion: 0,
    }),
  ]);
  assert.equal(updates.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    (updates.find((r) => r.status === 'rejected') as PromiseRejectedResult)
      .reason.code,
    'VERSION_CONFLICT',
  );
});
test('commerce: live permissions govern data and review writes independently', async (t) => {
  const { host, table, feed } = await setup(t);
  await host.setGrants('commerce-feed', ['orders:read']);
  assert.equal(
    (await host.inspect('commerce-feed')).tools.find(
      (t) => t.name === 'reviews.update',
    )?.exposed,
    false,
  );
  await assert.rejects(
    host.call(feed, 'reviews.update', {
      id: 'C536379',
      status: 'resolved',
      expectedVersion: 0,
    }),
    { code: 'PERMISSION_DENIED' },
  );
  await host.call(table, 'reviews.update', {
    id: 'C536379',
    status: 'resolved',
    expectedVersion: 0,
  });
  await host.setGrants('commerce-feed', []);
  await assert.rejects(host.call(feed, 'orders.list'), {
    code: 'PERMISSION_DENIED',
  });
  await assert.rejects(host.call(table, 'orders.list', { limit: 101 }), {
    code: 'INVALID_INPUT',
  });
});
test('commerce: review overlay survives a database restart without reimporting over it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-commerce-'));
  const settings = {
    ...options,
    storage: fileStorage(join(directory, 'workspace.json')),
  };
  const first = await createHost(settings);
  await first.call(await first.openSession('commerce-feed'), 'reviews.update', {
    id: 'C536379',
    status: 'in-progress',
    expectedVersion: 0,
    note: 'Continue this review.',
  });
  await first.close();
  const second = await createHost(settings);
  t.after(async () => {
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const detail = (await second.call(
    await second.openSession('commerce-table'),
    'orders.get',
    { id: 'C536379' },
  )) as RetailOrderDetail;
  assert.equal(detail.order.review.version, 1);
  assert.equal(detail.order.review.note, 'Continue this review.');
});
test('commerce: an independent standard MCP client uses exactly the same commerce records', async (t) => {
  const { host, table } = await setup(t);
  await host.setAgent(true, ['orders:read', 'reviews:write']);
  const connection = host.connection();
  const client = new Client({ name: 'commerce-agent', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(
    tools.sort(),
    [
      'workspace.describe',
      'tools.inspect',
      'orders.list',
      'orders.get',
      'orders.summary',
      'reviews.update',
    ].sort(),
  );
  const result = await client.callTool({
    name: 'reviews.update',
    arguments: {
      id: 'C536379',
      status: 'resolved',
      expectedVersion: 0,
      note: 'Reviewed by a connected agent.',
    },
  });
  assert.notEqual(result.isError, true);
  const detail = (await host.call(table, 'orders.get', {
    id: 'C536379',
  })) as RetailOrderDetail;
  assert.equal(detail.order.review.status, 'resolved');
});
