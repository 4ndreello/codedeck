---
description: Continue this orchestrator session without human input and write a run report.
disable-model-invocation: true
---

# Autonomous mode

The user invokes `/autonomous` in an already running interactive orchestrator session. This mode is explicit and one-way for the rest of that session. It never activates at startup, through configuration, because a worker asks a question, or through any other automatic path.

After activation, the orchestrator follows this contract for the rest of the session.

## Never ask the human

The orchestrator must never ask the human a question, request a choice, wait for an answer, or stop because a human answer is unavailable. If the orchestrator or a worker would need to ask the human for input, that work is blocked.

The orchestrator and its workers decide and log reversible choices or defer blocked work. A worker's question is evidence of a blocker, not permission to ask the human.

## Decision rubric

Use this as a heuristic, not a guarantee: can the decision be undone with `git revert`? A revert does not undo dependency installation, network fetches, transitive code execution, shared-state changes, or external side effects.

1. Bucket 1 covers reversible and cheap decisions that may be made immediately. This includes naming a candidate library in notes or prose, choosing a name, writing a test, refactoring, creating a file, and editing code. Record the assumption in the running notes and final report. Installing, fetching, or vendoring a dependency is not bucket 1. Treat it as bucket 2, including the lockfile change, network fetch, and transitive code execution.
2. Bucket 2 covers irreversible or destructive actions. The orchestrator and workers must never take them without the human. This includes deleting data, deleting untracked files, `git clean`, `git reset --hard`, force-pushing an already-shared branch, publishing or sharing commits, touching production, sending network writes or other external side-effecting calls, spending money, applying a migration to a shared database, and installing, fetching, or vendoring a dependency. Defer the action and record it in the report. Do not ask for permission.
3. An ambiguous product decision that genuinely matters is deferred as a pending question. Record the question, then route around it by doing independent work that does not depend on the answer.

The rubric governs the orchestrator's decisions. A worker's question is evidence of a blocker, not permission to ask the human.

For this MVP, naming a candidate library in notes or prose is bucket 1. Installing, fetching, or vendoring that library is bucket 2.

## Route around blockers

When a task is deferred or blocked, the orchestrator records the reason, keeps a running notes entry, and continues dispatching or doing every independent task. Independent means the task needs no output, file, or decision from the deferred or blocked item. When in doubt, list it as deferred rather than dispatch it. One blocker must not halt the whole run. Work that depends on the deferred decision remains listed as deferred.

## Report and notes

Use these repository paths for an autonomous run. `<slug>` is the feature slug from the active work item, lowercased with every run of non-alphanumeric characters replaced by one hyphen and leading or trailing hyphens removed. If the work item has no feature slug, use `autonomous-mode`.

The orchestrator cannot write files itself. On activation, the orchestrator dispatches a worker to create the slug directory, `run-notes.md`, and `run-report.md` immediately. No note-taking is valid before they exist.

- Running notes: `.specs/features/<slug>/run-notes.md`. This file is append-only per run and is never rewritten.
- Final report: `.specs/features/<slug>/run-report.md`. It must be self-contained. Do not write `see run-notes.md`; fold the notes into the report as content.

An assumption note is an append-only entry in `run-notes.md` carrying time-or-sequence, decision, category (bucket), and reason. Blocker entries also record the independent work taken around the blocker. At the end, fold the notes into `run-report.md` rather than leaving the report dependent on a separate log.

The final report lives at `.specs/features/<slug>/run-report.md`, is self-contained, contains the five sections below in this order, and uses the `Done` link formats or the links-unavailable fallback below.

1. `Done`, including commit and branch links.
2. `Assumptions I made`, covering reversible calls recorded during the run.
3. `Deferred / waiting for you`, covering irreversible actions and pending product questions.
4. `Blocked / failed`, covering failed work, blocked workers, and reasons.
5. `Not covered`, covering work left out of the run and why.

The `Done` section derives the branch by running `git branch --show-current` and the commit by running `git rev-parse HEAD`. With a web remote, it includes these Markdown links:

- Branch: `[<branch-name>](<remote>/tree/<branch-name>)`
- Commit: `[<full-sha>](<remote>/commit/<full-sha>)`

Without a web remote, it includes the exact branch name and full commit SHA and states that links are unavailable.
