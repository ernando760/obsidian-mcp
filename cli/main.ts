import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runtime } from './runtime';
import { chooseVault } from './vaults';
import { activationStatus, install, uninstall, type InstallOptions } from './installer';
import { doctor } from './doctor';

const help = `Obsidian MCP — instalador (Node.js 22.12+)

  obsidian-mcp install [--vault <caminho>] [--source local|remote]
  obsidian-mcp update [--vault <caminho>] [--source local|remote]
  obsidian-mcp doctor [--vault <caminho>]
  obsidian-mcp uninstall [--vault <caminho>] [--yes]

Opções:
  --vault <caminho>        Vault existente; omitido abre seleção interativa
  --config-dir <nome>      Diretório do vault (padrão: .obsidian)
  --source local|remote    Artefatos locais ou release pública do GitHub
  --project <caminho>      Projeto compilado (local; detectado no projeto/CLI)
  --repo <dono/repo>       Repositório GitHub (ou OBSIDIAN_MCP_REPOSITORY)
  --version <tag>          Release estável exata; padrão remoto: latest
  --port <número>          Porta de uma nova instalação; preservada ao atualizar
  --name <nome>           Nome do servidor Codex (padrão: estável por vault)
  --manual                Gerar configuração Codex sem alterar seu config.toml
  --no-enable             Manter a lista de plugins ativos inalterada
  --yes                   Confirmar desinstalação sem prompt
  --help                  Mostrar esta ajuda

Update reutiliza a fonte registrada, preservando data.json e permissões.
Reinicie/recarregue o Obsidian e o Codex para aplicar mudanças.`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    vault: { type: 'string' }, 'config-dir': { type: 'string' }, source: { type: 'string' },
    project: { type: 'string' }, repo: { type: 'string' }, version: { type: 'string' },
    port: { type: 'string' }, name: { type: 'string' }, manual: { type: 'boolean' },
    'no-enable': { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) { console.log(help); return 0; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['install', 'update', 'doctor', 'uninstall'].includes(command!)) throw new Error('Comando inválido. Use obsidian-mcp --help.');
  if (values.source !== undefined && values.source !== 'local' && values.source !== 'remote') throw new Error('--source deve ser local ou remote.');
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) < 1024 || Number(values.port) > 65535)) throw new Error('--port deve estar entre 1024 e 65535.');
  if (values.project && values.source === 'remote') throw new Error('--project não se aplica à instalação remota.');
  if (command === 'doctor' || command === 'uninstall') {
    for (const option of ['source', 'project', 'repo', 'version', 'port', 'name', 'manual', 'no-enable'] as const) if (values[option] !== undefined) throw new Error(`--${option} não se aplica a ${command}.`);
  }
  if (command !== 'uninstall' && values.yes) throw new Error('--yes só se aplica a uninstall.');
  const rt = runtime();
  const terminal = stdin.isTTY && stdout.isTTY ? createInterface({ input: stdin, output: stdout }) : undefined;
  if (terminal) rt.ask = question => terminal.question(question);
  try {
    const vault = await chooseVault(rt, values.vault, values['config-dir'], command !== 'install');
    if (command === 'doctor') {
      const checks = await doctor(rt, vault);
      for (const check of checks) rt.log(`${check.ok ? 'OK' : 'FALHA'}  ${check.message}`);
      return checks.every(check => check.ok) ? 0 : 1;
    }
    if (command === 'uninstall') { await uninstall(rt, vault, values.yes); return 0; }
    const options: InstallOptions = {
      source: values.source, project: values.project, repo: values.repo, version: values.version,
      port: values.port ? Number(values.port) : undefined, manual: values.manual,
      name: values.name, noEnable: values['no-enable'],
    };
    const result = await install(rt, vault, options, command === 'update');
    await activationStatus(rt, vault, result.settings, result.artifacts.info.version);
    return 0;
  } finally { terminal?.close(); }
}
