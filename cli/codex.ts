import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify, type TomlTable } from 'smol-toml';
import { atomicWrite, directory, readOptional, withLock } from './files';
import { codexHome, type Runtime } from './runtime';
import type { Settings } from '../src/settings';
import type { Vault } from './vaults';

export const endpoint = (settings: Settings) => `http://127.0.0.1:${settings.port}/mcp`;
export const serverName = (vault: Vault) => `obsidian-mcp-${createHash('sha256').update(`${vault.vault}\0${vault.configDir}`).digest('hex').slice(0, 10)}`;
function table(value: unknown): value is TomlTable {
  return typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export async function readConfig(home: string): Promise<{ raw?: Buffer; config: TomlTable }> {
  const raw = await readOptional(join(home, 'config.toml'), 4 * 1024 * 1024);
  try { return { raw, config: raw ? parse(raw.toString('utf8')) : {} }; }
  catch { throw new Error('config.toml do Codex é inválido; ele não será sobrescrito.'); }
}
function servers(config: TomlTable): TomlTable {
  if (config.mcp_servers === undefined) config.mcp_servers = {};
  if (!table(config.mcp_servers)) throw new Error('mcp_servers não é uma tabela válida no Codex.');
  return config.mcp_servers;
}
export function matches(entry: unknown, settings: Settings, env: NodeJS.ProcessEnv, allowDisabled = false): boolean {
  if (!table(entry) || entry.url !== endpoint(settings) || (!allowDisabled && entry.enabled === false) || entry.command !== undefined) return false;
  const headers = table(entry.http_headers) ? entry.http_headers : {};
  const envHeaders = table(entry.env_http_headers) ? entry.env_http_headers : {};
  const authKey = Object.keys(headers).find(key => key.toLowerCase() === 'authorization');
  const envKey = Object.keys(envHeaders).find(key => key.toLowerCase() === 'authorization');
  const authorization = authKey ? headers[authKey] : envKey && typeof envHeaders[envKey] === 'string' ? env[envHeaders[envKey] as string] : undefined;
  const bearer = typeof entry.bearer_token_env_var === 'string' ? env[entry.bearer_token_env_var] : undefined;
  return authorization === `Bearer ${settings.token}` || bearer === settings.token;
}
async function backup(home: string, raw?: Buffer): Promise<void> {
  if (raw) await atomicWrite(join(home, `config.toml.obsidian-mcp-backup-${Date.now()}-${randomUUID().slice(0, 8)}`), raw, 0o600);
}
export interface CodexRegistration { name: string; managed: boolean; home: string; manual?: string }
export async function manualConfig(rt: Runtime, vault: Vault, settings: Settings, name: string): Promise<CodexRegistration> {
  const path = join(vault.plugin, 'codex-config.toml');
  await atomicWrite(path, stringify({ mcp_servers: { [name]: { url: endpoint(settings), http_headers: { Authorization: `Bearer ${settings.token}` } } } }), 0o600);
  rt.log(`Configuração manual salva em ${path} (contém o token). Importe a tabela em ${join(codexHome(rt), 'config.toml')} ou use Settings → MCP servers.`);
  return { name, home: codexHome(rt), managed: false, manual: path };
}
export async function configureCodex(rt: Runtime, vault: Vault, settings: Settings, options: { manual?: boolean; name?: string; owned?: CodexRegistration } = {}): Promise<CodexRegistration> {
  const home = codexHome(rt), name = options.name ?? options.owned?.name ?? serverName(vault);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('Nome MCP inválido.');
  if (options.manual) {
    const result = await manualConfig(rt, vault, settings, name);
    return { ...result, managed: !!options.owned?.managed && options.owned.home === home && options.owned.name === name };
  }
  try {
    await directory(home);
    return await withLock(join(home, '.obsidian-mcp.lock'), async () => {
      const original = await readConfig(home);
      const entries = servers(original.config);
      const owned = options.owned?.managed && options.owned.home === home && options.owned.name === name;
      // Reuse a user's correctly configured entry without taking ownership of it.
      for (const [existingName, entry] of Object.entries(entries)) {
        if (matches(entry, settings, rt.env)) return { name: existingName, managed: !!owned && existingName === name, home };
      }
      const current = entries[name];
      if (current !== undefined && (!owned || !table(current) || current.url !== endpoint(settings))) throw new Error('Conflito com um servidor MCP existente.');
      await backup(home, original.raw);
      let touched = false;
      try {
        let base = original.config;
        if (current === undefined) {
          touched = true;
          const result = await rt.runCodex(['mcp', 'add', name, '--url', endpoint(settings)], home);
          if (result.available && result.ok) {
            const after = await readConfig(home);
            // A CLI success must not silently change unrelated configuration.
            const expected = structuredClone(original.config);
            const actual = structuredClone(after.config);
            delete servers(expected)[name]; delete servers(actual)[name];
            if (!isDeepStrictEqual(expected, actual)) {
              if (original.raw) await atomicWrite(join(home, 'config.toml'), original.raw, 0o600);
              throw new Error('A CLI alterou configurações não relacionadas.');
            }
            base = after.config;
          } else {
            // Fallback also covers old Codex versions and partial command failures.
            if (original.raw) await atomicWrite(join(home, 'config.toml'), original.raw, 0o600);
          }
        }
        const entry = table(servers(base)[name]) ? servers(base)[name] as TomlTable : {};
        const headers = table(entry.http_headers) ? entry.http_headers : {};
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key];
        headers.Authorization = `Bearer ${settings.token}`;
        entry.url = endpoint(settings); entry.http_headers = headers;
        delete entry.bearer_token_env_var;
        if (table(entry.env_http_headers)) for (const key of Object.keys(entry.env_http_headers)) if (key.toLowerCase() === 'authorization') delete entry.env_http_headers[key];
        servers(base)[name] = entry;
        touched = true;
        await atomicWrite(join(home, 'config.toml'), stringify(base), 0o600);
        rt.log(`Codex configurado: ${name}. Reinicie o aplicativo ou o servidor MCP.`);
        return { name, managed: true, home };
      } catch (error) {
        if (touched) {
          if (original.raw) await atomicWrite(join(home, 'config.toml'), original.raw, 0o600);
          else await rm(join(home, 'config.toml'), { force: true });
        }
        throw error;
      }
    });
  } catch {
    rt.log('A configuração automática do Codex não pôde ser concluída; configurações conflitantes não serão substituídas.');
    const fallback = await manualConfig(rt, vault, settings, name);
    return { ...fallback, managed: !!options.owned?.managed && options.owned.home === home && options.owned.name === name };
  }
}
export async function inspectCodex(rt: Runtime, settings: Settings, name?: string): Promise<boolean> {
  const { config } = await readConfig(codexHome(rt));
  const entries = servers(config);
  return name ? matches(entries[name], settings, rt.env) : Object.values(entries).some(entry => matches(entry, settings, rt.env));
}
export async function removeCodex(rt: Runtime, settings: Settings, registration?: CodexRegistration): Promise<boolean> {
  if (!registration?.managed) return true;
  // Never let a file in a vault redirect writes to an arbitrary Codex home.
  if (registration.home !== codexHome(rt)) return false;
  const home = registration.home;
  return withLock(join(home, '.obsidian-mcp.lock'), async () => {
    const original = await readConfig(home);
    const entries = servers(original.config);
    if (entries[registration.name] === undefined) return true;
    if (!matches(entries[registration.name], settings, rt.env, true)) return false;
    await backup(home, original.raw);
    const result = await rt.runCodex(['mcp', 'remove', registration.name], home);
    if (result.ok) {
      const after = await readConfig(home);
      const expected = structuredClone(original.config); delete servers(expected)[registration.name];
      if (isDeepStrictEqual(expected, after.config)) return true;
    }
    delete entries[registration.name];
    await atomicWrite(join(home, 'config.toml'), stringify(original.config), 0o600);
    return true;
  });
}
