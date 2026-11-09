// Obsidian ships the runtime inside Electron; tests model only the public API used here.
export class TFile {
  extension = 'md';
  stat = { size: 0, mtime: 0, ctime: 0 };
  constructor(public path = '') {}
}
export class TFolder { constructor(public path = '') {} }
export class FileSystemAdapter { getBasePath() { return ''; } }
export class Plugin {}
