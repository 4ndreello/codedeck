import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPaths } from "../src/config/paths.js";
import { openSourceKey } from "../src/core/usage-source.js";
import { Database } from "../src/store/database.js";
import { SessionStore } from "../src/store/sessions.js";
import { registerUsageCommand } from "../src/cli/commands/usage.js";

let tempRoot: string;
let tempHome: string;
let originalHome: string | undefined;
let originalRunAgentDir: string | undefined;
let originalExitCode: string | number | undefined;
let logs: string[];

const ids = {
  open: "92d88cce-bdbc-46db-8573-916afd32f6f7",
  sidecar: "3f1f93b8-c484-43aa-8a11-32a486109e22",
  worker: "f46552ad-8900-441a-a62b-c6901010a988",
  name: "866d169a-9c87-4c03-8f1f-2b4d44a31a34",
  marked: "eb8318ac-85b6-4da6-80f4-7092bc9d9160",
  noCostState: "2639586b-9e63-4985-bdb1-0d4439570210",
  missing: "4096e136-4b8b-4d8d-b078-97019b8e0f55",
};

async function runBackfill(args: string[] = ["--json"]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerUsageCommand(program);
  await program.parseAsync(["node", "codedeck", "usage", "--backfill", ...args], { from: "node" });
}

function seedSession(id: string, agent: string, origin: string | null, nativeId: string): void {
  const db = new Database(getPaths().db);
  try {
    db.getHandle().prepare(`
      INSERT INTO sessions (
        id, agent, native_session_id, status, cwd, created_at, updated_at, origin
      ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)
    `).run(id, agent, nativeId, tempRoot, new Date(2026, 8, 7).toISOString(), new Date(2026, 8, 7).toISOString(), origin);
  } finally {
    db.close();
  }
}

function createRepo(name: string): { root: string; cwd: string } {
  const root = path.join(tempRoot, name);
  const cwd = path.join(root, "nested", "project");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}

function writeCostTranscript(
  nativeId: string,
  cwd: string,
  values: { cost?: number; input?: number; output?: number; cacheRead?: number; cacheCreation?: number } = {},
): string {
  const transcriptDir = path.join(tempHome, ".claude", "projects", "fixture-project");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const file = path.join(transcriptDir, `${nativeId}.jsonl`);
  const record = {
    type: "cost-state",
    timestamp: "2026-09-07T14:30:00.000Z",
    cwd,
    totalCostUSD: values.cost ?? 1.25,
    modelUsage: {
      "claude-sonnet-4-6": {
        inputTokens: values.input ?? 120,
        outputTokens: values.output ?? 30,
        cacheReadInputTokens: values.cacheRead ?? 10,
        cacheCreationInputTokens: values.cacheCreation ?? 5,
        costUSD: values.cost ?? 1.25,
      },
    },
  };
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

function writeTokenOnlyTranscript(nativeId: string, cwd: string): void {
  const transcriptDir = path.join(tempHome, ".claude", "projects", "fixture-project");
  fs.mkdirSync(transcriptDir, { recursive: true });
  const record = {
    type: "assistant",
    timestamp: "2026-09-07T14:30:00.000Z",
    cwd,
    requestId: "request-1",
    message: {
      id: "message-1",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1 },
    },
  };
  fs.writeFileSync(path.join(transcriptDir, `${nativeId}.jsonl`), `${JSON.stringify(record)}\n`);
}

function writeSidecar(fileName: string, contents: string): string {
  const sessionsDir = getPaths().sessionsDir;
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const file = path.join(sessionsDir, fileName);
  fs.writeFileSync(file, contents);
  return file;
}

