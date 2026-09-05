import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadConfig,
  resolveModel,
  resolveRoleBinding,
  saveConfig,
  type RunAgentConfig,
} from "../src/config/config.js";

const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  process.env.RUN_AGENT_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "codedeck-config-test-"));
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
});

describe("resolveModel", () => {
  const config: RunAgentConfig = {
    defaultModel: "legacy-default",
    models: {
      claude: "claude-configured",
      codex: "codex-configured",
    },
  };

  it("uses explicit, per-agent, legacy, then driver precedence", () => {
    expect(resolveModel("claude", "explicit", config)).toBe("explicit");
    expect(resolveModel("claude", undefined, config)).toBe("claude-configured");
    expect(resolveModel("omp", undefined, config)).toBe("legacy-default");
    expect(resolveModel("opencode", undefined, {})).toBeUndefined();
  });
});

describe("resolveRoleBinding", () => {
  const config: RunAgentConfig = {
    agents: {
      reviewer: { harness: "codex", model: "gpt-5.6-luna" },
      general: { harness: "claude", model: "claude-opus-5" },
    },
  };

  it("returns the harness and model saved for the agent", () => {
    expect(resolveRoleBinding("reviewer", config)).toEqual({
      harness: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("returns nothing for an agent nobody configured, or for no agent at all", () => {
    expect(resolveRoleBinding("auditor", config)).toBeUndefined();
    expect(resolveRoleBinding(undefined, config)).toBeUndefined();
    expect(resolveRoleBinding("reviewer", {})).toBeUndefined();
  });

  // A binding is only usable whole. Half of one, hand-edited into the file,
  // would otherwise resolve to a harness with no model or the reverse.
  it("refuses a half-written binding instead of guessing the other half", () => {
    const broken = {
      agents: {
        reviewer: { harness: "codex" },
        auditor: { model: "gpt-5.6-luna" },
      },
    } as RunAgentConfig;

    expect(resolveRoleBinding("reviewer", broken)).toBeUndefined();
    expect(resolveRoleBinding("auditor", broken)).toBeUndefined();
  });
});

describe("config model persistence", () => {
  it("round-trips models through the isolated config directory", () => {
    const config: RunAgentConfig = {
      defaultAgent: "codex",
      worktree: true,
      defaultModel: "legacy-default",
      models: {
        claude: "claude-configured",
        codex: "codex-configured",
      },
    };

    saveConfig(config);

    const configFile = path.join(process.env.RUN_AGENT_CONFIG_DIR!, "config.json");
    expect(fs.existsSync(configFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configFile, "utf-8"))).toEqual(config);
    expect(loadConfig()).toEqual(config);
  });

  it("keeps defaultModel as the fallback for legacy configs", () => {
    saveConfig({ defaultModel: "legacy-default" });

    expect(loadConfig().defaultModel).toBe("legacy-default");
    expect(resolveModel("omp", undefined, loadConfig())).toBe("legacy-default");
  });

  it("round-trips the per-agent bindings setup writes", () => {
    const config: RunAgentConfig = {
      defaultAgent: "claude",
      worktree: false,
      agents: {
        general: { harness: "claude", model: "claude-opus-4-8" },
        reviewer: { harness: "codex", model: "gpt-5.6-luna" },
      },
    };

    saveConfig(config);

    expect(loadConfig()).toEqual(config);
    expect(resolveRoleBinding("reviewer", loadConfig())).toEqual({
      harness: "codex",
      model: "gpt-5.6-luna",
    });
  });
});
