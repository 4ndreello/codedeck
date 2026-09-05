# CodeDeck Open Specification

> Escopo: o launcher e os papéis. A durabilidade de plano, a contabilidade de despacho e a retomada pós-reboot vivem em `.specs/features/codedeck-orchestrate/spec.md`, que depende desta.

## Problem Statement

Abrir o Claude Code pronto pra trabalho hoje é ritual manual: escolher modelo, lembrar da grafia de `--effort`, ligar bypass, torcer pra que as skills certas estejam instaladas globalmente na máquina. Cada pessoa monta um alias diferente, ninguém compartilha as mesmas skills, e não existe papel: a mesma sessão que deveria conduzir trabalho paralelo é a que sai editando arquivo sozinha.

`codedeck open` é a porta de entrada: um comando que sobe uma sessão opinionada, com as skills e agentes de vocês carregados só naquela sessão, com papel escolhido no launch e imposto por ferramenta.

## Goals

- [ ] `codedeck open` sobe uma sessão Claude Code com skills, agentes e tema do CodeDeck sem instalar nada na config global do usuário
- [ ] O papel da sessão é escolhido no launch (`general`, `orchestrator`, `reviewer`). No `reviewer` a restrição é imposta por ferramenta e verificada; no `orchestrator` ela é parcial, porque ele mantém `Bash` e com `Bash` ainda dá pra escrever por redirecionamento
- [ ] O orquestrador delega trabalho de escrita pra sessões CodeDeck e aceita artefato como prova, dentro de uma sessão só
- [ ] Zero dependência de Python, zero instalação global, zero passo com root

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
| ------- | ------ |
| Plano durável, retomada pós-reboot, contabilidade de tarefa | Movido pra `codedeck-orchestrate`. Exige superfície nova de daemon (gravação tipada de plano, identidade de sessão por tarefa, gatilho de boot) que hoje não existe; deixar aqui bloqueava o launcher, cujo desenho já está fechado |
| Provisionar o worker com o setup do CodeDeck | `buildClaudeArgs` (`src/drivers/claude/driver.ts:12`) hoje monta `-p`, bypass fixo, model, effort, resume, e mais nada: worker não recebe `--plugin-dir`, `--agent` nem system prompt. Exige campo novo em `StartOptions`, que é contrato compartilhado pelos quatro drivers. Vai pra `codedeck-orchestrate` |
| Skill de spec-driven própria | Corpo de método que exige semanas de iteração com uso real; amarrar o `open` a ela impede os dois de sair. Entra em versão seguinte, e o `open` é o ambiente pra escrevê-la |
| Empacotar `tlc-spec-driven` de terceiro | CC-BY-4.0 exige atribuição e os 5 validadores são Python; um CLI Node que só funciona com Python instalado é passivo de suporte permanente |
| Papéis `implementer` e `fixer` no seletor | São alvos de spawn do orquestrador, não escolhas de humano; podem existir depois como agentes despacháveis sem aparecer no picker |
| Animação no banner | Medido: versão animada custa 0.403s de atraso puro e lê como terminal travando; escrita atômica custa 0.003s. Efeito fica pra depois, com técnica que não seja `sleep` por linha |
| Forçar fast mode no launch | Não existe flag, mas **existe a chave** `fastMode` no schema de settings, e o `open` já passa `--settings`, então seria um campo JSON. Fica fora porque o efeito é gated por entitlement de org e não foi possível confirmar que liga; entra depois com verificação real, não pela ausência de mecanismo |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear. Toda linha marcada com evidência foi verificada por comando contra `claude 2.1.258` nesta máquina, não lida em documentação, e reverificada por um segundo agente em plugin construído do zero.

