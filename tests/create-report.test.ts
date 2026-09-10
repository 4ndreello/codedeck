import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillFile = path.join(root, "skills", "create-report", "SKILL.md");
const partial = (name: string) =>
  fs.readFileSync(path.join(root, "plugin", "prompts", "_partials", `${name}.md`), "utf8");
const manifest = (role: string) =>
  fs.readFileSync(path.join(root, "plugin", "prompts", "roles", `${role}.md`), "utf8");
const agent = (role: string) =>
  fs.readFileSync(path.join(root, "plugin", "agents", `${role}.md`), "utf8");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

describe("create-report skill", () => {
  it("ships a model-invoked skill with report triggers", () => {
    const raw = fs.readFileSync(skillFile, "utf8");
    const front = FRONTMATTER.exec(raw)?.[1] ?? "";

    expect(front).toMatch(/^name:\s*create-report$/m);
    expect(front).toMatch(/report/i);
    expect(front).toMatch(/whitepaper|architecture memo/i);
    expect(front).not.toMatch(/disable-model-invocation/);
  });

  it("keeps the report portable and grounded in codedeck evidence", () => {
    const raw = fs.readFileSync(skillFile, "utf8");

    expect(raw).toMatch(/self-contained/i);
    expect(raw).toMatch(/inline (CSS|SVG)/i);
    expect(raw).toMatch(/codedeck diff <id> --stat/);
  });

  it("carries no em-dash", () => {
    expect(fs.readFileSync(skillFile, "utf8")).not.toContain("—");
  });
});

describe("report partials", () => {
  it.each(["reports-general", "reports-dispatch"])("%s offers a report and names the skill", (name) => {
    expect(partial(name)).toMatch(/^## Reports/m);
    expect(partial(name)).toContain("create-report");
    expect(partial(name)).toMatch(/offer/i);
    expect(partial(name)).not.toContain("—");
  });

  it("general builds while orchestrators dispatch", () => {
    expect(partial("reports-general")).toMatch(/then build it/i);
    expect(partial("reports-dispatch")).toMatch(/dispatch a general worker/i);
  });
});

describe("report pointers in roles", () => {
  it("general includes reports-general and the other roles include reports-dispatch", () => {
    expect(manifest("general")).toMatch(/^\s*-\s*reports-general$/m);
    for (const role of ["orchestrator", "orchestrator-read", "orchestrator-edit"] as const) {
      expect(manifest(role), role).toMatch(/^\s*-\s*reports-dispatch$/m);
    }
  });

  it.each(["general", "orchestrator", "orchestrator-read", "orchestrator-edit"])(
    "generated %s resolves exactly one Reports section naming the skill",
    (role) => {
      const sections = agent(role).match(/^## Reports/mg) ?? [];

      expect(sections, role).toHaveLength(1);
      expect(agent(role), role).toContain("create-report");
    },
  );
});
