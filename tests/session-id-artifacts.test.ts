import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateBranchName } from "../src/core/session.js";
import { SessionRuntime, sessionLogPaths, type RuntimeHooks } from "../src/drivers/session-runtime.js";
import { createWorktree, removeWorktree } from "../src/git/worktree.js";

const SESSION_ID = "abcd1234567890ef";
const originalCodedeckDir = process.env.CODEDECK_DIR;
let codedeckDir: string | undefined;
let worktree: string | undefined;
let repository: string | undefined;

afterEach(async () => {
  if (worktree && repository) await removeWorktree(worktree, repository);
  if (codedeckDir) fs.rmSync(codedeckDir, { recursive: true, force: true });
  if (originalCodedeckDir === undefined) delete process.env.CODEDECK_DIR;
  else process.env.CODEDECK_DIR = originalCodedeckDir;
  codedeckDir = undefined;
  worktree = undefined;
  repository = undefined;
});

describe("full session ID artifacts", () => {
  it("keeps the full ID in branch names, worktree paths, logs, and harness env", async () => {
    codedeckDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-artifacts-"));
    process.env.CODEDECK_DIR = codedeckDir;
    repository = path.join(codedeckDir, "repo");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "-q"], { cwd: repository });
    execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "init"], { cwd: repository });

    expect(generateBranchName("task", SESSION_ID)).toBe(`ra/task-${SESSION_ID}`);
    const created = await createWorktree({ repoRoot: repository, sessionId: SESSION_ID, prompt: "task" });
    worktree = created.path;
    expect(created.branch).toBe(`ra/task-${SESSION_ID}`);
    expect(path.basename(created.path)).toBe(SESSION_ID);

    const paths = sessionLogPaths(SESSION_ID);
    expect(path.basename(paths.stdoutPath)).toBe(`${SESSION_ID}.ndjson`);
    expect(path.basename(paths.stderrPath)).toBe(`${SESSION_ID}.stderr.log`);
    expect(path.basename(paths.metadataPath)).toBe(`${SESSION_ID}.process.json`);

    const hooks: RuntimeHooks = {
      onLine: (line, { setNativeId }) => {
        const payload = JSON.parse(line) as { sessionId?: string };
        if (payload.sessionId) setNativeId(payload.sessionId);
      },
      synthesizeTerminal: () => [],
    };
    const runtime = SessionRuntime.spawn({
      sessionId: SESSION_ID,
      cmd: process.execPath,
      args: ["-e", 'process.stdout.write(JSON.stringify({ sessionId: process.env.CODEDECK_SESSION_ID }) + "\\n");'],
      cwd: repository,
      hooks,
    });
    for await (const _event of runtime.events()) {}

    expect(runtime.nativeSessionId).toBe(SESSION_ID);
    expect(fs.existsSync(paths.stdoutPath)).toBe(true);
  }, 15000);
});
