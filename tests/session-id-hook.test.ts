import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const hook = path.join(root, "plugin", "hooks", "session-id.sh");

async function runHook(input: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; elapsedMs: number }> {
  const startedAt = performance.now();
  const child = spawn("bash", [hook], { cwd: root, env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
    // The hook exits without reading stdin when the session file is unset, so
    // the write can hit a closed pipe; that is expected, not a failure.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });

  if (stderr) throw new Error(stderr);
  return { exitCode, elapsedMs: performance.now() - startedAt };
}

describe("session id hook", () => {
  it("appends each session id and exits quickly without a daemon", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "codedeck-session-id-"));
    const sessionFile = path.join(dir, "session-id");
    const runId = "run-example";
    const env = {
      ...process.env,
      CODEDECK_RUN_ID: runId,
      CODEDECK_SESSION_FILE: sessionFile,
      RUN_AGENT_DIR: dir,
    };
    const ids = [
      "92d88cce-bdbc-46db-8573-916afd32f6f7",
      "3f1f93b8-c484-43aa-8a11-32a486109e22",
    ];

    try {
      expect(readdirSync(dir)).toEqual([]);
      for (const id of ids) {
        const result = await runHook(JSON.stringify({ session_id: id }), env);

        expect(result.exitCode).toBe(0);
        expect(result.elapsedMs).toBeLessThan(500);
      }

      expect(readFileSync(sessionFile, "utf8")).toBe(`${ids.join("\n")}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits successfully without writing when the session file is unset", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "codedeck-session-id-empty-"));
    const env = { ...process.env, CODEDECK_RUN_ID: "run-example", RUN_AGENT_DIR: dir };
    delete env.CODEDECK_SESSION_FILE;

    try {
      const result = await runHook(
        JSON.stringify({ session_id: "92d88cce-bdbc-46db-8573-916afd32f6f7" }),
        env,
      );

      expect(result.exitCode).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
