# CodeDeck Orchestrate Specification

> **Estado: bloqueada.** O desenho abaixo é a intenção acordada, e as dependências da seção "Blocking Dependencies" precisam ser decididas antes de escrever `tasks.md`. Não implementar direto desta versão.
>
> Depende de `.specs/features/codedeck-open/spec.md` (papel `orchestrator`, restrição por ferramenta, disciplina de despacho dentro de uma sessão) e de `.specs/features/daemon-power/spec.md` (identidade de PID, `interrupted`, drenagem no shutdown).

## Problem Statement

O `codedeck open` entrega um orquestrador que delega, confere artefato e não arredonda pra sucesso. Mas tudo isso vive no contexto de uma conversa: fechar o terminal, perder a sessão ou desligar a máquina apaga o plano. Numa run de dez tarefas, o dono do trabalho é a janela do terminal, o que é frágil demais pro trabalho que ela conduz.

O que falta é durabilidade: um plano que sobrevive ao processo que o escreveu, e uma retomada que devolve a run de onde parou sem despachar nada sem consentimento.

## Goals

- [ ] O plano de uma run sobrevive à morte do orquestrador, do daemon e da máquina
- [ ] No boot seguinte o estado é legível e uma confirmação explícita retoma o que não foi provado
- [ ] Retomar nunca coloca um segundo escritor na mesma árvore
- [ ] Um worker do CodeDeck sobe com o mesmo setup que o `open` entrega (skills, prompt, papel)

## Out of Scope

| Feature | Reason |
| ------- | ------ |
| Auto-re-dispatch sem confirmação | Invariante já escrito em `daemon-power`: resume é sempre explícito. Reboot acidental às 3h acordaria workers escrevendo arquivo sem consentimento e gastando token |
| Motor de loop (DAG, fan-out declarativo, orçamento) | O orquestrador aqui é plano + convenção; estados de motor (`exhausted`, `stalled`, `canceled`) seriam vocabulário que nada produz |
| Reatachar processo de worker **morto** | Vira tarefa re-despachada do zero: reatar conversa de processo morto exige protocolo que o driver não tem. Isso **não** revoga o reatamento de sessão viva que o daemon já faz depois de reiniciar (`src/daemon/daemon.ts:207`), que continua valendo |
| Tabela de tarefas no SQLite do daemon | O daemon descreve processo, não tarefa. A questão de **onde** o plano mora continua aberta (ver BD-3), mas misturar os eixos dentro do schema de sessão está descartado |
| Agente consultor (modo autonomia máxima) | Parado a pedido, entra depois. A ideia: o orquestrador escala dúvida pra um consultor de contexto limpo em vez de pro humano, e só pergunta ao humano em última instância. O corte que faz isso funcionar é **pergunta descobrível vai pro consultor, pergunta de preferência vai pro humano**, e o consultor só vale os tokens se não herdar o contexto do orquestrador, senão vira eco. Depende de saber se agente de plugin é dispachável como subagente por outro agente de plugin, o que **não foi sondado** |

---

## Blocking Dependencies

Cada linha é um bloqueio real encontrado em revisão da spec anterior, verificado contra o código. Nenhuma tem decisão tomada.

