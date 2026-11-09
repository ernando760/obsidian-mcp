import { FileSystemAdapter, Plugin } from 'obsidian';
import { loadSettings } from './settings';
import { LocalMcpServer } from './server/http';
import { Notes } from './vault/notes';
import { NotePolicy } from './vault/policy';

export default class ObsidianMcpPlugin extends Plugin {
  private server: LocalMcpServer | undefined;
  private stopped = false;
  private startup: Promise<void> | undefined;

  async onload(): Promise<void> {
    this.stopped = false;
    const settings = loadSettings(await this.loadData());
    await this.saveData(settings);
    if (this.stopped) return;
    const { vault } = this.app;
    if (!(vault.adapter instanceof FileSystemAdapter)) throw new Error('Obsidian MCP requires a local desktop vault');
    const policy = new NotePolicy(vault.adapter.getBasePath(), settings.allowedFolders, vault.configDir);
    const server = new LocalMcpServer(new Notes(vault, policy), settings, this.manifest.version);
    this.server = server;
    // The vault file index is ready only after layout initialization.
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      this.startup = server.start().then(async () => {
        if (this.stopped) await server.stop();
        else console.info(`[Obsidian MCP] Listening at http://127.0.0.1:${settings.port}/mcp`);
      }).catch(() => console.error('[Obsidian MCP] Could not start. Check settings and whether the port is in use.'));
    });
  }

  onunload(): void {
    this.stopped = true;
    const server = this.server;
    this.server = undefined;
    if (server) {
      // Obsidian does not await onunload. Close sockets immediately; wait for any pending bind too.
      void server.stop().catch(() => console.error('[Obsidian MCP] Could not stop server'));
      void this.startup?.then(() => server.stop()).catch(() => console.error('[Obsidian MCP] Could not finish server shutdown'));
    }
  }
}
