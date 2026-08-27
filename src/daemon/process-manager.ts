import type { ChildProcess } from "node:child_process";

export interface ManagedProcess {
  sessionId: string;
  pid?: number;
  proc: ChildProcess;
  startedAt: Date;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();

  register(sessionId: string, proc: ChildProcess): void {
    this.processes.set(sessionId, { sessionId, pid: proc.pid, proc, startedAt: new Date() });
    proc.on("close", () => {
      // Keep entry for a bit for status, but mark as done
      // Don't delete immediately so daemon can know exit code
    });
  }

  get(sessionId: string): ManagedProcess | undefined {
    return this.processes.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  async stop(sessionId: string, gracefulMs = 3000): Promise<boolean> {
    const mp = this.processes.get(sessionId);
    if (!mp) return false;
    const proc = mp.proc;
    if (proc.killed || proc.exitCode !== null) return true;
    try {
      proc.kill("SIGTERM");
    } catch {}
    const start = Date.now();
    while (Date.now() - start < gracefulMs) {
      if (proc.exitCode !== null || proc.killed) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    return true;
  }

  unregister(sessionId: string): void {
    this.processes.delete(sessionId);
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  isAlive(sessionId: string): boolean {
    const mp = this.processes.get(sessionId);
    if (!mp) return false;
    const proc = mp.proc;
    return proc.exitCode === null && !proc.killed;
  }
}
