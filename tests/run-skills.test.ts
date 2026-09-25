import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { composeRunSection, readRunSkills } from "../src/core/run-skills.js";

function pluginDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-run-skills-"));
}

function writeSkill(root: string, directory: string, contents: string): string {
  const skillDir = path.join(root, "skills", directory);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, contents);
  return skillPath;
}

describe("run skill catalog", () => {
  it("lists skill names, descriptions, and absolute paths sorted by name", () => {
    const root = pluginDir();
    const zetaPath = writeSkill(
      root,
      "zeta-dir",
      "---\nname: zeta\ndescription: Zeta skill description.\n---\n\nZeta body.\n",
    );
    const alphaPath = writeSkill(
      root,
      "alpha-dir",
      "---\nname: 'alpha'\ndescription: \"Alpha skill description.\"\n---\n\nAlpha body.\n",
    );

    const skills = readRunSkills(root);
    const section = composeRunSection(root);

    expect(skills).toEqual([
      { name: "alpha", description: "Alpha skill description.", path: path.resolve(alphaPath) },
      { name: "zeta", description: "Zeta skill description.", path: path.resolve(zetaPath) },
    ]);
    expect(path.isAbsolute(skills[0].path)).toBe(true);
    expect(section.indexOf("- alpha: Alpha skill description.")).toBeLessThan(
      section.indexOf("- zeta: Zeta skill description."),
    );
    expect(section).toContain(`  ${path.resolve(alphaPath)}`);
    expect(section).toContain(`  ${path.resolve(zetaPath)}`);
    expect(section).toContain("read its `SKILL.md` and follow it");
    expect(section).toContain("that file's directory");
  });

  it.each([
    [
      "folds a > block into one line",
      "name: folded\ndescription: >-\n  Use this skill\n  when x: y.\nother: ignored",
      { name: "folded", description: "Use this skill when x: y." },
    ],
    [
      "joins a | block and stops at the next column-zero key",
      "name: literal\ndescription: |+\n  Keep these words\n  from the next line.\nname: literal after block",
      { name: "literal after block", description: "Keep these words from the next line." },
    ],
    [
      "strips an unquoted comment after whitespace",
      "name: commented\ndescription: value # c",
      { name: "commented", description: "value" },
    ],
    [
      "keeps a # with no whitespace before it",
      "name: hash\ndescription: a#b",
      { name: "hash", description: "a#b" },
    ],
    [
      "keeps a quoted value followed by a comment",
      'name: quoted\ndescription: "Use when x: y"  # c',
      { name: "quoted", description: "Use when x: y" },
    ],
  ])("frontmatter: %s", (_title, frontmatter, expected) => {
    const root = pluginDir();
    writeSkill(root, "entry", `---\n${frontmatter}\n---\n`);

    expect(readRunSkills(root).map(({ name, description }) => ({ name, description }))).toEqual([expected]);
  });

  it.each(["missing", "empty"])("omits the catalog for a %s skills directory", (kind) => {
    const root = pluginDir();
    if (kind === "empty") fs.mkdirSync(path.join(root, "skills"));

    const section = composeRunSection(root);

    expect(section).toContain("This worker runs non-interactively in the background.");
    expect(section).toContain("Nobody answers approval, direction, or confirmation questions");
    expect(section).toContain("make the reasonable call, record the assumption in the final report, and deliver");
    expect(section).toContain("Follow the briefing's stop conditions.");
    expect(section).not.toContain("## CodeDeck skills");
  });

  it("skips a SKILL.md without a parseable name", () => {
    const root = pluginDir();
    const unnamedPath = writeSkill(
      root,
      "unnamed",
      "---\ndescription: This skill has no name.\n---\n\nNo name.\n",
    );
    const emptyNamePath = writeSkill(
      root,
      "empty-name",
      "---\nname:\ndescription: This skill has an empty name.\n---\n",
    );
    const namedPath = writeSkill(
      root,
      "named",
      "---\nname: named\ndescription: Kept skill.\n---\n\nNamed body.\n",
    );

    expect(readRunSkills(root)).toEqual([
      { name: "named", description: "Kept skill.", path: path.resolve(namedPath) },
    ]);
    expect(composeRunSection(root)).toContain("- named: Kept skill.");
    expect(composeRunSection(root)).not.toContain(unnamedPath);
    expect(composeRunSection(root)).not.toContain(emptyNamePath);
    expect(composeRunSection(root)).not.toContain("This skill has no name.");
  });
});
