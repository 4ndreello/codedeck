import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // See tests/helpers/node-sqlite-shim.ts — Vite cannot resolve node:sqlite
      // on its own because "sqlite" is absent from module.builtinModules.
      "node:sqlite": path.join(here, "tests/helpers/node-sqlite-shim.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
