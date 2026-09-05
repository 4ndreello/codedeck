import type { Command } from "commander";
import path from "node:path";
import { IpcClient } from "../../daemon/ipc.js";
import { loadConfig } from "../../config/config.js";
import { CODEX_SANDBOXES, parseEffort, parseSandbox, REASONING_EFFORTS } from "../../core/driver.js";
import { exitCodeForOutcome, type FailureInfo } from "../../core/errors.js";
import type { AgentEvent } from "../../core/events.js";
import { isTerminalStatus, type Session } from "../../core/session.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Start a new agent session (creates a CodeDeck session, not a raw harness call)")
    .argument("<prompt>", "prompt for the agent (e.g. \"implement authentication\")")
    .option("--agent <agent>", "agent to use: claude | codex | opencode | omp (default: claude or config.defaultAgent)")
    .option("--model <model>", "model to use (e.g. claude-opus-5, gpt-5, anthropic/claude-sonnet)")
    .option("--effort <level>", `reasoning effort: ${REASONING_EFFORTS.join(" | ")}`)
    .option("--fast", "use the priority service tier (1.5x speed) — codex and omp only")
    .option("--sandbox <mode>", `codex sandbox: ${CODEX_SANDBOXES.join(" | ")} (default: workspace-write)`)
    .option("--dangerously-bypass-approvals-and-sandbox", "codex: bypass sandbox and approvals (sets sandbox to danger-full-access)")
    .option("--name <name>", "human-readable session name (slug for branch)")
    .option("--cwd <cwd>", "working directory (default: current directory)")
    .option("--worktree", "create isolated git worktree at ~/.run-agent/worktrees/<hash>/<id>")
    .option("--no-worktree", "do not create worktree, run in current directory")
    .option("--bg, --detach", "run in background: print session id and exit")
    .option("--json", "output JSON instead of human-readable text")
    .addHelpText("after", `
Examples:
  $ npx codedeck run "implement authentication" --agent claude
  $ npx codedeck run "fix the tests" --agent codex --model gpt-5 --bg
  $ npx codedeck run "refactor" --agent codex --model gpt-5.6-luna --effort max --fast
  $ npx codedeck run "refactor module" --agent opencode --worktree --name refactor
  $ npx codedeck run "investigate bug" --agent omp --cwd ./my-project --json
Power: a poweroff/reboot marks running sessions interrupted (exit 3).
Resume with: codedeck send <id> "continue"
`)
    .action(async (prompt: string, opts: any) => {
      const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
      const cfg = loadConfig();
      const agent = opts.agent || cfg.defaultAgent || "claude";

      // Validate here so a typo fails before a session row is created; codex
      // would otherwise reject it at spawn time, leaving a dead session behind.
      let effort;
      if (opts.effort) {
        try {
          effort = parseEffort(opts.effort);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(3); // usage error — infra class
        }
      }

      let sandbox;
      if (opts.sandbox) {
        try {
          sandbox = parseSandbox(opts.sandbox);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(3);
        }
      }
      // --dangerously-bypass-approvals-and-sandbox is sugar for
      // --sandbox danger-full-access plus bypass flag; keep it codex-only.
      const dangerouslyBypass = !!opts.dangerouslyBypassApprovalsAndSandbox;
      if (dangerouslyBypass && !sandbox) sandbox = "danger-full-access" as const;
      if (dangerouslyBypass && sandbox && sandbox !== "danger-full-access") {
        console.error('Warning: --dangerously-bypass-approvals-and-sandbox implies --sandbox danger-full-access; overriding sandbox to danger-full-access.');
        sandbox = "danger-full-access" as const;
      }

      // Claude exposes no service-tier flag, so --fast cannot be honoured there.
      // Warn and clear it so the persisted session does not claim a priority
      // tier that was never applied — the driver ignores it anyway.
      const effectiveFast = agent !== "claude" && !!opts.fast;
      if (opts.fast && agent === "claude") {
        console.error("Warning: --fast has no effect on claude (no service tier flag); continuing without it.");
      }

      const effectiveSandbox = agent === "codex" ? sandbox : undefined;
      if (sandbox && agent !== "codex") {
        console.error(`Warning: --sandbox has no effect on ${agent} (only codex supports -s); continuing without it.`);
      }
      if (dangerouslyBypass && agent !== "codex") {
        console.error(`Warning: --dangerously-bypass-approvals-and-sandbox has no effect on ${agent} (only codex); continuing without it.`);
      }

      const client = new IpcClient();
      try {
        await client.ensureDaemonStarted();
      } catch (e) {
        console.error(`Failed to start daemon: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(3); // infra: daemon unavailable
      }

      const background = !!opts.detach;
      const params: any = {
        prompt,
        agent,
        model: opts.model,
        effort,
        fast: effectiveFast,
        sandbox: effectiveSandbox,
        dangerouslyBypassApprovalsAndSandbox: agent === "codex" ? dangerouslyBypass : undefined,
        name: opts.name,
        cwd,
        worktree: opts.worktree,
        noWorktree: opts.noWorktree,
        detach: background,
      };

      let result: any;
      try {
        result = await client.request("session.create", params);
      } catch (e) {
        console.error(`Failed to create session: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(3); // infra: daemon rejected session creation
      }

      const session = result.session;
      if (opts.json) {
        // Session object only in background mode, where it is the entire output.
        // Blocking --json keeps stdout a pure NDJSON event stream; every
        // event carries sessionId, so follow-ups never need the bare row.
        if (background) console.log(JSON.stringify(session));
      } else {
        console.log(`Session ${session.id} created (${session.agent})`);
        if (session.worktree) console.log(`Worktree: ${session.worktree} Branch: ${session.branch}`);
      }

      if (background) {
        // Just show id and exit
        if (!opts.json) console.log(`\nUse: npx codedeck logs ${session.id} --follow`);
        process.exit(0);
      }

      // ---- follow ---------------------------------------------------------
      // Agent contract: `--json` emits one NDJSON event per line on stdout and
      // NOTHING else touches stdout; human mode streams the pretty renderer.
      // Exit codes: 0 completed/stopped · 1 task failed · 2 harness crashed
      // (retryable) · 3 infra/usage — see exitCodeForOutcome in core/errors.
      if (!opts.json) console.log(`\nFollowing logs for ${session.id} (Ctrl+C to detach)...\n`);

      let followDone = false;
      let outcome: { status: string; failure?: FailureInfo } | null = null;

      const onEvent = (ev: AgentEvent) => {
        if (opts.json) {
          console.log(JSON.stringify(ev));
        } else if (ev.type === "message") {
          console.log(`[${ev.role || "assistant"}] ${ev.content.slice(0, 500)}`);
        } else if (ev.type === "text.delta") {
          process.stdout.write(ev.delta);
        } else if (ev.type === "tool.started") {
          console.log(`\n→ tool: ${ev.tool.name} ${ev.tool.input ? JSON.stringify(ev.tool.input).slice(0, 200) : ""}`);
        } else if (ev.type === "tool.completed") {
          console.log(`✓ tool: ${ev.tool.name} ${ev.tool.success === false ? "failed" : "completed"}`);
        } else if (ev.type === "session.completed") {
          console.log(`\n✓ Session ${session.id} completed`);
        } else if (ev.type === "session.failed") {
          const tag = ev.failure ? ` [${ev.failure.blame}${ev.failure.retryable ? ", retryable" : ""}]` : "";
          console.log(`\n✗ Session ${session.id} failed${tag}: ${ev.error}`);
        } else if (ev.type === "error") {
          console.log(`\n! Error: ${ev.error}`);
        }
        if (ev.type === "session.completed") {
          followDone = true;
          outcome = { status: "completed" };
        } else if (ev.type === "session.failed") {
          followDone = true;
          outcome = { status: "failed", failure: ev.failure };
        }
      };

      // Single authoritative exit path: the daemon persists status+failure
      // BEFORE broadcasting the terminal event, so the store always knows the
      // final state — even when the event stream died without one.
      const finishFromStore = async () => {
        try {
          const info = await client.request<{ session: Session }>("session.get", { id: session.id });
          process.exit(exitCodeForOutcome({ status: info.session.status, failure: info.session.failure }));
        } catch {
          // Stream AND store both lost: cannot confirm success, report failed.
          process.exit(exitCodeForOutcome(outcome ?? { status: "failed" }));
        }
      };

      const unsubscribe = client.subscribe(session.id, onEvent, () => {
        if (!followDone && !opts.json) console.log(`\n— log stream ended —`);
        void finishFromStore();
      }, (err) => {
        console.error(`Subscribe error: ${err.message}`);
      });

      // Also fetch initial logs that may have been missed before subscribe
      try {
        const logs = await client.request<{ events?: AgentEvent[] }>("session.logs", { id: session.id });
        for (const ev of logs.events || []) onEvent(ev);
        if (followDone) {
          unsubscribe();
          await finishFromStore();
        }
      } catch {}

      // Handle Ctrl+C: detach but keep session running
      process.on("SIGINT", () => {
        if (!opts.json) {
          console.log(`\nDetached from ${session.id}. Session continues in background.`);
          console.log(`Run: npx codedeck logs ${session.id} --follow  to reattach`);
          console.log(`     npx codedeck stop ${session.id}     to stop`);
        }
        unsubscribe();
        process.exit(0);
      });

      // Poll status until terminal if subscribe fails
      const poll = async () => {
        while (!followDone) {
          const { promise: tick, resolve: woke } = Promise.withResolvers<void>();
          setTimeout(woke, 2000);
          await tick;
          try {
            const info = await client.request<{ session: Session }>("session.get", { id: session.id });
            const status = info.session.status;
            if (isTerminalStatus(status)) {
              if (!opts.json) console.log(`\nSession ${session.id} is ${status}`);
              unsubscribe();
              process.exit(exitCodeForOutcome({ status, failure: info.session.failure }));
            }
          } catch {}
        }
      };
      poll();
    });
}
