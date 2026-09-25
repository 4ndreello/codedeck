# Store Busy Healing Specification

## Problem Statement

`attachDriverEvents` persistia cada evento num `BEGIN` deferred: `events.append` lê (dedupe por `source_key`, `MAX(sequence)`) antes do INSERT. Se outra conexão commita nesse intervalo, o upgrade leitura→escrita recebe `SQLITE_BUSY_SNAPSHOT` (errcode 517) na hora, sem `busy_timeout`. O `catch` tratava isso como falha do harness: gravava `session.failed` (`UNKNOWN`, `blame: harness`), marcava a linha `failed` e saía do loop, enquanto o harness seguia vivo e seus eventos deixavam de ser persistidos (sessão `df94`: tokens do segundo turno perdidos, `wait` com estado terminal falso).

A causa do segundo escritor (N daemons) é tratada em `daemon-single-instance`. Esta spec torna o loop robusto a qualquer escritor concorrente (ex.: `codedeck usage backfill`, lock mantido > 5s).

## Goals

- [x] `BEGIN IMMEDIATE` no loop de eventos: o lock de escrita é pego antes da leitura, `busy_timeout` volta a valer
- [x] `SQLITE_BUSY` (errcode base 5, incluindo 517) não encerra o loop nem marca a sessão: o mesmo evento é retentado com backoff (25ms dobrando, teto 2s) enquanto o daemon roda
- [x] Erros de persistência não-busy mantêm o comportamento atual (`failed`)
- [x] `classifyFailure("database is locked")` → `STORE_BUSY`, `blame: infra`, `retryable: true`
- [x] Reconciliador no boot (`reviveStoreBusyFailures`, antes do loop de `recover()`): linha `failed` com `failure.code=STORE_BUSY` ou `failure.detail` contendo `database is locked`, com log em disco e PID, volta a `working` e passa pelo mesmo reattach de um restart
  - harness vivo (mesma identidade de PID): segue tailando do offset persistido
  - harness morto (ou PID reciclado): o log é drenado do offset e o desfecho é classificado; eventos drenados e `completedAt` recebem o mtime do log (os parsers carimbam hora de leitura)
- [ ] Desfecho de harness morto sem frame terminal e exit não observado (hoje `failed` "exited without reporting a terminal event"): aceitar `turn.completed` final como `completed`? Decisão pendente

## Decisions

| Decisão | Escolha | Racional |
| ------- | ------- | -------- |
| Retry sem limite | Sim, enquanto não `shuttingDown` | O harness continua vivo e a saída está no log em disco; desistir recria o bug. Um lock eterno é problema do daemon, logado uma vez em `daemon.log` |
| Idempotência do retry | Transação inteira refeita (evento + offsets + status) | ROLLBACK desfaz tudo; dedupe por `sourceKey` protege replays |
| Shutdown durante o retry | Sai do loop sem gravar nada | O drain de shutdown é dono do desfecho (`interrupted`) |
| Reviver `failed` de lock | Só no boot, só com log + PID, nunca `origin=open` | Reusa o caminho de reattach testado; `open` não tem driver para reatachar |
| Horário do backlog drenado | mtime do log (máx. de stdout/stderr) quando o harness já morreu | Parsers usam `new Date()` na leitura; o mtime é o limite superior honesto. O uso por hora agrupa por `created_at`, então só a linha do tempo e `completedAt` mudam |
| Idempotência | O desfecho novo não tem `database is locked` no `detail` | Um boot seguinte não revive a mesma linha de novo |

## Acceptance Criteria

1. WHEN outro processo commita entre a leitura e a escrita da transação do evento THEN todos os eventos SHALL ser persistidos e a sessão SHALL terminar `completed`
2. WHEN `append` lança `SQLITE_BUSY`/`BUSY_SNAPSHOT` THEN o daemon SHALL retentar o mesmo evento e nenhum `session.failed` SHALL ser gravado
3. WHEN `append` lança um erro não-busy THEN a sessão SHALL ser marcada `failed` (sem regressão)
4. WHEN o texto do erro é `database is locked` THEN `classifyFailure` SHALL retornar `STORE_BUSY` com `blame: infra`
5. WHEN o boot encontra uma linha `failed` por lock com harness vivo THEN ela SHALL voltar a `working` e os eventos novos do log SHALL ser persistidos
6. WHEN o harness dessa linha já morreu THEN o log SHALL ser drenado do offset, a sessão SHALL terminar em estado terminal sem `database is locked`, e eventos drenados e `completedAt` SHALL usar o mtime do log
7. WHEN a falha não é de lock, ou não há log THEN a linha SHALL ficar intacta

## Validation

`tests/daemon-store-busy.test.ts` (AC 1-4), `tests/daemon-heal-store-busy.test.ts` (AC 5-7). AC 1 reproduz a intercalação real com uma segunda `DatabaseSync` e falhava antes do fix com só `session.failed` no log de eventos.
