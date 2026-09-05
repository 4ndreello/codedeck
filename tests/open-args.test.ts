import path from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import type { HarnessModels } from "../src/core/models.js";
import {
  ROLES,
  buildOpenArgs,
  effectiveModel,
  entitlementError,
  exitCodeFor,
  isNonInteractiveLaunch,
  judgeModel,
  parseRole,
  registerOpenCommand,
  renderBanner,
  resolvePluginDir,
  sanitizeEnv,
} from "../src/cli/commands/open.js";

describe("open command argument builder", () => {
  it("uses the CodeDeck defaults and plugin contract", () => {
    const args = buildOpenArgs("orchestrator", {}, "/opt/codedeck/plugin", []);

    expect(args).toEqual([
      "--model",
      "claude-opus-4-8",
      "--effort",
      "xhigh",
      "--dangerously-skip-permissions",
      "--plugin-dir",
      "/opt/codedeck/plugin",
      "--append-system-prompt-file",
      "/opt/codedeck/plugin/ultra.md",
      "--settings",
      "/opt/codedeck/plugin/settings.json",
      "--agent",
      "codedeck:orchestrator",
      "-n",
      "CodeDeck · orchestrator",
    ]);
  });

  it("overrides launcher settings and appends Claude arguments verbatim", () => {
    const args = buildOpenArgs(
      "reviewer",
      {
        model: "claude-sonnet",
        effort: "high",
        resume: "session-42",
        worktree: true,
        bypass: false,
      },
      "/opt/codedeck/plugin",
      ["--model", "claude-opus-4-8", "--add-dir", "other tree"],
    );

    expect(args).toEqual([
      "--model",
      "claude-sonnet",
      "--effort",
      "high",
      "--plugin-dir",
      "/opt/codedeck/plugin",
      "--append-system-prompt-file",
      "/opt/codedeck/plugin/ultra.md",
      "--settings",
      "/opt/codedeck/plugin/settings.json",
      "--agent",
      "codedeck:reviewer",
      "-n",
      "CodeDeck · reviewer",
      "--resume",
      "session-42",
      "-w",
      "--model",
      "claude-opus-4-8",
      "--add-dir",
      "other tree",
    ]);
  });

  it("keeps statusLine while removing theme settings", () => {
    const args = buildOpenArgs("general", { theme: false }, "/opt/codedeck/plugin", []);
    const settingsIndex = args.indexOf("--settings");
    const settings = JSON.parse(args[settingsIndex + 1] ?? "{}");

    expect(settings).toEqual({
      statusLine: {
        type: "command",
        command: 'bash "/opt/codedeck/plugin/statusline.sh"',
      },
    });
    expect(args).not.toContain("--agent");
  });

  // statusLine.command is a shell command, so an install under a directory with
  // a space silently loses the status line if the path is not quoted.
  it("quotes the statusline path so a space cannot split it", () => {
    const args = buildOpenArgs("general", { theme: false }, "/opt/Code Deck/plugin", []);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");

    expect(settings.statusLine.command).toBe('bash "/opt/Code Deck/plugin/statusline.sh"');
  });
});

describe("open command pure helpers", () => {
  it("parses the supported roles and rejects unknown roles", () => {
    expect(ROLES).toEqual(["general", "orchestrator", "reviewer"]);
    expect(parseRole(undefined)).toBeUndefined();
    expect(parseRole("orchestrator")).toBe("orchestrator");
    expect(parseRole(" REVIEWER ")).toBe("reviewer");
    expect(parseRole("implementer")).toBeUndefined();
  });

  it("removes only the nested Claude session marker", () => {
    const env = { PATH: "/bin", CLAUDE_CODE_CHILD_SESSION: "1" };
    const sanitized = sanitizeEnv(env);

    expect(sanitized).toEqual({ PATH: "/bin" });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe("1");
  });

  it("renders one readable banner string", () => {
    const banner = renderBanner("reviewer");

    expect(typeof banner).toBe("string");
    expect(banner).toContain("CodeDeck · reviewer");
    expect(banner).toContain("\n");
  });

  it("resolves a module-relative plugin directory", () => {
    const pluginDir = resolvePluginDir();

    expect(path.isAbsolute(pluginDir)).toBe(true);
    expect(path.basename(pluginDir)).toBe("plugin");
  });
});

// Under a pty (CI, `script`, most runners) stdout is a TTY, so a terminal check
// alone lets the role picker and the model wizard block a `-p` launch forever.
// This is the flag that says the launch answers once and exits.
describe("non-interactive launch detection", () => {
  it("recognises both spellings of the print flag anywhere in the passthrough", () => {
    expect(isNonInteractiveLaunch(["--print"])).toBe(true);
    expect(isNonInteractiveLaunch(["-p"])).toBe(true);
    expect(isNonInteractiveLaunch(["--max-turns", "1", "-p", "hello"])).toBe(true);
  });

  it("leaves an interactive launch alone", () => {
    expect(isNonInteractiveLaunch([])).toBe(false);
    expect(isNonInteractiveLaunch(["--add-dir", "/tmp"])).toBe(false);
  });

  it("does not mistake a prompt that merely mentions the flag for the flag", () => {
    expect(isNonInteractiveLaunch(["explain --print to me"])).toBe(false);
    expect(isNonInteractiveLaunch(["--printer"])).toBe(false);
  });
});

