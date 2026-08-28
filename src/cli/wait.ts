import type { AgentEvent } from "../core/events.js";
import { isTerminalEvent } from "../core/events.js";
import { isTerminalStatus, type Session } from "../core/session.js";

export interface SessionWaitClient {
  getSession: (sessionId: string) => Promise<Session>;
  subscribe: (
    sessionId: string,
    onEvent: (event: AgentEvent) => void,
    onDone?: () => void,
    onError?: (error: Error) => void,
  ) => () => void;
}

export interface WaitOptions {
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function waitForSession(
  client: SessionWaitClient,
  sessionId: string,
  options: WaitOptions = {},
): Promise<Session> {
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));

  let session = await client.getSession(sessionId);
  while (!isTerminalStatus(session.status)) {
    await new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const wake = () => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        resolve();
      };

      try {
        unsubscribe = client.subscribe(
          sessionId,
          (event) => {
            if (isTerminalEvent(event)) wake();
          },
          wake,
          wake,
        );
        if (settled) unsubscribe();
      } catch {
        wake();
      }
    });

    try {
      session = await client.getSession(sessionId);
    } catch {
      await sleep(retryDelayMs);
      continue;
    }
    if (!isTerminalStatus(session.status)) await sleep(retryDelayMs);
  }

  return session;
}
