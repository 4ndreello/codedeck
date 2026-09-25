import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverCodexHostSkills } from "../src/drivers/codex/host-skills.js";

const temporaryDirectories: string[] = [];

function makeTempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-host-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("discoverCodexHostSkills", () => {
  it("finds nested, dot-directory, agent-root, and symlinked skills while stopping cycles", () => {
    const temporary = makeTempDir();
    const codexHome = path.join(temporary, "codex-home");
    const homeDir = path.join(temporary, "home");
    const codexSkills = path.join(codexHome, "skills");
    const agentSkills = path.join(homeDir, ".agents", "skills");
    const nestedSkill = path.join(codexSkills, "nested", "SKILL.md");
    const dotSkill = path.join(codexSkills, ".system", "builtin", "SKILL.md");
    const agentSkill = path.join(agentSkills, "agent", "SKILL.md");
    const linkedSkill = path.join(temporary, "external", "linked", "SKILL.md");
    const linkedDir = path.dirname(linkedSkill);

    for (const file of [nestedSkill, dotSkill, agentSkill, linkedSkill]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "skill");
    }
    fs.symlinkSync(linkedDir, path.join(codexSkills, "linked"), "dir");
    fs.symlinkSync(codexSkills, path.join(codexSkills, "cycle"), "dir");

    expect(discoverCodexHostSkills({ codexHome, homeDir })).toEqual(
      [
        nestedSkill,
        dotSkill,
        agentSkill,
        path.join(codexSkills, "linked", "SKILL.md"),
      ].sort(),
    );
  });

  it("skips missing roots", () => {
    const temporary = makeTempDir();
    expect(
      discoverCodexHostSkills({
        codexHome: path.join(temporary, "missing-codex-home"),
        homeDir: path.join(temporary, "missing-home"),
      }),
    ).toEqual([]);
  });
});
