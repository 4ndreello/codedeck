# Open multi-harness Specification

> Escopo: `codedeck open` passa a lançar no harness do binding do role (claude ou opencode), com o launcher separado em três jurisdições: contrato (prompt), apresentação (UI) e runtime (spawn e sessão). Depende de `.specs/features/codedeck-open/spec.md`, que descreve o comportamento atual só-Claude.

## Problem Statement

`codedeck open` hoje só lança Claude Code. Um role amarrado a outro harness no `setup` não abre nada: `harnessMismatch` (`src/cli/commands/open.ts:325`) aborta e manda usar `codedeck run`. Quem trabalha no opencode fica sem a sessão opinionada, sem o contrato do role e sem o bypass configurado.

No mesmo arquivo moram três coisas distintas: injeção de prompt (role, `ultra.md`, modelo), estilo da sessão (tema, spinner, statusline) e runtime (daemon, banner, spawn, SIGINT, farewell). Qualquer harness novo paga o preço das três juntas, e a parte portável não é reutilizável porque não tem fronteira.

## Goals

- [ ] `codedeck open <role>` lança no harness que o `setup` amarrou ao role, claude ou opencode, sem flag nova de seleção
- [ ] O launcher vira factory: módulo de contrato idêntico entre harnesses, adapter de UI por harness, runtime compartilhado
- [ ] O launcher Claude migrado para a factory mantém o comportamento atual (a suíte `open-args` existente continua verde)
- [ ] Paridade no opencode: bypass ligado por padrão (`--auto`), preflight de modelo por catálogo, daemon garantido, banner e farewell

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
| ------- | ------ |
| Launchers codex e omp no `open` | A factory permite, mas cada um exige sonda própria de TUI e permissão; entra depois com o mesmo molde do opencode |
| Portar o tema `codedeck-ultra` para o opencode | Formato de tema do Claude não porta; no MVP o opencode abre com TUI stock |
| Statusline do opencode | `statusline.sh` lê payload do Claude; equivalente no opencode exige sonda de TUI que não existe ainda |
| `--worktree` no opencode | O opencode não tem `-w` nativo; avisa e segue sem, como `--fast` no claude faz hoje em `run.ts` |
| Tradução de erro de entitlement do opencode | Formato de erro não medido; falha de launch mostra o erro cru até haver sonda, sem inventar tradução |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Formato da factory | `OpenLauncher` por harness (`resolveBinary`, `preflightModel`, `assertSupport`, `buildLaunch`) + contrato, UI e runtime compartilhados | É o corte que a análise do `open.ts` atual já sugere: `buildOpenArgs`/`buildSettings` são só-Claude, o resto não | y |
| Seleção do harness | Só pelo binding do `setup`; sem flag `--agent`/`--harness` no `open` | Decisão do usuário nesta spec; evita reabrir a briga flag-vs-binding que o `run` já resolveu a favor do binding | y |
| Bypass no opencode | `--auto` ligado por padrão, `--no-bypass` desliga | Decisão do usuário nesta spec; paridade com `--dangerously-skip-permissions` e mesma superfície de flags | y |
| Escopo do MVP | Factory completa com o Claude migrado junto, não um launcher paralelo | Decisão do usuário nesta spec; termina sem dois `open` para manter | y |
| Tradução de permissão | Ponto de partida espelha o Claude (reviewer nega edit, mantém bash), mas o veredito final é o da sonda `OO-14`: se ela mostrar escrita via bash, o mapeamento muda para negar bash e esta linha é revisada | Apertar antes da sonda faria o mesmo role significar coisas distintas por harness sem evidência; decidir antes da sonda anularia o gate `OO-17` | n |
| Precedência de `--model` no `open` | Flag explícita vence o binding, como hoje (`opts.model ?? binding?.model`) | Preserva o comportamento atual do `open`; difere do `run` de propósito e sem mudar nada silenciosamente | n |
| Config efêmera do opencode | `OPENCODE_CONFIG_CONTENT` inline com `instructions`, agente, prompt e permission num JSON só; nenhum arquivo, nada para limpar | Sonda real: agente `zzprobe` injetado só por env apareceu em `agent list`, `debug agent` resolveu `edit:false/write:false` e `debug config` mostrou as `instructions`; `~/.config/opencode` intacto | y |
| Resume no opencode | `--resume <id>` vira `--session`; sem hook de SessionStart não há captura de id, então o farewell sai sem linha de resume | `renderExit` já trata id ausente; prometer resume sem captura seria arredondar para sucesso | n |
| Catálogo indisponível no preflight | Avisar e seguir com o modelo pedido, nunca bloquear | Precedente direto do preflight atual do Claude (`OPEN-17`) | y |
| UI do opencode no MVP | TUI stock; `--no-theme` aceito e sem efeito além de pular o que não existe | Tema próprio do opencode está fora de escopo; a flag não pode falhar por isso | n |

**Open questions:** none - all resolved or logged above (required before the spec is confirmed).

---

## User Stories

### P1: Factory com o Claude migrado sem mudar comportamento ⭐ MVP