function legacyRows(): Array<Record<string, unknown>> {
  const db = new Database(getPaths().db);
  try {
    return db.getHandle().prepare(`
      SELECT native_id, ended_at, cwd, repository, model, cost,
        input_tokens, output_tokens, cached_tokens
      FROM usage_legacy ORDER BY native_id
    `).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function usageTotals(): unknown {
  const db = new Database(getPaths().db);
  try {
    return new SessionStore(db.getHandle()).queryUsage({ period: "all" }).totals;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalRunAgentDir = process.env.RUN_AGENT_DIR;
  originalExitCode = process.exitCode;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usage-backfill-"));
  tempHome = path.join(tempRoot, "home");
  fs.mkdirSync(tempHome, { recursive: true });
  process.env.HOME = tempHome;
  process.env.RUN_AGENT_DIR = path.join(tempRoot, "run-agent");
  process.exitCode = undefined;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalRunAgentDir;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("usage historical backfill", () => {
  it("imports open rows and every sidecar line, skips worker ids, and stays idempotent", async () => {
    seedSession("open-row", "claude", "open", ids.open);
    seedSession("worker-row", "codex", null, ids.worker);
    const regularSidecar = writeSidecar("codedeck-session-4100", `${ids.sidecar}\n${ids.worker}\n`);
    const nameSidecar = writeSidecar(`codedeck-session-4100.${ids.open}.name`, "reviewer");
    const repo = createRepo("main-repo");
    writeCostTranscript(ids.open, repo.cwd, { cost: 1.25 });
    writeCostTranscript(ids.sidecar, repo.cwd, { cost: 0.75, input: 60, output: 20, cacheRead: 5, cacheCreation: 2 });
    writeCostTranscript(ids.worker, repo.cwd, { cost: 50 });

    await runBackfill();

    expect(JSON.parse(logs[0]!)).toEqual({ imported: 2, skipped: 1 });
    expect(legacyRows().map((row) => row.native_id).sort()).toEqual([ids.open, ids.sidecar].sort());
    const db = new Database(getPaths().db);
    let totalsAfterFirstRun: unknown;
    try {
      const mark = db.getHandle().prepare(`
        SELECT cost, input_tokens, output_tokens, cached_tokens
        FROM usage_sources WHERE source_key = ?
      `).get(openSourceKey(ids.open));
      expect(mark).toEqual({ cost: 1.25, input_tokens: 120, output_tokens: 30, cached_tokens: 15 });
      expect(new SessionStore(db.getHandle()).list(50, true).map((session) => session.id).sort())
        .toEqual(["open-row", "worker-row"]);
      totalsAfterFirstRun = new SessionStore(db.getHandle()).queryUsage({ period: "all" }).totals;
    } finally {
      db.close();
    }
    expect(fs.readFileSync(regularSidecar, "utf8")).toBe(`${ids.sidecar}\n${ids.worker}\n`);
    expect(fs.readFileSync(nameSidecar, "utf8")).toBe("reviewer");

    logs = [];
    await runBackfill();

    expect(JSON.parse(logs[0]!)).toEqual({ imported: 0, skipped: 3 });
    expect(usageTotals()).toEqual(totalsAfterFirstRun);
  });

  it("collects an id from a name sidecar and stores the transcript git root", async () => {
    const repo = createRepo("name-repo");
    const sidecar = writeSidecar(`codedeck-session-4101.${ids.name}.name`, "reviewer");
    writeCostTranscript(ids.name, repo.cwd, { cost: 0.9 });

    await runBackfill();

    expect(JSON.parse(logs[0]!)).toEqual({ imported: 1, skipped: 0 });
    expect(legacyRows()).toEqual([
      expect.objectContaining({
        native_id: ids.name,
        ended_at: "2026-09-07T14:30:00.000Z",
        cwd: repo.cwd,
        repository: repo.root,
        model: "claude-sonnet-4-6",
        cost: 0.9,
        input_tokens: 120,
        output_tokens: 30,
        cached_tokens: 15,
      }),
    ]);
    expect(fs.readFileSync(sidecar, "utf8")).toBe("reviewer");
  });

  it("skips existing marks, missing transcripts, and transcripts without cost-state", async () => {
    const repo = createRepo("partial-repo");
    const sidecar = writeSidecar(
      "codedeck-session-4102",
      `${ids.marked}\n${ids.noCostState}\n${ids.missing}\n`,
    );
    writeCostTranscript(ids.marked, repo.cwd);
    writeTokenOnlyTranscript(ids.noCostState, repo.cwd);
    const db = new Database(getPaths().db);
    try {
      db.getHandle().prepare(`
        INSERT INTO usage_sources (
          source_key, cost, input_tokens, output_tokens, cached_tokens, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(openSourceKey(ids.marked), 2, 20, 4, 1, new Date().toISOString());
    } finally {
      db.close();
    }

    await runBackfill();

    expect(JSON.parse(logs[0]!)).toEqual({ imported: 0, skipped: 3 });
    expect(legacyRows()).toEqual([]);
    expect(fs.readFileSync(sidecar, "utf8")).toBe(`${ids.marked}\n${ids.noCostState}\n${ids.missing}\n`);
  });

  it("prints a one-line text summary without --json", async () => {
    const repo = createRepo("text-repo");
    writeSidecar("codedeck-session-4103", `${ids.sidecar}\n`);
    writeCostTranscript(ids.sidecar, repo.cwd);

    await runBackfill([]);

    expect(logs).toEqual(["Usage backfill: imported 1, skipped 0"]);
    expect(logs[0]).not.toContain("\n");
  });
});