**`Confirmed?` significa decisão fechada e mecanismo comprovado por sonda, não código entregue.** Nada nesta spec está implementado: `codedeck open` não existe no CLI e `plugin/` não existe no repo. O que foi provado é que os mecanismos que a spec usa funcionam na versão do `claude` fixada acima.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Mecanismo de carga das skills | `--plugin-dir <dir>` por sessão | Evidência: skill de plugin efêmero foi invocada de verdade pela ferramenta Skill (o stream-json mostra `"name":"Skill"`) e devolveu o token do corpo, disparada pela descrição e não à força. Não instala nada global e versiona junto do pacote | y |
| Grafia do system prompt | `--append-system-prompt-file <arquivo>` | Sem entrada própria no `--help`, só citada de passagem dentro do texto de `--bare`. Verificada por erro do commander (`argument missing`, não `unknown option`) e por obediência real à instrução do arquivo | y |
| System prompt sobrevive ao papel | `--append-system-prompt-file` + `--agent` se somam | Evidência: com os dois passados juntos, a instrução do arquivo foi obedecida junto da identidade do agente. Sem isso as regras invioláveis sumiriam justamente no `orchestrator` | y |
| Referência de agente | Namespaced: `<plugin>:<agente>` | O nome nu **também resolve** (prompt e restrição de ferramenta inclusos). Namespace é por segurança de colisão: com dois `--plugin-dir` expondo o mesmo nome, o nu liga no primeiro **sem aviso nem erro de ambiguidade**. Nome inexistente falha alto listando os disponíveis, e a lista só mostra a forma namespaced. O `open` esconde o namespace: usuário digita `orchestrator` | y |
| Referência de tema | `custom:<plugin>:<slug>`, com `<slug>` = **basename do arquivo** | As três grafias óbvias (`<slug>`, `custom:<slug>`, `<plugin>:<slug>`) falharam **em silêncio**, sem erro e sem log nem com `--debug`; só a quarta aplicou. E o slug é o nome do arquivo, não o campo `name` do JSON: `zzz-alpha.json` com `"name": "Bravo Theme"` responde a `custom:<plugin>:zzz-alpha` e ignora `custom:<plugin>:bravo-theme` | y |
| Declaração de tema no manifesto | `experimental.themes` | `claude plugin validate` avisa que a forma top-level `themes` "will be removed in a future release" | y |
| `plugin validate` **não** cobre tema | Gate de tema é captura real de launch | Evidência: arquivo de tema substituído por `NOT JSON AT ALL {{{` passou pelo validate sem uma palavra. O validate cobre frontmatter de agente, não tema | y |
| Restrição de ferramenta por papel | `tools:` no frontmatter do agente | Evidência: agente com `tools: Read, Grep` **não escreveu arquivo mesmo com `--dangerously-skip-permissions`**, e relatou ter só essas duas ferramentas. Restrição de ferramenta é ortogonal a bypass de permissão | y |
| Modelo e esforço default | `claude-opus-4-8` + `--effort xhigh` | Ambos verificados executando; a caixa de boas-vindas exibe `Opus 4.8 with xhigh effort` sem configuração extra | y |
| Acesso ao `claude-opus-4-8` | Preflight de **catálogo** com `getCachedOrDiscoverModels(registry, { agent: "claude" })`, mais tradução do erro do `claude` | O preflight pega erro de digitação, não direito de conta: a descoberta lê `models.dev`, settings locais e a API de modelos, e **não** diz se a conta autenticada pode usar o modelo. Um id pode constar no catálogo e ainda voltar `[claude-code:unrecognized_model]`. Então são três estados distintos, não um: catálogo indisponível, catálogo sem o modelo, e conta sem direito. Cache em disco com TTL de 4h (`src/core/models.ts:46`), e `findClosestModel` dá a sugestão | y |
| Papéis expostos no seletor | `general` (default), `orchestrator`, `reviewer` | São os únicos que uma pessoa escolhe *ser* ao abrir o terminal | y |
| `general` não tem arquivo de agente | Omitir `--agent`; o `ultra.md` já se aplica sozinho | Um agente que não restringe nada nem muda instrução é arquivo morto pra manter | n |
| Ferramentas por papel | `reviewer` sem `Edit`/`Write`/`Bash`; `orchestrator` sem `Edit`/`Write`, com `Bash`; `general` completo | O `orchestrator` precisa de `Bash` pra rodar `codedeck run/ps/diff`, e com `Bash` ainda consegue escrever via redirecionamento: pra ele a regra continua parcialmente dependente do prompt. Pro `reviewer` a restrição é total e verificada | y |
| Conteúdo do `ultra.md` | Identidade + 2 regras invioláveis | Critério: entra o que, se esquecido, causa estrago irreversível. Delegação/prova e "nunca arredonde pra sucesso" passam; grilling e unslop são reversíveis e viram skill, disparadas pela descrição (que já fica no contexto sempre) | y |
| Fronteira do orquestrador | Nunca escreve código; toda escrita vira sessão CodeDeck | Regra binária ("escreve arquivo?") que o modelo acerta sempre, contra um limiar subjetivo de tamanho que ele erraria pros dois lados | y |
| Subagente nativo | Permitido só pra leitura e pesquisa | Trabalho que não escreve não tem estado que valha supervisionar nem retomar | y |
| Prova de conclusão | Artefato manda, resposta explica | `codedeck diff <sessão>` já existe e é a prova que sistemas equivalentes precisam inventar à mão | y |
| Despacho sempre com `--worktree` | O orquestrador passa `--worktree` em todo `codedeck run` | `worktree` é `false` por default (`src/config/config.ts:14`) e `getDiff` cai em `options.worktree \|\| options.cwd` (`src/git/diff.ts:19`). Sem worktree, dois workers na mesma árvore aparecem um no diff do outro e a prova por artefato vira ruído | y |
| Ciclo de vida do worker | Uma sessão por tarefa, descartável | O valor da sessão CodeDeck não é resume de worker: é `ps`, `logs`, `diff` e worktree, que sobrevivem à morte dele | y |
| Superfície de flags | `--model`, `--effort`, `--resume`, `--worktree`, `--no-bypass`, `--no-theme`, passthrough após `--` | O `--` separa contrato do CodeDeck de repasse pro claude: superfície opinionada continua pequena e testável, e flag nova do claude não vira comportamento acidental do `open` | y |
| Worktree do próprio `open` | Opt-in via `--worktree`, delegando pro `-w` nativo do claude | O `open` é launcher fino; duplicar a lógica de worktree do daemon não se paga, e criar sempre atrapalha o uso mais comum (abrir no repo em que já se está) | y |
| Empacotamento | `plugin/` na raiz, `build` = `tsc && cp -r plugin dist/plugin`, caminho por `import.meta.url` | `tsc` não copia `.md` (verificado em projeto mínimo: `dist` saiu só com o `.js`). Manter pasta real permite `--plugin-dir plugin/` direto do repo sem build e `plugin validate --strict` sobre a mesma pasta | y |
| Banner | Escrita atômica única, sem animação | Medido: 0.403s (linha a linha) contra 0.003s (bloco único). O boot do próprio claude é ~0.79s até a primeira pintura, e o shim do `mise` responde por só 33ms disso | y |
| Nome da sessão | `-n "CodeDeck · <papel>"` | O `-n` aparece na régua acima do input, no `/resume` e no título da janela; com três terminais abertos, nome fixo os torna indistinguíveis | y |
| Daemon no `open` | Chamar `client.ensureDaemonStarted()` e **deixar propagar**, como `run.ts:90` e `wait.ts:35` | É método de instância do cliente IPC (`src/daemon/ipc.ts:190`), não função solta. Os outros 7 call sites engolem a falha em `try {} catch {}`, o que serve a comando de leitura; o `open` vira sessão de escrita e não pode subir com daemon morto em silêncio | y |
| Transcript em sessão filha | `open` remove `CLAUDE_CODE_CHILD_SESSION` do env do spawn | Evidência: sessão aninhada exibiu "Transcript saving is off, inherited CLAUDE_CODE_CHILD_SESSION marker"; sem limpar, sessão aberta de dentro de outra perde `--resume` | y |
| Seletor interativo | Pergunta só quando o papel é omitido | Primeira dependência de UI do projeto (hoje só `commander`): ou lib nova ou ~40 linhas de `readline` cru. Perguntar sempre seria odioso na décima abertura | y |
| Grilling | Skill própria, com trechos da skill MIT de Matt Pocock | MIT permite cópia mantendo o aviso de copyright: uma linha de crédito no cabeçalho ou NOTICE resolve | y |
| CI | `.github/workflows/ci.yml`, matriz Node 24 e 26, rodando `npm ci`, `npm run build` e `npm test` | Primeiro workflow do repo. A matriz não inclui 20 nem 22 porque `src/store/database.ts` importa `node:sqlite` e o shim de teste repassa o specifier pro Node real em vez de fingir: precisa de runtime onde `node:sqlite` carrega sem flag. Verificado local: 28 arquivos, 168 testes, verdes | y |
| Gate de tema no CI | Roda só quando houver credencial; fora disso é gate local | A captura de launch precisa de sessão `claude` autenticada, o que CI público não tem. `plugin validate --strict` roda sem credencial e cobre manifesto e agente, mas **não** cobre tema | n |
| Análise estática | SonarCloud Automatic Analysis, já ativo. **Não** adicionar scanner ao CI | Roda pelo lado do SonarCloud, sem arquivo no repo e sem `SONAR_TOKEN`: por isso não há config nenhuma versionada. Verificado no PR #10, check `SonarCloud Code Analysis`, pass em 17s, projeto `4ndreello_run-agent`. Adicionar um `sonar-scanner` no workflow **desativa** a análise automática, então o CI daqui cobre build e teste e deixa o Sonar em paz | y |

