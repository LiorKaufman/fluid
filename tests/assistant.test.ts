import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHost, type Host } from '../src/core/host';
const openedHosts: Host[] = [];
after(async () => {
  await Promise.all(openedHosts.map((host) => host.close()));
});
import { seedTasks } from '../src/core/seed';
import { fileStorage } from '../src/core/storage';
import { APP_ID, PROTOCOL_VERSION, type Frontend } from '../src/protocol/index';
import {
  createAssistant,
  generationSchema,
  parseGeneration,
} from '../src/assistant/service';
import {
  createProviderRuntime,
  memorySecrets,
  validateBaseUrl,
  type ProviderRuntime,
} from '../src/assistant/providers';
import {
  defaultAssistantSettings,
  type AssistantStatus,
  type Proposal,
} from '../src/assistant/types';
import { encryptedSecrets } from '../src/assistant/secrets';

const frontend: Frontend = {
  id: 'studio',
  name: 'Studio',
  description: '',
  author: 'Fluid',
  protocol: PROTOCOL_VERSION,
  appId: APP_ID,
  permissions: ['tasks:read', 'tasks:write'],
  version: 1,
  builtin: true,
  html: '<h1>Original interface</h1>',
  updatedAt: new Date().toISOString(),
};
const generated = {
  name: 'A quieter workspace',
  message: 'I gave your workspace more room to breathe.',
  html: '<h1>My new interface</h1>',
  permissions: ['tasks:read'],
};
const status: AssistantStatus = {
  effective: 'codex',
  credentialStorage: 'session',
  providers: [
    {
      id: 'codex',
      name: 'Codex',
      available: true,
      detail: 'Already signed in',
    },
  ],
};
async function fixture(runtime?: Partial<ProviderRuntime>) {
  const host = await createHost({
    frontends: [frontend, { ...frontend, id: 'board' }],
    tasks: seedTasks(),
  });
  openedHosts.push(host);
  const provider: ProviderRuntime = {
    detect: async () => status,
    generate: async () => JSON.stringify(generated),
    saveKey() {},
    ...runtime,
  };
  return { host, assistant: createAssistant(host, provider) };
}
test('chat prepares a proposal without mutating the app; applying uses normal installation and zero new grants', async () => {
  let sent = '';
  const { host, assistant } = await fixture({
    async generate(id, _, request) {
      assert.equal(id, 'codex');
      sent = request.prompt;
      return JSON.stringify(generated);
    },
  });
  const before = await host.snapshot();
  const proposal = (await assistant.request('assistant.generate', [
    { prompt: 'Make it calmer', history: [] },
  ])) as Proposal;
  assert.deepEqual(await host.snapshot(), before);
  assert.ok(sent.includes('tasks.list'));
  assert.ok(sent.includes(frontend.html));
  assert.ok(!sent.includes(seedTasks()[0].title));
  const installed = (await assistant.request('assistant.apply', [
    proposal.id,
  ])) as Frontend;
  assert.equal(installed.html, generated.html);
  assert.equal((await host.snapshot()).activeId, 'studio');
  assert.deepEqual((await host.snapshot()).grants[installed.id], []);
  assert.equal((await host.frontendSource('studio')).html, frontend.html);
  await assert.rejects(assistant.request('assistant.apply', [proposal.id]), {
    code: 'NOT_FOUND',
  });
});
test('a proposal cannot replace an interface that changed after generation', async () => {
  const { host, assistant } = await fixture();
  const proposal = (await assistant.request('assistant.generate', [
    { prompt: 'Make it quieter', history: [] },
  ])) as Proposal;
  await host.activate('board');
  await assert.rejects(assistant.request('assistant.apply', [proposal.id]), {
    code: 'STALE_PROPOSAL',
  });
  assert.equal((await host.snapshot()).frontends.length, 2);
});
test('malformed, oversized, and unknown-permission outputs are rejected without running code', () => {
  for (const value of [
    'not json',
    JSON.stringify({ ...generated, html: '' }),
    JSON.stringify({ ...generated, html: 'x'.repeat(500_001) }),
    JSON.stringify({ ...generated, permissions: ['filesystem:read'] }),
  ])
    assert.throws(() => parseGeneration(value, frontend), {
      code: 'INVALID_RESPONSE',
    });
  assert.equal(
    parseGeneration('```json\n' + JSON.stringify(generated) + '\n```', frontend)
      .frontend.name,
    generated.name,
  );
});
test('one active request at a time, cancellation aborts the provider and creates no artifact', async () => {
  const { host, assistant } = await fixture({
    generate: async (_, __, request) =>
      new Promise((_, reject) => {
        if (request.signal.aborted) {
          reject(new Error('Stopped'));
          return;
        }
        request.signal.addEventListener(
          'abort',
          () => reject(new Error('Stopped')),
          { once: true },
        );
      }),
  });
  const pending = assistant.request('assistant.generate', [
    { prompt: 'Change it', history: [] },
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    assistant.request('assistant.generate', [{ prompt: 'Again', history: [] }]),
    { code: 'BUSY' },
  );
  await assistant.request('assistant.cancel', []);
  await assert.rejects(pending, /Stopped/);
  assert.equal((await host.snapshot()).frontends.length, 2);
});
test('helper visibility survives restarts and settings never persist unknown secret fields', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-settings-'));
  try {
    const options = {
      frontends: [frontend],
      tasks: seedTasks(),
      storage: fileStorage(join(directory, 'state.json')),
    };
    const host = await createHost(options),
      assistant = createAssistant(host);
    openedHosts.push(host);
    await assistant.request('assistant.settings', [
      {
        ...defaultAssistantSettings,
        helperVisible: false,
        apiKey: 'never-persist-me',
      },
    ]);
    await host.close();
    const restarted = await createHost(options);
    openedHosts.push(restarted);
    assert.equal((await restarted.snapshot()).assistant.helperVisible, false);

    assert.ok(
      !readFileSync(join(directory, 'state.sqlite'), 'utf8').includes(
        'never-persist-me',
      ),
    );
    await assert.rejects(
      createAssistant(restarted).request('assistant.settings', [
        {
          ...defaultAssistantSettings,
          connections: {
            ...defaultAssistantSettings.connections,
            openai: { baseUrl: 'https://other.example/v1', model: 'test' },
          },
        },
      ]),
      { code: 'INVALID_INPUT' },
    );
    await restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('automatic discovery selects an authenticated local agent without issuing inference', async () => {
  let inference = 0;
  const runtime = createProviderRuntime(memorySecrets(), {
    executable: (name) => '/test/' + name,
    command: async (_, args) => {
      if (args[0] === 'login') return 'Logged in using ChatGPT';
      if (args[0] === 'auth') return '{"loggedIn":true}';
      inference++;
      return '';
    },
    fetch: async () => Response.json({ models: [] }),
  });
  const detected = await runtime.detect(defaultAssistantSettings);
  assert.equal(detected.effective, 'codex');
  assert.equal(inference, 0);
  assert.equal(
    detected.providers.find((p) => p.id === 'claude')?.available,
    true,
  );
});
test('Codex adapter reuses auth, isolates the working directory, requests structured output and keeps sandboxing', async () => {
  let used = false;
  const runtime = createProviderRuntime(memorySecrets(), {
    executable: () => '/test/codex',
    command: async (_, args, options) => {
      if (args.includes('--help')) return '--ignore-user-config';
      assert.ok(args.includes('read-only'));
      assert.ok(args.includes('--ignore-user-config'));
      assert.ok(!args.some((arg) => arg.includes('dangerously')));
      assert.equal(options?.input, 'Design the interface');
      assert.notEqual(options?.cwd, process.cwd());
      const output = args[args.indexOf('--output-last-message') + 1];
      writeFileSync(output, JSON.stringify(generated));
      used = true;
      return '';
    },
  });
  const output = await runtime.generate('codex', defaultAssistantSettings, {
    prompt: 'Design the interface',
    signal: new AbortController().signal,
    schema: generationSchema,
  });
  assert.equal(JSON.parse(output).name, generated.name);
  assert.equal(used, true);
});
test('API credentials are scoped to their endpoint; compatible servers receive the actual prompt and model', async () => {
  const secrets = memorySecrets();
  const settings = structuredClone(defaultAssistantSettings);
  settings.connections.compatible = {
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'my-local-model',
  };
  const calls: {
    url: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const runtime = createProviderRuntime(secrets, {
    executable: () => undefined,
    fetch: async (url, options) => {
      calls.push({
        url: String(url),
        authorization: new Headers(options?.headers).get('Authorization'),
        body: JSON.parse(options?.body as string),
      });
      return Response.json({
        choices: [{ message: { content: JSON.stringify(generated) } }],
      });
    },
  });
  runtime.saveKey(
    'compatible',
    'test-key',
    settings.connections.compatible.baseUrl,
  );
  const request = {
    prompt: 'A new layout',
    signal: new AbortController().signal,
    schema: generationSchema,
  };
  await runtime.generate('compatible', settings, request);
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'my-local-model');
  settings.connections.compatible.baseUrl = 'https://different.example/v1';
  await runtime.generate('compatible', settings, request);
  assert.equal(calls[1].authorization, null);
  for (const url of [
    'http://remote.example',
    'file:///tmp/file',
    'https://key:secret@example.com/v1',
    'https://example.com/v1?api_key=secret',
  ])
    assert.throws(() => validateBaseUrl(url), { code: 'INVALID_INPUT' });
});
test('OpenAI uses the Responses API and parses structured output; provider errors do not expose keys', async () => {
  const settings = structuredClone(defaultAssistantSettings);
  settings.connections.openai.model = 'test-model';
  const runtime = createProviderRuntime(memorySecrets(), {
    fetch: async (url, options) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options?.body as string);
      assert.equal(body.text.format.type, 'json_schema');
      return Response.json({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(generated) }],
          },
        ],
      });
    },
  });
  runtime.saveKey('openai', 'secret-test-key', 'https://api.openai.com/v1');
  assert.equal(
    JSON.parse(
      await runtime.generate('openai', settings, {
        prompt: 'A view',
        signal: new AbortController().signal,
        schema: generationSchema,
      }),
    ).name,
    generated.name,
  );
  const rejected = createProviderRuntime(memorySecrets(), {
    fetch: async () => new Response('secret-test-key', { status: 401 }),
  });
  rejected.saveKey('openai', 'secret-test-key', 'https://api.openai.com/v1');
  await assert.rejects(
    rejected.generate('openai', settings, {
      prompt: 'A view',
      signal: new AbortController().signal,
      schema: generationSchema,
    }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes('secret-test-key'),
  );
});
test('secret storage persists ciphertext and supports removing a key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-vault-'));
  try {
    const path = join(directory, 'keys.json');
    // The interface accepts OS encryption; this reversible test cipher verifies the storage seam.
    const encrypt = (value: string) =>
      Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xad));
    const decrypt = (value: Buffer) =>
      Buffer.from([...value].map((byte) => byte ^ 0xad)).toString();
    encryptedSecrets(path, encrypt, decrypt).set('openai', 'private-key');
    assert.ok(!readFileSync(path, 'utf8').includes('private-key'));
    const reopened = encryptedSecrets(path, encrypt, decrypt);
    assert.equal(reopened.get('openai'), 'private-key');
    reopened.set('openai', '');
    assert.equal(reopened.get('openai'), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude Code subscription adapter disables tools and consumes structured results', async () => {
  const runtime = createProviderRuntime(memorySecrets(), {
    executable: () => '/test/claude',
    command: async (_, args) => {
      assert.equal(args[args.indexOf('--tools') + 1], '');
      assert.ok(args.includes('--strict-mcp-config'));
      assert.ok(args.includes('--no-session-persistence'));
      assert.ok(!args.includes('--bare'));
      return JSON.stringify({ structured_output: generated });
    },
  });
  const result = await runtime.generate('claude', defaultAssistantSettings, {
    prompt: 'A view',
    signal: new AbortController().signal,
    schema: generationSchema,
  });
  assert.deepEqual(JSON.parse(result), generated);
});

