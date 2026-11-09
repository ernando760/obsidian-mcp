import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { credentialsProtected } from '../cli/permissions';
import { fileSymlinks, windows } from './capabilities';
import type { Runtime } from '../cli/runtime';
import { atomicWrite, json, transaction, withLock } from '../cli/files';
import { chooseVault, discoverVaults, registry, validateVault, type Vault } from '../cli/vaults';
import { install, uninstall } from '../cli/installer';
import { configureCodex, endpoint, inspectCodex, serverName } from '../cli/codex';
import { remoteArtifacts } from '../cli/artifacts';
import { doctor, probeServer } from '../cli/doctor';
import { loadSettings } from '../src/settings';

let root: string, home: string, project: string, vault: Vault, rt: Runtime;
let messages: string[];
const info = { id: 'obsidian-mcp', name: 'Obsidian MCP', version: '0.1.0', minAppVersion: '1.8.7', isDesktopOnly: true };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'obsidian-mcp-cli-'));
  home = join(root, 'home'); project = join(root, 'project');
  await mkdir(home); await mkdir(project);
  await mkdir(join(root, 'Vault com espaços/.obsidian'), { recursive: true });
  vault = await validateVault(join(root, 'Vault com espaços'));
  await writeFile(join(project, 'manifest.json'), json(info));
  await writeFile(join(project, 'main.js'), 'module.exports = class Plugin {};');
  messages = [];
  rt = {
    home, env: {}, log: message => messages.push(message),
    fetch: vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    runCodex: vi.fn(async () => ({ available: false, ok: false, stdout: '' })),
    portAvailable: vi.fn(async () => true),
  };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const local = () => ({ project });
const configPath = () => join(home, '.codex/config.toml');
const dataPath = () => join(vault.plugin, 'data.json');
const readConfig = async () => parse(await readFile(configPath(), 'utf8')) as Record<string, any>;

async function remoteFixture(options: { checksums?: boolean; corrupt?: boolean; tag?: string } = {}) {
  const tag = options.tag ?? '0.2.0';
  const artifacts: Record<string, string> = { 'main.js': 'module.exports = class Updated {};', 'manifest.json': json({ ...info, version: '0.2.0' }) };
  artifacts.SHA256SUMS = Object.entries(artifacts).map(([name, data]) => `${createHash('sha256').update(data).digest('hex')}  ${name}`).join('\n');
  const release = { tag_name: tag, draft: false, prerelease: false, assets: Object.entries(artifacts).map(([name, data]) => ({ name,
    browser_download_url: `https://github.com/test/obsidian-mcp/releases/download/${tag}/${name}`,
    digest: options.checksums ? null : `sha256:${createHash('sha256').update(data).digest('hex')}`,
  })) };
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/test/obsidian-mcp/releases/')) return new Response(JSON.stringify(release));
    const name = url.split('/').at(-1)!;
    return new Response(options.corrupt && name === 'main.js' ? 'corrupt' : artifacts[name], { status: artifacts[name] ? 200 : 404 });
  });
  rt.fetch = fetcher as typeof fetch;
  return { release, fetcher };
}

