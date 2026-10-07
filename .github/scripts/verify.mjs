// Gate for Shopify/shop. Proves that the checkout is a complete, runnable @shopify/shop
// package plus repository configuration, and that package contents change only through
// releases. Node >= 22, built-ins only, no install step.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = (process.env.VERIFY_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const PACKAGE_NAME = '@shopify/shop';
// A trailing slash covers a directory.
const GOVERNANCE = ['.github/', '.gitattributes', '.gitignore', 'SECURITY.md', 'CODE_OF_CONDUCT.md'];
const PLUGIN_MANIFESTS = [
  'plugins/shop/plugin.json',
  'plugins/shop/.claude-plugin/plugin.json',
  'plugins/shop/.codex-plugin/plugin.json',
];
const PLUGIN_SOURCE = './plugins/shop';

const native = (posixPath) => join(root, ...posixPath.split('/'));
const parseJson = (text, label) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
};
const readJson = (posixPath) => {
  const file = native(posixPath);
  assert.ok(existsSync(file), `${posixPath} is missing; it must be present at the repository root`);
  return parseJson(readFileSync(file, 'utf8'), posixPath);
};
const isGovernance = (path) => GOVERNANCE.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
const pass = (message) => console.log(`ok  ${message}`);
const run = (file, args, options = {}) =>
  execFileSync(file, args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, ...options });
const git = (...args) => run('git', args).toString('utf8');
// The WASI host writes an experimental warning to stderr; only stdout bytes matter.
const shop = (...args) => {
  try {
    return run(process.execPath, ['bin/shop.mjs', ...args]);
  } catch (error) {
    assert.fail(`bin/shop.mjs ${args.join(' ')} exited with status ${error.status ?? 'unknown'} under Node ${process.version}; the module or host does not run on this platform`);
  }
};
const isPublished = async (version) => {
  const url = `${registry}/${PACKAGE_NAME.replace('/', '%2F')}/${version}`;
  let response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    assert.fail(`${url} is unreachable (${error.cause?.message || error.message}); the registry check needs network access`);
  }
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  assert.fail(`${url} returned ${response.status}; expected 200 or 404`);
};

