/** Desktop/dev adapter for the authoritative Rust host. No domain rules live here. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { nativePath } from './native-path.ts';
import {
  FluidError,
  unwrap,
  type Envelope,
  type Frontend,
  type Permission,
  type Snapshot,
  type Task,
  type ToolInspection,
} from '../protocol/index.ts';
import type { AssistantSettings } from '../assistant/types.ts';
export interface Storage {
  path?: string;
  load?():
    | (Omit<Snapshot, 'frontends' | 'history'> & {
        frontends: Frontend[];
        history: Record<string, Frontend[]>;
        tasks: Task[];
      })
    | undefined;
}
export interface HostOptions {
  storage?: Storage;
  frontends: Frontend[];
  tasks: Task[];
  binaryPath?: string;
}
export interface Connection {
  url: string;
  mcpUrl: string;
  discoveryUrl: string;
  token: string;
  engine: 'Rust';
  nativePath: string;
  agentPath?: string;
}
export async function createHost(options: HostOptions) {
  const binary =
    options.binaryPath ?? process.env.FLUID_HOST_BINARY ?? nativePath();
  if (!existsSync(binary))
    throw new FluidError(
      'NATIVE_HOST_MISSING',
      'Build the Rust host with npm run native:build, then start Fluid again.',
    );
  const child: ChildProcessWithoutNullStreams = spawn(binary, ['host'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  let counter = 0,
    stopped = false,
    closing = false;
  const listeners = new Set<() => void>();
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    stopped = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new FluidError(
          'NATIVE_HOST_STOPPED',
          'The Rust host stopped. Restart Fluid to reconnect.',
        ),
      );
    }
    pending.clear();
    if (!closing) for (const listener of listeners) listener();
  };
  child.once('error', fail);
  child.once('exit', fail);
  child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
  child.stdin.on('error', fail);
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Envelope & { id?: number; event?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.event === 'changed') {
      for (const listener of listeners) listener();
      return;
    }
    const item = pending.get(message.id!);
    if (!item) return;
    pending.delete(message.id!);
    clearTimeout(item.timer);
    try {
      item.resolve(unwrap(message));
    } catch (error) {
      item.reject(error as Error);
    }
  });
  function request<T = unknown>(
    method: string,
    args: unknown[] = [],
  ): Promise<T> {
    if (stopped || closing)
      return Promise.reject(
        new FluidError(
          'NATIVE_HOST_STOPPED',
          'The Rust host is no longer running. Restart Fluid.',
        ),
      );
    const id = ++counter;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new FluidError(
            'NATIVE_HOST_TIMEOUT',
            'The native request did not respond. Restart Fluid if this persists.',
          ),
        );
      }, 15000);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    });
  }
  const path = options.storage?.path;
  let connection: Connection;
  try {
    const native = await request<Omit<Connection, 'nativePath'>>('initialize', [
      {
        frontends: options.frontends,
        tasks: options.tasks,
        dataPath: path ? path.replace(/\.json$/, '') + '.sqlite' : null,
        legacyPath: path ?? null,
        legacyState: options.storage?.load?.() ?? null,
      },
    ]);
    connection = { ...native, nativePath: binary };
  } catch (error) {
    closing = true;
    child.kill();
    throw error;
  }
  return {
    request,
    connection: () => ({ ...connection }),
    snapshot(): Promise<Snapshot> {
      // MCP can finish a mutation before its change event reaches this process.
      // Metadata-only snapshots are cheap enough to read directly and stay current.
      return request<Snapshot>('snapshot');
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openSession: (id: string) => request<string>('openSession', [id]),
    frontendSource: (id: string) => request<Frontend>('frontendSource', [id]),
    closeSession: (session: string) => request<void>('closeSession', [session]),
    call: (session: string, name: string, args: unknown = {}) =>
      request('call', [session, name, args]),
    callAgent: (name: string, args: unknown = {}) =>
      request('callAgent', [name, args]),
    inspect: (id: string) => request<ToolInspection>('tools.inspect', [id]),
    setAgent: (enabled: boolean, grants?: Permission[]) =>
      request<void>('setAgent', [enabled, grants ?? null]),
    activate: (id: string) => request<void>('activate', [id]),
    install: (value: unknown) => request<Frontend>('install', [value]),
    restore: (id: string, version: number) =>
      request<Frontend>('restore', [id, version]),
    remove: (id: string) => request<void>('remove', [id]),
    setGrants: (id: string, grants: Permission[]) =>
      request<void>('setGrants', [id, grants]),
    setAssistantSettings: (settings: AssistantSettings) =>
      request<void>('setAssistantSettings', [settings]),
    async close() {
      if (closing || stopped) return;
      closing = true;
      listeners.clear();
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2000);
        timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
export type Host = Awaited<ReturnType<typeof createHost>>;
