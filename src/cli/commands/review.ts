import http from "node:http";
import type { Command } from "commander";
import { REVIEW_PAGE } from "../../web/review-page.js";
import { getLocalReview } from "../../git/review.js";
import { DEFAULT_WEB_PORT, openBrowser, parseWebPort, startWebServer, type WebRoute } from "../../web/server.js";

export const DEFAULT_REVIEW_PORT = DEFAULT_WEB_PORT;

export function parseReviewPort(raw: string | undefined): number {
  return parseWebPort(raw);
}

export { openBrowser };

export interface ReviewDeps {
  /** Repo root for /api/review. Defaults to process.cwd() at request time. */
  root?: string;
  loadReview?: (root: string, ref: string, file?: string) => Promise<unknown>;
}

export interface ReviewCommandDependencies extends ReviewDeps {
  startServer?: typeof startWebServer;
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

export function createReviewRoutes(reviewDeps?: ReviewDeps): WebRoute[] {
  const handler = createReviewHandler(reviewDeps);
  return [
    { path: "/", handler, kind: "page" },
    { path: "/review", handler, kind: "page", label: "Review" },
    { path: "/api/review", handler, kind: "api" },
  ];
}

export function registerReviewCommand(program: Command, dependencies: ReviewCommandDependencies = {}): void {
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

      try {
        await (dependencies.startServer ?? startWebServer)({
          routes: createReviewRoutes(dependencies),
          port,
          initialPath: "/",
          title: "CodeDeck review",
          open: opts.open,
        });
      } catch (error) {
        console.error(`Failed to listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
