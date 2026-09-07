import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { describe, expect, it } from "vitest";

import { buildSettings } from "../src/cli/commands/open.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = (...parts: string[]) => join(root, "plugin", ...parts);

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const readText = (path: string) => readFileSync(path, "utf8");

const frontmatter = (path: string) => {
  const match = readText(path).match(/^---\n([\s\S]*?)\n---/);
  expect(match, `${path} must have YAML frontmatter`).not.toBeNull();
  return match?.[1] ?? "";
};

const field = (source: string, name: string) =>
  source.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1] ?? "";

const agentBody = (path: string) =>
  readText(path).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");

describe("CodeDeck plugin manifest contract", () => {
  it("pins the plugin identity and experimental theme directory", () => {
    const manifest = readJson(plugin(".claude-plugin", "plugin.json"));

    expect(manifest.name).toBe("codedeck");
    expect(manifest.version).toEqual(expect.any(String));
    expect(manifest.description).toEqual(expect.any(String));
    expect(manifest.author).toEqual(expect.objectContaining({ name: expect.any(String) }));
    expect(manifest.experimental?.themes).toBe("./themes");
  });

  it("paints the keys the session spinner reads", () => {
    const theme = readJson(plugin("themes", "codedeck-ultra.json"));

    expect(theme.base).toBe("dark");
    expect(theme.overrides).toEqual(expect.objectContaining({
      promptBorder: expect.any(String),
      promptBorderShimmer: expect.any(String),
      // The spinner takes `claude`/`claudeShimmer` normally but swaps to these
      // two while a hook runs or a compaction is under way. Leaving them unset
      // dropped the palette at exactly the moments the spinner is on screen
      // longest.
      claudeBlue_FOR_SYSTEM_SPINNER: expect.any(String),
      claudeBlueShimmer_FOR_SYSTEM_SPINNER: expect.any(String),
      // The mascot is the one thing on the opening screen that keeps its stock
      // colour unless these two are set, and it is drawn from filled blocks, so
      // it reads as a foreign object rather than as a detail.
      clawd_body: expect.any(String),
      clawd_background: expect.any(String),
    }));
  });

  // The sweep that animates every shimmering surface advances on a 50ms timer
  // and is switched off only by prefersReducedMotion. Every one of these keys
  // is a colour it sweeps toward, so an unset one animates in stock colours.
  it("sets every colour the shimmer animation sweeps toward", () => {
    const { overrides } = readJson(plugin("themes", "codedeck-ultra.json"));
    const shimmering = Object.keys(overrides).filter((key) => key.endsWith("Shimmer"));

    expect(shimmering.sort()).toEqual([
      "autoAcceptShimmer",
      "claudeShimmer",
      "fastModeShimmer",
      "inactiveShimmer",
      "permissionShimmer",
      "promptBorderShimmer",
      "warningShimmer",
    ]);
  });

  // The slug in the theme ref is the FILE BASENAME, not the theme's `name`
  // field: `zzz-alpha.json` named "Bravo Theme" answers to zzz-alpha and
  // ignores bravo-theme. Getting this wrong costs the whole visual identity
  // with no error anywhere, not even under --debug, so the ref is derived
  // from the filesystem here instead of being compared to a second literal.
  it("resolves the theme ref to a file that actually exists", () => {
    const settings = buildSettings("/opt/codedeck/plugin", {}, "general", "m", "xhigh");
    const [prefix, pluginName, slug] = String(settings.theme).split(":");
    const manifest = readJson(plugin(".claude-plugin", "plugin.json"));

    expect(prefix).toBe("custom");
    expect(pluginName).toBe(manifest.name);

    const themeFiles = readdirSync(plugin("themes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));

    expect(themeFiles).toContain(slug);
  });

  // The plugin used to ship a settings.json that `open` passed to --settings.
  // Its status line never ran, because ${CLAUDE_PLUGIN_ROOT} is expanded only
  // for hooks in hooks/hooks.json, and nothing exercised the file. The payload
  // is built at launch now, and a second copy on disk would be free to drift
  // back out of sync in the same silence.
  it("ships no settings file for the launcher to fall back to", () => {
    expect(existsSync(plugin("settings.json"))).toBe(false);
  });

  // ${CLAUDE_PLUGIN_ROOT} is expanded for hooks declared here and nowhere else,
  // which is the whole reason the status line had to stop using it. A hook that
  // spelled the path any other way would not find its own script.
  it("names its hook script through the plugin root", () => {
    const hooks = readJson(plugin("hooks", "hooks.json"));
    const [entry] = hooks.hooks.SessionStart;
    const [promptEntry] = hooks.hooks.UserPromptSubmit;

    expect(entry.hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(entry.hooks[0].command).toContain("session-id.sh");
    expect(existsSync(plugin("hooks", "session-id.sh"))).toBe(true);
    expect(promptEntry.hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(promptEntry.hooks[0].command).toContain("session-name.sh");
    expect(existsSync(plugin("hooks", "session-name.sh"))).toBe(true);
    expect(statSync(plugin("hooks", "session-name.sh")).mode & 0o111).not.toBe(0);
  });

  it("derives a task name once, sanitizes it, and stays silent", async () => {
    const tempDir = mkdtempSync(join(os.tmpdir(), "codedeck-session-name-"));
    const sessionFile = join(tempDir, "session");
    const sessionId = "92d88cce-bdbc-46db-8573-916afd32f6f7";
    const sidecar = `${sessionFile}.${sessionId}.name`;
    const run = (prompt: string) => new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn("bash", [plugin("hooks", "session-name.sh")], {
        env: { ...process.env, CODEDECK_SESSION_FILE: sessionFile },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify({ prompt, session_id: sessionId }));
    });

    try {
      const first = await run(" !!! Fix API / auth retry logic withx a very long tail that must disappear !!! ");
      expect(first.status).toBe(0);
      expect(first.stdout).toBe("");
      expect(first.stderr).toBe("");
      expect(readFileSync(sidecar, "utf8")).toBe("fix-api-auth-retry-logic-withx");

      writeFileSync(sidecar, "keep-this-name");
      const second = await run("replace this name");
      expect(second.status).toBe(0);
      expect(second.stdout).toBe("");
      expect(second.stderr).toBe("");
      expect(readFileSync(sidecar, "utf8")).toBe("keep-this-name");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // The hook runs on the startup path someone is already waiting through, so it
  // stays in the shell. Reaching for node here would cost more than the read.
  it("captures the session id without spawning an interpreter", () => {
    const script = readText(plugin("hooks", "session-id.sh"));
    // Comments name the interpreters to say why they are not used, so the
    // assertion reads what actually runs.
    const code = script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(code).toContain("CODEDECK_SESSION_FILE");
    expect(code).not.toMatch(/\bnode\b|\bpython3?\b|\bjq\b/);
  });

  it("ships an agent file for every role", () => {
    const agents = readdirSync(plugin("agents"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();

    expect(agents).toEqual([
      "auditor",
      "general",
      "orchestrator",
      "orchestrator-edit",
      "orchestrator-read",
      "reviewer",
    ]);
    for (const agent of agents) {
      expect(field(frontmatter(plugin("agents", `${agent}.md`)), "name")).toBe(agent);
    }
  });

  // An agent file with no `tools:` key inherits the whole toolset, which is the
  // only way general keeps Edit and Write. Adding the key would silently take
  // them away, so its absence is the contract.
  it("leaves general's toolset inherited", () => {
    expect(frontmatter(plugin("agents", "general.md"))).not.toMatch(/^tools:/m);
  });

  it("pins tool restrictions for the three constrained roles", () => {
    const tools = (name: string) => field(frontmatter(plugin("agents", `${name}.md`)), "tools");

    for (const name of ["reviewer", "orchestrator", "auditor"]) {
      expect(tools(name), name).not.toMatch(/\b(Edit|Write)\b/);
      expect(tools(name), name).toMatch(/\bBash\b/);
    }

    // The reviewer is the single pass. Dispatching is what separates it from
    // the auditor, so the allowlist has to carry that and not just the prose.
    expect(tools("reviewer")).not.toMatch(/\b(Task|Agent)\b/);
    expect(tools("orchestrator")).toBe("Bash");
    expect(tools("orchestrator")).not.toMatch(/\b(Read|Grep|Glob|Task)\b/);
    expect(tools("auditor")).toMatch(/\bTask\b/);
  });

  it("requires --role on every dispatching role", () => {
    const agents = readdirSync(plugin("agents")).filter((file) => file.endsWith(".md"));
    for (const file of agents) {
      const name = file.replace(/\.md$/, "");
      const path = plugin("agents", `${name}.md`);
      if (/\bTask\b/.test(field(frontmatter(path), "tools"))) {
        expect(agentBody(path), name).toContain("codedeck run --role");
      }
    }
  });

  // ultra.md is appended to every role, so anything role-specific in it
  // contradicts one of them. It carries only what holds for all four.
  it("keeps the shared system prompt universal", () => {
    const ultra = readText(plugin("ultra.md"));

    expect(ultra).toMatch(/never round failure to success/i);
    expect(ultra).toMatch(/evidence over assertion/i);
    expect(ultra).toMatch(/the scope asked for is the deliverable/i);
    expect(ultra).not.toMatch(/\bcodedeck run\b/);
  });

  it("pins the orchestration and review boundaries", () => {
    const orchestrator = readText(plugin("agents", "orchestrator.md"));
    const general = readText(plugin("agents", "general.md"));
    const reviewer = readText(plugin("agents", "reviewer.md"));
    const auditor = readText(plugin("agents", "auditor.md"));
    const statusline = readText(plugin("statusline.sh"));

    expect(orchestrator).toContain('codedeck run --role <role> "<briefing>" --bg --json');
    expect(orchestrator).toContain("Always dispatch in the background.");
    expect(orchestrator).toContain("codedeck diff <id> --stat");
    expect(orchestrator).not.toMatch(/codedeck diff <id>(?! --stat)/);
    expect(orchestrator).toContain("codedeck stop <id>");
    expect(general).toContain('codedeck run --role reviewer --no-worktree "<briefing>"');

    // Both review roles owe the same third list. A shallow pass reported as a
    // complete one is the failure mode neither prompt may drop.
    expect(reviewer).toMatch(/what you did not cover/i);
    expect(auditor).toMatch(/what was not covered/i);
    expect(reviewer).toMatch(/you do not dispatch/i);

    expect(statusline).toContain("JSON.parse");
    expect(statusline).toContain("git");
  });
});
