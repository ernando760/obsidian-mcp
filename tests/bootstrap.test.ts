import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { parse } from 'smol-toml';
import { permissionSnapshot } from './capabilities';
import { credentialsProtected } from '../cli/permissions';

const execute = promisify(execFile);
const windows = process.platform === 'win32';
let root: string, capture: string, installDir: string, binDir: string, env: NodeJS.ProcessEnv;
let fixture: { release: Record<string, unknown>; responses: Record<string, string> };
const repo = 'test/obsidian-mcp', tag = 'v0.1.0';
const api = `https://api.github.com/repos/${repo}/releases/`;
const base = `https://github.com/${repo}/releases/download/${tag}/`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'obsidian-mcp-bootstrap-test-'));
  capture = join(root, 'capture.json'); installDir = join(root, "CLI d'água com espaços"); binDir = join(root, 'bin com espaços');
  const cli = `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.OBSIDIAN_MCP_TEST_CAPTURE, JSON.stringify(process.argv.slice(2))); process.exitCode = Number(process.env.OBSIDIAN_MCP_TEST_EXIT || 0);`;
  const digest = createHash('sha256').update(cli).digest('hex');
  const release = { tag_name: tag, draft: false, prerelease: false, assets: [
    { name: 'obsidian-mcp-cli.mjs', browser_download_url: `${base}obsidian-mcp-cli.mjs`, digest: `sha256:${digest}` },
    { name: 'SHA256SUMS', browser_download_url: `${base}SHA256SUMS` },
  ] };
  fixture = { release, responses: { [`${base}obsidian-mcp-cli.mjs`]: cli, [`${base}SHA256SUMS`]: `${digest}  obsidian-mcp-cli.mjs\n` } };
  const preload = join(root, 'mock-fetch.mjs');
  await writeFile(preload, `import { readFileSync, appendFileSync } from 'node:fs';
    globalThis.fetch = async url => {
      const fixture = JSON.parse(readFileSync(process.env.OBSIDIAN_MCP_TEST_FIXTURE, 'utf8'));
      appendFileSync(process.env.OBSIDIAN_MCP_TEST_REQUESTS, String(url)+'\\n');
      if (String(url).startsWith('${api}')) return new Response(JSON.stringify(fixture.release));
      return new Response(fixture.responses[String(url)] ?? 'missing', { status: fixture.responses[String(url)] === undefined ? 404 : 200 });
    };`);
  env = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, OBSIDIAN_MCP_TEST_CAPTURE: capture, OBSIDIAN_MCP_TEST_FIXTURE: join(root, 'fixture.json'), OBSIDIAN_MCP_TEST_REQUESTS: join(root, 'requests.txt') };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function run(options: { update?: boolean; version?: boolean; exit?: number; omitVault?: boolean; automatic?: boolean; port?: number; source?: 'argument' | 'environment' | 'default' } = {}) {
  await writeFile(env.OBSIDIAN_MCP_TEST_FIXTURE!, JSON.stringify(fixture));
  const vault = join(root, 'Meu vault com espaços');
  const source = options.source ?? 'argument';
  const childEnv = { ...env, OBSIDIAN_MCP_TEST_EXIT: String(options.exit ?? 0), OBSIDIAN_MCP_REPOSITORY: source === 'environment' ? repo : source === 'default' ? '' : 'ignored/environment' };
  const originalScript = resolve(windows ? 'install.ps1' : 'install.sh');
  const bootstrapScript = join(root, windows ? 'prepared-install.ps1' : 'prepared-install.sh');
  const defaultRepo = source === 'default' ? repo : 'ignored/default';
  const script = (await readFile(originalScript, 'utf8')).replace(/^official_repo='[^']*'$/m, `official_repo='${defaultRepo}'`).replace(/else \{ '[^']*' \}\),/, `else { '${defaultRepo}' }),`);
  await writeFile(bootstrapScript, script);
  if (!windows) {
    return execute('sh', [bootstrapScript, ...(source === 'argument' ? ['--repo', repo] : []), '--install-dir', installDir, '--bin-dir', binDir,
      ...(options.omitVault ? [] : ['--vault', vault]), ...(options.automatic ? [] : ['--manual', '--no-enable']), ...(options.port ? ['--port', String(options.port)] : []), ...(options.version ? ['--version', tag] : []), ...(options.update ? ['--update'] : [])], { env: childEnv, timeout: 90000 });
  }
  // Invoke the actual Windows installer with a network stub in the parent
  // PowerShell scope. Native ACLs and the Node argv boundary still execute.
  const harness = join(root, 'harness.ps1');
  await writeFile(harness, `
    function Invoke-WebRequest {
      param([string]$Uri, [string]$OutFile, [switch]$PassThru, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec, $Headers)
      $fixture = Get-Content -LiteralPath $env:OBSIDIAN_MCP_TEST_FIXTURE -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($Uri.StartsWith('${api}')) { $content = $fixture.release | ConvertTo-Json -Depth 10 }
      else { $content = $fixture.responses.PSObject.Properties[$Uri].Value }
      if ($null -eq $content) { throw 'Mock 404' }
      [IO.File]::WriteAllText($OutFile, $content, [Text.UTF8Encoding]::new($false))
      return [pscustomobject]@{ BaseResponse = [pscustomobject]@{ ResponseUri = [uri]$Uri } }
    }
    $arguments = @{ InstallDir=$env:OBSIDIAN_MCP_TEST_INSTALL; Manual=$${options.automatic ? 'false' : 'true'}; NoEnable=$${options.automatic ? 'false' : 'true'} }
    ${source === 'argument' ? `$arguments.Repo='${repo}'` : ''}
    ${options.port ? `$arguments.Port=${options.port}` : ''}
    ${options.omitVault ? '' : '$arguments.Vault=$env:OBSIDIAN_MCP_TEST_VAULT'}
    ${options.version ? `$arguments.Version='${tag}'` : ''}
    ${options.update ? '$arguments.Update=$true' : ''}
    & $env:OBSIDIAN_MCP_TEST_SCRIPT @arguments
  `);
  return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harness], { env: { ...childEnv, OBSIDIAN_MCP_TEST_INSTALL: installDir, OBSIDIAN_MCP_TEST_VAULT: vault, OBSIDIAN_MCP_TEST_SCRIPT: bootstrapScript }, timeout: 90000 });
}

