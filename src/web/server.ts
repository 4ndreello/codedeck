import http, { type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { InvalidArgumentError } from "commander";
import { checkWebRequest, createWebSecurity, getTokenUrl, type WebSecurity } from "./security.js";

export const DEFAULT_WEB_PORT = 3100;

export interface WebRoute {
  path: string;
  handler: RequestListener;
  kind: "page" | "api";
  label?: string;
}

export interface WebServerOptions {
  routes: readonly WebRoute[];
  port?: number;
  initialPath: string;
  title?: string;
  open?: boolean;
  openBrowser?: (url: string) => boolean | Promise<boolean>;
  log?: (message: string) => void;
  serverFactory?: (handler: RequestListener) => Server;
  fallbackToEphemeral?: boolean;
  signalTarget?: EventEmitter;
  closeServer?: () => Promise<void> | void;
  exit?: (code: number) => void;
}

export interface CreateWebServerOptions {
  routes: readonly WebRoute[];
  getSecurity: () => WebSecurity | undefined;
  serverFactory?: (handler: RequestListener) => Server;
}

export interface ListenWebServerOptions {
  routes: readonly WebRoute[];
  port?: number;
  fallbackToEphemeral?: boolean;
  serverFactory?: (handler: RequestListener) => Server;
}

export interface ListeningWebServer {
  server: Server;
  address: AddressInfo;
  port: number;
  baseUrl: string;
  security: WebSecurity;
  close(): Promise<void>;
}

export interface WebServerHandle {
  server: Server;
  address: AddressInfo;
  port: number;
  baseUrl: string;
  initialUrl: string;
  security: WebSecurity;
  close(): Promise<void>;
}

export function parseWebPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WEB_PORT;
  if (!/^\d+$/.test(raw)) throw new InvalidArgumentError("--port must be a positive integer");
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new InvalidArgumentError("--port must be a positive integer");
  }
  return port;
}

/** Like `parseWebPort`, but an omitted `--port` stays undefined so the daemon picks the port. */
export function parseOptionalWebPort(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : parseWebPort(raw);
}

export function openBrowser(url: string): Promise<boolean> {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    try {
      const child = spawn(opener, args, { detached: true, stdio: "ignore" });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

export function createWebServer(options: CreateWebServerOptions): Server {
  const serverFactory = options.serverFactory ?? ((handler) => http.createServer({ requireHostHeader: false }, handler));
  return serverFactory((request, response) => {
    const security = options.getSecurity();
    if (!security) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("server starting");
      return;
    }
    dispatchRequest(options.routes, security, request, response);
  });
}

export async function listenWebServer(options: ListenWebServerOptions): Promise<ListeningWebServer> {
  let security: WebSecurity | undefined;
  const server = createWebServer({
    routes: options.routes,
    getSecurity: () => security,
    serverFactory: options.serverFactory,
  });

  const requestedPort = options.port ?? DEFAULT_WEB_PORT;
  try {
    await listen(server, requestedPort);
  } catch (error) {
    if (!options.fallbackToEphemeral || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await listen(server, 0);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Web server did not return a TCP address");
  }

  security = createWebSecurity(address.port);
  let closing: Promise<void> | undefined;
  return {
    server,
    address,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    security,
    close: () => {
      closing ??= new Promise<void>((resolve) => server.close(() => resolve()));
      return closing;
    },
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const listening = await listenWebServer({
    routes: options.routes,
    port: options.port,
    fallbackToEphemeral: options.fallbackToEphemeral,
    serverFactory: options.serverFactory,
  });
  const { server, address, security, baseUrl } = listening;
  const pageUrl = new URL(options.initialPath, baseUrl).toString();
  const initialUrl = getTokenUrl(pageUrl, security.token);
  const log = options.log ?? ((message: string) => console.log(message));

  if (options.open === false) {
    log(`${options.title ?? "CodeDeck"} on ${initialUrl}`);
  } else if (!(await (options.openBrowser ?? openBrowser)(initialUrl))) {
    log(`Could not open a browser, visit ${initialUrl} manually.`);
  } else {
    log(`${options.title ?? "CodeDeck"} on ${initialUrl}`);
  }

  const signalTarget = options.signalTarget ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let signalClose: Promise<void> | undefined;
  let shutdown = () => {};
  const close = (): Promise<void> => {
    signalTarget.off("SIGINT", shutdown);
    signalTarget.off("SIGTERM", shutdown);
    return listening.close();
  };
  shutdown = () => {
    signalTarget.off("SIGINT", shutdown);
    signalTarget.off("SIGTERM", shutdown);
    if (!signalClose) {
      signalClose = options.closeServer
        ? Promise.resolve(options.closeServer())
        : close();
      void signalClose.then(() => exit(0), () => exit(0));
    }
  };
  signalTarget.on("SIGINT", shutdown);
  signalTarget.on("SIGTERM", shutdown);

  return {
    server,
    address,
    port: address.port,
    baseUrl,
    initialUrl,
    security,
    close,
  };
}

function dispatchRequest(
  routes: readonly WebRoute[],
  security: WebSecurity,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): void {
  let pathname: string;
  try {
    pathname = new URL(request.url || "/", `http://127.0.0.1:${security.port}`).pathname;
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("bad request");
    return;
  }

  const route = routes.find((candidate) => candidate.path === pathname);
  if (!checkWebRequest(request, response, security, { htmlPage: route?.kind === "page", api: route?.kind === "api" })) return;
  if (!route) {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  try {
    const result: unknown = route.handler(request, response);
    if (isThenable(result)) result.then(undefined, (error: unknown) => failRequest(response, error));
  } catch (error) {
    failRequest(response, error);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === "function";
}

function failRequest(response: http.ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
