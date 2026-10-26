# Grok harness

## Problem Statement

CodeDeck starts Claude, Codex, OpenCode, OMP and Antigravity, then normalizes their streams into one session. Grok Build is another local harness with a headless JSON mode, and a role cannot be bound to it. `codedeck run --agent grok` is rejected before anything spawns.

## Out of Scope

- `codedeck open` does not launch the Grok TUI. That path needs a probed pty contract. OMP and Antigravity are in the same position.
- No Grok plugin, theme, or typed `/rename`.
- Codex sandbox and `--fast` stay on the harnesses that already implement them.

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale |
| --- | --- | --- |
| Headless wire format | streaming-messages-json | Same Messages stream the Claude parser already consumes, and session_id arrives on the first line |
| Unattended permissions | --always-approve | run is unattended, the same reason Claude gets --dangerously-skip-permissions |
| Prompt fidelity | --verbatim | Role prose must reach the model unchanged |

Open questions: none

## User Stories

### GH-01: Run a Grok session

**Acceptance Criteria**

1. WHEN the user passes `--agent grok` and Grok is on PATH, the system SHALL spawn `grok` with `--output-format streaming-messages-json`, `--always-approve` and `--verbatim`.
2. WHEN a model or effort is set, the system SHALL forward them as `--model` and `--reasoning-effort`.
3. WHEN a native session id is known, the system SHALL resume with `--resume` and that id.
4. WHEN the prompt starts with a dash, the system SHALL pass it as `--single=<prompt>` so the CLI does not read it as a flag.

### GH-02: Normalize the stream

**Acceptance Criteria**

1. WHEN the stream emits a system init line, the system SHALL record session.started and the native session_id.
2. WHEN the stream emits assistant text or a tool_use block, the system SHALL emit message, text.delta and tool.started.
3. WHEN the stream emits a tool_result, the system SHALL emit tool.completed.
4. WHEN the stream emits a successful result, the system SHALL emit usage.updated and session.completed.
5. WHEN the stream emits a result whose subtype starts with error, the system SHALL emit session.failed.

### GH-03: Offer Grok in setup

**Acceptance Criteria**

1. The system SHALL accept grok as an agent id in config, run --agent, and the setup harness list.
2. WHEN `grok models` prints a model list, the system SHALL return those ids and mark the default row.
3. WHEN Grok is missing from PATH, the system SHALL report it not installed and SHALL NOT throw from detection.

## Requirement Traceability

| ID | Story | Status |
| --- | --- | --- |
| GH-01 | Run a Grok session | verified |
| GH-02 | Normalize the stream | verified |
| GH-03 | Offer Grok in setup | verified |
