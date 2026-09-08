import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";

export function registerDoneCommand(program: Command): void {
  program
    .command("done")
    .description("Mark a session as finished (archives interrupted rows as completed)")
    .argument("<id>", "session id (prefix allowed, e.g. a83f)")
    .option("--failed", "archive as failed instead of completed")
    .option("--error <text>", "failure text for --failed")
    .option("--json", "output JSON")
    .action(async (id: string, opts: any) => {
      const client = new IpcClient();
      try { await client.ensureDaemonStarted(); } catch {}
      try {
        const params: { id: string; status?: "failed"; error?: string } = { id };
        if (opts.failed) {
          params.status = "failed";
          if (typeof opts.error === "string" && opts.error.trim()) params.error = opts.error;
        }
        const result = await client.request("session.release", params);
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`Session ${id} marked as ${opts.failed ? "failed" : "completed"}`);
      } catch (e) {
        console.error(`Failed to mark done: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
