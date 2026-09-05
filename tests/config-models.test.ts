import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadConfig,
  resolveModel,
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
});