function mockMcp(settings: ReturnType<typeof loadSettings>, version = '0.1.0') {
  const methods: string[] = [];
  rt.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (new Headers(init?.headers).get('Authorization') !== `Bearer ${settings.token}`) return new Response('{}', { status: 401 });
    const rpc = JSON.parse(String(init?.body)); methods.push(rpc.method);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'obsidian-mcp', version } };
    else if (rpc.method === 'tools/list') result = { tools: ['list_notes', 'read_note', 'search_notes', 'create_note', 'create_folder'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return methods;
}

describe('CLI vault discovery and boundaries', () => {
  it('requires an existing Obsidian configuration directory', async () => {
    await expect(validateVault(project)).rejects.toThrow('Vault inválido');
    await expect(validateVault(vault.vault, '../escape')).rejects.toThrow();
  });
  it('discovers native/Flatpak vaults, removes duplicates and ignores stale entries', async () => {
    rt.platform = 'linux';
    const native = join(home, '.config/obsidian');
    await mkdir(native, { recursive: true });
    await writeFile(join(native, 'obsidian.json'), json({ vaults: { a: { path: vault.vault }, b: { path: '/missing' } } }));
    const flatpak = join(home, '.var/app/md.obsidian.Obsidian/config/obsidian');
    await mkdir(flatpak, { recursive: true });
    await writeFile(join(flatpak, 'obsidian.json'), json({ vaults: { duplicate: { path: vault.vault } } }));
    expect(await discoverVaults(rt)).toEqual([{ vault: vault.vault, configDir: '.obsidian' }]);
    rt.ask = vi.fn(async () => '1');
    expect((await chooseVault(rt)).vault).toBe(vault.vault);
  });
  it('accepts a manually entered path and requires it outside a terminal', async () => {
    await expect(chooseVault(rt)).rejects.toThrow('--vault');
    rt.ask = async () => vault.vault;
    expect((await chooseVault(rt)).vault).toBe(vault.vault);
  });
  it('refuses symlinks in plugin and Codex destinations', async () => {
    await mkdir(join(vault.config, 'plugins'));
    await symlink(project, join(vault.config, 'plugins/obsidian-mcp'), windows ? 'junction' : 'dir');
    await expect(validateVault(vault.vault)).rejects.toThrow('Link simbólico');
    await expect(atomicWrite(join(vault.plugin, 'main.js'), 'unsafe')).rejects.toThrow();
  });
  it.skipIf(windows)('rolls back already-written files if a later write fails', async () => {
    const first = join(root, 'first'); const locked = join(root, 'read-only');
    await writeFile(first, 'original'); await chmod(first, 0o640);
    await mkdir(locked, { mode: 0o500 });
    try {
      await expect(transaction([{ path: first, data: 'replacement' }, { path: join(locked, 'second'), data: 'fail' }])).rejects.toThrow();
      expect(await readFile(first, 'utf8')).toBe('original');
      expect((await stat(first)).mode & 0o777).toBe(0o640);
    } finally { await chmod(locked, 0o700); }
  });
  it('fails safely if a lock already exists', async () => {
    const lock = join(root, 'lock'); await writeFile(lock, 'another process');
    await expect(withLock(lock, async () => true)).rejects.toThrow('lock obsoleto');
    expect(await readFile(lock, 'utf8')).toBe('another process');
  });
});

describe('CLI install and update', () => {
  it('installs artifacts, private credentials, activation and Codex without a CLI', async () => {
    const result = await install(rt, vault, local());
    expect(result.codex.managed).toBe(true);
    expect(await readFile(join(vault.plugin, 'main.js'), 'utf8')).toContain('class Plugin');
    expect(await credentialsProtected(dataPath())).toBe(true);
    expect(await credentialsProtected(configPath())).toBe(true);
    expect((await stat(join(vault.vault, 'MCP'))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(vault.config, 'community-plugins.json'), 'utf8'))).toEqual(['obsidian-mcp']);
    expect(await inspectCodex(rt, result.settings, result.codex.name)).toBe(true);
    expect(messages.join('\n')).not.toContain(result.settings.token);
    expect(await registry(rt)).toHaveLength(1);
  });
  it('is idempotent and preserves settings bytes, artifact modes, allowedFolders and other plugins', async () => {
    await writeFile(join(vault.config, 'community-plugins.json'), json(['another-plugin']));
    const first = await install(rt, vault, local());
    const custom = json({ ...first.settings, allowedFolders: [], port: 28000 });
    await writeFile(dataPath(), custom); await chmod(dataPath(), 0o640);
    await chmod(join(vault.plugin, 'main.js'), 0o640);
    // Updating the port manually means the existing owned entry must not be replaced silently.
    const second = await install(rt, vault, local(), true);
    expect(await readFile(dataPath(), 'utf8')).toBe(custom);
    expect(await credentialsProtected(dataPath())).toBe(true);
    if (!windows) expect((await stat(join(vault.plugin, 'main.js'))).mode & 0o777).toBe(0o640);
    expect(second.settings.allowedFolders).toEqual([]);
    expect(await registry(rt)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(vault.config, 'community-plugins.json'), 'utf8'))).toEqual(['another-plugin', 'obsidian-mcp']);
    expect(Object.keys((await readConfig()).mcp_servers)).toHaveLength(1);
  });
  it.skipIf(windows).each([
    { updating: false, mode: 0o644 },
    { updating: false, mode: 0o640 },
    { updating: false, mode: 0o600 },
    { updating: true, mode: 0o644 },
    { updating: true, mode: 0o640 },
    { updating: true, mode: 0o600 },
  ])('enforces 0600 without changing settings bytes (update: $updating, previous mode: $mode)', async ({ updating, mode }) => {
    const first = await install(rt, vault, local());
    const content = Buffer.from(JSON.stringify({ ...first.settings, allowedFolders: [] }, null, '\t') + '\r\n');
    await writeFile(dataPath(), content);
    await chmod(dataPath(), mode);

    const result = await install(rt, vault, local(), updating);

    expect(await credentialsProtected(dataPath())).toBe(true);
    expect(await readFile(dataPath())).toEqual(content);
    expect(result.settings).toEqual({ ...first.settings, allowedFolders: [] });
  });
  it('reuses source on update and refuses downgrade and missing installations', async () => {
    await expect(install(rt, vault, local(), true)).rejects.toThrow('não instalado');
    await install(rt, vault, local());
    await writeFile(join(project, 'manifest.json'), json({ ...info, version: '0.2.0' }));
    await writeFile(join(project, 'main.js'), 'new build');
    const result = await install(rt, vault, {}, true);
    expect(result.artifacts.info.version).toBe('0.2.0');
    await writeFile(join(project, 'manifest.json'), json(info));
    await expect(install(rt, vault, {}, true)).rejects.toThrow('Downgrade');
    expect(await readFile(join(vault.plugin, 'main.js'), 'utf8')).toBe('new build');
  });
  it('refuses invalid existing credentials and preserves all artifacts', async () => {
    await install(rt, vault, local());
    await writeFile(dataPath(), '{"token":"invalid"}');
    await writeFile(join(project, 'main.js'), 'should not be written');
    await expect(install(rt, vault, local(), true)).rejects.toThrow();
    expect(await readFile(join(vault.plugin, 'main.js'), 'utf8')).not.toContain('should not');
  });
  it('preserves a deliberately disabled plugin when updating', async () => {
    await install(rt, vault, local());
    await writeFile(join(vault.config, 'community-plugins.json'), json(['other']));
    await install(rt, vault, local(), true);
    expect(JSON.parse(await readFile(join(vault.config, 'community-plugins.json'), 'utf8'))).toEqual(['other']);
  });
  it('does not silently change an existing port', async () => {
    await install(rt, vault, local());
    await expect(install(rt, vault, { ...local(), port: 29999 }, true)).rejects.toThrow('preservada');
  });
  it('uses different ports and Codex names for multiple vaults', async () => {
    const one = await install(rt, vault, local());
    const secondPath = join(root, 'second'); await mkdir(join(secondPath, '.obsidian'), { recursive: true });
    const two = await install(rt, await validateVault(secondPath), local());
    expect(two.settings.port).not.toBe(one.settings.port);
    expect(two.codex.name).not.toBe(one.codex.name);
    expect(Object.keys((await readConfig()).mcp_servers)).toHaveLength(2);
    expect(await registry(rt)).toHaveLength(2);
  });
  it('supports manual-only configuration without changing Codex or enabling the plugin', async () => {
    const result = await install(rt, vault, { ...local(), manual: true, noEnable: true });
    expect(result.codex.managed).toBe(false);
    await expect(readFile(configPath())).rejects.toThrow();
    expect(await credentialsProtected(join(vault.plugin, 'codex-config.toml'))).toBe(true);
    await expect(readFile(join(vault.config, 'community-plugins.json'))).rejects.toThrow();
  });
});