**Open questions:** nenhuma. A pendência do `engines` (declarava `>=20.0.0` com `node:sqlite` exigindo 23.4+) foi corrigida pra `>=24.0.0` junto do CI.

---

## User Stories

### P1: Launcher opinionado com plugin efêmero ⭐ MVP

**User Story**: As a dev do time, I want `codedeck open` a subir uma sessão Claude Code já configurada com as skills e o prompt do CodeDeck so that eu não precise manter alias pessoal nem instalar skill nenhuma na minha config global.

**Why P1**: É o núcleo. Sem o launcher e o empacotamento do plugin, nenhum dos outros papéis ou comportamentos tem onde existir.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN o usuário roda `codedeck open` THEN o CodeDeck SHALL invocar `client.ensureDaemonStarted()` antes de trocar de processo, deixando a falha propagar em vez de engolir <!-- event-driven --> `OPEN-01`
2. WHEN o `open` monta o comando THEN o CodeDeck SHALL passar `--model claude-opus-4-8`, `--effort xhigh`, `--dangerously-skip-permissions`, `--plugin-dir <dist>/plugin`, `--append-system-prompt-file <dist>/plugin/ultra.md` e `--settings <dist>/plugin/settings.json` <!-- event-driven --> `OPEN-02`
3. The CodeDeck SHALL resolver o caminho do plugin a partir de `import.meta.url`, nunca a partir do `cwd` <!-- ubiquitous --> `OPEN-02`
4. WHEN o `open` faz o spawn THEN o CodeDeck SHALL remover `CLAUDE_CODE_CHILD_SESSION` do ambiente do processo filho <!-- event-driven --> `OPEN-03`
5. WHEN o usuário passa `--model`, `--effort`, `--resume` ou `--worktree` THEN o CodeDeck SHALL sobrescrever o default correspondente <!-- event-driven --> `OPEN-04`
6. WHEN o usuário passa `--no-bypass` THEN o CodeDeck SHALL omitir `--dangerously-skip-permissions` <!-- event-driven --> `OPEN-04`
7. WHEN o usuário passa argumentos após `--` THEN o CodeDeck SHALL repassá-los verbatim ao `claude`, sem interpretá-los <!-- event-driven --> `OPEN-04`
8. IF o argumento após `--` colidir com uma flag que o `open` já define THEN o CodeDeck SHALL deixar o `claude` resolver a precedência e não abortar <!-- unwanted-behavior --> `OPEN-04`
9. The build SHALL copiar `plugin/` para `dist/plugin` <!-- ubiquitous --> `OPEN-05`
   *(o `files` do `package.json` já contém `dist`; só o passo de cópia é novo, porque `tsc` sozinho não leva `.md`)*
