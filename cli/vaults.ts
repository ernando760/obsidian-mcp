import { basename, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { z } from 'zod';
import { directory, json, jsonOptional, atomicWrite, safePath, statOptional } from './files';
import { stateDir, type Runtime } from './runtime';
import { obsidianRegistries, platform } from './platform';

export const registration = z.object({ vault: z.string(), configDir: z.string() });
export type Registration = z.infer<typeof registration>;
export interface Vault extends Registration { config: string; plugin: string }
const registrySchema = z.array(registration);
export async function registry(rt: Runtime): Promise<Registration[]> {
  const entries = registrySchema.parse(await jsonOptional(join(stateDir(rt), 'installations.json')) ?? []);
  const legacy = join(rt.home, '.local/state/obsidian-mcp/installations.json');
  if (platform(rt) !== 'linux' && legacy !== join(stateDir(rt), 'installations.json')) {
    entries.push(...registrySchema.parse(await jsonOptional(legacy) ?? []));
  }
  return [...new Map(entries.map(entry => [`${entry.vault}\0${entry.configDir}`, entry])).values()];
}
export async function saveRegistry(rt: Runtime, entries: Registration[]): Promise<void> {
  await atomicWrite(join(stateDir(rt), 'installations.json'), json(entries), 0o600);
}
export async function validateVault(path: string, configDir = '.obsidian'): Promise<Vault> {
  if (!/^[.A-Za-z0-9_-]+$/.test(configDir) || configDir === '.' || configDir === '..') throw new Error('Diretório de configuração inválido; use um nome simples como .obsidian.');
  const expanded = path === '~' ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
  const vault = await realpath(resolve(expanded));
  const config = join(vault, configDir);
  await safePath(config);
  if (!(await statOptional(vault))?.isDirectory() || !(await statOptional(config))?.isDirectory()) {
    throw new Error(`Vault inválido: é necessário um diretório existente com ${configDir}/. Abra-o antes no Obsidian.`);
  }
  const plugin = join(config, 'plugins', 'obsidian-mcp');
  await safePath(plugin);
  const current = await statOptional(plugin);
  if (current && !current.isDirectory()) throw new Error('O destino do plugin não é um diretório.');
  return { vault, configDir, config, plugin };
}
export async function discoverVaults(rt: Runtime, installedOnly = false): Promise<Registration[]> {
  const candidates = [...await registry(rt)];
  const configs = obsidianRegistries(rt);
  for (const path of configs) {
    let settings: unknown;
    try { settings = await jsonOptional(path); }
    catch { rt.log(`Cadastro de vaults ilegível: ${path}. Use --vault para informar o caminho.`); continue; }
    const parsed = z.object({ vaults: z.record(z.object({ path: z.string() }).passthrough()) }).passthrough().safeParse(settings);
    if (parsed.success) for (const { path } of Object.values(parsed.data.vaults)) candidates.push({ vault: path, configDir: '.obsidian' });
  }
  const found = new Map<string, Registration>();
  for (const candidate of candidates) {
    try {
      const vault = await validateVault(candidate.vault, candidate.configDir);
      if (installedOnly && !(await statOptional(join(vault.plugin, 'manifest.json')))) continue;
      found.set(`${vault.vault}\0${vault.configDir}`, { vault: vault.vault, configDir: vault.configDir });
    } catch { /* stale registrations are not offered */ }
  }
  return [...found.values()];
}
export async function chooseVault(rt: Runtime, path?: string, configDir?: string, installedOnly = false): Promise<Vault> {
  if (path) return validateVault(path, configDir);
  const found = await discoverVaults(rt, installedOnly);
  if (found.length === 1 && installedOnly) return validateVault(found[0]!.vault, configDir ?? found[0]!.configDir);
  if (!rt.ask) throw new Error('Informe --vault <caminho>; a seleção interativa exige um terminal.');
  found.forEach((v, i) => rt.log(`${i + 1}. ${basename(v.vault)} — ${v.vault} (${v.configDir})`));
  const answer = (await rt.ask(found.length ? 'Escolha o número do vault ou informe seu caminho: ' : 'Caminho do vault: ')).trim();
  const selected = /^\d+$/.test(answer) ? found[Number(answer) - 1] : undefined;
  if (/^\d+$/.test(answer) && !selected) throw new Error('Número de vault inválido.');
  if (!selected && !answer) throw new Error('Nenhum vault selecionado.');
  return validateVault(selected?.vault ?? answer, configDir ?? selected?.configDir);
}
export async function communityPlugins(vault: Vault): Promise<string[]> {
  return z.array(z.string()).parse(await jsonOptional(join(vault.config, 'community-plugins.json')) ?? []);
}
export async function enablePlugin(vault: Vault, enable: boolean): Promise<void> {
  const list = await communityPlugins(vault);
  const next = list.filter(id => id !== 'obsidian-mcp');
  if (enable) next.push('obsidian-mcp');
  if (JSON.stringify(next) !== JSON.stringify(list)) await atomicWrite(join(vault.config, 'community-plugins.json'), json(next));
}
export async function prepareVault(vault: Vault): Promise<void> { await directory(vault.plugin); }
