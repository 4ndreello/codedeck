import { InvalidArgumentError, type Command } from "commander";
import { isActiveStatus, type SessionStatus } from "../../core/session.js";
import { IpcClient } from "../../daemon/ipc.js";
import { getCliName } from "../cli-name.js";
import { truncate, visibleWidth } from "../ui.js";

function formatAge(date: string | Date): string {
  const d = new Date(date);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

type PsSession = {
  id?: string;
  name?: string;
  branch?: string;
  agent?: string;
  model?: string;
  status: string;
  cwd?: string;
  worktree?: string;
  pid?: number | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  lastEvent?: string;
};

const LAST_EVENT_WIDTH = 15;

const SEP = "  ";

const PS_FETCH_LIMIT = 100;
export const PS_RESERVED_LINES = 4;

type PsLayoutOptions = {
  all?: boolean;
  hiddenOlderCount?: number;
  isTTY: boolean;
  limit?: number;
  rows?: number;
};

export type PsLayout<T> = {
  sessions: T[];
  displayedCount: number;
  moreCount: number;
  showOverflowNote: boolean;
};

export function fitPsRowCount(rows?: number): number | undefined {
  if (rows == null || !Number.isFinite(rows) || rows <= 0) return undefined;
  return Math.max(1, Math.floor(rows) - PS_RESERVED_LINES);
}

export function psMoreCount(
  fetchedCount: number,
  displayedCount: number,
  hiddenOlderCount: number,
): number {
  return fetchedCount - displayedCount + hiddenOlderCount;
}

export function planPsLayout<T>(
  sessions: readonly T[],
  options: PsLayoutOptions,
): PsLayout<T> {
  const all = options.all === true;
  if (
    options.limit != null &&
    (!Number.isInteger(options.limit) || options.limit <= 0)
  ) {
    throw new Error("--limit must be a positive integer");
  }

  const explicitLimit =
    options.limit == null ? undefined : Math.min(options.limit, PS_FETCH_LIMIT);
  const heightLimit =
    explicitLimit == null && options.isTTY && !all
      ? fitPsRowCount(options.rows)
      : undefined;
  const displayLimit = explicitLimit ?? heightLimit;
  const displayed =
    displayLimit == null ? [...sessions] : sessions.slice(0, displayLimit);
  const ordered = options.isTTY ? [...displayed].reverse() : displayed;
  const moreCount = psMoreCount(
    sessions.length,
    displayed.length,
    options.hiddenOlderCount ?? 0,
  );

  return {
    sessions: ordered,
    displayedCount: displayed.length,
    moreCount,
    showOverflowNote: !all && moreCount > 0,
  };
}

export function formatPsOverflowNote(moreCount: number, cliName: string): string {
  return `+${moreCount} older hidden — ${cliName} ps --all`;
}

export function parsePsLimit(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("--limit must be a positive integer");
  }
  const limit = Number(value);
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    throw new InvalidArgumentError("--limit must be a positive integer");
  }
  return limit;
}

function padToWidth(s: string, w: number): string {
  const v = visibleWidth(s);
  if (v >= w) return s;
  return s + " ".repeat(w - v);
}

function ellipsizeEnd(s: string, w: number): string {
  if (w <= 0) return "";
  if (visibleWidth(s) <= w) return padToWidth(s, w);
  if (w === 1) return "…";
  return padToWidth(`${truncate(s, w - 1)}…`, w);
}

function ellipsizeStart(s: string, w: number): string {
  if (w <= 0) return "";
  if (visibleWidth(s) <= w) return padToWidth(s, w);
  if (w === 1) return "…";
  const chars = Array.from(s);
  let width = 0;
  let take = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = visibleWidth(chars[i]);
    if (width + cw > w - 1) break;
    width += cw;
    take++;
  }
  return padToWidth(`…${chars.slice(chars.length - take).join("")}`, w);
}

type PsColumnKey =
  | "id"
  | "name"
  | "agent"
  | "model"
  | "status"
  | "age"
  | "last"
  | "lastEvent"
  | "cwd";

type PsColumn = {
  key: PsColumnKey;
  header: string;
  pref: number;
  min: number;
  startTruncate?: boolean;
};

