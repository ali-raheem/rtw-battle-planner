// Bumps js/version.js (and package.json's version): `npm run bump` (patch), `npm run bump -- minor`, `npm run bump -- major`.
// Always stamps BUILT with the current UTC time.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../js/version.js', import.meta.url);
const src = readFileSync(file, 'utf8');
const [major, minor, patch] = src.match(/VERSION = '(\d+)\.(\d+)\.(\d+)'/).slice(1).map(Number);
const part = process.argv[2] ?? 'patch';
const next = part === 'major' ? [major + 1, 0, 0] : part === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1];
const built = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

writeFileSync(file, src
  .replace(/VERSION = '[^']*'/, `VERSION = '${next.join('.')}'`)
  .replace(/BUILT = '[^']*'/, `BUILT = '${built}'`));

const pkgFile = new URL('../package.json', import.meta.url);
const pkg = readFileSync(pkgFile, 'utf8');
writeFileSync(pkgFile, pkg.replace(/"version": "[^"]*"/, `"version": "${next.join('.')}"`));
console.log(`version ${next.join('.')} · built ${built}`);
