import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  effectiveModel,
  judgeModelIn,
  resolveOpenModel,
  resolveRoleBody,
  resolveRoleContract,
} from "../src/open/contract.js";
import type { HarnessModels } from "../src/core/models.js";
import { resolvePluginDir } from "../src/core/roles.js";
import { IpcClient } from "../src/daemon/ipc.js";
import * as claudeLauncher from "../src/open/launchers/claude.js";
import * as linkWatcher from "../src/open/link-watcher.js";
import * as runtime from "../src/open/runtime.js";
import { setupOpenHarness } from "./helpers/open-harness.js";

const catalog = (models: string[]): HarnessModels => ({
  agent: "opencode",
  available: true,
  providers: [
    {
      provider: "prov",
      displayName: "Prov",
      models: models.map((id) => ({ id, name: id, provider: "prov" })),
    },
  ],
});

const pluginDir = resolvePluginDir();
const { runOpen } = setupOpenHarness({ prefix: "codedeck-open-link-contract-" });

function runClaudeOpen(argv: string[]): Promise<void> {
  const configDir = process.env.RUN_AGENT_CONFIG_DIR;
  if (!configDir) throw new Error("test config directory is missing");
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    agents: { reviewer: { harness: "claude", model: "claude-sonnet-4-6", effort: "high" } },
  }));
  vi.spyOn(claudeLauncher, "preflightModel").mockResolvedValue(undefined);
  vi.spyOn(claudeLauncher, "resolveBinary").mockResolvedValue("/bin/claude");
  vi.spyOn(claudeLauncher, "assertSupport").mockResolvedValue(undefined);
  return runOpen(argv);
}

afterEach(() => {
  delete process.env.CODEDECK_CLI_NAME;
});

