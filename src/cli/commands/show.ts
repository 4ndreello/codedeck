import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";

export function registerShowCommand(program: Command): void {
  program
    .command("show")
    .description("Show full session details (status, worktree, usage, recent events)")
    .argument("<id>", "session id (prefix allowed, e.g. a83f)")
    .option("--json", "output JSON with session + events")
    .action(async (id: string, opts: any) => {
      const client = new IpcClient();
      try { await client.ensureDaemonStarted(); } catch {}
      let result: any;
      try {
        result = await client.request("session.get", { id });
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      const s = result.session;
      if (!s) {
        console.error(`Session ${id} not found`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const age = (() => {
        const diff = Date.now() - new Date(s.createdAt).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return "just now";
        if (m < 60) return `${m}m ago`;
        return `${Math.floor(m / 60)}h ago`;
      })();

      console.log(`Session       ${s.id}`);
      if (s.name) console.log(`Name          ${s.name}`);
      console.log(`Agent         ${s.agent}`);
      console.log(`Status        ${s.status}`);
      if (s.failure) {
        const f = s.failure;
        console.log(`Failure       [${f.blame}${f.retryable ? ", retryable" : ""}] ${f.code}${f.detail ? ` — ${String(f.detail).slice(0, 120)}` : ""}`);
      }
      if (s.model) console.log(`Model         ${s.model}`);
      console.log(``);
      if (s.repository) console.log(`Repository    ${s.repository}`);
      console.log(`Working dir   ${s.worktree || s.cwd}`);
      if (s.branch) console.log(`Branch        ${s.branch}`);
      if (s.baseCommit) console.log(`Base commit   ${s.baseCommit.slice(0, 12)}`);
      if (s.nativeSessionId) console.log(`Native ID     ${s.nativeSessionId}`);
      if (s.pid) console.log(`PID           ${s.pid}`);
      console.log(``);
      console.log(`Started       ${age}`);
      if (s.lastEvent) console.log(`Last event    ${s.lastEvent.slice(0, 80)}`);
      if (s.completedAt) console.log(`Completed     ${new Date(s.completedAt).toLocaleString()}`);
      console.log(``);
      if (s.usage) {
        if (s.usage.inputTokens != null) console.log(`Input tokens  ${s.usage.inputTokens.toLocaleString()}`);
        if (s.usage.outputTokens != null) console.log(`Output tokens ${s.usage.outputTokens.toLocaleString()}`);
        if (s.usage.cachedTokens != null) console.log(`Cached tokens ${s.usage.cachedTokens.toLocaleString()}`);
        if (s.usage.cost != null) console.log(`Cost          $${s.usage.cost}`);
        else console.log(`Cost          unavailable`);
      } else {
        console.log(`Cost          unavailable`);
      }
      console.log(``);
      console.log(`Events        ${result.eventCount ?? (result.events?.length ?? 0)}`);
      if (result.events?.length) {
        console.log(`\nRecent events:`);
        for (const ev of result.events.slice(-10)) {
          const t = new Date(ev.timestamp).toLocaleTimeString();
          if (ev.type === "message") console.log(`  [${t}] ${ev.type}: ${(ev.content || "").slice(0, 100)}`);
          else if (ev.type === "tool.started") console.log(`  [${t}] → ${ev.tool.name}`);
          else if (ev.type === "tool.completed") console.log(`  [${t}] ✓ ${ev.tool.name}`);
          else console.log(`  [${t}] ${ev.type}`);
        }
      }
    });
}
