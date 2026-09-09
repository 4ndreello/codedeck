import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  composeRunPrompt,
  parseRole,
  readCore,
  resolvePluginDir,
  resolveRolePrompt,
  roleBody,
  ROLES,
} from "../src/core/roles.js";

function pluginWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-roles-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ultra.md"), "# CodeDeck Ultra\n\nCore text.\n");
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

  it.each([
    ["gen", "general"],
    ["orc", "orchestrator"],
    ["rev", "reviewer"],
    ["aud", "auditor"],
  ])("resolves the %s prefix", (prefix, role) => {
    expect(parseRole(prefix)).toBe(role);
  });

  it("trims and lowercases prefixes", () => {
    expect(parseRole(" ORCH ")).toBe("orchestrator");
  });

  it.each(["", " ", "g", "ge"])("rejects a role input shorter than three characters: %j", (input) => {
    expect(parseRole(input)).toBeUndefined();
  });

  it.each(["ord", "orchestrators"])("rejects a non-matching prefix: %s", (input) => {
    expect(parseRole(input)).toBeUndefined();
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

  // Requiring a newline after the closing delimiter left the whole block in
  // the body, which is how `tools:` would reach a prompt as if it were prose.
  it.each([
    ["ends at the closing delimiter", "---\nname: reviewer\ntools: Read, Bash\n---"],
    ["ends at the closing delimiter with CRLF", "---\r\nname: reviewer\r\n---"],
  ])("strips a frontmatter that %s", (_label, source) => {
    const dir = pluginWith({ "reviewer.md": source });

    expect(roleBody(dir, "reviewer")).toBe("");
  });

  // A `---` rule inside the prose is not a second frontmatter block.
  it("strips only the leading block", () => {
    const dir = pluginWith({
      "reviewer.md": "---\nname: reviewer\n---\n\nOne.\n\n---\n\nTwo.\n",
    });

    expect(roleBody(dir, "reviewer")).toBe("One.\n\n---\n\nTwo.");
  });
});

describe("readCore", () => {
  it("reads the ultra text the open path ships separately", () => {
    const dir = pluginWith({});

    expect(readCore(dir)).toBe("# CodeDeck Ultra\n\nCore text.");
  });

  it("fails loud when ultra.md is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-roles-"));

    expect(() => readCore(dir)).toThrow(/ultra prompt not found/);
  });
});

describe("composeRunPrompt", () => {
  it("prepends core, then the role body, then the prompt", () => {
    const dir = pluginWith({
      "auditor.md": "---\nname: auditor\n---\n\nYou audit.\n",
    });

    expect(composeRunPrompt(dir, "auditor", "check the diff")).toBe(
      "# CodeDeck Ultra\n\nCore text.\n\n---\n\nYou audit.\n\n---\n\ncheck the diff",
    );
  });
});

describe("resolveRolePrompt", () => {
  it("passes the prompt through when the flag was not given", () => {
    const dir = pluginWith({ "auditor.md": "You audit.\n" });

    expect(resolveRolePrompt(dir, undefined, "check the diff")).toBe("check the diff");
  });

  it("composes core plus the role when the flag names a real role", () => {
    const dir = pluginWith({ "auditor.md": "---\nname: auditor\n---\n\nYou audit.\n" });

    expect(resolveRolePrompt(dir, " AUDITOR ", "check the diff")).toBe(
      "# CodeDeck Ultra\n\nCore text.\n\n---\n\nYou audit.\n\n---\n\ncheck the diff",
    );
  });

  // `--role=` reaches commander as an empty string, not as an absent flag.
  // Treating it as absent ran the session with no role and no complaint.
  it.each([
    ["an empty value", ""],
    ["an unknown role", "implementer"],
  ])("rejects %s", (_label, input) => {
    const dir = pluginWith({ "auditor.md": "You audit.\n" });

    expect(() => resolveRolePrompt(dir, input, "check the diff")).toThrow(/Invalid role/);
  });

  // Asking for a role and silently getting a plain run is what ultra.md calls
  // rounding failure to success: the session costs full price and is not the
  // thing that was asked for.
  it("refuses a role whose agent file is missing", () => {
    const dir = pluginWith({});

    expect(() => resolveRolePrompt(dir, "auditor", "check the diff")).toThrow(
      /has no agent file/,
    );
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
