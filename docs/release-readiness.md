# Preparação da primeira release

**Estado: [v0.1.0 publicada](https://github.com/ernando760/obsidian-mcp/releases/tag/v0.1.0); CI multiplataforma e auditoria de dependências aprovados.** A versão do projeto permanece `0.1.0`.
Os testes manuais dos aplicativos Obsidian e Codex em macOS e Windows permanecem pendentes.

## Origem oficial

A origem oficial está configurada em `package.json.repository` e nos instaladores:

```text
https://github.com/ernando760/obsidian-mcp.git
```

O repositório público e a branch `main` foram confirmados pelo conector GitHub.
O commit inicial é `f9a5f9d1cd63a812540fcf12b669f71889ec0579`, com origem,
atribuição e conteúdo auditados.

Com essa definição:

- O build incorpora a origem padrão no CLI independente.
- `release:prepare` incorpora a mesma origem em ambos os instaladores distribuídos
  e calcula os hashes dos arquivos finais, incluindo os scripts preenchidos.
- Argumentos explícitos prevalecem sobre `OBSIDIAN_MCP_REPOSITORY`; a variável
  prevalece sobre a origem anterior registrada e o padrão oficial.
- A preparação e a verificação recusam uma release sem origem oficial válida.

## Evidências e validações

Validação local após as correções: **150 testes aprovados e 3 ignorados**,
com testes HTTP executados mediante acesso ampliado, build, preparação e
verificação de artefatos aprovados. Os três ignorados são exclusivos de Windows.

A [execução nativa aprovada do CI](https://github.com/ernando760/obsidian-mcp/actions/runs/42675790640)
validou o commit `651d3f79ee11da41186d6184787e97cbb5afa768` nos três sistemas:

| Sistema | Aprovados | Ignorados | Resultado |
| --- | --- | --- | --- |
| Linux (`ubuntu-latest`) | 150 | 3 | Aprovado |
| macOS (`macos-latest`) | 150 | 3 | Aprovado |
| Windows (`windows-latest`) | 144 | 9 | Aprovado |

Os testes ignorados dependem das capacidades e do sistema operacional do runner.
Todos os jobs aprovaram build, sintaxe do instalador nativo, testes, preparação
e verificação dos artefatos. Os relatórios JUnit e checksums estão nos artefatos
`validation-*` dessa execução. A execução anterior do projeto também havia
passado nos três sistemas; seus resultados não substituem a validação das
dependências atualizadas.

A validação inclui:

- Instalação, atualização e desinstalação com os scripts nativos e o CLI real,
  usando downloads simulados e vaults temporários.
- Preservação do token, bytes de `data.json`, `allowedFolders`, notas e permissões
  durante a atualização; ACLs privadas verificadas no Windows.
- Substituição de CLI e launcher existentes, rejeição de downloads corrompidos
  e verificação dos hashes, versão e origem oficial dos artefatos.
- Servidor HTTP local, autenticação e integração Codex com configurações sintéticas.

O shell do macOS, o lockfile multiplataforma, a seleção do Node, os módulos
PowerShell, os caminhos Windows e a substituição de arquivos foram corrigidos
e validados pela matriz nativa. O bootstrap usa `[NullString]::Value` para passar
um caminho de backup nulo a `File.Replace`, conforme a [API oficial do PowerShell](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring).

Os testes automatizados usam dados sintéticos e downloads simulados. Os
artefatos da release publicada foram baixados e seus checksums conferidos. Na desinstalação confirmada, o token da
instalação é removido junto com o plugin; notas e entradas Codex não gerenciadas
são preservadas. O token é preservado em instalações repetidas e atualizações.

O sandbox padrão proíbe bind em localhost. Os testes HTTP foram executados com
permissão ampliada e `OBSIDIAN_MCP_REQUIRE_HTTP_TESTS=1`; o CI também usa essa
variável e falha se não puder executá-los. Testes exclusivos de Windows só executam nesse
sistema. O workflow guarda o relatório JUnit por sistema como evidência.

## Executar a validação sem publicar

Depois de disponibilizar este código em um checkout Git:

```sh
npm ci
npm test
npm run release:prepare
npm run release:check
```

Execute o workflow **Test** por push, pull request ou `workflow_dispatch` e confira
os jobs `ubuntu-latest`, `macos-latest` e `windows-latest`, além dos artefatos
`validation-*`. Esse workflow não publica releases. O workflow de publicação
reutiliza a matriz e só prossegue se todas as verificações passarem.

A geração de artefatos valida tags somente quando `GITHUB_REF_TYPE=tag`; nomes
de branches e referências de pull request não são tratados como versões.

## Auditoria de dependências

Em 9 de novembro de 2026, `npm audit` identificou **14 pacotes** sinalizados:
2 críticos, 5 altos, 6 moderados e 1 baixo. A contagem inclui dependências
intermediárias; não representa 14 vulnerabilidades independentes. Após as
atualizações, `npm audit` e `npm ci` retornaram **0 vulnerabilidades**.

| Pacote sinalizado | Severidade | Uso e impacto neste projeto | Correção |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | Alta | Produção: SDK no plugin e no CLI. Entradas HTTP excessivamente complexas podem esgotar recursos; o servidor já exige token e limita o corpo a 2 MiB. OAuth e tarefas experimentais dos avisos não são usados. | 1.32.2 e `maxToolInputElements=10000` |
| `zod` | Alta | Produção: validação de entradas no servidor. Coleções excessivas podem esgotar memória. | 4.6.7; limite de elementos do SDK ativado |
| `smol-toml` | Alta | Produção: o CLI lê `config.toml` local; TOML malformado poderia bloquear ou atrasar o processo. | 1.9.1 |
| `@hono/node-server` | Moderada | Transitiva de produção: avisos atingem serviço de arquivos estáticos, não usado pelo servidor do plugin. | 2.1.6 |
| `hono` | Moderada | Transitiva de produção: avisos envolvem HTML, formulários, geração estática e rotas não utilizadas pelo plugin. | 4.13.17 |
| `body-parser` | Alta | Transitiva de produção: aviso afeta corpos comprimidos processados pelo Express; o plugin usa `node:http` e JSON próprio. | 2.4.0 |
| `ip-address` | Moderada | Transitiva de produção: entrada IPv6 especialmente longa pode consumir CPU; o plugin não usa o limitador Express que a depende. | 10.7.6 |
| `vitest` | Crítica | Desenvolvimento: risco no servidor UI; o projeto usa `vitest run` sem UI e não distribui o Vitest. | 4.1.12 |
| `tinypool` | Crítica | Desenvolvimento: execução de código exige poluição de protótipo prévia; não é distribuído. | Removido da árvore atual |
| `@vitest/mocker` | Moderada | Desenvolvimento: riscos no servidor de mocks/UI, sem uso desses modos pelo projeto. | Atualizado com Vitest |
| `vite` | Alta | Desenvolvimento: avisos afetam principalmente servidor de desenvolvimento e editor; não é distribuído. | 8.3.7 |
| `esbuild` | Baixa | Desenvolvimento: aviso afeta servidor de desenvolvimento no Windows; o projeto usa build/watch, sem `serve`. | 0.28.2 |
| `moment` | Moderada | Desenvolvimento: transitiva dos tipos/API `obsidian`; o módulo Obsidian é externo ao bundle e fornecido pelo aplicativo. | 2.31.0 |
| `obsidian` | Moderada | Desenvolvimento: sinalizado por depender de `moment`; não é incorporado ao plugin. | 1.14.4 |

Os detalhes constam dos avisos oficiais de [SDK MCP](https://github.com/advisories/GHSA-46jr-4wx8-v453), [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [smol-toml](https://github.com/advisories/GHSA-7w5x-hrqm-74c2) e [Tinypool](https://github.com/advisories/GHSA-85c8-ppgw-ccpr).

As versões principais de Zod e Vitest e a atualização de esbuild foram necessárias
para corrigir avisos sem solução na árvore anterior. O schema de descoberta de
vaults e a configuração de testes foram adaptados; os testes de integração MCP
continuam exercitando as ferramentas. O lockfile foi regenerado com npm 11 após
uma falha do resolvedor npm 10; `npm ci` com npm 10 foi validado. A matriz nativa
aprovada acima inclui as dependências atualizadas.

## Impedimentos atuais

O teste funcional registrado abaixo foi realizado em uma instalação real.
Ainda são necessários testes manuais nos aplicativos Obsidian e Codex em macOS
e Windows; o CI nesses sistemas não substitui essa verificação. Os artefatos
distribuídos foram baixados e verificados com `SHA256SUMS`.

## Commits

A política de título, corpo e trailer está registrada em [AGENTS.md](../AGENTS.md).
A identidade `Codex <noreply@openai.com>` está documentada no
[repositório oficial do Codex](https://github.com/openai/codex/blob/8f5d68f9d25237d0e52ebb8bdd9e7ada01d586c9/docs/config.md#commit-attribution).
O commit inicial segue essa política. Os commits temporários de teste também
seguem o formato e não são publicados.

## Inicialização e envio do código-fonte

A auditoria dos arquivos candidatos é salva em `artifacts/publication-audit.json`.
O snapshot `artifacts/publication-manifest.json` identifica exatamente os arquivos
revisados por seus hashes SHA-256. Ambos ficam fora do versionamento.

O procedimento abaixo já foi executado pelo usuário no terminal autenticado.
Destina-se somente à inicialização de um repositório novo:

```sh
node scripts/setup-github.mjs
```

Essa operação exige `.git` gravável e acesso à API do GitHub. Ela valida a conta
`ernando760`, inicializa `main`, configura `origin`, aplica um e-mail noreply do
GitHub apenas neste repositório e revisa o índice e o único commit antes de enviar.
Não altera a identidade Git global, não faz force-push e não envia tags ou releases.
Se os arquivos tiverem mudado desde a auditoria ou existir histórico diferente,
a operação para antes da publicação. Um envio interrompido pode ser retomado
somente quando o commit inicial continuar idêntico ao snapshot aprovado.

A criação do remoto e o push inicial foram confirmados no GitHub. O procedimento
publicou apenas o código-fonte. As correções posteriores devem usar commits
normais; não execute novamente o inicializador após acrescentar histórico.

## Teste final do Obsidian MCP

Execução validada em 2026-11-09 usando somente a pasta autorizada `MCP/Projetos`:

| Ferramenta | Resultado |
| --- | --- |
| `list_notes` | Aprovado; listou as duas notas disponíveis antes do teste. |
| `create_folder` | Aprovado; criou `MCP/Projetos/testes-finais`. |
| `create_note` | Aprovado; criou `MCP/Projetos/testes-finais/validacao-final.md` com `Validação final das ferramentas Obsidian MCP.` |
| `read_note` | Aprovado; retornou o conteúdo exato criado. |
| `search_notes` | Aprovado; encontrou a nota pelo conteúdo exato. |

Nenhuma anotação existente foi modificada.