test('Anthropic and Ollama adapters use their native request and response formats', async () => {
  const settings = structuredClone(defaultAssistantSettings);
  settings.connections.anthropic.model = 'test-claude-model';
  const called: string[] = [];
  const runtime = createProviderRuntime(memorySecrets(), {
    fetch: async (url, options) => {
      const path = String(url);
      called.push(path);
      if (path.endsWith('/api/tags'))
        return Response.json({ models: [{ name: 'test-local-model' }] });
      const body = JSON.parse(options?.body as string);
      if (path.endsWith('/messages')) {
        assert.equal(
          new Headers(options?.headers).get('x-api-key'),
          'test-anthropic-key',
        );
        assert.equal(body.model, 'test-claude-model');
        return Response.json({
          content: [{ type: 'text', text: JSON.stringify(generated) }],
        });
      }
      assert.equal(body.model, 'test-local-model');
      assert.equal(body.stream, false);
      assert.deepEqual(body.format, generationSchema);
      return Response.json({ message: { content: JSON.stringify(generated) } });
    },
  });
  runtime.saveKey(
    'anthropic',
    'test-anthropic-key',
    settings.connections.anthropic.baseUrl,
  );
  for (const id of ['anthropic', 'ollama'] as const)
    assert.equal(
      JSON.parse(
        await runtime.generate(id, settings, {
          prompt: 'A view',
          signal: new AbortController().signal,
          schema: generationSchema,
        }),
      ).name,
      generated.name,
    );
  assert.deepEqual(called, [
    'https://api.anthropic.com/v1/messages',
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:11434/api/chat',
  ]);
});
