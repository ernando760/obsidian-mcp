import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

export function safeRelativePath(path: string): string {
  if (!path || path.length > 1024 || /[\\:%\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid vault-relative path');
  if (path.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.trim() !== part)) {
    throw new Error('Hidden, absolute and traversal paths are forbidden');
  }
  return path;
}

export class NotePolicy {
  constructor(private readonly root: string, private readonly folders: readonly string[], private readonly configDir: string) {
    folders.forEach(safeRelativePath);
  }
  authorize(path: string): string {
    safeRelativePath(path);
    if (!path.endsWith('.md') || path === this.configDir || path.startsWith(`${this.configDir}/`) ||
      !this.folders.some(folder => path.startsWith(`${folder}/`))) {
      throw new Error('Only Markdown notes inside authorized folders are allowed');
    }
    return path;
  }
  authorizeFolder(path: string): string {
    safeRelativePath(path);
    if (/[<>"|?*]/.test(path) || path === this.configDir || path.startsWith(`${this.configDir}/`) ||
      !this.folders.some(folder => path === folder || path.startsWith(`${folder}/`))) {
      throw new Error('Only folders inside authorized folders are allowed');
    }
    return path;
  }
  async checkFolder(path: string): Promise<void> {
    this.authorizeFolder(path);
    const parts = path.split('/');
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe folder path');
      } catch (error) {
        // Only the requested folder may be missing; every parent must be a real directory.
        if (index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new Error('Folder unavailable or unsafe path');
      }
    }
  }
  async check(path: string, creating = false): Promise<void> {
    this.authorize(path);
    const parts = path.split('/');
    let current = this.root;
    // Reject every symlink, including links pointing elsewhere inside the vault.
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const last = index === parts.length - 1;
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) throw new Error('Unsafe note path');
        if (last && creating) throw new Error('Note already exists');
      } catch (error) {
        if (creating && last && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new Error('Note unavailable or unsafe path');
      }
    }
  }
}
