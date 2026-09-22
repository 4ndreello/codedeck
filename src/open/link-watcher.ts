import fs from "node:fs";
import { SESSION_ID_PATTERN } from "./runtime.js";

export function startLinkWatcher(opts: {
  sessionFile: string;
  runId: string;
  link: (runId: string, nativeId: string) => Promise<unknown>;
  intervalMs?: number;
}): { flush(): Promise<void>; stop(): void } {
  const sent = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  const send = (nativeId: string): Promise<void> => {
    if (sent.has(nativeId)) return Promise.resolve();
    const existing = inFlight.get(nativeId);
    if (existing) return existing;

    const pending = Promise.resolve()
      .then(() => opts.link(opts.runId, nativeId))
      .then(() => {
        sent.add(nativeId);
      })
      .catch(() => {})
      .finally(() => {
        inFlight.delete(nativeId);
      });
    inFlight.set(nativeId, pending);
    return pending;
  };

  const flush = async (): Promise<void> => {
    let contents: string;
    try {
      contents = fs.readFileSync(opts.sessionFile, "utf8");
    } catch {
      return;
    }
    const nativeIds = [...new Set(contents.split(/\r?\n/).filter((id) => SESSION_ID_PATTERN.test(id)))];
    await Promise.all(nativeIds.map(send));
  };

  const timer = setInterval(() => {
    void flush();
  }, opts.intervalMs ?? 1000);
  timer.unref();

  return {
    flush,
    stop: () => clearInterval(timer),
  };
}
