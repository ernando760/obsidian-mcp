import { fileSymlinks } from './capabilities';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TFile, TFolder, type Vault } from 'obsidian';
import { NotePolicy } from '../src/vault/policy';
import { Notes } from '../src/vault/notes';
import { LocalMcpServer } from '../src/server/http';
import { loadSettings } from '../src/settings';

let root: string;
let notes: Notes;
let policy: NotePolicy;
let vault: Vault;
let server: LocalMcpServer | undefined;
let client: Client | undefined;
let port: number;
const token = 'a'.repeat(64);
// Managed CI environments may forbid binding even the loopback interface.
const canListen = await new Promise<boolean>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPERM' || error.code === 'EACCES') resolve(false);
    else reject(error);
  });
  probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
});
if (!canListen && process.env.OBSIDIAN_MCP_REQUIRE_HTTP_TESTS === '1') throw new Error('Native CI must permit localhost HTTP integration tests; refusing to silently skip them.');
if (!canListen) console.warn('HTTP integration tests skipped: environment forbids localhost binding (EPERM/EACCES). Run npm test on an unrestricted desktop.');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'obsidian-mcp-test-'));
  await mkdir(join(root, 'MCP'));
  await mkdir(join(root, 'Private'));
  await mkdir(join(root, '.obsidian'));
  await writeFile(join(root, 'MCP/one.md'), 'Olá mundo');
  await writeFile(join(root, 'Private/secret.md'), 'segredo');
  const makeFile = (path: string, size: number) => {
    const f = Object.assign(new TFile(), { path }); f.stat = { size, mtime: 1, ctime: 1 }; return f;
  };
  const files = new Map<string, TFile | TFolder>([
    ['/', Object.assign(new TFolder(), { path: '/' })],
    ['MCP', Object.assign(new TFolder(), { path: 'MCP' })], ['Private', Object.assign(new TFolder(), { path: 'Private' })],
    ['MCP/one.md', makeFile('MCP/one.md', 10)], ['Private/secret.md', makeFile('Private/secret.md', 7)],
  ]);
  vault = {
    getMarkdownFiles: () => [...files.values()].filter(f => f instanceof TFile),
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    read: (file: TFile) => readFile(join(root, file.path), 'utf8'),
    create: async (path: string, content: string) => {
      await writeFile(join(root, path), content, { flag: 'wx' });
      const file = makeFile(path, Buffer.byteLength(content)); files.set(path, file); return file;
    },
    createFolder: vi.fn(async (path: string) => {
      await mkdir(join(root, path));
      const folder = Object.assign(new TFolder(), { path }); files.set(path, folder); return folder;
    }),
  } as unknown as Vault;
  policy = new NotePolicy(root, ['MCP'], '.obsidian');
  notes = new Notes(vault, policy);
});
describe('folder creation', () => {
  it('uses the vault API to create folders, nested folders and notes within them', async () => {
    expect(await notes.createFolder('MCP/Projetos')).toEqual({ path: 'MCP/Projetos', created: true });
    expect(await notes.createFolder('MCP/Projetos/Subpasta')).toEqual({ path: 'MCP/Projetos/Subpasta', created: true });
    expect(vault.createFolder).toHaveBeenNthCalledWith(1, 'MCP/Projetos');
    expect(vault.createFolder).toHaveBeenNthCalledWith(2, 'MCP/Projetos/Subpasta');
    await notes.create('MCP/Projetos/Subpasta/note.md', 'nested');
    expect(await readFile(join(root, 'MCP/Projetos/Subpasta/note.md'), 'utf8')).toBe('nested');
  });
  it('returns created: false for existing authorized folders without calling createFolder again', async () => {
    expect(await notes.createFolder('MCP')).toEqual({ path: 'MCP', created: false });
    await notes.createFolder('MCP/existing');
    expect(await notes.createFolder('MCP/existing')).toEqual({ path: 'MCP/existing', created: false });
    expect(vault.createFolder).toHaveBeenCalledTimes(1);
  });
  it.each(['', '/', '.', '..', '../Private/new', '/MCP/new', 'MCP/../Private/new', 'MCP/.hidden',
    'MCP/.obsidian/new', 'MCP/a/../../Private/new', 'MCP\\new', 'MCP/%2e%2e/new', 'Private/new',
    'MCP2/new', 'MCP//new', 'MCP/new/', 'MCP/ new', 'MCP/new ', 'MCP/new.', 'MCP/a\u0000',
    'MCP/a\n', 'MCP/a\u007f', 'C:/MCP/new', 'MCP/a:b', 'MCP/a*', 'MCP/a?', 'MCP/a"',
    'MCP/a<', 'MCP/a>', 'MCP/a|', 'MCP/' + 'a'.repeat(1024)])('rejects invalid or unauthorized folder %j', async path => {
    await expect(notes.createFolder(path)).rejects.toThrow();
    expect(vault.createFolder).not.toHaveBeenCalled();
  });
  it('rejects file collisions and missing parents before calling the vault API', async () => {
    for (const path of ['MCP/one.md', 'MCP/one.md/child', 'MCP/missing/child']) {
      await expect(notes.createFolder(path)).rejects.toThrow();
    }
    expect(vault.createFolder).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'MCP/one.md'), 'utf8')).toBe('Olá mundo');
  });
  it.skipIf(!fileSymlinks)('rejects symlinks including internal links, broken links and linked ancestors', async () => {
    await symlink(join(root, 'Private'), join(root, 'MCP/outside'), 'dir');
    await symlink(join(root, 'MCP'), join(root, 'MCP/inside'), 'dir');
    await symlink(join(root, 'missing-target'), join(root, 'MCP/broken'), 'dir');
    await symlink(join(root, 'MCP/one.md'), join(root, 'MCP/file'));
    for (const path of ['MCP/outside', 'MCP/outside/new', 'MCP/inside', 'MCP/inside/new',
      'MCP/broken', 'MCP/broken/new', 'MCP/file']) {
      await expect(notes.createFolder(path)).rejects.toThrow();
    }
    expect(vault.createFolder).not.toHaveBeenCalled();
  });
  it('honors nested allowed folders, an empty allowlist and custom config directories', async () => {
    await notes.createFolder('MCP/shared');
    const restricted = new Notes(vault, new NotePolicy(root, ['MCP/shared'], 'MCP/shared/config'));
    await restricted.createFolder('MCP/shared/child');
    for (const path of ['MCP', 'MCP/other', 'MCP/shared2', 'MCP/shared/config', 'MCP/shared/config/child']) {
      await expect(restricted.createFolder(path)).rejects.toThrow();
    }
    const disabled = new Notes(vault, new NotePolicy(root, [], '.obsidian'));
    await expect(disabled.createFolder('MCP')).rejects.toThrow();
    await expect(disabled.createFolder('MCP/new')).rejects.toThrow();
  });
  it('handles concurrent creation of the same folder', async () => {
    const results = await Promise.all([notes.createFolder('MCP/race'), notes.createFolder('MCP/race')]);
    expect(results.map(result => result.created).sort()).toEqual([false, true]);
  });
  it('propagates API failures and refuses operations after stop', async () => {
    vi.mocked(vault.createFolder).mockRejectedValueOnce(new Error('Disk full'));
    await expect(notes.createFolder('MCP/new')).rejects.toThrow('Disk full');
    notes.stop();
    await expect(notes.createFolder('MCP/stopped')).rejects.toThrow('Plugin is stopping');
    expect(vault.createFolder).toHaveBeenCalledTimes(1);
  });
});
afterEach(async () => {
  await client?.close(); client = undefined;
  await server?.stop(); server = undefined;
  await rm(root, { recursive: true, force: true });
});
async function start() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  server = new LocalMcpServer(notes, { port, token, allowedFolders: ['MCP'] }, '0.1.0');
  await server.start();
  return `http://127.0.0.1:${port}/mcp`;
}
function raw(headers: Record<string, string>, body = '{}', method = 'POST') {
  return new Promise<number>(resolve => {
    const req = request({ hostname: '127.0.0.1', port, path: '/mcp', method, headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers,
    } }, res => { res.resume(); resolve(res.statusCode!); });
    req.end(body);
  });
}
describe('note authorization', () => {
  it.each(['../secret.md', '/tmp/x.md', 'MCP/../Private/secret.md', 'MCP/.hidden.md', 'MCP/.obsidian/a.md',
    'MCP/a.txt', 'MCP\\a.md', 'MCP/%2e%2e/a.md', 'Private/secret.md', 'MCP2/a.md', 'MCP//a.md', 'MCP/a.md\u0000'])('rejects %s', async path => {
    await expect(notes.read(path)).rejects.toThrow();
    await expect(notes.create(path, 'unsafe')).rejects.toThrow();
  });
  it('lists, reads, searches and creates only authorized notes', async () => {
    expect((await notes.list()).notes.map(n => n.path)).toEqual(['MCP/one.md']);
    expect((await notes.read('MCP/one.md')).content).toBe('Olá mundo');
    expect((await notes.search('MUNDO')).matches).toHaveLength(1);
    expect((await notes.search('segredo')).matches).toHaveLength(0);
    await notes.create('MCP/new.md', '# Nova');
    expect(await readFile(join(root, 'MCP/new.md'), 'utf8')).toBe('# Nova');
    await expect(notes.create('MCP/new.md', 'overwrite')).rejects.toThrow();
    await expect(notes.create('MCP/missing/new.md', 'x')).rejects.toThrow();
    expect((await notes.list(1, 1)).notes).toHaveLength(1);
  });
  it.skipIf(!fileSymlinks)('rejects file, directory and broken symlinks for read and create', async () => {
    await symlink(join(root, 'Private/secret.md'), join(root, 'MCP/link.md'));
    await symlink(join(root, 'Private'), join(root, 'MCP/linked'), 'dir');
    await symlink(join(root, 'missing-target'), join(root, 'MCP/broken.md'));
    for (const path of ['MCP/link.md', 'MCP/linked/secret.md', 'MCP/broken.md']) await expect(policy.check(path)).rejects.toThrow();
    await expect(notes.create('MCP/linked/new.md', 'x')).rejects.toThrow();
    await expect(notes.create('MCP/broken.md', 'x')).rejects.toThrow();
  });
  it('denies hidden config directories even when authorized', () => {
    expect(() => new NotePolicy(root, ['.obsidian'], '.obsidian')).toThrow();
    const custom = new NotePolicy(root, ['MCP'], 'MCP/config');
    expect(() => custom.authorize('MCP/config/data.md')).toThrow();
  });
  it('limits note bytes and prevents writes after stop', async () => {
    await expect(notes.create('MCP/large.md', 'á'.repeat(600000))).rejects.toThrow();
    notes.stop(); await expect(notes.create('MCP/stopped.md', 'x')).rejects.toThrow();
  });
  it('generates strong per-vault tokens and rejects invalid settings', () => {
    const first = loadSettings(null); expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.token).not.toBe(loadSettings(null).token);
    expect(() => loadSettings({ ...first, token: 'weak' })).toThrow();
    expect(() => loadSettings({ ...first, allowedFolders: ['../'] })).toThrow();
    expect(() => loadSettings({ ...first, host: '0.0.0.0' })).toThrow();
    expect(loadSettings({ ...first, allowedFolders: [] }).allowedFolders).toEqual([]);
  });
});
describe.skipIf(!canListen)('real Streamable HTTP transport', () => {
  it('connects the official MCP client and exercises all five tools', async () => {
    const url = await start();
    client = new Client({ name: 'mvp-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['create_folder', 'create_note', 'list_notes', 'read_note', 'search_notes']);
    for (const [name, args] of [
      ['list_notes', {}], ['read_note', { path: 'MCP/one.md' }], ['search_notes', { query: 'MUNDO' }],
      ['create_note', { path: 'MCP/client.md', content: '# Cliente' }],
      ['create_folder', { path: 'MCP/client-folder' }],
    ] as const) expect((await client.callTool({ name, arguments: args })).isError).not.toBe(true);
    expect(await readFile(join(root, 'MCP/client.md'), 'utf8')).toBe('# Cliente');
    expect((await client.callTool({ name: 'read_note', arguments: { path: 'Private/secret.md' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'create_note', arguments: { path: 'MCP/client.md', content: 'overwrite' } })).isError).toBe(true);
    expect((await client.callTool({ name: 'search_notes', arguments: { query: '' } })).isError).toBe(true);
  });
  it('rejects missing/invalid tokens, hostile hosts, origins and methods', async () => {
    await start();
    expect(await raw({ Authorization: '' })).toBe(401);
    expect(await raw({ Authorization: 'Bearer wrong' })).toBe(401);
    expect(await raw({ Host: `attacker.example:${port}` })).toBe(403);
    expect(await raw({ Origin: 'https://attacker.example' })).toBe(403);
    expect(await raw({ Origin: `http://localhost:${port}` })).toBe(403);
    expect(await raw({}, '', 'GET')).toBe(405);
    expect(await raw({}, '', 'DELETE')).toBe(405);
    expect(await raw({}, '{')).toBe(400);
    expect(await raw({ 'Content-Type': 'text/plain' })).toBe(415);
    expect(await raw({}, ' '.repeat(2 * 1024 * 1024 + 1))).toBe(413);
  });
  it('releases the listening port on stop and reports port conflicts', async () => {
    const url = await start();
    const conflict = new LocalMcpServer(notes, { port, token, allowedFolders: ['MCP'] }, '0.1.0');
    await expect(conflict.start()).rejects.toThrow();
    await conflict.stop();
    await server!.stop();
    await expect(fetch(url)).rejects.toThrow();
    const replacement = createServer();
    await new Promise<void>((resolve, reject) => replacement.once('error', reject).listen(port, '127.0.0.1', resolve));
    await new Promise<void>(resolve => replacement.close(() => resolve()));
  });
});

describe('official MCP client over in-memory transport', () => {
  it('negotiates, lists schemas and invokes every tool against the vault API', async () => {
    const mcp = createMcpServer(notes, '0.1.0');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'in-memory-test', version: '1' });
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(t => t.name).sort()).toEqual(['create_folder', 'create_note', 'list_notes', 'read_note', 'search_notes']);
      expect(tools.find(t => t.name === 'create_folder')?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
      for (const [name, args] of [
        ['list_notes', {}], ['read_note', { path: 'MCP/one.md' }],
        ['search_notes', { query: 'MUNDO' }], ['create_note', { path: 'MCP/sdk.md', content: '# SDK' }],
        ['create_folder', { path: 'MCP/sdk-folder' }],
      ] as const) expect((await client.callTool({ name, arguments: args })).isError).not.toBe(true);
      expect(await readFile(join(root, 'MCP/sdk.md'), 'utf8')).toBe('# SDK');
      const existing = await client.callTool({ name: 'create_folder', arguments: { path: 'MCP/sdk-folder' } });
      expect(existing.isError).not.toBe(true);
      expect(existing.content).toEqual([{ type: 'text', text: JSON.stringify({ path: 'MCP/sdk-folder', created: false }) }]);
      for (const path of ['Private/new', 'MCP/../Private/new', 'MCP/one.md', 'MCP/missing/child', '']) {
        expect((await client.callTool({ name: 'create_folder', arguments: { path } })).isError).toBe(true);
      }
      expect((await client.callTool({ name: 'read_note', arguments: { path: 'Private/secret.md' } })).isError).toBe(true);
      expect((await client.callTool({ name: 'create_note', arguments: { path: 'MCP/sdk.md', content: 'overwrite' } })).isError).toBe(true);
      expect((await client.callTool({ name: 'search_notes', arguments: { query: '' } })).isError).toBe(true);
    } finally { await client.close(); client = undefined; await mcp.close(); }
  });
});
