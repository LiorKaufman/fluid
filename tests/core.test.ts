import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHost, type Host, type Storage } from '../src/core/host';
import { fileStorage } from '../src/core/storage';
import { seedTasks } from '../src/core/seed';
import {
  APP_ID,
  PROTOCOL_VERSION,
  type Frontend,
  type Task,
} from '../src/protocol/index';
import { httpHandler } from '../src/core/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const frontends: Frontend[] = ['default', 'board'].map((id) => ({
  id,
  name: id,
  author: 'Test',
  description: '',
  protocol: PROTOCOL_VERSION,
  appId: APP_ID,
  version: 1,
  builtin: true,
  permissions: ['tasks:read', 'tasks:write', 'tasks:delete'],
  html: '<h1>Test</h1>',
  updatedAt: new Date().toISOString(),
}));
async function fixture(t: TestContext, storage?: Storage) {
  const host = await createHost({ frontends, tasks: seedTasks(), storage });
  t.after(() => host.close());
  return { host, session: await host.openSession('default') };
}
const list = async (host: Host, session: string) =>
  ((await host.call(session, 'tasks.list')) as { tasks: Task[] }).tasks;
test('Rust: two interfaces share data, queries, completion, and independent grants', async (t) => {
  const { host, session } = await fixture(t);
  const other = await host.openSession('board');
  const task = (await host.call(session, 'tasks.create', {
    title: 'Shared café work',
  })) as Task;
  assert.equal(
    (await list(host, other)).find((t) => t.id === task.id)?.status,
    'todo',
  );
  await host.call(other, 'tasks.update', { id: task.id, status: 'done' });
  assert.equal(
    (await list(host, session)).find((t) => t.id === task.id)?.status,
    'done',
  );
  assert.equal(
    (
      (await host.call(session, 'tasks.list', {
        search: 'CAFÉ',
        status: 'done',
      })) as { tasks: Task[] }
    ).tasks.length,
    1,
  );
  assert.equal((await host.snapshot()).runtime.engine, 'Rust');
});
test('Rust: live revocation and separate delete grants cannot be bypassed', async (t) => {
  const { host, session } = await fixture(t);
  const id = (await list(host, session))[0].id;
  await host.setGrants('default', ['tasks:read']);
  await assert.rejects(
    host.call(session, 'tasks.update', { id, status: 'done' }),
    { code: 'PERMISSION_DENIED' },
  );
  await assert.rejects(host.call(session, 'tasks.delete', { id }), {
    code: 'PERMISSION_DENIED',
  });
  assert.equal((await list(host, session))[0].status, 'in-progress');
  await host.setGrants('default', []);
  await assert.rejects(host.call(session, 'tasks.list'), {
    code: 'PERMISSION_DENIED',
  });
  assert.equal(
    ((await host.call(session, 'workspace.describe')) as { appId: string })
      .appId,
    APP_ID,
  );
  assert.equal(
    (await host.inspect('default')).tools.find(
      (tool) => tool.name === 'tasks.list',
    )?.exposed,
    false,
  );
});
test('Rust: schema and business validation reject invalid mutations', async (t) => {
  const { host, session } = await fixture(t);
  const before = (await list(host, session)).length;
  for (const input of [
    { title: '' },
    { title: '   ' },
    { title: 'Invalid', status: 'unknown' },
    { title: 'Invalid', dueDate: '2026-02-30' },
    { title: 'Invalid', owner: 'admin' },
    { title: 'x'.repeat(241) },
  ])
    await assert.rejects(host.call(session, 'tasks.create', input), {
      code: 'INVALID_INPUT',
    });
  await assert.rejects(
    host.call(session, 'tasks.update', { id: 'missing', title: 'No' }),
    { code: 'NOT_FOUND' },
  );
  await assert.rejects(host.call(session, 'filesystem.read'), {
    code: 'UNKNOWN_CAPABILITY',
  });
  assert.equal((await list(host, session)).length, before);
});
test('Rust: imported artifacts cannot grant themselves access and revisions invalidate old sessions', async (t) => {
  const { host } = await fixture(t);
  const artifact = {
    ...frontends[0],
    id: 'custom',
    builtin: true,
    grants: ['tasks:delete'],
  };
  const installed = await host.install(artifact);
  assert.equal(installed.builtin, undefined);
  assert.deepEqual((await host.snapshot()).grants.custom, []);
  await assert.rejects(
    host.call(await host.openSession('custom'), 'tasks.list'),
    { code: 'PERMISSION_DENIED' },
  );
  await assert.rejects(host.install(frontends[0]), {
    code: 'BUILTIN_FRONTEND',
  });
  await assert.rejects(host.install({ ...artifact, appId: 'different.app' }), {
    code: 'INCOMPATIBLE_FRONTEND',
  });
  await assert.rejects(host.install({ ...artifact, id: '__proto__' }), {
    code: 'INVALID_FRONTEND',
  });
  await assert.rejects(host.install({ ...artifact, id: 'external-agent' }), {
    code: 'INVALID_FRONTEND',
  });
  await assert.rejects(
    host.install({ ...artifact, permissions: ['filesystem:read'] }),
    { code: 'INVALID_FRONTEND' },
  );
  await host.setGrants('custom', ['tasks:read']);
  const session = await host.openSession('custom');
  await host.install({ ...artifact, html: '<h1>Updated</h1>' });
  await assert.rejects(host.call(session, 'tasks.list'), {
    code: 'SESSION_EXPIRED',
  });
  const restored = await host.restore('custom', 1);
  assert.equal(restored.version, 3);
  assert.equal(restored.html, artifact.html);
  assert.deepEqual((await host.snapshot()).grants.custom, ['tasks:read']);
});
test('Rust: removal restores the recovery interface and expires sessions', async (t) => {
  const { host } = await fixture(t);
  await host.install({ ...frontends[0], id: 'custom' });
  await host.activate('custom');
  const session = await host.openSession('custom');
  await host.remove('custom');
  assert.equal((await host.snapshot()).activeId, 'default');
  await assert.rejects(host.call(session, 'workspace.describe'), {
    code: 'SESSION_EXPIRED',
  });
  await assert.rejects(host.remove('default'), { code: 'BUILTIN_FRONTEND' });
});
test('Rust: SQLite persists task changes, frontend versions, grants, and helper preferences', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-sqlite-'));
  let restarted: Host | undefined;
  const storage = fileStorage(join(directory, 'workspace.json'));
  const { host, session } = await fixture(t, storage);
  t.after(async () => {
    await host.close();
    await restarted?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = (await host.call(session, 'tasks.create', {
    title: 'Survive a restart',
  })) as Task;
  await host.install({ ...frontends[0], id: 'custom' });
  await host.setGrants('custom', ['tasks:read']);
  await host.activate('custom');
  const settings = (await host.snapshot()).assistant;
  settings.helperVisible = false;
  await host.setAssistantSettings(settings);
  await host.close();
  restarted = await createHost({ storage, frontends, tasks: [] });
  assert.equal((await restarted.snapshot()).activeId, 'custom');
  assert.equal((await restarted.snapshot()).assistant.helperVisible, false);
  assert.ok(
    (await list(restarted, await restarted.openSession('custom'))).some(
      (t) => t.id === task.id,
    ),
  );
});
test('Rust: legacy JSON import is atomic, idempotent, and preserves the original file', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-migration-'));
  let migrated: Host | undefined, reopened: Host | undefined;
  t.after(async () => {
    await migrated?.close();
    await reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { host } = await fixture(t);
  const legacy = { ...(await host.snapshot()), frontends, tasks: seedTasks() };
  legacy.tasks[0].title = 'My existing work';
  legacy.agent = { enabled: true, permissions: ['tasks:read'] };
  const path = join(directory, 'workspace.json'),
    original = JSON.stringify(legacy);
  writeFileSync(path, original);
  const options = { storage: fileStorage(path), frontends, tasks: seedTasks() };
  migrated = await createHost(options);
  assert.equal(
    (await list(migrated, await migrated.openSession('default')))[0].title,
    'My existing work',
  );
  assert.deepEqual((await migrated.snapshot()).agent.permissions, [
    'tasks:read',
  ]);
  assert.equal(readFileSync(path, 'utf8'), original);
  await migrated.close();
  reopened = await createHost(options);
  assert.equal(
    (await list(reopened, await reopened.openSession('default'))).length,
    8,
  );
});
test('Rust: authenticated transports reject invalid tokens, foreign origins, and host-management calls', async (t) => {
  const { host } = await fixture(t),
    connection = host.connection();
  const request = (
    headers: Record<string, string>,
    path = '/mcp',
    body: unknown = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  ) =>
    fetch(connection.url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await request({})).status, 401);
  assert.equal((await request({ Authorization: 'Bearer wrong' })).status, 401);
  assert.equal(
    (
      await request({
        Authorization: `Bearer ${connection.token}`,
        Origin: 'https://evil.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        { Authorization: `Bearer ${connection.token}` },
        '/__fluid/rpc',
        { method: 'snapshot', args: [] },
      )
    ).status,
    404,
  );
  const discovery = await (await fetch(connection.discoveryUrl)).json();
  assert.equal(discovery.engine, 'Rust');
  assert.ok(!JSON.stringify(discovery).includes(connection.token));
});
test('Rust: standard Streamable HTTP MCP exposes exactly the permitted tools and supports agent-authored source', async (t) => {
  const { host, session } = await fixture(t);
  await host.setAgent(true, [
    'tasks:read',
    'frontends:read',
    'frontends:write',
  ]);
  const client = new Client({ name: 'interop-http', version: '1' });
  t.after(() => client.close());
  const connection = host.connection();
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  let tools = (await client.listTools()).tools;
  assert.ok(tools.some((t) => t.name === 'frontends.put'));
  assert.ok(!tools.some((t) => t.name === 'tasks.create'));
  const source = await client.callTool({
    name: 'frontends.get',
    arguments: { id: 'default' },
  });
  assert.ok(!source.isError);
  const artifact = {
    ...frontends[0],
    id: 'agent-workspace',
    html: '<h1>Written by any MCP agent</h1>',
  };
  const installed = await client.callTool({
    name: 'frontends.put',
    arguments: { frontend: artifact, expectedVersion: 0 },
  });
  assert.ok(!installed.isError);
  assert.deepEqual((await host.snapshot()).grants['agent-workspace'], []);
  const stale = await client.callTool({
    name: 'frontends.put',
    arguments: { frontend: artifact, expectedVersion: 0 },
  });
  assert.equal(stale.isError, true);
  await client.callTool({
    name: 'frontends.activate',
    arguments: { id: 'agent-workspace', canvasMode: true },
  });
  assert.equal((await host.snapshot()).activeId, 'agent-workspace');
  assert.equal((await host.snapshot()).canvasMode, true);
  assert.equal((await list(host, session)).length, 8);
  await host.setAgent(true, ['tasks:read']);
  tools = (await client.listTools()).tools;
  assert.ok(!tools.some((t) => t.name === 'frontends.get'));
  assert.equal(
    (
      await client.callTool({
        name: 'frontends.get',
        arguments: { id: 'default' },
      })
    ).isError,
    true,
  );
});
test('Rust: native MCP stdio requires no Node runtime and changes the running app', async (t) => {
  const { host, session } = await fixture(t);
  await host.setAgent(true, ['tasks:read', 'tasks:write']);
  const connection = host.connection();
  const client = new Client({ name: 'interop-stdio', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: connection.nativePath,
      args: ['mcp'],
      env: { FLUID_URL: connection.url, FLUID_AGENT_TOKEN: connection.token },
    }),
  );
  assert.deepEqual(
    new Set((await client.listTools()).tools.map((t) => t.name)),
    new Set([
      'workspace.describe',
      'tools.inspect',
      'tasks.list',
      'tasks.create',
      'tasks.update',
    ]),
  );
  assert.ok(
    !(
      await client.callTool({
        name: 'tasks.create',
        arguments: { title: 'An agent made this' },
      })
    ).isError,
  );
  assert.ok(
    (await list(host, session)).some((t) => t.title === 'An agent made this'),
  );
  await host.setAgent(false);
  assert.equal(
    (await client.callTool({ name: 'tasks.list', arguments: {} })).isError,
    true,
  );
});
test('development shell adapter still rejects cross-origin management requests', async (t) => {
  const { host } = await fixture(t);
  const server = createServer(httpHandler(host, host.connection, true));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing server');
  for (const headers of [
    {},
    { 'X-Fluid-Client': 'workspace', Origin: 'https://evil.example' },
  ] as Record<string, string>[]) {
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${address.port}/__fluid/rpc`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ method: 'snapshot', args: [] }),
        })
      ).status,
      403,
    );
  }
});

test('Rust: shipping a new default never overwrites an existing user artifact with the same ID', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-recovery-collision-'));
  const storage = fileStorage(join(directory, 'workspace.json'));
  const first = await createHost({ frontends, tasks: [], storage });
  const custom = await first.install({
    ...frontends[0],
    id: 'future-default',
    html: '<h1>My original source</h1>',
  });
  await first.setGrants(custom.id, ['tasks:read']);
  await first.activate(custom.id);
  await first.close();
  const second = await createHost({
    frontends: [
      ...frontends,
      {
        ...frontends[0],
        id: custom.id,
        html: '<h1>A new shipped default</h1>',
      },
    ],
    tasks: [],
    storage,
  });
  t.after(async () => {
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const snapshot = await second.snapshot();
  assert.equal((await second.frontendSource(custom.id)).html, custom.html);
  assert.equal(
    snapshot.frontends.find((f) => f.id === custom.id)?.builtin,
    undefined,
  );
  assert.deepEqual(snapshot.grants[custom.id], ['tasks:read']);
  assert.equal(snapshot.activeId, custom.id);
});
