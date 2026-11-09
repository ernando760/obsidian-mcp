import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { z } from 'zod';
import { loadSettings, type Settings } from '../src/settings';
import { type Artifacts, compareVersion, localArtifacts, manifest, remoteArtifacts } from './artifacts';
import { atomicWrite, directory, json, jsonOptional, readOptional, safePath, statOptional, transaction, withLock } from './files';
import { configureCodex, endpoint, removeCodex, type CodexRegistration } from './codex';
import { probeServer } from './doctor';
import { protectCredentials } from './permissions';
import { releaseRepository } from './repository';
import { stateDir, type Runtime } from './runtime';
import { communityPlugins, enablePlugin, prepareVault, registry, saveRegistry, validateVault, type Vault } from './vaults';

const metadataSchema = z.object({
  source: z.enum(['local', 'remote']), version: z.string(), project: z.string().optional(), repo: z.string().optional(), tag: z.string().optional(),
  codex: z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), home: z.string(), managed: z.boolean(), manual: z.string().optional() }).optional(),
});
export type Metadata = z.infer<typeof metadataSchema>;
export interface InstallOptions {
  source?: 'local' | 'remote'; project?: string; repo?: string; version?: string;
  port?: number; manual?: boolean; name?: string; noEnable?: boolean;
}
export async function metadata(vault: Vault): Promise<Metadata | undefined> {
  const data = await jsonOptional(join(vault.plugin, '.installer.json'));
  return data === undefined ? undefined : metadataSchema.parse(data);
}
async function artifacts(rt: Runtime, options: InstallOptions, previous?: Metadata): Promise<Artifacts> {
  const source = options.source ?? previous?.source ?? 'local';
  if (source === 'remote' && options.project) throw new Error('--project não se aplica à instalação remota.');
  if (source === 'remote') return remoteArtifacts(rt, releaseRepository(options.repo, rt.env.OBSIDIAN_MCP_REPOSITORY, previous?.repo), options.version);
  if (options.repo || options.version) throw new Error('--repo e --version exigem --source remote.');
  if (options.project || previous?.project) return localArtifacts(options.project ?? previous!.project!);
  const cwdManifest = await readOptional(join(process.cwd(), 'manifest.json'));
  if (cwdManifest) return localArtifacts(process.cwd());
  return localArtifacts(fileURLToPath(new URL('../', import.meta.url)));
}
async function newSettings(rt: Runtime, vault: Vault, port?: number): Promise<Settings> {
  const settings = loadSettings(null);
  const used = new Set<number>();
  for (const other of await registry(rt)) {
    if (other.vault === vault.vault && other.configDir === vault.configDir) continue;
    try {
      const info = await validateVault(other.vault, other.configDir);
      const data = await jsonOptional(join(info.plugin, 'data.json'));
      if (data) used.add(loadSettings(data).port);
    } catch { /* ignore removed vaults */ }
  }
  if (port !== undefined) {
    settings.port = loadSettings({ ...settings, port }).port;
    if (used.has(port)) throw new Error('Esta porta já está reservada por outro vault instalado. Escolha --port diferente.');
    return settings;
  }
  for (let candidate = 27124; candidate < 27224; candidate++) {
    if (!used.has(candidate) && await rt.portAvailable(candidate)) return { ...settings, port: candidate };
  }
  throw new Error('Nenhuma porta disponível entre 27124 e 27223. Informe --port.');
}
export async function install(rt: Runtime, vault: Vault, options: InstallOptions = {}, updating = false): Promise<{ settings: Settings; artifacts: Artifacts; codex: CodexRegistration }> {
  const previous = await metadata(vault);
  if (options.name && !/^[A-Za-z0-9_-]{1,80}$/.test(options.name)) throw new Error('Nome MCP inválido.');
  if (options.name && previous?.codex?.managed && options.name !== previous.codex.name) throw new Error('O nome MCP gerenciado será preservado. Remova a integração anterior antes de renomeá-la.');
  // Validate/download the full release before touching the installation.
  const bundle = await artifacts(rt, options, previous);
  return withLock(join(stateDir(rt), '.lock'), () => withLock(join(vault.config, '.obsidian-mcp-install.lock'), async () => {
    const oldManifest = await readOptional(join(vault.plugin, 'manifest.json'));
    if (updating && !oldManifest) throw new Error('Plugin não instalado neste vault. Use install.');
    if (oldManifest && compareVersion(bundle.info.version, manifest(oldManifest).version) < 0) throw new Error('Downgrade recusado. Selecione uma release igual ou mais recente.');
    const dataPath = join(vault.plugin, 'data.json');
    const rawSettings = await readOptional(dataPath);
    const settings = rawSettings ? loadSettings(await jsonOptional(dataPath)) : await newSettings(rt, vault, options.port);
    if (rawSettings && options.port !== undefined && settings.port !== options.port) throw new Error('A porta existente será preservada. Para alterá-la, configure o plugin separadamente.');
    // Fail before replacing artifacts if activation configuration is malformed.
    const enabled = await communityPlugins(vault);
    await prepareVault(vault);
    const changes = [
      { path: join(vault.plugin, 'main.js'), data: bundle.main },
      { path: join(vault.plugin, 'manifest.json'), data: bundle.manifest },
    ];
    if (!rawSettings) changes.push({ path: dataPath, data: Buffer.from(json(settings)) });
    if (!updating && !options.noEnable && !enabled.includes('obsidian-mcp')) changes.push({ path: join(vault.config, 'community-plugins.json'), data: Buffer.from(json([...enabled, 'obsidian-mcp'])) });
    if (!rawSettings) await directory(join(vault.vault, 'MCP'));
    await transaction(changes);
    // Restrict existing credentials without rewriting their content.
    await protectCredentials(dataPath);
    const codex = await configureCodex(rt, vault, settings, { manual: options.manual, name: options.name, owned: previous?.codex });
    const next: Metadata = { source: bundle.source, version: bundle.info.version, project: bundle.project, repo: bundle.repo, tag: bundle.tag, codex };
    await atomicWrite(join(vault.plugin, '.installer.json'), json(next), 0o600);
    const entries = (await registry(rt)).filter(v => v.vault !== vault.vault || v.configDir !== vault.configDir);
    entries.push({ vault: vault.vault, configDir: vault.configDir });
    await saveRegistry(rt, entries);
    rt.log(`${oldManifest ? 'Instalação atualizada' : 'Plugin instalado'}: ${bundle.info.version} em ${vault.plugin}`);
    rt.log(`Endpoint: ${endpoint(settings)}. Token ${rawSettings ? 'preservado' : 'gerado'}; permissões de notas ${rawSettings ? 'preservadas' : 'limitadas a MCP/'}.`);
    return { settings, artifacts: bundle, codex };
  }));
}
export async function activationStatus(rt: Runtime, vault: Vault, settings: Settings, version: string): Promise<void> {
  const checks = await probeServer(rt, settings, version);
  if (checks.length >= 3 && checks.every(c => c.ok)) rt.log('Obsidian carregou o plugin; autenticação e ferramentas MCP verificadas.');
  else rt.log(`Ativação/recarga pendente: abra ${vault.vault} no Obsidian, permita plugins da comunidade e ative ou recarregue Obsidian MCP. Reinicie o Codex e execute obsidian-mcp doctor --vault ${JSON.stringify(vault.vault)}.`);
}
export async function uninstall(rt: Runtime, vault: Vault, yes = false): Promise<boolean> {
  const data = await readOptional(join(vault.plugin, 'manifest.json'));
  if (!data) throw new Error('Plugin não instalado neste vault.');
  manifest(data);
  rt.log(`Remover o plugin e seu token em ${vault.plugin}. As notas e pastas do vault serão mantidas.`);
  if (!yes) {
    if (!rt.ask) throw new Error('Desinstalação exige confirmação em um terminal ou --yes.');
    if ((await rt.ask('Digite remover para confirmar: ')).trim() !== 'remover') { rt.log('Desinstalação cancelada.'); return false; }
  }
  return withLock(join(stateDir(rt), '.lock'), () => withLock(join(vault.config, '.obsidian-mcp-install.lock'), async () => {
    const allowed = new Set(['main.js', 'manifest.json', 'data.json', '.installer.json', 'codex-config.toml']);
    const names = await readdir(vault.plugin);
    if (names.some(name => !allowed.has(name))) throw new Error('A pasta contém arquivos desconhecidos. Remova-os manualmente antes de desinstalar.');
    for (const name of names) {
      await safePath(join(vault.plugin, name));
      if (!(await statOptional(join(vault.plugin, name)))?.isFile()) throw new Error('A instalação contém arquivos inseguros.');
    }
    const info = await metadata(vault);
    const saved = await jsonOptional(join(vault.plugin, 'data.json'));
    if (saved && info?.codex?.managed) {
      let removed = false;
      try { removed = await removeCodex(rt, loadSettings(saved), info.codex); } catch { /* explain partial cleanup */ }
      if (!removed) rt.log(`A entrada Codex ${info.codex.name} foi mantida: foi alterada, está inacessível ou pertence a outro CODEX_HOME. Revise-a manualmente.`);
    }
    await enablePlugin(vault, false);
    for (const name of names) await rm(join(vault.plugin, name));
    await rmdir(vault.plugin);
    await saveRegistry(rt, (await registry(rt)).filter(v => v.vault !== vault.vault || v.configDir !== vault.configDir));
    rt.log('Plugin removido. Feche/reabra o vault para descarregar qualquer instância ainda em memória.');
    return true;
  }));
}
