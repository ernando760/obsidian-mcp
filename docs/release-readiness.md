# Preparação da primeira release

**Estado: bloqueada para publicação.** A versão do projeto permanece `0.1.0`.
Nenhuma release ou tag foi publicada durante esta preparação.

## Origem oficial

A origem oficial está configurada em `package.json.repository` e nos instaladores:

```text
https://github.com/ernando760/obsidian-mcp.git
```

A conta `ernando760` foi identificada pela conexão GitHub. A criação do remoto e o
envio inicial ainda não foram confirmados nesta sessão: o terminal não alcança a
API do GitHub e `.git` está somente leitura. A autenticação realizada pelo usuário
fora do sandbox não elimina essas restrições do ambiente.

Com essa definição:

- O build incorpora a origem padrão no CLI independente.
- `release:prepare` incorpora a mesma origem em ambos os instaladores distribuídos
  e calcula os hashes dos arquivos finais, incluindo os scripts preenchidos.
- Argumentos explícitos prevalecem sobre `OBSIDIAN_MCP_REPOSITORY`; a variável
  prevalece sobre a origem anterior registrada e o padrão oficial.
- A preparação e a verificação recusam uma release sem origem oficial válida.

## Evidências e validações

Nesta sessão: **144 testes aprovados e 5 ignorados**, build e verificação de tipos
aprovados. Os cinco ignorados são três testes HTTP impedidos pelo sandbox e dois
exclusivos de Windows. O relatório local está em `artifacts/tests.xml` (ignorado
pelo Git). Nenhum resultado de GitHub Actions foi obtido nesta sessão.

| Área | Evidência disponível | Pendente |
| --- | --- | --- |
| Linux | Execução local de `install.sh` com downloads simulados e CLI real | Execução no runner Ubuntu do repositório oficial |
| macOS | Casos de descoberta de vaults e diretórios; workflow nativo configurado | Execução real no runner macOS |
| Windows | Harness para `install.ps1`, ACLs e launcher `.cmd`; workflow nativo configurado | Execução real no runner Windows |
| Ciclo de vida | Instalação, atualização e desinstalação executadas pelo CLI real em vault temporário | Repetir nos três runners |
| Preservação | Token e bytes de `data.json`, `allowedFolders`, notas e permissões de notas; configuração Codex não relacionada | Confirmar os resultados nativos de ACL no Windows |
| Integridade | Downloads corrompidos recusados; artefatos e origem oficial verificados por `release:prepare` e `release:check` | Confirmar o conteúdo distribuído após a primeira publicação autorizada |
| Aplicativos | API Obsidian e conexão MCP cobertas por testes | Smoke test manual no Obsidian Desktop e no Codex |

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

1. `.git` somente leitura nesta sessão: não foi possível inicializar o repositório
   local, configurar `origin` ou criar o commit inicial neste ambiente.
2. O terminal não consegue conectar à API do GitHub, e o conector não oferece
   criação de repositórios. Criação do remoto, push e CI nativo permanecem pendentes.
3. Smoke test nos aplicativos reais ainda pendente. Os testes de vault e protocolo
   não substituem o carregamento pelo Obsidian/Electron e o uso pelo Codex Desktop.

Não considerar a primeira release aprovada até resolver os itens acima. Não criar
uma tag de release como forma de testar o CI: use o workflow **Test**.

## Commits

A política de título, corpo e trailer está registrada em [AGENTS.md](../AGENTS.md).
A identidade `Codex <noreply@openai.com>` está documentada no
[repositório oficial do Codex](https://github.com/openai/codex/blob/8f5d68f9d25237d0e52ebb8bdd9e7ada01d586c9/docs/config.md#commit-attribution).
Nenhum commit do projeto foi criado nesta sessão, pois `.git` está somente leitura.
Os commits temporários de teste seguem o mesmo formato e não são publicados.

## Inicialização e envio do código-fonte

A auditoria dos arquivos candidatos é salva em `artifacts/publication-audit.json`.
O snapshot `artifacts/publication-manifest.json` identifica exatamente os arquivos
revisados por seus hashes SHA-256. Ambos ficam fora do versionamento.

No terminal normal autenticado, na raiz deste projeto:

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

Depois da criação do remoto e do push, confirme o estado no GitHub e confira a
execução da matriz do CI. Esse procedimento publica apenas o código-fonte.
