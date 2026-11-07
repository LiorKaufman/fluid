import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const targets = {
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  linux: {
    x64: 'x86_64-unknown-linux-gnu',
    arm64: 'aarch64-unknown-linux-gnu',
  },
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
};
const osNames = { darwin: 'mac', linux: 'linux', win32: 'win' };

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}).`);
  return result.stdout;
}

export function nativePlan(platform = process.platform, arch = process.arch) {
  const target = targets[platform]?.[arch];
  if (!target)
    throw new Error(
      `Unsupported native target: ${platform}/${arch}. Use x64 or arm64.`,
    );
  const binary = platform === 'win32' ? 'fluid-host.exe' : 'fluid-host';
  const directory = resolve('.fluid', 'native', `${osNames[platform]}-${arch}`);
  return {
    platform,
    arch,
    target,
    binary,
    directory,
    path: join(directory, binary),
  };
}

export function checksum(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function buildNative(platform = process.platform, arch = process.arch) {
  const plan = nativePlan(platform, arch);
  if (platform !== process.platform)
    throw new Error(
      `Build ${platform} packages on a ${platform} runner; cross-OS packaging is not supported in the alpha.`,
    );
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const metadata = JSON.parse(
    run(
      'cargo',
      ['metadata', '--no-deps', '--locked', '--format-version', '1'],
      true,
    ),
  );
  for (const name of ['fluid-host', 'fluid-protocol']) {
    if (
      metadata.packages.find((item) => item.name === name)?.version !== version
    )
      throw new Error(
        `Cargo ${name} version must match package.json (${version}).`,
      );
  }
  // An explicit target ignores ambient CARGO_BUILD_TARGET, and Cargo reports the real output path.
  const output = run(
    'cargo',
    [
      'build',
      '--release',
      '--locked',
      '-p',
      'fluid-host',
      '--target',
      plan.target,
      '--message-format=json-render-diagnostics',
    ],
    true,
  );
  const artifacts = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const artifact = artifacts.find(
    (item) =>
      item.reason === 'compiler-artifact' &&
      item.target.name === 'fluid-host' &&
      item.executable,
  );
  if (!artifact)
    throw new Error('Cargo did not report the fluid-host executable.');
  mkdirSync(plan.directory, { recursive: true });
  copyFileSync(artifact.executable, plan.path);
  writeFileSync(
    join(plan.directory, 'manifest.json'),
    JSON.stringify(
      {
        platform,
        arch,
        target: plan.target,
        version,
        sha256: checksum(plan.path),
      },
      null,
      2,
    ) + '\n',
  );
  return plan;
}

export function exportBindings(plan) {
  if (plan.platform !== process.platform || plan.arch !== process.arch)
    throw new Error(
      'Generate bindings with a native executable before packaging another architecture.',
    );
  run(plan.path, ['export']);
}

export function verifyPackagedNative(context, arch) {
  const plan = nativePlan(context.electronPlatformName, arch);
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : join(context.appOutDir, 'resources');
  const path = join(resources, 'native', plan.binary);
  const manifest = JSON.parse(
    readFileSync(join(resources, 'native', 'manifest.json'), 'utf8'),
  );
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (
    manifest.platform !== plan.platform ||
    manifest.arch !== arch ||
    manifest.target !== plan.target ||
    manifest.version !== version ||
    manifest.sha256 !== checksum(path)
  )
    throw new Error(
      `Packaged native host does not match ${plan.platform}/${arch}/${version}.`,
    );
  console.log(`Verified packaged Rust host: ${plan.target} (${version})`);
}
