import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { protectCredentials } from './permissions';

export async function statOptional(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function safePath(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await statOptional(current);
    if (stat?.isSymbolicLink() && process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(current) && await realpath(current) === `/private${current}`) continue;
    if (stat?.isSymbolicLink()) throw new Error(`Link simbólico não permitido: ${current}`);
    if (stat && current !== absolute && !stat.isDirectory()) throw new Error(`Diretório inválido: ${current}`);
  }
}
export async function directory(path: string): Promise<void> {
  await safePath(path);
  const stat = await statOptional(path);
  if (stat && !stat.isDirectory()) throw new Error(`Não é um diretório: ${path}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
}
export async function readOptional(path: string, max = 1024 * 1024): Promise<Buffer | undefined> {
  await safePath(path);
  const stat = await statOptional(path);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > max) throw new Error(`Arquivo inválido ou grande demais: ${path}`);
  return readFile(path);
}
export async function jsonOptional(path: string): Promise<unknown> {
  const data = await readOptional(path);
  if (!data) return undefined;
  try { return JSON.parse(data.toString('utf8')) as unknown; }
  catch { throw new Error(`JSON inválido: ${path}`); }
}
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function atomicWrite(path: string, data: string | Buffer, mode?: number): Promise<void> {
  await directory(dirname(path));
  await safePath(path);
  const existing = await statOptional(path);
  if (existing && !existing.isFile()) throw new Error(`Não é um arquivo regular: ${path}`);
  const temp = join(dirname(path), `.obsidian-mcp-${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', mode ?? (existing ? existing.mode & 0o777 : 0o600));
  try {
    if (process.platform === 'win32' && ((mode ?? (existing ? existing.mode & 0o777 : 0o600)) & 0o077) === 0) await protectCredentials(temp);
    await handle.writeFile(data);
    await handle.chmod(mode ?? (existing ? existing.mode & 0o777 : 0o600));
    await handle.sync();
    await handle.close();
    await rename(temp, path);
  } finally { await handle.close(); await rm(temp, { force: true }); }
}
export async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await directory(dirname(path));
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Outra operação está em andamento. Se não estiver, remova o lock obsoleto: ${path}`);
    throw error;
  }
  try { await handle.writeFile(`${process.pid}\n`); return await action(); }
  finally { await handle.close(); await rm(path, { force: true }); }
}
export async function transaction(changes: Array<{ path: string; data: string | Buffer }>): Promise<void> {
  const snapshots = await Promise.all(changes.map(async change => ({
    path: change.path, data: await readOptional(change.path, 20 * 1024 * 1024), mode: (await statOptional(change.path))?.mode,
  })));
  let applied = 0;
  try {
    for (const change of changes) { await atomicWrite(change.path, change.data); applied++; }
  } catch (error) {
    for (const snapshot of snapshots.slice(0, applied).reverse()) {
      if (snapshot.data) await atomicWrite(snapshot.path, snapshot.data, snapshot.mode === undefined ? undefined : snapshot.mode & 0o777);
      else await rm(snapshot.path, { force: true });
    }
    throw error;
  }
}
