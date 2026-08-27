import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Show git diff for a session against its base commit (harness-independent)")
    .argument("<id>", "session id (prefix allowed, e.g. a83f)")
    .option("--stat", "show diff --stat and file list only")
    .option("--json", "output JSON { base, diff, stat, files }")
    .action(async (id: string, opts: any) => {
      const client = new IpcClient();
      try { await client.ensureDaemonStarted(); } catch {}
      let result: any;
      try {
        result = await client.request("session.diff", { id });
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (opts.stat) {
        console.log(result.stat || "(no stat)");
        if (result.files?.length) {
          console.log(`\nFiles: ${result.files.join(", ")}`);
        }
        return;
      }

      if (!result.diff || !result.diff.trim()) {
        console.log("(no changes)");
        if (result.files?.length) console.log(`Files: ${result.files.join(", ")}`);
        return;
      }

      console.log(result.diff);
    });
}
