# Daemon Single Instance Specification

## Problem Statement

Uma máquina real acumulou 10 processos `dist/daemon/daemon.js --daemon` no mesmo `~/.run-agent`. O caminho: `isDaemonRunning()` (`src/daemon/ipc.ts`) desiste do socket após 1s; o daemon usa `DatabaseSync` síncrono, então uma query/checkpoint/espera de `busy_timeout` longa bloqueia o `accept`; o CLI conclui que não há daemon e `ensureDaemonStarted()` sobe outro; `createIpcServer()` deslinka o socket vivo; o daemon antigo segue vivo, sem socket, ainda escrevendo no SQLite; o novo `recover()` reatacha as mesmas sessões.

Com N daemons tailando o mesmo log e escrevendo no mesmo banco, o `BEGIN` deferred de `attachDriverEvents` sofre `SQLITE_BUSY_SNAPSHOT` (errcode 517, imediato, ignora `busy_timeout`), o `catch` marca a sessão `failed` com `database is locked` e sai do loop, enquanto o harness continua rodando (sessão `df94`, `codex exec resume` vivo após o "fail").

## Goals

- [x] No máximo um daemon por `RUN_AGENT_DIR`, garantido pelo SO
- [x] Um daemon perdedor não migra, não reatacha e não toca no socket
- [x] Nenhum lock stale: morte por `SIGKILL` libera o lock
- [ ] (fase 2, spec própria) Loop de eventos resistente a `SQLITE_BUSY`: `BEGIN IMMEDIATE`, retry, nunca `failed` com PID vivo
- [ ] (fase 2) Reconciliador: sessão `failed` por erro de store com PID vivo é reatachada

## Out of Scope

| Feature | Reason |
| ------- | ------ |
| Matar daemons extras já rodando | Ação manual única (`kill -9`, não `SIGTERM`, que marcaria sessões `interrupted`) |
| Aumentar o timeout do probe no CLI | Com o lock, um spawn a mais é inofensivo: sai com 0 e o CLI continua pollando |

## Decisions

| Decisão | Escolha | Racional |
| ------- | ------- | -------- |
| Mecanismo | Arquivo SQLite `daemon.lock` em `locking_mode=EXCLUSIVE`, `busy_timeout=0` | Lock fcntl liberado pelo kernel na morte do processo; `node:sqlite` já é dependência; Node não expõe `flock` |
| Arquivo separado | Não usar `run-agent.db` | Lock exclusivo no banco principal bloquearia CLIs read-only (`usage`) |
| Onde | Entrada `--daemon`, antes de `new Daemon()` | O perdedor não roda migração nem `recover()` |
| Saída do perdedor | `exit 0` + linha em `daemon.log` | `ensureDaemonStarted` segue pollando e conecta no daemon existente |

## Acceptance Criteria

1. WHEN um daemon segura o lock THEN um segundo `acquireInstanceLock` (mesmo processo ou outro) SHALL retornar `null`
2. WHEN o dono do lock morre por `SIGKILL` THEN o próximo daemon SHALL adquirir o lock sem limpeza
3. WHEN `daemon.js --daemon` inicia com o lock ocupado THEN SHALL sair com 0 sem abrir o banco nem deslinkar o socket

## Validation

- `tests/daemon-instance-lock.test.ts` (AC 1, 2)
- Manual contra `dist/`: dois `daemon.js --daemon` no mesmo `RUN_AGENT_DIR` → segundo sai 0, `daemon.log` registra, socket e `daemon.pid` seguem do primeiro; após `kill -9` do primeiro, um novo sobe (AC 3)
