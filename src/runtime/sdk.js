/* Injected into every frontend before its code. No session token crosses this seam. */
(() => {
  const instance = '__FLUID_INSTANCE__';
  let port,
    counter = 0;
  const pending = new Map(),
    listeners = new Set();
  let connected;
  const ready = new Promise((resolve) => {
    connected = resolve;
  });
  addEventListener('message', (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== 'fluid:init' ||
      event.data.instance !== instance ||
      port
    )
      return;
    port = event.ports[0];
    if (!port) return;
    port.onmessage = ({ data }) => {
      if (data.type === 'changed') {
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            console.error(error);
          }
        }
        return;
      }
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timeout);
      if (data.ok) request.resolve(data.value);
      else {
        const error = new Error(data.error?.message || 'The request failed.');
        error.code = data.error?.code;
        request.reject(error);
      }
    };
    port.start();
    connected();
  });
  Object.defineProperty(window, 'fluid', {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: '0.1',
      async call(capability, input = {}) {
        await ready;
        if (pending.size >= 100)
          throw new Error('Too many pending capability calls.');
        const id = String(++counter);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pending.delete(id);
            reject(
              new Error('The app did not respond. Reload this interface.'),
            );
          }, 12000);
          pending.set(id, { resolve, reject, timeout });
          port.postMessage({ id, capability, input });
        });
      },
      subscribe(callback) {
        if (typeof callback !== 'function')
          throw new TypeError('Expected a callback.');
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    }),
  });
  parent.postMessage({ type: 'fluid:ready', instance }, '*');
})();
