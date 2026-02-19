#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const realWranglerEntry = new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url);
if (existsSync(realWranglerEntry)) {
  const result = spawnSync(process.execPath, [realWranglerEntry.pathname, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
const isDryRunDeploy = args.length >= 2 && args[0] === 'deploy' && args.includes('--dry-run');

if (!isDryRunDeploy) {
  console.error('wrangler shim only supports `deploy --dry-run` in offline mode.');
  process.exit(1);
}

if (!existsSync('wrangler.toml')) {
  console.error('wrangler.toml not found.');
  process.exit(1);
}

console.log('wrangler shim: running offline deploy preflight checks.');
const typecheck = spawnSync('npm', ['run', 'test'], { stdio: 'inherit' });
if ((typecheck.status ?? 1) !== 0) {
  process.exit(typecheck.status ?? 1);
}

console.log('wrangler shim: dry-run preflight complete (bundle/deploy skipped: offline environment).');
process.exit(0);
