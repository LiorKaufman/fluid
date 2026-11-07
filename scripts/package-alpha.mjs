import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--universal'))
  throw new Error('The alpha ships separate x64 and arm64 macOS archives.');
const result = spawnSync(
  process.execPath,
  [
    'node_modules/electron-builder/out/cli/cli.js',
    ...args,
    '--publish',
    'never',
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await import('./checksums.mjs');
