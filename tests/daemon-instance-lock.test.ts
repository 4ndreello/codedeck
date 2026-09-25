import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, type InstanceLock } from "../src/daemon/instance-lock.js";

const lockModule = fileURLToPath(new URL("../src/daemon/instance-lock.ts", import.meta.url));

// Holds the lock from a separate OS process, the way a second `daemon.js`
// would, and reports once it has it.
function holdInOtherProcess(lockPath: string): Promise<ChildProcess> {
  const script = `
    import { acquireInstanceLock } from ${JSON.stringify(lockModule)};
    const lock = acquireInstanceLock(${JSON.stringify(lockPath)});
    process.stdout.write(lock ? "held\\n" : "refused\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.stdout!.once("data", (chunk: Buffer) => {
      if (chunk.toString().trim() === "held") resolve(child);
      else reject(new Error(`child did not get the lock: ${chunk}`));
    });
    child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

describe("daemon instance lock", () => {
  let tempDir: string;
  let lockPath: string;
  const held: InstanceLock[] = [];
  const children: ChildProcess[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-agent-instance-lock-"));
    lockPath = path.join(tempDir, "daemon.lock");
  });

  afterEach(async () => {
    for (const lock of held.splice(0)) lock.release();
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
      await exited(child);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("grants the lock to the first daemon", () => {
    const lock = acquireInstanceLock(lockPath);
    expect(lock).not.toBeNull();
    held.push(lock!);
  });

  it("refuses a second holder in the same process", () => {
    held.push(acquireInstanceLock(lockPath)!);
    expect(acquireInstanceLock(lockPath)).toBeNull();
  });

  it("refuses while another process holds it", async () => {
    children.push(await holdInOtherProcess(lockPath));
    expect(acquireInstanceLock(lockPath)).toBeNull();
  });

  it("frees the lock when the holder is SIGKILLed, with no stale file to clean", async () => {
    const child = await holdInOtherProcess(lockPath);
    child.kill("SIGKILL");
    await exited(child);
    const lock = acquireInstanceLock(lockPath);
    expect(lock).not.toBeNull();
    held.push(lock!);
  });

  it("is free again after release", () => {
    acquireInstanceLock(lockPath)!.release();
    const lock = acquireInstanceLock(lockPath);
    expect(lock).not.toBeNull();
    held.push(lock!);
  });
});
