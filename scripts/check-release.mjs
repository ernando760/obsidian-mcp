import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
const repository = url?.replace(/^git\+/, '').replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '');
if (!repository || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) || /\/(?:\.|\.\.)$/.test(repository)) throw new Error('Release blocked: the official repository in package.json.repository must be confirmed.');
const names = ['main.js', 'manifest.json', 'obsidian-mcp-cli.mjs', 'install.sh', 'install.ps1'];
const files = await readdir('release');
if (files.length !== 6 || ![...names, 'SHA256SUMS'].every(name => files.includes(name))) throw new Error('Release must contain exactly the five assets and SHA256SUMS');
const lines = (await readFile('release/SHA256SUMS', 'utf8')).trim().split(/\r?\n/);
if (lines.length !== names.length) throw new Error('Incomplete or duplicate checksums');
for (const name of names) {
  const matches = lines.map(line => line.match(/^([a-f0-9]{64})  (\S+)$/)).filter(match => match?.[2] === name);
  if (matches.length !== 1 || createHash('sha256').update(await readFile(`release/${name}`)).digest('hex') !== matches[0][1]) throw new Error(`Invalid checksum: ${name}`);
}
const manifest = JSON.parse(await readFile('release/manifest.json', 'utf8'));
if (manifest.id !== 'obsidian-mcp' || manifest.version !== pkg.version) throw new Error('Manifest/package version mismatch');
if (!(await readFile('release/install.sh', 'utf8')).includes(`official_repo='${repository}'`)) throw new Error('POSIX installer has no matching official default');
if (!(await readFile('release/install.ps1', 'utf8')).includes(`else { '${repository}' }),`)) throw new Error('Windows installer has no matching official default');
const root = await mkdtemp(join(tmpdir(), 'obsidian-mcp-release-check-'));
try {
  const cli = resolve('release/obsidian-mcp-cli.mjs');
  await execute(process.execPath, [cli, '--help'], { cwd: root, timeout: 15000 });
  const vault = join(root, 'vault');
  await mkdir(join(vault, '.obsidian'), { recursive: true });
  const request = join(root, 'request.txt');
  const preload = join(root, 'source-check.mjs');
  await writeFile(preload, `import { writeFileSync } from 'node:fs'; globalThis.fetch = async url => { writeFileSync(process.env.OBSIDIAN_MCP_RELEASE_REQUEST, String(url)); return new Response('{}', {status:404}); };`);
  try {
    await execute(process.execPath, [cli, 'install', '--source', 'remote', '--vault', vault], {
      cwd: root, timeout: 15000,
      env: { ...process.env, OBSIDIAN_MCP_REPOSITORY: '', CODEX_HOME: join(root, 'codex'), XDG_STATE_HOME: join(root, 'state'), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, OBSIDIAN_MCP_RELEASE_REQUEST: request },
    });
    throw new Error('Expected mocked download failure');
  } catch (error) { if (error.code !== 1) throw error; }
  if (await readFile(request, 'utf8') !== `https://api.github.com/repos/${repository}/releases/latest`) throw new Error('Standalone CLI default does not match the official repository');
} finally { await rm(root, { recursive: true, force: true }); }
console.log(`Release ${pkg.version}: five assets, checksums and standalone official source verified. No release was published.`);
