import os from "node:os";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { IpcClient } from "../daemon/ipc.js";
import { computeBuildId, distRootFor } from "../daemon/build-id.js";
import type { WebEnsureParams, WebEnsureResult } from "../daemon/protocol.js";
import { loadConfig } from "../config/config.js";
import { invalidWebHostMessage, resolveWebHost } from "../config/web-host.js";
import { invalidWebPortMessage, resolveWebPort } from "../config/web-port.js";
import { openBrowser, startWebServer } from "../web/server.js";
import { resolveWebToken } from "../web/web-token.js";
import { createUiRoutes } from "./commands/ui.js";

export interface LaunchWebPageOptions {
  path: string;
  query?: Record<string, string>;
  title: string;
  /** Explicit `--port`; omitted means the preferred port (`web.port`, else 7777) or an ephemeral one. */
  port?: number;
  /** Explicit `ui --host`; omitted means the resolved `web.host` or loopback. */
  host?: string;
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
  loadConfig?: () => { web?: unknown };
  networkInterfaces?: typeof os.networkInterfaces;
  resolveToken?: () => string;
}

/**
 * Open a console page served by the daemon's web child and return the exit code.
 * When the daemon cannot host it, serve the pages from this process instead.
 */
export async function launchWebPage(options: LaunchWebPageOptions, deps: LaunchWebPageDependencies = {}): Promise<number> {
  const client = deps.client ?? new IpcClient();
  const log = deps.log ?? ((message: string) => console.log(message));
  const error = deps.error ?? ((message: string) => console.error(message));
  const config = (deps.loadConfig ?? loadConfig)();
  const { port: preferredPort, invalid } = resolveWebPort(config);
  const { host: configuredHost, invalid: invalidHost } = resolveWebHost(config);
  if (invalid !== undefined) error(invalidWebPortMessage(invalid));
  if (invalidHost !== undefined) error(invalidWebHostMessage(invalidHost));
  const host = options.host ?? configuredHost;
  const askedPort = options.port ?? preferredPort;

  try {
    await client.ensureDaemonStarted();
  } catch {
    error("CodeDeck daemon is unavailable; serving from this process.");
    return serveInProcess(options, host, askedPort, deps, error);
  }

  const params: WebEnsureParams = {
    ...(options.host === undefined ? { preferredHost: configuredHost } : { host: options.host }),
    ...(options.port === undefined ? { preferredPort } : { port: options.port }),
    build: deps.build ?? computeBuildId(distRootFor(import.meta.url)),
    entry: deps.entry ?? fileURLToPath(new URL("../web/child.js", import.meta.url)),
  };
  let web: WebEnsureResult;
  try {
    web = await client.request<WebEnsureResult>("web.ensure", params);
  } catch (failure) {
    const { code, message, details } = failure as Error & { code?: string; details?: { port?: number } };
    if (code === "WEB_LISTEN_FAILED") {
      error(listenFailureMessage(host, details?.port ?? askedPort, message));
      return 1;
    }
    error(`CodeDeck daemon cannot host the web console (${code ?? "UNKNOWN"}); serving from this process.`);
    return serveInProcess(options, host, askedPort, deps, error);
  }

  warnForPlainHttp(host, web.port, error);
  if (web.port !== askedPort) log(`CodeDeck web is running on port ${web.port} instead of ${askedPort}`);
  const url = new URL(options.path, web.baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  url.searchParams.set("t", web.token);
  const pageUrl = url.toString();

  if (options.open && !(await (deps.openBrowser ?? openBrowser)(pageUrl))) {
    log(`Could not open a browser, visit ${pageUrl} manually.`);
  } else {
    log(`${options.title} on ${pageUrl}`);
  }
  printAlternateLinks(host, web.port, options, web.token, deps.networkInterfaces ?? os.networkInterfaces, log);
  return 0;
}

async function serveInProcess(
  options: LaunchWebPageOptions,
  host: string,
  port: number,
  deps: LaunchWebPageDependencies,
  error: (message: string) => void,
): Promise<number> {
  const query = new URLSearchParams(options.query ?? {}).toString();
  const log = deps.log ?? ((message: string) => console.log(message));
  try {
    const listening = await (deps.startServer ?? startWebServer)({
      routes: createUiRoutes(),
      host,
      port,
      fallbackToEphemeral: options.port === undefined,
      // The same token as the daemon's web child, so neither server's cookie locks out the other.
      token: (deps.resolveToken ?? resolveWebToken)(),
      initialPath: query ? `${options.path}?${query}` : options.path,
      title: options.title,
      open: options.open,
      openBrowser: deps.openBrowser,
      log,
    });
    warnForPlainHttp(host, listening.port, error);
    printAlternateLinks(host, listening.port, options, listening.security.token, deps.networkInterfaces ?? os.networkInterfaces, log);
  } catch (failure) {
    error(listenFailureMessage(host, port, failure instanceof Error ? failure.message : String(failure)));
    return 1;
  }
  // The server keeps this process alive until SIGINT or SIGTERM.
  return 0;
}

function listenFailureMessage(host: string, port: number, message: string): string {
  const displayedHost = isIP(host) === 6 ? `[${host}]` : host;
  return `Failed to listen on ${displayedHost}:${port}: ${message}`;
}

function warnForPlainHttp(host: string, port: number, error: (message: string) => void): void {
  const ipVersion = isIP(host);
  const loopback = ipVersion === 4
    ? host.startsWith("127.")
    : ipVersion === 6 && new URL(`http://[${host}]/`).hostname.toLowerCase() === "[::1]";
  if (loopback) return;
  error(`Warning: the console listens on ${host} over plain HTTP. Anyone who can reach port ${port} with the link gets full access; use it only on a trusted network such as Tailscale.`);
}

function printAlternateLinks(
  host: string,
  port: number,
  options: LaunchWebPageOptions,
  token: string,
  networkInterfaces: typeof os.networkInterfaces,
  log: (message: string) => void,
): void {
  if (host !== "0.0.0.0" && host !== "::") return;
  for (const info of Object.values(networkInterfaces()).flatMap((addresses) => addresses ?? [])) {
    if (info.family !== "IPv4" || info.internal) continue;
    const url = new URL(options.path, `http://${info.address}:${port}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    url.searchParams.set("t", token);
    log(`Also on ${url.toString()}`);
  }
}
