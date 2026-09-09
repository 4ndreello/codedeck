import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { composeRunPrompt, readCore } from "../src/core/roles.js";
import { resolveRoleContract } from "../src/open/contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(root, "plugin", "agents");
const partialsDir = path.join(root, "plugin", "prompts", "_partials");
const manifestsDir = path.join(root, "plugin", "prompts", "roles");
const ultraFile = path.join(root, "plugin", "ultra.md");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// Minimal frontmatter reader for the controlled manifest/generated shape:
// `#` comment lines, scalar name/description/tools, one `includes:` list.
function parseFrontmatter(source: string): { fields: Record<string, string>; includes: string[] } {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error("missing frontmatter");
  const fields: Record<string, string> = {};
  const includes: string[] = [];
  let inIncludes = false;
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trimStart().startsWith("#") || line.trim() === "") continue;
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (inIncludes && item) {
      includes.push(item[1]);
      continue;
    }
    const key = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!key) {
      inIncludes = false;
      continue;
    }
    inIncludes = key[1] === "includes";
    if (key[1] !== "includes") fields[key[1]] = key[2].trim();
  }
  return { fields, includes };
}

const agentBody = (role: string) =>
  fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8").replace(FRONTMATTER, "");

const manifestBody = (role: string) =>
  fs.readFileSync(path.join(manifestsDir, `${role}.md`), "utf8").replace(FRONTMATTER, "");

// Appendix A key phrases, one per must-sentence. The containment gate asserts
// exactly these substrings; word order does not matter, absence fails.
const PHRASES = [
  "Before declaring a file-changing task ready",
  "The review is read-only, so use",
  "Act on the review result",
  "If the human waived review",
  "so the worker has an attributable worktree",
  "Worktree is a choice, not a default",
  "Always include",
  "sends only a loose briefing",
  "The role owns the harness and the model",
  "Slice by ownership",
  "Workers start with none of this context",
  "Verify before you claim.",
  "before believing any worker",
  "rename your session",
] as const;

// Which phrases each generated file must contain. Orchestrator variants take
// worktree (5,6), dispatch (7-11) and proof both (12,13); reviewer takes the
// verify sentence (12) plus rename-run (14); auditor takes dispatch, proof
// both, and rename-run.
const EXPECTED: Record<string, number[]> = {
  general: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  orchestrator: [5, 6, 7, 8, 9, 10, 11, 12, 13],
  "orchestrator-read": [5, 6, 7, 8, 9, 10, 11, 12, 13],
  "orchestrator-edit": [5, 6, 7, 8, 9, 10, 11, 12, 13],
  reviewer: [12, 14],
  auditor: [7, 8, 9, 10, 11, 12, 13, 14],
};

const ROLES = Object.keys(EXPECTED);

const BUDGETS: Record<string, number> = {
  general: 16384,
  orchestrator: 14336,
  "orchestrator-read": 8192,
  "orchestrator-edit": 8192,
  reviewer: 8192,
  auditor: 8192,
};

describe("prompt layers: manifest validity", () => {
  it.each(ROLES)("every include in %s resolves to a partial", (role) => {
    const { includes } = parseFrontmatter(
      fs.readFileSync(path.join(manifestsDir, `${role}.md`), "utf8"),
    );

    expect(includes.length).toBeGreaterThan(0);
    for (const entry of includes) {
      expect(fs.existsSync(path.join(partialsDir, `${entry}.md`),), `${role} includes ${entry}`).toBe(true);
    }
  });

  it("skips # comment lines inside includes lists", () => {
    const { includes } = parseFrontmatter(
      "---\nname: x\ndescription: X.\nincludes:\n  # a comment about proof\n  - proof\n---\n\nBody.\n",
    );

    expect(includes).toEqual(["proof"]);
  });

  it("core is ultra.md verbatim and is never listed in includes", () => {
    expect(fs.readFileSync(path.join(partialsDir, "core.md"))).toEqual(
      fs.readFileSync(ultraFile),
    );
    for (const role of ROLES) {
      const { includes } = parseFrontmatter(
        fs.readFileSync(path.join(manifestsDir, `${role}.md`), "utf8"),
      );
      expect(includes, role).not.toContain("core");
    }
  });
});

describe("prompt layers: run-path core-first order", () => {
  it("starts every run-path composer output with the core text", () => {
    const core = readCore(path.join(root, "plugin"));

    expect(composeRunPrompt(path.join(root, "plugin"), "reviewer", "do it").startsWith(core)).toBe(true);
    expect(composeRunPrompt(path.join(root, "plugin"), "reviewer", "do it")).toContain("You are the CodeDeck reviewer.");
    expect(composeRunPrompt(path.join(root, "plugin"), "reviewer", "do it")).toMatch(/\n\n---\n\ndo it$/);
  });

  it("excludes core from every generated file", () => {
    for (const role of ROLES) {
      const text = fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8");
      expect(text, role).not.toContain("You are running inside a CodeDeck session");
      expect(text, role).not.toContain("Never round failure to success.");
    }
  });
});

describe("prompt layers: open-path no-duplication", () => {
  it("keeps the ultra text out of the open agent body", () => {
    for (const role of ["general", "orchestrator", "reviewer", "auditor"] as const) {
      const { agentBody: body, ultra } = resolveRoleContract(path.join(root, "plugin"), role);
      expect(body, role).not.toContain("You are running inside a CodeDeck session");
      expect(ultra).toContain("Never round failure to success");
    }
  });
});

