import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("../src/drivers/helpers.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/drivers/helpers.js")>();
  return { ...mod, detectBinary: vi.fn() };
});

import { DISPATCHER_PRESET, type OrchestratorMode } from "../src/config/orchestrator-mode.js";
import {
  agentName,
  autonomousCommand,
  buildArgs,
  buildInlineConfig,
  buildTuiConfig,
  createEphemeralTuiDir,
  ensureOpencodeTheme,
  OPENCODE_THEME_NAME,
  preflight,
  removeEphemeralTuiDir,
  resolveBinary,
  rolePermission,
  userThemesDir,
} from "../src/open/launchers/opencode.js";
import { launcherFor } from "../src/cli/commands/open.js";
import * as models from "../src/core/models.js";
import { detectBinary } from "../src/drivers/helpers.js";
import { resolvePluginDir } from "../src/core/roles.js";

const mockedDetect = vi.mocked(detectBinary);

const pluginDir = resolvePluginDir();

const mode = (overrides: Partial<OrchestratorMode> = {}): OrchestratorMode => ({
  ...DISPATCHER_PRESET,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rolePermission", () => {
  it("leaves general unrestricted", () => {
    expect(rolePermission("general")).toEqual({ "*": "allow" });
  });

  it.each([
    ["dispatch", mode(), { read: "deny", edit: "deny", write: "deny", task: "deny", bash: "allow" }],
    ["read", mode({ tools: "read" }), { read: "allow", edit: "deny", write: "deny", task: "deny", bash: "allow" }],
    ["edit", mode({ tools: "edit" }), { read: "allow", edit: "allow", write: "allow", task: "deny", bash: "allow" }],
  ] as const)("maps the orchestrator %s tier explicitly", (_tier, orchestratorMode, expected) => {
    expect(rolePermission("orchestrator", orchestratorMode)).toEqual(expected);
    expect(Object.keys(rolePermission("orchestrator", orchestratorMode))).toEqual([
      "read",
      "edit",
      "write",
      "task",
      "bash",
    ]);
  });

  it("denies reviewer edits and dispatch but keeps bash", () => {
    expect(rolePermission("reviewer")).toEqual({
      edit: "deny",
      write: "deny",
      task: "deny",
      bash: "allow",
    });
  });

  it("lets auditor dispatch but not edit", () => {
    expect(rolePermission("auditor")).toEqual({
      edit: "deny",
      write: "deny",
      task: "allow",
      bash: "allow",
    });
  });
});

