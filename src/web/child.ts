import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createUiRoutes } from "../cli/commands/ui.js";
import { computeBuildId, distRootFor } from "../daemon/build-id.js";
import { DEFAULT_WEB_PORT, listenWebServer, type WebRoute } from "./server.js";

export interface RunWebChildOptions {
  /** Explicit port; when omitted the child tries the default port and falls back to an ephemeral one. */
  port?: number;
  stdin: Readable;
  stdout: Writable;
  listen?: typeof listenWebServer;
  routes?: () => WebRoute[];
  build?: string;
  exit?: (code: number) => void;
  signalTarget?: EventEmitter;
}

/**
 * Serve the console routes for the daemon. The first stdout line is the
 * handshake: `{ port, token, build }` or `{ error: { message, port } }`.
 * The child exits when its stdin ends (the daemon went away) or on SIGTERM.
 */
export async function runWebChild(options: RunWebChildOptions): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const build = options.build ?? computeBuildId(distRootFor(import.meta.url));
  // The daemon may close the pipe after the handshake; a failed write must not crash the child.
  options.stdout.on("error", () => {});

  let listening: Awaited<ReturnType<typeof listenWebServer>>;
  try {
    listening = await (options.listen ?? listenWebServer)({
      routes: (options.routes ?? (() => createUiRoutes()))(),
      port: options.port,
      fallbackToEphemeral: options.port === undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = JSON.stringify({ error: { message, port: options.port ?? DEFAULT_WEB_PORT } });
    options.stdout.write(`${line}\n`, () => exit(1));
    return;
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void listening.close();
    listening.server.closeAllConnections();
    exit(0);
  };
  options.stdin.once("end", stop);
  options.stdin.once("close", stop);
  options.stdin.resume();
  (options.signalTarget ?? process).once("SIGTERM", stop);

  options.stdout.write(`${JSON.stringify({ port: listening.port, token: listening.security.token, build })}\n`);
}

if (process.argv.includes("--web-child")) {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : undefined;
  void runWebChild({ port, stdin: process.stdin, stdout: process.stdout });
}
