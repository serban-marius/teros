#!/usr/bin/env node
// Generate the union of every MCA's external dependencies into a package.json
// that the mca-runtime images install at build time.
//
// Why this exists (build-cache correctness):
//   The Dockerfiles must NOT `COPY mcas/` to compute the union, because that
//   busts the `npm install` layer whenever ANY MCA *source* file changes.
//   Instead we emit small files here; each Dockerfile COPYs only its own, so
//   the (expensive) install layer is cached and only re-runs when a
//   dependency actually changes.
//
// Two flavours are emitted:
//   docker/mca-runtime/deps.generated.json             → generic image, EXCLUDES
//                                                         the heavy browser stack
//   docker/mca-runtime-playwright/deps.generated.json  → playwright image, the
//                                                         FULL union incl. browsers
//   docker/mca-runtime-computer/deps.generated.json    → computer image: ONLY the
//                                                         deps of the MCAs it runs
//                                                         (one per desktop, so lean)
//
// Run from repo root (build.sh / deploy-server.sh do this before `docker build`):
//   node scripts/gen-mca-union-deps.mjs

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCAS_DIR = join(ROOT, 'mcas');

// The heavy browser stack lives only in the playwright image, not the generic one.
const BROWSER_DEPS = new Set([
  'playwright',
  'playwright-core',
  'chromium-bidi',
  '@browserbasehq/sdk',
]);
// Never installable from npm as a normal dep.
//   @teros/*      → baked as symlinks to /opt/teros-sdk
//   mca.* cross-refs → other MCAs, not npm packages
const isNonNpm = (name) => name.startsWith('@teros/') || name.startsWith('mca.');

// Collect the full union once.
const all = {};
for (const dir of readdirSync(MCAS_DIR)) {
  const pj = join(MCAS_DIR, dir, 'package.json');
  if (!existsSync(pj)) continue;
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    if (isNonNpm(name)) continue;
    // First declaration wins; the monorepo shares one lockfile so ranges align.
    all[name] ??= range;
  }
}

function emit(outPath, includeBrowser) {
  const picked = Object.keys(all)
    .filter((k) => includeBrowser || !BROWSER_DEPS.has(k))
    .sort();
  const deps = Object.fromEntries(picked.map((k) => [k, all[k]]));
  writeFileSync(
    join(ROOT, outPath),
    JSON.stringify({ name: 'mca-deps', private: true, dependencies: deps }, null, 2) + '\n',
  );
  console.log(`[gen-mca-union-deps] ${picked.length} deps -> ${outPath}`);
}

emit('docker/mca-runtime/deps.generated.json', false);
emit('docker/mca-runtime-playwright/deps.generated.json', true);

// Dedicated images that serve a single MCA install only that MCA's deps.
function emitOnly(outPath, mcaIds) {
  const deps = {};
  for (const id of mcaIds) {
    const pkg = JSON.parse(readFileSync(join(MCAS_DIR, id, 'package.json'), 'utf8'));
    for (const [name, range] of Object.entries(pkg.dependencies || {})) {
      if (!isNonNpm(name)) deps[name] ??= range;
    }
  }
  const sorted = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
  writeFileSync(
    join(ROOT, outPath),
    JSON.stringify({ name: 'mca-deps', private: true, dependencies: sorted }, null, 2) + '\n',
  );
  console.log(`[gen-mca-union-deps] ${Object.keys(sorted).length} deps -> ${outPath}`);
}

emitOnly('docker/mca-runtime-computer/deps.generated.json', ['mca.teros.computer']);
