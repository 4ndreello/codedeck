import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";

export function registerSendCommand(program: Command): void {
  program
    .command("send")
    .description("Continue a session with a new message (new turn, uses native resume when available)")
    .argument("<id>", "session id (prefix allowed, e.g. a83f)")
    .argument("<message>", "message to send (e.g. \"add tests\")")
    .option("--json", "output JSON")
    .action(async (id: string, message: string, opts: any) => {
      const client = new IpcClient();
      try { await client.ensureDaemonStarted(); } catch {}
      let result: any;
      try {
        result = await client.request("session.send", { id, message });
      } catch (e) {
        console.error(`Failed to send: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Message sent to ${id}`);
    });
}
