import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop a running session")
    .argument("<id>", "session id")
    .option("--json", "output JSON")
    .action(async (id: string, opts: any) => {
      const client = new IpcClient();
      try { await client.ensureDaemonStarted(); } catch {}
      try {
        const result = await client.request("session.stop", { id });
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`Session ${id} stopped`);
      } catch (e) {
        console.error(`Failed to stop: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
