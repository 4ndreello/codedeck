# Store Busy Healing Specification

## Problem Statement

`attachDriverEvents` persistia cada evento num `BEGIN` deferred: `events.append` lê (dedupe por `source_key`, `MAX(sequence)`) antes do INSERT. Se outra conexão commita nesse intervalo, o upgrade leitura→escrita recebe `SQLITE_BUSY_SNAPSHOT` (errcode 517) na hora, sem `busy_timeout`. O `catch` tratava isso como falha do harness: gravava `session.failed` (`UNKNOWN`, `blame: harness`), marcava a linha `failed` e saía do loop, enquanto o harness seguia vivo e seus eventos deixavam de ser persistidos (sessão `df94`: tokens do segundo turno perdidos, `wait` com estado terminal falso).

A causa do segundo escritor (N daemons) é tratada em `daemon-single-instance`. Esta spec torna o loop robusto a qualquer escritor concorrente (ex.: `codedeck usage backfill`, lock mantido > 5s).

## Goals

- [x] `BEGIN IMMEDIATE` no loop de eventos: o lock de escrita é pego antes da leitura, `busy_timeout` volta a valer
- [x] `SQLITE_BUSY` (errcode base 5, incluindo 517) não encerra o loop nem marca a sessão: o mesmo evento é retentado com backoff (25ms dobrando, teto 2s) enquanto o daemon roda
- [x] Erros de persistência não-busy mantêm o comportamento atual (`failed`)
- [x] `classifyFailure("database is locked")` → `STORE_BUSY`, `blame: infra`, `retryable: true`
- [ ] (próxima fase) Reconciliador: sessão `failed` com `STORE_BUSY`/`UNKNOWN` de lock e PID vivo com a mesma identidade é reatachada a partir dos offsets persistidos

## Decisions

| Decisão | Escolha | Racional |
| ------- | ------- | -------- |
| Retry sem limite | Sim, enquanto não `shuttingDown` | O harness continua vivo e a saída está no log em disco; desistir recria o bug. Um lock eterno é problema do daemon, logado uma vez em `daemon.log` |
| Idempotência do retry | Transação inteira refeita (evento + offsets + status) | ROLLBACK desfaz tudo; dedupe por `sourceKey` protege replays |
| Shutdown durante o retry | Sai do loop sem gravar nada | O drain de shutdown é dono do desfecho (`interrupted`) |

## Acceptance Criteria

1. WHEN outro processo commita entre a leitura e a escrita da transação do evento THEN todos os eventos SHALL ser persistidos e a sessão SHALL terminar `completed`
2. WHEN `append` lança `SQLITE_BUSY`/`BUSY_SNAPSHOT` THEN o daemon SHALL retentar o mesmo evento e nenhum `session.failed` SHALL ser gravado
3. WHEN `append` lança um erro não-busy THEN a sessão SHALL ser marcada `failed` (sem regressão)
4. WHEN o texto do erro é `database is locked` THEN `classifyFailure` SHALL retornar `STORE_BUSY` com `blame: infra`

## Validation

`tests/daemon-store-busy.test.ts` (AC 1-4). AC 1 reproduz a intercalação real com uma segunda `DatabaseSync` e falhava antes do fix com só `session.failed` no log de eventos.