async function main() {
  // (a) one version everywhere
  const pkg = readJson('package.json');
  assert.ok(pkg.name === PACKAGE_NAME, `package.json: name must be ${PACKAGE_NAME}`);
  assert.ok(typeof pkg.version === 'string', 'package.json: version must be a string');
  const version = pkg.version;
  for (const manifest of PLUGIN_MANIFESTS) {
    const plugin = readJson(manifest);
    assert.ok(plugin.version === version, `${manifest}: version ${plugin.version} differs from package.json (${version})`);
  }
  pass(`package.json and ${PLUGIN_MANIFESTS.length} plugin manifests carry version ${version}`);

  // (b) the tracked files are the package plus repository configuration
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  assert.ok(tracked.length > 0, 'git ls-files returned nothing; run verify.mjs inside the repository checkout');
  const productSet = new Set(tracked.filter((path) => !isGovernance(path)));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packReport = run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { shell: process.platform === 'win32' }).toString('utf8');
  const packed = new Set(parseJson(packReport, 'npm pack --json output')[0].files.map((entry) => entry.path.replaceAll('\\', '/')));
  for (const path of productSet) {
    assert.ok(packed.has(path), `${path} is tracked but the package does not ship it; this repository holds only the published package and its configuration`);
  }
  for (const path of packed) {
    assert.ok(productSet.has(path), `${path} would ship but is not tracked`);
  }
  pass(`npm pack would ship exactly the ${packed.size} tracked package files`);

  // (c) exactly one module
  const modules = [...productSet].filter((path) => path.endsWith('.wasm'));
  assert.ok(modules.length === 1 && modules[0] === 'lib/shop.wasm', `the package must ship exactly one .wasm file, lib/shop.wasm; found ${modules.length ? modules.join(', ') : 'none'}`);
  pass('lib/shop.wasm is the only module');

  // (d) marketplace catalogs point at the bundled plugin
  const claude = readJson('.claude-plugin/marketplace.json');
  assert.ok(claude.name === 'shop', '.claude-plugin/marketplace.json: name must be "shop"');
  const claudeEntry = (claude.plugins || []).find((entry) => entry?.name === 'shop');
  assert.ok(claudeEntry, '.claude-plugin/marketplace.json: missing plugin entry named "shop"');
  assert.ok(claudeEntry.source === PLUGIN_SOURCE, `.claude-plugin/marketplace.json: plugin "shop" source must be ${PLUGIN_SOURCE}`);
  const agents = readJson('.agents/plugins/marketplace.json');
  assert.ok(agents.name === 'shop', '.agents/plugins/marketplace.json: name must be "shop"');
  const agentsEntry = (agents.plugins || []).find((entry) => entry?.name === 'shop');
  assert.ok(agentsEntry, '.agents/plugins/marketplace.json: missing plugin entry named "shop"');
  assert.ok(agentsEntry.source?.path === PLUGIN_SOURCE, `.agents/plugins/marketplace.json: plugin "shop" source.path must be ${PLUGIN_SOURCE}`);
  const pluginDir = native(PLUGIN_SOURCE.replace(/^\.\//, ''));
  assert.ok(existsSync(pluginDir) && statSync(pluginDir).isDirectory(), `${PLUGIN_SOURCE} is not a directory in this checkout`);
  pass('both marketplace catalogs name "shop" and resolve to plugins/shop');

  // (e) the module runs under this Node and reports the package version
  const banner = shop('--version').toString('utf8');
  const expectedBanner = `shop ${version} (ucp `;
  assert.ok(banner.startsWith(expectedBanner), `bin/shop.mjs --version printed ${JSON.stringify(banner.split('\n')[0])}; expected it to start with ${JSON.stringify(expectedBanner)}`);
  pass(`bin/shop.mjs --version reports ${version}`);

  // (f) the embedded skill is byte-identical to the shipped skill files
  const skillDir = 'skills/shop';
  assert.ok(Buffer.compare(shop('skill'), readFileSync(native(`${skillDir}/SKILL.md`))) === 0, `${skillDir}/SKILL.md differs from the bytes embedded in the module (shop skill)`);
  const references = readdirSync(native(`${skillDir}/references`)).filter((name) => name.endsWith('.md')).sort();
  assert.ok(references.length > 0, `${skillDir}/references contains no .md files`);
  for (const name of references) {
    const embedded = shop('skill', `references/${name}`);
    assert.ok(Buffer.compare(embedded, readFileSync(native(`${skillDir}/references/${name}`))) === 0, `${skillDir}/references/${name} differs from the bytes embedded in the module (shop skill references/${name})`);
  }
  pass(`shop skill matches SKILL.md and ${references.length} references byte-for-byte`);

  // (g) on a pull request, a package change carries a version the registry does not have yet
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    pass('base comparison and registry check run on pull requests only');
    return;
  }
  let base;
  try {
    base = git('rev-parse', '--verify', '--quiet', 'HEAD^1').trim();
  } catch {
    base = '';
  }
  assert.ok(base, 'base commit unavailable; verify.yml must check out with fetch-depth 2');
  const changed = git('diff', '--name-only', '-z', 'HEAD^1', 'HEAD').split('\0').filter(Boolean).filter((path) => !isGovernance(path));
  if (changed.length === 0) {
    pass('configuration-only change; package contents unchanged');
    return;
  }
  let baseVersion = null;
  try {
    baseVersion = parseJson(git('show', 'HEAD^1:package.json'), 'package.json at the base commit').version ?? null;
  } catch (error) {
    if (!(error instanceof Error && 'status' in error)) throw error;
  }
  const published = await isPublished(version);
  if (version === baseVersion) {
    assert.ok(!published, `package contents changed at version ${version}, which is already published; package contents change only through a release, which carries a new version`);
  }
  assert.ok(!published, `${PACKAGE_NAME}@${version} is already published; a release carries a new version`);
  pass(`package contents changed from ${baseVersion ?? 'none'} to ${version}, which is not yet on ${registry}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // The ::error:: form surfaces the first failure in the pull request UI without a stack dump.
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : `verify: ${message}`);
  process.exit(1);
}
