import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BALANCED_PRESET,
  DISPATCHER_PRESET,
  EXPLORER_PRESET,
  isOrchestratorMode,
  orchestratorModeLabel,
  resolveOrchestratorMode,
  saveConfig,
  type OrchestratorMode,
  type RunAgentConfig,
} from "../src/config/config.js";
import { loadConfig } from "../src/config/config.js";

const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  process.env.RUN_AGENT_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "codedeck-orchestrator-test-"));
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
});

describe("orchestratorModeLabel", () => {
  it.each([
    ["dispatcher", DISPATCHER_PRESET],
    ["balanced", BALANCED_PRESET],
    ["explorer", EXPLORER_PRESET],
  ])("labels the %s preset", (label, mode) => {
    expect(orchestratorModeLabel(mode)).toBe(label);
  });

  it("labels a non-preset parameter bundle custom", () => {
    expect(
      orchestratorModeLabel({ investigate: "read", selfWork: "none", tools: "edit" }),
    ).toBe("custom");
  });

  it("requires parallelism to be absent for a fixed preset label", () => {
    expect(
      orchestratorModeLabel({ ...DISPATCHER_PRESET, parallelism: 2 }),
    ).toBe("custom");
  });
});

describe("orchestrator mode resolution", () => {
  it("defaults an absent block to dispatcher", () => {
    expect(resolveOrchestratorMode({})).toEqual(DISPATCHER_PRESET);
  });

  it("returns a valid configured mode without adding a preset label", () => {
    const configured: OrchestratorMode = {
      investigate: "free",
      selfWork: "none",
      tools: "read",
      parallelism: 3,
    };

    expect(resolveOrchestratorMode({ orchestrator: configured })).toEqual(configured);
    expect(orchestratorModeLabel(configured)).toBe("custom");
  });

  it("validates values and positive finite parallelism", () => {
    expect(isOrchestratorMode(DISPATCHER_PRESET)).toBe(true);
    expect(isOrchestratorMode({ investigate: "deep", selfWork: "none", tools: "dispatch" })).toBe(false);
    expect(isOrchestratorMode({ investigate: "none", selfWork: "none", tools: "dispatch", parallelism: 0 })).toBe(false);
    expect(isOrchestratorMode({ investigate: "none", selfWork: "none", tools: "dispatch", parallelism: Infinity })).toBe(false);
  });

  it("falls back to dispatcher for an invalid configured block", () => {
    const invalid = {
      orchestrator: { investigate: "none", selfWork: "none", tools: "dispatch", parallelism: 0 },
    } as unknown as RunAgentConfig;

    expect(resolveOrchestratorMode(invalid)).toEqual(DISPATCHER_PRESET);
  });
});

describe("orchestrator config persistence", () => {
  it.each([
    ["without parallelism", { investigate: "read", selfWork: "trivial", tools: "edit" }],
    ["with parallelism", { investigate: "free", selfWork: "small", tools: "edit", parallelism: 3 }],
  ])("round-trips the orchestrator block %s", (_description, orchestrator) => {
    const config: RunAgentConfig = {
      defaultAgent: "claude",
      worktree: true,
      remoteControl: true,
      defaultModel: "legacy-default",
      orchestrator,
    };

    saveConfig(config);

    const configFile = path.join(process.env.RUN_AGENT_CONFIG_DIR!, "config.json");
    expect(JSON.parse(fs.readFileSync(configFile, "utf-8"))).toEqual(config);
    expect(loadConfig()).toEqual(config);

    const loadedBlock = loadConfig().orchestrator!;
    expect(Object.hasOwn(loadedBlock, "parallelism")).toBe(Object.hasOwn(orchestrator, "parallelism"));
  });
});
