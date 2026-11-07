/** Browser development adapter. Production agent transports are implemented in Rust. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FluidError,
  MAX_REQUEST_BYTES,
  errorEnvelope,
} from '../protocol/index.ts';
import type { Host, Connection } from './host.ts';
export type { Connection } from './host.ts';
export const dispatch = (host: Host, method: string, args: unknown[]) =>
  method === 'snapshot' ? host.snapshot() : host.request(method, args);
export function httpHandler(
  host: Host,
  connection: () => Connection,
  development = false,
  extension?: (method: string, args: unknown[]) => Promise<unknown>,
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next?: () => void,
  ) => {
    if ((request.url ?? '').split('?')[0] !== '/__fluid/rpc') {
      if (next) next();
      else response.writeHead(404).end();
      return;
    }
    try {
      if (
        !development ||
        request.method !== 'POST' ||
        request.headers['x-fluid-client'] !== 'workspace' ||
        !/^(127\.0\.0\.1|localhost):\d+$/.test(request.headers.host ?? '') ||
        (request.headers.origin &&
          request.headers.origin !== `http://${request.headers.host}`)
      )
        throw new FluidError(
          'UNAUTHORIZED',
          'Host management is only available to the app shell.',
        );
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_REQUEST_BYTES)
          throw new FluidError('TOO_LARGE', 'Request exceeds the size limit.');
        chunks.push(buffer);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new FluidError('INVALID_INPUT', 'Expected JSON.');
      }
      if (
        !input ||
        typeof input.method !== 'string' ||
        !Array.isArray(input.args)
      )
        throw new FluidError('INVALID_INPUT', 'Expected method and args.');
      const value =
        input.method.startsWith('assistant.') && extension
          ? await extension(input.method, input.args)
          : input.method === 'connection'
            ? connection()
            : await dispatch(host, input.method, input.args);
      response
        .writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        .end(JSON.stringify({ ok: true, value }));
    } catch (error) {
      response
        .writeHead(
          error instanceof FluidError && error.code === 'UNAUTHORIZED'
            ? 403
            : 400,
          { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        )
        .end(JSON.stringify(errorEnvelope(error)));
    }
  };
}
