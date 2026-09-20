import { describe, expect, it } from "vitest";

import {
  MAX_CARD_COLUMNS,
  MIN_COLUMNS,
  formatPane,
  paneButtonLabel,
  selectPane,
} from "../../plugin/mods/agents/pane.js";
import type { PaneRow, PaneSnapshot, SessionRow } from "../../plugin/mods/agents/types.js";

const RUN = "f5fd";

const session = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "seed",
  runId: RUN,
  origin: "run",
  status: "completed",
  agent: "opencode",
  name: "task",
  updatedAt: "2026-09-19T12:00:00.000Z",
  ...overrides,
});

// A ready-made snapshot for the drawing rules, independent of selectPane.
const snapshot = (overrides: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  runId: RUN,
  orchestrator: { agent: "claude" },
  rows: [
    { id: "a1", status: "working", agent: "opencode", name: "alpha" },
    { id: "b2", status: "completed", agent: "claude", name: "beta" },
  ],
  hidden: 0,
  total: 3,
  ...overrides,
});

const ids = (snap: PaneSnapshot) => snap.rows.map((row) => row.id);

// The stem connector line at 89 columns: the card box caps at 56, so the
// stem sits at column 31 inside a frame row padded to the full width. Exact
// literal, so a stray or duplicated stem is caught by string identity.
const STEM89 = "│" + " ".repeat(30) + "│" + " ".repeat(56) + "│";

// Assert every line is exactly `columns` code units (the frozen contract is
// code units, matching fit()'s .length and the mock) and carries no newline,
// carriage return or tab. Reused by the width and hygiene rules.
function expectCleanWidth(lines: string[], columns: number): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line.length).toBe(columns);
    expect(line).not.toMatch(/[\n\r\t]/);
  }
}

// The real-screen fixture from the bug report: a run of 19 workers, one
// working and 18 finished, in a pane 89 columns wide and 44 rows tall. Built
// through selectPane so the snapshot is what the daemon pipeline produces.
function workerFixture(): PaneSnapshot {
  const base = Date.parse("2026-09-19T12:00:00.000Z");
  const finished = Array.from({ length: 18 }, (_, i) =>
    session({
      id: `a${String(i + 1).padStart(2, "0")}`,
      name: `task-${String(i + 1).padStart(2, "0")}`,
      updatedAt: new Date(base - i * 60000).toISOString(),
    }),
  );
  return selectPane(
    [session({ id: "w1", status: "working", name: "live", updatedAt: new Date(base + 30 * 60000).toISOString() }), ...finished],
    RUN,
  );
}

