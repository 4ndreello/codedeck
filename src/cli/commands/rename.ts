import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";

export function registerRenameCommand(program: Command): void {
  program
    .command("rename")
    .description("Rename a session")
    .argument("<id>", "session id (prefix allowed, e.g. a83f)")
    .argument("<name>", "new session name")
    .option("--json", "output JSON")
    .action(async (id: string, name: string, opts: { json?: boolean }) => {
      const client = new IpcClient();
      try { await client.ensureDaemonStarted(); } catch {}

      let result: unknown;
      try {
        result = await client.request("session.rename", { id, name });
      } catch (e) {
        console.error(`Failed to rename: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Session ${id} renamed to ${name}`);
    });
}
