import type { Command } from "commander";
import { IpcClient, isDaemonRunning } from "../../daemon/ipc.js";
import { getPaths } from "../../config/paths.js";
import fs from "node:fs";

function check(label: string, ok: boolean, detail?: string): string {
  const icon = ok ? "✓" : "✗";
  const msg = detail ? `${label.padEnd(20)} ${icon} ${detail}` : `${label.padEnd(20)} ${icon}`;
  return ok ? msg : `\x1b[31m${msg}\x1b[0m`;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check Node, Git, harnesses, daemon, database and paths")
    .option("--json", "output JSON with full health report")
    .action(async (opts: any) => {
      const client = new IpcClient();
      let daemonRunning = await isDaemonRunning();
      if (!daemonRunning) {
        try { await client.ensureDaemonStarted(); daemonRunning = true; } catch {}
      }

      let result: any;
      try {
        result = await client.request("doctor", {});
      } catch (e) {
        console.error(`Doctor failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("Run Agent\n");

      console.log("System");
      console.log(`  Node               ${result.node.version}`);
      console.log(`  ${check("Git", result.git.installed, result.git.version || "not found")}`);
      console.log("");

      for (const [agent, info] of Object.entries(result.agents as Record<string, any>)) {
        const label = agent.charAt(0).toUpperCase() + agent.slice(1);
        // normalize name
        const display = label === "Claude" ? "Claude Code" : label.charAt(0).toUpperCase() + label.slice(1);
        console.log(display);
        console.log(`  ${check("installed", !!info.installed, info.version || info.path || (info.installed ? "yes" : "no"))}`);
        if (info.installed) {
          const auth = info.authenticated;
          if (auth === true) console.log(`  ${check("authenticated", true, "yes")}`);
          else if (auth === false) console.log(`  ${check("authenticated", false, "no")}`);
          else console.log(`  ${check("authenticated", true, "unknown")}`);

          const caps = info.capabilities || {};
          for (const [k, v] of Object.entries(caps)) {
            const ok = !!v;
            const mark = ok ? "✓" : "✗";
            // Use check helper but without color for capabilities maybe
            console.log(`  ${k.padEnd(20)} ${ok ? "✓" : "✗"} ${ok ? "yes" : "no"}`);
          }
          if (info.details) console.log(`  details            ${info.details}`);
        } else if (info.error) {
          console.log(`  error              ${info.error}`);
        }
        console.log("");
      }

      console.log("Daemon");
      console.log(`  ${check("running", !!result.daemon.running, result.daemon.running ? `pid ${result.daemon.pid}` : "not running")}`);
      if (result.daemon.running) {
        const up = result.daemon.uptime;
        const upStr = up ? `${Math.floor(up / 1000)}s` : "unknown";
        console.log(`  uptime             ${upStr}`);
      }
      console.log("");

      console.log("Database");
      console.log(`  path               ${result.database.path}`);
      console.log(`  ${check("exists", !!result.database.exists, result.database.exists ? "yes" : "no")}`);
      console.log("");

      const paths = getPaths();
      console.log("Paths");
      console.log(`  base               ${paths.base}`);
      console.log(`  socket             ${paths.daemonSock} ${fs.existsSync(paths.daemonSock) ? "✓" : "✗"}`);
      console.log(`  worktrees          ${paths.worktreesDir}`);
      console.log("");
    });
}
