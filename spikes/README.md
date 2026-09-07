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

---

## Spike PTY: renomear a sessão do Claude Code pelo 1º prompt

`spikes/pty-rename.ts` + `spikes/pty-shim.mjs` + `spikes/pty-probe.mjs` + `spikes/pty-harness.py`

Rodar:

```bash
python3 spikes/pty-harness.py                       # self-test (7 checks)
node --experimental-strip-types spikes/pty-rename.ts -- claude -n "…"   # uso como wrapper
```

### Por que um PTY

Levantado no binário do Claude Code 2.1.263:

- `-n/--name` grava o **custom title** da sessão, que é o campo listado no app.
- O auto-título por Haiku a partir do 1º prompt existe (`generateSessionTitle` →
  `saveAiGeneratedTitle` → `adoptLocalAiTitle`, que empurra o nome novo pro bridge do
  Remote Control), mas só roda com
  `!disabled && !sessionTitle && !aiSessionTitle && !agentTitle` — o nosso `-n` **e** o
  nosso `--agent` bloqueiam, cada um sozinho.
- `rename_session` existe como control request, mas só entra por stdin em modo SDK
  (`--input-format stream-json`) ou pelo bridge com assinatura de dispositivo
  (`DROPPING unverified control_request` para o resto).
- O título persiste no transcript (`{"type":"custom-title","customTitle":…}`), porém o
  leitor fica em `restoreSessionMetadata`/`reAppendSessionMetadata`, que roda em re-stamp
  (start/resume/compactação) — não é watcher, então append externo não muda o título ao vivo.

Sobra o caminho oficial: **digitar `/rename` pelo usuário**, o que exige que o
`codedeck open` seja dono do PTY.

### Desenho validado (sem dependência nativa)

```
terminal real ──raw──> codedeck open ──pipe──> script ──> pty ──> pty-shim ──> claude
                            │                                        ▲
                            └── socket unix (resize) ─────────────────┘
```

- **`script`** é o alocador de PTY (util-linux: `script -qefc "<cmd>" /dev/null`; BSD:
  `script -q /dev/null /bin/sh -c "<cmd>"`). O stdin dele é um **pipe**, e é por esse pipe
  que a injeção do `/rename` entra — do ponto de vista do Claude, foi digitado.
- **`pty-shim.mjs`** roda dentro do PTY porque `script` só dimensiona o PTY quando o
  próprio stdin dele é um terminal: com pipe, o PTY nasce **`0 0`** (medido). Node não expõe
  ioctl, então o shim aplica `stty rows/cols` — no boot e a cada resize que o pai manda pelo
  socket. Escrever o tamanho no slave é o que faz o kernel levantar SIGWINCH no grupo de
  foreground, então a TUI redesenha sem saber que o shim existe.
- O gatilho reaproveita o que já existe: `plugin/hooks/session-name.sh` grava o slug do 1º
  prompt em `<sessionFile>.<id>.name`; o wrapper observa esse arquivo e digita
  `/rename <slug>` uma vez. O momento é o ideal — o prompt acabou de ser submetido, a caixa
  de input está vazia.

### Medido em 07/09/2026 (Linux, util-linux 2.39.3, node 22.22)

7/7 no self-test: harness vê `isTTY`; PTY nasce com o tamanho real (137x41); resize do
terminal chega na TUI (100x30); injeção direta chega como digitação; injeção disparada pelo
sidecar chega; Ctrl+C chega cru (byte 0x03) para uma TUI em raw mode; exit code atravessa
`script` + shim (7). Em modo passthrough (`stdout` inherit): `stty size`/`tput` corretos,
ANSI intacto, exit code preservado.

### Pendências antes de mexer no `open`

- Rodar contra o `claude` de verdade: um `/rename` injetado **durante** um turno é
  enfileirado pela TUI; confirmar que ele executa como comando ao fim do turno e não vira
  prompt.
- macOS: a sintaxe BSD do `script` está no código mas não foi executada aqui; confirmar
  também se o exit status do filho volta (no util-linux é o `-e`).
- Windows não tem `script`: o wrapper precisa cair no comportamento atual (`stdio: inherit`,
  sem rename).
- Saída não-raw sai com `\r\r\n` (ONLCR aplicado no PTY interno e de novo no terminal) —
  inofensivo, mas é o mesmo artefato de qualquer uso de `script`.
- Definir o texto do nome: hoje o hook grava slug (`corrigir-auth-do-login`); para o app um
  título mais legível seria melhor.
