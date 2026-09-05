import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriverRegistry } from "../src/core/driver.js";
import type { HarnessModels } from "../src/core/models.js";
import { loadConfig } from "../src/config/config.js";
import {
  needsModelSetup,
  registerSetupCommand,
  runModelSetupWizard,
} from "../src/cli/commands/setup.js";

const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  process.env.RUN_AGENT_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "codedeck-wizard-test-"));
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
});

function discoveredHarnesses(): HarnessModels[] {
  return [
    {
      agent: "claude",
      available: true,
      providers: [
        {
          provider: "anthropic",
          models: [
            { id: "claude-sonnet", name: "Sonnet", provider: "anthropic" },
            { id: "claude-opus", name: "Opus", provider: "anthropic", isDefault: true },
          ],
        },
      ],
    },
    {
      agent: "codex",
      available: false,
      error: "codex binary not found",
      providers: [],
    },
    {
      agent: "omp",
      available: true,
      providers: [],
    },
  ];
}

function scriptedInput(lines: string): PassThrough {
  const input = new PassThrough();
  const answers = lines.split("\n");
  setImmediate(() => {
    const writeNext = (index: number): void => {
      if (index >= answers.length) {
        input.end();
        return;
      }
      input.write(`${answers[index]}\n`);
      setImmediate(() => writeNext(index + 1));
    };
    writeNext(0);
  });
  return input;
}

describe("needsModelSetup", () => {
  it("only asks on a TTY when models are absent", () => {
    expect(needsModelSetup({ defaultAgent: "claude" }, true)).toBe(true);
    expect(needsModelSetup({ defaultAgent: "claude", models: {} }, true)).toBe(false);
    expect(needsModelSetup({ defaultAgent: "claude", models: { claude: "sonnet" } }, true)).toBe(false);
    expect(needsModelSetup({ defaultAgent: "claude" }, false)).toBe(false);
  });
});

describe("runModelSetupWizard", () => {
  it("does not discover, prompt, or write when stdout is not a TTY", async () => {
    let discovered = false;
    let saved = false;
    const config = { defaultAgent: "claude" as const };

    const result = await runModelSetupWizard({
      config,
      isTTY: false,
      discoverModels: async () => {
        discovered = true;
        return [];
      },
      save: () => {
        saved = true;
      },
    });

    expect(result).toBe(config);
    expect(discovered).toBe(false);
    expect(saved).toBe(false);
  });

  it("offers installed harnesses, allows manual ids, and persists choices", async () => {
    const input = scriptedInput("2\nopenrouter/custom-model\n");
    const output = new PassThrough();

    const result = await runModelSetupWizard({
      config: { defaultAgent: "claude", worktree: false },
      registry: {} as DriverRegistry,
      input,
      output,
      isTTY: true,
      discoverModels: async () => discoveredHarnesses(),
    });

    expect(result.models).toEqual({
      claude: "claude-opus",
      omp: "openrouter/custom-model",
    });
    expect(result.models).not.toHaveProperty("codex");
    expect(loadConfig()).toEqual(result);
  });

  it("warns and continues when config persistence fails", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runModelSetupWizard({
        config: { defaultAgent: "claude" },
        registry: {} as DriverRegistry,
        input: scriptedInput("\n\n"),
        output: new PassThrough(),
        isTTY: true,
        discoverModels: async () => discoveredHarnesses(),
        save: () => {
          throw new Error("read-only config directory");
        },
      });

      expect(result.models).toEqual({ claude: "claude-opus" });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Could not save config"));
    } finally {
      warning.mockRestore();
    }
  });

  // `readline/promises` question() never settles once the interface closes, so
  // Ctrl+D at a prompt used to leave the wizard hanging with no way out.
  it("gives up instead of hanging when stdin closes mid-question", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn();
    try {
      const config = { defaultAgent: "claude" as const };
      const closed = new PassThrough();
      closed.end();

      const result = await runModelSetupWizard({
        config,
        registry: {} as DriverRegistry,
        input: closed,
        output: new PassThrough(),
        isTTY: true,
        discoverModels: async () => discoveredHarnesses(),
        save,
      });

      // Half an answer is not an answer, so nothing is written and the next run
      // gets to ask again.
      expect(save).not.toHaveBeenCalled();
      expect(result).toEqual(config);
      expect(needsModelSetup(result, true)).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("interrupted"));
    } finally {
      warning.mockRestore();
    }
  });

  // Writing `models` is the flag that first-run setup already happened. Writing
  // it after asking nothing would spend the single prompt the user ever gets.
  it("leaves the config untouched when no agent had anything to offer", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn();
    try {
      const config = { defaultAgent: "claude" as const };
      const result = await runModelSetupWizard({
        config,
        registry: {} as DriverRegistry,
        input: scriptedInput(""),
        output: new PassThrough(),
        isTTY: true,
        discoverModels: async () => [],
        save,
      });

      expect(save).not.toHaveBeenCalled();
      expect(result).toEqual(config);
      expect(result.models).toBeUndefined();
      expect(needsModelSetup(result, true)).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });
});

describe("setup command", () => {
  it("registers setup without requiring arguments", () => {
    const program = new Command();
    registerSetupCommand(program);

    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup).toBeDefined();
    expect(setup?.registeredArguments).toHaveLength(0);
  });
});
