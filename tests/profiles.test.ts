import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentDriver, DriverRegistry } from "../src/core/driver.js";
import type { HarnessModels } from "../src/core/models.js";
import {
  baseConfig,
  extractProfileSnapshot,
  listProfiles,
  parseProfileName,
  resolveEffectiveConfig,
  serializeConfig,
  type RunAgentConfig,
  type SetupConfigRead,
} from "../src/config/config.js";
import {
  applyProfileAction,
  executeProfileAction,
  parseProfileArgs,
  ProfileUsageError,
} from "../src/cli/commands/profile.js";
import {
  parseSetupArgs,
  runSetupBatch,
  type SetupBatchDependencies,
  type SetupCliOptions,
} from "../src/cli/commands/setup.js";
import { createSetupConfigStore, DEFAULT_CONFIG } from "../src/config/config.js";
import { getPaths } from "../src/config/paths.js";

const originalEnv = {
  RUN_AGENT_DIR: process.env.RUN_AGENT_DIR,
  RUN_AGENT_CONFIG_DIR: process.env.RUN_AGENT_CONFIG_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

beforeEach(() => {
  process.env.RUN_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "codedeck-profile-runtime-"));
  process.env.RUN_AGENT_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "codedeck-profile-config-"));
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  if (originalEnv.RUN_AGENT_DIR === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalEnv.RUN_AGENT_DIR;
  if (originalEnv.RUN_AGENT_CONFIG_DIR === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalEnv.RUN_AGENT_CONFIG_DIR;
  if (originalEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
});

describe("parseProfileName", () => {
  it("accepts slugs and lowercases them", () => {
    expect(parseProfileName("max")).toBe("max");
    expect(parseProfileName("Barato-2_x")).toBe("barato-2_x");
  });

  it("rejects blanks, spaces and punctuation", () => {
    for (const bad of ["", "  ", "meu perfil", "UPPER!", "-x", "a/b", "x".repeat(65)]) {
      expect(() => parseProfileName(bad)).toThrow("Invalid profile");
    }
  });
});

describe("resolveEffectiveConfig", () => {
  const base: RunAgentConfig = {
    defaultAgent: "claude",
    agents: { general: { harness: "claude", model: "base-model" } },
  };

  it("returns the base config untouched when no profile is picked", () => {
    const config: RunAgentConfig = { ...base, profiles: { max: {} }, activeProfile: undefined };
    expect(resolveEffectiveConfig(config)).toEqual(baseConfig(config));
    expect(resolveEffectiveConfig(config)).not.toHaveProperty("profiles");
  });

  it("prefers the flag over the active profile", () => {
    const config: RunAgentConfig = {
      ...base,
      activeProfile: "a",
      profiles: {
        a: { agents: { general: { harness: "codex", model: "from-a" } } },
        b: { agents: { general: { harness: "codex", model: "from-b" } } },
      },
    };
    expect(resolveEffectiveConfig(config).agents?.general?.model).toBe("from-a");
    expect(resolveEffectiveConfig(config, "b").agents?.general?.model).toBe("from-b");
  });

  it("overlays whole blocks: agents come from the profile, scalars fall back", () => {
    const config: RunAgentConfig = {
      ...base,
      profiles: { max: { agents: { reviewer: { harness: "codex", model: "gpt" } } } },
    };
    const effective = resolveEffectiveConfig(config, "max");
    expect(effective.defaultAgent).toBe("claude");
    // The profile owns the agents map as a unit: a partial map must not
    // silently inherit roles from the base setup.
    expect(effective.agents?.general).toBeUndefined();
    expect(effective.agents?.reviewer?.model).toBe("gpt");
  });

  it("fails loud on unknown or malformed names", () => {
    const config: RunAgentConfig = { ...base, profiles: {} };
    expect(() => resolveEffectiveConfig(config, "nope")).toThrow('Unknown profile "nope"');
    expect(() => resolveEffectiveConfig({ ...base, activeProfile: "nope" })).toThrow(
      'Unknown profile "nope"',
    );
    expect(() => resolveEffectiveConfig(config, "bad name")).toThrow('Invalid profile "bad name"');
  });

  it("snapshots only what setup writes", () => {
    const snapshot = extractProfileSnapshot({
      ...base,
      worktree: true,
      orchestrator: { investigate: "read", selfWork: "trivial", tools: "edit" },
      profiles: { max: {} },
      activeProfile: "max",
    });
    expect(snapshot).toEqual({
      agents: base.agents,
      orchestrator: { investigate: "read", selfWork: "trivial", tools: "edit" },
    });
  });
});

describe("profile actions", () => {
  const saved: RunAgentConfig = {
    defaultAgent: "claude",
    agents: { general: { harness: "claude", model: "m" } },
  };

  it("saves the current setup without touching the base", () => {
    const result = applyProfileAction(saved, "save", "max");
    expect(result.save).toBe(true);
    expect(result.config.profiles?.max?.agents?.general?.model).toBe("m");
    expect(result.config.agents?.general?.model).toBe("m");
    expect(result.config).not.toHaveProperty("activeProfile");
  });

  it("saves a new profile from the base without active-profile contamination", () => {
    const config: RunAgentConfig = {
      defaultAgent: "claude",
      agents: { general: { harness: "claude", model: "base-model" } },
      activeProfile: "a",
      profiles: { a: { agents: { general: { harness: "codex", model: "from-a" } } } },
    };
    const result = applyProfileAction(config, "save", "b");
    expect(result.save).toBe(true);
    expect(result.config.profiles?.b?.agents?.general?.model).toBe("base-model");
    expect(result.config.profiles?.a?.agents?.general?.model).toBe("from-a");
  });

  it("saving the active profile snapshots its own effective setup", () => {
    const config: RunAgentConfig = {
      defaultAgent: "claude",
      agents: { general: { harness: "claude", model: "base-model" } },
      activeProfile: "a",
      profiles: { a: { agents: { general: { harness: "codex", model: "from-a" } } } },
    };
    const result = applyProfileAction(config, "save", "a");
    expect(result.config.profiles?.a?.agents?.general?.model).toBe("from-a");
  });

  it("uses, lists and shows profiles", () => {
    const withProfile = applyProfileAction(saved, "save", "max").config;
    const used = applyProfileAction(withProfile, "use", "max");
    expect(used.config.activeProfile).toBe("max");
    expect(applyProfileAction(used.config, "use", "max").save).toBe(false);

    const listed = applyProfileAction(used.config, "list");
    expect(listed.save).toBe(false);
    expect(listed.text).toContain("* max");
    expect(listed.payload).toEqual({ active: "max", profiles: ["max"] });

    const shown = applyProfileAction(used.config, "show", "max");
    expect(shown.save).toBe(false);
    expect(shown.text).toBe(serializeConfig(withProfile.profiles!.max));
  });

  it("deletes a profile and clears it when active", () => {
    const withProfile = applyProfileAction(saved, "save", "max").config;
    const active = applyProfileAction(withProfile, "use", "max").config;
    const deleted = applyProfileAction(active, "delete", "max");
    expect(deleted.config).not.toHaveProperty("profiles");
    expect(deleted.config).not.toHaveProperty("activeProfile");
    expect(() => applyProfileAction(deleted.config, "show", "max")).toThrow(ProfileUsageError);
  });

  it("refuses unknown profiles and bad names", () => {
    for (const action of ["show", "use", "delete"] as const) {
      expect(() => applyProfileAction(saved, action, "nope")).toThrow('Unknown profile "nope"');
    }
    expect(() => applyProfileAction(saved, "save", "bad name")).toThrow("Invalid profile");
  });

  it("parses action args", () => {
    expect(parseProfileArgs(["list"])).toMatchObject({ action: "list", json: false });
    expect(parseProfileArgs(["use", "max", "--json"])).toMatchObject({ action: "use", name: "max", json: true });
    expect(() => parseProfileArgs([])).toThrow("Missing action");
    expect(() => parseProfileArgs(["frobnicate"])).toThrow("Unknown action");
    expect(() => parseProfileArgs(["use"])).toThrow("needs a name");
    expect(() => parseProfileArgs(["list", "extra"])).toThrow("Unexpected argument");
  });

  it("lists names sorted and skips hand-edited junk", () => {
    const config = {
      profiles: { b: { agents: {} }, a: { agents: {} }, "bad name": {}, c: 42 },
    } as unknown as RunAgentConfig;
    expect(listProfiles(config)).toEqual(["a", "b"]);
  });
});

describe("setup --profile batch", () => {
  function fakeRegistry(...agents: AgentDriver["id"][]): DriverRegistry {
    const drivers = agents.map((id) => ({ id }) as AgentDriver);
    return {
      list: () => drivers,
      get: (id) => drivers.find((driver) => driver.id === id) ?? drivers[0],
      has: (id) => drivers.some((driver) => driver.id === id),
      detectAll: async () => ({}),
    };
  }

  function catalog(agent: AgentDriver["id"], ids: string[]): HarnessModels {
    return {
      agent,
      available: true,
      providers: [
        { provider: "test", models: ids.map((id) => ({ id, name: id, provider: "test" })) },
      ],
    };
  }

  function memoryStore(config: RunAgentConfig = {}) {
    const file = getPaths().configFile;
    const effective = { ...DEFAULT_CONFIG, ...config };
    const read = vi.fn(
      (): SetupConfigRead => ({
        status: "ok",
        source: "canonical",
        path: file,
        config: effective,
        raw: serializeConfig(effective),
        message: null,
      }),
    );
    const save = vi.fn();
    return { read, save };
  }

  function setupOptions(args: readonly string[]): SetupCliOptions {
    const parsed = parseSetupArgs(args);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.options;
  }

  function batchWorld() {
    const store = memoryStore({ agents: { general: { harness: "claude", model: "base" } } });
    const deps: SetupBatchDependencies = {
      configStore: store,
      registry: fakeRegistry("codex"),
      discoverModels: async () => [catalog("codex", ["gpt-5"])],
      saveCache: () => true,
    };
    return { store, deps };
  }

  it("writes binds into the profile and leaves top-level agents alone", async () => {
    const { store, deps } = batchWorld();
    const result = await runSetupBatch(
      setupOptions(["--bind", "reviewer=codex:gpt-5", "--profile", "max"]),
      deps,
    );

    expect(result.code).toBe(0);
    expect(store.save).toHaveBeenCalledOnce();
    const written = store.save.mock.calls[0][0] as RunAgentConfig;
    expect(written.agents?.general).toEqual({ harness: "claude", model: "base" });
    expect(written.profiles?.max?.agents?.reviewer).toEqual({ harness: "codex", model: "gpt-5" });
    expect(result.envelope.proposta).toMatchObject({
      profiles: { max: { agents: { reviewer: { harness: "codex", model: "gpt-5" } } } },
    });
  });

  it("creates a missing profile empty apart from the bind, without root leakage", async () => {
    const { store, deps } = batchWorld();
    const result = await runSetupBatch(
      setupOptions(["--non-interactive", "--bind", "reviewer=codex:gpt-5", "--profile=max"]),
      deps,
    );

    expect(result.code).toBe(0);
    const written = store.save.mock.calls[0][0] as RunAgentConfig;
    expect(written.profiles?.max?.agents?.reviewer).toEqual({ harness: "codex", model: "gpt-5" });
    expect(written.profiles?.max?.agents?.general).toBeUndefined();
    expect(written.agents?.general).toEqual({ harness: "claude", model: "base" });
  });

  it("setup without --profile edits the active profile and leaves the base alone", async () => {
    const file = getPaths().configFile;
    const activeSnapshot = { agents: { general: { harness: "codex", model: "from-a" } } } as const;
    const effective = {
      ...DEFAULT_CONFIG,
      agents: { general: { harness: "claude", model: "base" } },
      activeProfile: "a",
      profiles: { a: activeSnapshot },
    };
    const read = vi.fn(
      (): SetupConfigRead => ({
        status: "ok",
        source: "canonical",
        path: file,
        config: effective as RunAgentConfig,
        raw: serializeConfig(effective as RunAgentConfig),
        message: null,
      }),
    );
    const save = vi.fn();
    const deps: SetupBatchDependencies = {
      configStore: { read, save },
      registry: fakeRegistry("codex"),
      discoverModels: async () => [catalog("codex", ["gpt-5"])],
      saveCache: () => true,
    };
    const result = await runSetupBatch(setupOptions(["--bind", "reviewer=codex:gpt-5"]), deps);

    expect(result.code).toBe(0);
    const written = save.mock.calls[0][0] as RunAgentConfig;
    expect(written.activeProfile).toBe("a");
    expect(written.profiles?.a?.agents?.reviewer).toEqual({ harness: "codex", model: "gpt-5" });
    expect(written.profiles?.a?.agents?.general).toEqual(activeSnapshot.agents.general);
    expect(written.agents?.reviewer).toBeUndefined();
    expect(written.agents?.general).toEqual({ harness: "claude", model: "base" });
  });

  it("refuses setup when the active profile is missing", async () => {
    const { store, deps } = batchWorld();
    const read = store.read as ReturnType<typeof vi.fn>;
    const file = getPaths().configFile;
    const config = {
      ...DEFAULT_CONFIG,
      activeProfile: "missing",
      agents: { general: { harness: "claude", model: "base" } },
      profiles: {},
    } satisfies RunAgentConfig;
    read.mockReturnValueOnce({
      status: "ok",
      source: "canonical",
      path: file,
      config,
      raw: serializeConfig(config),
      message: null,
    });

    const result = await runSetupBatch(setupOptions(["--bind", "reviewer=codex:gpt-5"]), deps);

    expect(result.code).toBe(14);
    expect(result.envelope.resultado.message).toContain('Active profile "missing" does not exist');
    expect(store.save).not.toHaveBeenCalled();
  });

  it("rejects a bad profile name at parse time", () => {
    expect(parseSetupArgs(["--profile", "bad name"])).toMatchObject({ ok: false });
  });
});

describe("profile command wiring", () => {
  it("runs isolated from the real config file and saves via the store", async () => {
    const store = createSetupConfigStore();
    const live = store.read();
    expect(live.status).toBe("missing");

    const saved: RunAgentConfig[] = [];
    const code = await executeProfileAction(["save", "max"], {
      load: () => ({
        defaultAgent: "claude",
        agents: { general: { harness: "claude", model: "m" } },
      }),
      save: (config) => {
        saved.push(config);
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    expect(code).toBe(0);
    expect(saved).toHaveLength(1);
    expect(saved[0].profiles?.max?.agents?.general?.model).toBe("m");
  });
});
