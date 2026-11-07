import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksum } from './native.mjs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const archives = readdirSync('release')
  .filter(
    (name) =>
      name.startsWith(`Fluid-${version}-`) && /\.(zip|tar\.gz)$/.test(name),
  )
  .sort();
if (!archives.length) throw new Error('No alpha archives found in release/.');
writeFileSync(
  'release/SHA256SUMS.txt',
  archives
    .map((name) => `${checksum(join('release', name))}  ${name}`)
    .join('\n') + '\n',
);
console.log(`Wrote SHA256SUMS.txt for ${archives.length} archive(s).`);
