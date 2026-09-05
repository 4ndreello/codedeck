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
  buildModelMenu,
  buildScreens,
  collectSelections,
  needsModelSetup,
  parseModelSelection,
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

  it("answers every agent from one line and persists the choices", async () => {
    const input = scriptedInput("2 omp=openrouter/custom-model");
    const output = new PassThrough();

    const result = await runModelSetupWizard({
      config: { defaultAgent: "claude", worktree: false },
      registry: {} as DriverRegistry,
      input,
      output,
      isTTY: true,
      width: 80,
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
        input: scriptedInput(""),
        output: new PassThrough(),
        isTTY: true,
        width: 80,
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

const bulkHarness = (count: number): HarnessModels => ({
  agent: "claude",
  available: true,
  providers: [
    {
      provider: "anthropic",
      models: Array.from({ length: count }, (_, index) => ({
        id: `claude-a-rather-long-model-name-${index}`,
        name: "m",
        provider: "anthropic",
      })),
    },
  ],
});

describe("model menu", () => {
  const menu = () => buildModelMenu(discoveredHarnesses(), {}, 80);

  // Numbers restarting per agent would make a single input line ambiguous.
  it("numbers straight through every agent", () => {
    const { choices, agents } = menu();

    expect(agents).toEqual(["claude", "omp"]);
    expect(choices.map((choice) => choice.number)).toEqual([1, 2]);
    expect(choices).toEqual([
      { number: 1, agent: "claude", model: "claude-sonnet" },
      { number: 2, agent: "claude", model: "claude-opus" },
    ]);
  });

  it("skips an agent that is not installed", () => {
    expect(menu().agents).not.toContain("codex");
  });

  // An agent whose discovery came back empty still has to be visible, or the
  // user cannot tell it from one that is not installed.
  it("keeps an agent with no models on screen and names the way to set it", () => {
    const { screen, defaults } = menu();

    expect(screen).toContain("omp");
    expect(screen).toContain("omp=<id>");
    expect(defaults.omp).toBeUndefined();
  });

  it("offers the harness default and says Enter takes it", () => {
    const { screen, defaults } = menu();

    expect(defaults.claude).toBe("claude-opus");
    expect(screen).toContain("Enter = claude-opus");
  });

  // The old list was joined with two spaces and left to the terminal, which
  // wrapped mid-id: "c" on one line and "laude-sonnet-4-5" on the next.
  it("never lets a line run past the width it was given", () => {
    const wide = buildModelMenu([bulkHarness(14)], {}, 60);

    for (const line of wide.screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  // A pty with no window size reports 0, and taking that literally left one
  // model per line no matter how wide the terminal actually was.
  it("falls back to a usable width when the terminal reports none", () => {
    const zero = buildModelMenu([bulkHarness(8)], {}, 0);

    const rows = zero.screen.split("\n").filter((line) => /^\s+\d+ claude-a-rather/.test(line));

    expect(rows).toHaveLength(4);
  });

  // opencode proxies the whole OpenRouter catalog. Printing it scrolled every
  // other agent off the screen.
  it("shortlists a catalog too long to read and says how to reach the rest", () => {
    const huge = buildModelMenu([bulkHarness(600)], {}, 80);

    expect(huge.choices).toHaveLength(16);
    expect(huge.screen).toContain("+584 more, type claude=<id>");
  });
});

describe("model selection", () => {
  const menu = () => buildModelMenu(discoveredHarnesses(), {}, 80);

  it("takes every default when the line is empty", () => {
    expect(parseModelSelection("", menu())).toEqual({ ok: true, models: {} });
    expect(parseModelSelection("   ", menu())).toEqual({ ok: true, models: {} });
  });

  it("answers two agents from one line", () => {
    expect(parseModelSelection("1 omp=custom/thing", menu())).toEqual({
      ok: true,
      models: { claude: "claude-sonnet", omp: "custom/thing" },
    });
  });

  it("accepts a bare id when exactly one agent offers it", () => {
    expect(parseModelSelection("claude-opus", menu())).toEqual({
      ok: true,
      models: { claude: "claude-opus" },
    });
  });

  it.each([
    ["a number nobody listed", "99", /no 99 on the list/],
    ["an id nobody listed", "gpt-9", /<agent>=gpt-9/],
    ["an agent that is not installed", "codex=gpt-9", /not an installed agent/],
    ["an agent named with no model", "omp=", /No model given/],
    ["two models for one agent", "1 2", /Two models given for Claude Code/],
  ])("refuses %s and says why", (_label, answer, expected) => {
    const verdict = parseModelSelection(answer, menu());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.error).toMatch(expected);
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
});