describe('Codex integration', () => {
  it('uses codex mcp add when available and then saves auth for graphical apps', async () => {
    const settings = loadSettings(null);
    rt.runCodex = vi.fn(async (args, home) => {
      await atomicWrite(join(home, 'config.toml'), stringify({ mcp_servers: { [args[2]!]: { url: args[4]! } } }));
      return { available: true, ok: true, stdout: '' };
    });
    const result = await configureCodex(rt, vault, settings);
    expect(rt.runCodex).toHaveBeenCalledWith(['mcp', 'add', serverName(vault), '--url', endpoint(settings)], join(home, '.codex'));
    expect(await inspectCodex(rt, settings, result.name)).toBe(true);
    expect((rt.runCodex as ReturnType<typeof vi.fn>).mock.calls.flat(2).join(' ')).not.toContain(settings.token);
  });
  it('preserves unrelated TOML semantics, creates backup, and avoids duplicate entries', async () => {
    const settings = loadSettings(null);
    const original = '# my config\nmodel = "chosen-model"\n[mcp_servers.other]\ncommand = "other"\n';
    await atomicWrite(configPath(), original);
    const result = await configureCodex(rt, vault, settings);
    expect((await readConfig()).model).toBe('chosen-model');
    expect((await readConfig()).mcp_servers.other.command).toBe('other');
    await configureCodex(rt, vault, settings, { owned: result });
    expect(Object.keys((await readConfig()).mcp_servers)).toHaveLength(2);
    const { readdir } = await import('node:fs/promises');
    const backup = (await readdir(join(home, '.codex'))).find(name => name.startsWith('config.toml.obsidian-mcp-backup'))!;
    expect(await readFile(join(home, '.codex', backup), 'utf8')).toBe(original);
  });
  it('reuses a matching manually configured entry without taking ownership', async () => {
    const settings = loadSettings(null);
    await atomicWrite(configPath(), stringify({ mcp_servers: { obsidian: { url: endpoint(settings), http_headers: { Authorization: `Bearer ${settings.token}` } } } }));
    const result = await configureCodex(rt, vault, settings);
    expect(result).toMatchObject({ name: 'obsidian', managed: false });
    expect(rt.runCodex).not.toHaveBeenCalled();
  });
  it('does not overwrite conflicts or corrupt TOML; generates manual alternative', async () => {
    const settings = loadSettings(null);
    const original = stringify({ mcp_servers: { [serverName(vault)]: { command: 'unrelated' } } });
    await atomicWrite(configPath(), original);
    const result = await configureCodex(rt, vault, settings);
    expect(result.manual).toBeTruthy(); expect(await readFile(configPath(), 'utf8')).toBe(original);
    await writeFile(configPath(), 'invalid = [');
    expect((await configureCodex(rt, vault, settings)).manual).toBeTruthy();
    expect(await readFile(configPath(), 'utf8')).toBe('invalid = [');
  });
  it('restores the original config if codex makes unrelated changes', async () => {
    const original = 'model = "keep"\n';
    await atomicWrite(configPath(), original);
    rt.runCodex = vi.fn(async (_args, home) => {
      await atomicWrite(join(home, 'config.toml'), 'model = "changed"\n');
      return { available: true, ok: true, stdout: '' };
    });
    expect((await configureCodex(rt, vault, loadSettings(null))).manual).toBeTruthy();
    expect(await readFile(configPath(), 'utf8')).toBe(original);
  });
  it('retains ownership for uninstall when manual output is requested after auto setup', async () => {
    const settings = loadSettings(null);
    const owned = await configureCodex(rt, vault, settings);
    expect((await configureCodex(rt, vault, settings, { manual: true, owned })).managed).toBe(true);
  });
  it.skipIf(!fileSymlinks)('respects CODEX_HOME and refuses config symlinks', async () => {
    rt.env.CODEX_HOME = join(root, 'custom-codex');
    const settings = loadSettings(null);
    const result = await configureCodex(rt, vault, settings);
    expect(result.home).toBe(rt.env.CODEX_HOME);
    await rm(join(rt.env.CODEX_HOME, 'config.toml'));
    await symlink(join(project, 'manifest.json'), join(rt.env.CODEX_HOME, 'config.toml'));
    expect((await configureCodex(rt, vault, settings)).manual).toBeTruthy();
    expect(JSON.parse(await readFile(join(project, 'manifest.json'), 'utf8')).id).toBe('obsidian-mcp');
  });
});

