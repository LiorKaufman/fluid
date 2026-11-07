import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createHost } from './src/core/host.ts';
import { fileStorage } from './src/core/storage.ts';
import { seedTasks } from './src/core/seed.ts';
import { httpHandler } from './src/core/server.ts';
import { createAssistant } from './src/assistant/service.ts';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'fluid-development-host',
      async configureServer(server) {
        const { builtins } = await server.ssrLoadModule(
          '/src/frontends/index.ts',
        );
        const host = await createHost({
          storage: fileStorage(
            resolve(
              '.fluid',
              process.env.FLUID_TEST ? 'test-state.json' : 'dev-state.json',
            ),
          ),
          frontends: builtins,
          tasks: seedTasks(),
        });
        const assistant = createAssistant(host);
        server.httpServer?.once('close', () => {
          assistant.close();
          void host.close();
        });
        server.middlewares.use(
          httpHandler(
            host,
            () => host.connection(),
            true,
            (method, args) => assistant.request(method, args),
          ),
        );
      },
    },
  ],
  server: { port: 5173, strictPort: true },
});