describe("selectPane", () => {
  it("keeps only the rows whose runId matches (rule 1)", () => {
    const snap = selectPane(
      [session({ id: "mine" }), session({ id: "theirs", runId: "other" }), session({ id: "bare", runId: undefined })],
      RUN,
    );
    expect(ids(snap)).toEqual(["mine"]);
  });

  it("lifts the origin open row as the orchestrator, never a card (rule 2)", () => {
    const snap = selectPane(
      [session({ id: "boss", origin: "open", agent: "claude" }), session({ id: "kid", origin: "run" })],
      RUN,
    );
    expect(snap.orchestrator).toEqual({ agent: "claude" });
    expect(ids(snap)).toEqual(["kid"]);
  });

  it("orders workers by updatedAt descending, unparseable last, ties by id (rule 3)", () => {
    const snap = selectPane(
      [
        session({ id: "z-old", updatedAt: "2026-09-19T10:00:00.000Z" }),
        session({ id: "new", updatedAt: "2026-09-19T14:00:00.000Z" }),
        session({ id: "alpha", updatedAt: "2026-09-19T12:00:00.000Z" }),
        session({ id: "zeta", updatedAt: "2026-09-19T12:00:00.000Z" }),
        session({ id: "no-date", updatedAt: undefined }),
        session({ id: "garbage", updatedAt: "yesterday-ish" }),
      ],
      RUN,
    );
    expect(ids(snap)).toEqual(["new", "alpha", "zeta", "z-old", "garbage", "no-date"]);
  });

  it("gives a total order, so input order does not change the pane (rule 3)", () => {
    const tied = [
      session({ id: "b", updatedAt: "2026-09-19T12:00:00.000Z" }),
      session({ id: "a", updatedAt: "2026-09-19T12:00:00.000Z" }),
      session({ id: "c", updatedAt: "2026-09-19T12:00:00.000Z" }),
    ];
    expect(ids(selectPane(tied, RUN))).toEqual(["a", "b", "c"]);
    expect(ids(selectPane([...tied].reverse(), RUN))).toEqual(["a", "b", "c"]);
  });

  it("cuts to an explicit budget and counts the rest as hidden", () => {
    const workers = Array.from({ length: 4 }, (_, i) =>
      session({ id: `s${i}`, updatedAt: `2026-09-19T10:0${i}:00.000Z` }),
    );
    const snap = selectPane([session({ id: "boss", origin: "open" }), ...workers], RUN, 2);
    expect(ids(snap)).toEqual(["s3", "s2"]);
    expect(snap.hidden).toBe(2);
    expect(snap.total).toBe(5);
  });

  it("keeps every matched row and reports no hidden when the budget is omitted", () => {
    const workers = Array.from({ length: 19 }, (_, i) =>
      session({ id: `s${String(i).padStart(2, "0")}`, updatedAt: `2026-09-19T10:${String(i).padStart(2, "0")}:00.000Z` }),
    );
    const snap = selectPane(workers, RUN);
    expect(snap.rows).toHaveLength(19);
    expect(snap.hidden).toBe(0);
    expect(snap.total).toBe(19);
  });

  it("treats a non-finite budget as no budget, and zero as cut everything", () => {
    const workers = [session({ id: "s1" }), session({ id: "s2", updatedAt: "2026-09-19T10:00:00.000Z" })];
    expect(selectPane(workers, RUN, Number.NaN).rows).toHaveLength(2);
    expect(selectPane(workers, RUN, Number.POSITIVE_INFINITY).hidden).toBe(0);
    const none = selectPane(workers, RUN, 0);
    expect(none.rows).toHaveLength(0);
    expect(none.hidden).toBe(2);
  });

  it("resolves a missing agent, name or status to a placeholder (rule 13)", () => {
    const snap = selectPane(
      [session({ id: "bare", status: undefined, agent: "", name: undefined })],
      RUN,
    );
    expect(snap.rows[0]).toMatchObject({ status: "-", agent: "-" });
    expect(snap.rows[0].name).toBe("-");
  });

  it("never throws on a degenerate row list (rule 14)", () => {
    expect(selectPane(null as unknown as SessionRow[], RUN)).toMatchObject({ rows: [], hidden: 0, total: 0 });
    expect(selectPane([null, undefined] as unknown as SessionRow[], RUN).rows).toEqual([]);
  });
});

