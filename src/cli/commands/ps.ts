import type { Command } from "commander";
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

      if (opts.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }

      if (sessions.length === 0) {
        console.log("No sessions");
        return;
      }

      // Header
      console.log(
        "ID    NAME              AGENT     STATUS        AGE   CWD",
      );
      console.log(
        "─".repeat(80),
      );

      for (const s of sessions) {
        const id = (s.id || "").padEnd(4);
        const name = (s.name || s.branch?.replace("ra/", "") || "-").slice(0, 16).padEnd(16);
        const agent = (s.agent || "").padEnd(9);
        const status = (s.status || "").padEnd(12);
        const age = formatAge(s.createdAt).padEnd(5);
        const cwd = (s.worktree || s.cwd || "").replace(process.env.HOME || "", "~");
        console.log(`${id}  ${name}  ${agent}  ${status}  ${age}  ${cwd}`);
      }
    });
}
