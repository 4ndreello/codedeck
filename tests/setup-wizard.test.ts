import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriverRegistry } from "../src/core/driver.js";
import type { HarnessModels } from "../src/core/models.js";
import type { AgentId } from "../src/core/session.js";
import { loadConfig } from "../src/config/config.js";
import {
  buildAgentScreen,
  buildScreens,
  collectSelections,
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

describe("needsModelSetup", () => {
  it("only asks on a TTY when models are absent", () => {
    expect(needsModelSetup({ defaultAgent: "claude" }, true)).toBe(true);
    expect(needsModelSetup({ defaultAgent: "claude", models: {} }, true)).toBe(false);
    expect(needsModelSetup({ defaultAgent: "claude", models: { claude: "sonnet" } }, true)).toBe(false);
    expect(needsModelSetup({ defaultAgent: "claude" }, false)).toBe(false);
  });
});

describe("runModelSetupWizard", () => {
  function io() {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (value: boolean) => unknown;
    };
    input.isTTY = true;
    input.setRawMode = () => input;

    const output = new PassThrough() as PassThrough & { rows?: number; columns?: number };
    output.rows = 40;
    output.columns = 80;
    const seen: string[] = [];
    output.on("data", (chunk) => seen.push(String(chunk)));

    return { input, output, seen };
  }

  /**
   * Sends the next key only once a frame has been painted. A key written before
   * the picker attaches its listener would be dropped by the resumed stream.
   */
  function drive(input: PassThrough, output: PassThrough, keys: string[]): void {
    let next = 0;
    output.on("data", (chunk) => {
      if (!String(chunk).includes("agente")) return;
      if (next >= keys.length) return;
      const key = keys[next++];
      setImmediate(() => input.write(key));
    });
  }

  const base = () => ({
    config: { defaultAgent: "claude" as const, worktree: false },
    registry: {} as DriverRegistry,
    isTTY: true,
    discoverModels: async () => discoveredHarnesses(),
  });

  it("does not discover, prompt, or write when the streams are not a terminal", async () => {
    const discoverModels = vi.fn(async () => discoveredHarnesses());
    const save = vi.fn();
    const config = { defaultAgent: "claude" as const };

    const result = await runModelSetupWizard({ config, isTTY: false, discoverModels, save });

    expect(result).toBe(config);
    expect(discoverModels).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  // Discovery blocks for seconds, so silence there reads as a freeze.
  it("says it is discovering before it blocks on discovery", async () => {
    const { input, output, seen } = io();
    drive(input, output, ["\x03"]);

    await runModelSetupWizard({ ...base(), input, output });

    expect(seen[0]).toContain("discovering models");
  });

  it("passes refresh through to discovery", async () => {
    const { input, output } = io();
    const discoverModels = vi.fn(async () => discoveredHarnesses());
    drive(input, output, ["\x03"]);

    await runModelSetupWizard({ ...base(), input, output, refresh: true, discoverModels });

    expect(discoverModels).toHaveBeenCalledWith(expect.anything(), true);
  });

  // Two screens: claude has a catalog, omp reports none and only takes a typed
  // id, which needs a second Enter because no catalog can vouch for it.
  it("persists one pick per agent and writes the config", async () => {
    const { input, output } = io();
    drive(input, output, ["\r", "c", "u", "s", "t", "o", "m", "\r", "\r"]);

    const result = await runModelSetupWizard({ ...base(), input, output });

    expect(result.models).toEqual({ claude: "claude-opus", omp: "custom" });
    expect(result.models).not.toHaveProperty("codex");
    expect(loadConfig()).toEqual(result);
  });

  it("leaves an agent unset when it is skipped", async () => {
    const { input, output } = io();
    drive(input, output, ["\r", "\x07"]);

    const result = await runModelSetupWizard({ ...base(), input, output });

    expect(result.models).toEqual({ claude: "claude-opus" });
  });

  it("warns and continues when config persistence fails", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const { input, output } = io();
    drive(input, output, ["\r", "\x07"]);

    try {
      const result = await runModelSetupWizard({
        ...base(),
        input,
        output,
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

  // Walking out is not an answer, so nothing is written and the next run gets
  // to ask again.
  it("writes nothing when the run is aborted", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn();
    const { input, output } = io();
    drive(input, output, ["\x03"]);

    try {
      const result = await runModelSetupWizard({ ...base(), input, output, save });

      expect(save).not.toHaveBeenCalled();
      expect(result.models).toBeUndefined();
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
    const { input, output } = io();

    try {
      const result = await runModelSetupWizard({
        ...base(),
        input,
        output,
        save,
        discoverModels: async () => [],
      });

      expect(save).not.toHaveBeenCalled();
      expect(result.models).toBeUndefined();
      expect(needsModelSetup(result, true)).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  it("leaves the config alone on a terminal too short to draw", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn();
    const { input, output } = io();
    output.rows = 5;

    try {
      const result = await runModelSetupWizard({ ...base(), input, output, save });

      expect(save).not.toHaveBeenCalled();
      expect(result.models).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("5 rows"));
    } finally {
      warning.mockRestore();
    }
  });
});

const harness = (agent: AgentId, providers: Array<[string, string[]]>, defaults: string[] = []): HarnessModels => ({
  agent,
  available: true,
  providers: providers.map(([provider, ids]) => ({
    provider,
    models: ids.map((id) => ({ id, name: id, provider, isDefault: defaults.includes(id) })),
  })),
});

describe("agent screens", () => {
  it("gives one screen per installed harness, numbered", () => {
    const screens = buildScreens(
      [harness("claude", [["anthropic", ["a"]]]), { agent: "codex", available: false, providers: [] }],
      {},
    );

    expect(screens).toHaveLength(1);
    expect(screens[0].counter).toBe("agente 1 de 1");
  });

  // A linha fixa fica fora do agrupamento, senao ela contradiz a ordem dos providers.
  it("pins the configured model above the groups and marks it atual", () => {
    const screen = buildAgentScreen(harness("opencode", [["a", ["a/1"]], ["b", ["b/2"]]]), 0, 1, "b/2");

    expect(screen.pinned).toBe(true);
    expect(screen.items[0]).toMatchObject({ id: "b/2", note: "atual" });
    expect(screen.items[0].group).toBeUndefined();
  });

  it("pins a real isDefault and marks it padrao", () => {
    const screen = buildAgentScreen(harness("claude", [["anthropic", ["x", "y"]]], ["y"]), 0, 1);

    expect(screen.items[0]).toMatchObject({ id: "y", note: "padrao" });
  });

  // omp e opencode nao declaram isDefault: ids[0] e acidente alfabetico.
  it("pins nothing when neither config nor isDefault exists", () => {
    const screen = buildAgentScreen(harness("omp", [["bedrock", ["a", "b"]]]), 0, 1);

    expect(screen.pinned).toBe(false);
    expect(screen.items[0].note).toBeUndefined();
  });

  it("keeps a harness with an empty catalog on screen with nothing to list", () => {
    const screen = buildAgentScreen({ agent: "omp", available: true, providers: [] }, 1, 3);

    expect(screen.items).toEqual([]);
    expect(screen.counter).toBe("agente 2 de 3");
  });

  it("carries the discovery error so an empty list is not mistaken for no models", () => {
    const screen = buildAgentScreen(
      { agent: "omp", available: true, error: "discovery timed out", providers: [] },
      0,
      1,
    );

    expect(screen.error).toBe("discovery timed out");
  });

  it("counts an id once even when two providers report it", () => {
    const screen = buildAgentScreen(harness("opencode", [["a", ["dup"]], ["b", ["dup"]]]), 0, 1);

    expect(screen.items.filter((item) => item.id === "dup")).toHaveLength(1);
  });

  it("lists every model, with no cap", () => {
    const many = Array.from({ length: 600 }, (_, i) => `m-${i}`);

    expect(buildAgentScreen(harness("opencode", [["p", many]]), 0, 1).items).toHaveLength(600);
  });

  // A blank id used to become a selectable blank row that Enter saved as the model.
  it("drops a model whose id is blank", () => {
    const screen = buildAgentScreen(harness("opencode", [["p", ["", "   ", "real"]]]), 0, 1);

    expect(screen.items.map((item) => item.id)).toEqual(["real"]);
    expect(screen.known.has("")).toBe(false);
  });

  // open tells the user their saved model left the catalog and to run setup.
  // Setup then has to show which model that was.
  it("still pins a configured model the catalog no longer lists", () => {
    const screen = buildAgentScreen(harness("codex", [["openai", ["gpt-6"]]]), 0, 1, "gpt-retired");

    expect(screen.pinned).toBe(true);
    expect(screen.items[0]).toMatchObject({ id: "gpt-retired", note: "atual, fora do catalogo" });
    // Synthetic, so keeping it costs the same second Enter as typing it by hand.
    expect(screen.items[0].synthetic).toBe(true);
    expect(screen.known.has("gpt-retired")).toBe(false);
  });
});

describe("collecting selections", () => {
  it("writes what was picked", () => {
    expect(collectSelections([{ kind: "picked", agent: "claude", id: "x" }], undefined, 1)).toEqual({
      models: { claude: "x" },
      write: true,
    });
  });

  // Pular significa "nao mexe", nunca "desconfigura".
  it("leaves an earlier choice untouched when the agent is skipped", () => {
    expect(collectSelections([{ kind: "skipped", agent: "codex" }], { codex: "gpt-x" }, 1)).toEqual({
      models: { codex: "gpt-x" },
      write: true,
    });
  });

  it("writes the empty sentinel when everything was skipped and nothing was configured", () => {
    expect(collectSelections([{ kind: "skipped", agent: "claude" }], undefined, 1)).toEqual({
      models: {},
      write: true,
    });
  });

  // Sem tela mostrada, gravar queimaria a unica pergunta que o usuario recebe.
  it("writes nothing when no screen was shown at all", () => {
    expect(collectSelections([], undefined, 0)).toEqual({ models: {}, write: false });
  });

  it("writes nothing when the run was aborted", () => {
    expect(collectSelections([{ kind: "aborted" }], { claude: "keep" }, 2)).toEqual({
      models: { claude: "keep" },
      write: false,
    });
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

  // The cache holds for four hours, so rediscovery needs a way in.
  it("offers a refresh flag that ignores the cached catalog", () => {
    const program = new Command();
    registerSetupCommand(program);

    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup?.options.map((option) => option.long)).toContain("--refresh");
  });
});