const PS_COLUMNS: readonly PsColumn[] = [
  { key: "id", header: "ID", pref: 4, min: 4 },
  { key: "name", header: "NAME", pref: 16, min: 8 },
  { key: "agent", header: "AGENT", pref: 9, min: 5 },
  { key: "model", header: "MODEL", pref: 16, min: 8 },
  { key: "status", header: "STATUS", pref: 13, min: 6 },
  { key: "age", header: "AGE", pref: 5, min: 5 },
  { key: "last", header: "LAST", pref: 5, min: 5 },
  { key: "lastEvent", header: "LAST EVENT", pref: LAST_EVENT_WIDTH, min: 10 },
  { key: "cwd", header: "CWD", pref: 12, min: 12, startTruncate: true },
];

// First dropped first. ID and NAME never drop: on a very narrow terminal the
// table degrades to ID + NAME rather than wrapping onto two physical lines.
const PS_DROP_ORDER: readonly PsColumnKey[] = [
  "cwd",
  "lastEvent",
  "last",
  "model",
  "agent",
  "age",
  "status",
];

function columnValue(col: PsColumnKey, s: PsSession): string {
  switch (col) {
    case "id":
      return s.id || "";
    case "name":
      return s.name || s.branch?.replace("ra/", "") || "-";
    case "agent":
      return s.agent || "";
    case "model":
      return s.model || "-";
    case "status":
      return displayStatus(s);
    case "age":
      return formatAge(s.createdAt);
    case "last":
      return formatAge(s.updatedAt);
    case "lastEvent":
      return (s.lastEvent || "-").replace(/[\r\n\t]+/g, " ");
    case "cwd":
      return (s.worktree || s.cwd || "").replace(process.env.HOME || "", "~");
  }
}

function formatCell(col: PsColumn, raw: string, width: number): string {
  if (col.key === "id" || col.key === "age" || col.key === "last") {
    const cut = truncate(raw, width);
    return padToWidth(cut, width);
  }
  if (col.startTruncate) return ellipsizeStart(raw, width);
  return ellipsizeEnd(raw, width);
}

