import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISPATCHER_PRESET } from "../src/config/orchestrator-mode.js";
import {
  buildOpenArgs,
  CODEX_NOT_FOUND,
  codexSessionsDir,
  developerInstructionsOverride,
  diffCodexRollouts,
  diffCodexRolloutsAcross,
  initialPrompt,
  judgeModel,
  preflight,
  readCodexRollouts,
  resolveBinary,
  roleSandbox,
  rolloutIdentity,
  threadIdFromRollout,
} from "../src/open/launchers/codex.js";
import { isNonInteractiveLaunch } from "../src/cli/commands/open.js";
import { readUltra } from "../src/open/contract.js";
import * as models from "../src/core/models.js";
import { detectBinary } from "../src/drivers/helpers.js";
import { resolvePluginDir, roleBody } from "../src/core/roles.js";
import { composeOrchestratorProse } from "../src/open/orchestrator-prose.js";

// Hoisted above the imports it shadows: only the codex binary lookup is
// faked, everything else in the helpers module stays real.
vi.mock("../src/drivers/helpers.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/drivers/helpers.js")>();
  return { ...mod, detectBinary: vi.fn() };
});

const mockedDetect = vi.mocked(detectBinary);
const pluginDir = resolvePluginDir();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("roleSandbox", () => {
  it("keeps read-only roles on read-only", () => {
    expect(roleSandbox("reviewer")).toBe("read-only");
    expect(roleSandbox("auditor")).toBe("read-only");
  });

  it("keeps dispatching roles on workspace-write", () => {
    expect(roleSandbox("general")).toBe("workspace-write");
    expect(roleSandbox("orchestrator")).toBe("workspace-write");
  });
});

describe("initialPrompt", () => {
  it("carries the ultra text and the role body", () => {
    const prompt = initialPrompt(pluginDir, "reviewer");

    expect(prompt).toContain(readUltra(pluginDir).trimEnd());
    expect(prompt).toContain(roleBody(pluginDir, "reviewer"));
  });

  it("adds orchestrator prose only for the orchestrator", () => {
    const proseMode = { ...DISPATCHER_PRESET, parallelism: 3 };
    expect(composeOrchestratorProse(proseMode)).not.toBe("");
    expect(initialPrompt(pluginDir, "orchestrator", proseMode)).toContain(
      composeOrchestratorProse(proseMode),
    );
    expect(initialPrompt(pluginDir, "reviewer", proseMode)).not.toContain(
      composeOrchestratorProse(proseMode),
    );
  });
});

describe("buildOpenArgs", () => {
  it("opens a fresh read-only session with bypass on and no model flag", () => {
    const args = buildOpenArgs("reviewer", {}, pluginDir, [], "/wrk");

    expect(args.slice(0, 2)).toEqual(["-s", "read-only"]);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--json");
    expect(args).toContain("-C");
    expect(args).toContain("/wrk");
  });

  it("delivers the role contract as developer_instructions with no opening prompt", () => {
    const args = buildOpenArgs("reviewer", {}, pluginDir, ["--search"], "/wrk");
    const expected = developerInstructionsOverride(initialPrompt(pluginDir, "reviewer"));

    expect(args).toContain(expected);
    expect(args).not.toContain(initialPrompt(pluginDir, "reviewer"));
    expect(args.at(-1)).toBe("--search");
    // The -c value sits adjacent to its flag, or codex reads the next flag
    // as the value.
    const flagIndex = args.indexOf("-c");
    expect(args[flagIndex + 1]).toBe(expected);
  });

  it("passes an explicit model and effort, and drops the bypass on demand", () => {
    const args = buildOpenArgs(
      "general",
      { model: "gpt-5.6", effort: "xhigh", bypass: false },
      pluginDir,
      [],
      "/wrk",
    );

    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.6");
    expect(args).toContain(`model_reasoning_effort="xhigh"`);
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    // Model before sandbox, mirroring the exec driver's flag order.
    expect(args.slice(0, 4)).toEqual(["-m", "gpt-5.6", "-s", "workspace-write"]);
  });

  it("rejects an effort outside the known levels instead of interpolating it", () => {
    expect(() => buildOpenArgs("general", { effort: '" approval_policy="never' }, pluginDir, [], "/wrk"))
      .toThrow(/Invalid effort/);
  });

  it("resumes without sandbox, cwd or contract instructions", () => {
    const args = buildOpenArgs(
      "reviewer",
      { model: "gpt-5.6", resume: "thread-1" },
      pluginDir,
      ["hello again"],
      "/wrk",
    );

    expect(args.slice(0, 2)).toEqual(["resume", "thread-1"]);
    expect(args).not.toContain("-s");
    expect(args).not.toContain("-C");
    expect(args).not.toContain(roleBody(pluginDir, "reviewer"));
    expect(args.some((arg) => arg.startsWith("developer_instructions="))).toBe(false);
    expect(args).toContain("-m");
    expect(args.at(-1)).toBe("hello again");
  });
});

