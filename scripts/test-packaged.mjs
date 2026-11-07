import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checksum } from './native.mjs';

function findExecutable(root, depth = 0) {
  if (process.platform === 'darwin') {
    const app = readdirSync(root).find((name) => name.endsWith('.app'));
    return app
      ? join(root, app, 'Contents', 'MacOS', 'Fluid Workspace')
      : undefined;
  }
  const name =
    process.platform === 'win32' ? 'Fluid Workspace.exe' : 'fluid-workspace';
  if (existsSync(join(root, name))) return join(root, name);
  if (depth >= 2) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const executable = findExecutable(join(root, entry.name), depth + 1);
    if (executable) return executable;
  }
}

function extractArchive(directory) {
  const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const name = `Fluid-${version}-${os}-${process.arch}.${process.platform === 'linux' ? 'tar.gz' : 'zip'}`;
  const archive = resolve('release', name);
  const recorded = readFileSync('release/SHA256SUMS.txt', 'utf8')
    .split('\n')
    .find((line) => line.endsWith(`  ${name}`))
    ?.split('  ')[0];
  if (!recorded || recorded !== checksum(archive))
    throw new Error('Alpha archive checksum does not match.');
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const [command, args] =
    process.platform === 'darwin'
      ? ['ditto', ['-x', '-k', archive, directory]]
      : process.platform === 'win32'
        ? [
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(directory)}`,
            ],
          ]
        : ['tar', ['-xzf', archive, '-C', directory]];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not extract alpha archive.');
  return findExecutable(directory);
}

const directories =
  process.platform === 'darwin'
    ? [`mac-${process.arch}`, 'mac']
    : process.platform === 'win32'
      ? [`win-${process.arch}-unpacked`, 'win-unpacked']
      : [`linux-${process.arch}-unpacked`, 'linux-unpacked'];
let executable = process.argv[2] ?? process.env.FLUID_PACKAGED_APP;
let extracted;
if (executable === '--archive') {
  extracted = mkdtempSync(join(tmpdir(), 'fluid-alpha-archive-'));
  try {
    executable = extractArchive(extracted);
    if (!executable || !existsSync(executable))
      throw new Error(
        'The alpha archive does not contain the expected app executable.',
      );
  } catch (error) {
    rmSync(extracted, { recursive: true, force: true });
    throw error;
  }
}
if (!executable) {
  for (const directory of directories) {
    const root = resolve('release', directory);
    if (!existsSync(root)) continue;
    if (process.platform === 'darwin') {
      const app = readdirSync(root).find((name) => name.endsWith('.app'));
      if (app)
        executable = join(root, app, 'Contents', 'MacOS', 'Fluid Workspace');
    } else
      executable = join(
        root,
        process.platform === 'win32'
          ? 'Fluid Workspace.exe'
          : 'fluid-workspace',
      );
    if (executable && existsSync(executable)) break;
  }
}
if (!executable || !existsSync(executable))
  throw new Error(
    'Packaged app not found. Run npm run package or set FLUID_PACKAGED_APP.',
  );
console.log(`Testing packaged app: ${executable}`);
const result = spawnSync(
  process.execPath,
  ['node_modules/@playwright/test/cli.js', 'test'],
  {
    stdio: 'inherit',
    env: { ...process.env, FLUID_PACKAGED_APP: executable },
  },
);
if (extracted) rmSync(extracted, { recursive: true, force: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
