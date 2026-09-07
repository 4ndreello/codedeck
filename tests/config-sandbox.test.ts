import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CODEX_SANDBOXES, type CodexSandbox } from "../src/core/driver.js";
import {
  loadConfig,
  resolveDefaultSandbox,
  saveConfig,
  type RunAgentConfig,
} from "../src/config/config.js";

const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  process.env.RUN_AGENT_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "codedeck-config-sandbox-test-"));
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
});

describe("default sandbox config", () => {
  it.each(CODEX_SANDBOXES)("round-trips %s without dropping other fields", (defaultSandbox) => {
    const config: RunAgentConfig = {
      defaultAgent: "codex",
      worktree: true,
      defaultModel: "gpt-5.6-luna",
      remoteControl: false,
      defaultSandbox,
      models: {
        claude: "claude-opus-5",
        codex: "gpt-5.6-luna",
      },
      agents: {
        general: { harness: "claude", model: "claude-opus-5" },
        reviewer: { harness: "codex", model: "gpt-5.6-luna" },
      },
      orchestrator: {
        investigate: "free",
        selfWork: "small",
        tools: "edit",
        parallelism: 2,
      },
    };

    saveConfig(config);

    const configFile = path.join(process.env.RUN_AGENT_CONFIG_DIR!, "config.json");
    expect(JSON.parse(fs.readFileSync(configFile, "utf-8"))).toEqual(config);
    // The saved file omits pty, so load layers the DEFAULT_CONFIG default back on.
    expect(loadConfig()).toEqual({ ...config, pty: true });
    expect(resolveDefaultSandbox(loadConfig())).toBe(defaultSandbox);
  });

  it("leaves an unconfigured user without a sandbox value", () => {
    expect(loadConfig()).toEqual({
      defaultAgent: "claude",
      worktree: false,
      remoteControl: true,
      pty: true,
    });
    expect(Object.hasOwn(loadConfig(), "defaultSandbox")).toBe(false);
    expect(resolveDefaultSandbox(loadConfig())).toBeUndefined();
  });

  it.each([
    ["unknown string", "network"],
    ["number", 42],
    ["object", { mode: "danger-full-access" }],
    ["array", ["workspace-write"]],
    ["boolean", true],
    ["null", null],
  ])("treats a malformed %s as unset without rewriting it", (_description, defaultSandbox) => {
    const config = { defaultSandbox } as unknown as RunAgentConfig;
    saveConfig(config);

    expect(() => resolveDefaultSandbox(loadConfig())).not.toThrow();
    expect(resolveDefaultSandbox(loadConfig())).toBeUndefined();
    expect(loadConfig().defaultSandbox).toEqual(defaultSandbox);
  });

  it("accepts every allowlisted sandbox as a configured value", () => {
    for (const sandbox of CODEX_SANDBOXES) {
      expect(resolveDefaultSandbox({ defaultSandbox: sandbox })).toBe(sandbox as CodexSandbox);
    }
  });
});