describe("buildInlineConfig", () => {
  it("carries instructions, the namespaced agent, and the exact permission map", () => {
    const parsed = JSON.parse(buildInlineConfig(pluginDir, "reviewer")) as any;
    const agent = parsed.agent["codedeck-reviewer"];

    expect(agentName("reviewer")).toBe("codedeck-reviewer");
    expect(parsed.instructions).toHaveLength(1);
    expect(parsed.instructions[0]).toContain("Never round failure to success");
    expect(agent.mode).toBe("primary");
    expect(agent.prompt).toContain("CodeDeck reviewer");
    expect(agent.prompt).not.toContain("tools:");
    expect(agent.permission).toEqual(rolePermission("reviewer"));
    expect(Object.keys(parsed).sort()).toEqual(["agent", "command", "instructions"]);
  });

  it.each([
    ["enabled", { enabled: true }, { auto: true }],
    ["disabled", { enabled: false }, { auto: false }],
    ["manual without enabled", { cap: 300_000 }, { auto: true }],
  ] as const)("maps %s config to native compaction", (_name, autocompact, compaction) => {
    const parsed = JSON.parse(
      buildInlineConfig(pluginDir, "general", DISPATCHER_PRESET, {
        config: { autocompact },
      }),
    ) as any;

    expect(parsed.compaction).toEqual(compaction);
  });

  it.each([true, 200_000, "auto"] as const)("maps explicit %j as enable even without config", (explicit) => {
    const parsed = JSON.parse(
      buildInlineConfig(pluginDir, "general", DISPATCHER_PRESET, { explicit }),
    ) as any;

    expect(parsed.compaction).toEqual({ auto: true });
  });

  it.each([false, "--no-autocompact"] as const)("lets explicit %j win over enabled config", (explicit) => {
    const parsed = JSON.parse(
      buildInlineConfig(pluginDir, "general", DISPATCHER_PRESET, {
        config: { autocompact: { enabled: true } },
        explicit,
      }),
    ) as any;

    expect(parsed.compaction).toEqual({ auto: false });
  });

  it.each([false, "--no-autocompact"] as const)("disables compaction when explicit %j stands alone", (explicit) => {
    const parsed = JSON.parse(
      buildInlineConfig(pluginDir, "general", DISPATCHER_PRESET, { explicit }),
    ) as any;

    expect(parsed.compaction).toEqual({ auto: false });
  });

  it.each([true, 200_000, "auto"] as const)("lets explicit %j win over disabled config", (explicit) => {
    const parsed = JSON.parse(
      buildInlineConfig(pluginDir, "general", DISPATCHER_PRESET, {
        config: { autocompact: { enabled: false } },
        explicit,
      }),
    ) as any;

    expect(parsed.compaction).toEqual({ auto: true });
  });

  // probe-command-2026-09-07 pinned the `command` key as the delivery
  // channel, so the inline config carries /autonomous from the same file
  // Claude serves via --plugin-dir.
  it("delivers /autonomous with the command-file body minus frontmatter", () => {
    const parsed = JSON.parse(buildInlineConfig(pluginDir, "general")) as any;
    const command = parsed.command.autonomous;

    expect(command.description).toBe(
      "Continue this autonomous orchestrator session without human input and write a run report.",
    );
    expect(command.template.startsWith("# Autonomous mode")).toBe(true);
    expect(command.template).toContain("run-report.md");
    expect(command.template).not.toContain("disable-model-invocation");
    expect(autonomousCommand(pluginDir)).toEqual(command);
  });

  it("embeds each role's own permission map", () => {
    for (const role of ["general", "orchestrator", "reviewer", "auditor"] as const) {
      const parsed = JSON.parse(buildInlineConfig(pluginDir, role)) as any;
      expect(parsed.agent[`codedeck-${role}`].permission).toEqual(rolePermission(role));
    }
  });

  it("keeps the dispatcher contract byte-identical", () => {
    expect(buildInlineConfig(pluginDir, "orchestrator", DISPATCHER_PRESET)).toBe(
      buildInlineConfig(pluginDir, "orchestrator"),
    );
  });

  it("appends the resolved orchestrator prose to the agent prompt", () => {
    const parsed = JSON.parse(
      buildInlineConfig(
        pluginDir,
        "orchestrator",
        mode({ investigate: "read", selfWork: "trivial", tools: "edit", parallelism: 2 }),
      ),
    ) as any;

    expect(parsed.agent["codedeck-orchestrator"].prompt).toMatch(
      /Investigation allowance: read\.\nSelf-work allowance: trivial\.\nRun at most 2 workers concurrently\.$/,
    );
  });

  it("selects orchestrator tier agent body according to mode tools", () => {
    const editConfig = JSON.parse(
      buildInlineConfig(pluginDir, "orchestrator", mode({ tools: "edit" })),
    ) as any;
    expect(editConfig.agent["codedeck-orchestrator"].prompt).not.toContain("Bash is your dispatch console");
    expect(editConfig.agent["codedeck-orchestrator"].prompt).toContain("You are the CodeDeck orchestrator");

    const dispatchConfig = JSON.parse(
      buildInlineConfig(pluginDir, "orchestrator", mode({ tools: "dispatch" })),
    ) as any;
    expect(dispatchConfig.agent["codedeck-orchestrator"].prompt).toContain("Bash is your dispatch console");

    const readConfig = JSON.parse(
      buildInlineConfig(pluginDir, "orchestrator", mode({ tools: "read" })),
    ) as any;
    expect(readConfig.agent["codedeck-orchestrator"].prompt).not.toContain("Bash is your dispatch console");
  });

  it("leaves non-orchestrator prompts unchanged for a richer mode", () => {
    expect(
      buildInlineConfig(
        pluginDir,
        "reviewer",
        mode({ investigate: "free", selfWork: "small", tools: "edit", parallelism: 3 }),
      ),
    ).toBe(buildInlineConfig(pluginDir, "reviewer"));
  });

  it("writes nothing to disk", () => {
    const writes = [
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "copyFileSync"),
    ];

    buildInlineConfig(pluginDir, "general");
    buildArgs("general", { model: "prov/m" }, []);

    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
  });
});

