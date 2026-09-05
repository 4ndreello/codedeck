# Daemon Power Graceful Specification

## Problem Statement

O daemon CodeDeck morre de forma cega num `poweroff`/`reboot`/lid-close: `shutdown()` só deslinka socket/pid e fecha o SQLite, sem drenar tailers, sem `wal_checkpoint` e sem marcar sessões. Sessões `working` viram `orphaned`/`failed` genéricos no próximo `recover()`, o último evento pode se perder e o usuário não sabe como retomar. Precisamos de shutdown graceful best-effort (≤4s, sem root) e retomada manual clara.

## Goals

- [ ] Nenhum `poweroff`/`SIGTERM` corrompe `~/.run-agent/run-agent.db` (WAL checkpointado ou recuperável via `integrity_check`)
- [ ] Toda sessão ativa no momento do `SIGTERM` termina em estado terminal honesto (`interrupted` com `failure.code=SHUTDOWN`), nunca presa em `working`
- [ ] `codedeck ps/show/wait/doctor` explicam o estado pós-reboot e o caminho de resume (`send`)
- [ ] Nenhuma mudança exige root, nova dep obrigatória ou `postinstall` privilegiado

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
| ------- | ------ |
| Impedir/atrasar `poweroff` além de `InhibitDelayMaxSec` (modo `block`) | Exige `auth_admin`/root, bypassável por `--force`/`sysrq`, fora do escopo de pacote npm |
| Auto-`send`/auto-retry LLM no boot | Custo de tokens + side-effects (`tool writes`) sem consentimento; resume é sempre explícito |
| Remoção automática de worktrees no shutdown | Worktree contém patch não commitado; destruição silenciosa é inaceitável (`codedeck gc` futuro resolve) |
| `completed` sintético quando o harness morreu sem frame terminal | Viola invariante `terminal.ts`: fantasma faz o agente avançar sobre trabalho faltante |
| Listener D-Bus obrigatório (`dbus-next` hard dep) | Quebra installs sem logind (containers, macOS, CI); D-Bus é opt-in |
| `codedeck setup` (unit systemd/LaunchAgent) | Fase 2, spec própria; esta spec só endurece + avisa |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| Novo status `interrupted` é terminal | `isTerminalStatus` inclui `interrupted`; `wait` sai com código 3 (infra) | Distingue perda de energia de `failed` (bug do task) e `orphaned` (crash com PID vivo); `ps` filtra corretamente | n |
| Linha de evento persistida no shutdown | `session.failed` existente com `failure.code=SHUTDOWN`, `blame=infra`, `retryable=true`; NENHUM novo tipo de evento | `isTerminalEvent` (`events.ts:160`, só `completed`/`failed`), replay do `subscribe` (`daemon.ts:474-477`), `wake()` do `wait` e `broadcast done` só reconhecem esses dois tipos; novo tipo travaria `wait` | n |
| Mapeamento exit code | `exitCodeForOutcome` trata `status=interrupted` no mesmo ramo de `failed`/`orphaned` (`blame=infra` → 3) | Sem isso retorna 0 para status desconhecido e o AC de exit 3 falha | n |
| Ordenamento do shutdown vs locks/transações | Handler seta `shuttingDown=true` de forma síncrona; `handleRequest` rejeita com `SERVICE_UNAVAILABLE` enquanto flag; shutdown adquire `sessionLocks` por sessão antes de escrever `interrupted` (mesmo lock que `send`/`stop` e que faz `attachDriverEvents` descartar frames terminais sob lock em `daemon.ts:630`) | Serializa contra `send`/`stop` em voo e contra `COMMIT` por evento; sem isso o write do shutdown corre contra transação aberta | n |
| Processo sobrevivente ao kill | `recover()` ignora rows `interrupted` (fora de `listActive`, que só retorna `starting\|working\|needs_input\|idle`): nunca reatacha, nunca muda o status; processo que sobreviveu vira órfão não-rastreado (documentado, sem hunt) | Reatachar ressuscitaria para `working` e contradiria o `interrupted` gravado; caçar órfãos é escopo de `gc` futuro | n |
| `killGraceMs` do shutdown graceful | 1500ms por sessão, em paralelo via `Promise.allSettled`, sempre com `expectedStartTime=pidStartTime` quando conhecido | Cabe em `InhibitDelayMaxSec=5s` para 2-4 sessões; sem `expectedStartTime` o `killTree` sinaliza PID reciclado às cegas | n |
| Ordem do flush no shutdown | `wal_checkpoint(PASSIVE)` antes do kill, `TRUNCATE` depois, `db.close()` por último; filho `systemd-inhibit` morre após o `TRUNCATE`, antes do `db.close()` | `PASSIVE` incremental protege mesmo se `SIGKILL` chegar no meio; `TRUNCATE` final é best-effort | n |
| Linha `.ndjson` truncada | Descarte silencioso (sem evento `error`, sem `failed` sintetizado) SOMENTE no drain do `handleShutdown`; `FileTailer.flush()` normal inalterado | `flush()` atual emite `leftover` via `finishPartial()`; mudar globalmente alteraria semântica de crash comum | n |
| D-Bus/logind nesta fase | Nenhum; só `SIGTERM`/`SIGINT`/`SIGHUP` + `systemd-inhibit` filho se o binário existir | Zero dep nova; `PrepareForSleep/Shutdown` ficam para fase com `power.ts` dedicado | n |
| `SIGHUP` tratado como shutdown graceful | Sim, mesmo handler do `SIGTERM` | logind emite `SIGHUP` no lid-close/logout; hoje o daemon morre sem limpeza | n |
| `send` para `interrupted` | Mesmo fluxo de resume-turn; liveness com identidade (`processAlive` + `pidStartTime` igual, mesma regra do `stop`); `CAPABILITY_NOT_SUPPORTED` tem precedência sobre verificação de liveness | Sem identidade, reboot com PID reciclado bloqueia resume legítimo ou mira processo estranho | n |
| `paused` como status dedicado | Não; `pause` futuro usa `working` + campo `pausedAt` | Evita churn em `isTerminalStatus`/`ps`/`wait` para estado transitório | n |
| SQLite pragmas | `busy_timeout=5000`, `synchronous=NORMAL`, `wal_autocheckpoint=1000` em `migrate()` | Elimina `SQLITE_BUSY` entre daemon e CLI concorrente sem custo mensurável por evento | n |
| `daemon.stop` via IPC | `handleRequest` roteia `daemon.stop` para o mesmo `handleShutdown`; nenhum CLI o emite ainda (testável via IPC direto) | `protocol.ts` declara mas o switch cai em `UNKNOWN_METHOD` hoje | n |

