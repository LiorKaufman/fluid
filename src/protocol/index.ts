/** Client bindings and discovery metadata are generated from the Rust host. */
import type { Capability, RpcError } from './generated.ts';
import manifest from './contract.json' with { type: 'json' };
import defaults from './defaults.json' with { type: 'json' };
export type * from './generated.ts';
export const PROTOCOL_VERSION = defaults.protocol;
export const APP_ID = defaults.appId;
export const MAX_HTML_UNITS = defaults.limits.htmlUnits;
export const MAX_REQUEST_BYTES = defaults.limits.requestBytes;
export const permissions: string[] = defaults.permissions;
export type Permission = string;
export const capabilities = manifest.capabilities as Capability[];
export const contract = manifest;
export type Envelope<T = unknown> =
  { ok: true; value: T } | { ok: false; error: RpcError };
export class FluidError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FluidError';
  }
}
export function errorEnvelope(error: unknown): Envelope<never> {
  return {
    ok: false,
    error: {
      code: error instanceof FluidError ? error.code : 'INTERNAL_ERROR',
      message:
        error instanceof FluidError
          ? error.message
          : 'The app could not complete this request.',
    },
  };
}
export function unwrap<T>(envelope: Envelope<T>): T {
  if (!envelope.ok)
    throw new FluidError(envelope.error.code, envelope.error.message);
  return envelope.value;
}
