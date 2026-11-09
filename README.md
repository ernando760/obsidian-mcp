# Obsidian MCP

Plugin para **Obsidian Desktop** que permite a agentes de IA, como o Codex, acessar notas Markdown e criar pastas autorizadas no vault por meio do **Model Context Protocol (MCP)**.

O servidor roda localmente com Streamable HTTP e autenticação por token. O projeto inclui um CLI para instalar, atualizar, diagnosticar e remover o plugin, além de configurar a integração com o Codex.

[Funcionalidades](#funcionalidades) · [Requisitos](#requisitos) · [Instalação](#instalação) · [Configuração](#configuração-e-integração-com-o-codex) · [Ferramentas MCP](#ferramentas-mcp) · [Diagnóstico](#diagnóstico-e-solução-de-problemas) · [Contribuição](#desenvolvimento-e-contribuição)

## Funcionalidades

- Listar, ler, pesquisar e criar notas Markdown pela API oficial do Obsidian.
- Criar pastas dentro dos diretórios autorizados em `allowedFolders`.
- Restringir o acesso a pastas escolhidas pelo usuário, incluindo suas subpastas.
- Exigir token Bearer e aceitar conexões somente em `127.0.0.1`.
- Bloquear caminhos fora das permissões, arquivos ocultos e links simbólicos.
- Iniciar e encerrar o servidor junto com o plugin.
- Instalar artefatos locais ou releases públicas do GitHub, com verificação SHA-256.
- Configurar o Codex automaticamente, preservando configurações existentes e oferecendo uma alternativa manual.

O plugin não possui painel de configurações. As permissões de acesso são definidas em `data.json`.

## Requisitos

| Componente | Requisito |
| --- | --- |
| Obsidian | Desktop 1.8.7 ou posterior, com plugins da comunidade permitidos |
| Vault | Diretório local já aberto no Obsidian, com `.obsidian/` ou outro diretório de configuração existente |
| CLI | Node.js 22.12 ou posterior em Linux, macOS ou Windows |
| Build local | npm e as dependências do projeto |
| Instalador remoto | Linux/macOS: shell POSIX e `curl`; Windows: PowerShell 5.1 ou posterior; uma release pública do GitHub |
| Codex | Cliente local na mesma máquina e no mesmo namespace de rede do Obsidian |

O Node.js é necessário para o CLI e a compilação; o plugin instalado executa no runtime do Obsidian.

## Instalação

### Local

Na raiz de uma cópia do repositório:

```sh
npm ci
npm run build
npm link
obsidian-mcp install
```

O instalador oferece os vaults registrados pelo Obsidian no sistema (incluindo Flatpak no Linux) e permite digitar outro caminho. Para selecionar o vault diretamente:

```sh
obsidian-mcp install --vault "/caminho/do/vault" --source local
```

Sem registrar o comando no PATH com `npm link`, use `npm run cli -- install --vault "/caminho/do/vault"` após o build.

O CLI instala `main.js` e `manifest.json` em `.obsidian/plugins/obsidian-mcp/`, prepara `data.json`, registra a ativação e configura o Codex. Em Linux/macOS, aplica `0600` ao `data.json`; no Windows, restringe sua ACL ao usuário atual e a SYSTEM. O conteúdo existente é preservado.

### Remota: Linux e macOS

Os instaladores baixam e verificam o CLI, instalam um launcher por usuário e delegam a instalação do plugin ao CLI. Não é necessário clonar o repositório, usar npm ou compilar. Não requerem `sudo` nem alteram os perfis do shell.

Os exemplos abaixo serão utilizáveis após a publicação de uma release contendo os instaladores. A origem padrão é [`ernando760/obsidian-mcp`](https://github.com/ernando760/obsidian-mcp). Substitua `0.1.0` pela **tag exata** da release desejada. A origem oficial é declarada em `package.json.repository` e incorporada ao CLI e aos scripts preparados para a release. A URL configurada é `https://github.com/ernando760/obsidian-mcp.git`; a criação e disponibilidade do remoto devem ser verificadas antes da distribuição. Argumentos e `OBSIDIAN_MCP_REPOSITORY` continuam permitindo selecionar outra origem.

Baixe e confira o próprio script antes de executá-lo. A verificação abaixo usa `sha256sum` no Linux ou `shasum` no macOS:

```sh
REPO='ernando760/obsidian-mcp'
TAG='0.1.0'
curl -fL "https://github.com/$REPO/releases/download/$TAG/install.sh" -o install.sh &&
curl -fL "https://github.com/$REPO/releases/download/$TAG/SHA256SUMS" -o SHA256SUMS &&
if command -v sha256sum >/dev/null 2>&1; then
  awk '$2 == "install.sh" { print }' SHA256SUMS | sha256sum --check -
else
  awk '$2 == "install.sh" { print }' SHA256SUMS | shasum -a 256 --check -
fi &&
sh ./install.sh --repo "$REPO" --version "$TAG"
```

A precedência é argumento explícito, variável `OBSIDIAN_MCP_REPOSITORY` e origem oficial incorporada. No comando `update` do CLI, uma origem já registrada é reaproveitada antes do padrão oficial.

Sem `--vault`, o CLI detecta os vaults registrados ou solicita o caminho em um terminal interativo. Para informar o vault diretamente:

```sh
# Linux
sh ./install.sh --repo "$REPO" --version "$TAG" --vault "$HOME/Documentos/Meu Vault"
# macOS
sh ./install.sh --repo "$REPO" --version "$TAG" --vault "$HOME/Documents/Meu Vault"
```

O launcher fica em `~/.local/bin/obsidian-mcp`. Se esse diretório não estiver no PATH, use o caminho completo, por exemplo `~/.local/bin/obsidian-mcp doctor`. `--install-dir` e `--bin-dir` permitem escolher outros destinos, inclusive caminhos com espaços.

### Remota: Windows

Use PowerShell 5.1 ou posterior, com Node.js 22.12+ disponível no PATH. Execute como seu usuário normal; não é necessário abrir o terminal como administrador.

```powershell
$Repo = 'ernando760/obsidian-mcp'
$Tag = '0.1.0'
Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/releases/download/$Tag/install.ps1" -OutFile install.ps1 -ErrorAction Stop
Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/releases/download/$Tag/SHA256SUMS" -OutFile SHA256SUMS -ErrorAction Stop
$Entries = @(Get-Content SHA256SUMS | Where-Object { $_ -cmatch '^([a-f0-9]{64}) [ *]install\.ps1$' })
$Actual = (Get-FileHash .\install.ps1 -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Entries.Count -ne 1 -or $Entries[0].Substring(0, 64) -cne $Actual) { throw 'Checksum do instalador inválido' }
Unblock-File -LiteralPath .\install.ps1
.\install.ps1 -Repo $Repo -Version $Tag -Vault 'C:\Users\SeuUsuario\Documents\Meu Vault'
```

Omita `-Vault` para a descoberta e seleção interativa. O script não altera a política global de execução nem o PATH. O launcher fica em `%LOCALAPPDATA%\ObsidianMCP\obsidian-mcp.cmd`; use o caminho completo se o diretório não estiver no PATH:

```powershell
& "$env:LOCALAPPDATA\ObsidianMCP\obsidian-mcp.cmd" doctor --vault 'C:\Users\SeuUsuario\Documents\Meu Vault'
```

Use `-InstallDir 'D:\Ferramentas\Obsidian MCP'` para outro destino. O CLI protege credenciais com ACLs nativas, verificadas pelo `doctor`; o destino deve oferecer suporte a ACLs, como em volumes NTFS. `chmod 600` não representa essa proteção no Windows, conforme as [limitações de permissões do Node.js](https://nodejs.org/api/fs.html#fschmodpath-mode-callback).

### Opções dos scripts e integridade

| Linux/macOS | Windows | Função |
| --- | --- | --- |
| `--repo`, `--version` | `-Repo`, `-Version` | Selecionar repositório e tag; sem versão, resolve `latest` e fixa a tag no CLI |
| `--vault` | `-Vault` | Informar o vault diretamente |
| `--update` | `-Update` | Atualizar o CLI e delegar `update` ao núcleo existente |
| `--manual` | `-Manual` | Gerar configuração manual do Codex |
| `--config-dir`, `--port`, `--name`, `--no-enable` | `-ConfigDir`, `-Port`, `-Name`, `-NoEnable` | Encaminhar as opções correspondentes ao CLI |
| `--help` | `-Help` | Exibir a ajuda do script |

A release inclui `install.sh`, `install.ps1`, `obsidian-mcp-cli.mjs`, `main.js`, `manifest.json` e `SHA256SUMS`. Os scripts verificam o SHA-256 do CLI antes de executá-lo; em seguida, o CLI verifica os artefatos do plugin. Releases preliminares e rascunhos são recusados. A confiança na origem continua sendo a confiança no repositório e na release escolhidos.

A instalação configura o Codex automaticamente, reaproveita tokens e permissões de notas existentes e informa quando falta recarregar o Obsidian. Para uma alternativa totalmente manual, baixe `main.js` e `manifest.json` da mesma release, confira seus hashes em `SHA256SUMS` e copie-os para a pasta do plugin conforme a seção seguinte.

### Ativação e opções do instalador

Abra o vault no Obsidian, permita plugins da comunidade e confira se **Obsidian MCP** está ativo. Se o aplicativo já estava aberto, recarregue o plugin ou feche e reabra o vault. O CLI verifica o carregamento por uma conexão MCP autenticada e informa quando a ativação ainda está pendente.

| Opção | Uso |
| --- | --- |
| `--vault <path>` | Selecionar o vault; evita a seleção interativa |
| `--config-dir <nome>` | Usar outro diretório de configuração, como `.obsidian-trabalho` |
| `--source local\|remote` | Selecionar a origem dos artefatos em install/update |
| `--project <path>` | Indicar um projeto local com artefatos compilados |
| `--repo <dono/repo>` / `--version <tag>` | Selecionar repositório e release remotos |
| `--port <número>` | Definir a porta de uma nova instalação |
| `--name <nome>` | Definir o nome da entrada MCP no Codex |
| `--manual` | Gerar a configuração Codex para importação manual |
| `--no-enable` | Manter a lista de plugins ativos inalterada |

Use `obsidian-mcp --help` para consultar os comandos. Como alternativa ao CLI, copie `main.js` e `manifest.json` para a pasta do plugin e ative-o no Obsidian; o primeiro carregamento gera `data.json`. A conexão Codex pode ser configurada conforme a seção abaixo.

## Configuração e integração com o Codex

### Pastas autorizadas

**A pasta `MCP/` não é obrigatória para o funcionamento do plugin.** Qualquer pasta permitida pela política de caminhos pode ser autorizada em `allowedFolders`.

O padrão inicial é `["MCP"]`. Quando não existe `data.json`, o CLI também cria essa pasta como configuração inicial. Atualmente, não há uma opção do CLI para escolher `allowedFolders`; para utilizar outras pastas, ajuste o arquivo de configuração.

1. Desative o plugin no Obsidian.
2. Edite `<vault>/.obsidian/plugins/obsidian-mcp/data.json`, mantendo o token gerado.
3. Configure as pastas desejadas e reative o plugin.

Exemplo de configuração — substitua o token ilustrativo pelo valor existente:

```json
{
  "port": 27124,
  "token": "COLE_AQUI_O_TOKEN_GERADO_DE_64_CARACTERES_HEXADECIMAIS",
  "allowedFolders": ["Notas", "Projetos/Compartilhados"]
}
```

Nesse exemplo, os agentes podem acessar `Notas/reuniao.md` e `Projetos/Compartilhados/plano.md`, incluindo notas em suas subpastas. A pasta `MCP/` pode ficar fora da configuração e ser removida se estiver vazia.

| Campo | Comportamento |
| --- | --- |
| `allowedFolders` | Caminhos relativos ao vault, sem barra final; `[]` bloqueia todas as notas e a criação de pastas |
| `port` | Inteiro entre 1024 e 65535; cada vault aberto precisa de uma porta diferente |
| `token` | Token Bearer com 64 caracteres hexadecimais minúsculos, equivalente a 256 bits |

Não são aceitos a raiz do vault, caminhos absolutos, segmentos `..`, pastas ocultas, links simbólicos ou o diretório de configuração do Obsidian. As pastas usadas para leitura devem existir; para criar uma pasta autorizada, use `create_folder` com a pasta pai já existente.

Uma instalação nova pelo CLI procura uma porta livre entre 27124 e 27223; `--port` permite escolher outra sem fazer bind de teste. A instalação manual usa 27124 por padrão. O servidor atende em `http://127.0.0.1:<porta>/mcp`.

### Integração automática

O instalador usa `codex mcp add` quando disponível e completa a autenticação em `config.toml`. Se a CLI do Codex não estiver instalada, configura o arquivo diretamente.

A configuração fica em `~/.codex/config.toml`, ou no diretório definido por `CODEX_HOME`. O instalador usa um nome estável por vault, reaproveita entradas corretas e evita substituir servidores conflitantes. Antes de modificar um TOML existente, cria um backup `config.toml.obsidian-mcp-backup-*`; valores não relacionados são preservados, mas comentários e formatação podem ser normalizados.

Reinicie o Codex após configurar a conexão. Mantenha o vault aberto e o plugin ativo durante o uso.

### Integração manual

Para instalar sem alterar a configuração do Codex:

```sh
obsidian-mcp install --vault "/caminho/do/vault" --manual
```

O CLI salva a tabela em `.obsidian/plugins/obsidian-mcp/codex-config.toml`, com permissão `0600` em Linux/macOS ou ACL privada no Windows. Essa alternativa também é gerada quando a configuração automática encontra um conflito ou um arquivo inacessível ou inválido.

Importe a tabela no TOML do Codex ou configure a conexão equivalente:

```toml
[mcp_servers.obsidian]
url = "http://127.0.0.1:27124/mcp"
http_headers = { Authorization = "Bearer COLE_AQUI_O_TOKEN_DE_DATA_JSON" }
```

Use a porta de `data.json` e evite duplicar uma tabela existente. O token é local, não uma chave da OpenAI. Não o publique em issues ou logs. A autenticação utiliza Bearer estático, sem OAuth. Se trocar a porta ou o token, atualize também a conexão do Codex; executar `install` novamente permite tentar reconciliar a integração.

### Uso no Codex

Com as pastas do exemplo autorizadas, peça ao agente:

- “Liste minhas notas usando `list_notes`.”
- “Leia `Notas/reuniao.md`.”
- “Pesquise por ‘planejamento’ nas notas autorizadas.”
- “Crie `Projetos/Compartilhados/rascunho.md` com o conteúdo `# Rascunho`.”

As políticas de aprovação do cliente continuam valendo. Conteúdos retornados pelas ferramentas podem ser enviados pelo agente ao provedor de IA.

## Ferramentas MCP

Os caminhos são relativos ao vault e incluem a pasta autorizada. Notas exigem extensão `.md`. As respostas incluem JSON no conteúdo textual MCP; falhas de execução retornam `isError: true`.

| Ferramenta | Argumentos | Resultado |
| --- | --- | --- |
| `list_notes` | `offset` opcional: 0; `limit` opcional: 100, máximo 200 | Notas com caminho, tamanho e modificação; total e offset |
| `read_note` | `path` | Caminho e conteúdo da nota |
| `search_notes` | `query`; `limit` opcional: 50, máximo 200 | Caminhos e trechos correspondentes |
| `create_note` | `path`, `content` | Caminho e `created: true` |
| `create_folder` | `path` | Caminho e `created`; retorna `false` se a pasta já existir |

A busca é literal, ignora maiúsculas/minúsculas e pesquisa nos caminhos e conteúdos. Leitura, busca e criação de notas respeitam o limite de **1 MiB por nota em UTF-8**; notas maiores ainda aparecem na listagem. Criações exigem uma pasta pai existente e não sobrescrevem arquivos. Não há ferramentas de edição ou exclusão de notas.

O transporte é Streamable HTTP sem sessões, via `POST /mcp`, com respostas JSON. Requisições com `Origin` são recusadas e o servidor valida o cabeçalho `Host`. A proteção de caminhos pressupõe um sistema de arquivos local confiável; ela não isola processos locais maliciosos que alterem arquivos durante uma operação.

## Atualização e desinstalação

### Atualizar

```sh
obsidian-mcp update --vault "/caminho/do/vault"
```

O comando reutiliza a origem registrada. Para fontes remotas, consulta `latest` novamente, salvo quando `--version` é informado. Para fontes locais, utiliza os artefatos do projeto registrado; compile a nova versão antes de atualizar. Downgrades são recusados.

A atualização preserva o conteúdo de `data.json`, incluindo token e `allowedFolders`, aplica `0600` em Linux/macOS ou ACL privada no Windows e mantém a escolha de ativação do plugin. Recarregue o plugin para executar a nova versão. O comando atualiza o plugin; o executável CLI deve ser obtido novamente quando houver uma nova versão dele.

### Desinstalar

```sh
obsidian-mcp uninstall --vault "/caminho/do/vault"
```

Confirme digitando `remover`, ou use `--yes` em automações. O comando remove os arquivos conhecidos do plugin, seu token e a entrada de ativação. Notas e pastas do vault são mantidas. A entrada Codex criada pelo instalador é removida apenas se ainda corresponder à instalação; entradas manuais reaproveitadas ou alteradas são preservadas. Pastas do plugin com arquivos desconhecidos exigem revisão manual.

Feche e reabra o vault para descarregar uma instância ainda em memória.

## Diagnóstico e solução de problemas

```sh
obsidian-mcp doctor --vault "/caminho/do/vault"
```

O diagnóstico verifica artefatos, configuração, permissões do token, registro de ativação, conexão HTTP, rejeição de chamadas sem token, autenticação MCP, versão carregada e integração local do Codex. Usa `tools/list`, sem ler ou criar notas.

Retorna `0` quando todas as verificações passam e `1` quando há falhas ou pendências. Install/update podem retornar `0` com a ativação ainda pendente; confira a mensagem final. Sem `--vault`, update/doctor/uninstall selecionam automaticamente uma única instalação descoberta; se houver várias, exigem seleção interativa ou caminho explícito.

| Sintoma | Verificação |
| --- | --- |
| Vault não encontrado | Abra-o no Obsidian; informe `--vault` e, se necessário, `--config-dir` |
| Servidor indisponível | Abra o vault, permita plugins da comunidade, ative/recarregue o plugin e confira conflitos de porta |
| HTTP 401 | Confira o token em `data.json` e na conexão Codex |
| HTTP 403 | Use o endereço loopback diretamente em um cliente MCP nativo, sem `Origin` |
| HTTP 405 no navegador | Esperado: a navegação usa GET; este servidor MCP atende por POST |
| Lista vazia | Confira `allowedFolders`, a existência de notas `.md` autorizadas e a indexação do Obsidian |
| Falha ao criar nota ou pasta | Confira a permissão, a existência da pasta pai e colisões com arquivos |
| Permissões inseguras | Execute install/update novamente; em Linux/macOS, também pode aplicar `chmod 600` ao `data.json`. No Windows, o CLI corrige a ACL |
| Versão carregada diferente | Recarregue o plugin após atualizar os artefatos |
| Codex sem conexão | Confira `CODEX_HOME`, a tabela MCP e a porta/token; reinicie o cliente |
| Lock obsoleto | Verifique se há outro instalador ativo antes de remover o lock indicado na mensagem |

Para erros de inicialização, abra o console de desenvolvedor do Obsidian e procure mensagens com `[Obsidian MCP]`.

## Desenvolvimento e contribuição

```sh
npm ci
npm test
npm run build
```

| Script | Função |
| --- | --- |
| `npm run dev` | Recompilar o plugin ao salvar; exige recarregá-lo no Obsidian |
| `npm run build` | Verificar tipos e gerar `main.js` e `dist/obsidian-mcp-cli.mjs` |
| `npm run build:cli` | Verificar tipos e compilar somente o CLI |
| `npm test` | Executar os testes do plugin e do instalador |
| `npm run release:prepare` | Compilar e preparar os artefatos e checksums; exige a origem oficial confirmada em `package.json.repository` |
| `npm run release:check` | Verificar hashes, versão, origem padrão e execução independente do CLI preparado |

```text
src/main.ts       Ciclo de vida do plugin
src/server/       Servidor HTTP e transporte MCP
src/tools/        Registro das ferramentas e schemas
src/vault/        Operações e políticas de acesso ao vault
src/settings.ts   Validação das configurações
cli/              Instalação, releases, integração Codex e diagnóstico
scripts/          Build e preparação de releases
install.sh        Bootstrap verificado para Linux/macOS
install.ps1       Bootstrap verificado para Windows
tests/            Testes do plugin e do CLI
```

Os testes usam vaults temporários e simulações da API Obsidian e de downloads. O workflow de testes está configurado para Linux, macOS e Windows, incluindo execução do instalador nativo com downloads simulados e verificações de ACL no Windows. Em ambientes que proíbem bind em localhost, os testes HTTP por socket são ignorados com aviso; execute-os em um ambiente sem essa restrição. Valide também o carregamento no Obsidian e a conexão no Codex antes de publicar uma release.

O estado da primeira publicação e as evidências disponíveis estão em [Preparação da primeira release](docs/release-readiness.md). Os resultados locais não substituem uma execução nativa da matriz do CI.

Para contribuir, descreva o comportamento esperado e o observado em uma issue. Em pull requests, mantenha as alterações focadas, inclua testes para mudanças de comportamento e informe as verificações executadas. Não inclua tokens nem conteúdo privado de vaults. Commits feitos por IA devem seguir [AGENTS.md](AGENTS.md): título curto, corpo descritivo e trailer `Co-authored-by:` verificável, separados por linhas em branco.

O [workflow de release](.github/workflows/release.yml) depende da matriz nativa do [workflow de testes](.github/workflows/test.yml) e da verificação dos artefatos antes de publicar uma tag estável. A tag, com ou sem `v`, deve corresponder à versão de `package.json` e `manifest.json`. O estado do instalador fica em `.installer.json` na pasta do plugin e em `installations.json` no diretório de estado de cada sistema:

| Sistema | Arquivos do CLI | Estado do instalador | Cadastro de vaults do Obsidian |
| --- | --- | --- | --- |
| Linux | `$XDG_DATA_HOME/obsidian-mcp` ou `~/.local/share/obsidian-mcp` | `$XDG_STATE_HOME/obsidian-mcp` ou `~/.local/state/obsidian-mcp` | `$XDG_CONFIG_HOME/obsidian/obsidian.json` ou `~/.config/obsidian/obsidian.json`; também Flatpak |
| macOS | `~/Library/Application Support/obsidian-mcp` | `~/Library/Application Support/obsidian-mcp` | `~/Library/Application Support/obsidian/obsidian.json` |
| Windows | `%LOCALAPPDATA%\ObsidianMCP` | `%LOCALAPPDATA%\obsidian-mcp` | `%APPDATA%\obsidian\obsidian.json` |

`XDG_STATE_HOME`, quando definido, substitui o diretório de estado em qualquer sistema. Instalações registradas no caminho antigo `~/.local/state/obsidian-mcp` continuam sendo reconhecidas em macOS e Windows. A integração do Codex continua em `~/.codex/config.toml` ou no diretório indicado por `CODEX_HOME`.

Os caminhos de perfil seguem os [diretórios globais do Obsidian](https://obsidian.md/help/data-storage). No Windows, o CLI trata os launchers `.cmd` conforme o comportamento de [processos filhos do Node.js](https://nodejs.org/api/child_process.html).

Licença: [BSD Zero Clause (0BSD)](LICENSE).
