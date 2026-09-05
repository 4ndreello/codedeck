import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  composeRolePrompt,
  parseRole,
  resolvePluginDir,
  roleBody,
  ROLES,
} from "../src/core/roles.js";

function pluginWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-roles-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "agents", name), body);
  }
  return dir;
}

describe("parseRole", () => {
  it("accepts every shipped role and rejects anything else", () => {
    expect(ROLES).toEqual(["general", "orchestrator", "reviewer", "auditor"]);
    for (const role of ROLES) expect(parseRole(role)).toBe(role);
    expect(parseRole(" AUDITOR ")).toBe("auditor");
    expect(parseRole(undefined)).toBeUndefined();
    expect(parseRole("implementer")).toBeUndefined();
  });
});

describe("roleBody", () => {
  // `tools:` is an allowlist only Claude enforces. Carried into a prompt it
  // would read as an instruction to limit itself, which is not what it means.
  it("strips the frontmatter", () => {
    const dir = pluginWith({
      "reviewer.md": "---\nname: reviewer\ntools: Read, Bash\n---\n\nYou review.\n",
    });

    expect(roleBody(dir, "reviewer")).toBe("You review.");
  });

  it("keeps a body that has no frontmatter", () => {
    const dir = pluginWith({ "reviewer.md": "You review.\n" });

    expect(roleBody(dir, "reviewer")).toBe("You review.");
  });

  // A `---` rule inside the prose is not a second frontmatter block.
  it("strips only the leading block", () => {
    const dir = pluginWith({
      "reviewer.md": "---\nname: reviewer\n---\n\nOne.\n\n---\n\nTwo.\n",
    });

    expect(roleBody(dir, "reviewer")).toBe("One.\n\n---\n\nTwo.");
  });
});

describe("composeRolePrompt", () => {
  it("prefixes the prompt with the role body", () => {
    const dir = pluginWith({
      "auditor.md": "---\nname: auditor\n---\n\nYou audit.\n",
    });

    expect(composeRolePrompt(dir, "auditor", "check the diff")).toBe(
      "You audit.\n\n---\n\ncheck the diff",
    );
  });

  it("returns the prompt untouched when no role was asked for", () => {
    const dir = pluginWith({ "auditor.md": "You audit.\n" });

    expect(composeRolePrompt(dir, undefined, "check the diff")).toBe("check the diff");
  });

  // A plugin directory that shipped without the file degrades to a plain run.
  // Failing the session over a missing prompt costs more than running without it.
  it("returns the prompt untouched when the role file is missing", () => {
    const dir = pluginWith({});

    expect(composeRolePrompt(dir, "auditor", "check the diff")).toBe("check the diff");
  });
});

describe("resolvePluginDir", () => {
  it("finds a directory holding an agent file for every role", () => {
    const dir = resolvePluginDir();

    expect(fs.existsSync(dir)).toBe(true);
    for (const role of ROLES) {
      expect(fs.existsSync(path.join(dir, "agents", `${role}.md`))).toBe(true);
    }
  });
});
