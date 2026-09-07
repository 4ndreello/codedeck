# Uso agregado do run na statusline

## Goal

O CodeDeck SHALL mostrar na statusline do Claude Code o custo local do orquestrador e o custo e os tokens agregados dos workers do run atual. A configuração SHALL pedir atualização em dois segundos, com degradação para atualização orientada a eventos quando a versão do Claude Code não aceitar essa configuração.

## Current state

1. O SQLite já persiste `usage_input_tokens`, `usage_output_tokens`, `usage_cached_tokens` e `usage_cost` na tabela `sessions` (`src/store/database.ts:28-54`). `SessionRow` declara essas colunas (`src/store/sessions.ts:5-34`) e `rowToSession` as converte para `session.usage.inputTokens`, `outputTokens`, `cachedTokens` e `cost` (`src/store/sessions.ts:70-79`).

2. O CodeDeck não calcula o custo atual. O parser do Claude copia `obj.total_cost_usd` para `usage.cost` (`src/drivers/claude/parser.ts:108-129`). O parser do OMP copia `obj.cost` quando o harness envia um evento de uso (`src/drivers/omp/driver.ts:173-184`). O Codex declara `cost: false` (`src/drivers/codex/driver.ts:87-98`) e seu parser captura input, output e cached tokens, sem custo (`src/drivers/codex/parser.ts:121-133`).

3. O parser do OpenCode não emite `usage.updated`. Depois dos eventos de texto, raciocínio e ferramenta, ele retorna uma lista vazia para as demais linhas (`src/drivers/opencode/parser.ts:36-91`). Isso deixa um gap conhecido para esta feature.

4. Existe um catálogo de modelos para descoberta. `ModelCost` hoje tem apenas `input` e `output` em USD por 1 milhão de tokens (`src/core/models.ts:7-24`). O driver do Claude preenche esses campos a partir de `models.dev` (`src/drivers/claude/driver.ts:84-112`). O driver do Codex monta `ModelInfo` sem preencher `cost` (`src/drivers/codex/driver.ts:117-143`). `codedeck models --json` expõe os `ModelInfo` completos, portanto expõe `cost` quando ele existe (`src/cli/commands/models.ts:148-199`). Esse catálogo continua servindo à descoberta de modelos, mas não será a fonte de preços desta feature: o cálculo de fallback usará uma tabela estática versionada pelo CodeDeck.

5. O daemon não soma atualizações de uso. Em cada `usage.updated`, ele substitui os campos presentes pelo valor do evento mais recente, preservando somente campos ausentes (`src/daemon/daemon.ts:855-878`). Para o Claude isso funciona quando `total_cost_usd` e os tokens são cumulativos, mas não resolve uma sequência de eventos por turno que traga deltas.

6. `codedeck ps --json` serializa as sessões retornadas pelo daemon (`src/cli/commands/ps.ts:378-409`), e `show --json` retorna a sessão e seus eventos (`src/cli/commands/show.ts:8-32`). `logs --json` retorna os eventos normalizados (`src/cli/commands/logs.ts:42-64`). Nenhum desses comandos soma sessões, e o registro atual de comandos não inclui um comando de uso agregado (`src/cli/index.ts:7-18`, `src/cli/index.ts:73-84`).

7. Não existe vínculo durável de run. A interface `Session` tem agente, diretório, repository, worktree e branch, mas não tem `runId`, `parentId` ou tags (`src/core/session.ts:29-64`). O schema SQLite também não tem essa coluna (`src/store/database.ts:28-54`). O daemon preenche os campos de contexto ao criar uma sessão (`src/daemon/daemon.ts:247-304`), mas eles não são uma chave confiável para agrupar duas execuções.

8. O custo local da sessão Claude já aparece na statusline a partir de `payload.cost.total_cost_usd` (`plugin/statusline.sh:117-145`). A configuração inline gerada por `buildSettings` declara apenas `type` e `command` no objeto `statusLine` (`src/open/launchers/claude.ts:58-75`) e é passada por `--settings`, sem gravar `.claude/settings.json` (`src/open/launchers/claude.ts:98-109`). Não há `refreshInterval` configurado.

