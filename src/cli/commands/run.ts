import type { Command } from "commander";
import path from "node:path";
import { IpcClient } from "../../daemon/ipc.js";
import { loadConfig } from "../../config/config.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Start a new agent session")
    .argument("<prompt>", "prompt for the agent")
    .option("--agent <agent>", "agent to use (claude|codex|opencode|omp)")
    .option("--model <model>", "model to use")
    .option("--name <name>", "session name")
    .option("--cwd <cwd>", "working directory")
    .option("--worktree", "create isolated git worktree")
    .option("--no-worktree", "do not create worktree")
    .option("--detach", "run detached, print session id and exit")
    .option("--json", "output JSON")
    .action(async (prompt: string, opts: any) => {
      const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
      const cfg = loadConfig();
      const agent = opts.agent || cfg.defaultAgent || "claude";

      const client = new IpcClient();
      try {
        await client.ensureDaemonStarted();
      } catch (e) {
        console.error(`Failed to start daemon: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      const params: any = {
        prompt,
        agent,
        model: opts.model,
        name: opts.name,
        cwd,
        worktree: opts.worktree,
        noWorktree: opts.noWorktree,
        detach: !!opts.detach,
      };

      let result: any;
      try {
        result = await client.request("session.create", params);
      } catch (e) {
        console.error(`Failed to create session: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      const session = result.session;
      if (opts.json) {
        console.log(JSON.stringify(session, null, 2));
      } else {
        console.log(`Session ${session.id} created (${session.agent})`);
        if (session.worktree) console.log(`Worktree: ${session.worktree} Branch: ${session.branch}`);
      }

      if (opts.detach) {
        // Just show id and exit
        if (!opts.json) console.log(`\nUse: ra logs ${session.id} --follow`);
        process.exit(0);
      }

      // Follow logs
      console.log(`\nFollowing logs for ${session.id} (Ctrl+C to detach)...\n`);

      let followDone = false;
      const onEvent = (ev: any) => {
        if (ev.type === "message" && ev.content) {
          console.log(`[${ev.role || "assistant"}] ${ev.content.slice(0, 500)}`);
        } else if (ev.type === "text.delta" && ev.delta) {
          process.stdout.write(ev.delta);
        } else if (ev.type === "tool.started") {
          console.log(`\n→ tool: ${ev.tool.name} ${ev.tool.input ? JSON.stringify(ev.tool.input).slice(0, 200) : ""}`);
        } else if (ev.type === "tool.completed") {
          console.log(`✓ tool: ${ev.tool.name} ${ev.tool.success === false ? "failed" : "completed"}`);
        } else if (ev.type === "session.completed") {
          console.log(`\n✓ Session ${session.id} completed`);
          followDone = true;
        } else if (ev.type === "session.failed") {
          console.log(`\n✗ Session ${session.id} failed: ${ev.error}`);
          followDone = true;
        } else if (ev.type === "error") {
          console.log(`\n! Error: ${ev.error}`);
        }
      };

      const unsubscribe = client.subscribe(session.id, onEvent, () => {
        if (!followDone) console.log(`\n— log stream ended —`);
        process.exit(followDone ? 0 : 0);
      }, (err) => {
        console.error(`Subscribe error: ${err.message}`);
      });

      // Also fetch initial logs that may have been missed before subscribe
      try {
        const logs = await client.request<any>("session.logs", { id: session.id });
        for (const ev of logs.events || []) {
          onEvent(ev);
          if (ev.type === "session.completed" || ev.type === "session.failed") followDone = true;
        }
        if (followDone) {
          unsubscribe();
          process.exit(0);
        }
      } catch {}

      // Handle Ctrl+C: detach but keep session running
      process.on("SIGINT", () => {
        console.log(`\nDetached from ${session.id}. Session continues in background.`);
        console.log(`Run: ra logs ${session.id} --follow  to reattach`);
        console.log(`     ra stop ${session.id}     to stop`);
        unsubscribe();
        process.exit(0);
      });

      // Poll status until terminal if subscribe fails
      const poll = async () => {
        while (!followDone) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const info: any = await client.request("session.get", { id: session.id });
            const status = info.session.status;
            if (["completed", "failed", "stopped", "orphaned"].includes(status)) {
              console.log(`\nSession ${session.id} is ${status}`);
              unsubscribe();
              process.exit(status === "failed" ? 1 : 0);
            }
          } catch {}
        }
      };
      poll();
    });
}
