import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { APP_ID, PROTOCOL_VERSION, type Snapshot } from '../src/protocol/index';

const launchDesktop = (environment: Record<string, string>) =>
  electron.launch({
    executablePath: process.env.FLUID_PACKAGED_APP,
    args: process.env.FLUID_PACKAGED_APP ? [] : [resolve('.')],
    env: environment,
  });

test('desktop: interchangeable interfaces, custom code, permissions, and persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-desktop-test-'));
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  environment.FLUID_DATA_DIR = directory;
  delete environment.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(environment);
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const frame = page.frameLocator('iframe.surface');
    const screenshot = async (name: string) => {
      await frame
        .locator('main')
        .evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
      await page.screenshot({
        path: `docs/${name}.png`,
        animations: 'disabled',
        scale: 'css',
      });
    };
    await expect(
      frame.getByRole('heading', { name: 'Make room for good work.' }),
    ).toBeVisible();
    await screenshot('workspace');
    await frame.getByRole('button', { name: 'New task', exact: true }).click();
    await frame
      .getByRole('textbox', { name: 'Task name', exact: true })
      .fill('My interfaces share this task');
    await frame.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(
      frame.getByRole('button', {
        name: 'My interfaces share this task',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Flow board A little more perspective' })
      .click();
    await expect(
      frame.getByRole('heading', {
        name: 'A little momentum goes a long way.',
      }),
    ).toBeVisible();
    await expect(
      frame.getByRole('button', {
        name: 'My interfaces share this task',
        exact: true,
      }),
    ).toBeVisible();
    await screenshot('board');
    await page
      .getByRole('button', { name: 'Focus A little less distraction' })
      .click();
    await expect(
      frame.getByRole('heading', { name: 'One thing at a time.' }),
    ).toBeVisible();
    await screenshot('focus');
    await page
      .getByRole('button', { name: 'Interfaces', exact: false })
      .first()
      .click();
    await page
      .getByRole('button', { name: 'Create interface', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Interface name', exact: true })
      .fill('My custom canvas');
    await page
      .getByRole('textbox', { name: 'Interface source code', exact: true })
      .fill(
        `<style>body{padding:40px;font:16px system-ui;background:#eaf0e1;color:#315239}</style><h1>My entirely different frontend</h1><div id="result"></div><script>async function refresh(){try{const {tasks}=await fluid.call('tasks.list');document.getElementById('result').textContent=tasks.map(t=>t.title).join(' | ')}catch(e){document.getElementById('result').textContent=e.code}}fluid.subscribe(refresh);refresh();</script>`,
      );
    await page.getByRole('button', { name: 'Save & review access' }).click();
    await expect(
      page.getByRole('dialog', { name: 'A little introduction.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Allow selected & use' }).click();
    await expect(
      frame.getByRole('heading', { name: 'My entirely different frontend' }),
    ).toBeVisible();
    await expect(frame.locator('#result')).toContainText(
      'My interfaces share this task',
    );
    await page
      .getByRole('button', { name: 'Permissions', exact: true })
      .click();
    await page
      .getByRole('switch', {
        name: 'My custom canvas: Read your tasks',
        exact: true,
      })
      .click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(frame.locator('#result')).toContainText('PERMISSION_DENIED');
    // The custom renderer gets neither the Electron bridge nor access to the parent DOM.
    const custom = page.frames().find((f) => f.url() === 'about:srcdoc')!;
    expect(await custom.evaluate(() => typeof window.fluidDesktop)).toBe(
      'undefined',
    );
    expect(
      await custom.evaluate(() => {
        try {
          return Boolean(parent.document);
        } catch {
          return false;
        }
      }),
    ).toBe(false);
    expect(
      await custom.evaluate(async () => {
        try {
          await fetch('https://example.com');
          return 'allowed';
        } catch {
          return 'blocked';
        }
      }),
    ).toBe('blocked');
    await page
      .getByRole('button', { name: 'Studio A home for all your moving parts' })
      .click();
    await expect(
      frame.getByRole('button', {
        name: 'My interfaces share this task',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Interfaces', exact: true }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles(resolve('examples/reading-room.fluid.json'));
    await page.getByRole('button', { name: 'Allow selected & use' }).click();
    await expect(
      frame.getByRole('heading', { name: 'The reading room.', exact: true }),
    ).toBeVisible();
    await expect(frame.locator('main')).toContainText(
      'My interfaces share this task',
    );
    await page.getByRole('button', { name: 'Interfaces', exact: true }).click();
    const exportedPath = join(directory, 'exported-interface.json');
    // Select a disposable path in place of the native Save dialog.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportedPath);
    await page
      .getByRole('button', { name: 'Export The reading room', exact: true })
      .click();
    await expect.poll(() => existsSync(exportedPath)).toBe(true);
    expect(JSON.parse(readFileSync(exportedPath!, 'utf8')).id).toBe(
      'reading-room',
    );
    await page
      .getByRole('button', { name: 'Edit The reading room', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'Interface source code' })
      .fill('<h1>The second reading room</h1>');
    await page.getByRole('button', { name: 'Save & review access' }).click();
    await page.getByRole('button', { name: 'Allow selected & use' }).click();
    await expect(
      frame.getByRole('heading', { name: 'The second reading room' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Interfaces', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Restore previous version of The reading room',
        exact: true,
      })
      .click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(
      frame.getByRole('heading', { name: 'The reading room.', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Studio A home for all your moving parts' })
      .click();
    expect(errors).toEqual([]);
    await app.close();
    app = undefined;
    app = await launchDesktop(environment);
    const restarted = await app.firstWindow();
    await expect(
      restarted.frameLocator('iframe.surface').getByRole('button', {
        name: 'My interfaces share this task',
        exact: true,
      }),
    ).toBeVisible();
    await restarted
      .getByRole('button', { name: 'Interfaces', exact: false })
      .first()
      .click();
    await expect(
      restarted.getByRole('heading', { name: 'My custom canvas', exact: true }),
    ).toBeVisible();
  } finally {
    await app?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('desktop: bundled MCP adapter connects to the actual app and live updates its frontend', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-desktop-agent-'));
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  environment.FLUID_DATA_DIR = directory;
  delete environment.ELECTRON_RUN_AS_NODE;
  const app = await launchDesktop(environment);
  const diagnostic = process.env.FLUID_TRACE_AGENT === '1';
  const stderr: string[] = [];
  if (diagnostic)
    app
      .process()
      .stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const client = new Client({
    name: 'desktop-integration-test',
    version: '1.0',
  });
  try {
    const page = await app.firstWindow();
    if (diagnostic) {
      const geometry = await app.evaluate(({ BrowserWindow, screen }) => ({
        bounds: BrowserWindow.getAllWindows()[0].getBounds(),
        workArea: screen.getPrimaryDisplay().workArea,
        focused: BrowserWindow.getAllWindows()[0].isFocused(),
      }));
      console.log('Native window geometry:', JSON.stringify(geometry));
      if (process.env.FLUID_FIT_WINDOW === '1')
        await app.evaluate(({ BrowserWindow, screen }) => {
          const window = BrowserWindow.getAllWindows()[0],
            area = screen.getPrimaryDisplay().workArea;
          window.setMinimumSize(
            Math.min(960, area.width),
            Math.min(680, area.height),
          );
          window.setBounds({
            ...area,
            width: Math.min(1440, area.width),
            height: Math.min(970, area.height),
          });
        });
    }
    if (diagnostic)
      await page.evaluate(() => {
        const events: object[] = [];
        for (const type of ['mousedown', 'mouseup', 'click'])
          document.addEventListener(
            type,
            (event) => {
              const target = event.target;
              if (!(target instanceof Element)) return;
              events.push({
                type,
                target: target.tagName,
                label: target.closest('button')?.getAttribute('aria-label'),
                focused: document.hasFocus(),
                switchState: document
                  .querySelector('[aria-label="External agent access"]')
                  ?.getAttribute('aria-checked'),
              });
              document.documentElement.dataset.agentEvents = JSON.stringify(
                events.slice(-20),
              );
            },
            true,
          );
      });
    await page
      .getByRole('button', { name: 'Connect an agent', exact: true })
      .click();
    await page
      .getByRole('switch', { name: 'External agent access', exact: true })
      .click();
    if (diagnostic) {
      const state = await page.evaluate(async () => {
        const reply = await window.fluidDesktop!.request('snapshot', []);
        const snapshot = reply.ok ? (reply.value as Snapshot) : undefined;
        return {
          viewport: { width: innerWidth, height: innerHeight },
          switchBounds: document
            .querySelector('[aria-label="External agent access"]')
            ?.getBoundingClientRect()
            .toJSON(),
          events: JSON.parse(
            document.documentElement.dataset.agentEvents ?? '[]',
          ),
          enabled: snapshot?.agent.enabled,
          revision: snapshot?.revision,
          error: !reply.ok ? reply.error.code : undefined,
          toast: document.querySelector('.toast')?.textContent,
          access: snapshot?.activity
            .filter((item) => item.action === 'agent.access')
            .map((item) => item.detail),
        };
      });
      console.log('Agent click diagnostic:', JSON.stringify(state));
      const sanitized = stderr
        .join('')
        .replace(/\b[a-f0-9]{64}\b/gi, '<REDACTED>');
      await test.info().attach('native-diagnostics', {
        body: sanitized,
        contentType: 'text/plain',
      });
    }
    await expect(page.locator('.connection-config')).toContainText(
      'FLUID_AGENT_TOKEN',
    );
    const config = JSON.parse(
      await page.locator('.connection-config').innerText(),
    ).mcpServers['fluid-workspace'];
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...environment, ...config.env },
      }),
    );
    expect((await client.listTools()).tools).toHaveLength(5);
    expect(
      (
        await client.callTool({
          name: 'tasks.create',
          arguments: { title: 'A real agent made this task' },
        })
      ).isError,
    ).not.toBe(true);
    await page
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await expect(
      page.frameLocator('iframe.surface').getByRole('button', {
        name: 'A real agent made this task',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Connect an agent', exact: true })
      .click();
    await page
      .getByRole('switch', { name: 'External agent access', exact: true })
      .click();
    expect(
      (await client.callTool({ name: 'tasks.list', arguments: {} })).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('desktop: helper generates through a configured API, applies with consent, and remembers visibility', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-helper-test-'));
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  environment.FLUID_DATA_DIR = directory;
  delete environment.ELECTRON_RUN_AS_NODE;
  const received: {
    path: string;
    authorization?: string;
    body: { model: string; messages: { content: string }[] };
  }[] = [];
  const model = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    received.push({
      path: request.url!,
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                name: 'A gentler workspace',
                message:
                  'I made a quieter, peach-toned workspace with room for your tasks.',
                permissions: ['tasks:read'],
                html: `<style>body{background:#f6eee1;color:#6a543d;font:15px system-ui;padding:45px}h1{font:40px Georgia}p{line-height:1.8}</style><h1>A gentler workspace.</h1><p>Your existing tasks, with a little room to breathe.</p><div id="count"></div><script>async function refresh(){try{const {tasks}=await fluid.call('tasks.list');document.getElementById('count').textContent=tasks.length+' tasks, right where you left them.'}catch(e){document.getElementById('count').textContent=e.message}}fluid.subscribe(refresh);refresh();</script>`,
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  if (!address || typeof address === 'string')
    throw new Error('No mock model address');
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop(environment);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /OpenAI-compatible API/ }).click();
    await page
      .getByRole('textbox', { name: 'API base URL', exact: true })
      .fill(`http://127.0.0.1:${address.port}/v1`);
    await page
      .getByRole('textbox', { name: 'Provider model', exact: true })
      .fill('test-interface-model');
    await page
      .getByRole('textbox', { name: 'Provider API key', exact: true })
      .fill('test-only-provider-key');
    await page
      .getByRole('button', { name: 'Save helper settings', exact: true })
      .click();
    await expect(
      page.getByText('Your helper settings are saved.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page
      .getByRole('button', { name: 'Open interface helper', exact: true })
      .click();
    await expect(
      page.getByText('Using Compatible API', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('textbox', {
        name: 'Tell the helper how to change your interface',
      })
      .fill('Make a calmer peach workspace with my task count.');
    await page.getByRole('button', { name: 'Send interface request' }).click();
    await expect(
      page.getByRole('button', { name: 'Review & use', exact: true }),
    ).toBeVisible();
    await expect(
      page
        .frameLocator('iframe.surface')
        .getByRole('heading', { name: 'Make room for good work.' }),
    ).toBeVisible();
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/v1/chat/completions');
    expect(received[0].authorization).toBe('Bearer test-only-provider-key');
    expect(received[0].body.model).toBe('test-interface-model');
    expect(received[0].body.messages[0].content).not.toContain(
      'Find the feeling for our new homepage',
    );
    await page.screenshot({ path: 'docs/helper-chat.png', scale: 'css' });
    await page
      .getByRole('button', { name: 'Review & use', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Allow selected & use', exact: true })
      .click();
    const frame = page.frameLocator('iframe.surface');
    await expect(
      frame.getByRole('heading', { name: 'A gentler workspace.', exact: true }),
    ).toBeVisible();
    await expect(frame.locator('#count')).toContainText('8 tasks');
    await page
      .getByRole('button', { name: 'Helper settings', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: 'Interface helper', exact: true }),
    ).not.toBeVisible();
    await page
      .getByRole('switch', { name: 'Show helper chat button', exact: true })
      .click();
    await expect(
      page.getByRole('switch', {
        name: 'Show helper chat button',
        exact: true,
      }),
    ).toHaveAttribute('aria-checked', 'false');
    await expect(
      page.getByRole('button', { name: 'Open interface helper', exact: true }),
    ).not.toBeVisible();
    const keys = join(directory, 'provider-keys.json');
    if (existsSync(keys))
      expect(readFileSync(keys, 'utf8')).not.toContain(
        'test-only-provider-key',
      );
    await app.close();
    app = undefined;
    app = await launchDesktop(environment);
    const reopened = await app.firstWindow();
    await expect(
      reopened
        .frameLocator('iframe.surface')
        .getByRole('heading', { name: 'A gentler workspace.', exact: true }),
    ).toBeVisible();
    await expect(
      reopened.getByRole('button', {
        name: 'Open interface helper',
        exact: true,
      }),
    ).not.toBeVisible();
    await reopened
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await reopened
      .getByRole('switch', { name: 'Show helper chat button', exact: true })
      .click();
    await expect(
      reopened.getByRole('button', {
        name: 'Open interface helper',
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await app?.close();
    model.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('desktop: live Rust tool exposure, source publishing by any MCP client, full canvas and recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-tools-test-'));
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  environment.FLUID_DATA_DIR = directory;
  delete environment.ELECTRON_RUN_AS_NODE;
  const app = await launchDesktop(environment);
  const client = new Client({ name: 'independent-agent', version: '1' });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole('button', { name: 'Exposed tools', exact: true })
      .click();
    await expect(
      page.getByRole('heading', {
        name: 'See what your agent can actually do.',
      }),
    ).toBeVisible();
    await expect(page.locator('.tools-count strong')).toHaveText('0');
    await expect(
      page.getByText('External agent access is off.', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Connect an agent', exact: true })
      .last()
      .click();
    await page
      .getByRole('switch', { name: 'External agent access', exact: true })
      .click();
    await page
      .getByRole('checkbox', { name: 'Read interface source', exact: true })
      .check();
    await page
      .getByRole('checkbox', {
        name: 'Publish and switch interfaces',
        exact: true,
      })
      .check();
    await page
      .getByRole('button', { name: 'Streamable HTTP', exact: true })
      .click();
    const config = JSON.parse(
      await page.locator('.connection-config').innerText(),
    ).mcpServers['fluid-workspace'];
    expect(config.url).toContain('/mcp');
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      }),
    );
    await page
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await expect(page.locator('.tools-count strong')).toHaveText('10');
    await page.screenshot({ path: 'docs/exposed-tools.png', scale: 'css' });
    const tool = page
      .locator('details.capability-card')
      .filter({ hasText: 'frontends.put' });
    await tool.locator('summary').click();
    await expect(tool.locator('pre').first()).toContainText('expectedVersion');
    await page.screenshot({ path: 'docs/tool-schema.png', scale: 'css' });
    const allTools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(allTools).toContain('frontends.put');
    expect(allTools).not.toContain('tasks.delete');
    const artifact = {
      id: 'agent-canvas',
      name: 'An agent-owned canvas',
      description: 'Complete source supplied by an independent client',
      author: 'Independent MCP client',
      appId: APP_ID,
      protocol: PROTOCOL_VERSION,
      permissions: ['tasks:read'],
      html: `<style>body{margin:0;min-height:100vh;background:#172e35;color:#e0eee4;font:16px system-ui;display:grid;place-content:center;padding:60px}h1{font-size:54px;font-weight:400;letter-spacing:-2px}p{color:#99b8ad;line-height:1.8}</style><h1>This entire canvas is yours.</h1><p>Written through standard MCP. Powered by the Rust host.</p><div id="data"></div><script>async function refresh(){try{const {tasks}=await fluid.call('tasks.list');document.getElementById('data').textContent=tasks.length+' shared tasks'}catch(e){document.getElementById('data').textContent=e.code}}fluid.subscribe(refresh);refresh();</script>`,
    };
    expect(
      (
        await client.callTool({
          name: 'frontends.put',
          arguments: { frontend: artifact, expectedVersion: 0 },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: 'frontends.activate',
          arguments: { id: 'agent-canvas', canvasMode: true },
        })
      ).isError,
    ).not.toBe(true);
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    const frame = page.frameLocator('iframe.surface');
    await expect(
      frame.getByRole('heading', { name: 'This entire canvas is yours.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open app controls', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.sidebar')).not.toBeVisible();
    await expect(frame.locator('#data')).toHaveText('PERMISSION_DENIED');
    await page
      .getByRole('button', { name: 'Open app controls', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Permissions', exact: true })
      .click();
    await page
      .getByRole('switch', {
        name: 'An agent-owned canvas: Read your tasks',
        exact: true,
      })
      .click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(frame.locator('#data')).toHaveText('8 shared tasks');
    await page
      .getByRole('button', { name: 'Use full canvas', exact: true })
      .click();
    await expect(page.locator('.sidebar')).not.toBeVisible();
    await frame
      .locator('h1')
      .evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    await page.screenshot({ path: 'docs/full-canvas.png', scale: 'css' });
    await page
      .getByRole('button', { name: 'Open app controls', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Exposed tools', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Inspect tools for client', exact: true })
      .selectOption('agent-canvas');
    await expect(page.locator('.tools-count strong')).toHaveText('3');
    const selfInspection = await client.callTool({
      name: 'tools.inspect',
      arguments: {},
    });
    expect(selfInspection.isError).not.toBe(true);
  } finally {
    await client.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('commerce: real invoices, independent client UI choices, and a review shared between table and feed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-commerce-desktop-'));
  const environment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  environment.FLUID_DATA_DIR = directory;
  delete environment.ELECTRON_RUN_AS_NODE;
  const app = await launchDesktop(environment);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page
      .getByRole('button', { name: 'Commerce demo', exact: true })
      .click();
    const table = page.frameLocator('iframe[title="Order desk interface"]');
    const feed = page.frameLocator('iframe[title="Action feed interface"]');
    await expect(
      table.getByRole('heading', { name: 'The order desk.' }),
    ).toBeVisible();
    await expect(table.locator('.metrics')).toContainText('500');
    await expect(table.locator('tbody tr')).toHaveCount(20);
    await page.screenshot({ path: 'docs/commerce-table.png', scale: 'css' });
    await page
      .getByRole('button', { name: "Use Leo's demo client", exact: true })
      .click();
    await expect(
      feed.getByRole('heading', { name: 'A little forward motion.' }),
    ).toBeVisible();
    await expect(feed.locator('.action-card').first()).toBeVisible();
    await page.screenshot({ path: 'docs/commerce-feed.png', scale: 'css' });
    // Choosing a new interface for Leo does not change Maya's saved preference.
    await page
      .getByRole('button', { name: 'Use Order desk view', exact: true })
      .click();
    await page
      .getByRole('button', { name: "Use Maya's demo client", exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Use Order desk view', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page
      .getByRole('button', { name: 'Use Action feed view', exact: true })
      .click();
    await page
      .getByRole('button', { name: "Use Leo's demo client", exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Use Order desk view', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page
      .getByRole('button', { name: 'Compare both interfaces', exact: true })
      .click();
    const orderId = (await feed
      .locator('.action-card')
      .first()
      .getAttribute('data-order'))!;
    await table
      .getByRole('textbox', { name: 'Search orders', exact: true })
      .fill(orderId);
    const row = table.locator(`tr[data-order="${orderId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('To review');
    await feed
      .locator(`article[data-order="${orderId}"]`)
      .getByRole('button', { name: 'View record', exact: true })
      .click();
    await expect(
      feed.getByRole('dialog', { name: `Invoice ${orderId}`, exact: true }),
    ).toBeVisible();
    await feed
      .getByRole('textbox', { name: 'Shared review note', exact: true })
      .fill('Checked the original credit note. Shared with the analyst.');
    await feed
      .getByRole('button', { name: 'Mark reviewed', exact: true })
      .last()
      .click();
    await expect(row).toContainText('Reviewed');
    await feed
      .getByRole('button', { name: 'Close invoice', exact: true })
      .click();
    await expect(feed.locator(`article[data-order="${orderId}"]`)).toHaveCount(
      0,
    );
    await page.screenshot({
      path: 'docs/commerce-comparison.png',
      scale: 'css',
    });
    await table
      .getByRole('button', { name: `#${orderId}`, exact: true })
      .click();
    await expect(
      table.getByRole('textbox', { name: 'Shared review note', exact: true }),
    ).toHaveValue('Checked the original credit note. Shared with the analyst.');
    await expect(table.locator('.source-line').first()).toContainText(
      'spreadsheet row',
    );
    await table
      .getByRole('button', { name: 'Close invoice', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'About the data', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', {
        name: 'Real data and transformation rules',
        exact: true,
      }),
    ).toContainText('541,909');
    await expect(
      page.getByRole('dialog', {
        name: 'Real data and transformation rules',
        exact: true,
      }),
    ).toContainText('not authenticated team accounts');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
