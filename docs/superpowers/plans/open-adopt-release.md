# Implementation Plan: Open Adopt/Release Lifecycle (Head Session Tracking)

- **Date**: 2026-09-07
- **Spec Reference**: [`docs/superpowers/specs/open-adopt-release.md`](file:///home/andreello/dev/codedeck/docs/superpowers/specs/open-adopt-release.md)
- **Status**: Approved (Remediated after Architectural Review)

---

## 1. Overview & Architecture

Este plano implementa o rastreamento da sessão orquestradora/cabeça criada por `codedeck open` através do ciclo **adopt/patch/release** (Ciclo A):
- **`session.adopt`**: Pré-spawn; aloca ID canônico curto (4 hex), valida agente na registry, grava `runId = id`, `origin = "open"`, status `working`.
- **`session.patch`**: Pós-spawn imediato via gancho `onSpawn` em `spawnHarness` e `launchClaude`; persiste `child.pid`, `pidStartTime` e worktree.
- **`session.release`**: No fechamento da TUI (`onClose`); transiciona para `completed` se ativo (ou `failed` se abortado pré-spawn), no-op se já terminal (`stopped`), persiste `nativeSessionId`.
- **`recover()`**: Reconciliação no boot: se `origin = "open"`, bloco autocontido que nunca cai no fallback de workers (`orphaned`); se PID vivo, mantém `working` sem `driver.attach`; se PID morto, marca `completed`.
- **`session.stop`**: Executa `killTree` na cabeça sem afetar workers com o mesmo `runId`.
- **`session.send`**: Rejeita com `CAPABILITY_NOT_SUPPORTED` em sessões com `origin = "open"`.

---

## 2. Phase 1: Database Schema & Entity Mapping

### 2.1 Schema Migration in `src/store/database.ts`
- **What**: Adicionar coluna `origin TEXT` à tabela `sessions` tanto no `CREATE TABLE IF NOT EXISTS` quanto em `addMissingColumns()`.
- **Details**:
  - Em `CREATE TABLE IF NOT EXISTS sessions`: adicionar `origin TEXT` ao DDL inicial.
  - Em `addMissingColumns()`:
    ```typescript
    const additions: Array<[string, string]> = [
      // ...
      ["origin", "TEXT"],
    ];
    ```
- **Files**:
  - `src/store/database.ts`

### 2.2 Core Types in `src/core/session.ts`
- **What**: Atualizar interface `Session` com campo opcional `origin`.
- **Details**:
  ```typescript
  export interface Session {
    // ...
    origin?: "open" | "run" | string | null;
  }
  ```
- **Files**:
  - `src/core/session.ts`

### 2.3 Store Operations in `src/store/sessions.ts`
- **What**: Mapear `origin` em `SessionRow` e operações do store.
- **Details**:
  - Em `SessionRow`: adicionar `origin: string | null;`.
  - Em `rowToSession`: `origin: (row.origin as Session["origin"]) ?? undefined`.
  - Em `SessionStore.create`: persistir `session.origin ?? null` na coluna `origin`.
  - Em `SessionStore.update`: mapear `patch.origin` em `map.origin`.
- **Files**:
  - `src/store/sessions.ts`

---

## 3. Phase 2: Daemon IPC Protocol & Handlers

### 3.1 Protocol Definitions in `src/daemon/protocol.ts`
- **What**: Declarar novos métodos, interfaces de requisição e tipos de resultado tipados.
- **Details**:
  - Adicionar `"session.adopt" | "session.patch" | "session.release"` a `RequestMethod`.
  - Adicionar interfaces de requisição:
    ```typescript
    export interface AdoptSessionRequest {
      method: "session.adopt";
      params: {
        role: string;
        agent: AgentId;
        model?: string;
        cwd: string;
        worktree?: string;
        branch?: string;
        baseCommit?: string;
      };
    }

    export interface PatchSessionRequest {
      method: "session.patch";
      params: {
        id: string;
        pid?: number;
        pidStartTime?: string;
        worktree?: string;
        branch?: string;
        baseCommit?: string;
        cwd?: string;
      };
    }

    export interface ReleaseSessionRequest {
      method: "session.release";
      params: {
        id: string;
        nativeSessionId?: string;
        status?: "completed" | "failed";
        error?: string;
      };
    }
    ```
  - Adicionar interfaces de resultado:
    ```typescript
    export interface SessionAdoptResult {
      session: Session;
    }

    export interface SessionPatchResult {
      ok: boolean;
      session?: Session;
    }

    export interface SessionReleaseResult {
      ok: boolean;
    }
    ```
  - Atualizar união `RequestParams`.
- **Files**:
  - `src/daemon/protocol.ts`

### 3.2 Daemon Handlers in `src/daemon/daemon.ts`
- **What**: Implementar os métodos no switch `handleRequest`.
- **Details**:
  - **`session.adopt`**:
    1. Validar agente: `if (!this.registry.has(p.agent)) { send({ error: { code: "AGENT_NOT_FOUND", message: "Unknown agent " + p.agent } }); return; }`.
    2. Gerar ID com `generateSessionId()`. Loop anti-colisão `while (this.sessions.get(sessionId))`.
    3. Montar objeto `Session`:
       - `id: sessionId`
       - `runId: sessionId`
       - `origin: "open"`
       - `status: "working"`
       - `name: p.role`
       - `agent: p.agent`
       - `model: p.model`
       - `cwd: p.cwd`
       - `worktree: p.worktree`
       - `branch: p.branch`
       - `baseCommit: p.baseCommit`
       - `createdAt: now`, `updatedAt: now`
    4. `this.sessions.create(session)`.
    5. Responder `{ result: { session } }`. (Zero chamada a driver, zero tailer).
  - **`session.patch`**:
    1. Buscar sessão por `p.id`. Se não encontrada, erro `SESSION_NOT_FOUND`.
    2. Se `p.pid` existir e `p.pidStartTime` for omitido, auto-resolver via `processStartTime(p.pid)`.
    3. Chamar `this.sessions.update(p.id, { pid: p.pid, pidStartTime: ..., worktree: p.worktree, branch: p.branch, baseCommit: p.baseCommit, cwd: p.cwd })`.
    4. Responder `{ result: { ok: true, session: this.sessions.get(p.id) } }`.
  - **`session.release`**:
    1. Buscar sessão por `p.id`. Se não encontrada, erro `SESSION_NOT_FOUND`.
    2. Se `isTerminalStatus(s.status)` (`stopped`, `completed`, `failed`, `interrupted`): responder `{ result: { ok: true } }` (no-op para preservar `stopped` de um `codedeck stop` prévio).
    3. Se ativa (`working`):
       - Se `p.status === "failed"`:
         - `this.sessions.setStatus(p.id, "failed", { lastEvent: p.error || "pre-spawn setup failed" })`.
         - Emitir evento `session.failed`.
       - Caso contrário (padrão `"completed"`):
         - `this.sessions.setStatus(p.id, "completed", { lastEvent: "completed", ...(p.nativeSessionId ? { nativeSessionId: p.nativeSessionId } : {}) })`.
         - Append de evento `session.completed` (`reason: "completed"`).
         - Broadcast do evento terminal.
       - Responder `{ result: { ok: true } }`.
  - **`session.send`**:
    - Adicionar verificação inicial:
      ```typescript
      if (s.origin === "open") {
        send({ error: { code: "CAPABILITY_NOT_SUPPORTED", message: "Interactive open sessions do not support send" } });
        return;
      }
      ```
- **Files**:
  - `src/daemon/daemon.ts`

### 3.3 Boot Reconciliation in `daemon.recover()`
- **What**: Implementar reconciliação do Ciclo A para `origin = "open"` de forma autocontida para evitar fallthrough para `orphaned`.
- **Details**:
  - No loop `for (const s of actives)` de `recover()`:
    ```typescript
    if (s.origin === "open") {
      if (pid == null) {
        this.sessions.setStatus(s.id, "failed", { lastEvent: "session never launched" });
      } else if (!processPresent) {
        this.sessions.setStatus(s.id, "completed", { lastEvent: "process exited" });
      } else if (pidReused) {
        // Já tratado pelo bloco de pidReused acima (continua no continue)
      } else if (identityVerified) {
        // PID vivo e verificado -> continua working, não faz attach
      } else {
        this.sessions.setStatus(s.id, "failed", { lastEvent: "process alive but identity unverified" });
      }
      continue;
    }
    ```
- **Files**:
  - `src/daemon/daemon.ts`

---

## 4. Phase 3: Runtime & CLI Integration

### 4.1 Runtime Enhancements in `src/open/runtime.ts`
- **What**: Adicionar callback `onSpawn` a `SpawnHarnessOptions` e fazer `finishOpenSession` retornar o `nativeSessionId`.
- **Details**:
  - Em `SpawnHarnessOptions`:
    ```typescript
    onSpawn?: (child: ChildProcess) => void | Promise<void>;
    ```
  - Em `spawnHarness`: logo após `child = spawnChild(...)` ou `child = pty.child`:
    ```typescript
    if (opts.onSpawn) {
      try {
        void Promise.resolve(opts.onSpawn(child)).catch(() => {});
      } catch {}
    }
    ```
  - Em `finishOpenSession`:
    ```typescript
    export function finishOpenSession(
      role: Role,
      sessionFile: string,
      write: (text: string) => void = writeStdoutSync,
      stdoutIsTty: boolean = process.stdout.isTTY === true,
    ): string | undefined {
      try {
        const id = takeSessionId(sessionFile);
        if (resumeHint(role, id) !== undefined && stdoutIsTty) write(CLAUDE_RESUME_ERASE);
        write(renderExit(role, id));
        return id;
      } catch {
        return undefined;
      }
    }
    ```
    *Dessa forma, o arquivo de sessão é lido e removido uma única vez, o banner de saída mantém o hint de resume intacto, e o ID é retornado para ser enviado no release.*
- **Files**:
  - `src/open/runtime.ts`

### 4.2 Forwarding in `src/cli/commands/open.ts`
- **What**: Atualizar assinatura de `launchClaude`, substituir o UUID pelo ID curto do daemon, gerenciar `onSpawn`/`onClose` com resolução ordenada de promises e captura de falhas pré-spawn.
- **Details**:
  - Adicionar `onSpawn?: (child: ChildProcess) => void | Promise<void>` como argumento opcional em `launchClaude` e repassá-lo a `spawnHarness`.
  - No corpo de `registerOpenCommand`:
    - Chamar `session.adopt` antes do spawn:
      ```typescript
      const adoptRes = await client.request<{ session: Session }>("session.adopt", {
        role,
        agent: launcher,
        model: passthroughModel ?? boundModel,
        cwd,
      });
      const session = adoptRes.session;
      const runId = session.id;
      ```
    - Envolver toda a fase pré-spawn e execução em `try ... catch`:
      ```typescript
      let patchPromise: Promise<unknown> | undefined;
      let spawned = false;
      try {
        // se opts.worktree: criar worktree com sessionId = runId
        // ...
        // no onClose:
        const onClose = async () => {
          if (patchPromise) {
            try { await patchPromise; } catch {}
          }
          const nativeId = finishOpenSession(role, sessionFile);
          try {
            await client.request("session.release", { id: runId, nativeSessionId: nativeId });
          } catch {}
        };
        // no onSpawn:
        const onSpawn = (child: ChildProcess) => {
          spawned = true;
          const pid = child.pid;
          const pidStartTime = pid ? processStartTime(pid) : undefined;
          patchPromise = client.request("session.patch", {
            id: runId,
            pid,
            pidStartTime,
            ...(wt ? { worktree: wt.path, branch: wt.branch, baseCommit: wt.baseCommit, cwd: openCwd } : {}),
          });
        };
        // invocar launcher (opencode via spawnHarness ou claude via launchClaude) passando onSpawn e onClose
      } catch (err) {
        if (!spawned) {
          try {
            await client.request("session.release", {
              id: runId,
              status: "failed",
              error: err instanceof Error ? err.message : String(err),
            });
          } catch {}
        }
        throw err;
      }
      ```
- **Files**:
  - `src/cli/commands/open.ts`

---

## 5. Phase 4: Test Suite & Harness Fixes

### 5.1 Test Harness Update in `tests/helpers/open-harness.ts`
- **What**: Mockar `IpcClient.prototype.request` para responder chamadas de adopt, patch e release sem tentar abrir conexões socket reais.
- **Details**:
  - Em `setupOpenHarness`:
    ```typescript
    vi.spyOn(IpcClient.prototype, "request").mockImplementation(async (method: string, params: any) => {
      if (method === "session.adopt") {
        return {
          session: {
            id: "a83f",
            runId: "a83f",
            origin: "open",
            status: "working",
            name: params?.role || "orchestrator",
            agent: params?.agent || "opencode",
            cwd: params?.cwd || process.cwd(),
          },
        } as never;
      }
      return { ok: true } as never;
    });
    ```
- **Files**:
  - `tests/helpers/open-harness.ts`

### 5.2 Unit / Daemon Tests (`tests/session-adopt.test.ts`)
- **What**: Criar nova suíte cobrindo todos os fluxos de adopt, patch, release e recover.
- **Test cases**:
  1. `session.adopt`:
     - Cria sessão com `origin = "open"`, `status = "working"`, `runId = session.id`.
     - Rejeita agente desconhecido com `AGENT_NOT_FOUND`.
     - Não cria driver runtime nem dispara tailer.
  2. `session.patch`:
     - Atualiza `pid`, `pidStartTime`, `worktree` e `cwd`.
     - Auto-detecta `pidStartTime` no Linux se omitido.
  3. `session.release`:
     - Sessão ativa transiciona para `completed` e emite evento terminal `session.completed`.
     - Sessão com `status: "failed"` transiciona para `failed` com erro registrado.
     - Sessão com status terminal prévio (`stopped`) permanece `stopped` (idempotência no-op).
     - Persiste `nativeSessionId` se fornecido.
  4. `session.send`:
     - Rejeita com `CAPABILITY_NOT_SUPPORTED` em sessão `origin = "open"`.
  5. `session.stop`:
     - Mata PID via `killTree`, marca `stopped`.
     - Workers criados com mesmo `runId` continuam em `working`.
  6. `daemon.recover`:
     - PID vivo com identidade preservada: continua `working` sem reatachar driver.
     - PID morto: transiciona para `completed` (Ciclo A).
     - PID reciclado: transiciona para `failed` (`pid_reused`).
     - PID ausente (`pid == null`): transiciona para `failed` ("session never launched").
  7. `usage.get`:
     - Agrupa a cabeça e workers com o mesmo `runId`. Cabeça entra com custo inicial zero.
- **Files**:
  - `tests/session-adopt.test.ts` (novo)

### 5.3 CLI Integration Tests (`tests/open-action.test.ts` & `tests/open-args.test.ts`)
- **What**: Validar a sequência do CLI e passagem de argumentos.
- **Test cases**:
  - `open` chama `session.adopt` antes de `spawnHarness`.
  - `CODEDECK_RUN_ID` recebe o ID curto gerado pelo daemon.
  - `onSpawn` dispara `session.patch` com o `child.pid`.
  - `onClose` dispara `session.release` preservando o resume hint.
  - Falha de worktree pré-spawn invoca `session.release` com `status = "failed"`.
- **Files**:
  - `tests/open-action.test.ts`
  - `tests/open-args.test.ts`

---

## 6. Verification Checklist & Gate Checks

1. `npx vitest run tests/session-adopt.test.ts`
2. `npx vitest run tests/open-action.test.ts`
3. `npx vitest run tests/open-args.test.ts`
4. `npm run test` (suite completa do repositório)
5. `npm run build` (tsc / typecheck estrito limpo)