describe('native bootstrap installer (mock GitHub release, real Node process)', () => {
  it('verifies downloads, installs a standalone CLI and forwards paths/manual settings intact', async () => {
    await run();
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['install', '--source', 'remote', '--repo', repo, '--version', tag,
      '--vault', join(root, 'Meu vault com espaços'), '--manual', '--no-enable']);
    expect(await readFile(join(installDir, 'obsidian-mcp-cli.mjs'), 'utf8')).toBe(fixture.responses[`${base}obsidian-mcp-cli.mjs`]);
    const launcher = windows ? join(installDir, 'obsidian-mcp.cmd') : join(binDir, 'obsidian-mcp');
    await access(launcher);
    if (!windows) {
      await execute(launcher, ['doctor', '--vault', join(root, 'Outro vault')], { env });
      expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(['doctor', '--vault', join(root, 'Outro vault')]);
      expect(await readFile(env.OBSIDIAN_MCP_TEST_REQUESTS!, 'utf8')).toContain(`${api}latest`);
    }
  });
  it.each(['environment', 'default'] as const)('uses the %s repository when no argument is provided', async source => {
    await run({ source });
    const args = JSON.parse(await readFile(capture, 'utf8'));
    expect(args[args.indexOf('--repo') + 1]).toBe(repo);
  });
  it('delegates discovery to the CLI when no vault is supplied', async () => {
    await run({ omitVault: true });
    expect(JSON.parse(await readFile(capture, 'utf8'))).not.toContain('--vault');
  });
  it('can replace a previous CLI after verifying the new download', async () => {
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, 'obsidian-mcp-cli.mjs'), 'old CLI');
    await run({ update: true });
    expect(await readFile(join(installDir, 'obsidian-mcp-cli.mjs'), 'utf8')).toBe(fixture.responses[`${base}obsidian-mcp-cli.mjs`]);
    expect(JSON.parse(await readFile(capture, 'utf8'))[0]).toBe('update');
  });
  it('pins an explicit release and delegates update to the CLI', async () => {
    await run({ update: true, version: true });
    const args = JSON.parse(await readFile(capture, 'utf8'));
    expect(args[0]).toBe('update'); expect(args[args.indexOf('--version') + 1]).toBe(tag);
  });
  it('never executes or replaces an existing CLI when the checksum does not match', async () => {
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, 'obsidian-mcp-cli.mjs'), 'original');
    fixture.responses[`${base}obsidian-mcp-cli.mjs`] += '\n// tampered';
    await expect(run()).rejects.toThrow();
    expect(await readFile(join(installDir, 'obsidian-mcp-cli.mjs'), 'utf8')).toBe('original');
    await expect(access(capture)).rejects.toThrow();
  });
  it('refuses absent checksum entries, invalid asset URLs and draft releases', async () => {
    const sums = fixture.responses[`${base}SHA256SUMS`]!;
    fixture.responses[`${base}SHA256SUMS`] = '';
    await expect(run()).rejects.toThrow();
    fixture.responses[`${base}SHA256SUMS`] = sums;
    (fixture.release.assets as Array<{ browser_download_url: string }>)[0]!.browser_download_url = 'https://attacker.example/cli';
    await expect(run()).rejects.toThrow();
    fixture.release.draft = true;
    await expect(run()).rejects.toThrow();
    await expect(access(capture)).rejects.toThrow();
  });
  it('propagates a CLI failure rather than reporting a successful installation', async () => {
    await expect(run({ exit: 37 })).rejects.toMatchObject({ code: 37 });
  });
});


