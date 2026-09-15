import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "plugin", "skills", "tlc-spec-driven");
const skillFile = path.join(skillDir, "SKILL.md");
const read = (file: string) => fs.readFileSync(file, "utf8");

describe("tlc-spec-driven plugin skill", () => {
  it("ships the model-invoked skill with its supporting files", () => {
    const skill = read(skillFile);

    expect(skill).toMatch(/^name: tlc-spec-driven$/m);
    expect(skill).toMatch(/Feature planning and implementation with 4 adaptive phases/);
    expect(skill).not.toMatch(/disable-model-invocation/);

    for (const file of [
      "references/implement.md",
      "references/validate.md",
      "references/coding-principles.md",
      "scripts/check_commit.py",
      "scripts/lessons.py",
      "scripts/validate_spec.py",
      "scripts/validate_state.py",
      "scripts/validate_tasks.py",
    ]) {
      expect(fs.existsSync(path.join(skillDir, file)), file).toBe(true);
    }
  });

  it("keeps the skill self-contained and free of em dashes", () => {
    expect(read(skillFile)).toContain("<skill-dir>");
    expect(read(skillFile)).not.toContain(String.fromCodePoint(0x2014));
  });
});

describe("tlc-spec-driven orchestrator default", () => {
  it("uses the default spec-driven contract in every orchestrator mode", () => {
    const partial = read(path.join(root, "plugin", "prompts", "_partials", "spec-gates.md"));

    expect(partial).toContain("tlc-spec-driven");
    expect(partial).toMatch(/default/i);
    expect(partial).toMatch(/every feature/i);
    expect(partial).toContain("When the harness does not expose the skill");

    for (const role of ["orchestrator", "orchestrator-read", "orchestrator-edit"]) {
      const manifest = read(path.join(root, "plugin", "prompts", "roles", `${role}.md`));
      expect(manifest, role).toMatch(/^\s*-\s*spec-gates$/m);
    }
  });

  it("renders the default contract into generated agents", () => {
    for (const role of ["orchestrator", "orchestrator-read", "orchestrator-edit"]) {
      const agent = read(path.join(root, "plugin", "agents", `${role}.md`));
      expect(agent, role).toContain("tlc-spec-driven");
      expect(agent, role).toContain("When the harness does not expose the skill");
    }
  });
});
