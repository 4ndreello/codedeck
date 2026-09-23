import type { Command } from "commander";
import { createReviewRoutes } from "./review.js";
import { fetchUsageQuery } from "./usage.js";
import { renderHomePage } from "../../web/home-page.js";
import { createSetupRoutes, type SetupRoutesDependencies } from "../../web/setup-routes.js";
import { DEFAULT_WEB_PORT, parseWebPort, startWebServer, type WebRoute } from "../../web/server.js";
import { createUsageRoutes, type UsageRoutesOptions } from "../../web/usage-routes.js";

export interface UiCommandOptions {
  port?: string;
  open?: boolean;
}

export interface UiCommandDependencies {
  startServer?: typeof startWebServer;
  setup?: SetupRoutesDependencies;
  usage?: UsageRoutesOptions;
}

export function createUiRoutes(dependencies: Pick<UiCommandDependencies, "setup" | "usage"> = {}): WebRoute[] {
  const reviewRoutes = createReviewRoutes().filter((route) => route.path !== "/");
  const setupRoutes = createSetupRoutes(dependencies.setup);
  const usageOptions = dependencies.usage ?? { fetchUsageQuery };
  const labeledUsageRoutes = createUsageRoutes(usageOptions).map((route) =>
    route.path === "/usage" ? { ...route, label: "Usage" } : route,
  );
  const routes = [...reviewRoutes, ...setupRoutes];
  const pages = [...routes, ...labeledUsageRoutes].flatMap((route) =>
    route.kind === "page" && route.label ? [{ label: route.label, path: route.path }] : [],
  );
  const usageRoutes = createUsageRoutes({ ...usageOptions, pages }).map((route) =>
    route.path === "/usage" ? { ...route, label: "Usage" } : route,
  );
  const home: WebRoute = {
    path: "/",
    kind: "page",
    handler: (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderHomePage(pages));
    },
  };
  return [home, ...routes, ...usageRoutes];
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
          routes: createUiRoutes(dependencies),
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
