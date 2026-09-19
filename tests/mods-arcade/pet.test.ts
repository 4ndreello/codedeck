import { describe, expect, it } from "vitest";

import { feed, level, MOOD, newPet, petEvent, stage, TEST_COMMAND, XP } from "../../plugin/mods/arcade/games/pet";

describe("XP table", () => {
  it("rewards test passes, commits and edits", () => {
    expect(XP["test-pass"]).toBe(10);
    expect(XP["test-fail"]).toBe(2);
    expect(XP.commit).toBe(15);
    expect(XP.edit).toBe(1);
  });
});

describe("MOOD table", () => {
  it("tracks mood per event kind", () => {
    expect(MOOD["test-pass"]).toBe(8);
    expect(MOOD["test-fail"]).toBe(-12);
    expect(MOOD.commit).toBe(10);
    expect(MOOD.edit).toBe(1);
  });
});

describe("TEST_COMMAND", () => {
  it.each([
    "bun test",
    "npm test",
    "npm run test",
    "pnpm test",
    "yarn test",
    "npx jest",
    "npx vitest",
    "npx mocha",
    "pytest",
    "pytest tests/test_pet.py",
    "jest",
    "vitest run",
    "rspec",
    "phpunit",
    "mocha",
    "go test ./...",
    "cargo test",
    "make test",
    "mvn test",
    "gradle test",
    "./gradlew test",
    "sbt test",
  ])("matches %s", (cmd) => {
    expect(TEST_COMMAND.test(cmd)).toBe(true);
  });

  it.each(["git commit -m hi", "go build ./...", "npm run lint"])("does not match %s", (cmd) => {
    expect(TEST_COMMAND.test(cmd)).toBe(false);
  });

  it.each([
    "cat vitest.config.ts",
    "rm -rf node_modules/.vitest",
    "git add jest.config.js",
    "grep -rn mocha docs/",
    "ls tests/pytest.ini",
  ])("does not mistake %s for a test run", (cmd) => {
    expect(TEST_COMMAND.test(cmd)).toBe(false);
  });
});

describe("petEvent", () => {
  it("classifies Bash test runs by command text", () => {
    expect(petEvent({ tool: "Bash", command: "npm test", ok: true })?.kind).toBe("test-pass");
    expect(petEvent({ tool: "Bash", command: "go test ./...", ok: false })?.kind).toBe("test-fail");
  });

  it("classifies git commit without the dry-run flag into commits", () => {
    expect(petEvent({ tool: "Bash", command: "git commit -m hi", ok: true })?.kind).toBe("commit");
    expect(petEvent({ tool: "Bash", command: "git commit --dry-run", ok: true })).toBeUndefined();
  });

  it("prefers commit over test words in the message", () => {
    expect(petEvent({ tool: "Bash", command: "git commit -m 'fix jest config'", ok: true })?.kind).toBe(
      "commit",
    );
  });

  it.each(["Edit", "Write", "NotebookEdit"])("classifies %s tool names into edits", (tool) => {
    expect(petEvent({ tool })?.kind).toBe("edit");
  });

  it("ignores denied calls with undefined ok", () => {
    expect(petEvent({ tool: "Bash", command: "npm test", denied: true })).toBeUndefined();
    const denied = petEvent({ tool: "Bash", command: "npm test", denied: true, ok: undefined });
    expect(denied?.ok).toBeUndefined();
  });

  it("ignores unrelated tools", () => {
    expect(petEvent({ tool: "Read" })).toBeUndefined();
    expect(petEvent({ tool: "Bash", command: "echo hi" })).toBeUndefined();
  });
});

describe("feed / level / stage", () => {
  it("starts from zero with newPet", () => {
    expect(newPet()).toEqual({ xp: 0, mood: 0, tests: 0, commits: 0, edits: 0 });
  });

  it("accumulates xp, mood and counters", () => {
    const start = newPet();
    const after = feed(start, { kind: "test-pass", ok: true, xp: XP["test-pass"], mood: MOOD["test-pass"] });
    expect(after.xp).toBe(10);
    expect(after.mood).toBe(8);
    expect(after.tests).toBe(1);
  });

  it("derives level from xp and stage from level", () => {
    expect(level(newPet())).toBe(1);
    expect(level({ xp: 250, mood: 0, tests: 0, commits: 0, edits: 0 })).toBe(3);
    expect(stage(1)).toBe("egg");
    expect(stage(newPet())).toBe("egg");
  });
});