**Open questions:** none - all resolved or logged above (required before the spec is confirmed).

---

## User Stories

### P1: Shutdown graceful no poweroff ⭐ MVP

**User Story**: As a laptop user com sessões rodando, I want o daemon a marcar `interrupted` e fechar o SQLite com segurança no `SIGTERM` so that nenhum reboot deixa sessão fantasma `working` nem DB corrompido.

**Why P1**: É o núcleo da feature; sem isso todo o resto (hints, resume) mente sobre o estado real.

**Acceptance Criteria** (each line is one EARS pattern):

1. WHEN o daemon recebe `SIGTERM` THEN o daemon SHALL setar `shuttingDown=true` de forma síncrona e executar `handleShutdown("SIGTERM")` exatamente uma vez <!-- event-driven -->
2. WHILE `shuttingDown` está setada o daemon SHALL rejeitar novos `handleRequest` com `SERVICE_UNAVAILABLE` <!-- state-driven -->
3. WHEN `handleShutdown` executa THEN o daemon SHALL adquirir `sessionLocks` por sessão ativa antes de escrever, e persistir UM evento `session.failed` com `failure.code=SHUTDOWN`, `blame=infra`, `retryable=true` + `sessions.setStatus(interrupted)` para cada sessão em `starting|working|needs_input|idle` <!-- event-driven -->
4. WHEN `handleShutdown` executa THEN o daemon SHALL invocar `driver.stop()`/`killTree` com `graceMs=1500` e `expectedStartTime=<pidStartTime conhecido>` em paralelo (`Promise.allSettled`) para cada sessão ativa com PID <!-- event-driven -->
5. WHEN `handleShutdown` inicia o drain THEN o daemon SHALL executar `PRAGMA wal_checkpoint(PASSIVE)` antes do kill e `PRAGMA wal_checkpoint(TRUNCATE)` depois, antes de `db.close()` <!-- event-driven -->
6. WHILE `handleShutdown` está em curso o daemon SHALL ignorar `SIGTERM`/`SIGINT` repetidos sem reiniciar o flush <!-- state-driven -->
7. IF um `BEGIN` estava aberto durante o `SIGTERM` THEN o daemon SHALL finalizar com `ROLLBACK` ou `COMMIT` antes de `db.close()`, nunca fechar no meio da transação <!-- unwanted-behavior -->
8. The daemon SHALL expor `handleShutdown` como método testável sem depender de systemd/logind <!-- ubiquitous -->
9. The daemon SHALL remover o handler `process.on("exit", shutdown)` e registrar `SIGTERM`/`SIGINT`/`SIGHUP` via `process.once` <!-- ubiquitous -->

**Independent Test**: Subir daemon com 2 sessões fake ativas, `kill -TERM <pid>`, reabrir o DB e ver 2 rows `interrupted` + último evento `session.failed` com `failure.code=SHUTDOWN` e `PRAGMA integrity_check` OK.

