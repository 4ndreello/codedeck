import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";

function formatEvent(ev: any): string {
  const t = new Date(ev.timestamp).toLocaleTimeString();
  switch (ev.type) {
    case "session.started":
      return `[${t}] ● Session started ${ev.nativeSessionId ? `(native ${String(ev.nativeSessionId).slice(0, 8)})` : ""}`;
    case "turn.started":
      return `[${t}] ▶ Turn started${ev.prompt ? `: ${String(ev.prompt).slice(0, 100)}` : ""}`;
    case "message":
      return `[${t}] ${ev.role === "user" ? "▶" : "●"} ${ev.role}: ${String(ev.content).slice(0, 500)}`;
    case "text.delta":
      return ev.delta;
    case "tool.started":
      return `[${t}] → ${ev.tool.name} ${ev.tool.input ? JSON.stringify(ev.tool.input).slice(0, 120) : ""}`;
    case "tool.completed":
      return `[${t}] ✓ ${ev.tool.name} ${ev.tool.success === false ? "failed" : "done"}${ev.tool.output ? `: ${String(ev.tool.output).slice(0, 200)}` : ""}`;
    case "file.changed":
      return `[${t}] ✎ ${ev.change} ${ev.path}`;
    case "usage.updated":
      return `[${t}] ◐ usage: ${JSON.stringify(ev.usage)}`;
    case "turn.completed":
      return `[${t}] ◑ turn completed (${ev.reason || ""})`;
    case "session.completed":
      return `[${t}] ● Session completed ${ev.reason || ""}`;
    case "session.failed":
      {
        const f = ev.failure;
        const tag = f ? ` [${f.blame}${f.retryable ? ", retryable" : ""}]` : "";
        return `[${t}] ✗ Session failed${tag}: ${ev.error}`;
      }
    case "error":
      return `[${t}] ✗ Error: ${ev.error}`;
    case "permission.requested":
      return `[${t}] ? Permission requested: ${ev.tool || ev.description || ""}`;
    default:
      return `[${t}] ${ev.type} ${JSON.stringify(ev).slice(0, 200)}`;
  }
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Show normalized session logs (human, JSON, or raw)")
    .argument("<id>", "session id (prefix allowed, e.g. a83f)")
    .option("--follow", "follow logs in real time (Ctrl+C to detach, session keeps running)")
    .option("--json", "output JSON array of normalized events")
    .option("--raw", "output raw harness payloads (debug)")
    .action(async (id: string, opts: any) => {
      const client = new IpcClient();
      try { await client.ensureDaemonStarted(); } catch {}
      let result: any;
      try {
        result = await client.request("session.logs", { id, follow: !!opts.follow, json: !!opts.json, raw: !!opts.raw });
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }

      const events = result.events || [];

      if (opts.json) {
        console.log(JSON.stringify(events, null, 2));
        if (!opts.follow) return;
      } else if (opts.raw) {
        for (const ev of events) {
          console.log(JSON.stringify(ev.raw || ev, null, 2));
        }
        if (!opts.follow) return;
      } else {
        for (const ev of events) {
          if (ev.type === "text.delta") {
            // For logs non-follow, show deltas as they are but maybe skip to avoid spam?
            // We'll show them
            process.stdout.write(ev.delta);
          } else {
            console.log(formatEvent(ev));
          }
        }
        if (!opts.follow) {
          // If terminal not reached and follow not requested, just exit
          return;
        }
      }

      if (!opts.follow) return;

      // Follow mode: subscribe
      console.log(`\n— following ${id} (Ctrl+C to exit) —\n`);

      const onEvent = (ev: any) => {
        if (opts.json) {
          console.log(JSON.stringify(ev));
        } else if (opts.raw) {
          console.log(JSON.stringify(ev.raw || ev, null, 2));
        } else {
          if (ev.type === "text.delta") process.stdout.write(ev.delta);
          else console.log(formatEvent(ev));
        }
        if (ev.type === "session.completed" || ev.type === "session.failed") {
          console.log(`\n— session ${ev.type === "session.completed" ? "completed" : "failed"} —`);
          process.exit(ev.type === "session.failed" ? 1 : 0);
        }
      };

      const off = client.subscribe(id, onEvent, () => {
        console.log("\n— stream ended —");
        process.exit(0);
      }, (err) => {
        console.error(`Subscribe error: ${err.message}`);
        process.exit(1);
      });

      process.on("SIGINT", () => {
        console.log("\nDetached.");
        off();
        process.exit(0);
      });

      // Also poll status as fallback
      const poll = async () => {
        while (true) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const info: any = await client.request("session.get", { id });
            const status = info.session.status;
            if (["completed", "failed", "stopped"].includes(status)) {
              console.log(`\nSession ${status}`);
              off();
              process.exit(status === "failed" ? 1 : 0);
            }
          } catch {}
        }
      };
      poll();
    });
}