9. `open` instala um shim `codedeck` no início do `PATH` da sessão Claude (`src/open/runtime.ts:150-164`) e passa `CODEDECK_SESSION_FILE` ao processo filho (`src/open/runtime.ts:500-539`). Esse valor é o caminho de um arquivo. O hook lê o `session_id` nativo do Claude e grava o ID nesse arquivo (`plugin/hooks/session-id.sh:17-21`). O `open` lança Claude diretamente (`src/cli/commands/open.ts:334-371`, `src/cli/commands/open.ts:429-453`) e não chama `session.create`, portanto não cria hoje uma linha CodeDeck para o orquestrador.

10. `findByNativeId` existe apenas no store (`src/store/sessions.ts:239-243`). O protocolo IPC não expõe essa busca nem um método de uso agregado (`src/daemon/protocol.ts:6-18`).

As descobertas estão atualizadas. As duas precisões acima são importantes: `CODEDECK_SESSION_FILE` aponta para o arquivo, e `ps --json` inclui `usage` no objeto em runtime mesmo que o tipo privado `PsSession` não o declare.

## Design decisions

1. `open` SHALL gerar um UUID por execução e injetá-lo como `CODEDECK_RUN_ID` no processo Claude. `codedeck run` SHALL ler `CODEDECK_RUN_ID` do ambiente e persistir a associação na criação da sessão. O implementador pode usar uma coluna `run_id` em `sessions` ou uma tabela auxiliar, desde que a associação use uma chave única por sessão, seja indexada por run e seja resistente a restart do daemon. O `open` não cria uma linha na tabela `sessions` para o orquestrador.

2. A statusline SHALL herdar `CODEDECK_RUN_ID` do ambiente do Claude. O Claude foi lançado pelo `open` com essa variável, portanto a statusline não pode inferir o run por CWD, repository, worktree, branch, nome ou modelo.

3. A fonte de preço do CodeDeck SHALL ser uma tabela estática mantida pelo próprio projeto e versionada no repositório. A tabela terá o formato `model -> { input, output }`, com valores em USD por 1.000.000 de tokens. O cálculo desta feature não consulta a rede nem `models.dev` para obter preços. A localização exata do arquivo da tabela permanece aberta como detalhe de execução.

4. O custo por sessão SHALL seguir esta ordem. Se o harness reportar custo, como Claude ou OMP, o CodeDeck SHALL usar o valor reportado. Caso contrário, SHALL calcular o custo com a tabela estática. Se o modelo não estiver na tabela, o custo SHALL ser `null` e a sessão SHALL entrar em `sessionsWithoutCost`; ela nunca pode virar `$0` por falta de preço. Para cached tokens, a implementação pode escolher o formato de baixo risco, com preço padrão igual ao de input e uma terceira coluna opcional `cached` na tabela. Essa escolha deve ficar explícita na implementação e nos testes. Quando a coluna existir, o cálculo será `(inputTokens * input + outputTokens * output + cachedTokens * cached) / 1.000.000`; sem ela, `cached` usa o preço de `input`.

5. `codedeck usage <run-id> --json` SHALL imprimir somente um objeto JSON com estas oito propriedades:

   ```json
   {
     "runId": "run-example",
     "inputTokens": 1200,
     "outputTokens": 800,
     "cachedTokens": 300,
     "costUsd": 0.42,
     "sessionCount": 2,
     "costComplete": true,
     "sessionsWithoutCost": 0
   }
   ```

   `inputTokens`, `outputTokens`, `cachedTokens` e `costUsd` são os totais das sessões de workers persistidas com aquele `run_id`. `costUsd` é a soma dos custos conhecidos. `sessionCount` conta essas sessões, inclusive as que ainda não têm uso. `costComplete` SHALL ser `false` quando pelo menos uma sessão não tiver custo conhecido, e `sessionsWithoutCost` SHALL ser a contagem dessas sessões. Nesse caso, `costUsd` continua sendo a soma parcial dos custos conhecidos. O custo do orquestrador não entra nesse comando.

## Acceptance criteria