describe('release lifecycle with the actual bundled CLI', () => {
  it('installs, updates and uninstalls while preserving existing notes and settings', async () => {
    const bundled = await build({
      entryPoints: ['cli/entry.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
      banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    });
    const cli = bundled.outputFiles[0]!.text;
    const plugin = await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron'], write: false });
    function release(version: string) {
      const releaseTag = `v${version}`;
      const base = `https://github.com/${repo}/releases/download/${releaseTag}/`;
      const assets: Record<string, string> = {
        'obsidian-mcp-cli.mjs': cli,
        'main.js': plugin.outputFiles[0]!.text + `\n// Release fixture ${version}\n`,
        'manifest.json': JSON.stringify({ id: 'obsidian-mcp', name: 'Obsidian MCP', version, minAppVersion: '1.8.7', isDesktopOnly: true }),
      };
      assets.SHA256SUMS = Object.entries(assets).map(([name, data]) => `${createHash('sha256').update(data).digest('hex')}  ${name}`).join('\n');
      fixture = {
        release: { tag_name: releaseTag, draft: false, prerelease: false, assets: Object.entries(assets).map(([name, data]) => ({ name, browser_download_url: `${base}${name}`, digest: `sha256:${createHash('sha256').update(data).digest('hex')}` })) },
        responses: Object.fromEntries(Object.entries(assets).map(([name, data]) => [`${base}${name}`, data])),
      };
    }
    const vault = join(root, 'Meu vault com espaços');
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    await mkdir(join(vault, 'Notas'));
    const note = join(vault, 'Notas/preexistente.md');
    const bytes = Buffer.from('# Nota preexistente\nNão alterar: conteúdo privado de teste.\n');
    await writeFile(note, bytes);
    const notePermissions = await permissionSnapshot(note);
    await writeFile(join(vault, '.obsidian/community-plugins.json'), '["other-plugin"]');
    env.CODEX_HOME = join(root, 'Codex com espaços');
    env.XDG_STATE_HOME = join(root, 'state');
    await mkdir(env.CODEX_HOME);
    await writeFile(join(env.CODEX_HOME, 'config.toml'), 'model = "release-fixture"\n[mcp_servers.other]\ncommand = "unrelated"\n');
    release('0.1.0');
    await run({ automatic: true, port: 28124 });
    const folder = join(vault, '.obsidian/plugins/obsidian-mcp');
    const dataPath = join(folder, 'data.json');
    const settings = JSON.parse(await readFile(dataPath, 'utf8'));
    const custom = Buffer.from(JSON.stringify({ ...settings, allowedFolders: ['Notas'] }, null, '\t') + '\r\n');
    await writeFile(dataPath, custom);
    const metadata = JSON.parse(await readFile(join(folder, '.installer.json'), 'utf8'));
    expect(metadata.codex.managed).toBe(true);
    expect(await credentialsProtected(dataPath)).toBe(true);
    release('0.1.1');
    await run({ automatic: true, update: true, port: 28124 });
    expect(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')).version).toBe('0.1.1');
    expect(await readFile(dataPath)).toEqual(custom);
    expect(JSON.parse(await readFile(dataPath, 'utf8')).token).toBe(settings.token);
    expect(await credentialsProtected(dataPath)).toBe(true);
    expect(await readFile(note)).toEqual(bytes);
    expect(await permissionSnapshot(note)).toBe(notePermissions);
    const configPath = join(env.CODEX_HOME, 'config.toml');
    const config = parse(await readFile(configPath, 'utf8'));
    expect(config.model).toBe('release-fixture');
    expect(Object.keys(config.mcp_servers as object)).toHaveLength(2);
    await execute(process.execPath, [join(installDir, 'obsidian-mcp-cli.mjs'), 'uninstall', '--vault', vault, '--yes'], { env, timeout: 60000 });
    await expect(access(folder)).rejects.toThrow();
    expect(await readFile(note)).toEqual(bytes);
    expect(await permissionSnapshot(note)).toBe(notePermissions);
    expect(JSON.parse(await readFile(join(vault, '.obsidian/community-plugins.json'), 'utf8'))).toEqual(['other-plugin']);
    const after = parse(await readFile(configPath, 'utf8'));
    expect(after.model).toBe('release-fixture');
    expect(Object.keys(after.mcp_servers as object)).toEqual(['other']);
  }, 120000);
});
