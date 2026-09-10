---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS, not the current workspace. Name it `handoff-<topic-slug>.md` so it sorts next to its subject.

When the work ran through codedeck, anchor the handoff on the CodeDeck session: record the session id plus `codedeck show <id> --json` (status, harness, model, branch, worktree path, base commit) and `codedeck diff <id> --stat` (what actually changed). A success message is a claim, the diff is the fact: record the stat, never the claim alone. When the next session continues failed or interrupted work, carry the failure code and the last relevant lines from `codedeck logs <id>`.

Include a "suggested skills" section naming which skills the next agent should load, and a "suggested role" line (`general`, `orchestrator`, `auditor`, `reviewer`) when the continuation runs through `codedeck run --role`.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact secrets (API keys, passwords, tokens) and personal data before writing.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