1. O CodeDeck SHALL associar cada worker iniciado por `codedeck run` ao `CODEDECK_RUN_ID` do `codedeck open` de forma durável.

   `open` SHALL gerar o UUID, exportá-lo ao processo Claude, e `codedeck run` SHALL enviar esse valor ao daemon na criação da sessão. O agrupamento SHALL usar somente o `run_id` persistido. CWD, repository, worktree, branch, nome e modelo podem ser exibidos como metadados, mas não podem decidir a associação.

   Teste de aceitação: iniciar duas execuções abertas no mesmo diretório, com os mesmos nomes e branches, verificar UUIDs diferentes no ambiente Claude e criar workers em cada uma. Os workers devem aparecer somente no próprio run após reiniciar o daemon. O `open` não deve criar uma linha de sessão no store.

2. SHALL existir o comando `codedeck usage <run-id> --json` com o contrato definido em `Design decisions`.

   A saída SHALL conter somente `runId`, `inputTokens`, `outputTokens`, `cachedTokens`, `costUsd`, `sessionCount`, `costComplete` e `sessionsWithoutCost`. Os totais SHALL incluir todas as sessões de workers persistidas com o run, inclusive as que ainda estão em andamento. O orquestrador não é contado em `sessionCount`.

   Teste de aceitação: criar duas sessões de worker para `run-example`, com uso conhecido de 1200/800/300 e 100/50/20, e custos de 0.42 e 0.08. Executar `codedeck usage run-example --json`, analisar a saída como JSON e verificar exatamente oito propriedades, `sessionCount` igual a 2, tokens iguais a 1300/850/320, `costUsd` igual a 0.50, `costComplete` igual a `true` e `sessionsWithoutCost` igual a 0.

3. O custo de cada worker SHALL usar a fonte correta.

   1. Se o harness reportar custo, como Claude ou OMP, o agregador SHALL usar o custo persistido reportado pela sessão e não recalculá-lo com outra tabela.
   2. Se o harness não reportar custo, como o Codex, o agregador SHALL calcular o custo a partir dos tokens billáveis e da tabela estática de preços do CodeDeck, dividindo cada produto por 1.000.000 para converter o preço por milhão de tokens. Essa etapa não consulta a rede nem `models.dev`.
   3. Input, output e cached tokens SHALL continuar separados no uso persistido e no contrato JSON. O cálculo SHALL ter preço aplicável para cached tokens. Por padrão, cached usa o mesmo preço de input; a tabela pode declarar uma terceira coluna `cached`. Sem preço aplicável, a sessão SHALL ficar sem custo conhecido.
   4. Um modelo ausente da tabela estática ou sem preço aplicável SHALL entrar em `sessionsWithoutCost`, sem ser convertido em custo conhecido.

   Teste de aceitação: configurar um worker Claude com custo reportado de 0.10 e uma tabela estática que produziria outro valor, e verificar que o agregado usa 0.10. Configurar um worker Codex com input e output iguais a 1.000.000 e preços conhecidos, e verificar a soma exata dos dois preços. Remover o preço do modelo Codex e verificar `costComplete: false`, `sessionsWithoutCost: 1` e `costUsd` igual somente à soma dos custos conhecidos restantes.

4. O agregado do run SHALL ser a soma do uso persistido por sessão, com uma única linha por `session_id` e valor last-wins mantido pelo daemon.

   O agregador SHALL deduplicar por `session_id` e somar os campos persistidos de cada sessão uma única vez. Ele NUNCA SHALL re-somar eventos individuais armazenados. A sequência de eventos deve ser consolidada pelo daemon antes da consulta. Se um harness resetar contadores, o valor persistido refletirá o último evento recebido. Essa é uma limitação conhecida.

   Teste de aceitação: persistir N sessões com uso conhecido, por exemplo, `s1` com input/output/cached/cost iguais a 100/20/5/0.10 e `s2` com 40/10/2/0.03, e verificar que o total é 140/30/7/0.13. Enviar dois eventos para a mesma sessão, com o segundo valor last-wins, e verificar que o resultado usa uma única linha dessa sessão, sem somar os dois eventos nem alterar o total ao reprocessar o primeiro.

