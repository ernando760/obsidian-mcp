import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, copyFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { build } from 'esbuild';
import { repositoryName, releaseRepository, officialRepository } from '../cli/repository';

const execute = promisify(execFile);
let root: string;
const repository = 'release-fixture/obsidian-mcp';
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'obsidian-mcp-release-fixture-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  pkg.repository = { type: 'git', url: `https://github.com/${repository}.git` };
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  for (const name of ['manifest.json', 'install.sh', 'install.ps1']) await copyFile(name, join(root, name));
  await writeFile(join(root, 'main.js'), 'module.exports = {};');
  const cli = await build({
    entryPoints: ['cli/entry.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    plugins: [{ name: 'fixture-official-repository', setup(builder) {
      builder.onLoad({ filter: /package\.json$/ }, args => args.path === resolve('package.json') ? { contents: JSON.stringify(pkg), loader: 'json' } : undefined);
    } }],
  });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/obsidian-mcp-cli.mjs'), cli.outputFiles[0]!.text);
  return pkg;
}
async function prepare(env: NodeJS.ProcessEnv = {}) {
  return execute(process.execPath, [resolve('scripts/release.mjs')], { cwd: root, env: { ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'release-preparation', ...env }, timeout: 30000 });
}
describe('release source precedence', () => {
  it.each(['owner/repo', 'https://github.com/owner/repo.git', 'git+https://github.com/owner/repo.git', 'git@github.com:owner/repo.git'])('normalizes %s without inventing a repository', value => {
    expect(repositoryName(value)).toBe('owner/repo');
  });
  it('allows arguments and environment to override a stored or official source', () => {
    expect(releaseRepository('argument/repo', 'environment/repo', 'stored/repo')).toBe('argument/repo');
    expect(releaseRepository(undefined, 'environment/repo', 'stored/repo')).toBe('environment/repo');
    expect(releaseRepository(undefined, '', 'stored/repo')).toBe('stored/repo');
    expect(releaseRepository()).toBe(officialRepository);
  });
  it.each(['../repo', 'https://attacker.example/owner/repo', 'owner/..', 'owner/repo;command', { type: 'git' }])('refuses invalid official metadata %j', value => {
    expect(() => repositoryName(value)).toThrow();
  });
});
describe('release preparation gates', () => {
  it('locks native optional dependencies for every supported installer platform', async () => {
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    for (const tool of ['rolldown', 'esbuild']) {
      const parent = lock.packages[`node_modules/${tool}`];
      for (const [name, version] of Object.entries(parent.optionalDependencies)) {
        if (!name.startsWith(`@${tool}/`)) continue;
        const entry = lock.packages[`node_modules/${name}`];
        expect(entry, `Missing native dependency: ${name}`).toBeDefined();
        expect(entry.version).toBe(version);
        expect(entry.optional).toBe(true);
        expect(entry.integrity).toMatch(/^sha512-/);
      }
    }
  });
  it('does not create distributable artifacts when the official source is missing', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    await copyFile('manifest.json', join(root, 'manifest.json'));
    await expect(prepare()).rejects.toMatchObject({ code: 1 });
    expect(await readdir(root)).not.toContain('release');
  });
  it('stamps both installers and verifies the standalone CLI default, hashes and version', async () => {
    const pkg = await fixture();
    await prepare();
    await execute(process.execPath, [resolve('scripts/check-release.mjs')], { cwd: root, timeout: 30000 });
    expect(await readFile(join(root, 'release/install.sh'), 'utf8')).toContain(`official_repo='${repository}'`);
    expect(await readFile(join(root, 'release/install.ps1'), 'utf8')).toContain(`else { '${repository}' }),`);
    expect(JSON.parse(await readFile(join(root, 'release/manifest.json'), 'utf8')).version).toBe(pkg.version);
    await writeFile(join(root, 'release/install.sh'), 'tampered');
    await expect(execute(process.execPath, [resolve('scripts/check-release.mjs')], { cwd: root })).rejects.toMatchObject({ code: 1 });
  });
  it('refuses a mismatched release tag, but permits branch-based CI checks', async () => {
    await fixture();
    await expect(prepare({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' })).rejects.toMatchObject({ code: 1 });
    await prepare({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'feature/first-release' });
    expect(await readdir(join(root, 'release'))).toContain('SHA256SUMS');
  });
});
