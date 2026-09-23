# open-boot-latency

> Cortar o tempo fixo que o CodeDeck soma antes do harness subir no `codedeck open`, e medir o que sobra.

## Contexto medido (sessões 80c5 e c3ea, fake harness, daemon isolado)

| Cenário | Mediana | Mín |
|---|---:|---:|
| `open`, daemon quente, animação padrão | 930 ms | 924 ms |
| `open`, daemon quente, `--no-theme` | 189 ms | 151 ms |
| `open`, daemon frio, `--no-theme` | 724 ms | 538 ms |
| `ps` quente / frio | 105 / 305 ms | 91 / 295 ms |
| daemon spawn até aceitar socket | 79 ms | 61 ms |

- `playBoot` (`src/open/runtime.ts:424-460`) dorme 19 x 40 ms antes do spawn: ~740 ms fixos.
- `ensureDaemonStarted` (`src/daemon/ipc.ts:213-216`) dorme 200 ms antes da primeira checagem, com o socket pronto em ~60-80 ms.

## Requisitos

- **R1**: WHEN `playBoot` runs on a TTY THEN the sum of its animation delays SHALL be at most 200 ms.
- **R2**: WHEN `playBoot` runs on a TTY THEN its last logo frame SHALL be the fully resolved frame (progress 1), followed by the `role · model · effort` line and the `booting…` line.
- **R3**: WHILE stdout is not a TTY, `playBoot` SHALL write `renderBanner(...)` once and SHALL NOT wait on any timer.
- **R4**: WHEN `ensureDaemonStarted` spawns the daemon THEN it SHALL resolve within 50 ms after the socket starts accepting connections.
- **R5**: IF the socket never accepts THEN `ensureDaemonStarted` SHALL reject with `Failed to start daemon` no earlier than 6 s after the spawn.
- **R6**: WHEN a daemon already accepts on the socket THEN `ensureDaemonStarted` SHALL NOT spawn a process.

## Fora de escopo

- Rodar a animação em paralelo aos probes ou ao daemon.
- Lazy import dos comandos em `src/cli/index.ts` (~48 ms medidos).
- Cache de `detect()` no `doctor`.
- Mudanças no plugin, hooks e status line (dependem da medição D1).

## Tasks

| Task | Requisitos | Arquivos | Tests | Gate |
|---|---|---|---|---|
| T1 animação com orçamento | R1, R2, R3 | `src/open/runtime.ts`, `tests/open-boot.test.ts` | unit, fake timers | `npx vitest run tests/open-boot.test.ts` |
| T2 poll do daemon | R4, R5, R6 | `src/daemon/ipc.ts`, `tests/ipc-daemon-start.test.ts` | unit, socket unix real em dir temp, spawn mockado | `npx vitest run tests/ipc-daemon-start.test.ts` |
| D1 medição do boot do claude e probes | discovery | nenhum | none | relatório |

## Coverage matrix

| Camada | Tipo | Onde | Comando |
|---|---|---|---|
| `src/open/runtime.ts` (`playBoot`) | unit, fake timers | `tests/open-boot.test.ts` | `npx vitest run tests/open-boot.test.ts` |
| `src/daemon/ipc.ts` (`ensureDaemonStarted`) | unit, socket real | `tests/ipc-daemon-start.test.ts` | `npx vitest run tests/ipc-daemon-start.test.ts` |
| Regressão do open | unit existente | `tests/open-*.test.ts` | `npx vitest run tests/open-` |
| D1 | none (discovery) | - | - |

## Rodada 2 (medição D1, sessão 9e3f)

Com cache quente, `resolveBinary` custa 78 ms (`which` + `claude --version`, versão descartada) e `assertSupport` 176 ms (sobe o claude pra testar a flag), em todo `open`.

- **R7**: WHEN `resolveBinary` (claude launcher) finds `claude` on PATH THEN it SHALL return its absolute path without spawning the `claude` binary.
- **R8**: WHEN `assertSupport` already passed for the same binary (same realpath, size and mtime) THEN it SHALL NOT spawn `claude`.
- **R9**: WHEN no support record exists for the binary, or its realpath, size or mtime changed, THEN `assertSupport` SHALL run the probe.
- **R10**: IF the probe reports an unknown option THEN `assertSupport` SHALL throw the upgrade error and SHALL NOT record support.

| Task | Requisitos | Arquivos | Tests | Gate |
|---|---|---|---|---|
| T3 probes do claude | R7-R10 | `src/open/launchers/claude.ts`, `tests/open-claude-probes.test.ts` | unit, binário fake em PATH temp | `npx vitest run tests/open-claude-probes.test.ts tests/open-` |

Fora de escopo nesta rodada: launchers codex/opencode (mesmo padrão), cache do catálogo de modelos (367 ms só no cache frio), status line (138 ms a cada 2 s), boot real do claude (não medido: exige a conta autenticada).
