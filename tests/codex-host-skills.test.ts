import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StartOptions } from "../src/core/driver.js";
import { CodexDriver } from "../src/drivers/codex/driver.js";
import { discoverCodexHostSkills } from "../src/drivers/codex/host-skills.js";

const temporaryDirectories: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

class ExposedCodexDriver extends CodexDriver {
  args(options: StartOptions): string[] {
    return this.buildArgs(options);
  }
}

function makeTempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-host-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  vi.restoreAllMocks();
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
    const uppercaseSkill = path.join(codexSkills, "Alpha", "SKILL.md");
    const lowercaseSkill = path.join(codexSkills, "alpha", "SKILL.md");
    const agentSkill = path.join(agentSkills, "agent", "SKILL.md");
    const linkedSkill = path.join(temporary, "external", "linked", "SKILL.md");
    const linkedDir = path.dirname(linkedSkill);

    for (const file of [
      nestedSkill,
      dotSkill,
      uppercaseSkill,
      lowercaseSkill,
      agentSkill,
      linkedSkill,
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "skill");
    }
    fs.symlinkSync(linkedDir, path.join(codexSkills, "linked"), "dir");
    fs.symlinkSync(codexSkills, path.join(codexSkills, "cycle"), "dir");

    expect(discoverCodexHostSkills({ codexHome, homeDir })).toEqual(
      [
        nestedSkill,
        dotSkill,
        uppercaseSkill,
        lowercaseSkill,
        agentSkill,
        path.join(codexSkills, "linked", "SKILL.md"),
      ].sort((a, b) => a.localeCompare(b)),
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

  it("uses the homedir codex root when CODEX_HOME is empty", () => {
    const temporary = makeTempDir();
    const homeDir = path.join(temporary, "home");
    const skillPath = path.join(homeDir, ".codex", "skills", "fallback", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "skill");
    process.env.CODEX_HOME = "";
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    expect(discoverCodexHostSkills({ homeDir })).toEqual([skillPath]);
  });

  it("passes discovered host skills through CodexDriver buildArgs", () => {
    const temporary = makeTempDir();
    const codexHome = path.join(temporary, "codex-home");
    const skillPath = path.join(codexHome, "skills", "nested", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "skill");
    process.env.CODEX_HOME = codexHome;

    const args = new ExposedCodexDriver().args({
      sessionId: "test-session",
      prompt: "do it",
      cwd: temporary,
    });
    const config = args.flatMap((arg, index) => (arg === "-c" ? [args[index + 1]] : []));

    expect(
      config.some((value) => value.includes(`path=${JSON.stringify(skillPath)},enabled=false`)),
    ).toBe(true);
  });
});
