import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  accessSync,
  constants,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { FluidError } from '../protocol/index.ts';
import type {
  ApiProvider,
  AssistantSettings,
  AssistantStatus,
  ModelRequest,
  ProviderId,
  ProviderStatus,
} from './types.ts';

export interface SecretStore {
  mode: 'encrypted' | 'session';
  get(id: string): string | undefined;
  set(id: string, value: string): void;
}
export function memorySecrets(): SecretStore {
  const keys = new Map<string, string>();
  return {
    mode: 'session',
    get: (id) => keys.get(id),
    set(id, value) {
      if (value) keys.set(id, value);
      else keys.delete(id);
    },
  };
}
export interface ProviderRuntime {
  detect(
    settings: AssistantSettings,
    force?: boolean,
  ): Promise<AssistantStatus>;
  generate(
    provider: Exclude<ProviderId, 'auto'>,
    settings: AssistantSettings,
    request: ModelRequest,
  ): Promise<string>;
  saveKey(provider: ApiProvider, value: string, baseUrl: string): void;
}
export function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Subscription adapters should not silently switch to environment API billing.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  return env;
}
export function runCommand(
  binary: string,
  args: string[],
  options: {
    input?: string;
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    includeStderr?: boolean;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: commandEnvironment(),
      cwd: options.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '',
      errors = '',
      settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value ?? output);
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish(new FluidError('CANCELLED', 'The request was stopped.'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(
        new FluidError(
          'PROVIDER_TIMEOUT',
          'The agent took too long. Try a smaller change or another connection.',
        ),
      );
    }, options.timeout ?? 180_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 2_000_000) {
        child.kill('SIGTERM');
        finish(
          new FluidError(
            'PROVIDER_OUTPUT_LIMIT',
            'The agent response was too large.',
          ),
        );
      }
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk.toString()).slice(-4000);
    });
    child.once('error', () =>
      finish(
        new FluidError(
          'PROVIDER_UNAVAILABLE',
          'The selected agent could not be started. Check that it is installed and signed in.',
        ),
      ),
    );
    child.once('close', (code) => {
      if (code === 0)
        finish(undefined, options.includeStderr ? output + errors : output);
      else
        finish(
          new FluidError(
            'PROVIDER_FAILED',
            /rate.?limit|quota|usage.?limit/i.test(errors + output)
              ? 'This agent has reached a usage limit. Try again later or choose another connection.'
              : 'The agent could not finish. Check its sign-in and model availability, then try again.',
          ),
        );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}
function executable(name: string) {
  const paths = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const nvm = join(homedir(), '.nvm/versions/node');
  if (existsSync(nvm))
    for (const version of readdirSync(nvm).reverse())
      paths.push(join(nvm, version, 'bin'));
  const candidates = paths
    .filter(Boolean)
    .map((path) =>
      join(path, process.platform === 'win32' ? name + '.exe' : name),
    );
  if (name === 'codex' && process.platform === 'darwin')
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    );
  return candidates.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
export function validateBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FluidError('INVALID_INPUT', 'Enter a valid API base URL.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ))
  )
    throw new FluidError(
      'INVALID_INPUT',
      'Use HTTPS for remote APIs, or HTTP for a local model on this device.',
    );
  return url.toString().replace(/\/$/, '');
}
async function responseJson(response: Response) {
  if (!response.ok)
    throw new FluidError(
      'PROVIDER_FAILED',
      response.status === 401 || response.status === 403
        ? 'The provider rejected this API key. Check the connection in Settings.'
        : response.status === 429
          ? 'This provider has reached a usage or rate limit.'
          : `The model request failed (HTTP ${response.status}). Check the model and endpoint in Settings.`,
    );
  return response.json();
}
export function createProviderRuntime(
  secrets: SecretStore = memorySecrets(),
  dependencies: {
    executable?: typeof executable;
    command?: typeof runCommand;
    fetch?: typeof fetch;
  } = {},
): ProviderRuntime {
  const findExecutable = dependencies.executable ?? executable;
  const command = dependencies.command ?? runCommand;
  const fetchModel = dependencies.fetch ?? fetch;
  const binaries: Partial<Record<'codex' | 'claude', string>> = {};
  let cache: { at: number; key: string; status: AssistantStatus } | undefined;
  const apiKey = (id: ApiProvider, settings: AssistantSettings) =>
    secrets.get(`${id}@${settings.connections[id].baseUrl}`) ??
    (id === 'openai'
      ? process.env.OPENAI_API_KEY
      : id === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : id === 'compatible' &&
            settings.connections.compatible.baseUrl ===
              process.env.FLUID_API_BASE_URL
          ? process.env.FLUID_API_KEY
          : undefined);
  const configuredModel = (id: ApiProvider, settings: AssistantSettings) =>
    settings.connections[id].model ||
    (id === 'openai'
      ? process.env.OPENAI_MODEL
      : id === 'anthropic'
        ? process.env.ANTHROPIC_MODEL
        : id === 'compatible'
          ? process.env.FLUID_MODEL
          : '') ||
    '';
  return {
    saveKey(id, value, baseUrl) {
      secrets.set(`${id}@${baseUrl}`, value);
      cache = undefined;
    },
    async detect(settings, force = false) {
      const key = JSON.stringify(settings.connections);
      if (!force && cache?.key === key && Date.now() - cache.at < 30_000)
        return structuredClone(cache.status);
      const cli = await Promise.all(
        (['codex', 'claude'] as const).map(async (id) => {
          const binary = findExecutable(id);
          if (binary) binaries[id] = binary;
          let available = false;
          if (binary)
            try {
              const result = await command(
                binary,
                id === 'codex' ? ['login', 'status'] : ['auth', 'status'],
                { timeout: 8000, includeStderr: id === 'codex' },
              );
              available =
                id === 'codex'
                  ? /logged in/i.test(result)
                  : JSON.parse(result).loggedIn === true;
            } catch {
              /* Signed out and missing are useful connection states, not startup failures. */
            }
          return {
            id,
            name:
              id === 'codex'
                ? 'Codex · existing sign-in'
                : 'Claude Code · existing sign-in',
            available,
            detail: available
              ? 'Uses the account already signed in on this device.'
              : binary
                ? 'Installed. Sign in with the agent first, then refresh.'
                : 'Install and sign in to reuse your subscription.',
          } satisfies ProviderStatus;
        }),
      );
      const providers: ProviderStatus[] = [...cli];
      for (const id of ['openai', 'anthropic', 'compatible'] as const) {
        const hasKey = Boolean(apiKey(id, settings));
        const available = Boolean(
          configuredModel(id, settings) && (hasKey || id === 'compatible'),
        );
        providers.push({
          id,
          name:
            id === 'openai'
              ? 'OpenAI API'
              : id === 'anthropic'
                ? 'Anthropic API'
                : 'OpenAI-compatible API',
          hasKey,
          available,
          detail: available
            ? 'Configured. Model access is checked when you send.'
            : hasKey
              ? 'API key found. Choose a model in Settings.'
              : id === 'compatible'
                ? 'Set an endpoint and model. A key is optional for local servers.'
                : 'Add an API key and model in Settings.',
        });
      }
      let models: string[] = [];
      try {
        const base = validateBaseUrl(settings.connections.ollama.baseUrl);
        const response = await fetchModel(base + '/api/tags', {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        if (response.ok)
          models = ((await response.json()).models ?? [])
            .map((model: { name: string }) => model.name)
            .filter((name: unknown) => typeof name === 'string');
      } catch {
        /* A local model server is optional. */
      }
      providers.push({
        id: 'ollama',
        name: 'Ollama · local model',
        available: models.length > 0,
        models,
        detail: models.length
          ? `${models.length} local model${models.length === 1 ? '' : 's'} available.`
          : 'Start Ollama and download a model to use it here.',
      });
      const effective = providers.find((p) => p.available)?.id ?? null;
      const status = { providers, effective, credentialStorage: secrets.mode };
      cache = { at: Date.now(), key, status };
      return structuredClone(status);
    },
    async generate(provider, settings, request) {
      if (provider === 'codex' || provider === 'claude') {
        const binary = binaries[provider] ?? findExecutable(provider);
        if (!binary)
          throw new FluidError(
            'PROVIDER_UNAVAILABLE',
            'Install and sign in to the selected agent, then refresh connections.',
          );
        const directory = mkdtempSync(join(tmpdir(), 'fluid-ui-'));
        try {
          if (provider === 'codex') {
            const schema = join(directory, 'schema.json'),
              result = join(directory, 'result.json');
            writeFileSync(schema, JSON.stringify(request.schema));
            const help = await command(binary, ['exec', '--help'], {
              timeout: 8000,
              signal: request.signal,
            });
            const args = [
              '--ask-for-approval',
              'never',
              'exec',
              '--sandbox',
              'read-only',
              '--skip-git-repo-check',
              '--ephemeral',
              '--output-schema',
              schema,
              '--output-last-message',
              result,
              '--json',
            ];
            if (help.includes('--ignore-user-config'))
              args.push('--ignore-user-config');
            args.push('-c', 'features.shell_tool=false', '-');
            await command(binary, args, {
              input: request.prompt,
              cwd: directory,
              signal: request.signal,
            });
            return readFileSync(result, 'utf8');
          }
          const result = JSON.parse(
            await command(
              binary,
              [
                '-p',
                '--output-format',
                'json',
                '--json-schema',
                JSON.stringify(request.schema),
                '--tools',
                '',
                '--disallowedTools',
                'mcp__*',
                '--strict-mcp-config',
                '--mcp-config',
                '{"mcpServers":{}}',
                '--setting-sources',
                '',
                '--no-session-persistence',
              ],
              { input: request.prompt, cwd: directory, signal: request.signal },
            ),
          );
          if (result.is_error)
            throw new FluidError(
              'PROVIDER_FAILED',
              'Claude could not complete the request. Check its sign-in and usage limits.',
            );
          return result.structured_output
            ? JSON.stringify(result.structured_output)
            : result.result;
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
      const config = settings.connections[provider];
      const base = validateBaseUrl(config.baseUrl);
      let model = configuredModel(provider, settings);
      if (provider === 'ollama' && !model) {
        const response = await responseJson(
          await fetchModel(base + '/api/tags', {
            signal: request.signal,
            redirect: 'error',
          }),
        );
        model = response.models?.[0]?.name;
      }
      if (!model)
        throw new FluidError(
          'MODEL_REQUIRED',
          'Choose a model for this connection in Settings.',
        );
      const key = apiKey(provider, settings);
      if ((provider === 'openai' || provider === 'anthropic') && !key)
        throw new FluidError('API_KEY_REQUIRED', 'Add an API key in Settings.');
      const endpoint =
        provider === 'anthropic'
          ? '/messages'
          : provider === 'ollama'
            ? '/api/chat'
            : provider === 'openai'
              ? '/responses'
              : '/chat/completions';
      const body =
        provider === 'anthropic'
          ? {
              model,
              max_tokens: 16000,
              messages: [{ role: 'user', content: request.prompt }],
            }
          : provider === 'ollama'
            ? {
                model,
                stream: false,
                format: request.schema,
                messages: [{ role: 'user', content: request.prompt }],
              }
            : provider === 'openai'
              ? {
                  model,
                  input: request.prompt,
                  text: {
                    format: {
                      type: 'json_schema',
                      name: 'fluid_interface',
                      schema: request.schema,
                      strict: true,
                    },
                  },
                }
              : {
                  model,
                  messages: [{ role: 'user', content: request.prompt }],
                };
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (key) {
        if (provider === 'anthropic') {
          headers['x-api-key'] = key;
          headers['anthropic-version'] = '2023-06-01';
        } else headers.Authorization = `Bearer ${key}`;
      }
      const response = await responseJson(
        await fetchModel(base + endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
          redirect: 'error',
        }),
      );
      const text =
        provider === 'anthropic'
          ? response.content
              ?.filter((part: { type: string }) => part.type === 'text')
              .map((part: { text: string }) => part.text)
              .join('\n')
          : provider === 'ollama'
            ? response.message?.content
            : provider === 'openai'
              ? response.output
                  ?.flatMap(
                    (item: { content?: unknown[] }) => item.content ?? [],
                  )
                  .filter(
                    (part: { type: string }) => part.type === 'output_text',
                  )
                  .map((part: { text: string }) => part.text)
                  .join('')
              : response.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.length > 1_000_000)
        throw new FluidError(
          'INVALID_RESPONSE',
          'The provider returned an empty or oversized response.',
        );
      return text;
    },
  };
}
