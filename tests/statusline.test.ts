import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statusline = path.join(root, "plugin", "statusline.sh");
const project = path.basename(root);
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");

interface RenderOptions {
  payload: Record<string, unknown>;
  runId?: string;
  usage?: Record<string, unknown>;
  shimExitCode?: number;
  sessionId?: string;
  taskName?: string;
}

async function render({ payload, runId, usage, shimExitCode = 0, sessionId, taskName }: RenderOptions): Promise<{
  output: string;
  args: string[];
  exitCode: number | null;
}> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "codedeck-statusline-"));
  const argsPath = path.join(tempDir, "args");
  const shim = path.join(tempDir, "codedeck");
  writeFileSync(argsPath, "");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$CODEDECK_SHIM_ARGS"',
      `printf '%s\\n' '${JSON.stringify(usage ?? {})}'`,
      `exit ${shimExitCode}`,
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o700);

  const env = {
    ...process.env,
    PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CODEDECK_SHIM_ARGS: argsPath,
  };
  if (sessionId !== undefined) {
    const sessionFile = path.join(tempDir, "session");
    env.CODEDECK_SESSION_FILE = sessionFile;
    if (taskName !== undefined) writeFileSync(`${sessionFile}.${sessionId}.name`, taskName);
  } else {
    delete env.CODEDECK_SESSION_FILE;
  }
  if (runId === undefined) delete env.CODEDECK_RUN_ID;
  else env.CODEDECK_RUN_ID = runId;

  try {
    const result = await new Promise<{ output: string; exitCode: number | null }>((resolve, reject) => {
      const child = spawn("bash", [statusline], {
        cwd: root,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let error = "";
      child.stdout.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer | string) => { error += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (exitCode) => {
        if (exitCode !== 0 && error) reject(new Error(error));
        else resolve({ output, exitCode });
      });
      child.stdin.end(JSON.stringify(payload));
    });

    const args = readFileSync(argsPath, "utf8").trim();
    return {
      ...result,
      args: args ? args.split("\n") : [],
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const payload = (cost: number, contextTokens: Record<string, unknown> = {}) => ({
  session_name: "CodeDeck · codedeck · builder",
  model: { display_name: "claude-sonnet-4" },
  workspace: { current_dir: root },
  worktree: { branch: "main" },
  context_window: { remaining_percentage: 68, ...contextTokens },
  cost: { total_cost_usd: cost },
});

describe("Claude statusline", () => {
  it("renders aggregate usage using the exact usage argv", async () => {
    const result = await render({
      payload: payload(0.25, { total_input_tokens: 900_000, total_output_tokens: 100_000 }),
      runId: "run-example",
      usage: {
        runId: "run-example",
        inputTokens: 1200,
        outputTokens: 800,
        cachedTokens: 300,
        costUsd: 0.4,
        sessionCount: 2,
        activeSessionCount: 2,
        costComplete: true,
        sessionsWithoutCost: 0,
      },
    });

    expect(stripAnsi(result.output)).toBe(`builder · ${project}/main · ctx 68% · 2.3k tok · run $0.65`);
    expect(result.args).toEqual(["usage", "run-example", "--json"]);
    expect(result.output).not.toContain("▌RAGE");
    expect(result.output).not.toContain("claude-sonnet-4");
  });

  it("reports the local orchestrator cost without counting its live source twice", async () => {
    const sessionId = "92d88cce-bdbc-46db-8573-916afd32f6f7";
    const otherSourceId = "3f1f93b8-c484-43aa-8a11-32a486109e22";
    const result = await render({
      payload: { ...payload(1), session_id: sessionId },
      sessionId,
      runId: "run-example",
      usage: {
        runId: "run-example",
        inputTokens: 1200,
        outputTokens: 800,
        cachedTokens: 300,
        costUsd: 0.5,
        sessionCount: 2,
        activeSessionCount: 2,
        costComplete: true,
        sessionsWithoutCost: 0,
        orchestrator: {
          costUsd: 3.8,
          costComplete: true,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          sources: [
            { nativeId: otherSourceId, costUsd: 3 },
            { nativeId: sessionId, costUsd: 0.8 },
          ],
        },
        total: { costUsd: 4.3 },
      },
    });

    expect(stripAnsi(result.output)).toContain("run $4.50");
    expect(result.args).toEqual([
      "usage",
      "run-example",
      "--json",
      "--observe",
      `${sessionId}=1`,
    ]);
  });

  it("observes zero cost but skips invalid session ids and negative costs", async () => {
    const sessionId = "92d88cce-bdbc-46db-8573-916afd32f6f7";
    const zero = await render({
      payload: { ...payload(0), session_id: sessionId },
      sessionId,
      runId: "run-example",
    });
    const invalidId = await render({
      payload: { ...payload(1), session_id: "ses_invalid" },
      sessionId: "ses_invalid",
      runId: "run-example",
    });
    const negativeCost = await render({
      payload: { ...payload(-1), session_id: sessionId },
      sessionId,
      runId: "run-example",
    });

    expect(zero.args).toEqual([
      "usage",
      "run-example",
      "--json",
      "--observe",
      `${sessionId}=0`,
    ]);
    expect(invalidId.args).toEqual(["usage", "run-example", "--json"]);
    expect(negativeCost.args).toEqual(["usage", "run-example", "--json"]);
  });

  it("omits a present task name sidecar and starts with the role", async () => {
    const sessionId = "92d88cce-bdbc-46db-8573-916afd32f6f7";
    const result = await render({
      payload: { ...payload(0.25), session_id: sessionId },
      sessionId,
      taskName: "  fix\tapi\nclient   now with more words than allowed  ",
    });

    expect(stripAnsi(result.output)).toBe(`builder · ${project}/main · ctx 68% · $0.25`);
    expect(stripAnsi(result.output)).not.toContain("fix api client");
  });

  it("renders only the branch when it matches the project name", async () => {
    const result = await render({ payload: { ...payload(0.25), worktree: { branch: project } } });

    expect(stripAnsi(result.output)).toBe(`builder · ${project} · ctx 68% · $0.25`);
  });

  it("renders only the branch when it is the project worktree branch", async () => {
    const result = await render({ payload: { ...payload(0.25), worktree: { branch: `worktree-${project}` } } });

    expect(stripAnsi(result.output)).toBe(`builder · worktree-${project} · ctx 68% · $0.25`);
  });

  it("keeps the project and branch when they differ", async () => {
    const result = await render({ payload: { ...payload(0.25), worktree: { branch: "feature/statusline" } } });

    expect(stripAnsi(result.output)).toBe(`builder · ${project}/feature/statusline · ctx 68% · $0.25`);
  });

  it("keeps the local cost when the run id is absent", async () => {
    const result = await render({ payload: payload(0.25) });

    expect(stripAnsi(result.output)).toBe(`builder · ${project}/main · ctx 68% · $0.25`);
    expect(stripAnsi(result.output)).not.toContain(" · run ");
    expect(stripAnsi(result.output)).not.toContain("agents");
  });

  it("renders the current local context token snapshot in degraded mode", async () => {
    const result = await render({
      payload: payload(0.25, { total_input_tokens: 1_200, total_output_tokens: 800 }),
    });

    expect(stripAnsi(result.output)).toBe(`builder · ${project}/main · ctx 68% · 2k tok · $0.25`);
  });

  it("keeps the local token snapshot when the usage CLI fails", async () => {
    const result = await render({
      payload: payload(1, { total_input_tokens: 1_200, total_output_tokens: 800 }),
      runId: "run-unavailable",
      shimExitCode: 1,
    });

    expect(stripAnsi(result.output)).toBe(`builder · ${project}/main · ctx 68% · 2k tok · $1.00`);
    expect(stripAnsi(result.output)).not.toContain(" · run ");
    expect(stripAnsi(result.output)).not.toContain("agents");
  });

  it("formats token totals compactly", async () => {
    const million = await render({
      payload: payload(0),
      runId: "run-million",
      usage: {
        runId: "run-million",
        inputTokens: 1_000_000,
        outputTokens: 234_567,
        cachedTokens: 0,
        costUsd: 0,
        sessionCount: 1,
        activeSessionCount: 1,
        costComplete: true,
        sessionsWithoutCost: 0,
      },
    });
    const thousands = await render({
      payload: payload(0.25, { total_input_tokens: 340_000, total_output_tokens: 0 }),
    });
    const small = await render({
      payload: payload(0.25, { total_input_tokens: 980, total_output_tokens: 0 }),
    });

    expect(stripAnsi(million.output)).toContain("1.2M tok");
    expect(stripAnsi(thousands.output)).toContain("340k tok");
    expect(stripAnsi(small.output)).toContain("980 tok");
  });

  it("marks a partial aggregate even when the local cost is zero", async () => {
    const result = await render({
      payload: payload(0),
      runId: "run-partial",
      usage: {
        runId: "run-partial",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0.42,
        sessionCount: 1,
        activeSessionCount: 0,
        costComplete: false,
        sessionsWithoutCost: 1,
      },
    });

    expect(stripAnsi(result.output)).toContain("0 tok · run $0.42?");
  });

  it("marks the run incomplete when orchestrator cost is incomplete", async () => {
    const result = await render({
      payload: payload(0),
      runId: "run-partial-orchestrator",
      usage: {
        runId: "run-partial-orchestrator",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0.42,
        sessionCount: 0,
        activeSessionCount: 0,
        costComplete: true,
        sessionsWithoutCost: 0,
        orchestrator: {
          costUsd: 0,
          costComplete: false,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          sources: [],
        },
        total: { costUsd: 0.42 },
      },
    });

    expect(stripAnsi(result.output)).toContain("run $0.42?");
  });

  it("keeps the existing run formula when orchestrator data is invalid", async () => {
    const sessionId = "92d88cce-bdbc-46db-8573-916afd32f6f7";
    const result = await render({
      payload: { ...payload(0.25), session_id: sessionId },
      sessionId,
      runId: "run-invalid-orchestrator",
      usage: {
        runId: "run-invalid-orchestrator",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0.4,
        sessionCount: 1,
        activeSessionCount: 0,
        costComplete: true,
        sessionsWithoutCost: 0,
        orchestrator: {
          costUsd: 0.8,
          costComplete: false,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          sources: [{ nativeId: sessionId, costUsd: "invalid" }],
        },
      },
    });

    expect(stripAnsi(result.output)).toContain("run $0.65");
    expect(stripAnsi(result.output)).not.toContain("run $0.65?");
  });

  it("does not render a duplicate run session count", async () => {
    const result = await render({
      payload: payload(0),
      runId: "run-live-agents",
      usage: {
        runId: "run-live-agents",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0.42,
        sessionCount: 4,
        activeSessionCount: 1,
        costComplete: true,
        sessionsWithoutCost: 0,
      },
    });

    expect(stripAnsi(result.output)).toContain("run $0.42");
    expect(stripAnsi(result.output)).not.toContain("agents");
  });
});