describe("buildArgs", () => {
  it("emits agent, model, auto, session, and passthrough in order", () => {
    expect(
      buildArgs("reviewer", { model: "prov/m", resume: "sess-1" }, ["--log-level", "debug"]),
    ).toEqual([
      "--agent",
      "codedeck-reviewer",
      "--model",
      "prov/m",
      "--auto",
      "--session",
      "sess-1",
      "--log-level",
      "debug",
    ]);
  });

  it("drops --auto when bypass is off", () => {
    expect(buildArgs("general", { model: "prov/m", bypass: false }, [])).toEqual([
      "--agent",
      "codedeck-general",
      "--model",
      "prov/m",
    ]);
  });

  it("rejects models outside provider/model shape before spawn", () => {
    for (const bad of ["baremodel", "has space/x", "/leading", "trailing/"]) {
      expect(() => buildArgs("general", { model: bad }, [])).toThrow(/must be provider\/model/);
    }
  });
});

describe("opencode theme", () => {
  // Partial theme files are silently dropped by the TUI: a four-key file
  // selected fine but painted nothing, while the full set painted. The list
  // below is the whole contract the theme file owes.
  const requiredKeys = [
    "primary", "secondary", "accent",
    "error", "warning", "success", "info",
    "text", "textMuted",
    "background", "backgroundPanel", "backgroundElement",
    "border", "borderActive", "borderSubtle",
    "diffAdded", "diffRemoved", "diffContext", "diffHunkHeader",
    "diffHighlightAdded", "diffHighlightRemoved",
    "diffAddedBg", "diffRemovedBg", "diffContextBg",
    "diffLineNumber", "diffAddedLineNumberBg", "diffRemovedLineNumberBg",
    "markdownText", "markdownHeading", "markdownLink", "markdownLinkText",
    "markdownCode", "markdownBlockQuote", "markdownEmph", "markdownStrong",
    "markdownHorizontalRule", "markdownListItem", "markdownCodeBlock",
    "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
    "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
    "syntaxPunctuation",
  ];

  it("selects the managed theme and nothing else", () => {
    expect(OPENCODE_THEME_NAME).toBe("codedeck-rage");
    expect(JSON.parse(buildTuiConfig())).toEqual({
      $schema: "https://opencode.ai/tui.json",
      theme: "codedeck-rage",
    });
  });

  it("ships a complete theme file whose references resolve", () => {
    const file = path.join(pluginDir, "themes", `${OPENCODE_THEME_NAME}.json`);
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as {
      defs: Record<string, string>;
      theme: Record<string, { dark: string; light: string }>;
    };

    for (const key of requiredKeys) {
      expect(doc.theme[key], key).toEqual({
        dark: expect.any(String),
        light: expect.any(String),
      });
    }
    const hex = /^#[0-9a-fA-F]{6}$/;
    for (const [key, variants] of Object.entries(doc.theme)) {
      for (const mode of ["dark", "light"] as const) {
        const value = variants[mode];
        expect(
          value === "none" || hex.test(value) || value in doc.defs,
          `${key}.${mode}`,
        ).toBe(true);
      }
    }
    for (const value of Object.values(doc.defs)) expect(value).toMatch(hex);
  });

  it("resolves the user themes dir from XDG or home", () => {
    expect(userThemesDir("/home/u", "/xdg")).toBe("/xdg/opencode/themes");
    expect(userThemesDir("/home/u", "")).toBe(path.join("/home/u", ".config", "opencode", "themes"));
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(userThemesDir("/home/u")).toBe(
      path.join("/home/u", ".config", "opencode", "themes"),
    );
  });

  it("installs the theme when missing and leaves an identical one alone", () => {
    const themesDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-theme-"));
    try {
      expect(ensureOpencodeTheme(pluginDir, themesDir)).toBe(true);
      const target = path.join(themesDir, `${OPENCODE_THEME_NAME}.json`);
      expect(fs.readFileSync(target, "utf8")).toBe(
        fs.readFileSync(path.join(pluginDir, "themes", `${OPENCODE_THEME_NAME}.json`), "utf8"),
      );

      const write = vi.spyOn(fs, "writeFileSync");
      try {
        expect(ensureOpencodeTheme(pluginDir, themesDir)).toBe(true);
        expect(write).not.toHaveBeenCalled();
      } finally {
        write.mockRestore();
      }
    } finally {
      fs.rmSync(themesDir, { recursive: true, force: true });
    }
  });

  it("refreshes a stale copy and never throws", () => {
    const themesDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-theme-"));
    try {
      const target = path.join(themesDir, `${OPENCODE_THEME_NAME}.json`);
      fs.writeFileSync(target, "stale");
      expect(ensureOpencodeTheme(pluginDir, themesDir)).toBe(true);
      expect(fs.readFileSync(target, "utf8")).not.toBe("stale");

      expect(ensureOpencodeTheme("/no/such/plugin", themesDir)).toBe(false);
      expect(ensureOpencodeTheme(pluginDir, path.join(themesDir, "x"))).toBe(true);
    } finally {
      fs.rmSync(themesDir, { recursive: true, force: true });
    }
  });

  it("creates and removes an ephemeral dir holding only the selection", () => {
    const dir = createEphemeralTuiDir();
    try {
      expect(dir.startsWith(os.tmpdir())).toBe(true);
      expect(fs.readdirSync(dir)).toEqual(["tui.json"]);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "tui.json"), "utf8"))).toEqual(
        JSON.parse(buildTuiConfig()),
      );
    } finally {
      removeEphemeralTuiDir(dir);
    }
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => removeEphemeralTuiDir(dir)).not.toThrow();
  });
});

