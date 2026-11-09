import { join } from 'node:path';
import type { Runtime } from './runtime';

export const platform = (rt: Pick<Runtime, 'platform'>) => rt.platform ?? process.platform;
export function obsidianRegistries(rt: Runtime): string[] {
  if (platform(rt) === 'darwin') return [join(rt.home, 'Library/Application Support/obsidian/obsidian.json')];
  if (platform(rt) === 'win32') return [join(rt.env.APPDATA || join(rt.home, 'AppData/Roaming'), 'obsidian/obsidian.json')];
  return [
    join(rt.env.XDG_CONFIG_HOME || join(rt.home, '.config'), 'obsidian/obsidian.json'),
    join(rt.home, '.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json'),
  ];
}
export function nativeStateDir(rt: Runtime): string {
  if (rt.env.XDG_STATE_HOME) return join(rt.env.XDG_STATE_HOME, 'obsidian-mcp');
  if (platform(rt) === 'darwin') return join(rt.home, 'Library/Application Support/obsidian-mcp');
  if (platform(rt) === 'win32') return join(rt.env.LOCALAPPDATA || join(rt.home, 'AppData/Local'), 'obsidian-mcp');
  return join(rt.home, '.local/state/obsidian-mcp');
}
// Windows npm installs a codex.cmd launcher. Only fixed CLI tokens are accepted
// here, never shell metacharacters, paths supplied by users, or credentials.
export function codexCommand(args: string[], os: NodeJS.Platform, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  if (os !== 'win32') return { file: 'codex', args };
  if (!args.every(arg => /^[A-Za-z0-9_:/.-]+$/.test(arg))) throw new Error('Argumento Codex inválido para o launcher Windows.');
  return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `codex ${args.join(' ')}`] };
}
