import { resolve } from 'node:path';

export function nativePath(root = process.cwd()): string {
  const names: Partial<Record<NodeJS.Platform, string>> = {
    darwin: 'mac',
    win32: 'win',
    linux: 'linux',
  };
  const os = names[process.platform];
  if (!os) throw new Error(`Unsupported native platform: ${process.platform}`);
  return resolve(
    root,
    '.fluid',
    'native',
    `${os}-${process.arch}`,
    process.platform === 'win32' ? 'fluid-host.exe' : 'fluid-host',
  );
}
