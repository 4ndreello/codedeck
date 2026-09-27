import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { IpcClient } from "../src/daemon/ipc.js";
import * as claudeLauncher from "../src/open/launchers/claude.js";
import * as runtime from "../src/open/runtime.js";
import { setupOpenHarness } from "./helpers/open-harness.js";

const { runOpen } = setupOpenHarness({ prefix: "codedeck-run-linkage-", runId: "stale-parent-value" });

describe("open run linkage", () => {
  it("gives each opened process a fresh 4-hex session ID and passes it to the harness", async () => {
    await runOpen(["reviewer", "--no-theme"]);
    await runOpen(["reviewer", "--no-theme"]);

    const runIds = vi.mocked(runtime.spawnHarness).mock.calls.map(([, , options]) => {
      return (options.envExtra as Record<string, string>).CODEDECK_RUN_ID;
    });

    expect(runIds).toHaveLength(2);
    expect(runIds[0]).toMatch(/^[0-9a-f]{4}$/);
    expect(runIds[1]).toMatch(/^[0-9a-f]{4}$/);
    expect(runIds[0]).not.toBe(runIds[1]);
    expect(runIds[0]).not.toBe("stale-parent-value");
    expect(runIds[1]).not.toBe("stale-parent-value");
  });

  it("passes the adopted session ID to the Claude process", async () => {
    const configDir = process.env.RUN_AGENT_CONFIG_DIR;
    if (!configDir) throw new Error("test config directory is missing");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ agents: { reviewer: { harness: "claude", model: "prov/m", effort: "low" } } }),
    );
    vi.spyOn(claudeLauncher, "preflightModel").mockResolvedValue(undefined);
    vi.spyOn(claudeLauncher, "resolveBinary").mockResolvedValue("/bin/claude");
    vi.spyOn(claudeLauncher, "assertSupport").mockResolvedValue(undefined);

    await runOpen(["reviewer", "--no-theme"]);

    const spawnCall = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(spawnCall?.[0]).toBe("/bin/claude");
    const runId = (spawnCall?.[2].envExtra as Record<string, string>).CODEDECK_RUN_ID;
    const requestMock = vi.mocked(IpcClient.prototype.request);
    const adoptIndex = requestMock.mock.calls.findIndex(([method]) => method === "session.adopt");
    const adoptResult = await requestMock.mock.results[adoptIndex]?.value;
    const sessionId = (adoptResult as { session: { id: string } }).session.id;

    expect(runId).not.toBe("stale-parent-value");
    expect(runId).toBe(sessionId);
  });
});