5. A statusline SHALL usar fontes disjuntas para o orquestrador e os workers.

   O custo e os tokens do orquestrador SHALL vir somente do payload nativo recebido no stdin da statusline, usando `cost.total_cost_usd` e `context_window`. O custo e os tokens dos workers SHALL vir somente de `codedeck usage <run-id> --json`, usando as sessões do store com aquele `run_id`. O `open` não cria uma linha de sessão, portanto os conjuntos são disjuntos. O total mostrado na statusline SHALL ser custo local do stdin mais custo dos workers retornado pelo CLI. A statusline não pode gravar o orquestrador no store nem fundir o custo local com outra parcela do agregado persistido.

   Teste de aceitação: fornecer ao stdin um custo local de 0.25 e um `context_window` conhecido, e fazer o CLI retornar duas sessões de workers com custo agregado de 0.40. Verificar que o total renderizado é 0.65, que `sessionCount` é 2 e que nenhuma chamada ou linha do store representa o orquestrador. Repetir a chamada com o mesmo payload e verificar que o custo local não é contado duas vezes.

6. `buildSettings` SHALL incluir `statusLine.refreshInterval === 2`.

   O teste deve verificar o valor de configuração retornado por `buildSettings`, sem esperar ou medir tempo de relógio. Se a versão do Claude Code não suportar `refreshInterval`, a statusline SHALL degradar para atualização orientada a eventos sem quebrar a inicialização nem a renderização. A compatibilidade por versão permanece aberta em `Open questions`.

   Teste de aceitação: chamar `buildSettings` com uma configuração válida e fazer uma asserção direta de que `settings.statusLine.refreshInterval === 2`. Em uma fixture que marca a versão do Claude Code como incompatível, iniciar a statusline e verificar saída válida e ausência de erro fatal, com atualização orientada a eventos.

7. A statusline SHALL resolver o run somente pelo ambiente e consultar o estado atual sem heurística.

   Ela SHALL ler `CODEDECK_RUN_ID` herdado do Claude e usar exatamente esse valor em `codedeck usage <run-id> --json`. Cada invocação SHALL consultar o estado corrente do run ou uma atualização equivalente. Um worker criado ou atualizado depois da invocação anterior deve aparecer na próxima invocação, sem reiniciar `open`.

   Se a variável estiver ausente, o run não existir, o CLI falhar, o JSON for inválido ou a consulta exceder o limite operacional, a statusline SHALL continuar exibindo uma linha local válida e sair sem quebrar a sessão Claude. O erro não pode apagar o custo local nem fazer a statusline retornar uma falha fatal.

   Teste de aceitação: configurar `CODEDECK_RUN_ID=run-123`, interceptar o processo filho e verificar a chamada exata com `run-123`, sem consulta por CWD ou branch. Depois alterar o uso mockado de um worker e verificar que a segunda invocação reflete o novo valor. Repetir sem a variável, com CLI indisponível e com JSON inválido, verificando em todos os casos uma linha local válida com o custo local preservado.

## Statusline redesign

O layout alvo do modo agregado é exatamente:

```text
<role> · <projeto>/<branch> · ctx <n>% · <T> tok · run $<total> · <N> agents
```

Quando o agregado não estiver disponível, o layout degradado é:

```text
<role> · <projeto>/<branch> · ctx <n>% · <T local> tok · $<custo local>
```

8. A statusline SHALL remover o rótulo de branding no início da linha, hoje `▌RAGE`, e SHALL remover o campo de modelo. O role SHALL aparecer primeiro e continuar sendo extraído de `session_name` como hoje.

   Teste de aceitação: fornecer um payload nativo com `session_name` que produza o role `builder` e com um modelo explícito. Verificar que a linha começa por `builder ·`, não contém `▌RAGE` e não contém o nome do modelo.

