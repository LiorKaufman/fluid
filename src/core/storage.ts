import type { Storage } from './host.ts';
/** Rust imports this legacy JSON path once; new changes go to its sibling SQLite DB. */
export function fileStorage(path: string): Storage {
  return { path };
}
