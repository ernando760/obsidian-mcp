import { TFile, TFolder, type Vault } from 'obsidian';
import { NotePolicy } from './policy';
export const MAX_NOTE_BYTES = 1024 * 1024;
export class Notes {
  private active = true;
  constructor(private readonly vault: Vault, private readonly policy: NotePolicy) {}
  stop(): void { this.active = false; }
  private assertActive(): void { if (!this.active) throw new Error('Plugin is stopping'); }
  private async file(path: string): Promise<TFile> {
    this.assertActive();
    await this.policy.check(path);
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('Markdown note not found');
    return file;
  }
  async list(offset = 0, limit = 100) {
    this.assertActive();
    const notes = [];
    for (const file of this.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
      try { await this.policy.check(file.path); } catch { continue; }
      notes.push({ path: file.path, size: file.stat.size, modified: file.stat.mtime });
    }
    return { notes: notes.slice(offset, offset + limit), total: notes.length, offset };
  }
  async read(path: string) {
    const file = await this.file(path);
    if (file.stat.size > MAX_NOTE_BYTES) throw new Error('Note exceeds 1 MiB');
    this.assertActive();
    const content = await this.vault.read(file);
    if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new Error('Note exceeds 1 MiB');
    return { path, content };
  }
  async search(query: string, limit = 50) {
    const needle = query.toLocaleLowerCase();
    const matches = [];
    for (const file of this.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
      this.assertActive();
      try { await this.policy.check(file.path); } catch { continue; }
      if (file.stat.size > MAX_NOTE_BYTES) continue;
      const { content } = await this.read(file.path);
      const index = content.toLocaleLowerCase().indexOf(needle);
      if (index >= 0 || file.path.toLocaleLowerCase().includes(needle)) {
        matches.push({ path: file.path, excerpt: content.slice(Math.max(0, index - 80), Math.max(0, index) + 240) });
        if (matches.length >= limit) break;
      }
    }
    return { matches };
  }
  async create(path: string, content: string) {
    this.assertActive();
    if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new Error('Note exceeds 1 MiB');
    await this.policy.check(path, true);
    if (this.vault.getAbstractFileByPath(path)) throw new Error('Note already exists');
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!(this.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw new Error('Parent folder must already exist');
    this.assertActive();
    await this.vault.create(path, content);
    return { path, created: true };
  }
  async createFolder(path: string) {
    this.assertActive();
    await this.policy.checkFolder(path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return { path, created: false };
    if (existing) throw new Error('Path already exists and is not a folder');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/';
    if (!(this.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw new Error('Parent folder must already exist');
    this.assertActive();
    try {
      await this.vault.createFolder(path);
    } catch (error) {
      // Another call may have created the folder while the API operation was pending.
      await this.policy.checkFolder(path);
      if (!(this.vault.getAbstractFileByPath(path) instanceof TFolder)) throw error;
      return { path, created: false };
    }
    return { path, created: true };
  }
}