export function resolvePsWidth(explicit?: number): number {
  if (explicit != null && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const stdout = process.stdout as { columns?: number; isTTY?: boolean } | undefined;
  const cols = stdout?.columns;
  if (stdout?.isTTY && typeof cols === "number" && cols > 0) return cols;
  return Number.POSITIVE_INFINITY;
}

function planPsColumns(maxWidth: number): { cols: PsColumn[]; widths: Map<PsColumnKey, number> } {
  const visible: PsColumn[] = [...PS_COLUMNS];

  if (!Number.isFinite(maxWidth)) {
    const widths = new Map<PsColumnKey, number>(visible.map((c) => [c.key, c.pref]));
    return { cols: visible, widths };
  }

  // 8 is the floor the force-shrink below can always reach (ID 2 + NAME 4
  // + one separator), so the fit guarantee holds for every width >= 8.
  const width = Math.max(8, Math.floor(maxWidth));
  const totalFor = (cols: PsColumn[], widths: Map<PsColumnKey, number>): number => {
    let sum = 0;
    for (const c of cols) sum += widths.get(c.key) ?? c.pref;
    return sum + SEP.length * Math.max(0, cols.length - 1);
  };

  // Drop low-priority columns first so NAME/MODEL keep their full width at
  // 80 columns (ID NAME AGENT MODEL STATUS AGE LAST = exactly 80).
  let widths = new Map<PsColumnKey, number>(visible.map((c) => [c.key, c.pref]));
  while (visible.length > 2) {
    if (totalFor(visible, widths) <= width) break;
    const dropKey = PS_DROP_ORDER.find((k) => visible.some((c) => c.key === k));
    if (!dropKey) break;
    const idx = visible.findIndex((c) => c.key === dropKey);
    visible.splice(idx, 1);
    widths.delete(dropKey);
  }

  // Shrink what remains from pref down to min, least important first.
  widths = new Map(visible.map((c) => [c.key, c.pref]));
  const shrinkOrder = [...visible]
    .filter((c) => c.pref > c.min)
    .sort((a, b) => {
      const pa = PS_DROP_ORDER.indexOf(a.key);
      const pb = PS_DROP_ORDER.indexOf(b.key);
      return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    });
  for (const col of shrinkOrder) {
    let total = totalFor(visible, widths);
    if (total <= width) break;
    const cur = widths.get(col.key) ?? col.pref;
    const reduce = Math.min(cur - col.min, total - width);
    widths.set(col.key, cur - reduce);
  }

  // Extremely narrow terminal: force NAME (then STATUS, then ID) below min
  // rather than emitting a line that wraps.
  while (totalFor(visible, widths) > width) {
    const name = visible.find((c) => c.key === "name");
    const nameW = name ? (widths.get("name") ?? name.pref) : 0;
    if (name && nameW > 4) {
      widths.set("name", nameW - 1);
      continue;
    }
    const status = visible.find((c) => c.key === "status");
    const statusW = status ? (widths.get("status") ?? status.pref) : 0;
    if (status && statusW > 4) {
      widths.set("status", statusW - 1);
      continue;
    }
    const id = visible.find((c) => c.key === "id");
    const idW = id ? (widths.get("id") ?? id.pref) : 0;
    if (id && idW > 2) {
      widths.set("id", idW - 1);
      continue;
    }
    break;
  }

  return { cols: visible, widths };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function displayStatus(session: PsSession): string {
  if (
    isActiveStatus(session.status as SessionStatus) &&
    session.pid != null &&
    !isProcessAlive(session.pid)
  ) {
    return "dead";
  }
  if (session.status === "interrupted") return "⏻ interrupted";
  return session.status;
}

export function psEmptyMessage(all: boolean): string {
  return all ? "No sessions" : "No sessions in the last 24h (use --all for full history)";
}

export function formatPsJson(sessions: readonly PsSession[]): string {
  return JSON.stringify(sessions, null, 2);
}
export function renderPsTable(sessions: readonly PsSession[], width?: number): string {
  const maxWidth = resolvePsWidth(width);
  const { cols, widths } = planPsColumns(maxWidth);

  // CWD is fill: with rows it takes the longest path that still fits, without
  // rows it shrinks to its header, so the divider matches the real width.
  if (cols.some((c) => c.key === "cwd")) {
    const cwdContent = Math.max(
      3,
      ...sessions.map((s) => visibleWidth(columnValue("cwd", s))),
    );
    if (Number.isFinite(maxWidth)) {
      const others = cols.filter((c) => c.key !== "cwd");
      const othersWidth =
        others.reduce((sum, c) => sum + (widths.get(c.key) ?? c.pref), 0) +
        SEP.length * Math.max(0, cols.length - 1);
      widths.set(
        "cwd",
        Math.max(3, Math.min(cwdContent, Math.floor(maxWidth) - othersWidth)),
      );
    } else {
      widths.set("cwd", cwdContent);
    }
  }

  const formatRow = (cells: string[]): string => {
    const line = cols
      .map((c, i) => formatCell(c, cells[i], widths.get(c.key) ?? c.pref))
      .join(SEP);
    return line.trimEnd();
  };

  const header = formatRow(cols.map((c) => c.header));
  const rows = sessions.map((s) => formatRow(cols.map((c) => columnValue(c.key, s))));
  const tableWidth = Math.max(visibleWidth(header), ...rows.map((r) => visibleWidth(r)));
  const dividerWidth = Number.isFinite(maxWidth)
    ? Math.min(tableWidth, Math.floor(maxWidth))
    : tableWidth;

  return [header, "─".repeat(dividerWidth), ...rows].join("\n");
}

export function registerPsCommand(program: Command): void {
  program
    .command("ps")
    .description("List recent sessions (daemon-owned, not harness IDs)")
    .option("--all", "include all sessions including completed/failed (default: recent)")
    .option("--json", "output JSON instead of table")
    .option("--limit <n>", "limit displayed sessions", parsePsLimit)
    .action(async (opts: any) => {
      const client = new IpcClient();
      try { await client.ensureDaemonStarted(); } catch {}
      let result: any;
      try {
        result = await client.request("session.list", { all: !!opts.all });
      } catch (e) {
        console.error(`Failed to list sessions: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      const sessions = (result.sessions || []) as PsSession[];
      const hidden = typeof result.hidden === "number" ? result.hidden : 0;
      const stdout = process.stdout as { isTTY?: boolean; rows?: number };
      const layout = planPsLayout(sessions, {
        all: !!opts.all,
        hiddenOlderCount: hidden,
        isTTY: opts.json ? false : !!stdout.isTTY,
        limit: opts.limit,
        rows: stdout.rows,
      });

      if (opts.json) {
        console.log(formatPsJson(layout.sessions));
        return;
      }

      if (sessions.length === 0) {
        console.log(psEmptyMessage(!!opts.all));
        return;
      }

      // Header and rows share the same fixed-width formatter.
      const overflowNote = layout.showOverflowNote
        ? formatPsOverflowNote(layout.moreCount, getCliName())
        : undefined;
      if (stdout.isTTY && overflowNote) console.log(overflowNote);
      console.log(renderPsTable(layout.sessions));
      if (!stdout.isTTY && overflowNote) console.log(overflowNote);
    });
}
