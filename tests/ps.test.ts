import { describe, expect, it, vi } from "vitest";
import { renderPsTable } from "../src/cli/commands/ps.js";

function findMissingPid(): number {
  for (let pid = process.pid + 1; pid < process.pid + 10_000; pid++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("Could not find an unused PID for the test");
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "55a2",
    name: "plano2-task3-4",
    agent: "omp",
    status: "working",
    cwd: "/tmp/codedeck",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    updatedAt: new Date(),
    pid: process.pid,
    lastEvent: "tool: Bash",
    ...overrides,
  };
}

describe("ps table liveness", () => {
  it("shows dead and uses updatedAt for an inactive process", () => {
    const output = renderPsTable([
      session({
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 49 * 60 * 1000),
        pid: findMissingPid(),
      }),
    ]);

    expect(output).toContain("dead");
    expect(output).not.toContain("working");
    expect(output).toContain("49m");
    expect(output).toContain("tool: Bash");
    expect(output).toContain("LAST EVENT");
  });

  it("truncates a long LAST EVENT to the table column width", () => {
    const lastEvent = "message: " + "x".repeat(40);
    const row = renderPsTable([session({ lastEvent })]).split("\n")[2];

    expect(row).toContain("message: xxxxxx");
    expect(row).not.toContain(lastEvent);
  });

  it("keeps multiline LAST EVENT on one table row", () => {
    const output = renderPsTable([
      session({ lastEvent: "tool: Bash\nnext line\r\nthird" }),
    ]);

    expect(output.split("\n")).toHaveLength(3);
    expect(output).toContain("tool: Bash next");
  });

  it("marks every active status dead when its process is gone", () => {
    const pid = findMissingPid();
    const output = renderPsTable(
      (["starting", "working", "needs_input", "idle"] as const).map((status, index) =>
        session({ id: `a${index}0`, status, pid }),
      ),
    );

    expect(output.split("\n").slice(2).every((row) => row.includes("dead"))).toBe(true);
  });

  it("does not probe liveness when pid is null", () => {
    const kill = vi.spyOn(process, "kill");

    try {
      const output = renderPsTable([session({ pid: null })]);
      expect(output).toContain("working");
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("keeps working for the current process and reports a fresh LAST", () => {
    const output = renderPsTable([session({ updatedAt: new Date(), pid: process.pid })]);

    expect(output).toContain("working");
    expect(output).toContain("now");
  });

  it("keeps completed when its recorded pid no longer exists", () => {
    const output = renderPsTable([
      session({ status: "completed", pid: findMissingPid() }),
    ]);

    expect(output).toContain("completed");
    expect(output).not.toContain("dead");
  });

  it("treats EPERM as a living process", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      const output = renderPsTable([session({ pid: 12345 })]);
      expect(output).toContain("working");
      expect(output).not.toContain("dead");
    } finally {
      kill.mockRestore();
    }
  });
});
