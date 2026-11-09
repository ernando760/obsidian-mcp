import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { runtime, stateDir } from '../cli/runtime';
import { obsidianRegistries, codexCommand, windowsPowerShellEnv } from '../cli/platform';
import { discoverVaults, registry } from '../cli/vaults';
import { json } from '../cli/files';
import { protectCredentials, credentialsProtected } from '../cli/permissions';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'obsidian-mcp-platform-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('platform-specific CLI paths', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('discovers an existing vault in the %s profile', async platform => {
    const rt = { ...runtime(), platform, home: root, env: { APPDATA: join(root, 'Roaming'), LOCALAPPDATA: join(root, 'Local') } };
    const vault = join(root, 'Vault com espaços e acentos');
    await mkdir(join(vault, '.obsidian'), { recursive: true });
    const configs = obsidianRegistries(rt);
    const { dirname } = await import('node:path');
    await mkdir(dirname(configs[0]!), { recursive: true });
    await writeFile(configs[0]!, json({ vaults: { one: { path: vault } } }));
    const found = await discoverVaults(rt);
    expect(found).toHaveLength(1);
    expect(found[0]!.vault).toContain('Vault com espaços e acentos');
    expect(configs[0]).toBe(platform === 'linux' ? join(root, '.config/obsidian/obsidian.json') : platform === 'darwin' ? join(root, 'Library/Application Support/obsidian/obsidian.json') : join(root, 'Roaming/obsidian/obsidian.json'));
  });
  it('uses native state directories and honors XDG_STATE_HOME', () => {
    const rt = { ...runtime(), home: root, env: {}, platform: 'linux' as const };
    expect(stateDir(rt)).toBe(join(root, '.local/state/obsidian-mcp'));
    expect(stateDir({ ...rt, platform: 'darwin' })).toBe(join(root, 'Library/Application Support/obsidian-mcp'));
    expect(stateDir({ ...rt, platform: 'win32', env: { LOCALAPPDATA: join(root, 'Local') } })).toBe(join(root, 'Local/obsidian-mcp'));
    expect(stateDir({ ...rt, platform: 'win32', env: { XDG_STATE_HOME: join(root, 'state') } })).toBe(join(root, 'state/obsidian-mcp'));
  });
  it('continues discovering installations in legacy state on macOS/Windows', async () => {
    const path = join(root, '.local/state/obsidian-mcp');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'installations.json'), json([{ vault: root, configDir: '.obsidian' }]));
    for (const platform of ['darwin', 'win32'] as const) expect(await registry({ ...runtime(), home: root, env: {}, platform })).toEqual([{ vault: root, configDir: '.obsidian' }]);
  });
});
describe('Codex process invocation', () => {
  it('uses argv directly on POSIX and cmd.exe for the Windows npm launcher', () => {
    const args = ['mcp', 'add', 'obsidian-mcp-test', '--url', 'http://127.0.0.1:27124/mcp'];
    expect(codexCommand(args, 'darwin', {})).toEqual({ file: 'codex', args });
    expect(codexCommand(args, 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'codex mcp add obsidian-mcp-test --url http://127.0.0.1:27124/mcp'] });
  });
  it.skipIf(process.platform !== 'win32')('executes a real npm-style codex.cmd launcher', async () => {
    const script = join(root, 'fake-codex.cjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    await writeFile(join(root, 'codex.cmd'), `@echo off\r\nnode "${script}" %*\r\n`);
    const oldPath = process.env.PATH;
    vi.stubEnv('PATH', `${root};${oldPath}`);
    try {
      const result = await runtime().runCodex(['mcp', 'get', 'test-server', '--json'], join(root, 'codex-home'));
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual(['mcp', 'get', 'test-server', '--json']);
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(['name&whoami', '%USERNAME%', 'name"', '^test', 'name\ncommand', '$(command)', 'a b'])('rejects shell expansion in %j', arg => {
    expect(() => codexCommand(['mcp', 'add', arg], 'win32', {})).toThrow();
  });
});
describe('native credential protection', () => {
  it('isolates Windows PowerShell module discovery without changing the caller environment', () => {
    const env = { PSModulePath: 'PowerShell7/Modules', psmodulepath: 'other/modules', PATH: 'node/bin', OTHER: 'kept' };
    expect(windowsPowerShellEnv(env)).toEqual({ PATH: 'node/bin', OTHER: 'kept' });
    expect(env.PSModulePath).toBe('PowerShell7/Modules');
  });
  it('protects a credential file without rewriting its bytes', async () => {
    const file = join(root, 'credenciais com espaços.json');
    const data = '{"token":"local-test"}\r\n';
    await writeFile(file, data);
    await protectCredentials(file);
    expect(await credentialsProtected(file)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(data);
  });
  it.skipIf(process.platform !== 'win32')('detects an unsafe Windows ACL and repairs it', async () => {
    const file = join(root, 'credentials.json');
    await writeFile(file, '{}'); await protectCredentials(file);
    const script = `$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:OBSIDIAN_MCP_ACL_TEST; $everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'Read','Allow')); Set-Acl -LiteralPath $env:OBSIDIAN_MCP_ACL_TEST -AclObject $acl`;
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...windowsPowerShellEnv(process.env), OBSIDIAN_MCP_ACL_TEST: file } });
    expect(await credentialsProtected(file)).toBe(false);
    await protectCredentials(file);
    expect(await credentialsProtected(file)).toBe(true);
  });
});