describe("prompt layers: marker hygiene", () => {
  it("opens with the delimiter and keeps DO NOT EDIT inside the frontmatter", () => {
    for (const role of ROLES) {
      const text = fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8");
      expect(text.startsWith("---\n"), role).toBe(true);
      const front = FRONTMATTER.exec(text)?.[1] ?? "";
      expect(front, role).toMatch(/DO NOT EDIT/);
      expect(front, role).toMatch(new RegExp(`roles/${role}\\.md`));
    }
  });

  it("leaks no include markers, manifest paths, or includes keys into bodies", () => {
    for (const role of ROLES) {
      const body = agentBody(role);
      expect(body, role).not.toMatch(/^includes:/m);
      expect(body, role).not.toContain("_partials");
      expect(body, role).not.toContain("prompts/roles");
      expect(body, role).not.toMatch(/DO NOT EDIT/);
    }
  });
});

describe("prompt layers: frontmatter preserved as parsed YAML", () => {
  it.each(ROLES)("generated frontmatter equals manifest minus includes for %s", (role) => {
    const generated = parseFrontmatter(fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8"));
    const manifest = parseFrontmatter(fs.readFileSync(path.join(manifestsDir, `${role}.md`), "utf8"));

    expect(generated.includes).toEqual([]);
    expect(generated.fields).toEqual(manifest.fields);
  });

  it("keeps the exact tools allowlist per role", () => {
    const tools = (role: string) =>
      parseFrontmatter(fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8")).fields.tools;
    expect(tools("general")).toBeUndefined();
    expect(tools("orchestrator")).toBe("Bash");
    expect(tools("orchestrator-read")).toBe("Read, Grep, Glob, Bash");
    expect(tools("orchestrator-edit")).toBe("Read, Grep, Glob, Edit, Write, Bash");
    expect(tools("reviewer")).toBe("Read, Grep, Glob, Bash, WebFetch, WebSearch");
    expect(tools("auditor")).toBe("Read, Grep, Glob, Bash, WebFetch, WebSearch, Task");
  });
});

describe("prompt layers: Appendix A containment gate", () => {
  it.each(ROLES)("generated %s contains its phrases and drops the rest", (role) => {
    const text = fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8");
    const wanted = EXPECTED[role];
    PHRASES.forEach((phrase, index) => {
      const n = index + 1;
      if (wanted.includes(n)) expect(text, `${role} phrase ${n}`).toContain(phrase);
      else expect(text, `${role} phrase ${n}`).not.toContain(phrase);
    });
  });

  it("reviewer never gains the run-worker diff sentence", () => {
    expect(agentBody("reviewer")).not.toContain("before believing any worker");
  });

  // Role bodies may extend a concept with role-specific detail but must not
  // restate any must-sentence: every phrase arrives via a partial, never from
  // the manifest body.
  it.each(ROLES)("manifest body for %s restates no must-sentence", (role) => {
    const body = manifestBody(role);
    PHRASES.forEach((phrase, index) => {
      expect(body, `${role} phrase ${index + 1}`).not.toContain(phrase);
    });
  });
});

describe("prompt layers: composition order", () => {
  it("composes includes in manifest order, then the role body", () => {
    const text = fs.readFileSync(path.join(agentsDir, "general.md"), "utf8");
    const order = [
      "Before declaring a file-changing task ready",
      "so the worker has an attributable worktree",
      "Always include",
      "Verify before you claim.",
      "rename your session",
      "## Commits",
      "## Pull requests",
      "You are the CodeDeck general session.",
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = text.indexOf(marker);
      expect(at, marker).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});

describe("prompt layers: size budgets on generated file bytes", () => {
  it.each(ROLES)("%s stays within its budget", (role) => {
    const bytes = fs.statSync(path.join(agentsDir, `${role}.md`)).size;
    expect(bytes).toBeLessThanOrEqual(BUDGETS[role]);
  });
});

describe("prompt layers: build reproduces generated files", () => {
  const snapshotAgents = () =>
    new Map(ROLES.map((role) => [role, fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8")]));

  it("rewrites byte-identical output on regenerate", () => {
    const before = snapshotAgents();
    execFileSync("node", ["scripts/copy-plugin.mjs"], { cwd: root, stdio: "pipe" });
    for (const role of ROLES) {
      expect(fs.readFileSync(path.join(agentsDir, `${role}.md`), "utf8"), role).toBe(before.get(role));
    }
  });

  it("fails naming the manifest and the entry on a dangling include", () => {
    const bad = path.join(manifestsDir, "zz-bogus.md");
    fs.writeFileSync(
      bad,
      "---\nname: zz-bogus\ndescription: Bogus role.\nincludes:\n  - nope\n---\n\nBody.\n",
    );
    try {
      expect(() => execFileSync("node", ["scripts/copy-plugin.mjs"], { cwd: root, stdio: "pipe" })).toThrow(
        /zz-bogus.*nope/s,
      );
    } finally {
      fs.rmSync(bad, { force: true });
      fs.rmSync(path.join(agentsDir, "zz-bogus.md"), { force: true });
      execFileSync("node", ["scripts/copy-plugin.mjs"], { cwd: root, stdio: "pipe" });
    }
    expect(fs.existsSync(path.join(agentsDir, "zz-bogus.md"))).toBe(false);
  });
});
