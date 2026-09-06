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
  harnessMismatch,
  isNonInteractiveLaunch,
  judgeModel,
  parseRole,
  registerOpenCommand,
  renderBanner,
  resolvePluginDir,
  sanitizeEnv,
  scanOptions,
} from "../src/cli/commands/open.js";

/** The launcher passes settings inline, so every assertion reads them back. */
const settingsOf = (args: string[]) =>
  JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}") as Record<string, any>;

describe("open command argument builder", () => {
  it("uses the CodeDeck defaults and plugin contract", () => {
    const args = buildOpenArgs("orchestrator", {}, "/opt/codedeck/plugin", []);
    const settingsIndex = args.indexOf("--settings");

    expect(args.filter((_, i) => i !== settingsIndex + 1)).toEqual([
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
      "--agent",
      "codedeck:orchestrator",
      "-n",
      "CodeDeck · orchestrator",
    ]);
  });

  // `--agent` layers on Claude's own system prompt instead of replacing it, and
  // an agent file with no `tools:` key keeps the whole toolset, so general has
  // no reason to be the one role launched without its contract.
  it("hands general the same --agent as every other role", () => {
    const args = buildOpenArgs("general", {}, "/opt/codedeck/plugin", []);

    expect(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2)).toEqual([
      "--agent",
      "codedeck:general",
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
    const settingsIndex = args.indexOf("--settings");

    expect(args.filter((_, i) => i !== settingsIndex + 1)).toEqual([
      "--model",
      "claude-sonnet",
      "--effort",
      "high",
      "--plugin-dir",
      "/opt/codedeck/plugin",
      "--append-system-prompt-file",
      "/opt/codedeck/plugin/ultra.md",
      "--settings",
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

  // ${CLAUDE_PLUGIN_ROOT} is expanded only for hooks declared in a plugin's
  // hooks/hooks.json. In statusLine.command it throws inside the runner, which
  // swallows it: no status line, no error, not even under --debug. The command
  // has to name a path that needs no expansion.
  it("resolves the statusline path instead of leaving a plugin-root placeholder", () => {
    const settings = settingsOf(buildOpenArgs("general", {}, "/opt/codedeck/plugin", []));

    expect(settings.statusLine).toEqual({
      type: "command",
      command: "bash '/opt/codedeck/plugin/statusline.sh'",
    });
    expect(JSON.stringify(settings)).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("declares the whole CodeDeck look", () => {
    const settings = settingsOf(buildOpenArgs("reviewer", {}, "/opt/codedeck/plugin", []));

    expect(settings.theme).toBe("custom:codedeck:codedeck-ultra");
    expect(settings.tui).toBe("fullscreen");
    expect(settings.spinnerVerbs.mode).toBe("replace");
    expect(settings.spinnerVerbs.verbs.length).toBeGreaterThan(8);
    expect(settings.spinnerTipsOverride).toMatchObject({ excludeDefault: true, label: "ULTRA" });
    expect(settings.spinnerTipsOverride.tips.length).toBeGreaterThan(0);
  });

  // "replace" drops Claude Code's own verbs, so an empty or one-entry list
  // would leave the spinner saying the same word for a whole session.
  it("carries enough spinner verbs to replace the built-in ones", () => {
    const { spinnerVerbs } = settingsOf(buildOpenArgs("general", {}, "/opt/codedeck/plugin", []));

    expect(new Set(spinnerVerbs.verbs).size).toBe(spinnerVerbs.verbs.length);
    for (const verb of spinnerVerbs.verbs) expect(verb.trim()).toBe(verb);
  });

  // Every tip is read as a command someone will type, so a tip naming a command
  // this CLI does not ship is worse than no tip.
  it("only advertises commands the CLI actually ships", () => {
    const commands = new Set([
      "run", "ps", "logs", "wait", "diff", "stop", "send", "show", "open", "setup",
      "models", "doctor",
    ]);
    const { spinnerTipsOverride } = settingsOf(
      buildOpenArgs("general", {}, "/opt/codedeck/plugin", []),
    );

    for (const tip of spinnerTipsOverride.tips as string[]) {
      const named = tip.match(/codedeck ([a-z-]+)/)?.[1];
      expect(named, tip).toBeDefined();
      expect(commands, tip).toContain(named);
    }
  });

  // The announcement is the only text CodeDeck gets to put on the opening
  // screen, and under the fullscreen renderer it is the only one that survives:
  // the alternate screen wipes whatever was printed before the launch.
  it("announces the role, model, effort and permission state", () => {
    const settings = settingsOf(
      buildOpenArgs("auditor", { model: "claude-sonnet" }, "/opt/codedeck/plugin", []),
    );

    expect(settings.companyAnnouncements).toHaveLength(1);
    expect(settings.companyAnnouncements[0]).toContain("CODEDECK ULTRA");
    expect(settings.companyAnnouncements[0]).toContain(
      "auditor · claude-sonnet · xhigh · permissions bypassed",
    );
  });

  it("says so in the announcement when the bypass is off", () => {
    const settings = settingsOf(
      buildOpenArgs("general", { bypass: false }, "/opt/codedeck/plugin", []),
    );

    expect(settings.companyAnnouncements[0]).toContain("permissions on");
  });

  // Claude honours the last --model on the line, and the passthrough is
  // appended last, so announcing the resolved one would name a model the
  // session is not running.
  it("announces the model the passthrough overrode to", () => {
    const settings = settingsOf(
      buildOpenArgs("general", { model: "claude-sonnet" }, "/opt/codedeck/plugin", [
        "--model",
        "claude-opus-4-8",
      ]),
    );

    expect(settings.companyAnnouncements[0]).toContain("claude-opus-4-8");
    expect(settings.companyAnnouncements[0]).not.toContain("claude-sonnet");
  });

  it("keeps only the status line when the theme is off", () => {
    const args = buildOpenArgs("general", { theme: false }, "/opt/codedeck/plugin", []);

    expect(settingsOf(args)).toEqual({
      statusLine: {
        type: "command",
        command: "bash '/opt/codedeck/plugin/statusline.sh'",
      },
    });
  });

  // statusLine.command is handed to a shell, so the install directory is not
  // just a string here. Double quotes survive only the first of these; the rest
  // execute or break the command.
  it.each([
    ["a space", "/opt/Code Deck/plugin", "bash '/opt/Code Deck/plugin/statusline.sh'"],
    ["a substitution", "/opt/a$(id)b/plugin", "bash '/opt/a$(id)b/plugin/statusline.sh'"],
    ["a backtick", "/opt/a`id`b/plugin", "bash '/opt/a`id`b/plugin/statusline.sh'"],
    ["a quote", "/opt/it's/plugin", "bash '/opt/it'\\''s/plugin/statusline.sh'"],
  ])("keeps the status line runnable when the path holds %s", (_label, pluginDir, expected) => {
    // Both branches build the same command, so the quoting is checked on the
    // one that used to hand Claude a path it never resolved.
    expect(settingsOf(buildOpenArgs("general", { theme: false }, pluginDir, [])).statusLine.command)
      .toBe(expected);
    expect(settingsOf(buildOpenArgs("general", {}, pluginDir, [])).statusLine.command)
      .toBe(expected);
  });
});

describe("open command pure helpers", () => {
  it("parses the supported roles and rejects unknown roles", () => {
    expect(ROLES).toEqual(["general", "orchestrator", "reviewer", "auditor"]);
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

  it("renders one banner string carrying the whole launch context", () => {
    const banner = renderBanner("reviewer", "claude-opus-5", "xhigh");

    expect(typeof banner).toBe("string");
    expect(banner).toContain("reviewer · claude-opus-5 · xhigh");
    expect(banner).toContain("╔═╗");
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
// `open` launches Claude Code and nothing else. Opening it for an agent bound
// elsewhere would run a session under a name whose configuration it ignores.
describe("an agent bound to another harness", () => {
  it("refuses, naming the harness and the way out", () => {
    const message = harnessMismatch("reviewer", { harness: "codex", model: "gpt-5.6-luna" });

    expect(message).toContain("codex");
    expect(message).toContain("codedeck run --role reviewer");
  });

  it("allows an agent bound to claude, and one nobody bound at all", () => {
    expect(harnessMismatch("general", { harness: "claude", model: "claude-opus-5" })).toBeUndefined();
    expect(harnessMismatch("general", undefined)).toBeUndefined();
  });

  // An explicit --model changes which claude runs, never whether claude is the
  // right harness, so it is no escape from the refusal.
  it("refuses every non-claude harness", () => {
    for (const harness of ["codex", "opencode", "omp"] as const) {
      expect(harnessMismatch("auditor", { harness, model: "whatever" })).toContain(harness);
    }
  });
});

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
    expect(effectiveModel(["--model", "first", "--model", "override"])).toBe("override");
  });

  it("reads the joined spelling too, which claude also accepts", () => {
    expect(effectiveModel(["--model=override"])).toBe("override");
    expect(effectiveModel(["--model", "first", "--model=override"])).toBe("override");
    expect(effectiveModel(["--model=first", "--model", "override"])).toBe("override");
  });

  it("reports nothing when the passthrough carries no model", () => {
    expect(effectiveModel([])).toBeUndefined();
    expect(effectiveModel(["--print", "hi"])).toBeUndefined();
    expect(effectiveModel(["--model"])).toBeUndefined();
  });

  // Scanning the built vector cannot answer "did the passthrough override
  // anything", because that vector always opens with a --model pair. Worse,
  // `open --resume --model` leaves a bare "--model" bound to resume, and the
  // token after it then reads as the model.
  it("does not read the launcher's own arguments", () => {
    const flags = { model: "resolved", resume: "--model", worktree: true };
    const args = buildOpenArgs("general", flags, "/p", []);

    expect(args.slice(args.indexOf("--resume"))).toEqual(["--resume", "--model", "-w"]);
    expect(effectiveModel([])).toBeUndefined();
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

});

// Driven through scanOptions rather than a parse, because the accepted cases
// would otherwise run the whole action and launch a session.
describe("option scanning", () => {
  const openCommand = (): Command => {
    const program = new Command();
    program.name("codedeck").exitOverride();
    registerOpenCommand(program);
    const open = program.commands.find((command) => command.name() === "open");
    if (!open) throw new Error("open command was not registered");
    return open;
  };

  const scan = (tokens: string[]) => scanOptions(tokens, openCommand());

  // Commander honours "=" only on options declared with a value and drops the
  // token otherwise, so this spelling looked accepted and did nothing:
  // `--no-bypass=false` launched with the permission bypass still on.
  it("rejects a value glued to an option that takes none", () => {
    expect(() => scan(["--no-bypass=false"])).toThrow(/takes no value/);
    expect(() => scan(["--worktree=true"])).toThrow(/takes no value/);
  });

  it("accepts a value glued to an option that wants one", () => {
    expect(scan(["--model=sonnet"])).toEqual([]);
  });

  // Commander binds the token after a value-taking option as its value, however
  // much it looks like a flag, so the guard must not read it as one.
  it("does not mistake an option's value for an option", () => {
    expect(scan(["--model", "-weird"])).toEqual([]);
    expect(scan(["--resume", "-abc"])).toEqual([]);
  });

  it("still rejects an unknown option among valid ones", () => {
    expect(() => scan(["--model", "sonnet", "--no-bypas"])).toThrow(/--no-bypas/);
  });

  // The operands are what tells a role from a value that happens to spell one.
  it("reports only the tokens commander did not swallow", () => {
    expect(scan(["reviewer"])).toEqual(["reviewer"]);
    expect(scan(["--resume", "reviewer"])).toEqual([]);
    expect(scan(["--model", "sonnet", "orchestrator"])).toEqual(["orchestrator"]);
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

    expect(judgeModel("claude-opus-4-8", models, false)).toEqual({ kind: "ok" });
    expect(judgeModel("opus", models, false)).toEqual({ kind: "ok" });
  });

  it("rejects an unlisted model and points at the closest one", () => {
    const verdict = judgeModel("claude-opus-4-9", catalog([{ id: "claude-opus-4-8" }]), false);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).toContain("claude-opus-4-8");
  });

  it("rejects without a suggestion when nothing is close", () => {
    const verdict = judgeModel("zzzzzzzzzz", catalog([{ id: "claude-opus-4-8" }]), false);

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
      const verdict = judgeModel("claude-opus-4-8", models, false);

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

describe("a saved model that left the catalog", () => {
  const catalogs = [
    {
      agent: "claude" as const,
      available: true,
      providers: [
        {
          provider: "anthropic",
          models: [{ id: "claude-opus-5", name: "o", provider: "anthropic" }],
        },
      ],
    },
  ];

  it("tells the user to run setup when the model came from config", () => {
    const verdict = judgeModel("claude-opus-4", catalogs, true);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).toContain("codedeck setup");
  });

  // A wrong --model is a typo made just now, not a stale config.
  it("does not mention setup when the model came from a flag", () => {
    const verdict = judgeModel("claude-opus-4", catalogs, false);

    expect(verdict.kind).toBe("rejected");
    if (verdict.kind !== "rejected") return;
    expect(verdict.error).not.toContain("codedeck setup");
  });
});