**User Story**: As a dev mantendo o CodeDeck, I want o `open` separado em contrato, UI e runtime com o Claude como um launcher da factory so that o comportamento atual continue idêntico e o próximo harness reuse o que é comum.

**Why P1**: É o núcleo. Sem a separação, o launcher opencode duplica runtime; sem migrar o Claude, sobram dois `open` para manter.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN o usuário roda `codedeck open` com qualquer role amarrado ao claude THEN o CodeDeck SHALL montar os mesmos args de hoje (`--plugin-dir`, `--append-system-prompt-file`, `--settings`, `--agent codedeck:<role>`) <!-- event-driven --> `OO-01`
2. The contrato do role (corpo do agente sem frontmatter + `ultra.md`) SHALL ser resolvido por um módulo que não importa nada dos launchers, verificado por teste que resolve corpo e prompt sem spawn e sem import de harness <!-- ubiquitous --> `OO-02`
3. WHEN a suíte `open-args` existente roda THEN todos os testes SHALL passar sem alteração de expectativa <!-- event-driven --> `OO-03`
4. WHEN o binding do role aponta para opencode THEN o CodeDeck SHALL lançar pelo launcher opencode em vez de lançar erro de `harnessMismatch` <!-- event-driven --> `OO-04`

**Independent Test**: `npx vitest run tests/open-args.test.ts` verde após o refactor, mais `codedeck open reviewer -- --version` subindo a mesma sessão de antes.

---

### P1: Open no opencode pelo binding ⭐ MVP

**User Story**: As a dev com role amarrado ao opencode, I want `codedeck open <role>` abrir o TUI do opencode com o contrato do role so that eu tenha a mesma sessão opinionada sem estar no Claude.

**Why P1**: É a feature visível. Sem ela a factory é refactor sem entrega.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN o role resolvido tem binding para opencode THEN o CodeDeck SHALL montar `OPENCODE_CONFIG_CONTENT` com `instructions` do `ultra.md` e o agente `codedeck-<role>` (prompt do corpo do agente, permission do mapa de ferramentas), sem escrever em `~/.config/opencode` nem em tmp <!-- event-driven --> `OO-05`
2. WHEN o `open` lança no opencode THEN o CodeDeck SHALL passar `--agent codedeck-<role>`, `--model <modelo>` em formato `provider/model` e `--auto` (omitido só com `--no-bypass`) <!-- event-driven --> `OO-06`
3. WHEN o usuário passa `--resume <id>` THEN o CodeDeck SHALL repassar como `--session <id>` <!-- event-driven --> `OO-07`
4. WHEN o usuário passa argumentos após `--` THEN o CodeDeck SHALL repassá-los verbatim ao `opencode`, sem interpretá-los <!-- event-driven --> `OO-08`
5. IF o `opencode` não estiver no `PATH` THEN o CodeDeck SHALL falhar com instrução de instalação, sem stack trace <!-- unwanted-behavior --> `OO-09`
6. BEFORE o spawn THEN o CodeDeck SHALL consultar o catálogo do opencode via `getCachedOrDiscoverModels(registry, { agent: "opencode" })` <!-- event-driven --> `OO-10`
7. IF o catálogo carregou E não contém o modelo resolvido THEN o CodeDeck SHALL falhar antes do spawn citando o modelo e a sugestão de `findClosestModel`, com a busca feita pelo launcher do harness e o veredito puro sobre o catálogo (o `judgeModel` atual fixa `agent === "claude"` e SHALL ser dividido assim) <!-- unwanted-behavior --> `OO-15`
8. WHEN a sessão opencode termina THEN o CodeDeck SHALL imprimir o farewell, com linha de resume só quando houver id capturado; nada existe para limpar porque o contrato viajou por env <!-- event-driven --> `OO-11`
9. WHEN o `open` inicia no opencode THEN o CodeDeck SHALL garantir o daemon via `client.ensureDaemonStarted()` deixando a falha propagar <!-- event-driven --> `OO-12`

**Independent Test**: Com `general` amarrado ao opencode, rodar `codedeck open` e confirmar que o TUI abre com as instruções do CodeDeck e que `~/.config/opencode` não foi modificado nem tmp criado.

---

### P2: UI mínima do opencode

**User Story**: As a dev abrindo sessão no opencode, I want o `open` aceitar `--no-theme` sem erro so that a superfície de flags seja a mesma nos dois harnesses.

**Why P2**: Não bloqueia trabalho, mas flag que existe num harness e explode no outro é armadilha.

**Acceptance Criteria**:

1. WHEN o usuário passa `--no-theme` com binding opencode THEN o CodeDeck SHALL abrir normalmente com TUI stock <!-- event-driven --> `OO-13`
2. The launcher opencode SHALL sair com TUI stock sem aplicar tema, spinner customizado nem statusline no MVP <!-- ubiquitous --> `OO-16`

**Independent Test**: `codedeck open --no-theme` com binding opencode abre e fecha sem erro.

---

### P2: Prova de restrição do reviewer no opencode

