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
}

async function render({ payload, runId, usage, shimExitCode = 0 }: RenderOptions): Promise<{
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
  it("renders the aggregate total and worker count using the exact usage argv", async () => {
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
        costComplete: true,
        sessionsWithoutCost: 0,
      },
    });

    expect(stripAnsi(result.output)).toBe(`builder · ${project}/main · ctx 68% · 2.3k tok · run $0.65 · 2 agents`);
    expect(result.args).toEqual(["usage", "run-example", "--json"]);
    expect(result.output).not.toContain("▌RAGE");
    expect(result.output).not.toContain("claude-sonnet-4");
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
      payload: payload(0.25, { total_input_tokens: 1_200, total_output_tokens: 800 }),
      runId: "run-unavailable",
      shimExitCode: 1,
    });

    expect(stripAnsi(result.output)).toBe(`builder · ${project}/main · ctx 68% · 2k tok · $0.25`);
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
        costComplete: false,
        sessionsWithoutCost: 1,
      },
    });

    expect(stripAnsi(result.output)).toContain("0 tok · run $0.42?");
  });
});
