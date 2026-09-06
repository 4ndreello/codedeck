import { describe, expect, it, vi } from "vitest";
import { formatPsJson, psEmptyMessage, renderPsTable, resolvePsWidth } from "../src/cli/commands/ps.js";
import { visibleWidth } from "../src/cli/ui.js";

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

    expect(row).toContain("message: xxxxx…");
    expect(row).not.toContain(lastEvent);
  });

  it("keeps multiline LAST EVENT on one table row", () => {
    const output = renderPsTable([
      session({ lastEvent: "tool: Bash\nnext line\r\nthird" }),
    ]);

    expect(output.split("\n")).toHaveLength(3);
    expect(output).toContain("tool: Bash nex…");
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

  it.each([null, undefined])("does not probe liveness when pid is %s", (pid) => {
    const kill = vi.spyOn(process, "kill");

    try {
      const output = renderPsTable([session({ pid })]);
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

describe("ps output contract", () => {
  it("suggests --all only in the default view", () => {
    expect(psEmptyMessage(false)).toBe("No sessions in the last 24h (use --all for full history)");
    expect(psEmptyMessage(true)).toBe("No sessions");
  });

  it("keeps --json a bare sessions array", () => {
    const parsed: unknown = JSON.parse(formatPsJson([session()]));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });
});

describe("ps responsive table", () => {
  function wideSession(overrides: Record<string, unknown> = {}) {
    return session({
      id: "add0pen",
      name: "tighten-shim-per-extra-long",
      agent: "codex",
      model: "gpt-5.6-luna",
      status: "completed",
      lastEvent: "You've hit your usage limit, please try again later",
      cwd: "/home/dev/codedeck.worktrees/spike-ooooo",
      ...overrides,
    });
  }

  it.each([20, 40, 60, 80, 100, 120])("keeps every line within %i columns", (width) => {
    const rows = [
      wideSession(),
      wideSession({ name: "xpto-xyv-long-name", model: "claude-sonnet-4-5", lastEvent: "Claude exited with code 1" }),
    ];
    for (const line of renderPsTable(rows, width).split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("drops CWD and LAST EVENT at 80 columns but keeps the core", () => {
    const output = renderPsTable([wideSession()], 80);

    expect(output).not.toContain("CWD");
    expect(output).not.toContain("LAST EVENT");
    expect(output).toContain("NAME");
    expect(output).toContain("STATUS");
    expect(output).toContain("tighten-shim-pe…");
  });

  it("truncates a long NAME with an ellipsis", () => {
    const row = renderPsTable([wideSession()], 200).split("\n")[2];

    expect(row).toContain("tighten-shim-pe…");
    expect(row).not.toContain("tighten-shim-per-extra-long");
  });

  it("keeps the tail of a truncated CWD", () => {
    const row = renderPsTable([wideSession()], 120).split("\n")[2];

    expect(row).toContain("…");
    expect(row).toContain("spike-ooooo");
  });

  it("reads the width from the terminal when TTY", () => {
    const stdout = process.stdout as { columns?: number; isTTY?: boolean };
    const prevColumns = stdout.columns;
    const prevIsTTY = stdout.isTTY;
    stdout.columns = 80;
    stdout.isTTY = true;
    try {
      expect(resolvePsWidth()).toBe(80);
      expect(renderPsTable([wideSession()])).toBe(renderPsTable([wideSession()], 80));
    } finally {
      stdout.columns = prevColumns;
      stdout.isTTY = prevIsTTY;
    }
  });

  it("keeps the full table when not a TTY", () => {
    expect(resolvePsWidth()).toBe(Number.POSITIVE_INFINITY);
  });
});