describe('GitHub release source', () => {
  it.each([false, true])('downloads exact version and verifies SHA-256 (checksum file: %s)', async checksums => {
    await remoteFixture({ checksums });
    const result = await remoteArtifacts(rt, 'test/obsidian-mcp', '0.2.0');
    expect(result.info.version).toBe('0.2.0'); expect(result.source).toBe('remote');
  });
  it('installs and updates remote releases without invoking a compiler', async () => {
    await remoteFixture();
    const result = await install(rt, vault, { source: 'remote', repo: 'test/obsidian-mcp' });
    expect(result.artifacts.info.version).toBe('0.2.0');
    await install(rt, vault, {}, true);
    expect(await readFile(join(vault.plugin, 'main.js'), 'utf8')).toContain('Updated');
  });
  it('rejects corrupt releases before touching a working installation', async () => {
    await install(rt, vault, local());
    await remoteFixture({ corrupt: true });
    await expect(install(rt, vault, { source: 'remote', repo: 'test/obsidian-mcp' }, true)).rejects.toThrow('Checksum');
    expect(await readFile(join(vault.plugin, 'main.js'), 'utf8')).toContain('class Plugin');
  });
  it('rejects mismatched tags, absent repositories, unsafe URLs and missing assets', async () => {
    await expect(remoteArtifacts(rt, undefined)).rejects.toThrow('--repo');
    await expect(remoteArtifacts(rt, 'test/repo', '../escape')).rejects.toThrow('--version');
    const { release } = await remoteFixture({ tag: '0.3.0' });
    await expect(remoteArtifacts(rt, 'test/obsidian-mcp')).rejects.toThrow('versão');
    release.assets[0]!.browser_download_url = 'https://attacker.example/main.js';
    await expect(remoteArtifacts(rt, 'test/obsidian-mcp')).rejects.toThrow('URL inválida');
    release.assets = [];
    await expect(remoteArtifacts(rt, 'test/obsidian-mcp')).rejects.toThrow('Asset ausente');
  });
  it('reports GitHub rate limits and missing releases', async () => {
    rt.fetch = vi.fn(async () => new Response('{}', { status: 403 })) as typeof fetch;
    await expect(remoteArtifacts(rt, 'test/obsidian-mcp')).rejects.toThrow('403');
  });
});