10. The manifesto do plugin SHALL declarar `author`, sem o qual `--strict` falha com `No author information provided` <!-- ubiquitous --> `OPEN-05`
11. The CI SHALL rodar `claude plugin validate --strict plugin/` e falhar em qualquer warning <!-- ubiquitous --> `OPEN-06`
12. The gate de tema SHALL ser uma captura real de launch procurando o código de cor, porque `plugin validate` **não olha tema nenhum** <!-- ubiquitous --> `OPEN-06`
13. IF o job não tiver credencial de `claude` THEN o gate de tema SHALL ser pulado com aviso, nunca passar silenciosamente como verde <!-- unwanted-behavior --> `OPEN-06`
14. The CI SHALL rodar `npm ci`, `npm run build` e `npm test` em matriz de Node onde `node:sqlite` carregue sem flag <!-- ubiquitous --> `OPEN-18`
15. BEFORE o spawn THEN o CodeDeck SHALL consultar `getCachedOrDiscoverModels(registry, { agent: "claude" })` <!-- event-driven --> `OPEN-17`
16. IF o catálogo carregou E não contém o modelo resolvido THEN o CodeDeck SHALL falhar antes do spawn citando o modelo pedido e a sugestão de `findClosestModel` <!-- unwanted-behavior --> `OPEN-17`
17. IF o catálogo não carregou (offline, cache frio, binário ausente) THEN o CodeDeck SHALL seguir com o modelo pedido e avisar, nunca bloquear o launch por indisponibilidade de descoberta <!-- unwanted-behavior --> `OPEN-17`
18. IF o `claude` sair com `[claude-code:unrecognized_model]` apesar do preflight THEN o CodeDeck SHALL traduzir isso em mensagem sobre direito de conta, porque o catálogo não prova entitlement <!-- unwanted-behavior --> `OPEN-19`

