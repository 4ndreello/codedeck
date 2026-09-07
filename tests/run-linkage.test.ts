import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IpcClient } from "../src/daemon/ipc.js";
import { registerOpenCommand } from "../src/cli/commands/open.js";
import * as opencodeLauncher from "../src/open/launchers/opencode.js";
import * as runtime from "../src/open/runtime.js";

const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;
const originalRunId = process.env.CODEDECK_RUN_ID;
let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-run-linkage-"));
  process.env.RUN_AGENT_CONFIG_DIR = configDir;
  process.env.CODEDECK_RUN_ID = "stale-parent-value";
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ agents: { reviewer: { harness: "opencode", model: "prov/m" } } }),
  );
  vi.spyOn(IpcClient.prototype, "ensureDaemonStarted").mockResolvedValue(undefined as never);
  vi.spyOn(opencodeLauncher, "preflight").mockResolvedValue(undefined);
  vi.spyOn(opencodeLauncher, "resolveBinary").mockResolvedValue("/bin/opencode");
  vi.spyOn(runtime, "spawnHarness").mockResolvedValue(undefined);
  vi.spyOn(runtime, "finishOpenSession").mockImplementation(() => {});
  vi.spyOn(runtime, "renderBanner").mockReturnValue("");
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
  if (originalRunId === undefined) delete process.env.CODEDECK_RUN_ID;
  else process.env.CODEDECK_RUN_ID = originalRunId;
  fs.rmSync(configDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runOpen(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerOpenCommand(program);
  await program.parseAsync(["node", "codedeck", "open", ...argv], { from: "node" });
}

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
