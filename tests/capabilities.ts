import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export const windows = process.platform === 'win32';
const root = await mkdtemp(join(tmpdir(), 'obsidian-mcp-capabilities-'));
export const fileSymlinks = await (async () => {
  try {
    await writeFile(join(root, 'target'), 'test');
    await symlink(join(root, 'target'), join(root, 'link'), 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally { await rm(root, { recursive: true, force: true }); }
})();

export async function permissionSnapshot(path: string): Promise<string> {
  if (!windows) {
    const { stat } = await import('node:fs/promises');
    return String((await stat(path)).mode & 0o777);
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const code = `$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:OBSIDIAN_MCP_PERMISSION_SNAPSHOT).Sddl`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env: { ...process.env, OBSIDIAN_MCP_PERMISSION_SNAPSHOT: path }, timeout: 15000 });
  return stdout.trim();
}
