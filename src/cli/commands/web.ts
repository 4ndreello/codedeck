import http from "node:http";
import { spawn } from "node:child_process";
import { InvalidArgumentError, type Command } from "commander";
import { IpcClient } from "../../daemon/ipc.js";
import { CANVAS_PAGE } from "../../web/canvas-page.js";
import { REVIEW_PAGE } from "../../web/review-page.js";
import { getLocalReview } from "../../git/review.js";

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

export type SessionSubpathAction = "stream" | "logs" | "get" | "send" | "release";

export interface SessionSubpath {
  action: SessionSubpathAction;
  id: string;
}

/**
 * Pure route split for /api/sessions/:id[/stream|/logs|/get|/send|/release].
 * More specific routes must be tried before this one so "stream" never lands
 * in :id handling. "send"/"release" are the only POST routes; the method
 * check lives at the callsite, so a GET to either parses here and then falls
 * through to 404.
 */
export function parseSessionSubpath(parts: string[]): SessionSubpath | null {
  if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "sessions" || !parts[2]) {
    return null;
  }
  const id = decodeURIComponent(parts[2]);
  if (parts.length === 3) return { action: "get", id };
  if (parts.length === 4 && parts[3] === "stream") return { action: "stream", id };
  if (parts.length === 4 && parts[3] === "logs") return { action: "logs", id };
  if (parts.length === 4 && parts[3] === "send") return { action: "send", id };
  if (parts.length === 4 && parts[3] === "release") return { action: "release", id };
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

// POST /api/sessions/:id/send body cap. A turn prompt larger than this is
// almost always a mistake; the drain (no req.destroy) keeps the socket clean.
export const MAX_SEND_BODY_BYTES = 64 * 1024;

/** Validates the parsed /send body: returns the trimmed message or null. */
export function parseSendBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("message" in body)) return null;
  const message: unknown = body.message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed === "" ? null : trimmed;
}

function sendErrorStatus(code: string | undefined): number {
  if (code === "SESSION_NOT_FOUND") return 404;
  if (code === "SESSION_BUSY") return 409;
  if (code === "CAPABILITY_NOT_SUPPORTED") return 400;
  if (code === "INVALID") return 400;
  return 502;
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
export interface WebReviewDeps {
  /** Repo root for /api/review. Defaults to process.cwd() at request time. */
  root?: string;
  loadReview?: (root: string, ref: string, file?: string) => Promise<unknown>;
}

export function createWebHandler(bridge: WebBridge, reviewDeps?: WebReviewDeps): http.RequestListener {
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
        if (req.method === "GET" && url.pathname === "/review") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(REVIEW_PAGE);
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/review") {
          const ref = url.searchParams.get("ref") || "HEAD";
          const file = url.searchParams.get("file") || undefined;
          const root = reviewDeps?.root ?? process.cwd();
          try {
            const load = reviewDeps?.loadReview ?? ((r: string, q: string, f?: string) => getLocalReview(r, { ref: q, file: f }));
            sendJson(res, 200, await load(root, ref, file));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, message.includes("not a git repository") ? 404 : 500, { error: message });
          }
          return;
        }

        const sub = parseSessionSubpath(parts);
        if (req.method === "POST" && sub?.action === "send") {
          // Body cap: stop buffering past the limit but keep draining so the
          // socket closes cleanly; a loopback client has nothing to gain.
          const raw = await new Promise<string | null>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            req.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size <= MAX_SEND_BODY_BYTES) chunks.push(chunk);
            });
            req.on("end", () => resolve(size > MAX_SEND_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
            req.on("error", reject);
          });
          if (raw === null) {
            sendJson(res, 413, { error: "message body too large" });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "invalid JSON body" });
            return;
          }
          const message = parseSendBody(parsed);
          if (message === null) {
            sendJson(res, 400, { error: "message required" });
            return;
          }
          try {
            const result = await bridge.request("session.send", { id: sub.id, message });
            sendJson(res, 200, result);
          } catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
            sendJson(res, sendErrorStatus(code), { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && sub?.action === "release") {
          try {
            const result = await bridge.request("session.release", { id: sub.id });
            sendJson(res, 200, result);
          } catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
            sendJson(res, sendErrorStatus(code), { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "GET" && sub?.action === "stream") {
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
        if (req.method === "GET" && sub?.action === "logs") {
          sendJson(res, 200, await bridge.request("session.logs", { id: sub.id }));
          return;
        }
        if (req.method === "GET" && sub?.action === "get") {
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
