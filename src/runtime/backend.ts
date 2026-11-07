import { unwrap, type Envelope } from '../protocol/index';
export interface Backend {
  request<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  subscribe(listener: () => void): () => void;
}
declare global {
  interface Window {
    fluidDesktop?: {
      request(method: string, args: unknown[]): Promise<Envelope>;
      subscribe(listener: () => void): () => void;
    };
  }
}
export const backend: Backend = window.fluidDesktop
  ? {
      async request<T>(method: string, ...args: unknown[]) {
        return unwrap(
          (await window.fluidDesktop!.request(method, args)) as Envelope<T>,
        );
      },
      subscribe: (listener) => window.fluidDesktop!.subscribe(listener),
    }
  : {
      async request<T>(method: string, ...args: unknown[]) {
        const response = await fetch('/__fluid/rpc', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Fluid-Client': 'workspace',
          },
          body: JSON.stringify({ method, args }),
        });
        return unwrap((await response.json()) as Envelope<T>);
      },
      subscribe(listener) {
        let revision: number | undefined;
        let stopped = false;
        let checking = false;
        const timer = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            const next = await backend.request<number>('revision');
            if (!stopped && next !== revision) {
              revision = next;
              listener();
            }
          } catch {
            if (!stopped) listener();
          } finally {
            checking = false;
          }
        }, 1000);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      },
    };