describe('doctor', () => {
  it.skipIf(windows).each([false, true])('detects unsafe data.json permissions and passes after repair (update: %s)', async updating => {
    const installed = await install(rt, vault, local());
    mockMcp(installed.settings);
    await chmod(dataPath(), 0o644);
    const content = await readFile(dataPath());

    expect((await doctor(rt, vault)).filter(check => !check.ok)).toEqual([
      { ok: false, message: 'data.json é acessível a outros usuários. Use chmod 600 nesse arquivo.' },
    ]);
    expect((await stat(dataPath())).mode & 0o777).toBe(0o644);

    await install(rt, vault, local(), updating);

    expect((await doctor(rt, vault)).every(check => check.ok)).toBe(true);
    expect(await credentialsProtected(dataPath())).toBe(true);
    expect(await readFile(dataPath())).toEqual(content);
  });
  it('checks HTTP rejection, authenticated MCP version, tools and Codex without accessing notes', async () => {
    const installed = await install(rt, vault, local());
    const methods = mockMcp(installed.settings);
    const checks = await doctor(rt, vault);
    expect(checks.filter(check => !check.ok)).toEqual([]);
    expect(methods).toContain('initialize'); expect(methods).toContain('tools/list');
    expect(methods).not.toContain('tools/call');
  });
  it('reports offline servers, incorrect tokens and stale loaded versions', async () => {
    const installed = await install(rt, vault, local());
    expect((await doctor(rt, vault)).some(check => !check.ok && check.message.includes('indisponível'))).toBe(true);
    mockMcp(installed.settings, '0.0.1');
    expect((await probeServer(rt, installed.settings, '0.1.0')).some(check => !check.ok && check.message.includes('versão'))).toBe(true);
    rt.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as typeof fetch;
    expect((await probeServer(rt, installed.settings, '0.1.0')).some(check => !check.ok)).toBe(true);
  });
  it('fails if the endpoint allows unauthenticated requests or artifacts are absent', async () => {
    expect((await doctor(rt, vault))[0]!.ok).toBe(false);
    const installed = await install(rt, vault, local());
    rt.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    expect((await probeServer(rt, installed.settings, '0.1.0'))[0]!.ok).toBe(false);
  });
});

describe('uninstall', () => {
  it('requires confirmation and allows cancellation', async () => {
    await install(rt, vault, local());
    await expect(uninstall(rt, vault)).rejects.toThrow('confirmação');
    rt.ask = async () => 'não';
    expect(await uninstall(rt, vault)).toBe(false);
    expect((await stat(dataPath())).isFile()).toBe(true);
  });
  it('removes only the plugin, its activation entry and owned Codex entry; keeps all notes', async () => {
    const installed = await install(rt, vault, local());
    await writeFile(join(vault.vault, 'MCP/keep.md'), '# Keep');
    await writeFile(join(vault.config, 'community-plugins.json'), json(['other', 'obsidian-mcp']));
    expect(await uninstall(rt, vault, true)).toBe(true);
    await expect(stat(vault.plugin)).rejects.toThrow();
    expect(await readFile(join(vault.vault, 'MCP/keep.md'), 'utf8')).toBe('# Keep');
    expect(JSON.parse(await readFile(join(vault.config, 'community-plugins.json'), 'utf8'))).toEqual(['other']);
    expect((await readConfig()).mcp_servers[installed.codex.name]).toBeUndefined();
    expect(await registry(rt)).toEqual([]);
  });
  it('preserves foreign files and credentials changed by the user', async () => {
    const installed = await install(rt, vault, local());
    await writeFile(join(vault.plugin, 'unknown.txt'), 'keep');
    await expect(uninstall(rt, vault, true)).rejects.toThrow('desconhecidos');
    await rm(join(vault.plugin, 'unknown.txt'));
    const config = await readConfig(); config.mcp_servers[installed.codex.name].http_headers.Authorization = 'Bearer changed';
    await writeFile(configPath(), stringify(config));
    await uninstall(rt, vault, true);
    expect((await readConfig()).mcp_servers[installed.codex.name].http_headers.Authorization).toBe('Bearer changed');
  });
});
