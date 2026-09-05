import type { Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";
import { exitCodeForOutcome } from "../../core/errors.js";
import type { Session } from "../../core/session.js";
import { waitForSession, type SessionWaitClient } from "../wait.js";

interface WaitCommandOptions {
  json?: boolean;
}

export function formatWaitResult(session: Session): string {
  if (session.status === "failed" || session.status === "orphaned" || session.status === "interrupted") {
    const failure = session.failure;
    const tag = failure ? ` [${failure.blame}${failure.retryable ? ", retryable" : ""}]` : "";
    const detail = failure?.detail ? `: ${String(failure.detail).slice(0, 200)}` : "";
    return `✗ Session ${session.id} ${session.status}${tag}${detail}`;
  }
  return `✓ Session ${session.id} ${session.status}`;
}

export function registerWaitCommand(program: Command): void {
  program
    .command("wait")
    .description("Wait for a session to reach a terminal state")
    .argument("<id>", "session id (prefix allowed, e.g. a83f)")
    .option("--json", "output the final session as JSON")
    .addHelpText("after", `
Examples:
  $ npx codedeck wait a83f
  $ npx codedeck wait a83f --json
`)
    .action(async (id: string, opts: WaitCommandOptions) => {
      const client = new IpcClient();
      try {
        await client.ensureDaemonStarted();
      } catch (error) {
        console.error(`Failed to start daemon: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 3;
        return;
      }

      const waitClient: SessionWaitClient = {
        getSession: async (sessionId) => {
          const result = await client.request<{ session: Session }>("session.get", { id: sessionId });
          return result.session;
        },
        subscribe: (sessionId, onEvent, onDone, onError) =>
          client.subscribe(sessionId, onEvent, onDone, onError),
      };

      let session: Session;
      try {
        session = await waitForSession(waitClient, id);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 3;
        return;
      }

      if (opts.json) console.log(JSON.stringify(session));
      else console.log(formatWaitResult(session));
      process.exitCode = exitCodeForOutcome(session);
    });
}
