import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  Menu,
  dialog,
  safeStorage,
} from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHost } from '../src/core/host';
import { nativePath } from '../src/core/native-path';
import { fileStorage } from '../src/core/storage';
import { seedTasks } from '../src/core/seed';
import { builtins } from '../src/frontends/index';
import { dispatch } from '../src/core/server';
import {
  FluidError,
  MAX_REQUEST_BYTES,
  errorEnvelope,
} from '../src/protocol/index';
import { createAssistant } from '../src/assistant/service';
import {
  createProviderRuntime,
  memorySecrets,
} from '../src/assistant/providers';
import { encryptedSecrets } from '../src/assistant/secrets';

app.setName('Fluid Workspace');
if (process.env.FLUID_DATA_DIR)
  app.setPath('userData', process.env.FLUID_DATA_DIR);
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  let window: BrowserWindow | null = null;
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const host = await createHost({
        storage: fileStorage(join(app.getPath('userData'), 'workspace.json')),
        frontends: builtins,
        tasks: seedTasks(),
        binaryPath: app.isPackaged
          ? join(
              process.resourcesPath,
              'native',
              process.platform === 'win32' ? 'fluid-host.exe' : 'fluid-host',
            )
          : nativePath(app.getAppPath()),
      });
      const secure =
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' ||
          safeStorage.getSelectedStorageBackend() !== 'basic_text');
      const secrets = secure
        ? encryptedSecrets(
            join(app.getPath('userData'), 'provider-keys.json'),
            (text) => safeStorage.encryptString(text),
            (data) => safeStorage.decryptString(data),
          )
        : memorySecrets();
      const assistant = createAssistant(host, createProviderRuntime(secrets));
      app.on('before-quit', () => {
        assistant.close();
        void host.close();
      });
      const devUrl = process.env.FLUID_DEV_URL;
      const indexFile = join(__dirname, '../dist/index.html');
      const createWindow = () => {
        window = new BrowserWindow({
          width: 1440,
          height: 970,
          minWidth: 960,
          minHeight: 680,
          backgroundColor: '#fbfcf9',
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 21, y: 20 },
          webPreferences: {
            preload: join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            webviewTag: false,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) =>
          event.preventDefault(),
        );
        window.webContents.on('will-frame-navigate', (event) => {
          if (
            !event.isMainFrame &&
            event.url !== 'about:srcdoc' &&
            event.url !== 'about:blank'
          )
            event.preventDefault();
        });
        window.webContents.on('will-attach-webview', (event) =>
          event.preventDefault(),
        );
        if (devUrl) void window.loadURL(devUrl);
        else void window.loadFile(indexFile);
      };
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      // Arbitrary frontend code is offline, including navigations and image beacons.
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const protocol = new URL(details.url).protocol;
        const localDev =
          devUrl &&
          (details.url.startsWith(devUrl + '/') ||
            details.url.startsWith(devUrl.replace('http:', 'ws:') + '/'));
        callback({
          cancel: !(
            ['file:', 'data:', 'blob:', 'about:', 'devtools:'].includes(
              protocol,
            ) || localDev
          ),
        });
      });
      ipcMain.handle('fluid:request', async (event, method, args) => {
        try {
          if (
            event.sender !== window?.webContents ||
            event.senderFrame !== window.webContents.mainFrame
          )
            throw new FluidError(
              'UNAUTHORIZED',
              'Only the app shell can manage the host.',
            );
          if (typeof method !== 'string' || !Array.isArray(args))
            throw new FluidError('INVALID_INPUT', 'Invalid host request.');
          if (method.startsWith('assistant.'))
            return { ok: true, value: await assistant.request(method, args) };
          if (method === 'saveFile') {
            const [filename, content] = args;
            if (
              typeof filename !== 'string' ||
              !/^[\w.-]{1,120}\.json$/.test(filename) ||
              typeof content !== 'string' ||
              Buffer.byteLength(content, 'utf8') > MAX_REQUEST_BYTES
            )
              throw new FluidError('INVALID_INPUT', 'Invalid export file.');
            const result = await dialog.showSaveDialog(window!, {
              title: 'Export from Fluid',
              buttonLabel: 'Export',
              defaultPath: join(app.getPath('downloads'), filename),
              filters: [{ name: 'JSON file', extensions: ['json'] }],
            });
            if (result.canceled || !result.filePath)
              return { ok: true, value: { saved: false } };
            writeFileSync(result.filePath, content, { mode: 0o600 });
            return { ok: true, value: { saved: true } };
          }
          return {
            ok: true,
            value:
              method === 'connection'
                ? host.connection()
                : await dispatch(host, method, args),
          };
        } catch (error) {
          return errorEnvelope(error);
        }
      });
      host.subscribe(() => window?.webContents.send('fluid:changed'));
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { role: 'togglefullscreen' },
            ],
          },
          { role: 'windowMenu' },
        ]),
      );
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      console.error(error);
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
