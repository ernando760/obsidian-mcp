import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Settings } from '../src/settings';
import { loadSettings } from '../src/settings';
import { join } from 'node:path';
import { manifest } from './artifacts';
import { jsonOptional, readOptional } from './files';
import { endpoint, inspectCodex } from './codex';
import { communityPlugins, type Vault } from './vaults';
import type { Runtime } from './runtime';
import { credentialsProtected } from './permissions';
export interface Check { ok: boolean; message: string }
export async function probeServer(rt: Runtime, settings: Settings, expectedVersion: string): Promise<Check[]> {
  const url = endpoint(settings);
  const client = new Client({ name: 'obsidian-mcp-doctor', version: '0.1.0' });
  const checks: Check[] = [];
  try {
    const unauthorized = await rt.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{}', signal: AbortSignal.timeout(4000), redirect: 'error',
    });
    await unauthorized.body?.cancel();
    checks.push({ ok: unauthorized.status === 401, message: unauthorized.status === 401 ? 'HTTP local acessível; requisição sem token recusada.' : `Proteção HTTP inesperada: status ${unauthorized.status}; esperado 401.` });
    if (unauthorized.status !== 401) return checks;
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      fetch: rt.fetch, requestInit: { headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' },
    }), { timeout: 5000 });
    const info = client.getServerVersion();
    checks.push({ ok: info?.name === 'obsidian-mcp' && info.version === expectedVersion, message: info?.name === 'obsidian-mcp' && info.version === expectedVersion ? `Plugin ${info.version} carregado; token aceito via MCP.` : 'Servidor ou versão diferente do instalado. Recarregue o plugin e confira a porta.' });
    const tools = await client.listTools({}, { timeout: 5000 });
    const required = ['list_notes', 'read_note', 'search_notes', 'create_note'];
    const present = new Set(tools.tools.map(t => t.name));
    checks.push({ ok: required.every(name => present.has(name)), message: required.every(name => present.has(name)) ? `Ferramentas MCP disponíveis (${present.size}); nenhuma nota foi lida ou criada.` : 'Ferramentas MCP esperadas não foram encontradas.' });
  } catch {
    checks.push({ ok: false, message: `MCP indisponível ou token recusado em ${url}. Abra o vault, permita plugins da comunidade e recarregue Obsidian MCP. Confira conflitos de porta.` });
  } finally { await client.close().catch(() => {}); }
  return checks;
}
export async function doctor(rt: Runtime, vault: Vault): Promise<Check[]> {
  const checks: Check[] = [];
  let settings: Settings, version: string;
  try {
    const [data, main] = await Promise.all([readOptional(join(vault.plugin, 'manifest.json')), readOptional(join(vault.plugin, 'main.js'), 20 * 1024 * 1024)]);
    if (!data || !main?.length) throw new Error();
    version = manifest(data).version;
    const saved = await jsonOptional(join(vault.plugin, 'data.json'));
    if (!saved) throw new Error();
    settings = loadSettings(saved);
    checks.push({ ok: true, message: `Artefatos ${version} e data.json válidos em ${vault.plugin}.` });
    const protectedFile = await credentialsProtected(join(vault.plugin, 'data.json'));
    checks.push({ ok: protectedFile, message: protectedFile ? 'Token protegido pelas permissões do arquivo.' : process.platform === 'win32' ? 'data.json possui uma ACL insegura. Execute install/update para restringir o acesso.' : 'data.json é acessível a outros usuários. Use chmod 600 nesse arquivo.' });
  } catch { return [{ ok: false, message: 'Instalação ausente, insegura ou inválida. Execute install --vault com o caminho deste vault.' }]; }
  try {
    const enabled = (await communityPlugins(vault)).includes('obsidian-mcp');
    checks.push({ ok: enabled, message: enabled ? 'Plugin registrado em community-plugins.json; o teste MCP confirma o carregamento efetivo.' : 'Plugin não está na lista de ativação. Ative-o em Configurações → Plugins da comunidade.' });
  } catch { checks.push({ ok: false, message: 'community-plugins.json inválido.' }); }
  try {
    const configured = await inspectCodex(rt, settings);
    checks.push({ ok: configured, message: configured ? 'Codex possui uma entrada habilitada com URL e autenticação correspondentes.' : 'Integração Codex ausente, desativada ou com URL/token incorretos. Execute install novamente para configurar.' });
  } catch { checks.push({ ok: false, message: 'Não foi possível verificar o config.toml do Codex.' }); }
  checks.push(...await probeServer(rt, settings, version));
  return checks;
}