describe("resolveBinary", () => {
  it("fails with install instructions when opencode is missing", async () => {
    mockedDetect.mockResolvedValueOnce({ installed: false });

    await expect(resolveBinary()).rejects.toThrow(/not found on PATH/);
  });

  it("returns the checked path when opencode is present", async () => {
    mockedDetect.mockResolvedValueOnce({ installed: true, path: "/bin/opencode" });

    await expect(resolveBinary()).resolves.toBe("/bin/opencode");
  });
});

describe("launcherFor", () => {
  it("opens claude for a claude binding", () => {
    expect(launcherFor("general", { harness: "claude", model: "m" })).toBe("claude");
  });

  it("opens claude when nobody bound the role", () => {
    expect(launcherFor("general", undefined)).toBe("claude");
  });

  it("opens opencode for an opencode binding", () => {
    expect(launcherFor("reviewer", { harness: "opencode", model: "prov/m" })).toBe("opencode");
  });

  it("throws instead of rounding codex down to the wrong session", () => {
    expect(() => launcherFor("reviewer", { harness: "codex", model: "m" })).toThrow(/codex/);
  });

  it("throws instead of rounding omp down to the wrong session", () => {
    expect(() => launcherFor("reviewer", { harness: "omp", model: "m" })).toThrow(/omp/);
  });
});

describe("preflight", () => {
  it("warns and continues when discovery throws", async () => {
    vi.spyOn(models, "getCachedOrDiscoverModels").mockRejectedValueOnce(new Error("net down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(preflight("prov/m", false)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });

  it("consults the opencode catalog, not another harness", async () => {
    const discover = vi.spyOn(models, "getCachedOrDiscoverModels").mockResolvedValueOnce([]);

    await preflight("prov/m", false);

    expect(discover).toHaveBeenCalledWith(expect.anything(), { agent: "opencode" });
  });

  it("rejects a model the opencode catalog does not list", async () => {
    vi.spyOn(models, "getCachedOrDiscoverModels").mockResolvedValueOnce([
      {
        agent: "opencode",
        available: true,
        providers: [
          {
            provider: "prov",
            displayName: "Prov",
            models: [{ id: "prov/a", name: "a", provider: "prov" }],
          },
        ],
      },
    ]);

    await expect(preflight("prov/zzz", false)).rejects.toThrow(/not in the opencode catalog/);
  });
});