| ID | Bloqueio | Evidência | Por que trava |
| -- | -------- | --------- | ------------- |
| BD-1 | O orquestrador não pode escrever o plano | O agente declara `tools` sem `Edit` e sem `Write` (`codedeck-open`, OPEN-09), e a regra de fronteira diz que ele nunca escreve arquivo | Sobra shell cru via `Bash`, que é exatamente o que a regra proíbe. Ou existe superfície tipada (`codedeck plan set <task> <status>`), ou o papel ganha escrita restrita a um caminho, ou o plano não é arquivo |
| BD-2 | Tarefa sem artefato nunca termina | A regra de retomada é "sem artefato provado = re-despacha". Uma tarefa de investigação, ou uma marcada `no-op`, tem diff permanentemente vazio | Ela seria re-despachada a cada boot, pra sempre. Estado terminal precisa de marca própria, não derivada de artefato |
| BD-3 | Não existe caminho de boot | `client.ensureDaemonStarted()` (`src/daemon/ipc.ts:190`) só é chamado por comando de CLI: `run`, `wait`, `ps`, `diff`, `logs`, `send`, `stop`, `show`, `doctor`. O repo **usa** systemd (`systemd-inhibit` em `src/daemon/daemon.ts:888`) e já **espera** uma unit de usuário `~/.config/systemd/user/codedeck.service`, checada por `powerServiceInstalled()` (`src/daemon/daemon.ts:29`) e pelo `doctor` (`src/cli/commands/doctor.ts:15`). O que não existe é quem **crie** essa unit | O gatilho de boot está a uma unit de distância, não a uma arquitetura. Mas mesmo com ela, `daemon-power` colocou auto-retomada no boot em Out of Scope. Ver open question 1 |
| BD-4 | Re-despacho pode criar um segundo escritor | O código já tem `processAlive` (`src/utils/process.ts:41`) e `pidStartTime` (`src/core/session.ts:46`, usado em `session-driver.ts:148` pra recusar `stop` sem identidade de PID) | A spec anterior descrevia re-despacho sem consultar nenhum dos dois. Worker vivo numa worktree suja + worker novo na mesma tarefa = corrupção |
| BD-5 | Onde o plano mora | Estado do CodeDeck vive em `~/.run-agent` (`src/config/paths.ts`), e worktrees em `~/.run-agent/worktrees`. `git worktree add` só materializa arquivo **rastreado** | Plano em `.codedeck/` gitignorado dentro do repo nunca aparece na worktree do worker: ele não consegue ler o próprio arquivo de tarefa. Plano commitado polui o repo do usuário |
| BD-6 | Worker sobe sem o setup do CodeDeck | `buildClaudeArgs` (`src/drivers/claude/driver.ts:12`) monta `-p`, `--dangerously-skip-permissions` incondicional, `--model`, `--effort`, `--resume`, prompt. Nada de `--plugin-dir`, `--agent` ou `--append-system-prompt-file` | "Delegar pra sessão CodeDeck" hoje entrega um claude cru. Cada driver tem seu próprio builder (`buildCodexArgs` em `codex/driver.ts:15`, `buildOmpArgs` em `omp/driver.ts:255`), então mudar o do claude não afeta os outros. O que é compartilhado é `StartOptions`, que hoje não tem campo pra plugin, papel, system prompt nem bypass de claude |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Eixo de propriedade | Daemon é dono de processo, orquestrador é dono de tarefa | Separação já presente no vocabulário do projeto; misturar obriga o daemon a entender semântica de tarefa | y |
| Formato do plano | Markdown com frontmatter, um arquivo por tarefa | Legível por humano sem ferramenta, sobrevive a banco corrompido, versionável se o usuário quiser | y |
| Local do plano | **Sem decisão** | Ver BD-5. Candidatos: `~/.run-agent/runs/<run-id>/` (fora do repo, invisível ao worker por padrão), `.codedeck/` commitado, ou passado ao worker via prompt em vez de arquivo | n |
| Escrita do plano | **Sem decisão** | Ver BD-1. Candidatos: `codedeck plan` tipado, `Write` restrito por caminho no frontmatter do agente, ou plano gravado pelo daemon a partir de comando do orquestrador | n |
| Vocabulário de tarefa | `todo, doing, done, no-op, blocked, failed` | `no-op` é onde cai o worker que terminou com diff vazio; sem ele "nunca arredonde pra sucesso" não tem destino. `blocked` ≠ `failed` na retomada: `failed` re-despacha, `blocked` espera humano | n |
| Quais estados são terminais | **Sem decisão** | Sem isso a spec se contradiz: ORCH-08 re-despacha o não terminal e ORCH-11 manda deixar `blocked` parado, então `blocked` precisa ser terminal pra retomada e não terminal pro fluxo (alguém ainda vai desbloquear). Falta tabela de transição e um predicado `isTerminalTask`, sem os quais um teste que só confere a existência das seis strings passa com transição errada | n |
| Quem produz `todo` e `blocked` | **Sem decisão** | Na versão anterior nada produzia esses dois estados: eram vocabulário morto. Ou o fluxo que os cria fica explícito, ou eles saem | n |
| Identidade de tarefa ↔ sessão | Tarefa guarda o id da sessão CodeDeck que a executou | Sem isso não dá pra consultar `processAlive`/`pidStartTime` na retomada nem atribuir diff. Estava faltando na versão anterior | n |
| Isolamento no despacho | `codedeck run --worktree` sempre | `worktree` é `false` por default (`src/config/config.ts:14`) e `getDiff` cai em `options.worktree \|\| options.cwd` (`src/git/diff.ts:19`): sem worktree os diffs de dois workers se misturam | y |
| Gatilho de retomada | **Sem decisão** | Ver BD-3 e open question 1 | n |
| Conteúdo do hook `SessionStart` | Só fato, nenhuma instrução | Evidência: um claude aninhado leu bloco imperativo injetado por hook e respondeu que aquilo tinha cara de prompt injection e ia ignorar. Instrução em hook o modelo descarta; fato ele consome | y |
| Custo do hook | Precisa de orçamento medido | Hook de `SessionStart` é global à máquina e bloqueia o start. Estimativa de revisão: até ~6s no pior caso, não medido nesta base | n |