describe("formatPane", () => {
  it("never exceeds the given rows, at every width and every input (rule 1)", () => {
    const snaps = [snapshot(), workerFixture(), snapshot({ rows: [], hidden: 7, total: 7 })];
    for (const snap of snaps) {
      for (const columns of [MIN_COLUMNS, 40, 89, 120]) {
        for (const rows of [0, 9, 10, 11, 12, 15, 20, 44, 45, 200]) {
          const lines = formatPane(snap, columns, rows);
          expect(lines.length).toBeLessThanOrEqual(rows);
          for (const line of lines) expect(line.length).toBe(columns);
        }
      }
    }
  });

  it("keeps a compact history preview when rows is not a usable number (rule 2)", () => {
    const snap = workerFixture();
    const wide = formatPane(snap, 89);
    // 10 frame + the live card + its stem + the five-line history section
    // and its stem. The 18 finished workers no longer get one line each.
    expect(wide).toHaveLength(21);
    expect(wide.some((l) => l.includes("hidden agents"))).toBe(false);
    expect(wide.join("\n")).toContain("HISTORY · 18 finished");
    expect(wide.join("\n")).toContain("a01");
    expect(wide.join("\n")).toContain("+15 earlier");
    expect(wide.join("\n")).not.toContain("a18");
    expect(formatPane(snap, 89, undefined)).toEqual(wide);
    expect(formatPane(snap, 89, Number.NaN)).toEqual(wide);
    expect(formatPane(snap, 89, Number.POSITIVE_INFINITY)).toEqual(wide);
    expect(formatPane(snap, 89, "44" as unknown as number)).toEqual(wide);
    // A shorter pane keeps the live card and drops the history first.
    const short = formatPane(snap, 89, 20);
    expect(short.length).toBeLessThanOrEqual(20);
    expect(short.join("\n")).toContain("w1");
    expect(short.join("\n")).not.toContain("a01");
  });

  it("survives as a frame at every height that draws anything (rule 3)", () => {
    const snap = workerFixture();
    for (const rows of [10, 11, 12, 15, 20, 30, 44, 50, 400]) {
      const lines = formatPane(snap, 89, rows);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^┌─ Run canvas/);
      expect(lines[1]).toContain("sessions");
      expect(lines[2]).toContain("finished");
      expect(lines[3]).toMatch(/^├─/);
      expect(lines[lines.length - 1]).toMatch(/^└─/);
      expect(lines[lines.length - 3]).toContain("● working");
      expect(lines[lines.length - 2]).toContain("▲ Claude");
      expect(lines[lines.length - 4]).toMatch(/^├─/);
    }
  });

  it("draws live rows as cards and groups finished rows in history (rule 4)", () => {
    const rows: PaneRow[] = [
      { id: "k1", status: "working", agent: "opencode", name: "k-live" },
      { id: "k2", status: "needs_input", agent: "claude", name: "k-wait" },
      { id: "k3", status: "starting", agent: "codex", name: "k-boot" },
      { id: "k4", status: "completed", agent: "claude", name: "k-done" },
      { id: "k5", status: "stopped", agent: "omp", name: "k-stop" },
      { id: "k6", status: "weird", agent: "opencode", name: "k-odd" },
    ];
    const joined = formatPane(snapshot({ rows, hidden: 0, total: 7 }), 89).join("\n");
    expect(joined).toContain("Working now");
    expect(joined).toContain("Waiting for you");
    expect(joined).toContain("Starting");
    expect(joined).not.toContain("Completed");
    expect(joined).not.toContain("Paused");
    expect(joined).toContain("HISTORY · 3 finished");
    expect(joined).toContain("▲ k4  k-done");
    expect(joined).toContain("⬟ k5  k-stop");
    expect(joined).toContain("■ k6  k-odd");
  });

  it("drops history before live cards when the pane is short (rule 5)", () => {
    const rows: PaneRow[] = [
      { id: "wNew", status: "working", agent: "claude", name: "wn", updatedAt: "2026-09-19T12:00:00.000Z" },
      { id: "cNew", status: "completed", agent: "claude", name: "cn", updatedAt: "2026-09-19T11:00:00.000Z" },
      { id: "wOld", status: "working", agent: "claude", name: "wo", updatedAt: "2026-09-19T09:00:00.000Z" },
      { id: "cOld", status: "completed", agent: "claude", name: "co", updatedAt: "2026-09-19T08:00:00.000Z" },
    ];
    const snap = snapshot({ rows, orchestrator: undefined, hidden: 0, total: 4 });
    // The history section leaves as a unit, so both live cards remain visible.
    const at24 = formatPane(snap, 40, 24);
    expect(at24).toHaveLength(23);
    expect(at24.join("\n")).toContain("wNew");
    expect(at24.join("\n")).toContain("wOld");
    expect(at24.join("\n")).not.toContain("cOld");
    expect(at24.join("\n")).not.toContain("cNew");
    expect(at24.join("\n")).toContain("+2 hidden agents");

    // At 21 the live cards still win, and the hidden line gives way if needed.
    const at21 = formatPane(snap, 40, 21);
    expect(at21).toHaveLength(21);
    expect(at21.join("\n")).toContain("wNew");
    expect(at21.join("\n")).toContain("wOld");
    expect(at21.join("\n")).not.toContain("hidden agents");
  });

  it("keeps history counts in the summary and reports dropped blocks when useful (rule 6)", () => {
    const snap = snapshot({ hidden: 2, total: 6 });
    const unbounded = formatPane(snap, 40);
    const hiddenLine = unbounded.filter((l) => l.includes("hidden agents"));
    expect(hiddenLine).toHaveLength(0);
    expect(unbounded.join("\n")).toContain("HISTORY · 3 finished");
    expect(unbounded.join("\n")).toContain("+2 earlier");

    // The history block represents all 18 finished workers, while the live
    // card stays visible in a 20-row pane.
    const fitted = formatPane(workerFixture(), 89, 20);
    expect(fitted.filter((l) => l.includes("hidden agents"))).toHaveLength(1);
    expect(fitted.join("\n")).toContain("+18 hidden agents");
    expect(fitted.join("\n")).toContain("w1");
    expect(fitted.join("\n")).not.toContain("a01");

    // At 12 rows even the live card must leave, so the frame and hidden count
    // survive without overflowing the pane.
    const tight = formatPane(workerFixture(), 89, 12);
    expect(tight.join("\n")).toContain("+19 hidden agents");
    expect(tight.join("\n")).not.toContain("w1");
  });

  it("returns nothing when the height cannot hold the frame alone (rule 7)", () => {
    const snap = workerFixture();
    expect(formatPane(snap, 89, 9)).toEqual([]);
    expect(formatPane(snap, 89, 0)).toEqual([]);
    expect(formatPane(snap, 89, -5)).toEqual([]);
    expect(formatPane(snap, 89, 10)).toHaveLength(10);
  });

  it("caps cards at MAX_CARD_COLUMNS while the frame spans the pane (rule 8)", () => {
    expect(MAX_CARD_COLUMNS).toBe(56);
    const lines = formatPane(workerFixture(), 100);
    expectCleanWidth(lines, 100);
    const cardTops = lines.filter((l) => l.startsWith("│  ┌─"));
    expect(cardTops.length).toBeGreaterThan(0);
    for (const top of cardTops) {
      const open = top.indexOf("┌", 2);
      const close = top.indexOf("┐");
      expect(close - open - 1).toBeLessThanOrEqual(MAX_CARD_COLUMNS - 2);
      expect(close - open - 1).toBe(54);
    }
    expect(lines[0]).toMatch(/^┌─ Run canvas .*─┐$/);
    expect(lines[0]).toHaveLength(100);
  });

  it("returns lines all exactly the requested width across three widths (rule 9)", () => {
    const snap = snapshot();
    for (const columns of [MIN_COLUMNS, 40, 60]) {
      expectCleanWidth(formatPane(snap, columns), columns);
      expectCleanWidth(formatPane(snap, columns, 100), columns);
    }
  });

  it("keeps exact code-unit width when astral content is clipped (rule 9)", () => {
    const snap = snapshot({
      rows: [{ id: "🚀🚀🚀", status: "completed", agent: "claude", name: "🚀 a🚀b🚀 café" }],
    });
    for (const columns of [24, 40, 60]) {
      const lines = formatPane(snap, columns);
      expectCleanWidth(lines, columns);
    }
  });

  it("draws the agreed shape at 40 columns (rule 9)", () => {
    const lines = formatPane(snapshot({
      rows: [{ id: "12a4", status: "completed", agent: "opencode", name: "fix-setup-active-profile", updatedAt: "2026-09-19T12:00:00.000Z" }],
      hidden: 12,
      total: 14,
    }), 40);
    expect(lines[0]).toBe("┌─ Run canvas f5fd ────────────────────┐");
    expect(lines[0]).toHaveLength(40);
    expect(lines.some((l) => l.includes("Orchestrator"))).toBe(true);
    expect(lines.some((l) => l.includes("12a4"))).toBe(true);
    expect(lines.some((l) => l.includes("13 finished"))).toBe(true);
    expect(lines.some((l) => l.includes("+12 earlier"))).toBe(true);
  });

  it("returns no line carrying a newline, carriage return or tab (rule 9)", () => {
    const snap = snapshot({
      rows: [{ id: "x", status: "work\ting", agent: "cla\rude", name: "line\nbreak" }],
    });
    for (const line of formatPane(snap, 40)) {
      expect(line).not.toMatch(/[\n\r\t]/);
    }
  });

  it("turns control and separator characters into spaces before drawing (rule 9)", () => {
    const snap = snapshot({
      rows: [{ id: "esc", status: "completed", agent: "opencode", name: "ref\u001b[2J\u001b[Hx\u2028docs\u2029y" }],
    });
    const lines = formatPane(snap, 40);
    expectCleanWidth(lines, 40);
    for (const line of lines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    }
    expect(lines.join("\n")).toContain("ref");
  });

  it("clips an over-long name to the cell without wrapping it (rule 9)", () => {
    const snap = snapshot({
      rows: [{ id: "c", status: "completed", agent: "claude", name: "n".repeat(200) }],
    });
    const lines = formatPane(snap, 40);
    expectCleanWidth(lines, 40);
    expect(lines.join("\n")).not.toMatch(/n{40}/);
  });

  it("never strands half of a surrogate pair when clipping (rule 9)", () => {
    const snap = snapshot({
      rows: [{ id: "s", status: "completed", agent: "claude", name: "🚀".repeat(60) }],
    });
    for (const line of formatPane(snap, 40)) {
      // Walk the line as code units, consuming a valid pair together. A high
      // not followed by a low, or a low not preceded by a high, is a strand.
      for (let i = 0; i < line.length; i += 1) {
        const code = line.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = line.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
          i += 1;
        } else {
          expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
        }
      }
    }
  });

  it("returns an empty array when columns is below MIN_COLUMNS (rule 9)", () => {
    expect(MIN_COLUMNS).toBe(24);
    expect(formatPane(snapshot(), 23)).toEqual([]);
    expect(formatPane(snapshot(), 0)).toEqual([]);
  });

  it("returns an empty array when there are no rows and no orchestrator (rule 10)", () => {
    expect(formatPane(snapshot({ rows: [], orchestrator: undefined, hidden: 0 }), 40)).toEqual([]);
    expect(formatPane(snapshot({ rows: [], orchestrator: undefined, hidden: 4 }), 40)).toEqual([]);
  });

  it("draws an orchestrator-only run as a single node (rule 10)", () => {
    const lines = formatPane(snapshot({ rows: [], hidden: 0, total: 1 }), 40);
    expectCleanWidth(lines, 40);
    expect(lines.some((l) => l.includes("Orchestrator"))).toBe(true);
    expect(lines.some((l) => l.includes("hidden"))).toBe(false);
  });

  it("summarizes source-hidden rows in history, and adds no duplicate hidden line (rule 6)", () => {
    const withHidden = formatPane(snapshot({ hidden: 3, total: 6 }), 40);
    const hiddenLines = withHidden.filter((l) => l.includes("hidden agents"));
    expect(hiddenLines).toHaveLength(0);
    expect(withHidden.some((l) => l.includes("4 finished"))).toBe(true);
    expect(withHidden.some((l) => l.includes("+3 earlier"))).toBe(true);

    const withoutHidden = formatPane(snapshot({ hidden: 0 }), 40);
    expect(withoutHidden.some((l) => l.includes("hidden agents"))).toBe(false);
  });

  it("counts working, waiting and finished separately in the header (rule 3)", () => {
    const rows: PaneRow[] = [
      { id: "w", status: "working", agent: "claude", name: "w" },
      { id: "s", status: "starting", agent: "claude", name: "s" },
      { id: "n", status: "needs_input", agent: "claude", name: "n" },
      { id: "c", status: "completed", agent: "claude", name: "c" },
      { id: "f", status: "failed", agent: "claude", name: "f" },
    ];
    const header = formatPane(snapshot({ rows, orchestrator: { agent: "claude" }, hidden: 0, total: 6 }), 40);
    expect(header.some((l) => l.includes("2 working"))).toBe(true);
    expect(header.some((l) => l.includes("1 waiting for you"))).toBe(true);
    expect(header.some((l) => l.includes("2 finished"))).toBe(true);
  });

  it("folds the hidden overflow into the finished count (rule 6)", () => {
    const rows: PaneRow[] = [{ id: "w", status: "working", agent: "claude", name: "w" }];
    const lines = formatPane(snapshot({ rows, hidden: 3, total: 5 }), 40);
    expect(lines.some((l) => l.includes("1 working"))).toBe(true);
    expect(lines.some((l) => l.includes("3 finished"))).toBe(true);
    expect(lines.some((l) => l.includes("5 sessions"))).toBe(true);
  });

  it("renders missing fields as a placeholder, never undefined (rule 10)", () => {
    const snap = snapshot({
      orchestrator: undefined,
      rows: [{ status: "completed" } as unknown as PaneRow],
    });
    const lines = formatPane(snap, 40);
    expectCleanWidth(lines, 40);
    expect(lines.join("\n")).not.toContain("undefined");
    expect(lines.some((l) => l.includes("-"))).toBe(true);
  });

  it("renders a prototype-key agent or status as a placeholder, not a function (rule 10)", () => {
    for (const key of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      const snap = snapshot({
        orchestrator: { agent: key },
        rows: [{ id: "x", status: key, agent: key, name: key }],
      });
      const lines = formatPane(snap, 40);
      expectCleanWidth(lines, 40);
      const joined = lines.join("\n");
      expect(joined).not.toMatch(/function|native code|\[object/);
      expect(joined).not.toContain("undefined");
    }
  });

  it("never throws on a snapshot that is not the shape it claims (rule 10)", () => {
    const junk = [
      null,
      undefined,
      {},
      { rows: null },
      { rows: [null, undefined], orchestrator: "open" },
      { rows: [{ id: 7, name: {}, status: null }], hidden: Number.NaN, total: -5 },
    ];
    for (const bad of junk) {
      for (const rows of [undefined, 0, 9, 10, 12, 44]) {
        const lines = formatPane(bad as unknown as PaneSnapshot, 40, rows);
        expect(Array.isArray(lines)).toBe(true);
        if (typeof rows === "number") expect(lines.length).toBeLessThanOrEqual(Math.max(rows, 0));
        for (const line of lines) expect(line).toHaveLength(40);
      }
    }
  });

  it("keeps a hostile name with a newline and an escape clean and correctly wide (mandatory)", () => {
    const snap = snapshot({
      rows: [
        { id: "h", status: "working", agent: "opencode", name: "evil\nname\rwith\ttabs\u001b[31mred\u2028next" },
      ],
    });
    const lines = formatPane(snap, 40);
    expectCleanWidth(lines, 40);
    expect(lines.some((l) => l.includes("evil name with tabs"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    }
  });

  it("renders 19 workers at 89x44 with a compact history section (mandatory)", () => {
    const lines = formatPane(workerFixture(), 89, 44);
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe("└" + "─".repeat(87) + "┘");
    expect(lines[18]).toContain("● working");
    expect(lines[19]).toContain("▲ Claude");
    expect(lines.some((l) => l.includes("19 sessions"))).toBe(true);
    expect(lines.some((l) => l.includes("1 working"))).toBe(true);
    expect(lines.some((l) => l.includes("0 waiting for you"))).toBe(true);
    expect(lines.some((l) => l.includes("18 finished"))).toBe(true);
    expect(lines.some((l) => l.includes("HISTORY · 18 finished"))).toBe(true);
    // The live worker and three recent finished workers are visible. The rest
    // is represented by the history summary.
    expect(lines.filter((l) => l.includes("hidden agents"))).toHaveLength(0);
    const joined = lines.join("\n");
    for (const worker of ["w1", "a01", "a03"]) expect(joined).toContain(worker);
    expect(joined).toContain("+15 earlier");
    expect(joined).not.toContain("a18");
  });

  it("keeps every live worker and only three finished workers at 89x44 (mandatory)", () => {
    const lines = formatPane(workerFixture(), 89, 44);
    const joined = lines.join("\n");
    const workerIds = ["w1", ...Array.from({ length: 18 }, (_, i) => `a${String(i + 1).padStart(2, "0")}`)];
    const drawn = workerIds.filter((id) => joined.includes(id)).length;
    expect(drawn).toBe(4);
  });

  it("keeps the live worker when the 89x20 pane drops history (mandatory)", () => {
    const lines = formatPane(workerFixture(), 89, 20);
    expect(lines).toHaveLength(17);
    expect(lines[16]).toBe("└" + "─".repeat(87) + "┘");
    const joined = lines.join("\n");
    expect(joined).toContain("w1");
    expect(joined).toContain("+18 hidden agents");
    expect(joined).not.toContain("a01");
    expect(joined).not.toContain("a18");
  });

  it("draws the first line after the header separator and its blank as a card top (mandatory)", () => {
    for (const snap of [workerFixture(), snapshot()]) {
      const lines = formatPane(snap, 89, 44);
      expect(lines[5].startsWith("│  ┌─")).toBe(true);
    }
  });

  it("keeps history to one connected section when every entry is finished (mandatory)", () => {
    const rows: PaneRow[] = [
      { id: "c1", status: "completed", agent: "claude", name: "one" },
      { id: "c2", status: "completed", agent: "opencode", name: "two" },
      { id: "c3", status: "stopped", agent: "codex", name: "three" },
    ];
    const lines = formatPane(snapshot({ rows, hidden: 0, total: 4 }), 89);
    expect(lines.filter((l) => l === STEM89)).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(STEM89 + "\n" + STEM89);
    expect(lines.join("\n")).toContain("HISTORY · 3 finished");
  });

  it("draws history as the root block with no stem at all (mandatory)", () => {
    const rows: PaneRow[] = [
      { id: "c1", status: "completed", agent: "claude", name: "one" },
      { id: "c2", status: "completed", agent: "opencode", name: "two" },
      { id: "c3", status: "stopped", agent: "codex", name: "three" },
    ];
    const lines = formatPane(snapshot({ orchestrator: undefined, rows, hidden: 0, total: 3 }), 89);
    // The history block is the root, so there is nothing above it to hang a
    // stem from.
    expect(lines).toHaveLength(14);
    expect(lines.filter((l) => l === STEM89)).toHaveLength(0);
    expect(lines[5]).toContain("HISTORY · 3 finished");
  });

  it("keeps the orchestrator as the root when workers do not fit (mandatory)", () => {
    // snapshot(): orchestrator + working a1 + finished b2.
    const at16 = formatPane(snapshot(), 40, 16);
    expect(at16).toHaveLength(16);
    const joined16 = at16.join("\n");
    expect(joined16).toContain("Orchestrator");
    expect(joined16).toContain("+2 hidden agents");
    expect(joined16).not.toContain("a1");
    expect(joined16).not.toContain("b2");
    // One row tighter still keeps the root, but the hidden line gives way.
    const at15 = formatPane(snapshot(), 40, 15);
    expect(at15).toHaveLength(14);
    const joined15 = at15.join("\n");
    expect(joined15).toContain("Orchestrator");
    expect(joined15).not.toContain("hidden agents");
  });

  it("renders the same 19 workers at 12 rows as header, footer and hidden line (mandatory)", () => {
    const lines = formatPane(workerFixture(), 89, 12);
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe("└" + "─".repeat(87) + "┘");
    expect(lines.some((l) => l.includes("19 sessions"))).toBe(true);
    expect(lines.some((l) => l.includes("18 finished"))).toBe(true);
    expect(lines.some((l) => l.includes("● working"))).toBe(true);
    expect(lines.some((l) => l.includes("+19 hidden agents"))).toBe(true);
    for (const worker of ["w1", "a01", "a18"]) expect(lines.join("\n")).not.toContain(worker);
  });
});

describe("paneButtonLabel", () => {
  it("shows only the workers that are working now", () => {
    expect(paneButtonLabel(snapshot({ total: 3 }))).toBe("1 working");
  });

  it("shows waiting workers when nobody is working", () => {
    const waiting = snapshot({
      rows: [{ id: "b2", status: "needs_input", agent: "claude", name: "beta" }],
      total: 2,
    });
    expect(paneButtonLabel(waiting)).toBe("1 waiting for you");
  });

  it("does not count finished workers", () => {
    const idle = snapshot({
      rows: [{ id: "b2", status: "completed", agent: "claude", name: "beta" }],
      total: 2,
    });
    expect(paneButtonLabel(idle)).toBe("no active agents");
  });

  it("counts starting as working, matching the pane header", () => {
    const booting = snapshot({
      rows: [{ id: "a1", status: "starting", agent: "codex", name: "alpha" }],
      total: 2,
    });
    expect(paneButtonLabel(booting)).toBe("1 working");
  });

  it("shows an inactive run without its historical total", () => {
    expect(paneButtonLabel(snapshot({ rows: [], hidden: 0, total: 1 }))).toBe("no active agents");
  });

  it("falls back to a bare word before the first refresh lands", () => {
    expect(paneButtonLabel(undefined)).toBe("agents");
  });

  it("survives a snapshot the daemon mangled, because a throw drops the drawing", () => {
    const broken = { rows: "nope", total: "many" } as unknown as PaneSnapshot;
    expect(paneButtonLabel(broken)).toBe("no active agents");
  });
});
