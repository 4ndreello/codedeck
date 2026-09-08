import http from "node:http";
import { spawn } from "node:child_process";
import { InvalidArgumentError, type Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";
import { CANVAS_PAGE } from "../../web/canvas-page.js";

export const DEFAULT_WEB_PORT = 3100;

export function parseWebPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WEB_PORT;
  if (!/^\d+$/.test(raw)) {
    throw new InvalidArgumentError("--port must be a positive integer");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new InvalidArgumentError("--port must be a positive integer");
  }
  return port;
}

export type SessionSubpathAction = "stream" | "logs" | "get";

export interface SessionSubpath {
  action: SessionSubpathAction;
  id: string;
}

/**
 * Pure route split for /api/sessions/:id[/stream|/logs]. More specific routes
 * must be tried before this one so "stream" never lands in :id handling.
 */
export function parseSessionSubpath(parts: string[]): SessionSubpath | null {
  if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "sessions" || !parts[2]) {
    return null;
  }
  const id = decodeURIComponent(parts[2]);
  if (parts.length === 3) return { action: "get", id };
  if (parts.length === 4 && parts[3] === "stream") return { action: "stream", id };
  if (parts.length === 4 && parts[3] === "logs") return { action: "logs", id };
  return null;
}

export function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function sseNamed(name: string, data: unknown): string {
  return `event: ${name}\n${sseData(data)}`;
}

export function sseComment(text = "conectado"): string {
  return `: ${text}\n\n`;
}

export function openBrowser(url: string): boolean {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(opener, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface WebBridge {
  request<T>(method: string, params: unknown): Promise<T>;
  subscribe(
    sessionId: string,
    onEvent: (event: { type?: string } & Record<string, unknown>) => void,
    onDone?: () => void,
    onError?: (error: Error) => void,
  ): () => void;
}

function sendJson(res: http.ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

export function createWebHandler(bridge: WebBridge): http.RequestListener {
  return (req, res) => {
    void (async () => {
      try {
        // Loopback base: only the path and query of the incoming request are
        // read, nothing is ever fetched. (A non-loopback dummy base trips
        // the S5332 cleartext-protocol rule.)
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const parts = url.pathname.split("/").filter(Boolean);

        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(CANVAS_PAGE);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/health") {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/status") {
          sendJson(res, 200, await bridge.request("daemon.status", {}));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/sessions") {
          const all = url.searchParams.get("all") === "1";
          sendJson(res, 200, await bridge.request("session.list", { all }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/usage") {
          const period = url.searchParams.get("period") || "today";
          sendJson(res, 200, await bridge.request("usage.query", { period }));
          return;
        }

        const sub = req.method === "GET" ? parseSessionSubpath(parts) : null;
        if (sub?.action === "stream") {
          // Pre-flight before the 200: otherwise the browser holds an
          // EventSource open on pings with no visible error when the daemon
          // is down or the session does not exist.
          try {
            await bridge.request("session.get", { id: sub.id });
          } catch {
            sendJson(res, 404, { error: "session not found or daemon unavailable" });
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(sseComment());
          const keepalive = setInterval(() => {
            try {
              res.write(sseComment("ping"));
            } catch {
              // Client is gone; req close below owns the cleanup.
            }
          }, 25000);
          const off = bridge.subscribe(
            sub.id,
            (event) => {
              try {
                res.write(sseData(event));
              } catch {
                // Client is gone; req close below owns the cleanup.
              }
            },
            () => {
              try {
                res.write(sseNamed("done", {}));
              } catch {
                // Client is gone; req close below owns the cleanup.
              }
            },
            () => {
              try {
                res.write(sseNamed("error", { error: "daemon disconnected" }));
              } catch {
                // Client is gone; req close below owns the cleanup.
              }
            },
          );
          req.on("close", () => {
            clearInterval(keepalive);
            off();
          });
          return;
        }
        if (sub?.action === "logs") {
          sendJson(res, 200, await bridge.request("session.logs", { id: sub.id }));
          return;
        }
        if (sub?.action === "get") {
          sendJson(res, 200, await bridge.request("session.get", { id: sub.id }));
          return;
        }
        sendJson(res, 404, { error: "not found" });
      } catch (error) {
        // The pre-flight and stream branches answer above, so reaching here
        // means no bytes were written yet and a JSON error is still safe.
        try {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        } catch {
          try {
            res.end();
          } catch {
            // Last resort: the socket is already unusable.
          }
        }
      }
    })();
  };
}

export interface WebCommandOptions {
  port?: string;
  open?: boolean;
}

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Serve the realtime runs canvas in the browser (localhost only, no auth)")
    .option("--port <n>", "port to listen on (default: 3100)", String(DEFAULT_WEB_PORT))
    .option("--open", "open the canvas in the default browser")
    .action(async (opts: WebCommandOptions) => {
      let port: number;
      try {
        port = parseWebPort(opts.port);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
        throw error;
      }

      const client = new IpcClient();
      try {
        await client.ensureDaemonStarted();
      } catch {
        // The bridge answers with JSON errors when the daemon is down, so a
        // cold start failing here must not take the page down with it.
      }

      const server = http.createServer(createWebHandler(client));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      }).catch((error: unknown) => {
        console.error(`Failed to listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });

      const url = `http://127.0.0.1:${port}/`;
      console.log(`CodeDeck web on ${url}`);
      if (opts.open && !openBrowser(url)) {
        console.log(`Could not open a browser, visit ${url} manually.`);
      }

      const shutdown = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref?.();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