**Open questions:**

1. **Qual é o gatilho de retomada?** Três caminhos: (a) unidade systemd/launchd que sobe o daemon no boot, o que contradiz `daemon-power` a menos que o daemon apenas leia e nunca despache; (b) o próximo `codedeck open` mostra o pendente, sem nada rodando no boot; (c) comando explícito `codedeck resume <run-id>`. A opção (b) é a única que não exige infraestrutura nova nem mexe no invariante já escrito.
2. **O plano é arquivo ou linha de banco?** BD-1 e BD-5 se resolvem juntos ou não se resolvem. Se o daemon grava, o orquestrador não precisa de `Write` e o worker não precisa enxergar o arquivo.
3. **Provisionar o worker entra nesta feature ou em uma própria?** BD-6 mexe em `buildClaudeArgs`, que serve claude, codex, opencode e omp. Pode ser feature separada de "worker herda o setup do open".
4. **`no-op` é terminal por marca ou por artefato?** BD-2 depende disso.
5. **Qual é a tabela de transição de tarefa, e o que desbloqueia uma `blocked`?** Precisa sair como predicado testável (`isTerminalTask`) e não como prosa, senão ORCH-08 e ORCH-11 continuam se contradizendo.
6. **Quem é o dono do portão de confirmação?** Hoje `session.create` persiste e já dispara o driver (`src/daemon/daemon.ts:283-325`), sem estado de admissão tipo `awaiting_confirmation` e sem método IPC de confirmar run. Um hook só de fatos não impede o orquestrador de chamar `codedeck run` antes do consentimento: ORCH-07 só é real se o daemon segurar o despacho.

---

## User Stories

> As stories abaixo estão escritas na intenção acordada. Os ACs marcados com `⛔ BD-n` dependem da decisão correspondente e podem mudar de forma.

### P1: Plano durável de uma run

**User Story**: As a dev conduzindo uma run de dez tarefas, I want o plano em disco em vez de só no contexto so that fechar o terminal não apague o trabalho combinado.

**Why P1**: É a fundação. Retomada, contabilidade e relatório dependem de existir um plano legível fora do processo.

**Acceptance Criteria**:

1. WHEN o orquestrador cria uma run THEN o CodeDeck SHALL persistir um registro por tarefa contendo id, descrição, status e id da sessão executora <!-- event-driven --> ⛔ BD-1, BD-5 `ORCH-01`
2. The status de tarefa SHALL pertencer a um conjunto fechado, e cada valor SHALL ter um produtor identificado <!-- ubiquitous --> ⛔ BD-2 `ORCH-02`
3. WHEN uma tarefa muda de status THEN o CodeDeck SHALL gravar a mudança sem exigir que o orquestrador use `Write` ou `Edit` <!-- event-driven --> ⛔ BD-1 `ORCH-03`
4. The plano SHALL ser legível por humano sem ferramenta do CodeDeck <!-- ubiquitous --> `ORCH-04`
5. WHEN o worker precisa do enunciado da tarefa THEN o CodeDeck SHALL entregá-lo por um caminho que funcione dentro da worktree do worker <!-- event-driven --> ⛔ BD-5 `ORCH-05`

