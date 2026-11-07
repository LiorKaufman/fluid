import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('alpha: archive verification rejects a checksum mismatch before launching the app', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-invalid-archive-'));
  try {
    const os =
      process.platform === 'darwin'
        ? 'mac'
        : process.platform === 'win32'
          ? 'win'
          : 'linux';
    const name = `Fluid-0.0.0-alpha.1-${os}-${process.arch}.${process.platform === 'linux' ? 'tar.gz' : 'zip'}`;
    mkdirSync(join(directory, 'release'));
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ version: '0.0.0-alpha.1' }),
    );
    writeFileSync(join(directory, 'release', name), 'An altered archive');
    writeFileSync(
      join(directory, 'release', 'SHA256SUMS.txt'),
      `${'0'.repeat(64)}  ${name}\n`,
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [resolve('scripts/test-packaged.mjs'), '--archive'],
          { cwd: directory, stdio: 'pipe' },
        ),
      /Alpha archive checksum does not match/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