9. A statusline SHALL renderizar os campos na ordem e no formato do layout alvo: role, `projeto/branch`, contexto restante em porcentagem, `<T> tok`, `run $<total>` e `<N> agents`.

   `<T>` SHALL ser `inputTokens + outputTokens + cachedTokens` do agregado retornado pelo CLI. `run $<total>` SHALL ser o custo local do stdin somado ao custo conhecido dos workers retornado pelo CLI. `<N> agents` SHALL ser `sessionCount` do agregado de workers. Os três campos não podem ser calculados por contagem ou custo local.

   A decisão sobre os tokens nativos do orquestrador é deliberadamente conservadora. A documentação do Claude Code informa que, desde a v2.1.132, `context_window.total_input_tokens` e `context_window.total_output_tokens` representam a janela de contexto atual da resposta mais recente, e não totais cumulativos da sessão. Como essa janela pode se repetir ou diminuir após compactação, a statusline SHALL não somá-la ao uso dos workers nem chamá-la de total geral. Assim, no modo agregado, `<T>` é o total confiável dos workers. No modo degradado, quando ambos os campos nativos existirem, `<T local>` será a soma da janela local atual; se necessário, a statusline poderá calcular essa mesma soma a partir de `context_window.current_usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens` e `cache_read_input_tokens`). Sem dados suficientes, o campo `tok` SHALL ser omitido.

   Teste de aceitação: fornecer um payload nativo com role `builder`, projeto `codedeck`, branch `main`, contexto restante de 68%, janela local de 1.000.000 tokens e custo local de 0.25, junto com um agregado mockado de workers com 1.200 input, 800 output, 300 cached, custo 0.40 e `sessionCount` 2. Verificar exatamente `builder · codedeck/main · ctx 68% · 2.3k tok · run $0.65 · 2 agents`, sem somar a janela nativa.

10. A statusline SHALL manter a coloração por faixa já existente para contexto e custo.

   A formatação SHALL continuar suprimindo valores conhecidos abaixo de $0.01, como já faz `plugin/statusline.sh`. Quando `costComplete` for `false`, a soma parcial SHALL mostrar o marcador de custo desconhecido, por exemplo `run $0.42?`, e esse marcador SHALL continuar visível mesmo quando a parcela numérica for suprimida. O estado de custo desconhecido deve ser diferente de `$0.00` e do campo ausente. Um campo nativo ausente SHALL preservar o comportamento de ausência já existente, sem virar custo zero.

   Teste de aceitação: renderizar fixtures nas faixas de contexto e custo já usadas pela statusline e verificar que os mesmos códigos de cor são escolhidos. Renderizar um agregado parcial com custo conhecido de 0.42 e `costComplete: false` e verificar `run $0.42?`. Renderizar um agregado parcial abaixo de 0.01 e verificar que o número é suprimido, mas o marcador permanece. Renderizar um payload sem campo de custo e verificar que ele não produz `$0.00` nem o marcador de custo desconhecido.

11. A statusline SHALL degradar para os dados locais quando não puder obter o agregado.

   Com `CODEDECK_RUN_ID` ausente ou CLI indisponível, a linha SHALL manter role, projeto/branch, contexto, `<T local> tok` quando o snapshot nativo for confiável e custo local, sem inventar `run $<total>` ou `<N> agents`, e sem quebrar. Com o agregado disponível, tokens, custo e contagem SHALL vir do agregado conforme os critérios anteriores.

   Teste de aceitação: fornecer payload local com role `builder`, projeto `codedeck`, branch `main`, contexto restante de 68%, `total_input_tokens` 1.200, `total_output_tokens` 800 e custo local de 0.25, sem `CODEDECK_RUN_ID` ou com falha do CLI. Verificar `builder · codedeck/main · ctx 68% · 2k tok · $0.25` e a ausência de `run` e `agents`. Sem os campos nativos, verificar que `tok` é omitido. Com o agregado mockado, verificar o layout alvo completo.

## Out of scope

1. Corrigir o parser de usage do OpenCode. O gap fica conhecido e documentado para outra feature.
2. Criar statuslines equivalentes para Codex, OpenCode ou OMP.
3. Criar dashboards históricos, telas de análise ou armazenamento de relatórios persistentes além dos registros mínimos necessários para identificar o run e consultar seu estado atual.
4. Trocar a fonte de preços de todos os harnesses. A mudança fica limitada ao que for necessário para calcular o custo dos harnesses que hoje não o reportam.

## Open questions

1. Qual é a versão mínima do Claude Code que aceita `refreshInterval`? Se a versão suportada não aceitar o campo, a compatibilidade deve manter a statusline orientada a eventos sem quebrar a sessão.

2. Em qual arquivo do repositório a tabela estática de preços será mantida? A decisão de usar uma tabela versionada, seu formato e sua regra de fallback já está fechada; falta apenas esse detalhe de execução.
