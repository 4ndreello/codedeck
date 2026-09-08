# Send queue (one-slot pending message)

## Goal

Let the user type the next message while a headless session is still
working, instead of waiting staring at "aguarde o turno atual terminar".
The message waits in one visible slot and auto-dispatches as the next
turn when the current turn ends. Interactive sessions (`origin=open`)
stay out of scope: the daemon has no wire to their PTY.

## Current behavior (evidence, corrected per review)

- Headless `send` is a new process, not stdin: `SessionDriver.send()`
  (`src/drivers/session-driver.ts:126`) calls `start({ resumeSessionId,
  prompt })`, appending to the same log files. Native id resolves as
  `session.nativeSessionId || runtime.nativeSessionId` — dispatch must
  use the same resolution, not require the column alone.
- Between-turn state is terminal, not idle: every harness ends a turn
  with terminal `session.completed`, and `session.send`
  (`src/daemon/daemon.ts:560-605`) has NO terminal rejection — the
  non-`interrupted` branch only returns `SESSION_BUSY` (lock held,
  `starting`, `working`+live pid, runtime not done/drained) or
  `CAPABILITY_NOT_SUPPORTED`, otherwise it resumes. Canvas agrees:
  `paintSendState()` (`src/web/canvas-page.ts:862`) enables send on
  `completed`. So "resumable terminal" IS today's success path.
- The daemon never sets `idle`/`needs_input`: `updateSessionFromEvent`
  only sets `completed`/`failed`; `needs_input` is canvas-local
  (set on `permission.requested` in `canvas-page.ts:570`). A
  permission-parked turn still has a live runtime → counts as busy,
  dispatches only at stream end, never on `permission.resolved`.
- Restart states (`recover()`, `daemon.ts:145-290`): `working` reattaches
  (tail dispatch covers it); dead/pid-reused rows become
  `failed`/`orphaned`; `interrupted` rows are skipped via `continue`.
  There is no "idle-but-queued" state after boot.
- Web mirrors busy: `paintSendState()` disables input on
  `working/starting` and on `origin=open` always.
- `interrupted` is terminal (`src/core/session.ts:87`), produced only by
  `markInterrupted()` (`src/daemon/daemon.ts:1300`). Archiving it
  (`session.release`, `daemon.ts:483`) is a separate, smaller change and
  explicitly out of scope here.

## Design

### Slot

- One slot per session: `pendingMessage: string | null` + `pendingAt: string | null`.
- Persisted in SQLite, not in-memory: the queue must survive a daemon
  restart and be visible in `session.get`. Four touch points, all required:
  1. `CREATE TABLE` column list in `src/store/database.ts`,
  2. `addMissingColumns()` in the same file (existing installs throw
     "no such column" without it),
  3. explicit `INSERT` column list in `SessionStore.create()`,
  4. column map in `SessionStore.update()` + `rowToSession()`
  (`src/store/sessions.ts`).
- Single slot, last-wins: a second `send` while the slot is occupied
  overwrites. Rationale: no unbounded growth, no stuck queue behind a
  stale message, no concat-runaway prompts. The overwrite is observable
  (new `pendingAt`, new queued event).

### Admission (`session.send`, `src/daemon/daemon.ts:560`)

Precedence (first match wins):

1. Empty message → validation error (new daemon contract, see below).
   Checked before origin so the error is stable regardless of session kind.
2. `origin === "open"` → `CAPABILITY_NOT_SUPPORTED`, never queued.
3. `interrupted` with live PID identity (triple
   `pid && pidStartTime && processAlive && processStartTime equal`, same
   as the `stop` path) → `SESSION_BUSY` (stop first), not queued.
4. Busy (today's `SESSION_BUSY` conditions: lock held, `starting`,
   `working`+live identity, runtime not done/drained — permission-parked
   included) → enqueue (see locking), return `{ ok: true, queued: true }`.
   No `turn.started`, no status change, no driver call.
5. Otherwise (resumable: terminal `completed`/`failed`/`stopped`/`orphaned`,
   or `interrupted` without live identity, with `resume` capable driver) →
   start now. If the slot is occupied (stale leftover), the new message
   wins: it starts now and the slot is cleared. Returns
   `{ ok: true, queued: false }`.

Enqueue runs under `sessionLocks`: acquire the session lock around
busy-check + slot persist + queued-event append (same bounded discipline
as `markInterrupted`), otherwise a message landing between dispatch's
slot read and clear is stranded or silently destroyed. Double-enqueue
stays safe (last-wins); event order follows lock order.

### Dispatch (`tryDispatch`)

- One function owns starting a queued turn; two call sites:
  1. tail of `attachDriverEvents()` (`daemon.ts:1054`) when the stream
     ends with the session back in a resumable state (turn completed,
     or failed — a queued message retries as the next turn);
  2. `recover()` post-restart for rows that actually exist with a
     surviving slot: reattached-`working` is covered by (1); for
     `failed`/`orphaned`-with-pending the boot site dispatches only
     under an explicit policy (see acceptance). No `send`-fast-path
     call (it already started a turn).
