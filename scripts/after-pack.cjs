exports.default = async (context) => {
  const { Arch } = require('electron-builder');
  const { verifyPackagedNative } = await import('./native.mjs');
  verifyPackagedNative(context, Arch[context.arch]);
};
