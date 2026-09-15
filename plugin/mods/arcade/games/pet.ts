export type PetEventKind = "test-pass" | "test-fail" | "commit" | "edit";

export interface PetToolCall {
  tool: string;
  command?: string;
  text?: string;
  ok?: boolean;
  denied?: boolean;
  exitCode?: number;
}

export interface PetEvent {
  kind: PetEventKind;
  ok: boolean | undefined;
  xp: number;
  mood: number;
}

export interface Pet {
  xp: number;
  mood: number;
  tests: number;
  commits: number;
  edits: number;
}

export const XP: Record<PetEventKind, number> = {
  "test-pass": 10,
  "test-fail": 2,
  commit: 15,
  edit: 1,
};

export const MOOD: Record<PetEventKind, number> = {
  "test-pass": 8,
  "test-fail": -12,
  commit: 10,
  edit: 1,
};

// Matches common test invocations:
// bun / npm / pnpm / yarn test, npx jest vitest mocha,
// pytest jest vitest rspec phpunit mocha at a command start or after a
// shell separator, go test, cargo test, make test,
// mvn gradle gradlew sbt test tasks.
// Bare tool names are anchored so words inside other commands
// (e.g. "cat vitest.config.ts") do not count as test runs.
export const TEST_COMMAND =
  /(?:\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bnpx\s+(?:jest|vitest|mocha)\b|(?:^|[;&|]\s*)\b(?:pytest|jest|vitest|rspec|phpunit|mocha)\b(?=\s|$)|\bgo\s+test\b|\bcargo\s+test\b|\bmake\s+test\b|\b(?:mvn|gradle|gradlew|sbt)\b[^\n]*\btest\b)/;

const GIT_COMMIT = /\bgit\s+commit\b/;
const DRY_RUN = /--dry-run/;

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function commandText(call: PetToolCall): string {
  return call.command ?? call.text ?? "";
}

function kindForTest(call: PetToolCall): PetEventKind {
  if (call.ok === false) return "test-fail";
  if (typeof call.exitCode === "number" && call.exitCode !== 0) return "test-fail";
  return "test-pass";
}

export function petEvent(call: PetToolCall): PetEvent | undefined {
  // Denied calls carry undefined ok and are ignored.
  if (call.denied) return undefined;

  if (call.tool === "Bash") {
    const text = commandText(call);
    // Commits win over test words: "git commit -m 'fix jest config'"
    // is a commit, not a test run.
    if (GIT_COMMIT.test(text) && !DRY_RUN.test(text)) {
      return { kind: "commit", ok: call.ok, xp: XP.commit, mood: MOOD.commit };
    }
    if (TEST_COMMAND.test(text)) {
      const kind = kindForTest(call);
      return { kind, ok: call.ok, xp: XP[kind], mood: MOOD[kind] };
    }
    return undefined;
  }

  if (EDIT_TOOLS.has(call.tool)) {
    return { kind: "edit", ok: call.ok, xp: XP.edit, mood: MOOD.edit };
  }

  return undefined;
}

export function newPet(): Pet {
  return { xp: 0, mood: 0, tests: 0, commits: 0, edits: 0 };
}

export function feed(pet: Pet, event: PetEvent): Pet {
  const next: Pet = {
    xp: pet.xp + event.xp,
    mood: pet.mood + event.mood,
    tests: pet.tests,
    commits: pet.commits,
    edits: pet.edits,
  };
  if (event.kind === "test-pass" || event.kind === "test-fail") next.tests += 1;
  if (event.kind === "commit") next.commits += 1;
  if (event.kind === "edit") next.edits += 1;
  return next;
}

export function level(pet: Pet): number {
  return 1 + Math.floor(Math.max(0, pet.xp) / 100);
}

export function stage(input: Pet | number): string {
  const lvl = typeof input === "number" ? input : level(input);
  if (lvl <= 1) return "egg";
  if (lvl === 2) return "baby";
  if (lvl === 3) return "teen";
  return "adult";
}
