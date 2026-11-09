import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexCommand, nativeStateDir } from './platform';
export interface CommandResult { available: boolean; ok: boolean; stdout: string }
export interface Runtime {
  platform?: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  log: (message: string) => void;
  ask?: (message: string) => Promise<string>;
  runCodex: (args: string[], home: string) => Promise<CommandResult>;
  portAvailable: (port: number) => Promise<boolean>;
}
export function runtime(): Runtime {
  return {
    platform: process.platform, home: homedir(), env: process.env, fetch: globalThis.fetch, log: console.log,
    runCodex: (args, codexHome) => new Promise(resolve => {
      const command = codexCommand(args, process.platform, process.env);
      execFile(command.file, command.args, {
        cwd: homedir(), env: { ...process.env, CODEX_HOME: codexHome },
        timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
      }, (error, stdout) => resolve({ available: (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT', ok: !error, stdout: error ? '' : stdout }));
    }),
    portAvailable: port => new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
        else reject(new Error('Não foi possível verificar a porta local. Informe --port explicitamente ou revise as permissões de rede.'));
      });
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    }),
  };
}
export const codexHome = (rt: Runtime) => rt.env.CODEX_HOME || join(rt.home, '.codex');
export const stateDir = nativeStateDir;
