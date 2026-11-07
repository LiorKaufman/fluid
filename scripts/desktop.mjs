import { spawn } from 'node:child_process';
import { createServer } from 'vite';
await import('./build-native.mjs');
await import('./build-electron.mjs');
const server = await createServer({ server: { host: '127.0.0.1' } });
await server.listen();
const electron = (await import('electron')).default;
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    FLUID_DEV_URL: 'http://127.0.0.1:5173',
  },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill('SIGINT'));
