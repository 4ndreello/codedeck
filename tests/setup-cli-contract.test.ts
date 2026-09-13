import fs from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDriver, DriverRegistry } from "../src/core/driver.js";
import type { HarnessModels } from "../src/core/models.js";
import {
  CACHE_TTL_MS,
  saveDiskModelsCache,
} from "../src/core/models.js";
import {
  createSetupConfigStore,
  DEFAULT_CONFIG,
  saveConfig,
  serializeConfig,
  type RunAgentConfig,
  type SetupConfigRead,
} from "../src/config/config.js";
import { getPaths } from "../src/config/paths.js";
import { getCliName } from "../src/cli/cli-name.js";
import {
  executeSetupAction,
  parseBind,
  parseSetupArgs,
  runSetupBatch,
  type SetupBatchDependencies,
  type SetupCliOptions,
} from "../src/cli/commands/setup.js";

const originalEnv = {
  HOME: process.env.HOME,
  RUN_AGENT_DIR: process.env.RUN_AGENT_DIR,
  RUN_AGENT_CONFIG_DIR: process.env.RUN_AGENT_CONFIG_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

class MemoryWritable extends Writable {
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

function fakeRegistry(...agents: AgentDriver["id"][]): DriverRegistry {
  const drivers = agents.map((id) => ({ id } as AgentDriver));
  return {
    list: () => drivers,
    get: (id) => drivers.find((driver) => driver.id === id) ?? drivers[0],
    has: (id) => drivers.some((driver) => driver.id === id),
    detectAll: async () => ({}),
  };
}

function catalog(
  agent: AgentDriver["id"],
  models: Array<{ id: string; aliases?: string[] }>,
  cachedAt?: string,
): HarnessModels {
  return {
    agent,
    available: true,
    providers: [
      {
        provider: "test",
        models: models.map((model) => ({
          id: model.id,
          name: model.id,
          provider: "test",
          ...(model.aliases === undefined ? {} : { aliases: model.aliases }),
        })),
      },
    ],
    ...(cachedAt === undefined ? {} : { cachedAt }),
  };
}

function configStore(config: RunAgentConfig = {}): {
  read: ReturnType<typeof vi.fn<() => SetupConfigRead>>;
  save: ReturnType<typeof vi.fn>;
} {
  const file = getPaths().configFile;
  const effective = { ...DEFAULT_CONFIG, ...config };
  const read = vi.fn((): SetupConfigRead => ({
    status: "ok",
    source: "canonical",
    path: file,
    config: effective,
    raw: serializeConfig(effective),
    message: null,
  }));
  const save = vi.fn();
  return { read, save };
}

function options(args: readonly string[]): SetupCliOptions {
  const parsed = parseSetupArgs(args);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.options;
}

function dependencies(
  store: ReturnType<typeof configStore>,
  discoverModels: SetupBatchDependencies["discoverModels"],
  extra: Partial<SetupBatchDependencies> = {},
): SetupBatchDependencies {
  return {
    configStore: store,
    registry: fakeRegistry("codex"),
    discoverModels,
    saveCache: () => true,
    ...extra,
  };
}

beforeEach(() => {
  process.env.RUN_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "codedeck-setup-runtime-"));
  process.env.RUN_AGENT_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "codedeck-setup-config-"));
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  if (originalEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.HOME;
  if (originalEnv.RUN_AGENT_DIR === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalEnv.RUN_AGENT_DIR;
  if (originalEnv.RUN_AGENT_CONFIG_DIR === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalEnv.RUN_AGENT_CONFIG_DIR;
  if (originalEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
});

describe("setup batch parser", () => {
  it("parses an exact binding and keeps colons in the model", () => {
    expect(() => parseBind("reviewer=codex=not-a-model")).toThrow();
    expect(parseBind("reviewer=codex:provider:model:variant")).toEqual({
      role: "reviewer",
      binding: { harness: "codex", model: "provider:model:variant" },
    });
  });

  it("reads a trailing level as the binding effort", () => {
    expect(parseBind("reviewer=codex:gpt-5:high")).toEqual({
      role: "reviewer",
      binding: { harness: "codex", model: "gpt-5", effort: "high" },
    });
  });

  it("keeps a single-colon level-named model whole", () => {
    expect(parseBind("reviewer=codex:high")).toEqual({
      role: "reviewer",
      binding: { harness: "codex", model: "high" },
    });
    expect(parseBind("reviewer=codex:gpt:maximum")).toEqual({
      role: "reviewer",
      binding: { harness: "codex", model: "gpt:maximum" },
    });
  });

  it("rejects invalid bind values with the fixed diagnostic", () => {
    const value = "reviewer=codex:model name";
    expect(() => parseBind(value)).toThrow(
      `Invalid --bind "${value}": expected role=harness:model[:effort]`,
    );
    expect(parseSetupArgs(["--bind=-bad"])).toMatchObject({ ok: false, json: false });
    expect(parseSetupArgs(["--bind", "--unknown"])).toEqual({
      ok: false,
      json: false,
      message: 'Option "--bind" expects role=harness:model[:effort].',
    });
    expect(parseSetupArgs(["--bind", value])).toMatchObject({ ok: false, json: false });
    expect(parseSetupArgs(["--json", "--bind"])).toEqual({
      ok: false,
      json: true,
      message: 'Option "--bind" expects role=harness:model[:effort].',
    });
  });

  it("marks only explicit batch flags as batch and preserves bind order", () => {
    expect(parseSetupArgs([])).toMatchObject({ ok: true, options: { batch: false } });
    expect(parseSetupArgs(["--refresh"])).toMatchObject({ ok: true, options: { batch: false } });
    const parsed = parseSetupArgs([
      "--bind=general=claude:first",
      "--bind",
      "reviewer=codex:second",
      "--bind",
      "general=claude:last",
    ]);
    expect(parsed).toMatchObject({ ok: true, options: { batch: true } });
    if (parsed.ok) expect(parsed.options.binds.map((entry) => entry.binding.model)).toEqual([
      "first",
      "second",
      "last",
    ]);
  });
});

describe("setup batch execution", () => {
  it("uses separate stdout and stderr and emits one JSON envelope", async () => {
    const store = configStore({ defaultModel: "legacy" });
    const stdout = new MemoryWritable();
    const stderr = new MemoryWritable();
    const now = Date.now();
    const result = await executeSetupAction(
      ["--non-interactive", "--json", "--bind", "reviewer=codex:gpt-5"],
      {
        isTTY: false,
        stdout: stdout as MemoryWritable & { isTTY?: boolean },
        stderr,
        registry: fakeRegistry("codex"),
        configStore: store,
        discoverModels: async () => [catalog("codex", [{ id: "gpt-5" }], new Date(now).toISOString())],
        saveCache: () => true,
        now: () => now,
      },
    );

    expect(result.code).toBe(0);
    expect(stdout.chunks).toHaveLength(1);
    const envelope = JSON.parse(stdout.text());
    expect(Object.keys(envelope)).toEqual(["proposta", "validacoes", "mudancas", "resultado"]);
    expect(envelope.validacoes.catalogo).toMatchObject({ status: "fresh", source: "network", ageMs: 0 });
    expect(envelope.validacoes.bindings).toEqual([
      { role: "reviewer", harness: "codex", model: "gpt-5", status: "accepted", message: "" },
    ]);
    expect(envelope.proposta.defaultModel).toBe("legacy");
    expect(envelope.proposta.agents.reviewer).toEqual({ harness: "codex", model: "gpt-5" });
    expect(stderr.text()).toContain("discovering models...");
    expect(stderr.text()).not.toContain("saved:");
    expect(store.save).toHaveBeenCalledOnce();
  });

  it("serializes parser failures with the not-run catalog state", async () => {
    const stdout = Object.assign(new MemoryWritable(), { isTTY: false });
    const stderr = new MemoryWritable();
    const result = await executeSetupAction(["--json", "--unknown"], { stdout, stderr, isTTY: false });
    const envelope = JSON.parse(stdout.text());

    expect(result.code).toBe(2);
    expect(envelope.validacoes.config.message).toBe("not-run");
    expect(envelope.validacoes.catalogo).toEqual({
      status: "not-needed",
      source: "none",
      ageMs: null,
      message: "not-run",
    });
    expect(envelope.resultado).toMatchObject({ status: "error", code: 2, saved: false });
    expect(stderr.text()).toBe('Unknown option "--unknown".\n');
  });

  it("returns unchanged without discovery when a batch has no bind or refresh", async () => {
    const store = configStore({ defaultModel: "keep" });
    const discover = vi.fn<NonNullable<SetupBatchDependencies["discoverModels"]>>();
    const result = await runSetupBatch(
      options(["--non-interactive", "--dry-run"]),
      dependencies(store, discover),
    );

    expect(result.code).toBe(0);
    expect(result.envelope.resultado).toEqual({
      status: "unchanged",
      code: 0,
      saved: false,
      message: "Configuration unchanged.",
    });
    expect(result.envelope.validacoes.catalogo).toEqual({
      status: "not-needed",
      source: "none",
      ageMs: null,
      message: null,
    });
    expect(discover).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("does not discover or write for a non-batch invocation without a TTY", async () => {
    const discover = vi.fn<NonNullable<SetupBatchDependencies["discoverModels"]>>();
    const save = vi.fn();
    const stderr = new MemoryWritable();
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    const result = await executeSetupAction([], {
      input,
      stdout: Object.assign(new MemoryWritable(), { isTTY: false }),
      stderr,
      discoverModels: discover,
      saveConfig: save,
      isTTY: false,
    });

    expect(result.code).toBe(1);
    expect(stderr.text()).toBe(`${getCliName()} setup needs a terminal on both stdin and stdout.\n`);
    expect(discover).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("merges bindings by role and validates only the last occurrence", async () => {
    const store = configStore({
      defaultModel: "keep",
      agents: { auditor: { harness: "codex", model: "existing" } },
    });
    const result = await runSetupBatch(
      options([
        "--non-interactive",
        "--bind",
        "reviewer=codex:old",
        "--bind",
        "general=codex:general",
        "--bind",
        "reviewer=codex:new",
      ]),
      dependencies(store, async () => [catalog("codex", [{ id: "general" }, { id: "new" }])]),
    );

    expect(result.code).toBe(0);
    expect(result.envelope.validacoes.bindings.map((entry) => entry.role)).toEqual(["general", "reviewer"]);
    expect(result.envelope.proposta).toEqual({
      defaultAgent: "claude",
      worktree: false,
      remoteControl: true,
      pty: true,
      defaultModel: "keep",
      agents: {
        auditor: { harness: "codex", model: "existing" },
        general: { harness: "codex", model: "general" },
        reviewer: { harness: "codex", model: "new" },
      },
    });
  });

  it("saves a trailing level as the binding effort", async () => {
    const store = configStore();
    const result = await runSetupBatch(
      options(["--non-interactive", "--bind", "reviewer=codex:gpt-5:high"]),
      dependencies(store, async () => [catalog("codex", [{ id: "gpt-5" }])]),
    );

    expect(result.code).toBe(0);
    expect(result.envelope.proposta.agents.reviewer).toEqual({
      harness: "codex",
      model: "gpt-5",
      effort: "high",
    });
  });

  it("rejects unavailable harnesses and unknown models before saving", async () => {
    const unavailable = configStore();
    const unavailableResult = await runSetupBatch(
      options(["--non-interactive", "--bind", "reviewer=codex:gpt-5"]),
      dependencies(unavailable, async () => [{ agent: "codex", available: false, providers: [], error: "not installed" }]),
    );
    expect(unavailableResult.code).toBe(11);
    expect(unavailableResult.envelope.validacoes.bindings[0].status).toBe("harness-unavailable");
    expect(unavailable.save).not.toHaveBeenCalled();

    const unknown = configStore();
    const unknownResult = await runSetupBatch(
      options(["--non-interactive", "--bind", "reviewer=codex:gpt-5"]),
      dependencies(unknown, async () => [catalog("codex", [{ id: "other" }])]),
    );
    expect(unknownResult.code).toBe(12);
    expect(unknownResult.envelope.validacoes.bindings[0].status).toBe("unknown-model");
    expect(unknownResult.envelope.mudancas).toEqual([
      expect.objectContaining({
        path: "/agents/reviewer",
        beforePresent: false,
        afterPresent: true,
        after: { harness: "codex", model: "gpt-5" },
      }),
    ]);
    expect(unknown.save).not.toHaveBeenCalled();
  });

  it("uses exact aliases, never fuzzy matching, in a fresh catalog", async () => {
    const store = configStore();
    const accepted = await runSetupBatch(
      options(["--non-interactive", "--bind", "reviewer=codex:sonnet"]),
      dependencies(store, async () => [catalog("codex", [{ id: "provider/claude-4", aliases: ["sonnet"] }])]),
    );
    expect(accepted.code).toBe(0);

    const rejected = await runSetupBatch(
      options(["--non-interactive", "--bind", "reviewer=codex:sonne"]),
      dependencies(configStore(), async () => [catalog("codex", [{ id: "provider/claude-4", aliases: ["sonnet"] }])]),
    );
    expect(rejected.code).toBe(12);
  });

  it("keeps dry-run offline and reports an unavailable catalog without saving", async () => {
    const store = configStore();
    const discover = vi.fn<NonNullable<SetupBatchDependencies["discoverModels"]>>();
    const result = await runSetupBatch(
      options(["--non-interactive", "--dry-run", "--bind", "reviewer=codex:gpt-5"]),
      dependencies(store, discover),
    );

    expect(result.code).toBe(13);
    expect(result.envelope.resultado.saved).toBe(false);
    expect(result.envelope.validacoes.catalogo).toMatchObject({ status: "unavailable", source: "none" });
    expect(result.envelope.validacoes.bindings[0].status).toBe("unverified");
    expect(discover).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(fs.existsSync(getPaths().configFile)).toBe(false);
  });

  it("accepts a model from stale cache offline and rejects an absent one", async () => {
    const now = Date.now();
    const stale = catalog("codex", [{ id: "cached-model" }], new Date(now - CACHE_TTL_MS).toISOString());
    expect(saveDiskModelsCache([stale])).toBe(true);
    const discover = vi.fn<NonNullable<SetupBatchDependencies["discoverModels"]>>(() => Promise.reject(new Error("network down")));

    const acceptedStore = configStore();
    const accepted = await runSetupBatch(
      options(["--non-interactive", "--bind", "reviewer=codex:cached-model"]),
      dependencies(acceptedStore, discover, { now: () => now, timeoutMs: 20 }),
    );
    expect(accepted.code).toBe(0);
    expect(accepted.envelope.validacoes.catalogo).toMatchObject({ status: "offline", source: "stale-cache" });
    expect(accepted.envelope.validacoes.bindings[0].status).toBe("accepted");
    expect(accepted.envelope.validacoes.catalogo.message).toBe("Catalog is stale; using offline cache.");

    const rejected = await runSetupBatch(
      options(["--non-interactive", "--bind", "reviewer=codex:missing-model"]),
      dependencies(configStore(), discover, { now: () => now, timeoutMs: 20 }),
    );
    expect(rejected.code).toBe(13);
    expect(rejected.envelope.validacoes.bindings[0].status).toBe("unverified");
    expect(rejected.envelope.validacoes.catalogo.message).toContain("the catalog is stale");
  });

  it("uses refresh output instead of a model present in the old cache", async () => {
    const now = Date.now();
    expect(saveDiskModelsCache([catalog("codex", [{ id: "old" }], new Date(now).toISOString())])).toBe(true);
    const result = await runSetupBatch(
      options(["--non-interactive", "--refresh", "--bind", "reviewer=codex:old"]),
      dependencies(configStore(), async () => [catalog("codex", [{ id: "new" }], new Date(now).toISOString())], { now: () => now }),
    );
    expect(result.code).toBe(12);
    expect(result.envelope.validacoes.catalogo).toMatchObject({ status: "fresh", source: "network" });
    expect(result.envelope.validacoes.bindings[0].status).toBe("unknown-model");
  });
});

describe("setup config persistence", () => {
  it("writes canonical sorted JSON atomically and is idempotent", async () => {
    const now = Date.now();
    const first = await executeSetupAction(
      ["--non-interactive", "--bind", "reviewer=codex:gpt-5"],
      {
        isTTY: false,
        registry: fakeRegistry("codex"),
        discoverModels: async () => [catalog("codex", [{ id: "gpt-5" }], new Date(now).toISOString())],
        saveCache: () => true,
        now: () => now,
        timeoutMs: 20,
      },
    );
    const file = getPaths().configFile;
    expect(first.code).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const firstBytes = fs.readFileSync(file, "utf8");
    const firstMtime = fs.statSync(file).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await executeSetupAction(
      ["--non-interactive", "--bind", "reviewer=codex:gpt-5"],
      {
        isTTY: false,
        registry: fakeRegistry("codex"),
        discoverModels: async () => [catalog("codex", [{ id: "gpt-5" }], new Date(now).toISOString())],
        saveCache: () => true,
        now: () => now,
        timeoutMs: 20,
      },
    );
    expect(second.code).toBe(0);
    expect(second.envelope?.resultado.status).toBe("unchanged");
    expect(second.envelope?.mudancas).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(firstBytes);
    expect(fs.statSync(file).mtimeMs).toBe(firstMtime);
    expect(fs.readdirSync(path.dirname(file)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("fsyncs the temporary file and its parent directory", () => {
    const fsync = vi.spyOn(fs, "fsyncSync");
    try {
      expect(saveConfig({ defaultModel: "fsync" })).toBe(true);
      expect(fsync).toHaveBeenCalledTimes(2);
    } finally {
      fsync.mockRestore();
    }
  });

  it("removes the temporary file when rename fails", () => {
    const file = getPaths().configFile;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });
    try {
      expect(() => saveConfig({ defaultModel: "rename" })).toThrow("rename failed");
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(path.dirname(file)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  it("preserves an invalid config and never reports it as saved", async () => {
    const file = getPaths().configFile;
    fs.writeFileSync(file, "{ broken", "utf8");
    const original = fs.readFileSync(file, "utf8");
    const discover = vi.fn<NonNullable<SetupBatchDependencies["discoverModels"]>>();
    const result = await executeSetupAction(
      ["--non-interactive", "--json", "--bind", "reviewer=codex:gpt-5"],
      {
        isTTY: false,
        stdout: Object.assign(new MemoryWritable(), { isTTY: false }),
        stderr: new MemoryWritable(),
        registry: fakeRegistry("codex"),
        discoverModels: discover,
        saveCache: () => true,
      },
    );
    expect(result.code).toBe(14);
    expect(result.envelope?.validacoes.config.status).toBe("invalid");
    expect(result.envelope?.resultado.saved).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(discover).not.toHaveBeenCalled();
  });

  it("does not follow a symlink at the canonical target", async () => {
    const file = getPaths().configFile;
    const outside = path.join(path.dirname(file), "outside.json");
    fs.writeFileSync(outside, serializeConfig({ defaultModel: "outside" }), "utf8");
    fs.symlinkSync(outside, file);
    const result = await executeSetupAction(
      ["--non-interactive", "--bind", "reviewer=codex:gpt-5"],
      {
        isTTY: false,
        registry: fakeRegistry("codex"),
        discoverModels: async () => [catalog("codex", [{ id: "gpt-5" }])],
        saveCache: () => true,
      },
    );
    expect(result.code).toBe(15);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toContain("outside");
  });

  it("reads and migrates the legacy file only without a config override", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "codedeck-setup-home-"));
    delete process.env.RUN_AGENT_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    const legacy = path.join(home, ".run-agent", "config.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacy, JSON.stringify({ defaultModel: "legacy" }), "utf8");

    const result = await executeSetupAction(
      ["--non-interactive", "--bind", "reviewer=codex:gpt-5"],
      {
        isTTY: false,
        registry: fakeRegistry("codex"),
        discoverModels: async () => [catalog("codex", [{ id: "gpt-5" }])],
        saveCache: () => true,
      },
    );
    expect(result.code).toBe(0);
    expect(result.envelope?.validacoes.config.source).toBe("legacy");
    expect(fs.existsSync(getPaths().configFile)).toBe(true);
    expect(fs.readFileSync(legacy, "utf8")).toBe(JSON.stringify({ defaultModel: "legacy" }));
    expect(JSON.parse(fs.readFileSync(getPaths().configFile, "utf8"))).toMatchObject({
      defaultModel: "legacy",
      agents: { reviewer: { harness: "codex", model: "gpt-5" } },
    });
  });

  it("keeps runtime and config path precedence independent", () => {
    const runtime = mkdtempSync(path.join(tmpdir(), "codedeck-runtime-path-"));
    const config = mkdtempSync(path.join(tmpdir(), "codedeck-config-path-"));
    const xdg = mkdtempSync(path.join(tmpdir(), "codedeck-xdg-path-"));
    process.env.RUN_AGENT_DIR = runtime;
    process.env.RUN_AGENT_CONFIG_DIR = config;
    process.env.XDG_CONFIG_HOME = xdg;
    expect(getPaths().base).toBe(path.resolve(runtime));
    expect(getPaths().configFile).toBe(path.resolve(config, "config.json"));
    delete process.env.RUN_AGENT_CONFIG_DIR;
    expect(getPaths().configFile).toBe(path.resolve(xdg, "run-agent", "config.json"));
  });

  it("does not call save when the injected config store rejects a write", async () => {
    const store = configStore();
    store.save.mockImplementation(() => {
      throw new Error("fsync failed");
    });
    const result = await runSetupBatch(
      options(["--non-interactive", "--bind", "reviewer=codex:gpt-5"]),
      dependencies(store, async () => [catalog("codex", [{ id: "gpt-5" }])]),
    );
    expect(result.code).toBe(15);
    expect(result.envelope.resultado.saved).toBe(false);
    expect(result.envelope.resultado.message).toContain("fsync failed");
  });
});

describe("config store seam", () => {
  it("keeps the regular config loader fallback separate from strict setup reads", () => {
    const file = getPaths().configFile;
    fs.writeFileSync(file, "not json", "utf8");
    expect(createSetupConfigStore().read().status).toBe("invalid");
    expect(saveConfig({ defaultModel: "valid" })).toBe(true);
  });
});
