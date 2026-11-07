import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHost } from '../src/core/host';
import { APP_ID, PROTOCOL_VERSION, type Frontend } from '../src/protocol/index';

const frontend: Frontend = {
  id: 'default',
  name: 'Default',
  author: 'Test',
  description: '',
  appId: APP_ID,
  protocol: PROTOCOL_VERSION,
  version: 1,
  builtin: true,
  permissions: ['tasks:read', 'tasks:write'],
  html: '<main>Recovery</main>',
  updatedAt: '',
};

async function fixture(t: TestContext) {
  const host = await createHost({ frontends: [frontend], tasks: [] });
  t.after(() => host.close());
  await host.setAgent(true, ['frontends:read', 'frontends:write']);
  return host;
}

test(
  'alpha: numeric JSON representations cannot poison the host through MCP',
  { timeout: 20_000 },
  async (t) => {
    const host = await fixture(t),
      connection = host.connection();
    for (const version of ['0.0', '-0.0', '1e100']) {
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'frontends.put',
          arguments: {
            frontend: { ...frontend, id: 'numeric' },
            expectedVersion: 'VERSION',
          },
        },
      }).replace('"VERSION"', version);
      const response = await fetch(connection.mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.token}`,
        },
        body: request,
      });
      const result = await response.json();
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, /INVALID_INPUT/);
      assert.equal(
        (await host.request<{ activeId: string }>('snapshot')).activeId,
        'default',
      );
    }
  },
);

test(
  'alpha: Unicode and escaped source publish through HTTP and native stdio',
  { timeout: 20_000 },
  async (t) => {
    const host = await fixture(t),
      connection = host.connection();
    const html = '<main>' + '界'.repeat(400_000) + '</main>';
    const request = (id: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'frontends.put',
          arguments: {
            frontend: { ...frontend, id, html },
            expectedVersion: 0,
          },
        },
      });
    // Both legal encodings must fit: raw UTF-8 is 1.2 MB, escaped JSON is 2.4 MB.
    for (const escaped of [false, true]) {
      const id = escaped ? 'escaped-http' : 'unicode-http';
      const response = await fetch(connection.mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.token}`,
        },
        body: escaped ? request(id).replaceAll('界', '\\u754c') : request(id),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).result.isError, false);
      assert.equal((await host.frontendSource(id)).html, html);
    }
    const child = spawn(connection.nativePath, ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FLUID_URL: connection.url,
        FLUID_AGENT_TOKEN: connection.token,
      },
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.end(
      request('escaped-stdio').replaceAll('界', '\\u754c') + '\n',
    );
    assert.equal(await completed, 0, stderr);
    assert.equal(JSON.parse(stdout).result.isError, false);
    assert.equal((await host.frontendSource('escaped-stdio')).html, html);
    const snapshot = await host.snapshot();
    assert.ok(JSON.stringify(snapshot).length < 20_000);
    assert.ok(snapshot.frontends.every((item) => !('html' in item)));
  },
);
