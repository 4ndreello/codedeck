import type { Command } from "commander";
import { isActiveStatus, type SessionStatus } from "../../core/session.js";
import { IpcClient } from "../../daemon/ipc.js";

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
export function renderPsTable(sessions: readonly PsSession[]): string {
  const lines = [
    "ID    NAME              AGENT      MODEL             STATUS         AGE    LAST   LAST EVENT       CWD",
    "─".repeat(80),
  ];

  for (const s of sessions) {
    const id = (s.id || "").slice(0, 4).padEnd(4);
    const name = (s.name || s.branch?.replace("ra/", "") || "-").slice(0, 16).padEnd(16);
    const agent = (s.agent || "").slice(0, 9).padEnd(9);
    const model = (s.model || "-").slice(0, 16).padEnd(16);
    const status = displayStatus(s).slice(0, 13).padEnd(13);
    const age = formatAge(s.createdAt).padEnd(5);
    const last = formatAge(s.updatedAt).padEnd(5);
    const lastEvent = (s.lastEvent || "-").replace(/[\r\n\t]+/g, " ").slice(0, LAST_EVENT_WIDTH).padEnd(LAST_EVENT_WIDTH);
    const cwd = (s.worktree || s.cwd || "").replace(process.env.HOME || "", "~");
    lines.push(`${id}  ${name}  ${agent}  ${model}  ${status}  ${age}  ${last}  ${lastEvent}  ${cwd}`);
  }

  return lines.join("\n");
}

export function registerPsCommand(program: Command): void {
  program
    .command("ps")
    .description("List recent sessions (daemon-owned, not harness IDs)")
    .option("--all", "include all sessions including completed/failed (default: recent)")
    .option("--json", "output JSON instead of table")
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

      const sessions = result.sessions || [];
      const hidden = typeof result.hidden === "number" ? result.hidden : 0;

      if (opts.json) {
        console.log(formatPsJson(sessions));
        return;
      }

      if (sessions.length === 0) {
        console.log(psEmptyMessage(!!opts.all));
        return;
      }

      // Header and rows share the same fixed-width formatter.
      console.log(renderPsTable(sessions));
      if (hidden > 0) {
        console.log(`+${hidden} older hidden — codedeck ps --all`);
      }
    });
}