describe("developerInstructionsOverride", () => {
  it("wraps the contract as a TOML multiline string", () => {
    const override = developerInstructionsOverride("line1\nline2");

    expect(override.startsWith('developer_instructions="""')).toBe(true);
    expect(override.endsWith('"""')).toBe(true);
    expect(override).toContain("line1\nline2");
  });

  it("escapes quotes and backslashes so the contract cannot inject config", () => {
    const override = developerInstructionsOverride('say "hi" \\ done');

    expect(override).toContain('\\"hi\\"');
    expect(override).toContain("\\\\");
  });

  it("emits other C0 controls as unicode escapes, keeping LF raw", () => {
    const bell = String.fromCharCode(7);
    const backspace = String.fromCharCode(8);
    const tab = String.fromCharCode(9);
    const vt = String.fromCharCode(11);
    const override = developerInstructionsOverride(`a${bell}b${backspace}c${tab}d\ne${vt}f`);

    expect(override).toContain("\\u0007");
    expect(override).toContain("\\u0008");
    expect(override).toContain("\\u0009");
    expect(override).toContain("d\ne");
    expect(override).not.toContain(bell);
    expect(override).not.toContain(vt);
  });
});

describe("judgeModel", () => {
  it("judges against the codex catalog", () => {
    const catalogs = [
      {
        agent: "codex",
        available: true,
        providers: [
          { provider: "openai", displayName: "OpenAI", models: [{ id: "gpt-5", name: "gpt-5" }] },
        ],
      },
    ] as never;

    expect(judgeModel("gpt-5", catalogs, false).kind).toBe("ok");
    expect(judgeModel("nope", catalogs, false).kind).toBe("rejected");
  });
});