**Independent Test**: Criar uma run de duas tarefas, matar o orquestrador com `SIGKILL`, e ler o plano do disco com `cat`: as duas tarefas aparecem com status e id de sessão.

---

### P1: Retomada com confirmação e sem escritor duplicado

**User Story**: As a laptop user que desligou a máquina no meio de uma run, I want ver o que ficou pendente e retomar com uma confirmação so that nada gaste token sozinho mas eu também não perca o trabalho.

**Why P1**: É a promessa que fecha o produto. Sem ela o plano durável é só um log.

**Acceptance Criteria**:

1. WHEN uma sessão do `open` inicia THEN o hook `SessionStart` SHALL injetar apenas fatos: sessões ativas, tarefas não terminais e branch/worktree atual <!-- event-driven --> `ORCH-06`
2. The hook SHALL não conter instrução imperativa <!-- ubiquitous --> `ORCH-06`
3. IF existem tarefas não terminais de uma run anterior THEN o CodeDeck SHALL apresentá-las e aguardar confirmação explícita antes de despachar qualquer worker <!-- unwanted-behavior --> `ORCH-07`
4. WHEN a confirmação é dada THEN o orquestrador SHALL re-despachar apenas tarefas cujo artefato não prova conclusão E que não estejam marcadas como terminais <!-- event-driven --> ⛔ BD-2 `ORCH-08`
5. BEFORE re-despachar uma tarefa THEN o CodeDeck SHALL consultar `processAlive` e `pidStartTime` da sessão registrada e SHALL recusar o despacho enquanto o worker anterior estiver vivo <!-- event-driven --> ⛔ BD-4 `ORCH-09`
6. IF o processo do worker ainda está vivo THEN o CodeDeck SHALL preservar o reatamento que o daemon já faz (`src/daemon/daemon.ts:207`, `SessionRuntime.reattach` em `src/drivers/session-runtime.ts:180`), sem re-despachar <!-- unwanted-behavior --> `ORCH-10`
7. IF o processo do worker está morto THEN o orquestrador SHALL re-despachar a tarefa do zero em vez de tentar reatar, porque o driver não tem protocolo pra retomar conversa de worker morto <!-- unwanted-behavior --> `ORCH-10`
8. WHEN uma tarefa é re-despachada THEN o CodeDeck SHALL reportar ao humano se a worktree anterior ficou suja <!-- event-driven --> `ORCH-17`
9. IF uma tarefa está bloqueada por decisão humana THEN o CodeDeck SHALL deixá-la parada e reportar, e a retomada SHALL não contá-la como candidata <!-- unwanted-behavior --> ⛔ BD-2 `ORCH-11`
10. The gatilho de retomada SHALL ser explícito, nunca automático no boot <!-- ubiquitous --> ⛔ BD-3 `ORCH-12`

**Independent Test**: Criar uma run com uma tarefa em execução, `poweroff` na máquina, ligar de novo e abrir: a tarefa pendente aparece, nenhum worker sobe até a confirmação, e com o worker anterior forçado a "vivo" o re-despacho é recusado.

---

### P2: Worker herda o setup do CodeDeck

**User Story**: As a orquestrador despachando trabalho, I want que o worker suba com as mesmas skills e o mesmo prompt que o `open` entrega so that eu não precise reescrever o contexto do CodeDeck em cada prompt.

**Why P2**: Hoje dá pra contornar escrevendo prompt autossuficiente (é o que `codedeck-open` OPEN-13 exige). Melhora fidelidade, não desbloqueia nada.

**Acceptance Criteria**:

1. WHEN o daemon sobe um worker claude THEN o CodeDeck SHALL passar `--plugin-dir` apontando pro plugin empacotado <!-- event-driven --> ⛔ BD-6 `ORCH-13`
2. WHEN a tarefa declara um papel THEN o CodeDeck SHALL passar o `--agent` correspondente <!-- event-driven --> ⛔ BD-6 `ORCH-14`
3. The bypass de permissão do worker SHALL ser configurável em vez de incondicional <!-- ubiquitous --> ⛔ BD-6 `ORCH-15`
4. The mudança SHALL não quebrar os drivers `codex`, `opencode` e `omp` <!-- ubiquitous --> `ORCH-16`

