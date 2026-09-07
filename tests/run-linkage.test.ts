import { describe, expect, it, vi } from "vitest";

import * as runtime from "../src/open/runtime.js";
import { setupOpenHarness } from "./helpers/open-harness.js";

const { runOpen } = setupOpenHarness({ prefix: "codedeck-run-linkage-", runId: "stale-parent-value" });

describe("open run linkage", () => {
  it("gives each opened process a fresh UUID and passes it to the harness", async () => {
    await runOpen(["reviewer", "--no-theme"]);
    await runOpen(["reviewer", "--no-theme"]);

    const runIds = vi.mocked(runtime.spawnHarness).mock.calls.map(([, , options]) => {
      return (options.envExtra as Record<string, string>).CODEDECK_RUN_ID;
    });

    expect(runIds).toHaveLength(2);
    expect(runIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(runIds[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(runIds[0]).not.toBe(runIds[1]);
    expect(runIds[0]).not.toBe("stale-parent-value");
    expect(runIds[1]).not.toBe("stale-parent-value");
  });
});
