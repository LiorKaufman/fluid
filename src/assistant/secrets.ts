import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { SecretStore } from './providers.ts';

/** Encryption is supplied by Electron safeStorage; plaintext never enters app state. */
export function encryptedSecrets(
  path: string,
  encrypt: (text: string) => Buffer,
  decrypt: (data: Buffer) => string,
): SecretStore {
  let values: Record<string, string> = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : {};
  return {
    mode: 'encrypted',
    get(id) {
      const encrypted = values[id];
      if (!encrypted) return undefined;
      try {
        return decrypt(Buffer.from(encrypted, 'base64'));
      } catch {
        return undefined;
      }
    },
    set(id, value) {
      const next = { ...values };
      if (value) next[id] = encrypt(value).toString('base64');
      else delete next[id];
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path + '.tmp', JSON.stringify(next), { mode: 0o600 });
      renameSync(path + '.tmp', path);
      values = next;
    },
  };
}