**User Story**: As a dev abrindo `reviewer` no opencode, I want a restrição de escrita verificada por sonda so that o papel signifique o mesmo nos dois harnesses.

**Why P2**: A tradução `tools:` para `permission:` é a única parte do contrato que não se transfere por inspeção; sem sonda a promessa é chute.

**Acceptance Criteria**:

1. WHEN a sonda de launch roda `reviewer` no opencode com `--auto` THEN a sessão SHALL recusar criação de arquivo via ferramenta de edit <!-- event-driven --> `OO-14`
2. The resultado da sonda (recusa ou escrita via bash) SHALL estar registrado na tabela de suposições desta spec antes de declarar o papel equivalente <!-- ubiquitous --> `OO-17`

**Independent Test**: Sessão `reviewer` no opencode recebe pedido de criar arquivo; o arquivo não existe no disco e a resposta cita falta de permissão, mesmo com `--auto` ligado.

---

## Edge Cases

- IF o conteúdo inline não puder ser montado (arquivo de agente ausente, plugin incompleto) THEN o `open` SHALL falhar antes do spawn, nunca subir sessão sem contrato silenciosamente <!-- unwanted-behavior --> `OO-18`
- IF dois `open` rodarem juntos THEN cada um SHALL levar seu próprio env sem arquivo ou estado compartilhado <!-- unwanted-behavior --> `OO-19`
- IF `--worktree` for passado com binding opencode THEN o CodeDeck SHALL avisar que não há equivalente e seguir sem, como `--fast` faz no claude <!-- unwanted-behavior --> `OO-20`
- IF o modelo do binding não estiver no formato `provider/model` THEN o CodeDeck SHALL falhar antes do spawn explicando o formato esperado <!-- unwanted-behavior --> `OO-21`
- IF o `cwd` do processo não existir mais THEN o `open` SHALL falhar antes do spawn, igual ao launcher atual <!-- unwanted-behavior --> `OO-22`
- IF o usuário roda `codedeck open` fora de repositório git THEN o `open` no opencode SHALL subir normalmente <!-- unwanted-behavior --> `OO-23`

---

## Requirement Traceability

| Requirement ID | Requisito | Story | Status |
| -------------- | --------- | ----- | ------ |
| OO-01 | Args do Claude preservados na factory | P1 Factory | Pending |
| OO-02 | Módulo de contrato sem dependência de harness | P1 Factory | Implementing |
| OO-03 | Suíte open-args verde sem mudar expectativa | P1 Factory | Implementing |
| OO-04 | Fim do harnessMismatch para roles no opencode | P1 Factory | Pending |
| OO-05 | Conteúdo inline com agente e instructions | P1 Opencode | Pending |
| OO-06 | Flags `--agent`, `--model`, `--auto` no launch | P1 Opencode | Implementing |
| OO-07 | `--resume` vira `--session` | P1 Opencode | Pending |
| OO-08 | Passthrough após `--` verbatim | P1 Opencode | Pending |
| OO-09 | Binário ausente falha com instrução | P1 Opencode | Pending |
| OO-10 | Preflight de modelo no catálogo opencode | P1 Opencode | Pending |
| OO-11 | Farewell ao fechar, sem limpeza | P1 Opencode | Implementing |
| OO-12 | Daemon garantido antes do spawn | P1 Opencode | Implementing |
| OO-13 | `--no-theme` aceito, TUI stock | P2 UI | Pending |
| OO-14 | Sonda de restrição do reviewer | P2 Prova | Pending |
| OO-15 | Rejeição de modelo com veredito por harness | P1 Opencode | Pending |
| OO-16 | TUI stock sem tema nem statusline no MVP | P2 UI | Pending |
| OO-17 | Resultado da sonda registrado antes da equivalência | P2 Prova | Pending |
| OO-18 | Montagem do inline aborta antes do spawn | Edge | Implementing |
| OO-19 | Env próprio por processo, sem compartilhamento | Edge | Pending |
| OO-20 | `--worktree` no opencode avisa e segue | Edge | Pending |
| OO-21 | Modelo fora do formato falha antes do spawn | Edge | Pending |
| OO-22 | `cwd` morto falha antes do spawn | Edge | Implementing |
| OO-23 | Fora de git sobe normalmente | Edge | Pending |

**ID format:** `[CATEGORY]-[NUMBER]`

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 23 requisitos, 0 mapeados para tasks (Tasks ainda não existe).

---

## Success Criteria

- [ ] `codedeck open` com role no claude abre sessão idêntica à de antes (suíte existente verde, sem mudar expectativa)
- [ ] `codedeck open` com role no opencode abre o TUI com o contrato do role e nada escrito em `~/.config/opencode`
- [ ] `codedeck open --model inexistente-9` com binding opencode falha antes do spawn com sugestão
- [ ] Sonda do reviewer no opencode registrada: recusa de escrita via edit com `--auto` ligado, e veredito sobre escrita via bash
- [ ] Zero dependência nova de runtime, zero passo com root, testes escopados verdes