**Independent Test**: Rodar `npm pack`, instalar o tarball em diretório limpo, executar `npx codedeck open -- --version` e confirmar que o plugin foi resolvido a partir do pacote instalado, sem nada escrito em `~/.claude/`.

---

### P1: Papéis com restrição imposta por ferramenta ⭐ MVP

**User Story**: As a dev abrindo o CodeDeck, I want escolher no launch se estou conduzindo, revisando ou trabalhando so that o `reviewer` seja incapaz de escrever em vez de apenas instruído a não escrever.

**Why P1**: É o que distingue o `open` de um alias. E a restrição por ferramenta é a única parte da fronteira do orquestrador que não depende do modelo obedecer.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN o usuário roda `codedeck open <papel>` com papel em `general|orchestrator|reviewer` THEN o CodeDeck SHALL entrar direto no papel sem perguntar <!-- event-driven --> `OPEN-07`
2. WHEN o usuário roda `codedeck open` sem papel E o stdout é TTY THEN o CodeDeck SHALL apresentar seleção interativa dos três papéis com `general` pré-selecionado <!-- event-driven --> `OPEN-07`
3. IF o stdout não é TTY E nenhum papel foi passado THEN o CodeDeck SHALL assumir `general` sem bloquear esperando input <!-- unwanted-behavior --> `OPEN-07`
4. WHEN o papel resolvido é `orchestrator` ou `reviewer` THEN o CodeDeck SHALL passar `--agent <nome-do-plugin>:<papel>` com o namespace completo <!-- event-driven --> `OPEN-08`
5. WHEN o papel resolvido é `general` THEN o CodeDeck SHALL omitir `--agent` <!-- event-driven --> `OPEN-08`
6. The agente `reviewer` SHALL declarar `tools` sem `Edit`, `Write` nem `Bash` <!-- ubiquitous --> `OPEN-09`
7. The agente `orchestrator` SHALL declarar `tools` sem `Edit` e sem `Write`, mantendo `Bash` <!-- ubiquitous --> `OPEN-09`
8. IF o usuário passa um papel inexistente THEN o CodeDeck SHALL falhar antes do spawn listando os papéis válidos <!-- unwanted-behavior --> `OPEN-07`
9. WHEN qualquer papel é usado THEN o `ultra.md` SHALL continuar aplicado <!-- event-driven --> `OPEN-08`

**Independent Test**: `codedeck open reviewer` e pedir a criação de um arquivo; a sessão responde que não tem ferramenta de escrita e o arquivo não existe no disco, mesmo com bypass ligado.

---

### P2: Identidade visual da sessão

**User Story**: As a dev com três terminais abertos, I want cada sessão do CodeDeck visualmente identificada e distinguível pelo papel so that eu saiba num relance qual janela é qual.

**Why P2**: Não bloqueia trabalho, mas é o que faz o modo parecer um produto em vez de um alias. Depende só do P1.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN o `open` inicia THEN o CodeDeck SHALL imprimir o banner em uma única escrita atômica antes do `exec`, sem `sleep` intermediário <!-- event-driven --> `OPEN-10`
2. WHEN o `open` monta o comando THEN o CodeDeck SHALL passar `-n "CodeDeck · <papel>"` <!-- event-driven --> `OPEN-10`
3. The `settings.json` do plugin SHALL declarar `theme` como `custom:<nome-do-plugin>:<basename-do-arquivo-de-tema>`, ignorando o campo `name` do JSON do tema <!-- ubiquitous --> `OPEN-11`
4. The manifesto do plugin SHALL declarar o tema sob `experimental.themes` <!-- ubiquitous --> `OPEN-11`
5. WHEN o usuário passa `--no-theme` THEN o CodeDeck SHALL omitir a chave `theme` do settings efetivo, preservando `statusLine` <!-- event-driven --> `OPEN-11`
6. The statusLine SHALL exibir papel, modelo e branch, derivando cada valor do payload recebido ou do git, nunca de texto fixo <!-- ubiquitous --> `OPEN-12`
7. IF o terminal não suporta truecolor THEN o banner SHALL continuar legível (arte não pode depender de cor pra fazer sentido) <!-- unwanted-behavior --> `OPEN-10`

