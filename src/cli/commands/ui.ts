import type { Command } from "commander";
import { createReviewRoutes } from "./review.js";
import { renderHomePage } from "../../web/home-page.js";
import { DEFAULT_WEB_PORT, parseWebPort, startWebServer, type WebRoute } from "../../web/server.js";

export interface UiCommandOptions {
  port?: string;
  open?: boolean;
}

export interface UiCommandDependencies {
  startServer?: typeof startWebServer;
}

export function createUiRoutes(): WebRoute[] {
  const reviewRoutes = createReviewRoutes();
  const pages = reviewRoutes.flatMap((route) =>
    route.kind === "page" && route.label ? [{ label: route.label, path: route.path }] : [],
  );
  const reviewRouteTable = reviewRoutes.filter((route) => route.path !== "/");
  const home: WebRoute = {
    path: "/",
    kind: "page",
    handler: (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderHomePage(pages));
    },
  };
  return [home, ...reviewRouteTable];
}

export function registerUiCommand(program: Command, dependencies: UiCommandDependencies = {}): void {
  program
    .command("ui")
    .description("Open the local CodeDeck console")
    .option("--port <n>", "port to listen on (default: 3100)", String(DEFAULT_WEB_PORT))
    .option("--no-open", "serve the console without opening a browser")
    .action(async (opts: UiCommandOptions) => {
      let port: number;
      try {
        port = parseWebPort(opts.port);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }

      try {
        await (dependencies.startServer ?? startWebServer)({
          routes: createUiRoutes(),
          port,
          initialPath: "/",
          title: "CodeDeck UI",
          open: opts.open,
        });
      } catch (error) {
        console.error(`Failed to listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}
