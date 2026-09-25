# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CodeDeck (`codedeck` binary, repo still named `run-agent` in places) is a local process manager for coding-agent harnesses: Claude Code, Codex, OpenCode, OMP and Antigravity. It is not an agent. It starts harnesses, normalizes their event streams, persists sessions in SQLite, and isolates work in git worktrees. It also ships a Claude Code plugin (`plugin/`) that `codedeck open` loads to run an opinionated session with a role contract.

Node >= 24 is required: the store uses `node:sqlite` (`DatabaseSync`) with no flag.

## Commands

```bash
npm install
npm run build              # tsc -> dist/, then scripts/copy-plugin.mjs (generates plugin/agents, copies plugin/ -> dist/plugin)
npm run build:plugin       # only the plugin step
npm run dev                # tsc --watch (does NOT run the plugin step)
node dist/cli/index.js doctor
```

Tests are vitest over `tests/**/*.test.ts`, run against `src/` directly (no build needed for unit tests). `npm test` is a bare `vitest run` and runs everything, so scope it:

```bash
npx vitest run tests/session-store.test.ts
npx vitest run tests/open-            # filename substring
npx vitest run tests/roles.test.ts -t "parseRole"
scripts/run-isolated.sh npx vitest run tests/foo.test.ts   # caps RAM/swap in a sibling systemd scope so an OOM does not kill the terminal
```

Gate scripts that drive the built `dist/` (run `npm run build` first): `scripts/pty-gate.sh` (fake harness, no credential), `scripts/theme-gate.sh` and `scripts/rename-gate.sh` (need an authenticated `claude`). CI (`.github/workflows/ci.yml`) runs build + tests + pty gate on Node 24 and 26, plus `claude plugin validate --strict plugin/`.

Spikes (`spikes/*.ts`, run with `npx tsx spikes/claude.ts`) are throwaway harness probes kept as a record. They are excluded from tsc, the package, and Sonar. Do not hold them to shipped-code standards or refactor them.

## Architecture

```
codedeck CLI (src/cli, commander)
  │  NDJSON over Unix socket (~/.run-agent/daemon.sock), see docs/protocol.md
  ▼
Daemon (src/daemon/daemon.ts)  ── auto-spawned by IpcClient.ensureDaemonStarted() from dist/daemon/daemon.js
  ├── SessionStore / EventStore / claims (src/store, SQLite ~/.run-agent/run-agent.db)
  ├── DriverRegistry (src/drivers/registry.ts) -> one AgentDriver per harness
  └── git worktrees (src/git) under ~/.run-agent/worktrees/<repo-hash>/<session-id>
```

- The daemon owns sessions; the CLI only subscribes. Closing the terminal does not kill an agent.
- **Detached harness processes.** Drivers spawn harnesses detached, writing stdout/stderr to `~/.run-agent/logs/<session>.ndjson`. `SessionRuntime` (`src/drivers/session-runtime.ts`) tails those files with `FileTailer` and persists byte offsets, so a restarted daemon reattaches by PID + `/proc` start time instead of respawning (`AgentDriver.attach`). Resume turns (`send`) append to the same log files.
- **Driver contract** is `src/core/driver.ts` (`detect`, `capabilities`, `start`, `send`, `stop`, `events`, optional `resume`/`attach`/`listModels`). Most drivers are built from `src/drivers/session-driver.ts`: a per-harness `parser.ts` turns one raw line into normalized `AgentEvent`s (`src/core/events.ts`), and `synthesizeTerminal` produces a `session.failed` when the process dies without a terminal frame. Every event keeps its raw payload.
- **Failure contract.** `session.failed` carries `failure { code, blame: harness|task|infra, retryable }` (`src/core/errors.ts`), mirrored on the session row. `run`/`wait` exit codes map to it: 0 completed/stopped, 1 task, 2 harness crash, 3 infra (including `interrupted` after shutdown). A harness death is never reported as `completed`.
- **Shutdown/power.** On SIGTERM/SIGHUP the daemon drains, marks active sessions `interrupted` with `code: SHUTDOWN`, and holds a `systemd-inhibit` delay lock when available. Resume is explicit via `send`.
- **Config** (`src/config/`): `~/.config/run-agent/config.json` (or `$XDG_CONFIG_HOME/run-agent`, legacy `~/.run-agent/config.json`). Holds `defaultAgent`, per-role bindings (`agents`), `models`, sandbox, autocompact. Tests override locations with `RUN_AGENT_DIR` and `RUN_AGENT_CONFIG_DIR`.
- **Roles** (`src/core/roles.ts`): `general`, `orchestrator`, `reviewer`, `auditor`. `run --role` resolves harness + model from the role binding. On claude the role is passed as `--agent` (tool allowlist enforced by the harness); on other harnesses `composeRunPrompt` prefixes `ultra.md` + the role body to the prompt, so the restriction is prose only.
- **`open`** (`src/open/`): per-harness launchers in `src/open/launchers/`. For claude it builds a settings payload at launch (theme, status line with resolved plugin path, spinner, tips) instead of writing to `~/.claude`. It runs the harness under a pty (`script(1)` + `plugin/pty-shim.mjs`) so it can type `/rename` once `plugin/hooks/session-name.sh` derives a name from the first prompt. Keystrokes per harness live in `src/open/injection.ts`.
- `src/git/review.ts` + `src/web/review-page.ts` back `codedeck review` (local HTML review of current changes).