**Independent Test**: Abrir com pty capturado e confirmar no dump: `Opus 4.8 with xhigh effort` na caixa, `CodeDeck · orchestrator` na régua acima do input, e o código de cor do `promptBorder` do tema presente na saída.

---

### P2: Disciplina de despacho do orquestrador

**User Story**: As a dev conduzindo trabalho paralelo, I want o orquestrador delegando toda escrita pra sessões CodeDeck e conferindo artefato antes de dizer pronto so that ele nunca reporte concluído o que ninguém fez.

**Why P2**: É prompt e uso de CLI que já existe (`run`, `ps`, `diff`, `stop`), sem código novo de daemon e sem estado durável. Depende do P1. A versão com plano em disco e retomada é `codedeck-orchestrate`.

**Escopo**: dentro de uma sessão. O plano vive no contexto da conversa, não em disco. Fechar o terminal perde o plano, e isso é aceito aqui de propósito: durabilidade é a feature seguinte.

**Acceptance Criteria** (each line is one EARS pattern):

1. The agente `orchestrator` SHALL instruir que toda tarefa que escreve arquivo vira sessão CodeDeck, e que subagente nativo só é permitido pra leitura e pesquisa <!-- ubiquitous --> `OPEN-13`
2. WHEN o orquestrador despacha uma tarefa THEN ele SHALL passar `--worktree` no `codedeck run`, pra que o diff de cada worker seja atribuível <!-- event-driven --> `OPEN-14`
3. WHEN um worker termina THEN o orquestrador SHALL consultar `codedeck diff <sessão>` antes de afirmar qualquer conclusão <!-- event-driven --> `OPEN-15`
4. IF o worker terminou com `diff` vazio THEN o orquestrador SHALL reportar que nada foi produzido, nunca concluído <!-- unwanted-behavior --> `OPEN-15`
5. IF a resposta do worker afirma sucesso mas o artefato não confirma THEN o orquestrador SHALL tratar o artefato como autoridade <!-- unwanted-behavior --> `OPEN-15`
6. WHEN uma tarefa falha THEN o orquestrador SHALL despachar no máximo um ciclo corretivo antes de reportar a falha ao humano <!-- event-driven --> `OPEN-16`
7. WHEN uma tarefa termina THEN o orquestrador SHALL encerrar a sessão do worker <!-- event-driven --> `OPEN-16`
8. The agente `orchestrator` SHALL declarar explicitamente que workers hoje sobem sem o setup do CodeDeck, pra que ele escreva prompt autossuficiente em vez de assumir skill disponível do outro lado <!-- ubiquitous --> `OPEN-13`

**Independent Test**: Rodar um plano de duas tarefas onde a segunda não tem nada a fazer; a primeira é reportada com diff não vazio, a segunda é reportada como sem produção, e nenhum worker segue vivo em `codedeck ps`.

---

## Edge Cases

- IF `dist/plugin` não existe (instalação corrompida ou build sem o passo de cópia) THEN o `open` SHALL falhar com mensagem apontando o caminho esperado, nunca subir sessão sem plugin silenciosamente
- IF o ref de tema estiver errado THEN a sessão SHALL subir normalmente sem tema (falha silenciosa é comportamento do harness, não corrigível daqui): por isso o gate é captura de launch, e não `plugin validate`
- IF o `claude` não estiver no `PATH` THEN o `open` SHALL falhar com instrução de instalação, sem stack trace
- IF a versão do `claude` não suportar `--append-system-prompt-file` THEN o `open` SHALL detectar antes do spawn e falhar explicando; a detecção é o texto de erro do commander, que separa `argument missing` de `unknown option`
- IF o modelo pedido não constar no catálogo THEN o `open` SHALL falhar antes do spawn com sugestão, porque isso é quase sempre erro de digitação
- IF o cache de modelos estiver frio E a descoberta falhar (offline, binário fora do `PATH`) THEN o `open` SHALL seguir com o modelo pedido em vez de bloquear: o preflight é rede de segurança, não portão
- IF o modelo constar no catálogo mas a conta não tiver direito THEN só o `claude` descobre, e o `open` SHALL traduzir o `unrecognized_model` em mensagem sobre plano em vez de deixar o erro cru
- WHEN o `open` roda dentro de outra sessão Claude Code THEN a limpeza de `CLAUDE_CODE_CHILD_SESSION` SHALL garantir transcript salvo na sessão nova
- IF o usuário roda `codedeck open` fora de um repositório git THEN o `open` SHALL subir normalmente e a statusLine SHALL exibir ausência de branch sem erro
- IF `--worktree` for passado junto de `--resume` THEN o `open` SHALL deixar o `claude` decidir a combinação, sem validação própria
- IF o `cwd` do processo não existir mais (diretório apagado embaixo do shell) THEN o `open` SHALL falhar antes do spawn. O `open` não tem flag de diretório alvo: quem quiser outro diretório passa `--add-dir` depois do `--`

