exports.default = async (context) => {
  const { Arch } = require('electron-builder');
  const { buildNative } = await import('./native.mjs');
  buildNative(context.electronPlatformName, Arch[context.arch]);
};
