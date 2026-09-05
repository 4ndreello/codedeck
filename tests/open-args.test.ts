import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROLES,
  buildOpenArgs,
  isNonInteractiveLaunch,
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