---

## Requirement Traceability

| Requirement ID | Requisito | Story | Status |
| -------------- | --------- | ----- | ------ |
| OPEN-01 | Daemon garantido antes do spawn | P1 Launcher | Pending |
| OPEN-02 | Flags default e resolução do plugin | P1 Launcher | Pending |
| OPEN-03 | Higiene de ambiente no spawn | P1 Launcher | Pending |
| OPEN-04 | Superfície de override e passthrough | P1 Launcher | Pending |
| OPEN-05 | Empacotamento do plugin | P1 Launcher | Pending |
| OPEN-06 | Gates de validação | P1 Launcher | Pending |
| OPEN-07 | Resolução do papel e seletor | P1 Papéis | Pending |
| OPEN-08 | Ligação agente + system prompt | P1 Papéis | Pending |
| OPEN-09 | Restrição por ferramenta | P1 Papéis | Pending |
| OPEN-10 | Banner e nome de sessão | P2 Visual | Pending |
| OPEN-11 | Tema | P2 Visual | Pending |
| OPEN-12 | statusLine | P2 Visual | Pending |
| OPEN-13 | Fronteira de escrita do orquestrador, e aviso de que o worker sobe sem setup | P2 Despacho | Pending |
| OPEN-14 | Isolamento por worktree no despacho | P2 Despacho | Pending |
| OPEN-15 | Prova por artefato | P2 Despacho | Pending |
| OPEN-16 | Ciclo de vida do worker | P2 Despacho | Pending |
| OPEN-17 | Preflight de modelo | P1 Launcher | Pending |
| OPEN-18 | Pipeline de build e teste | P1 Launcher | Done |
| OPEN-19 | Tradução do erro de entitlement | P1 Launcher | Pending |
| OPEN-20 | Edge cases de ambiente (plugin ausente, `claude` fora do `PATH`, `cwd` morto, sem git, terminal sem truecolor) | Edge Cases | Pending |

**ID format:** `[CATEGORY]-[NUMBER]`

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 20 requisitos. `OPEN-18` já está entregue (`.github/workflows/ci.yml`); os outros 19 esperam `tasks.md`. `OPEN-20` agrupa os edge cases de ambiente, que antes não tinham ID nenhum e podiam sumir da implementação sem violar a tabela.

**Aviso sobre o CI atual:** o workflow cobre build e a suíte existente (28 arquivos, 168 testes, sobre runtime, power, models e drivers). Ele **não** cobre nenhum AC desta spec, porque `open` e `plugin/` ainda não existem. CI verde aqui não é evidência de `OPEN-01` a `OPEN-17`.

---

## Success Criteria

- [ ] `npx codedeck open` em máquina limpa sobe sessão com skills do CodeDeck disponíveis e nada escrito em `~/.claude/`
- [ ] `codedeck open reviewer` não consegue criar arquivo mesmo com bypass ligado
- [ ] `claude plugin validate --strict plugin/` passa sem warning
- [ ] Um teste pina a grafia que falha **em silêncio**: `custom:<plugin>:<slug>` aplica, as outras três não pintam nada, e o slug é o basename do arquivo (o campo `name` não resolve)
- [ ] Um teste pina `experimental.themes` e `--append-system-prompt-file`, que falham alto e de formas diferentes
- [ ] Banner aparece em uma escrita só, sem atraso artificial mensurável
- [ ] `codedeck open --model inexistente-9` falha antes do spawn com sugestão, e o segundo `open` seguido não paga descoberta de novo
- [ ] Zero deps novas além do seletor interativo, zero passo com root, testes escopados verdes
