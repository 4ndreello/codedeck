import http from "node:http";
import { spawn } from "node:child_process";
import { InvalidArgumentError, type Command } from "commander";
import { REVIEW_PAGE } from "../../web/review-page.js";
import { getLocalReview } from "../../git/review.js";

export const DEFAULT_REVIEW_PORT = 3100;

export function parseReviewPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_REVIEW_PORT;
  if (!/^\d+$/.test(raw)) {
    throw new InvalidArgumentError("--port must be a positive integer");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new InvalidArgumentError("--port must be a positive integer");
  }
  return port;
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

export interface ReviewDeps {
  /** Repo root for /api/review. Defaults to process.cwd() at request time. */
  root?: string;
  loadReview?: (root: string, ref: string, file?: string) => Promise<unknown>;
}

function sendJson(res: http.ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

export function createReviewHandler(reviewDeps?: ReviewDeps): http.RequestListener {
  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/review")) {
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
        sendJson(res, 404, { error: "not found" });
      } catch (error) {
        try {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        } catch {
          try {
            res.end();
          } catch {
            // The socket is already unusable.
          }
        }
      }
    })();
  };
}

export interface ReviewCommandOptions {
  port?: string;
  open?: boolean;
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Open a local review of the current git changes")
    .option("--port <n>", "port to listen on (default: 3100)", String(DEFAULT_REVIEW_PORT))
    .option("--no-open", "serve the review without opening a browser")
    .action(async (opts: ReviewCommandOptions) => {
      let port: number;
      try {
        port = parseReviewPort(opts.port);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }

      const server = http.createServer(createReviewHandler());
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => resolve());
        });
      } catch (error) {
        console.error(`Failed to listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }

      const url = `http://127.0.0.1:${port}/`;
      console.log(`CodeDeck review on ${url}`);
      if (opts.open !== false && !openBrowser(url)) {
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
