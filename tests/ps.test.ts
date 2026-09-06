import { describe, expect, it, vi } from "vitest";
import {
  fitPsRowCount,
  formatPsJson,
  formatPsOverflowNote,
  parsePsLimit,
  planPsLayout,
  psEmptyMessage,
  psMoreCount,
  renderPsTable,
  resolvePsWidth,
} from "../src/cli/commands/ps.js";
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

function sessions(...ids: string[]) {
  return ids.map((id) => session({ id }));
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

describe("ps fit-to-screen layout", () => {
  it("subtracts the reserved lines from a TTY height", () => {
    expect(fitPsRowCount(24)).toBe(20);
  });

  it("keeps the newest displayed session as the last TTY row", () => {
    const layout = planPsLayout(sessions("newest", "middle", "oldest"), {
      isTTY: true,
      rows: 24,
    });

    expect(layout.sessions.map((item) => item.id)).toEqual(["oldest", "middle", "newest"]);
  });

  it("keeps non-TTY rows newest-first without height truncation", () => {
    const layout = planPsLayout(sessions("newest", "middle", "oldest"), {
      isTTY: false,
      rows: 4,
    });

    expect(layout.sessions.map((item) => item.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("reverses --all on a TTY without an overflow note or height limit", () => {
    const layout = planPsLayout(sessions("newest", "middle", "oldest"), {
      all: true,
      isTTY: true,
      rows: 4,
      hiddenOlderCount: 12,
    });

    expect(layout.sessions.map((item) => item.id)).toEqual(["oldest", "middle", "newest"]);
    expect(layout.moreCount).toBe(12);
    expect(layout.showOverflowNote).toBe(false);
  });

  it("lets --limit override the TTY height limit", () => {
    const layout = planPsLayout(sessions("newest", "middle", "oldest", "older"), {
      isTTY: true,
      rows: 6,
      limit: 3,
    });

    expect(layout.sessions.map((item) => item.id)).toEqual(["oldest", "middle", "newest"]);
    expect(layout.displayedCount).toBe(3);
  });

  it("counts rows hidden by the display limit and the daemon window", () => {
    expect(psMoreCount(100, 8, 42)).toBe(134);

    const layout = planPsLayout(sessions("newest", "middle", "oldest"), {
      isTTY: true,
      rows: 6,
      limit: 2,
      hiddenOlderCount: 4,
    });

    expect(layout.moreCount).toBe(5);
    expect(layout.showOverflowNote).toBe(true);
    expect(formatPsOverflowNote(layout.moreCount, "codedeck")).toBe(
      "+5 older hidden — codedeck ps --all",
    );
  });

  it("keeps one row when the terminal is smaller than the reserved space", () => {
    expect(fitPsRowCount(3)).toBe(1);

    const layout = planPsLayout(sessions("newest", "oldest"), {
      isTTY: true,
      rows: 3,
    });

    expect(layout.sessions).toHaveLength(1);
    expect(layout.sessions[0].id).toBe("newest");
  });

  it.each([undefined, 0])("does not height-truncate when rows is %s", (rows) => {
    expect(fitPsRowCount(rows)).toBeUndefined();

    const layout = planPsLayout(sessions("newest", "oldest"), {
      isTTY: true,
      rows,
    });

    expect(layout.sessions.map((item) => item.id)).toEqual(["oldest", "newest"]);
  });

  it("accepts only positive integer limits", () => {
    expect(parsePsLimit("3")).toBe(3);
    for (const value of ["0", "-1", "1.5", "nope"]) {
      expect(() => parsePsLimit(value)).toThrow("--limit must be a positive integer");
    }
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
