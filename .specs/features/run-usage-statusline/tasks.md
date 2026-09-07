# Plano de tasks

T1 e T2 não dependem uma da outra e podem ser executadas em paralelo. T3 depende de T1 e T2. T4 depende de T3.

## T1. Vincular sessões ao run

Dependência: nenhuma.

Files:

- `src/store/database.ts`
- `src/store/sessions.ts`
- `src/core/session.ts`
- `src/daemon/protocol.ts`
- `src/daemon/daemon.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/open.ts`
- `src/open/runtime.ts`

Interface e entregável:

- Adicionar `run_id` à tabela `sessions`, com índice, tanto no `CREATE TABLE` quanto na migração de bancos existentes.
- Expor `runId` em `Session`, nas opções de criação e no contrato IPC usado por `session.create`. O store deve converter a coluna, gravá-la no INSERT e oferecer uma consulta exata, como `listByRunId(runId)`.
- Fazer `open` gerar um UUID por execução e passá-lo como `CODEDECK_RUN_ID` ao processo Claude. O `open` não deve criar uma sessão do orquestrador no store.
- Fazer `codedeck run` ler `process.env.CODEDECK_RUN_ID`, enviá-lo na criação da sessão e fazer o daemon persistir o valor recebido.
- Manter a associação apenas no `run_id` persistido, inclusive depois de reiniciar o daemon. CWD, repository, worktree, branch, nome e modelo não podem substituir essa chave.

Testes:

- `tests/session-store.test.ts`: criação e leitura de sessão com `runId`, migração de banco legado com a nova coluna e `listByRunId` retornando somente as sessões do run pedido.
- `tests/run-linkage.test.ts`: duas execuções abertas recebem UUIDs diferentes, o ambiente do Claude recebe `CODEDECK_RUN_ID`, e `codedeck run` repassa o valor e persiste a associação.
- `tests/run-role.test.ts`: o request `session.create` inclui o `runId` herdado do ambiente.

Gate:

- O schema novo e a migração de um banco existente passam sem perder linhas antigas.
- Uma sessão criada com `run_id = run-a` aparece em `listByRunId("run-a")` e nunca em `listByRunId("run-b")`.
- Dois `open` simultâneos geram UUIDs distintos, o worker recebe exatamente o UUID do seu processo Claude e nenhuma linha é criada para o orquestrador.
- Após reconstruir o daemon a consulta ainda separa corretamente os workers por run.

## T2. Tabela de preços e cálculo de custo

Dependência: nenhuma. Pode ser executada em paralelo com T1.

Files:

- `src/core/pricing.ts`

Interface e entregável:

- Criar uma tabela estática e versionada de `model -> { input, output }`, em USD por 1.000.000 de tokens. O local exato do arquivo da tabela continua sendo uma escolha de implementação registrada na spec.
- Expor uma função pura que receba o custo reportado, o modelo e o uso da sessão, e retorne o custo da sessão ou `null`.
- Fazer custo reportado vencer qualquer cálculo pela tabela, inclusive quando o valor reportado for zero.
- Quando não houver custo reportado, calcular com a tabela. Modelo ausente ou sem preço aplicável retorna `null`, nunca custo zero.
- Tratar cached tokens com a decisão de baixo risco definida na spec: usar por padrão o preço de input e aceitar uma coluna opcional `cached` com preço próprio.
- Manter o módulo sem consulta de rede e sem dependência de `models.dev`.

Testes:

- `tests/pricing.test.ts`: modelo conhecido com soma exata de input, output e cached; modelo desconhecido retornando `null`; custo reportado passando direto; preço padrão de cached igual ao de input; coluna `cached` opcional alterando apenas o componente cached.

Gate:

- A função é determinística e pura, sem chamada de rede ou leitura de catálogo dinâmico.
- Os casos de modelo conhecido, desconhecido, custo reportado e cached passam com valores numéricos exatos.
- Nenhuma sessão sem preço aplicável pode ser convertida em `$0`.

## T3. Comando `codedeck usage <run-id> --json`

Dependência: T1 e T2 concluídas.

Files:

- `src/daemon/protocol.ts`
- `src/daemon/daemon.ts`
- `src/cli/commands/usage.ts`
- `src/cli/index.ts`

Interface e entregável:

- Adicionar uma rota IPC de consulta por run, por exemplo `usage.get`, que receba `{ runId }` e devolva o resumo agregado.
- Consultar as sessões persistidas por `run_id`, contando cada `session_id` uma vez. Somar `inputTokens`, `outputTokens` e `cachedTokens` da linha persistida, sem reprocessar eventos individuais.
- Calcular o custo de cada sessão usando T2. Custo reportado tem precedência; quando faltar custo, a tabela pode calcular; quando não houver preço, a sessão entra em `sessionsWithoutCost`.
- Devolver exatamente `{ runId, inputTokens, outputTokens, cachedTokens, costUsd, sessionCount, costComplete, sessionsWithoutCost }`. `sessionCount` inclui sessões sem uso, `costUsd` soma somente custos conhecidos e `costComplete` é falso quando qualquer sessão não tem custo.
- Registrar o comando em `src/cli/index.ts`. `codedeck usage <run-id> --json` deve imprimir somente o objeto JSON do contrato.

Testes:

- `tests/usage.test.ts`: fixture com várias sessões do mesmo run, rota IPC consultada por `runId`, separação entre dois runs, soma de tokens e custo, contagem de sessões sem uso, precedência de custo reportado, `costComplete = false`, `sessionsWithoutCost` correto, valor last-wins persistido por sessão, ausência de dupla contagem ao reprocessar eventos e contrato com exatamente oito propriedades.

Gate:

- A consulta por um run não retorna sessões de outro run e continua correta depois de reiniciar o daemon.
- O fixture de duas sessões produz os totais esperados e o JSON não contém propriedades extras.
- Uma sessão sem custo produz `costComplete: false`, incrementa `sessionsWithoutCost` e deixa `costUsd` apenas com a soma conhecida.
- O comando não mistura texto humano com a saída `--json`.

## T4. Redesign da statusline e refresh

Dependência: T3 concluída.

Files:

- `src/open/launchers/claude.ts`
- `plugin/statusline.sh`

Interface e entregável:

- Fazer `buildSettings` incluir `statusLine.refreshInterval: 2`, preservando a inicialização quando uma versão do Claude Code não aceitar esse campo.
- Remover `▌RAGE` e o campo de modelo do `plugin/statusline.sh`. Renderizar o layout alvo na ordem `<role> · <projeto>/<branch> · ctx <n>% · run $<total> · <N> agents`.
- Ler `CODEDECK_RUN_ID` e chamar exatamente `codedeck usage "$CODEDECK_RUN_ID" --json`. Somar o custo local do payload com `costUsd` do agregado e usar `sessionCount` como o número de agents.
- Se a variável estiver ausente, o CLI falhar, o JSON for inválido ou a consulta não responder, manter uma linha local válida com role, projeto/branch, contexto e custo local, sem inventar `run` ou `agents`.
- Manter as cores por faixa já existentes. Para `costComplete: false`, mostrar um marcador próprio, como `?`, inclusive quando o número estiver abaixo do limiar de exibição. Custo nativo ausente continua ausente, sem virar `$0.00`.

Testes:

- `tests/statusline.test.ts`: payload local mais agregado mockado produz o layout alvo, ausência de branding e modelo, custo total correto, `sessionCount` correto, cores por faixa, marcador `?` e degradação sem agregado ou com falha do CLI.
- `tests/open-args.test.ts`: `buildSettings` e os argumentos inline expõem `settings.statusLine.refreshInterval === 2`.

Gate:

- Os testes focados de statusline e `buildSettings` passam para o payload com agregado e para todos os caminhos de degradação.
- O layout completo bate exatamente com `builder · codedeck/main · ctx 68% · run $0.65 · 2 agents` no fixture correspondente.
- Editar `plugin/` não altera o `codedeck` que já está rodando. É obrigatório executar `npm run build:plugin` para copiar o plugin para `dist/plugin` antes de aceitar a task; o artefato gerado deve conter a mesma statusline testada.