describe("effective model", () => {
  it("takes the last --model, which is the one claude honours", () => {
    const args = buildOpenArgs("general", { model: "resolved" }, "/p", ["--model", "override"]);

    expect(effectiveModel(args)).toBe("override");
  });

  it("falls back to the resolved one when the passthrough carries none", () => {
    const args = buildOpenArgs("general", { model: "resolved" }, "/p", ["--print"]);

    expect(effectiveModel(args)).toBe("resolved");
  });

  it("reports nothing when no --model has a value after it", () => {
    expect(effectiveModel([])).toBeUndefined();
    expect(effectiveModel(["--model"])).toBeUndefined();
  });
});

// Collapsing a signalled death to 1 tells the caller the session failed when it
// was actually killed. Shells report 128 plus the signal number.
describe("exit code", () => {
  it("passes a real exit code through, zero included", () => {
    expect(exitCodeFor(0, null)).toBe(0);
    expect(exitCodeFor(2, null)).toBe(2);
  });

  it("maps a signal to the conventional 128 plus its number", () => {
    expect(exitCodeFor(null, "SIGINT")).toBe(130);
    expect(exitCodeFor(null, "SIGKILL")).toBe(137);
    expect(exitCodeFor(null, "SIGTERM")).toBe(143);
  });

  it("falls back to 1 when there is neither", () => {
    expect(exitCodeFor(null, null)).toBe(1);
  });
});

// Unknown options must reach claude through the passthrough, but accepting them
// before the separator makes a typo in a safety flag silent: `--no-bypas` looked
// like it disabled the permission bypass and launched with it still on.
describe("unknown options before the separator", () => {
  const run = (argv: string[]) => {
    const program = new Command();
    program.name("codedeck").exitOverride();
    registerOpenCommand(program);
    return program.parseAsync(["node", "codedeck", ...argv]);
  };

  it("rejects a misspelled option instead of ignoring it", async () => {
    await expect(run(["open", "--no-bypas", "--", "--print"])).rejects.toThrow(/--no-bypas/);
    await expect(run(["open", "--modl", "x", "--", "--print"])).rejects.toThrow(/--modl/);
  });

  it("rejects it even without a separator", async () => {
    await expect(run(["open", "--no-bypas"])).rejects.toThrow(/--no-bypas/);
  });

  it("says where Claude's own options belong", async () => {
    await expect(run(["open", "--no-bypas", "--", "-p"])).rejects.toThrow(/after "--"/);
  });
});

// The catalog answers "does this model exist", never "may this account use it".
// Those are different failures with different fixes, so they get different
// messages: one names a typo, the other names the plan.
describe("model preflight", () => {
  const catalog = (models: { id: string; aliases?: string[] }[]): HarnessModels[] => [
    {
      agent: "claude",
      available: true,
      providers: [
        {
          provider: "anthropic",
          models: models.map((m) => ({ ...m, name: m.id, provider: "anthropic" })),
        },
      ],
    },
  ];

  it("accepts a model listed under its id or an alias", () => {
    const models = catalog([{ id: "claude-opus-4-8", aliases: ["opus"] }]);

    expect(judgeModel("claude-opus-4-8", models)).toEqual({ kind: "ok" });
    expect(judgeModel("opus", models)).toEqual({ kind: "ok" });
  });

  it("rejects an unlisted model and points at the closest one", () => {
    const verdict = judgeModel("claude-opus-4-9", catalog([{ id: "claude-opus-4-8" }]));

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).toContain("claude-opus-4-8");
  });

  it("rejects without a suggestion when nothing is close", () => {
    const verdict = judgeModel("zzzzzzzzzz", catalog([{ id: "claude-opus-4-8" }]));

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).toContain("No close model was found");
  });

  // An unreachable catalog is not evidence against the model. Failing here
  // would ground the user over a stale cache or an offline harness.
  it.each([
    ["no claude entry", []],
    ["harness not installed", [{ agent: "claude", available: false, providers: [] }]],
    ["discovery errored", [{ agent: "claude", available: true, error: "timed out", providers: [] }]],
    ["empty catalog", catalog([])],
    ["nothing at all", undefined],
  ] as [string, HarnessModels[] | undefined][])(
    "warns and continues when the catalog is unusable: %s",
    (_label, models) => {
      const verdict = judgeModel("claude-opus-4-8", models);

      expect(verdict.kind).toBe("unknown-catalog");
      if (verdict.kind !== "unknown-catalog") return;
      expect(verdict.warning).toContain("claude-opus-4-8");
    },
  );

  it("translates the entitlement tag and stays quiet otherwise", () => {
    expect(entitlementError("claude-opus-4-8", "boom [claude-code:unrecognized_model] boom"))
      .toContain("not entitled");
    expect(entitlementError("claude-opus-4-8", "some unrelated failure")).toBeUndefined();
  });

  // Passthrough can carry its own --model, which wins over the resolved one, so
  // naming the model CodeDeck chose would point the user at the wrong string.
  it("names the model claude actually rejected, not the one CodeDeck resolved", () => {
    const line = '[claude-code:unrecognized_model] {"model":"made-up-xyz","query_source":"sdk"}';

    expect(entitlementError("claude-opus-4-8", line)).toContain('"made-up-xyz"');
    expect(entitlementError("claude-opus-4-8", line)).not.toContain("claude-opus-4-8");
  });

  it("falls back to the resolved model when the tag carries no usable payload", () => {
    expect(entitlementError("claude-opus-4-8", "[claude-code:unrecognized_model] {oops"))
      .toContain('"claude-opus-4-8"');
    expect(entitlementError("claude-opus-4-8", "[claude-code:unrecognized_model] {}"))
      .toContain('"claude-opus-4-8"');
  });
});
