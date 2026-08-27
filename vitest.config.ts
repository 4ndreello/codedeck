import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    server: { deps: { inline: [/node:sqlite/] } },
    deps: { inline: [/node:sqlite/] },
  },
});
