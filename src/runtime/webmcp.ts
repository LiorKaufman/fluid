import type { ToolInspection } from '../protocol/index';
import { backend } from './backend';
interface ModelContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      execute(input: unknown): Promise<unknown>;
    },
    options?: { signal: AbortSignal },
  ): Promise<void> | void;
  // Older implementations predate signal-based unregistration.
  unregisterTool?(name: string): void;
}
export function webMcpAvailable() {
  return Boolean(
    (document as Document & { modelContext?: ModelContext }).modelContext,
  );
}
// Serialize registration/cleanup so a stale effect cannot unregister a newer tool.
let queue = Promise.resolve();
export function connectWebMcp(frontendId: string) {
  const context = (document as Document & { modelContext?: ModelContext })
    .modelContext;
  if (!context) return () => {};
  const registration = new AbortController();
  let cancelled = false,
    session: string | undefined;
  const registered: string[] = [];
  queue = queue
    .then(async () => {
      if (cancelled) return;
      session = await backend.request<string>('openSession', frontendId);
      const inspection = await backend.request<ToolInspection>(
        'tools.inspect',
        frontendId,
      );
      for (const capability of inspection.tools.filter(
        (tool) => tool.exposed,
      )) {
        if (cancelled) break;
        await context.registerTool(
          {
            name: capability.name,
            description: capability.description,
            inputSchema: capability.inputSchema,
            async execute(input) {
              try {
                if (cancelled)
                  throw new Error('This frontend session has ended.');
                const value = await backend.request(
                  'call',
                  session,
                  capability.name,
                  input ?? {},
                );
                return {
                  content: [{ type: 'text', text: JSON.stringify(value) }],
                };
              } catch (error) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: (error as Error).message }],
                };
              }
            },
          },
          { signal: registration.signal },
        );
        registered.push(capability.name);
      }
    })
    .catch((error) => {
      if (!cancelled) console.warn('WebMCP registration failed:', error);
    });
  return () => {
    cancelled = true;
    registration.abort();
    queue = queue
      .then(async () => {
        registered.forEach((name) => context.unregisterTool?.(name));
        if (session) await backend.request('closeSession', session);
      })
      .catch(() => {});
  };
}
