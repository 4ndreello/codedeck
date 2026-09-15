import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "plugin", "skills", "tlc-spec-driven");
const skillFile = path.join(skillDir, "SKILL.md");
const read = (file: string) => fs.readFileSync(file, "utf8");

const runPython = (script: string, args: string[], cwd: string) => {
  const result = spawnSync("python3", [path.join(skillDir, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

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

describe("tlc-spec-driven script boundaries", () => {
  it("rejects artifact paths outside the project root", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-tlc-"));
    const projectRoot = path.join(tempRoot, "project");
    const outsideRoot = path.join(tempRoot, "outside");
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(outsideRoot);
    fs.mkdirSync(path.join(projectRoot, ".specs", "features"), { recursive: true });
    const outsideSpec = path.join(outsideRoot, "spec.md");
    const outsideTasks = path.join(outsideRoot, "tasks.md");
    fs.writeFileSync(outsideSpec, "# outside\n");
    fs.writeFileSync(outsideTasks, "# outside\n");
    const outsideMessage = path.join(outsideRoot, "commit-message.txt");
    fs.writeFileSync(outsideMessage, "feat(core): add safe path\n");

    try {
      const spec = runPython("validate_spec.py", [outsideSpec, "--root", projectRoot], projectRoot);
      const tasks = runPython("validate_tasks.py", [outsideTasks, "--root", projectRoot], projectRoot);
      const state = runPython("validate_state.py", [outsideRoot, "--root", projectRoot], projectRoot);
      const commit = runPython("check_commit.py", [outsideMessage], projectRoot);

      for (const result of [spec, tasks, state, commit]) {
        expect(result.status).toBe(2);
        expect(result.output).toMatch(/outside.*root|root.*outside/i);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