## Plugin and prompts

- `plugin/agents/*.md` are **generated**. Edit `plugin/prompts/roles/<role>.md` (frontmatter `name`, `description`, `tools`, `includes:` list) and `plugin/prompts/_partials/*.md`, then run `npm run build:plugin`. The reviewer gets a scoped copy of the `proof` partial (see `resolvePartial` in `scripts/copy-plugin.mjs`). `orchestrator-edit`/`orchestrator-read` are tool-mode variants chosen by `src/config/orchestrator-mode.ts`.
- `plugin/ultra.md` is the core contract prepended to every role.
- `resolvePluginDir()` prefers `dist/plugin` when running from `dist/`, so a running `codedeck` sees plugin edits only after `npm run build:plugin`.
- An agent file with no `tools:` key is unrestricted. Granting `Bash` drops `Grep`/`Glob` from the resolved toolset. Measured harness quirks live in `docs/harness-behaviour.md`; read it before changing agent frontmatter or `open` flags.
- `${CLAUDE_PLUGIN_ROOT}` is expanded only in `hooks/hooks.json`, never in `statusLine.command`, and fails silently. That is why `open` writes resolved paths.
- Function hooks / mods (`plugin/hooks/register.tsx`, `plugin/mods/`) need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (set in `sanitizeEnv`, `src/open/runtime.ts`) and claude >= 2.1.269. See `docs/mods.md`.
- Many tests pin prompt and manifest text (`prompt-layers`, `orchestrator-prose`, `plugin-manifest`, `tlc-spec-driven`, `roles`). Changing prose usually means updating those tests.
- The `commit` and `pr-writer` sections of the general agent are rendered from `skills/commit` and `skills/pr-writer` by `SKILL_PARTIALS` in `scripts/copy-plugin.mjs`, which swaps references to skills the prompt cannot load. Edit the skill; the build fails if an adaptation stops matching.
- Top-level `skills/` holds standalone skills. `skills/use-codedeck` also has an installed copy under `~/.claude`; edit both or the `/use-codedeck` command does not change.

## Testing notes

- `node:sqlite` is aliased to `tests/helpers/node-sqlite-shim.ts` in `vitest.config.ts` because Vite cannot resolve it. Keep that alias.
- Daemon tests drive private lifecycle methods through `tests/helpers/daemon-seam.ts` without starting a socket server. Harness output fixtures live in `tests/fixtures/<harness>/`.

## Workflow conventions

- Feature work follows the spec-driven flow (`plugin/skills/tlc-spec-driven`): artifacts live in `.specs/features/<feature>/` (`spec.md`, optionally `design.md`, `tasks.md`, `validation.md`). Check for an existing spec before changing a feature.
- Commits and PR titles: Conventional Commits in English, `<type>(<scope>): <Subject>` (imperative, capitalized subject, no trailing period, max 70 chars), e.g. `fix(open): Reuse the prior session when resuming an open`.
