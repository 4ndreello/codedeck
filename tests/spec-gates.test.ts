import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatesDir = path.join(root, "scripts", "spec-gates");

function run(script: string, args: string[], cwd: string): { rc: number; out: string } {
  try {
    const out = execFileSync("python3", [path.join(gatesDir, script), ...args], {
      cwd,
      encoding: "utf8",
    });
    return { rc: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { rc: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function featureRoot(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gates-"));
  const fdir = path.join(dir, ".specs", "features", "demo");
  fs.mkdirSync(fdir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(fdir, name), body);
  }
  return dir;
}

const GOOD_SPEC = `# Demo Specification

## Problem Statement

Something hurts.

## Out of Scope

| Feature | Reason |
| ------- | ------ |
| X | Later |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale |
| --------------------- | -------------- | --------- |
| Store | SQLite | Zero deps |

**Open questions:** none

## User Stories

### P1: Thing

**Acceptance Criteria**:

1. WHEN the user clicks THEN the system SHALL respond
2. The system SHALL stay up
`;

describe("spec gates: validate_spec", () => {
  it("passes a SHALL-shaped spec", () => {
    const dir = featureRoot({ "spec.md": GOOD_SPEC });
    const r = run("validate_spec.py", ["demo", "--root", dir], dir);
    expect(r.rc).toBe(0);
  });

  it("fails a criterion without SHALL", () => {
    const bad = GOOD_SPEC.replace(
      "1. WHEN the user clicks THEN the system SHALL respond",
      "1. Clicking should work nicely",
    );
    const dir = featureRoot({ "spec.md": bad });
    const r = run("validate_spec.py", ["demo", "--root", dir], dir);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/no SHALL/);
  });
});

describe("spec gates: validate_tasks", () => {
  const GOOD_TASKS = `# Demo Tasks

## Test Coverage Matrix

| Code Layer | Required Test Type | Location Pattern | Run Command |
| ---------- | ------------------ | ---------------- | ----------- |
| Service | unit | tests/*.test.ts | npx vitest run tests/a.test.ts |

## Gate Check Commands

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Unit-only tasks | npx vitest run tests/a.test.ts |

## Execution Plan

### Phase 1: Build

\`\`\`
T1 -> T2
\`\`\`

## Task Breakdown

### T1: Create service

**What**: One service
**Where**: \`src/a.ts\`
**Depends on**: None
**Tests**: unit
**Gate**: quick

### T2: Wire service

**What**: Wiring
**Where**: \`src/b.ts\`
**Depends on**: T1
**Tests**: unit
**Gate**: quick
`;

  it("passes well-formed tasks", () => {
    const dir = featureRoot({ "tasks.md": GOOD_TASKS });
    const r = run("validate_tasks.py", ["demo", "--root", dir], dir);
    expect(r.rc).toBe(0);
  });

  it("fails a task missing its Tests field", () => {
    const bad = GOOD_TASKS.replace("**Tests**: unit\n**Gate**: quick\n\n### T2", "**Gate**: quick\n\n### T2");
    const dir = featureRoot({ "tasks.md": bad });
    const r = run("validate_tasks.py", ["demo", "--root", dir], dir);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/missing `Tests` field/);
  });
});

describe("spec gates: check_commit", () => {
  it("accepts a repo-style message", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gates-"));
    const r = run("check_commit.py", ["--message", "feat(prompts): Add lean spec gates"], dir);
    expect(r.rc).toBe(0);
  });

  it("rejects lowercase subjects and missing types", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gates-"));
    const lower = run("check_commit.py", ["--message", "fix(x): add thing"], dir);
    expect(lower.rc).toBe(1);
    expect(lower.out).toMatch(/uppercase/);
    const notype = run("check_commit.py", ["--message", "just some words"], dir);
    expect(notype.rc).toBe(1);
  });
});

describe("spec gates: validate_state", () => {
  it("passes a PASS report with file:line evidence", () => {
    const dir = featureRoot({
      "validation.md": "# Demo Validation\n\n**Result**: PASS\n\nCovered by `src/a.ts:42`.",
    });
    const r = run("validate_state.py", ["demo", "--root", dir], dir);
    expect(r.rc).toBe(0);
  });

  it("fails a missing report", () => {
    const dir = featureRoot({});
    const r = run("validate_state.py", ["demo", "--root", dir], dir);
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/no validation\.md/);
  });
});
