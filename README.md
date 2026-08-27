# Run Agent

Local runtime for coding agents — session management, process supervision, event normalization, git isolation.

> **Process manager for coding agents**: PM2 + tmux + git worktrees + normalized events

## Visão

O Run Agent não é um agente. Ele gerencia o lifecycle de harnesses existentes:

- **Claude Code** (`claude -p --output-format stream-json`)
- **Codex** (`codex exec --json` / app-server)
- **OpenCode** (`opencode run --format json`)
- **OMP** (`omp --mode rpc`)

A CLI `ra` oferece uma interface única para todos:

```bash
ra run "implemente autenticação" --agent claude
ra run "corrija os testes" --agent codex
ra run "investigue esse bug" --agent opencode
ra run "refatore esse módulo" --agent omp

ra ps
ra logs a83f --follow
ra show a83f
ra send a83f "adicione testes"
ra stop a83f
ra diff a83f
ra doctor
```

## Stack

- TypeScript / Node.js
- SQLite (`node:sqlite` - DatabaseSync)
- Unix Domain Socket para IPC
- Git worktrees para isolamento

## Instalação

```bash
npm install -g run-agent
# ou
npx run-agent
```

Binários: `ra` e `run-agent`

Durante desenvolvimento:

```bash
npm install
npm run build
node dist/cli/index.js doctor
# ou alias local
npm link
ra doctor
```

## Arquitetura

```
ra CLI
  │ IPC (Unix Socket, NDJSON)
  ▼
Run Agent Daemon
  ├── Session Store (SQLite)
  ├── Event Store (SQLite)
  ├── Process Manager
  └── Driver Registry
        ├── ClaudeDriver (stream-json)
        ├── CodexDriver (exec --json)
        ├── OpencodeDriver (run --format json)
        └── OmpDriver (rpc)
```

O daemon é dono das sessões. A CLI apenas acompanha eventos — fechar o terminal não mata o agente.

## Comandos

| Comando | Descrição |
|---------|-----------|
| `ra doctor` | Verifica Node, Git, harnesses, daemon, banco |
| `ra run "<prompt>" --agent <id> [--model <m>] [--name <n>] [--worktree] [--detach]` | Inicia sessão |
| `ra ps [--all] [--json]` | Lista sessões recentes |
| `ra show <id> [--json]` | Detalhes da sessão |
| `ra logs <id> [--follow] [--json] [--raw]` | Eventos normalizados |
| `ra send <id> "<msg>"` | Continua sessão (novo turn) |
| `ra stop <id>` | Interrupção graceful → SIGTERM → SIGKILL |
| `ra diff <id> [--stat] [--json]` | Git diff vs base commit |

## Sessão

```ts
Session {
  id: string          // ex: a83f (run-agent)
  nativeSessionId?    // id interno do harness
  agent: "claude"|"codex"|"opencode"|"omp"
  status: "starting"|"working"|"needs_input"|"idle"|"completed"|"failed"|"stopped"|"orphaned"
  cwd, worktree, branch, repository, baseCommit
  pid, usage, createdAt, updatedAt
}
```

`nativeSessionId` é detalhe interno — o usuário só vê o ID do Run Agent.

## Eventos normalizados

```ts
AgentEvent =
  | session.started | turn.started | text.delta | message
  | tool.started | tool.completed | file.changed
  | permission.requested | permission.resolved
  | usage.updated | turn.completed
  | session.completed | session.failed | error
```

Todo evento persiste com `raw` intacto para debug e compatibilidade futura.

Tabelas:

- `sessions` — estado por sessão
- `events` — log monotônico `(session_id, sequence)`

## Worktrees

```bash
ra run "implemente oauth" --worktree
# cria ~/.run-agent/worktrees/<repo-hash>/<session-id>
# branch: ra/<slug>-<session-id>
```

O driver recebe o worktree como `cwd`. O isolamento é responsabilidade do Run Agent, não do harness.

Config global: `~/.config/run-agent/config.json` ou `~/.run-agent/` (fallback)

```json
{
  "defaultAgent": "claude",
  "worktree": true
}
```

## Spikes

Validam cada harness isoladamente antes de abstrações:

```
spikes/claude.ts
spikes/codex.ts
spikes/opencode.ts
spikes/omp.ts
```

Rodar com:

```bash
npx tsx spikes/claude.ts
```

Cada spike prova: detect, start, prompt, eventos, nativeSessionId, conclusão, interrupt, resume, stderr, cleanup.

## Desenvolvimento

```
src/
  cli/       → commander, comandos (run/ps/show/logs/send/stop/diff/doctor)
  core/      → driver interface, session, events, capabilities, errors
  drivers/   → claude / codex / opencode / omp
  daemon/    → daemon, ipc (Unix socket), process-manager, protocol
  store/     → SQLite (sessions, events)
  git/       → repository, worktree, diff
  config/    → paths, config
  utils/
```

Build:

```bash
npm run build
npm test
```

## Definition of Done (primeiro release)

```bash
cd example-project
ra doctor
ra run "find one improvement and implement it" --agent claude --worktree --detach
ra run "find one improvement and implement it" --agent codex --worktree --detach
ra ps
ra logs <claude-session> --follow
ra show <codex-session>
ra diff <claude-session>
ra diff <codex-session>
ra send <claude-session> "run the tests before finishing"
ra stop <codex-session>
```

Mesma experiência para os quatro harnesses.

## Segurança

- Não armazena API keys/tokens — usa auth dos harnesses.
- Raw events podem conter dados sensíveis (documentado).
- Não modifica config do usuário silenciosamente.

## Licença

MIT
