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
import { itemKey } from "../src/cli/picker-state.js";
import {
  buildRoleScreen,
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
    // A second installed harness with a catalog of its own, so the flat list
    // really spans two of them and a screen can be answered with either.
    {
      agent: "omp",
      available: true,
      providers: [
        {
          provider: "openai",
          models: [{ id: "omp-fast", name: "Fast", provider: "openai" }],
        },
      ],
    },
  ];
}

describe("needsModelSetup", () => {
  it("only asks on a TTY when the agent bindings are absent", () => {
    expect(needsModelSetup({ defaultAgent: "claude" }, true)).toBe(true);
    expect(needsModelSetup({ defaultAgent: "claude", agents: {} }, true)).toBe(false);
    expect(
      needsModelSetup(
        { defaultAgent: "claude", agents: { general: { harness: "claude", model: "opus" } } },
        true,
      ),
    ).toBe(false);
    expect(needsModelSetup({ defaultAgent: "claude" }, false)).toBe(false);
  });

  // The per-harness map answers "what model does codex run", never "what runs
  // the reviewer", so a config holding only that has not been through setup.
  it("still asks when only the older per-harness models are saved", () => {
    expect(needsModelSetup({ defaultAgent: "claude", models: { claude: "sonnet" } }, true)).toBe(true);
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

  // Four screens, one per agent, each spanning claude and omp. The second is
  // typed by hand and needs a second Enter because no catalog vouches for it.
  it("persists one harness and model per agent, and writes the config", async () => {
    const { input, output } = io();
    drive(input, output, ["\r", ...[..."omp:custom"], "\r", "\r", "\r", "\r"]);

    const result = await runModelSetupWizard({ ...base(), input, output });

    expect(result.agents).toEqual({
      general: { harness: "claude", model: "claude-opus" },
      orchestrator: { harness: "omp", model: "custom" },
      reviewer: { harness: "claude", model: "claude-opus" },
      auditor: { harness: "claude", model: "claude-opus" },
    });
    expect(loadConfig()).toEqual(result);
  });

  // Two harnesses on one screen, so the answer for an agent can come from
  // either. Picking the pin every time would prove nothing about the second.
  it("binds an agent to a harness other than the default one", async () => {
    const { input, output } = io();
    drive(input, output, ["\x1b[B", "\x1b[B", "\r", "\r", "\r", "\r"]);

    const result = await runModelSetupWizard({ ...base(), input, output });

    expect(result.agents?.general).toEqual({ harness: "omp", model: "omp-fast" });
    expect(result.agents?.reviewer).toEqual({ harness: "claude", model: "claude-opus" });
  });

  // codex reported unavailable, so it reaches no screen: not as a row, not as a
  // group header, not as a prefix free text could name.
  it("offers only the installed harnesses", async () => {
    const { input, output, seen } = io();
    drive(input, output, ["\r", "\r", "\r", "\r"]);

    await runModelSetupWizard({ ...base(), input, output });
    const painted = seen.join("");

    expect(painted).toContain("-- claude ");
    expect(painted).toContain("-- omp ");
    expect(painted).not.toContain("codex");
  });

  it("leaves an agent unset when it is skipped", async () => {
    const { input, output } = io();
    drive(input, output, ["\r", "\x07", "\x07", "\x07"]);

    const result = await runModelSetupWizard({ ...base(), input, output });

    expect(result.agents).toEqual({ general: { harness: "claude", model: "claude-opus" } });
  });

  it("warns and continues when config persistence fails", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const { input, output } = io();
    drive(input, output, ["\r", "\x07", "\x07", "\x07"]);

    try {
      const result = await runModelSetupWizard({
        ...base(),
        input,
        output,
        save: () => {
          throw new Error("read-only config directory");
        },
      });

      expect(result.agents).toEqual({ general: { harness: "claude", model: "claude-opus" } });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Could not save config"));
    } finally {
      warning.mockRestore();
    }
  });

  // Walking out mid-run is the case worth pinning: answers already given are
  // dropped with the rest, so a half-answered run cannot reach the file.
  it("writes nothing when the run is aborted after an agent was answered", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn();
    const { input, output } = io();
    drive(input, output, ["\r", "\x03"]);

    try {
      const result = await runModelSetupWizard({ ...base(), input, output, save });

      expect(save).not.toHaveBeenCalled();
      expect(result.agents).toBeUndefined();
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
      expect(result.agents).toBeUndefined();
      expect(needsModelSetup(result, true)).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("interrupted"));
    } finally {
      warning.mockRestore();
    }
  });

  // Writing `agents` is the flag that first-run setup already happened. Writing
  // it after asking nothing would spend the single prompt the user ever gets.
  it("leaves the config untouched when no harness had anything to offer", async () => {
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
      expect(result.agents).toBeUndefined();
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
      expect(result.agents).toBeUndefined();
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
  it("gives one screen per agent, each spanning every installed harness", () => {
    const screens = buildScreens(
      ["general", "reviewer"],
      [
        harness("claude", [["anthropic", ["a"]]]),
        harness("codex", [["openai", ["g"]]]),
        { agent: "opencode", available: false, providers: [] },
      ],
      {},
    );

    expect(screens).toHaveLength(2);
    expect(screens.map((screen) => screen.role)).toEqual(["general", "reviewer"]);
    expect(screens[0].counter).toBe("agente 1 de 2");
    expect(screens[0].items.map((item) => item.harness)).toEqual(["claude", "codex"]);
    // An unavailable harness reaches no screen, so it cannot be picked at all.
    expect(screens[0].harnesses).toEqual(new Set(["claude", "codex"]));
  });

  // Asking which harness runs an agent is unanswerable with none installed, and
  // writing the bindings anyway would mark first-run setup as done.
  it("gives no screens when nothing is installed", () => {
    expect(
      buildScreens(["general"], [{ agent: "codex", available: false, providers: [] }], {}),
    ).toEqual([]);
  });

  // A linha fixa fica fora do agrupamento, senao ela contradiz a ordem dos harnesses.
  it("pins the configured binding above the groups and names its harness", () => {
    const screen = buildRoleScreen(
      "reviewer",
      [harness("opencode", [["a", ["a/1"]], ["b", ["b/2"]]])],
      0,
      1,
      { harness: "opencode", model: "b/2" },
    );

    expect(screen.pinned).toBe(true);
    expect(screen.items[0]).toMatchObject({
      id: "b/2",
      harness: "opencode",
      note: "atual · opencode",
    });
    // Listed once: the pin replaces the catalog row rather than doubling it.
    expect(screen.items.filter((item) => item.id === "b/2")).toHaveLength(1);
  });

  // 1,462 catalog entries spell the version readably in `name` and only in
  // the id the way it is typed, so the filter needs it even though the row
  // shows the id.
  it("carries a readable name for the filter, and only when it adds something", () => {
    const catalog: HarnessModels = {
      agent: "claude",
      available: true,
      providers: [
        {
          provider: "anthropic",
          models: [
            { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", isDefault: false },
            { id: "claude-haiku", name: "claude-haiku", provider: "anthropic", isDefault: false },
          ],
        },
      ],
    };

    const screen = buildRoleScreen("general", [catalog], 0, 1, undefined);

    expect(screen.items.find((item) => item.id === "claude-opus-5")?.name).toBe("Claude Opus 5");
    expect(screen.items.find((item) => item.id === "claude-haiku")).not.toHaveProperty("name");
  });

  // With nothing saved for the agent, the suggestion comes from whichever
  // harness runs everything else, and only if that harness names a default.
  it("pins a real isDefault of the fallback harness and marks it padrao", () => {
    const screen = buildRoleScreen(
      "general",
      [harness("omp", [["bedrock", ["z"]]]), harness("claude", [["anthropic", ["x", "y"]]], ["y"])],
      0,
      1,
      undefined,
      "claude",
    );

    expect(screen.items[0]).toMatchObject({ id: "y", harness: "claude", note: "padrao · claude" });
  });

  // omp e opencode nao declaram isDefault: o primeiro id e acidente alfabetico.
  it("pins nothing when neither config nor isDefault exists", () => {
    const screen = buildRoleScreen(
      "general",
      [harness("omp", [["bedrock", ["a", "b"]]])],
      0,
      1,
      undefined,
      "omp",
    );

    expect(screen.pinned).toBe(false);
    expect(screen.items[0].note).toBeUndefined();
  });

  it("pins nothing when the fallback harness is not installed", () => {
    const screen = buildRoleScreen(
      "general",
      [harness("omp", [["bedrock", ["a"]]], ["a"])],
      0,
      1,
      undefined,
      "claude",
    );

    expect(screen.pinned).toBe(false);
  });

  it("keeps a harness with an empty catalog listed without contributing rows", () => {
    const screen = buildRoleScreen("reviewer", [{ agent: "omp", available: true, providers: [] }], 1, 3, undefined);

    expect(screen.items).toEqual([]);
    expect(screen.counter).toBe("agente 2 de 3");
    // Still typeable as a prefix: the harness is installed, it just listed nothing.
    expect(screen.harnesses).toEqual(new Set(["omp"]));
  });

  // One screen now spans every harness, so the error has to say whose it is.
  it("names the harness behind a discovery error", () => {
    const screen = buildRoleScreen(
      "reviewer",
      [
        harness("claude", [["anthropic", ["a"]]]),
        { agent: "omp", available: true, error: "discovery timed out", providers: [] },
      ],
      0,
      1,
      undefined,
    );

    expect(screen.error).toBe("omp: discovery timed out");
  });

  it("counts an id once per harness, and keeps the same id under two of them", () => {
    const screen = buildRoleScreen(
      "reviewer",
      [harness("opencode", [["a", ["dup"]], ["b", ["dup"]]]), harness("codex", [["openai", ["dup"]]])],
      0,
      1,
      undefined,
    );

    expect(screen.items.filter((item) => item.id === "dup")).toHaveLength(2);
    expect(screen.items.map((item) => item.harness)).toEqual(["opencode", "codex"]);
  });

  it("lists every model of every harness, with no cap", () => {
    const many = Array.from({ length: 600 }, (_, i) => `m-${i}`);
    const screen = buildRoleScreen(
      "reviewer",
      [harness("opencode", [["p", many]]), harness("codex", [["openai", ["g"]]])],
      0,
      1,
      undefined,
    );

    expect(screen.items).toHaveLength(601);
  });

  // A blank id used to become a selectable blank row that Enter saved as the model.
  it("drops a model whose id is blank", () => {
    const screen = buildRoleScreen("reviewer", [harness("opencode", [["p", ["", "   ", "real"]]])], 0, 1, undefined);

    expect(screen.items.map((item) => item.id)).toEqual(["real"]);
    expect(screen.known.has(itemKey("opencode", ""))).toBe(false);
  });

  // open tells the user their saved model left the catalog and to run setup.
  // Setup then has to show which model that was.
  it("still pins a configured binding the catalog no longer lists", () => {
    const screen = buildRoleScreen("reviewer", [harness("codex", [["openai", ["gpt-6"]]])], 0, 1, {
      harness: "codex",
      model: "gpt-retired",
    });

    expect(screen.pinned).toBe(true);
    expect(screen.items[0]).toMatchObject({
      id: "gpt-retired",
      harness: "codex",
      note: "atual · codex, fora do catalogo",
    });
    // Synthetic, so keeping it costs the same second Enter as typing it by hand.
    expect(screen.items[0].synthetic).toBe(true);
    expect(screen.known.has(itemKey("codex", "gpt-retired"))).toBe(false);
  });

  // Not the same case as a retired model: here the whole harness is gone from
  // the machine. The binding still has to be visible, because setup is where
  // the user goes to move the agent somewhere else.
  it("still pins a binding whose harness is no longer installed", () => {
    const screen = buildRoleScreen("reviewer", [harness("claude", [["anthropic", ["a"]]])], 0, 1, {
      harness: "codex",
      model: "gpt-5.6-luna",
    });

    expect(screen.items[0]).toMatchObject({
      id: "gpt-5.6-luna",
      harness: "codex",
      note: "atual · codex, fora do catalogo",
      synthetic: true,
    });
    // Gone from the machine, so free text cannot name it as a prefix either.
    expect(screen.harnesses).toEqual(new Set(["claude"]));
  });

  // The catalog trims ids and keys the rows by the trimmed value, so a default
  // looked up untrimmed missed its own row and pinned nothing.
  it("pins a default whose id the harness reported padded", () => {
    const padded: HarnessModels = {
      agent: "claude",
      available: true,
      providers: [
        {
          provider: "anthropic",
          models: [{ id: "  claude-opus  ", name: "Opus", provider: "anthropic", isDefault: true }],
        },
      ],
    };
    const screen = buildRoleScreen("reviewer", [padded], 0, 1, undefined, "claude");

    expect(screen.pinned).toBe(true);
    expect(screen.items[0]).toMatchObject({ id: "claude-opus", note: "padrao · claude" });
    // Pinned means hoisted, never duplicated.
    expect(screen.items.filter((item) => item.id === "claude-opus")).toHaveLength(1);
  });
});

describe("collecting selections", () => {
  it("writes both halves of what was picked", () => {
    expect(
      collectSelections([{ kind: "picked", role: "reviewer", harness: "codex", id: "x" }], undefined, 1),
    ).toEqual({
      agents: { reviewer: { harness: "codex", model: "x" } },
      write: true,
    });
  });

  // Pular significa "nao mexe", nunca "desconfigura".
  it("leaves an earlier choice untouched when the agent is skipped", () => {
    expect(
      collectSelections(
        [{ kind: "skipped", role: "reviewer" }],
        { reviewer: { harness: "codex", model: "gpt-x" } },
        1,
      ),
    ).toEqual({
      agents: { reviewer: { harness: "codex", model: "gpt-x" } },
      write: true,
    });
  });

  it("writes the empty sentinel when everything was skipped and nothing was configured", () => {
    expect(collectSelections([{ kind: "skipped", role: "general" }], undefined, 1)).toEqual({
      agents: {},
      write: true,
    });
  });

  // Sem tela mostrada, gravar queimaria a unica pergunta que o usuario recebe.
  it("writes nothing when no screen was shown at all", () => {
    expect(collectSelections([], undefined, 0)).toEqual({ agents: {}, write: false });
  });

  it("writes nothing when the run was aborted", () => {
    expect(
      collectSelections([{ kind: "aborted" }], { general: { harness: "claude", model: "keep" } }, 2),
    ).toEqual({
      agents: { general: { harness: "claude", model: "keep" } },
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