---

### P1: Sinais que faltam (SIGHUP) e pragmas SQLite ⭐ MVP

**User Story**: As a laptop user que fecha a tampa, I want o daemon a tratar `SIGHUP` igual a `SIGTERM` e o SQLite a tolerar CLI concorrente so that lid-close/logout não mata o daemon sem limpeza nem aborta `COMMIT` com `SQLITE_BUSY`.

**Why P1**: Sem `SIGHUP` o lid-close mata sem `shutdown()`; sem `busy_timeout` o `doctor`/`ps` concorrente derruba o lote do evento.

**Acceptance Criteria**:

1. WHEN o daemon recebe `SIGHUP` THEN o daemon SHALL executar o mesmo `handleShutdown("SIGHUP")` do `SIGTERM` <!-- event-driven -->
2. The database SHALL aplicar `PRAGMA busy_timeout=5000` em `migrate()` <!-- ubiquitous -->
3. IF dois processos tocam o DB concorrentemente THEN o writer SHALL aguardar até 5s em vez de abortar com `SQLITE_BUSY` <!-- unwanted-behavior -->

**Independent Test**: `kill -HUP <daemon-pid>` drena e sai 0 sem deixar `daemon.sock` órfão; teste de concorrência daemon+CLI não retorna `SQLITE_BUSY`.

---

### P2: Pós-reboot honesto (ps/show/wait/doctor)

**User Story**: As a user que religou a máquina, I want `ps`/`show`/`wait`/`doctor` a mostrarem `interrupted` e o caminho de resume so that eu sei o que morreu no poweroff e como continuar.

**Why P2**: Estado correto sem superfície legível não serve; mas é camada de apresentação sobre a P1.

**Acceptance Criteria**:

1. WHEN o usuário roda `codedeck ps` após reboot THEN o CLI SHALL listar sessões `interrupted` recentes com símbolo `⏻` distinto de `failed` <!-- event-driven -->
2. WHEN o usuário roda `codedeck show <id> --json` numa sessão `interrupted` THEN o CLI SHALL exibir `status=interrupted` e objeto `failure` com `code=SHUTDOWN` <!-- event-driven -->
3. WHEN o usuário roda `codedeck wait <id>` numa sessão `interrupted` THEN o CLI SHALL retornar imediatamente com exit code 3 (via `exitCodeForOutcome` com ramo `interrupted` + `blame=infra`) <!-- event-driven -->
4. WHEN o usuário roda `codedeck doctor` THEN o CLI SHALL exibir seção `Power` com `service instalado?` (existência de `~/.config/systemd/user/codedeck.service`) e `systemd-inhibit disponível?` (via `which`, sem exigir systemd ativo nem root) <!-- event-driven -->
5. WHEN o usuário roda `codedeck run --help` THEN o help SHALL documentar em ≤3 linhas que poweroff marca `interrupted` e resume é via `send` <!-- event-driven -->

**Independent Test**: Seed de DB com 1 row `interrupted` + evento `session.failed` SHUTDOWN, rodar `ps`/`show --json`/`wait` e conferir símbolo, JSON com `failure.code` e exit code 3.

---

### P2: Resume manual via send para interrupted

**User Story**: As a user com sessão `interrupted`, I want `codedeck send <id> "continue"` a reabrir o turno com `--resume <nativeId>` so that eu retomo sem perder `cwd`/`worktree`/`branch`.

**Why P2**: Fecha o loop poweroff→reboot→continue reaproveitando o resume-turn existente.

**Acceptance Criteria**:

1. WHEN o usuário roda `send` numa sessão `interrupted` com `nativeSessionId` e driver com `resume:true` e sem processo vivo com identidade correspondente THEN o daemon SHALL iniciar novo harness com `resumeSessionId=<nativeId>` no mesmo `cwd`/`worktree` <!-- event-driven -->
2. IF a sessão `interrupted` não tem `nativeSessionId` ou o driver tem `resume:false` THEN o daemon SHALL rejeitar com `CAPABILITY_NOT_SUPPORTED` antes de qualquer checagem de liveness <!-- unwanted-behavior -->
3. WHILE existe processo vivo com `processAlive(pid)` E `processStartTime(pid)=pidStartTime` registrado THEN o daemon SHALL rejeitar `send` com `SESSION_BUSY` e hint para `stop` primeiro, mesmo com status `interrupted` <!-- state-driven -->

**Independent Test**: Seed `interrupted` com `nativeSessionId` fake, `send` spouses harness com args contendo `--resume <id>`; sem `nativeSessionId`, erro `CAPABILITY_NOT_SUPPORTED`; com PID vivo de mesma identidade, `SESSION_BUSY`.

---