- Dispatch precondition (rechecked under `sessionLocks`): slot non-empty,
  lock free, not `starting`, no live runtime (`done && drained`), no live
  PID identity per the triple above (never `processAlive` alone — a
  recycled PID must not block or permit), `origin !== "open"`, driver
  `resume` capable, native id resolvable per
  `session.nativeSessionId || runtime.nativeSessionId`. Permission-parked
  (live runtime) counts as busy. If unmet, the slot stays; nothing is lost.
- Dispatch reuses the existing send body factored out, with one change:
  failure handling. There is no IPC caller at tail/boot, so a dispatch
  failure (including stale native id → `SessionDriver.send` resume throw,
  or a crash between clear and `turn.started`) must NOT vanish the
  message: restore the slot and append + broadcast a dispatch-failed event
  (keeping the failure classification honest) instead of `SEND_FAILED`-to-nobody.
- Clearing policy: `session.stop` and `session.release` clear the slot on
  ALL exits including error/early-return paths (`SESSION_BUSY`,
  `SESSION_NOT_RUNNING`, `STOP_UNSAFE`, release's terminal early return),
  otherwise a phantom "1 na fila" survives with no tail left to consume
  it. Daemon shutdown (`markInterrupted`) keeps it by design.

### Validation (new daemon contract)

- `parseSendBody` (`src/cli/commands/web.ts:63`) only trims/rejects
  empty; the 64 KiB cap is `MAX_SEND_BODY_BYTES` on raw body bytes at the
  route (`web.ts:60,149-170`). The daemon and `codedeck send` validate
  nothing today.
- This spec adds daemon-side validation with a named error code, units
  (chars vs bytes — bytes, to match the route), and web/CLI status
  mapping. Precedence: empty → validation error even for `origin=open`
  (documented flip from `CAPABILITY_NOT_SUPPORTED`); oversize → same
  rejection idle or busy (never queued).

### Events and reads

- Enqueue appends + broadcasts a queued event. `AgentEventType`
  (`src/core/events.ts:4-18`) is a closed union and the canvas
  (`selectSession` transcript branches, `onEvent` live handler) plus
  `updateSessionFromEvent` silently drop unknown types — so adding
  `message.queued` REQUIRES explicit branches in all three (transcript
  render "você (na fila)", live handler, `lastEvent` update) or the
  render claim is dropped and only `pendingMessage`-in-`get` drives the
  "na fila" display. `EventStore.append` itself is type-agnostic, so
  persistence works either way. Dispatch emits the normal `turn.started`.
- `session.get` / `session.logs` expose `pendingMessage` (or preview) +
  `pendingAt` so the canvas and `ps` can show "1 na fila" without a new
  round trip.

### Surfaces

- Web (`src/web/canvas-page.ts`): input stays enabled while
  `working/starting` for non-`open` sessions; disabled only for
  `origin=open` and while `sendInFlight`. Helper text: "mensagem na fila
  — envia quando o turno terminar" after a queued send; detail shows the
  queued text until dispatch. `POST /send` maps `queued:true` to 200 with
  `{ ok, queued }`, preserving existing error codes otherwise, plus the
  new validation code mapping.
- CLI (`codedeck send`): prints `queued — sends when the current turn
  ends` vs `sent` today. `--json` passes `queued` through.

## Acceptance criteria

- Send while `working` returns `{ queued: true }`, changes no status,
  emits the queued event, and the message appears as pending in `get`.
- When the turn ends (completed or failed), the pending message starts
  exactly one new turn with the normal `turn.started` flow; no duplicate
  turns under overlapping completions (lock-guarded dispatch AND enqueue).
- Second send while occupied overwrites: one queued event per send, one
  pending message, newest text wins.
- `stop`/`release` cancel pending on every exit path (slot empty after,
  no phantom "na fila"); shutdown keeps it (slot present after restart).
- Boot policy (explicit): reattached-`working`-with-pending dispatches via
  the normal tail; `failed`/`orphaned`/`interrupted`-with-pending do NOT
  auto-spend tokens on boot — the slot stays visible and the next manual
  `send` (admission rule 5) or an explicit opt-in resumes it. If product
  wants boot auto-dispatch for terminal-with-pending, state it here; it
  is new token-spending behavior, not a bug fix.
- `origin=open` never queues under any status; error stays
  `CAPABILITY_NOT_SUPPORTED` (except empty message → validation error
  per precedence).
- Oversize/empty messages are rejected the same way whether the session
  is busy or resumable; nothing oversize is ever queued.
- Dispatch failure restores the slot + emits a dispatch-failed event;
  no silent pending-vanish, no double-send after crash.

## Out of scope

- Interrupting the live turn to send now (`send --interrupt`); this spec
  never kills a running harness.
- PTY/stdin injection into headless sessions; no per-session pty, no log
  format change, parsers untouched.
- Archiving `interrupted` sessions (`release` in canvas/CLI); tracked
  separately.
- Multi-message FIFO, priorities, per-run queues (overwrite covers edit).

## Risks

- Dispatch races overlapping stream tails → hold `sessionLocks` across
  check-clear-start AND busy-check-enqueue; the existing terminal-frame
  discard under lock (`daemon.ts:1059`) is the pattern to follow.
- Failed-turn auto-dispatch could loop user-visible retries → acceptable:
  one queued message yields at most one extra turn, then the slot is empty.
- Stale `nativeSessionId` at dispatch → slot restored + dispatch-failed
  event, never silent loss.
