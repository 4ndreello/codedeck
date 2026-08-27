# Spikes

Validação isolada dos 4 harnesses antes de abstrações.

Cada spike prova 10 pontos:

1. detectar instalação
2. iniciar harness
3. enviar prompt
4. receber eventos estruturados
5. identificar sessão nativa
6. detectar conclusão
7. interromper (stop)
8. continuar sessão (resume)
9. capturar stderr e falhas
10. finalizar corretamente

Rodar:

```bash
npx tsx spikes/claude.ts
npx tsx spikes/codex.ts
npx tsx spikes/opencode.ts
npx tsx spikes/omp.ts
```

Observado em 27/08/2026:

- **Claude**: `claude -p --output-format stream-json --verbose --dangerously-skip-permissions` emite `system/init` com `session_id`, `assistant` com `content`, `result` com `usage` e `total_cost_usd`. Resume via `--resume <id>`. Interrupção via SIGTERM.
- **Codex**: `codex exec --json --skip-git-repo-check -C <cwd> "<prompt>"` emite `thread.started` + `item.completed` + `turn.completed`. Resume via `codex exec resume <thread_id> --json`. Necessário fechar `stdin` (`proc.stdin.end()`) para evitar `Reading additional input from stdin...`.
- **Opencode**: `opencode run --format json` — falha sem modelo válido (`ox-alpha-free is not supported`, `401`); precisa `--model` explícito e credenciais.
- **OMP**: `omp --mode rpc -p "<prompt>"` / `--resume` — NDJSON em stdout, requer `proc.stdin.end()`.

Parser normaliza para `AgentEvent` e preserva `raw`.
