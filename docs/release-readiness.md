# Preparação da primeira release

**Estado: bloqueada para publicação.** A versão do projeto permanece `0.1.0`.
Nenhuma release ou tag foi publicada durante esta preparação.

## Origem oficial

A origem oficial está configurada em `package.json.repository` e nos instaladores:

```text
https://github.com/ernando760/obsidian-mcp.git
```

O repositório público e a branch `main` foram confirmados pelo conector GitHub.
O commit inicial é `f9a5f9d1cd63a812540fcf12b669f71889ec0579`, com origem,
atribuição e conteúdo auditados. Nenhuma release foi publicada.

Com essa definição:

- O build incorpora a origem padrão no CLI independente.
- `release:prepare` incorpora a mesma origem em ambos os instaladores distribuídos
  e calcula os hashes dos arquivos finais, incluindo os scripts preenchidos.
- Argumentos explícitos prevalecem sobre `OBSIDIAN_MCP_REPOSITORY`; a variável
  prevalece sobre a origem anterior registrada e o padrão oficial.
- A preparação e a verificação recusam uma release sem origem oficial válida.

## Evidências e validações

Validação local após as correções: **147 testes aprovados e 6 ignorados**,
build, preparação e verificação de artefatos aprovados. Os seis ignorados são
três testes HTTP impedidos pelo sandbox e três exclusivos de Windows.

A [primeira execução nativa do CI](https://github.com/ernando760/obsidian-mcp/actions/runs/42668338428)
aprovou Ubuntu e revelou duas falhas, corrigidas no código:

- macOS: o shell recusava o heredoc JavaScript dentro de uma substituição de
  comando. O heredoc agora fica em uma função, mantendo a entrada do terminal.
- Windows: o lockfile omitia os pacotes nativos opcionais do Rollup. Foram
  restauradas as entradas das plataformas a partir dos metadados do registro,
  sem atualizar versões, e adicionado um teste para impedir essa regressão.

A [segunda execução do CI](https://github.com/ernando760/obsidian-mcp/actions/runs/42670109846),
no commit `7cba805a78dd2376f1406681c28873c167ee717f`, aprovou Linux e macOS:
**148 testes aprovados e 2 exclusivos de Windows ignorados em cada sistema**.
O Windows executou os testes, com 105 aprovados, 36 falhos e 9 ignorados.
As falhas revelaram problemas adicionais corrigidos localmente, ainda sem
validação nativa dessa correção:

- Selecionar somente o primeiro executável Node encontrado no PATH.
- Usar os módulos do próprio runtime PowerShell no bootstrap e não herdar
  `PSModulePath` de PowerShell 7 nos subprocessos Windows PowerShell de ACLs.
- Propagar o código de saída do instalador pelo harness de testes.
- Comparar o caminho real do repositório e do diretório atual, incluindo aliases
  de nomes curtos e diferenças de maiúsculas/minúsculas do Windows.

A [terceira execução do CI](https://github.com/ernando760/obsidian-mcp/actions/runs/42670863779),
no commit `c47baade5f41d3ac112286b582289356adc6fbbc`, aprovou novamente Linux e
macOS. No Windows, 142 testes passaram, 9 foram ignorados e restaram 2 falhas,
ambas na substituição de um CLI existente. As verificações de ACL e os demais
casos do CLI passaram.

O bootstrap foi corrigido para passar `[NullString]::Value` como caminho de backup
para `File.Replace`: o PowerShell convertia `$null` em uma string vazia, que o
.NET rejeitava como caminho inválido. O teste de atualização agora também verifica
a substituição do launcher existente, as permissões e a ausência de arquivos
residuais. Essa alteração ainda depende de nova execução nativa no Windows.
A finalidade de `NullString` está documentada na [API oficial do PowerShell](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring).

| Área | Evidência disponível | Pendente |
| --- | --- | --- |
| Linux | CI aprovado, incluindo HTTP e ciclo de instalação/atualização/desinstalação | Repetir após as últimas correções |
| macOS | CI completo aprovado, incluindo o instalador POSIX | Repetir após as últimas correções |
| Windows | 142 testes aprovados, incluindo ACLs; 2 falhas de substituição corrigidas localmente | CI completo, incluindo ACLs |
| Preservação | Token, bytes de `data.json`, `allowedFolders`, notas e permissões verificados localmente, no Ubuntu e no macOS | Confirmação nativa no Windows |
| Integridade | Downloads corrompidos recusados; hashes, versão e origem oficial verificados | Conferir os artefatos distribuídos na primeira publicação autorizada |
| Aplicativos | API Obsidian e conexão MCP cobertas por testes | Smoke test no Obsidian Desktop e no Codex |

Os testes usam dados sintéticos e downloads simulados. Eles não provam que uma
release já esteja disponível no GitHub. Na desinstalação confirmada, o token da
instalação é removido junto com o plugin; notas e entradas Codex não gerenciadas
são preservadas. O token é preservado em instalações repetidas e atualizações.

No Linux desta sessão, o sandbox proíbe bind em localhost. Os testes por socket
são ignorados localmente, mas o CI define `OBSIDIAN_MCP_REQUIRE_HTTP_TESTS=1` e
falha se não puder executá-los. Testes exclusivos de Windows só executam nesse
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

## Impedimentos atuais

1. Aprovar novamente a matriz do CI após as últimas correções do Windows.
2. Realizar smoke test nos aplicativos reais. Os testes de vault e protocolo não
   substituem o carregamento pelo Obsidian/Electron e o uso pelo Codex Desktop.
3. Analisar o relatório de dependências do primeiro CI: `npm ci` informou 14
   vulnerabilidades (1 baixa, 6 moderadas, 5 altas e 2 críticas). Ainda não foi
   determinada a aplicabilidade ao plugin, CLI ou dependências de desenvolvimento.

Não considerar a primeira release aprovada até resolver os itens acima. Não criar
uma tag de release como forma de testar o CI: use o workflow **Test**.

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
