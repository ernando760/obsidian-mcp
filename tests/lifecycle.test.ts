import { describe, expect, it, vi } from 'vitest';
import { FileSystemAdapter, type App, type PluginManifest } from 'obsidian';
const state = vi.hoisted(() => ({ instances: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> }));
vi.mock('../src/server/http', () => ({
  LocalMcpServer: class {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    constructor() { state.instances.push(this); }
  },
}));
import ObsidianMcpPlugin from '../src/main';

function fixture(data: unknown = null) {
  const plugin = Object.create(ObsidianMcpPlugin.prototype) as ObsidianMcpPlugin;
  const adapter = Object.assign(Object.create(FileSystemAdapter.prototype) as FileSystemAdapter, { getBasePath: () => '/vault' });
  let layoutReady: (() => void) | undefined;
  Object.assign(plugin, {
    app: { vault: { adapter, configDir: '.obsidian' }, workspace: { onLayoutReady: (callback: () => void) => { layoutReady = callback; } } } as unknown as App,
    manifest: { version: '0.1.0' } as PluginManifest,
    loadData: vi.fn(async () => data), saveData: vi.fn(async () => {}),
  });
  return { plugin, ready: () => layoutReady?.() };
}

describe('plugin lifecycle', () => {
  it('persists a generated token and waits for vault indexing before starting', async () => {
    const { plugin, ready } = fixture();
    await plugin.onload();
    const server = state.instances.at(-1)!;
    expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({ allowedFolders: ['MCP'], token: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(server.start).not.toHaveBeenCalled();
    ready(); await Promise.resolve();
    expect(server.start).toHaveBeenCalledTimes(1);
    plugin.onunload();
    expect(server.stop).toHaveBeenCalled();
  });
  it('does not start if unloaded before layout becomes ready', async () => {
    const { plugin, ready } = fixture();
    await plugin.onload();
    const server = state.instances.at(-1)!;
    plugin.onunload(); ready();
    expect(server.start).not.toHaveBeenCalled();
    expect(server.stop).toHaveBeenCalled();
  });
  it('closes a listener that finishes binding after unload', async () => {
    const { plugin, ready } = fixture();
    await plugin.onload();
    const server = state.instances.at(-1)!;
    let finish!: () => void;
    server.start.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    ready(); plugin.onunload();
    expect(server.stop).toHaveBeenCalledTimes(1);
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(server.stop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('refuses invalid saved settings before creating a server', async () => {
    const previous = state.instances.length;
    const { plugin } = fixture({ token: 'weak' });
    await expect(plugin.onload()).rejects.toThrow();
    expect(state.instances).toHaveLength(previous);
  });
});
