import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createUiRoutes } from "../cli/commands/ui.js";
import { DEFAULT_WEB_HOST } from "../config/web-host.js";
import { computeBuildId, distRootFor } from "../daemon/build-id.js";
import { DEFAULT_WEB_PORT, listenWebServer, type WebRoute } from "./server.js";
import { resolveWebToken } from "./web-token.js";

export interface RunWebChildOptions {
  host?: string;
  /** Explicit port (`--port`): no fallback. */
  port?: number;
  /** Preferred port (`--preferred-port`): an OS-assigned port on any listen error. Defaults to 7777. */
  preferredPort?: number;
  /** Seam for the shared console token; defaults to `~/.run-agent/web-token`. */
  resolveToken?: () => string;
  stdin: Readable;
  stdout: Writable;
  listen?: typeof listenWebServer;
  routes?: () => WebRoute[];
  build?: string;
  /** Tree the build identity is computed from; defaults to this module's dist root. */
  distRoot?: string;
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
  const build = options.build ?? computeBuildId(options.distRoot ?? distRootFor(import.meta.url));
  // The daemon may close the pipe after the handshake; a failed write must not crash the child.
  options.stdout.on("error", () => {});
  const port = options.port ?? options.preferredPort ?? DEFAULT_WEB_PORT;

  let listening: Awaited<ReturnType<typeof listenWebServer>>;
  try {
    listening = await (options.listen ?? listenWebServer)({
      routes: (options.routes ?? (() => createUiRoutes()))(),
      host: options.host ?? DEFAULT_WEB_HOST,
      port,
      fallbackToEphemeral: options.port === undefined,
      token: (options.resolveToken ?? resolveWebToken)(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = JSON.stringify({ error: { message, port } });
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

/** `--port <n>` is explicit; `--preferred-port <n>` may fall back; the host defaults to loopback. */
export function parseWebChildArgs(argv: readonly string[]): { host: string; port?: number; preferredPort?: number } {
  const numberValueOf = (flag: string): number | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? Number(argv[index + 1]) : undefined;
  };
  const hostIndex = argv.indexOf("--host");
  const host = hostIndex >= 0 ? argv[hostIndex + 1] : undefined;
  const port = numberValueOf("--port");
  const preferredPort = numberValueOf("--preferred-port");
  return {
    host: host ?? DEFAULT_WEB_HOST,
    ...(port === undefined ? {} : { port }),
    ...(preferredPort === undefined ? {} : { preferredPort }),
  };
}

if (process.argv.includes("--web-child")) {
  void runWebChild({ ...parseWebChildArgs(process.argv), stdin: process.stdin, stdout: process.stdout });
}