describe("resolveRoleContract", () => {
  it("returns the agent body without frontmatter plus the ultra text", () => {
    const { agentBody, ultra } = resolveRoleContract(pluginDir, "reviewer");

    expect(agentBody).toContain("CodeDeck reviewer");
    expect(agentBody).not.toContain("tools:");
    expect(ultra).toContain("Never round failure to success");
  });

  it("selects orchestrator variant according to tools mode", () => {
    const dispatch = resolveRoleContract(pluginDir, "orchestrator", {
      investigate: "none",
      selfWork: "none",
      tools: "dispatch",
    });
    expect(dispatch.agentBody).toContain("Bash is your dispatch console");

    const read = resolveRoleContract(pluginDir, "orchestrator", {
      investigate: "none",
      selfWork: "none",
      tools: "read",
    });
    expect(read.agentBody).not.toContain("Bash is your dispatch console");

    const edit = resolveRoleContract(pluginDir, "orchestrator", {
      investigate: "none",
      selfWork: "none",
      tools: "edit",
    });
    expect(edit.agentBody).not.toContain("Bash is your dispatch console");
  });

  it("keeps the ultra text out of the open agent body", () => {
    for (const role of ["general", "reviewer"] as const) {
      const { agentBody, ultra } = resolveRoleContract(pluginDir, role);

      expect(agentBody).not.toContain("You are running inside a CodeDeck session");
      expect(ultra).toContain("Never round failure to success");
    }
  });

  it("fails loud when the agent file is missing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-contract-"));
    try {
      expect(() => resolveRoleContract(empty, "reviewer")).toThrow(/no agent file/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails loud when ultra.md is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-contract-"));
    try {
      fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
      fs.copyFileSync(
        path.join(pluginDir, "agents", "reviewer.md"),
        path.join(dir, "agents", "reviewer.md"),
      );
      expect(() => resolveRoleContract(dir, "reviewer")).toThrow(/ultra prompt not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Hand-edited agent files can carry a leading blank line or BOM before the
  // delimiter. Without the pre-strip the anchored match misses and `tools:`
  // lands in the prompt as prose.
  it.each([
    ["a leading blank line", "\n---\nname: reviewer\ntools: Read, Bash\n---\n\nYou review.\n"],
    ["a leading BOM", "\uFEFF---\nname: reviewer\ntools: Read, Bash\n---\n\nYou review.\n"],
  ])("strips frontmatter after %s", (_label, source) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-contract-"));
    try {
      fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agents", "reviewer.md"), source);

      expect(resolveRoleBody(dir, "reviewer")).toBe("You review.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveOpenModel", () => {
  it("lets an explicit flag win over the binding", () => {
    const config = { agents: { reviewer: { harness: "opencode", model: "prov/bound" } } } as any;

    expect(resolveOpenModel("reviewer", { model: "prov/flag" }, config)).toEqual({
      model: "prov/flag",
      fromConfig: false,
    });
  });

  it("uses the binding model and marks it from config", () => {
    const config = { agents: { reviewer: { harness: "opencode", model: "prov/bound" } } } as any;

    expect(resolveOpenModel("reviewer", {}, config)).toEqual({
      model: "prov/bound",
      fromConfig: true,
    });
  });

  it("falls back to the harness config model", () => {
    const config = { models: { claude: "claude-sonnet" } } as any;

    expect(resolveOpenModel("general", {}, config)).toEqual({
      model: "claude-sonnet",
      fromConfig: true,
    });
  });

  it("leaves the model undefined for the launcher default", () => {
    expect(resolveOpenModel("general", {}, {})).toEqual({ model: undefined, fromConfig: false });
  });
});

describe("judgeModelIn", () => {
  it("accepts a model the catalog lists", () => {
    expect(judgeModelIn(catalog(["prov/a"]), "prov/a", false, "opencode")).toEqual({ kind: "ok" });
  });

  it("warns and continues when the catalog is missing", () => {
    expect(judgeModelIn(undefined, "prov/a", false, "opencode")).toEqual({
      kind: "unknown-catalog",
      warning: 'Warning: opencode model catalog is unavailable; continuing with "prov/a".',
    });
  });

  it("warns and continues when the catalog is empty", () => {
    expect(judgeModelIn(catalog([]), "prov/a", false, "opencode")).toEqual({
      kind: "unknown-catalog",
      warning: 'Warning: opencode model catalog is empty; continuing with "prov/a".',
    });
  });

  it("rejects an unknown model with suggestion and config recovery", () => {
    expect(judgeModelIn(catalog(["prov/abc"]), "prov/abd", true, "opencode")).toEqual({
      kind: "rejected",
      error:
        'Model "prov/abd" is not in the opencode catalog. Did you mean "prov/abc"? Run `codedeck setup` to pick another.',
    });
  });

  it("names the renamed CLI in the config recovery hint", () => {
    process.env.CODEDECK_CLI_NAME = "codedeck-dev";

    expect(judgeModelIn(catalog(["prov/abc"]), "prov/abd", true, "opencode")).toEqual({
      kind: "rejected",
      error:
        'Model "prov/abd" is not in the opencode catalog. Did you mean "prov/abc"? Run `codedeck-dev setup` to pick another.',
    });
  });

  it("names the harness in the verdict", () => {
    const verdict = judgeModelIn(catalog(["prov/abc"]), "prov/abd", false, "Claude");

    expect(verdict).toEqual({
      kind: "rejected",
      error:
        'Model "prov/abd" is not in the Claude catalog. Did you mean "prov/abc"?',
    });
  });
});

describe("effectiveModel", () => {
  it("reads the last --model when both spellings are present", () => {
    expect(effectiveModel(["--model", "bad", "--model=good"])).toBe("good");
  });

  it("returns undefined when the passthrough carries no model", () => {
    expect(effectiveModel(["--add-dir", "other"])).toBeUndefined();
  });
});

describe("open native session linking", () => {
  it("links every sidecar id before releasing the Claude row", async () => {
    const nativeId = "92d88cce-bdbc-46db-8573-916afd32f6f7";
    await runClaudeOpen(["reviewer", "--no-theme", "--no-worktree"]);

    const [, , options] = vi.mocked(runtime.spawnHarness).mock.calls[0]!;
    fs.writeFileSync(options.sessionFile, `${nativeId}\n`);
    await options.onClose();

    const lifecycleCalls = vi.mocked(IpcClient.prototype.request).mock.calls
      .filter(([method]) => method === "session.linkNative" || method === "session.release");
    expect(lifecycleCalls.map(([method]) => method)).toEqual([
      "session.linkNative",
      "session.release",
    ]);
    expect(lifecycleCalls[0]?.[1]).toEqual({ id: "0001", nativeId });
  });

  it("stops the watcher and releases the session when flush rejects", async () => {
    const events: string[] = [];
    const nativeWatcher = {
      flush: vi.fn(async () => {
        events.push("flush");
        throw new Error("link failed");
      }),
      stop: vi.fn(() => {
        events.push("stop");
      }),
    };
    vi.spyOn(linkWatcher, "startLinkWatcher").mockReturnValue(nativeWatcher);
    vi.mocked(runtime.finishOpenSession).mockImplementation(() => {
      events.push("finish");
    });

    await runClaudeOpen(["reviewer", "--no-theme", "--no-worktree"]);
    const [, , options] = vi.mocked(runtime.spawnHarness).mock.calls[0]!;
    await options.onClose();

    expect(events).toEqual(["flush", "stop", "finish"]);
    expect(vi.mocked(IpcClient.prototype.request).mock.calls.map(([method]) => method))
      .toContain("session.release");
  });
});
