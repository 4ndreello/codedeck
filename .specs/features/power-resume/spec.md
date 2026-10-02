# Power Resume Specification

## Problem Statement

Três lacunas na reconciliação após suspend e reboot, medidas no DB e nos logs reais (`~/.codedeck`) em 2026-10-01:

1. **Suspend vira `failed` falso.** O codex emite `{"type":"error","message":"Reconnecting... N/5 ..."}` como aviso de retry quando a rede some (lid-close, Wi-Fi caindo). `parseCodexLine` (`src/drivers/codex/parser.ts:166`) mapeia todo `type:"error"` para `session.failed`, e `synthesizeTerminalEvent` (`src/drivers/terminal.ts:21`) deixa de emitir o `completed` do exit 0 porque já houve terminal. As sessões `0408` e `d049` têm 4 frames de reconnect, `turn.completed` com o trabalho commitado e `status=failed` no DB. Na `0408`, o journal mostra `Lid closed. Suspending...` às 22:11:18Z, `System returned from sleep` às 22:33:02Z e o codex voltando a rodar tools às 22:33:14Z.
2. **Reboot nunca retoma.** São 74 eventos `SHUTDOWN` (todos SIGTERM) e nenhum `session.started` depois deles. A retomada existe (`send` → `codex exec resume <thread_id>`), mas é sempre manual.
3. **Nada sobe o daemon no login.** `ensureDaemonStarted` só roda quando algum comando `codedeck` é executado. O `doctor` confere `~/.config/systemd/user/codedeck.service`, mas nada no repo cria esse arquivo.

## Goals

- [x] Uma sessão codex que se recupera de reconnect termina `completed`, nunca `failed`
- [x] Com opt-in, sessões `run` interrompidas por shutdown recentemente recebem um turno de retomada no boot do daemon, sem comando manual
- [x] `codedeck service install` faz o daemon subir sozinho no login, no Linux com systemd de usuário

## Out of Scope

| Feature | Reason |
| ------- | ------ |
| Auto-resume ligado por padrão | Supersede parcial do "Auto-`send` no boot" de `daemon-power`: aqui é opt-in explícito, o default continua manual |
| Auto-resume de sessões `open` (interativas) | Sessão `open` não aceita turno headless (`CAPABILITY_NOT_SUPPORTED`) |
| Toggle no `codedeck setup` / web | A config é editada à mão nesta fase |
| LaunchAgent no macOS | `service install` é só Linux + systemd de usuário |
| Reparar no DB as sessões antigas `0408`/`d049` | Correção de dados, fica fora do código |
| Mudar parser de outros harnesses (claude, opencode, omp, antigravity) | Só o codex tem evidência medida |
| Detectar suspend/resume (D-Bus `PrepareForSleep`) | O suspend já preserva os processos, o problema era só o parser |

## Assumptions & Open Questions

| Decision | Chosen default | Rationale |
| -------- | -------------- | --------- |
| Frame `type:"error"` do codex | Vira um `AgentEvent` `error` não terminal; só `turn.failed`/`thread.failed` encerram | Em todos os logs reais, todo `error` fatal (usage limit, capacity, prompt flagged) vem seguido de `turn.failed`; os não fatais (reconnect, skill budget, WebSocket fallback) vêm seguidos de `turn.completed` |
| Config do auto-resume | `autoResume?: { enabled?: boolean; maxAgeHours?: number }` em `CodedeckConfig`, ausente = desligado, `maxAgeHours` default 24 | Opt-in decidido pelo usuário; a janela evita retomar as 66 sessões `interrupted` antigas |
| Elegibilidade | `status=interrupted`, `failure.code=SHUTDOWN`, `failure.retryable=true`, `origin!="open"`, `nativeSessionId` presente, driver com `resume:true`, sem processo vivo com a mesma identidade, interrompida há ≤ `maxAgeHours` | Mesmas guardas do `session.send` manual mais a janela |
| Prompt de retomada | Constante fixa em inglês: avisa que o turno anterior foi interrompido por um shutdown, pede inspeção de `git status`/`git diff` antes de agir e continuação da tarefa original | O turno morreu no meio; o worktree pode estar pela metade |
| Momento do auto-resume | Uma vez por boot do daemon, depois de `recover()` e com o socket ligado, pelo mesmo caminho de `runResumeTurn` sob `sessionLocks` | Reaproveita o resume-turn verificado de `daemon-power` P2 |
| Unit systemd | `~/.config/systemd/user/codedeck.service`, `ExecStart=<process.execPath> <dist/daemon/daemon.js resolvido> --daemon`, `Environment=PATH=<PATH no install>`, `KillMode=process`, `Restart=on-failure`, `WantedBy=default.target` | Sob systemd o PATH é mínimo e os harnesses (`~/.local/bin`) sumiriam; `KillMode=process` evita que um `restart` do serviço mate workers que caíram no cgroup do serviço |


