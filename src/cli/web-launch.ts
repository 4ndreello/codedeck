import { fileURLToPath } from "node:url";
import { IpcClient } from "../daemon/ipc.js";
import { computeBuildId, distRootFor } from "../daemon/build-id.js";
import type { WebEnsureParams, WebEnsureResult } from "../daemon/protocol.js";
import { DEFAULT_WEB_PORT, openBrowser, startWebServer } from "../web/server.js";
import { createUiRoutes } from "./commands/ui.js";

export interface LaunchWebPageOptions {
  path: string;
  query?: Record<string, string>;
  title: string;
  /** Explicit `--port`; omitted means the daemon picks 3100 or an ephemeral port. */
  port?: number;
  open: boolean;
}

export interface LaunchWebPageDependencies {
  client?: Pick<IpcClient, "ensureDaemonStarted" | "request">;
  openBrowser?: (url: string) => boolean | Promise<boolean>;
  log?: (message: string) => void;
  error?: (message: string) => void;
  startServer?: typeof startWebServer;
  build?: string;
  entry?: string;
}

/**
 * Open a console page served by the daemon's web child and return the exit code.
 * When the daemon cannot host it, serve the pages from this process instead.
 */
export async function launchWebPage(options: LaunchWebPageOptions, deps: LaunchWebPageDependencies = {}): Promise<number> {
  const client = deps.client ?? new IpcClient();
  const log = deps.log ?? ((message: string) => console.log(message));
  const error = deps.error ?? ((message: string) => console.error(message));

  try {
    await client.ensureDaemonStarted();
  } catch {
    error("CodeDeck daemon is unavailable; serving from this process.");
    return serveInProcess(options, deps, error);
  }

  const params: WebEnsureParams = {
    ...(options.port === undefined ? {} : { port: options.port }),
    build: deps.build ?? computeBuildId(distRootFor(import.meta.url)),
    entry: deps.entry ?? fileURLToPath(new URL("../web/child.js", import.meta.url)),
  };
  let web: WebEnsureResult;
  try {
    web = await client.request<WebEnsureResult>("web.ensure", params);
  } catch (failure) {
    const { code, message, details } = failure as Error & { code?: string; details?: { port?: number } };
    if (code === "WEB_LISTEN_FAILED") {
      error(`Failed to listen on 127.0.0.1:${details?.port ?? options.port ?? DEFAULT_WEB_PORT}: ${message}`);
      return 1;
    }
    error(`CodeDeck daemon cannot host the web console (${code ?? "UNKNOWN"}); serving from this process.`);
    return serveInProcess(options, deps, error);
  }

  if (options.port !== undefined && web.port !== options.port) {
    log(`CodeDeck web is already running on port ${web.port}`);
  }
  const url = new URL(options.path, web.baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  url.searchParams.set("t", web.token);
  const pageUrl = url.toString();

  if (options.open && !(await (deps.openBrowser ?? openBrowser)(pageUrl))) {
    log(`Could not open a browser, visit ${pageUrl} manually.`);
  } else {
    log(`${options.title} on ${pageUrl}`);
  }
  return 0;
}

async function serveInProcess(
  options: LaunchWebPageOptions,
  deps: LaunchWebPageDependencies,
  error: (message: string) => void,
): Promise<number> {
  const query = new URLSearchParams(options.query ?? {}).toString();
  const port = options.port ?? DEFAULT_WEB_PORT;
  try {
    await (deps.startServer ?? startWebServer)({
      routes: createUiRoutes(),
      port,
      fallbackToEphemeral: options.port === undefined,
      initialPath: query ? `${options.path}?${query}` : options.path,
      title: options.title,
      open: options.open,
      openBrowser: deps.openBrowser,
      log: deps.log,
    });
  } catch (failure) {
    error(`Failed to listen on 127.0.0.1:${port}: ${failure instanceof Error ? failure.message : String(failure)}`);
    return 1;
  }
  // The server keeps this process alive until SIGINT or SIGTERM.
  return 0;
}