describe("preflight", () => {
  const catalogListing = (...ids: string[]) => [
    {
      agent: "codex",
      available: true,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          models: ids.map((id) => ({ id, name: id, provider: "openai" })),
        },
      ],
    },
  ];

  it("pins the launch to whatever the codex catalog answers", async () => {
    const discover = vi.spyOn(models, "getCachedOrDiscoverModels");
    discover.mockResolvedValueOnce([]);
    await preflight("gpt-5", false);
    expect(discover).toHaveBeenCalledWith(expect.anything(), { agent: "codex" });

    discover.mockResolvedValueOnce(catalogListing("gpt-5"));
    await expect(preflight("gpt-zzz", false)).rejects.toThrow(/not in the Codex catalog/);
  });

  it("treats an unreachable catalog as unknown, not as rejection", async () => {
    vi.spyOn(models, "getCachedOrDiscoverModels").mockRejectedValueOnce(new Error("net down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(preflight("gpt-5", false)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });
});

describe("resolveBinary", () => {
  it("throws the codex message when the binary is missing", async () => {
    mockedDetect.mockResolvedValueOnce({ installed: false });

    await expect(resolveBinary()).rejects.toThrow(CODEX_NOT_FOUND);
  });

  it("returns the checked path when codex is present", async () => {
    mockedDetect.mockResolvedValueOnce({ installed: true, path: "/bin/codex" });

    await expect(resolveBinary()).resolves.toBe("/bin/codex");
  });
});

describe("codexSessionsDir", () => {
  it("honours CODEX_HOME", () => {
    const dir = codexSessionsDir(new Date(2026, 8, 10), "/home/u", "/custom/codex");

    expect(dir).toBe(path.join("/custom/codex", "sessions", "2026", "09", "10"));
  });

  it("defaults under the home directory with the local date", () => {
    const dir = codexSessionsDir(new Date(2026, 0, 5), "/home/u", undefined);

    expect(dir).toBe(path.join("/home/u", ".codex", "sessions", "2026", "01", "05"));
  });
});

describe("codex rollout capture", () => {
  const sessionId = "92d88cce-bdbc-46db-8573-916afd32f6f7";

  const writeRollout = (dir: string, name: string, id: unknown, cwd = "/wrk"): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n{}\n`,
    );
    return file;
  };

  const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-codex-"));

  it("lists only rollout files", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "rollout-a.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "nope\n");

    expect(readCodexRollouts(dir)).toEqual(["rollout-a.jsonl"]);
  });

  it("reads a missing directory as empty, not as failed capture", () => {
    expect(readCodexRollouts(path.join(os.tmpdir(), "codedeck-codex-missing"))).toEqual([]);
  });

  it("reads the thread id off the session_meta line", () => {
    const dir = tempDir();
    const file = writeRollout(dir, "rollout-a.jsonl", sessionId);

    expect(threadIdFromRollout(file)).toBe(sessionId);
    expect(rolloutIdentity(file)).toEqual({ id: sessionId, cwd: "/wrk" });
  });

  it("refuses a rollout from another working directory when cwd is known", () => {
    const dir = tempDir();
    const file = writeRollout(dir, "rollout-a.jsonl", sessionId, "/other");

    expect(threadIdFromRollout(file, "/wrk")).toBeUndefined();
    expect(threadIdFromRollout(file, "/other")).toBe(sessionId);
    expect(threadIdFromRollout(file)).toBe(sessionId);
  });

  it("rejects a rollout without a usable id", () => {
    const dir = tempDir();
    const bad = writeRollout(dir, "rollout-bad.jsonl", "not an id!!");
    const plain = path.join(dir, "rollout-plain.jsonl");
    fs.writeFileSync(plain, "not json\n");

    expect(threadIdFromRollout(bad)).toBeUndefined();
    expect(threadIdFromRollout(plain)).toBeUndefined();
    expect(threadIdFromRollout(path.join(dir, "rollout-gone.jsonl"))).toBeUndefined();
  });

  it("diffs the single session created between snapshots", () => {
    const dir = tempDir();
    writeRollout(dir, "rollout-a.jsonl", sessionId);
    const before = readCodexRollouts(dir) ?? [];
    writeRollout(dir, "rollout-b.jsonl", sessionId);

    expect(diffCodexRollouts(dir, before, readCodexRollouts(dir) ?? [], "/wrk")).toBe(sessionId);
    expect(diffCodexRollouts(dir, before, readCodexRollouts(dir) ?? [], "/other")).toBeUndefined();
  });

  it("finds a session that crossed midnight into a new day directory", () => {
    const dayOne = tempDir();
    const dayTwo = tempDir();
    writeRollout(dayOne, "rollout-a.jsonl", sessionId);
    const before = readCodexRollouts(dayOne) ?? [];
    writeRollout(dayTwo, "rollout-b.jsonl", sessionId);

    expect(
      diffCodexRolloutsAcross(
        before,
        [
          { dir: dayOne, files: readCodexRollouts(dayOne) ?? [] },
          { dir: dayTwo, files: readCodexRollouts(dayTwo) ?? [] },
        ],
        "/wrk",
      ),
    ).toBe(sessionId);
  });

  it("captures the first session of a day with no before snapshot", () => {
    const dir = tempDir();
    writeRollout(dir, "rollout-a.jsonl", sessionId);

    expect(
      diffCodexRolloutsAcross([], [{ dir, files: readCodexRollouts(dir) ?? [] }], "/wrk"),
    ).toBe(sessionId);
  });

  it("calls zero or ambiguous snapshots cannot-tell", () => {
    const dir = tempDir();
    writeRollout(dir, "rollout-a.jsonl", sessionId);
    const before = readCodexRollouts(dir) ?? [];

    expect(diffCodexRollouts(dir, before, [...before])).toBeUndefined();

    writeRollout(dir, "rollout-b.jsonl", sessionId);
    writeRollout(dir, "rollout-c.jsonl", sessionId);
    expect(diffCodexRollouts(dir, before, readCodexRollouts(dir) ?? [])).toBeUndefined();
  });
});

describe("isNonInteractiveLaunch for codex", () => {
  it("never treats -p as print: it is --profile on codex", () => {
    expect(isNonInteractiveLaunch(["-p", "myprofile"], "codex")).toBe(false);
    expect(isNonInteractiveLaunch(["--print"], "codex")).toBe(false);
    expect(isNonInteractiveLaunch([], "codex")).toBe(false);
  });

  it("keeps claude semantics by default", () => {
    expect(isNonInteractiveLaunch(["-p"])).toBe(true);
    expect(isNonInteractiveLaunch(["-p"], "claude")).toBe(true);
  });
});
