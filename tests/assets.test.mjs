import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);

test('the service worker caches every script, stylesheet and icon', () => {
  const sw = readFileSync(new URL('sw.js', root), 'utf8');
  const cached = new Set([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));
  for (const dir of ['js', 'css', 'icons']) {
    for (const f of readdirSync(new URL(`${dir}/`, root))) {
      assert.ok(cached.has(`${dir}/${f}`), `${dir}/${f} is missing from ASSETS in sw.js`);
    }
  }
});

test('version.js has a semver version and an ISO build time', async () => {
  const { VERSION, BUILT } = await import('../js/version.js');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(!Number.isNaN(Date.parse(BUILT)));
});

test('the manifest pins its app id instead of deriving it from start_url', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  // Must stay exactly this: it matches the id installed copies already have, and
  // changing it makes browsers treat the app as a different one.
  assert.equal(manifest.id, '/rtw/');
});