### P3: Delay-lock best-effort sem D-Bus

**User Story**: As a Linux user com systemd, I want o daemon a segurar um `systemd-inhibit --mode=delay` filho enquanto drena so that o shutdown aguarda até `InhibitDelayMaxSec` antes do `SIGKILL`.

**Why P3**: Ganha os 5s garantidos sem `dbus-next`; mas é otimização sobre o `SIGTERM` que já funciona.

**Acceptance Criteria**:

1. WHERE o binário `systemd-inhibit` existe no `PATH` o daemon SHALL spawna-lo em `start()` com argv `systemd-inhibit --what=shutdown:sleep --who=CodeDeck --why="flush sessions" --mode=delay sleep infinity`, mantido vivo pela vida do daemon e morto após o `TRUNCATE`, antes do `db.close()` <!-- optional-feature -->
2. WHERE o binário `systemd-inhibit` não existe o daemon SHALL seguir só com `SIGTERM` sem erro nem warn bloqueante <!-- optional-feature -->
3. IF o flush excede `InhibitDelayMaxSec` THEN o sistema SHALL prosseguir o shutdown e o daemon SHALL já ter persistido `interrupted` (falha aberta segura) <!-- unwanted-behavior -->

**Independent Test**: Teste unitário com `PATH` stubado contendo `systemd-inhibit` fake: asserts argv exato e que o filho morre após `TRUNCATE` (sem depender de `--list` racy); com `PATH` sem o binário, shutdown segue normal.

---

## Edge Cases

Edge cases are usually unwanted-behavior (IF/THEN) or boundary (WHEN) criteria:

- IF o `SIGKILL` chega no meio do flush THEN o daemon SHALL ter ao menos executado `wal_checkpoint(PASSIVE)` e marcado `interrupted` antes do kill (ordem: PASSIVE → kill → TRUNCATE)
- IF a linha final do `.ndjson` está truncada (sem `\n`) no drain do `handleShutdown` THEN o daemon SHALL descartá-la sem emitir evento `error` nem `failed` sintetizado (drain-path only; `flush()` normal inalterado)
- IF o PID foi reutilizado entre poweroff e boot THEN o `recover()` SHALL marcar `failed` com `reason=pid_reused` e nunca sinalizar o processo estranho
- WHEN 5+ sessões ativas drenam em paralelo THEN o daemon SHALL concluir em <5s (`Promise.allSettled`, nunca sequencial)
- IF o FS já desmontou (`EROFS`/`EIO`) durante o flush THEN o daemon SHALL abortar o flush e sair 0 sem mascarar o erro original
- IF `daemon.stop` chega via IPC THEN o daemon SHALL executar o mesmo `handleShutdown` do `SIGTERM` (gap atual: switch cai em `UNKNOWN_METHOD`)
- IF um harness sobreviveu ao `killTree` do shutdown THEN o próximo `recover()` SHALL ignorar a row `interrupted` (sem reattach, sem flip) e o processo segue órfão não-rastreado

---

## Requirement Traceability

Each requirement gets a unique ID for tracking across design, tasks, and validation.

| Requirement ID | Story | Phase | Status |
| -------------- | ----- | ----- | ------ |
| PWR-01 | P1: Shutdown graceful no poweroff | Done | Verified |
| PWR-02 | P1: Shutdown graceful no poweroff | Done | Verified |
| PWR-03 | P1: Shutdown graceful no poweroff | Done | Verified |
| PWR-04 | P1: Sinais que faltam e pragmas | Done | Verified |
| PWR-05 | P1: Sinais que faltam e pragmas | Done | Verified |
| PWR-06 | P2: Pós-reboot honesto | Done | Verified |
| PWR-07 | P2: Pós-reboot honesto | Done | Verified |
| PWR-08 | P2: Resume manual via send | Done | Verified |
| PWR-09 | P2: Resume manual via send | Done | Verified |
| PWR-10 | P3: Delay-lock best-effort | Done | Verified |

**ID format:** `[CATEGORY]-[NUMBER]` (e.g., `AUTH-01`, `CART-03`, `NOTIF-02`)

**Status values:** Pending → In Design → In Tasks → Implementing → Verified

**Coverage:** 10 total, 10 mapped to tasks (T1-T11), 0 unmapped

---

## Success Criteria

How we know the feature is successful:

- [ ] `kill -TERM <daemon-pid>` com 2 sessões ativas resulta em 2× `interrupted` + último evento `session.failed` SHUTDOWN e `integrity_check` OK em <5s
- [ ] `kill -HUP <daemon-pid>` tem o mesmo efeito, sem socket órfão
- [ ] `codedeck wait <interrupted>` retorna exit 3 imediatamente após reboot simulado
- [ ] Zero novas deps obrigatórias, zero passos com root, `npm test` verde