**Independent Test**: Despachar um worker e pedir a ele que invoque uma skill do CodeDeck; a skill responde. Rodar a suíte escopada dos quatro drivers e ver verde.

---

## Edge Cases

- IF o plano existe mas a sessão registrada sumiu do banco THEN o CodeDeck SHALL tratar a tarefa como não provada e reportar a inconsistência, nunca assumir sucesso
- IF duas runs referenciam a mesma worktree THEN o CodeDeck SHALL recusar a segunda
- IF o hook de `SessionStart` demorar acima do orçamento THEN o CodeDeck SHALL degradar pra contexto vazio em vez de segurar o start da sessão
- IF o usuário apagar o plano à mão no meio de uma run THEN os workers vivos SHALL continuar e aparecer em `codedeck ps`, porque o dono do processo é o daemon e não o plano
- IF um worker terminar enquanto o orquestrador está morto THEN o resultado SHALL continuar recuperável por `codedeck diff` na próxima abertura

---

## Requirement Traceability

| Requirement ID | Requisito | Story | Bloqueio | Status |
| -------------- | --------- | ----- | -------- | ------ |
| ORCH-01 | Persistência do registro de tarefa | P1 Plano | BD-1, BD-5 | Blocked |
| ORCH-02 | Conjunto fechado de status com produtor | P1 Plano | BD-2 | Blocked |
| ORCH-03 | Gravação sem `Write` no orquestrador | P1 Plano | BD-1 | Blocked |
| ORCH-04 | Plano legível sem ferramenta | P1 Plano | - | Pending |
| ORCH-05 | Enunciado alcançável de dentro da worktree | P1 Plano | BD-5 | Blocked |
| ORCH-06 | Hook de fatos, sem instrução | P1 Retomada | - | Pending |
| ORCH-07 | Confirmação antes de despachar | P1 Retomada | - | Pending |
| ORCH-08 | Re-despacho só do não provado | P1 Retomada | BD-2 | Blocked |
| ORCH-09 | Guarda de escritor duplicado | P1 Retomada | BD-4 | Blocked |
| ORCH-10 | Reatar worker vivo, re-despachar worker morto | P1 Retomada | - | Pending |
| ORCH-17 | Relato de worktree suja no re-despacho | P1 Retomada | - | Pending |
| ORCH-11 | Tarefa bloqueada espera humano | P1 Retomada | BD-2 | Blocked |
| ORCH-12 | Gatilho explícito de retomada | P1 Retomada | BD-3 | Blocked |
| ORCH-13 | Plugin no worker | P2 Setup | BD-6 | Blocked |
| ORCH-14 | Papel no worker | P2 Setup | BD-6 | Blocked |
| ORCH-15 | Bypass configurável no worker | P2 Setup | BD-6 | Blocked |
| ORCH-16 | Drivers não claude intactos | P2 Setup | - | Pending |

**Status values:** Blocked → Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 17 requisitos, 11 bloqueados por uma das 6 dependências acima. `tasks.md` não deve ser escrito enquanto BD-1 a BD-6 e as 6 open questions não tiverem decisão.

**Aviso:** os Success Criteria abaixo descrevem o estado desejado, não coisa verificável hoje. Nenhum plano, run, tarefa ou comando de retomada existe no código: o único vocabulário de status que roda é o de sessão do daemon (`starting, working, needs_input, idle, completed, failed, stopped, orphaned, interrupted`).

---

## Success Criteria

- [ ] `poweroff` no meio de uma run de cinco tarefas, e no boot seguinte a run é listada com o estado de cada tarefa
- [ ] Nenhum worker sobe sem confirmação explícita
- [ ] Com o worker anterior ainda vivo, o re-despacho da mesma tarefa é recusado
- [ ] Uma tarefa que legitimamente não produz artefato termina e não volta na retomada seguinte
- [ ] Cada valor do vocabulário de status tem pelo menos um produtor no código
- [ ] Testes escopados verdes nos quatro drivers
