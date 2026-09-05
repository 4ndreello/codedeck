import path from "node:path";
import { describe, expect, it } from "vitest";

import type { HarnessModels } from "../src/core/models.js";
import {
  ROLES,
  buildOpenArgs,
  entitlementError,
  isNonInteractiveLaunch,
  judgeModel,
  parseRole,
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
        command: "/opt/codedeck/plugin/statusline.sh",
      },
    });
    expect(args).not.toContain("--agent");
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
