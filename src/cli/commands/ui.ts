import type { Command } from "commander";
import { createReviewRoutes } from "./review.js";
import { fetchUsageQuery } from "./usage.js";
import { renderHomePage } from "../../web/home-page.js";
import { createSetupRoutes, type SetupRoutesDependencies } from "../../web/setup-routes.js";
import { parseOptionalWebPort, type WebRoute } from "../../web/server.js";
import { createUsageRoutes, type UsageRoutesOptions } from "../../web/usage-routes.js";
import type { WebPageLink } from "../../web/brand.js";
import { launchWebPage } from "../web-launch.js";

export interface UiCommandOptions {
  port?: string;
  open?: boolean;
}

export interface UiRoutesDependencies {
  setup?: SetupRoutesDependencies;
  usage?: UsageRoutesOptions;
}

export interface UiCommandDependencies {
  launch?: typeof launchWebPage;
}

export function createUiRoutes(dependencies: UiRoutesDependencies = {}): WebRoute[] {
  const reviewRoutes = createReviewRoutes().filter((route) => route.path !== "/");
  const pages: WebPageLink[] = [];
  const setupRoutes = createSetupRoutes({ ...dependencies.setup, pages });
  const routes = [...reviewRoutes, ...setupRoutes];
  const usageOptions = dependencies.usage ?? { fetchUsageQuery };
  const labeledUsageRoutes = createUsageRoutes(usageOptions).map((route) =>
    route.path === "/usage" ? { ...route, label: "Usage" } : route,
  );
  pages.push(
    { label: "Home", path: "/" },
    ...[...routes, ...labeledUsageRoutes].flatMap((route) =>
      route.kind === "page" && route.label ? [{ label: route.label, path: route.path }] : [],
    ),
  );
  const usageRoutes = createUsageRoutes({ ...usageOptions, pages }).map((route) =>
    route.path === "/usage" ? { ...route, label: "Usage" } : route,
  );
  const home: WebRoute = {
    path: "/",
    kind: "page",
    handler: (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderHomePage(pages.filter((page) => page.path !== "/")));
    },
  };
  return [home, ...routes, ...usageRoutes];
}

export function registerUiCommand(program: Command, dependencies: UiCommandDependencies = {}): void {
  program
    .command("ui")
    .description("Open the local CodeDeck console")
    .option("--port <n>", "port for a new console (default: web.port from config, else 7777)")
    .option("--no-open", "print the console URL without opening a browser")
    .action(async (opts: UiCommandOptions) => {
      let port: number | undefined;
      try {
        port = parseOptionalWebPort(opts.port);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }

      const code = await (dependencies.launch ?? launchWebPage)({ path: "/", title: "CodeDeck UI", port, open: opts.open !== false });
      if (code !== 0) process.exitCode = code;
    });
}
