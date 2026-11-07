/** Compatibility launcher. New integrations invoke the native Rust binary directly. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { nativePath } from './core/native-path';
const binary = process.env.FLUID_HOST_BINARY ?? nativePath();
if (!existsSync(binary)) {
  console.error(
    'Build the native host with npm run native:build before connecting.',
  );
  process.exitCode = 1;
} else {
  const child = spawn(binary, ['mcp'], {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  child.once('error', () => {
    console.error('Could not start the native MCP adapter.');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
