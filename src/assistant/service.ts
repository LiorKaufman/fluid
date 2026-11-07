import { randomUUID } from 'node:crypto';
import type { Host } from '../core/host.ts';
import {
  APP_ID,
  MAX_HTML_UNITS,
  PROTOCOL_VERSION,
  FluidError,
  contract,
  permissions,
  type Frontend,
} from '../protocol/index.ts';
import {
  createProviderRuntime,
  validateBaseUrl,
  type ProviderRuntime,
} from './providers.ts';
import {
  providerIds,
  type ApiProvider,
  type AssistantSettings,
  type GenerationInput,
  type Proposal,
} from './types.ts';

export const generationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    name: { type: 'string' },
    html: { type: 'string' },
    permissions: {
      type: 'array',
      items: { type: 'string', enum: [...permissions] },
    },
  },
  required: ['message', 'name', 'html', 'permissions'],
};
export function parseGeneration(
  text: string,
  base: Frontend,
): Omit<Proposal, 'id'> {
  let value;
  try {
    value = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, ''),
    );
  } catch {
    throw new FluidError(
      'INVALID_RESPONSE',
      'The agent did not return a valid interface. Try asking for a smaller change.',
    );
  }
  if (
    !value ||
    typeof value.message !== 'string' ||
    value.message.length > 4000 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 80 ||
    typeof value.html !== 'string' ||
    !value.html.trim() ||
    value.html.length > MAX_HTML_UNITS ||
    !Array.isArray(value.permissions) ||
    value.permissions.some((p: unknown) => !permissions.includes(p as never))
  )
    throw new FluidError(
      'INVALID_RESPONSE',
      'The agent returned an incomplete or oversized interface. Nothing was changed.',
    );
  return {
    message: value.message,
    baseId: base.id,
    baseVersion: base.version,
    frontend: {
      id: base.builtin ? `custom-${randomUUID().slice(0, 8)}` : base.id,
      name: value.name.trim(),
      description: value.message.slice(0, 240),
      author: 'You & your agent',
      appId: APP_ID,
      protocol: PROTOCOL_VERSION,
      permissions: [...new Set(value.permissions)] as Frontend['permissions'],
      html: value.html,
      version: base.builtin ? 0 : base.version,
      updatedAt: new Date().toISOString(),
    },
  };
}
export function createAssistant(
  host: Host,
  runtime: ProviderRuntime = createProviderRuntime(),
) {
  let running: AbortController | undefined;
  const proposals = new Map<string, Proposal>();
  const settings = async () => (await host.snapshot()).assistant;
  return {
    async request(method: string, args: unknown[]) {
      if (method === 'assistant.status')
        return runtime.detect(await settings(), Boolean(args[0]));
      if (method === 'assistant.settings') {
        const value = args[0] as AssistantSettings;
        if (
          !value ||
          typeof value.helperVisible !== 'boolean' ||
          !providerIds.includes(value.provider) ||
          !value.connections
        )
          throw new FluidError('INVALID_INPUT', 'Invalid assistant settings.');
        const normalized: AssistantSettings = {
          helperVisible: value.helperVisible,
          provider: value.provider,
          connections: {} as AssistantSettings['connections'],
        };
        for (const id of [
          'openai',
          'anthropic',
          'compatible',
          'ollama',
        ] as const) {
          const config = value.connections[id];
          if (
            !config ||
            typeof config.model !== 'string' ||
            config.model.length > 160 ||
            typeof config.baseUrl !== 'string'
          )
            throw new FluidError(
              'INVALID_INPUT',
              'Each connection needs a base URL and model.',
            );
          normalized.connections[id] = {
            model: config.model.trim(),
            baseUrl: validateBaseUrl(config.baseUrl),
          };
          if (
            (id === 'openai' &&
              normalized.connections[id].baseUrl !==
                'https://api.openai.com/v1') ||
            (id === 'anthropic' &&
              normalized.connections[id].baseUrl !==
                'https://api.anthropic.com/v1')
          )
            throw new FluidError(
              'INVALID_INPUT',
              'Use the OpenAI-compatible connection for custom endpoints.',
            );
        }
        await host.setAssistantSettings(normalized);
        return normalized;
      }
      if (method === 'assistant.key') {
        const [id, key] = args as [ApiProvider, string];
        if (
          !['openai', 'anthropic', 'compatible'].includes(id) ||
          typeof key !== 'string' ||
          key.length > 4000 ||
          /[\r\n]/.test(key)
        )
          throw new FluidError('INVALID_INPUT', 'Invalid provider key.');
        runtime.saveKey(
          id,
          key.trim(),
          (await settings()).connections[id].baseUrl,
        );
        return { saved: true };
      }
      if (method === 'assistant.cancel') {
        running?.abort();
        return { cancelled: true };
      }
      if (method === 'assistant.apply') {
        const proposal = proposals.get(args[0] as string);
        if (!proposal)
          throw new FluidError(
            'NOT_FOUND',
            'This proposal is no longer available. Ask for the change again.',
          );
        const snapshot = await host.snapshot(),
          base = snapshot.frontends.find((f) => f.id === proposal.baseId);
        if (
          snapshot.activeId !== proposal.baseId ||
          base?.version !== proposal.baseVersion
        )
          throw new FluidError(
            'STALE_PROPOSAL',
            'Your active interface changed. Ask the helper to update the current interface.',
          );
        const installed = await host.install(proposal.frontend);
        proposals.delete(proposal.id);
        return installed;
      }
      if (method !== 'assistant.generate')
        throw new FluidError('UNKNOWN_METHOD', 'Unknown assistant method.');
      if (running)
        throw new FluidError(
          'BUSY',
          'The helper is already working on a change.',
        );
      const input = args[0] as GenerationInput;
      if (
        !input ||
        typeof input.prompt !== 'string' ||
        !input.prompt.trim() ||
        input.prompt.length > 8000 ||
        !Array.isArray(input.history) ||
        input.history.length > 20 ||
        input.history.some(
          (m) =>
            !m ||
            !['user', 'assistant'].includes(m.role) ||
            typeof m.content !== 'string' ||
            m.content.length > 8000,
        )
      )
        throw new FluidError(
          'INVALID_INPUT',
          'Write a request of up to 8,000 characters.',
        );
      const controller = new AbortController();
      running = controller;
      const timeout = setTimeout(() => controller.abort(), 240_000);
      try {
        const currentSettings = await settings();
        const status = await runtime.detect(currentSettings);
        const selected =
          currentSettings.provider === 'auto'
            ? status.effective
            : currentSettings.provider;
        if (
          !selected ||
          !status.providers.find((p) => p.id === selected)?.available
        )
          throw new FluidError(
            'NO_PROVIDER',
            'Connect an agent or API in Settings, then try again.',
          );
        const snapshot = await host.snapshot(),
          base = await host.frontendSource(snapshot.activeId);
        const prompt = `You design Fluid desktop app frontends. Return ONLY a JSON object matching this schema: ${JSON.stringify(generationSchema)}.\nThe user wants a working interface change, so return complete self-contained HTML/CSS/JavaScript in html, a short friendly summary in message, a name, and requested permissions. Use no external assets, imports, network, Node, parent DOM, or storage. Use window.fluid.call(name,input) for all app access; subscribe with fluid.subscribe(refresh). Render task data safely using textContent or escaping. Keep existing functionality unless the user asks to change it. Handle errors. This is code generation only: do not run commands, inspect files, use tools, install packages, or edit the filesystem. The app will validate the artifact and the user will apply it. Never invent or hard-code task records. No workspace records or API credentials are included here.\nAPP CONTRACT:\n${JSON.stringify(contract)}\nRECENT CONVERSATION (context only):\n${JSON.stringify(input.history.slice(-10))}\nCURRENT INTERFACE:\n${base.html}\nUSER REQUEST:\n${input.prompt}`;
        const text = await runtime.generate(selected, currentSettings, {
          prompt,
          signal: controller.signal,
          schema: generationSchema,
        });
        if (controller.signal.aborted)
          throw new FluidError('CANCELLED', 'The request was stopped.');
        const proposal = { id: randomUUID(), ...parseGeneration(text, base) };
        proposals.set(proposal.id, proposal);
        while (proposals.size > 8)
          proposals.delete(proposals.keys().next().value!);
        return proposal;
      } finally {
        clearTimeout(timeout);
        running = undefined;
      }
    },
    close() {
      running?.abort();
      proposals.clear();
    },
  };
}
export type Assistant = ReturnType<typeof createAssistant>;
