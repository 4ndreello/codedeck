import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultCommandPath = join(root, "plugin", "commands", "autonomous.md");

function commandSource(): string {
  expect(existsSync(defaultCommandPath), `${defaultCommandPath} must exist`).toBe(true);
  return readFileSync(defaultCommandPath, "utf8");
}

function commandParts(): { frontmatter: string; body: string } {
  const source = commandSource();
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  expect(match, `${defaultCommandPath} must have YAML frontmatter`).not.toBeNull();
  return {
    frontmatter: match?.[1] ?? "",
    body: source.slice(match?.[0].length ?? 0),
  };
}

describe("/autonomous command contract", () => {
  it("is an explicit user-only command with the required frontmatter", () => {
    const { frontmatter } = commandParts();

    expect(existsSync(defaultCommandPath)).toBe(true);
    expect(frontmatter).toMatch(/^description:\s+[^\r\n]+$/m);
    expect(frontmatter).toContain(
      "description: Continue this autonomous orchestrator session without human input and write a run report.",
    );
    expect(frontmatter).toMatch(/^disable-model-invocation:\s*true\s*$/m);
  });

  it("contains the never-ask rule and all three decision buckets", () => {
    const { body } = commandParts();

    for (const marker of [
      "This mode is explicit and one-way for the rest of that session. It never activates at startup, through configuration, because a worker asks a question, or through any other automatic path.",
      "The orchestrator must never ask the human a question, request a choice, wait for an answer, or stop because a human answer is unavailable.",
      "If the orchestrator or a worker would need to ask the human for input, that work is blocked.",
      "A worker's question is evidence of a blocker, not permission to ask the human.",
      "Use this as a heuristic, not a guarantee: can the decision be undone with `git revert`?",
      "1. Bucket 1 covers reversible and cheap decisions that may be made immediately.",
      "2. Bucket 2 covers irreversible or destructive actions.",
      "3. An ambiguous product decision that genuinely matters is deferred as a pending question.",
      "Installing, fetching, or vendoring a dependency is not bucket 1. Treat it as bucket 2, including the lockfile change, network fetch, and transitive code execution.",
      "This includes deleting data, deleting untracked files, `git clean`, `git reset --hard`, force-pushing an already-shared branch, publishing or sharing commits, touching production, sending network writes or other external side-effecting calls, spending money, applying a migration to a shared database, and installing, fetching, or vendoring a dependency.",
      "The orchestrator and workers must never take them without the human.",
      "Defer the action and record it in the report. Do not ask for permission.",
      "For this MVP, naming a candidate library in notes or prose is bucket 1. Installing, fetching, or vendoring that library is bucket 2.",
      "A revert does not undo dependency installation, network fetches, transitive code execution, shared-state changes, or external side effects.",
    ]) {
      expect(body, `missing contract marker: ${marker}`).toContain(marker);
    }
  });

  it("records blockers and routes around work that does not depend on them", () => {
    const { body } = commandParts();

    for (const marker of [
      "## Route around blockers",
      "When a task is deferred or blocked, the orchestrator records the reason, keeps a running notes entry, and continues dispatching or doing every independent task.",
      "Independent means the task needs no output, file, or decision from the deferred or blocked item.",
      "When in doubt, list it as deferred rather than dispatch it.",
      "One blocker must not halt the whole run.",
      "Work that depends on the deferred decision remains listed as deferred.",
    ]) {
      expect(body, `missing route-around marker: ${marker}`).toContain(marker);
    }
  });

  it("dispatches report-file creation and defines append-only notes", () => {
    const { body } = commandParts();

    for (const marker of [
      "On activation, the orchestrator dispatches a worker (or, if the session is an edit-capable harness, directs the session) to create the slug directory and both files immediately.",
      "`<slug>` is the feature slug from the active work item, lowercased with every run of non-alphanumeric characters replaced by one hyphen and leading or trailing hyphens removed.",
      "If the work item has no feature slug, use `autonomous-mode`.",
      "`.specs/features/<slug>/run-notes.md`",
      "`.specs/features/<slug>/run-report.md`",
      "No note-taking is valid before they exist.",
      "This file is append-only per run and is never rewritten.",
      "The final report lives at `.specs/features/<slug>/run-report.md`",
      "Do not write `see run-notes.md`; fold the notes into the report as content.",
      "time-or-sequence, decision, category (bucket), and reason",
    ]) {
      expect(body, `missing report-workflow marker: ${marker}`).toContain(marker);
    }
  });

  it("pins the revert limitation and rejects approval prompts", () => {
    const { body } = commandParts();

    expect(body).toContain(
      "A revert does not undo dependency installation, network fetches, transitive code execution, shared-state changes, or external side effects.",
    );
    expect(body).toContain("If the work item has no feature slug, use `autonomous-mode`.");
    expect(body).not.toContain("ASK HUMAN:");
  });

  it("keeps the five final-report sections and link rules in order", () => {
    const { body } = commandParts();
    const sections = [
      "1. `Done`, including commit and branch links.",
      "2. `Assumptions I made`, covering reversible calls recorded during the run.",
      "3. `Deferred / waiting for you`, covering irreversible actions and pending product questions.",
      "4. `Blocked / failed`, covering failed work, blocked workers, and reasons.",
      "5. `Not covered`, covering work left out of the run and why.",
    ];
    let previous = -1;

    for (const section of sections) {
      const position = body.indexOf(section);
      expect(position, `missing report section: ${section}`).toBeGreaterThan(previous);
      previous = position;
    }

    for (const marker of [
      "The `Done` section derives the branch by running `git branch --show-current` and the commit by running `git rev-parse HEAD`.",
      "- Branch: `[<branch-name>](<remote>/tree/<branch-name>)`",
      "- Commit: `[<full-sha>](<remote>/commit/<full-sha>)`",
      "Without a web remote, it includes the exact branch name and full commit SHA and states that links are unavailable.",
    ]) {
      expect(body, `missing link-rule marker: ${marker}`).toContain(marker);
    }
  });
});
