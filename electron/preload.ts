import { contextBridge, ipcRenderer } from 'electron';
if (process.isMainFrame)
  contextBridge.exposeInMainWorld('fluidDesktop', {
    request: (method: string, args: unknown[]) =>
      ipcRenderer.invoke('fluid:request', method, args),
    subscribe: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('fluid:changed', listener);
      return () => {
        ipcRenderer.removeListener('fluid:changed', listener);
      };
    },
  });
