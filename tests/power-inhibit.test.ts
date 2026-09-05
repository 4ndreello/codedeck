import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { processAlive } from "../src/utils/process.js";
import { Database } from "../src/store/database.js";
import { SessionStore } from "../src/store/sessions.js";
import { Daemon } from "../src/daemon/daemon.js";
import { makeTempDir, removeTempDir, seam, seed } from "./helpers/daemon-seam.js";

let dir: string;
let strayPids: number[];

beforeEach(() => {
  dir = makeTempDir("power-inhibit-");
  process.env.RUN_AGENT_DIR = dir;
  strayPids = [];
});

afterEach(() => {
  delete process.env.RUN_AGENT_DIR;
  delete process.env.CODEDECK_INHIBIT_ARGS;
  for (const pid of strayPids) {
    try { if (processAlive(pid)) process.kill(pid, "SIGKILL"); } catch {}
  }
  removeTempDir(dir);
});


function reopenSessions(): SessionStore {
  return new SessionStore(new Database(path.join(dir, "run-agent.db")).getHandle());
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function writeFakeInhibit(scriptPath: string, argsFile: string): void {
  fs.writeFileSync(scriptPath, `#!/bin/sh\necho "$@" > "$CODEDECK_INHIBIT_ARGS"\nexec sleep 30\n`);
  fs.chmodSync(scriptPath, 0o755);
}

describe("power systemd-inhibit child", () => {
  it("spawns with the exact argv and dies after TRUNCATE", async () => {
    const fakeBin = path.join(dir, "fake-inhibit");
    const argsFile = path.join(dir, "inhibit-args.txt");
    process.env.CODEDECK_INHIBIT_ARGS = argsFile;
    writeFakeInhibit(fakeBin, argsFile);

    const daemon = new Daemon();
    seam(daemon).maybeSpawnInhibit(fakeBin);

    expect(await waitFor(() => fs.existsSync(argsFile), 3000)).toBe(true);
    expect(fs.readFileSync(argsFile, "utf8").trim()).toBe(
      "--what=shutdown:sleep --who=CodeDeck --why=flush sessions --mode=delay sleep infinity",
    );
    const childPid = seam(daemon).inhibitChild?.pid;
    expect(childPid).toBeDefined();
    if (childPid !== undefined) {
      expect(processAlive(childPid)).toBe(true);
      strayPids.push(childPid);
    }

    const dbHandle = seam(daemon).db.getHandle();
    let truncateAt = 0;
    const execOrig = dbHandle.exec.bind(dbHandle);
    const execSpy = vi.spyOn(dbHandle, "exec").mockImplementation((sql: string) => {
      if (sql.includes("wal_checkpoint(TRUNCATE)")) truncateAt = Date.now();
      execOrig(sql);
    });
    seed(daemon, "s-inhibit", "working");
    try {
      await seam(daemon).handleShutdown("SIGTERM");
    } finally {
      execSpy.mockRestore();
    }

    expect(seam(daemon).inhibitChild).toBeNull();
    expect(truncateAt).toBeGreaterThan(0);
    let deathAt = 0;
    if (childPid !== undefined) {
      const died = await waitFor(() => !processAlive(childPid), 5000);
      expect(died).toBe(true);
      deathAt = Date.now();
    }
    expect(deathAt).toBeGreaterThanOrEqual(truncateAt);
    expect(reopenSessions().get("s-inhibit")?.status).toBe("interrupted");
  });

  it("is a silent no-op when systemd-inhibit is absent", async () => {
    const missing = path.join(dir, "does-not-exist");

    const daemon = new Daemon();
    seam(daemon).maybeSpawnInhibit(missing);
    expect(seam(daemon).inhibitChild).toBeNull();

    seed(daemon, "s-noinhibit", "working");
    await seam(daemon).handleShutdown("SIGTERM");

    expect(reopenSessions().get("s-noinhibit")?.status).toBe("interrupted");
  });
});