**Open questions:** none. O usuário escolheu auto-resume opt-in (opção a) em 2026-10-01.
---

## User Stories

### P1: Reconnect do codex não falha a sessão ⭐ MVP

**Acceptance Criteria**:

1. WHEN o codex emite um frame `{"type":"error","message":...}` THEN `parseCodexLine` SHALL retornar um evento `error` com a mensagem e SHALL NOT retornar `session.failed` <!-- PRS-01 -->
2. WHEN o codex emite `turn.failed` ou `thread.failed` THEN `parseCodexLine` SHALL continuar retornando `session.failed` <!-- PRS-02 -->
3. WHEN um log codex contém frames de reconnect seguidos de `turn.completed` e o processo sai com código 0 THEN a sessão SHALL terminar com status `completed` <!-- PRS-03 -->
4. WHEN um log codex contém `error` seguido de `turn.failed` THEN a sessão SHALL terminar com status `failed` <!-- PRS-04 -->

### P2: Auto-resume opt-in no boot do daemon

**Acceptance Criteria**:

1. WHERE `autoResume.enabled` não é `true` o daemon SHALL NOT iniciar nenhum turno no boot <!-- PRS-05 -->
2. WHERE `autoResume.enabled` é `true`, WHEN o daemon inicia THEN ele SHALL iniciar exatamente um turno de retomada com o prompt fixo para cada sessão elegível <!-- PRS-06 -->
3. IF a sessão foi interrompida há mais de `maxAgeHours` THEN o daemon SHALL deixá-la `interrupted` sem iniciar turno <!-- PRS-07 -->
4. IF a sessão tem `origin="open"`, não tem `nativeSessionId`, tem `failure.code` diferente de `SHUTDOWN` ou o driver não tem `resume` THEN o daemon SHALL deixá-la intocada <!-- PRS-08 -->
5. IF o processo da sessão ainda está vivo com a mesma identidade THEN o daemon SHALL NOT iniciar turno <!-- PRS-09 -->
6. WHEN um turno de retomada falha ao iniciar THEN o daemon SHALL registrar o erro no daemon log e seguir para a próxima sessão sem derrubar o boot <!-- PRS-10 -->

### P3: Serviço systemd de usuário

**Acceptance Criteria**:

1. WHEN o usuário roda `codedeck service install` no Linux THEN o CLI SHALL escrever `~/.config/systemd/user/codedeck.service` com `ExecStart` absoluto para o node atual e o `dist/daemon/daemon.js` resolvido <!-- PRS-11 -->
2. WHEN a unit é escrita THEN ela SHALL conter `Environment=PATH=` com o PATH do processo que instalou <!-- PRS-12 -->
3. WHEN a unit é escrita THEN ela SHALL conter `KillMode=process` e `WantedBy=default.target` <!-- PRS-13 -->
4. WHEN a unit é escrita THEN o CLI SHALL rodar `systemctl --user daemon-reload` e `systemctl --user enable codedeck.service` e mostrar o resultado <!-- PRS-14 -->
5. WHEN o usuário roda `codedeck service uninstall` THEN o CLI SHALL rodar `systemctl --user disable codedeck.service` e remover a unit <!-- PRS-15 -->
6. IF a plataforma não é Linux ou `systemctl` não existe THEN o CLI SHALL sair com código 1 e mensagem clara, sem escrever arquivo <!-- PRS-16 -->
7. WHEN o usuário roda `codedeck doctor` depois do install THEN a seção Power SHALL mostrar `unit installed` (comportamento existente, sem mudança de código) <!-- PRS-17 -->

---

## Requirement Traceability

| ID | Story | Task | Status |
| -- | ----- | ---- | ------ |
| PRS-01 | P1 | T1 | Verified |
| PRS-02 | P1 | T1 | Verified |
| PRS-03 | P1 | T1 | Verified |
| PRS-04 | P1 | T1 | Verified |
| PRS-05 | P2 | T2 | Verified |
| PRS-06 | P2 | T2 | Verified |
| PRS-07 | P2 | T2 | Verified |
| PRS-08 | P2 | T2 | Verified |
| PRS-09 | P2 | T2 | Verified |
| PRS-10 | P2 | T2 | Verified |
| PRS-11 | P3 | T3 | Verified |
| PRS-12 | P3 | T3 | Verified |
| PRS-13 | P3 | T3 | Verified |
| PRS-14 | P3 | T3 | Verified |
| PRS-15 | P3 | T3 | Verified |
| PRS-16 | P3 | T3 | Verified |
| PRS-17 | P3 | T3 | Verified |
