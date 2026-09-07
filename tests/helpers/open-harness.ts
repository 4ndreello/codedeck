import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, vi } from "vitest";

import { IpcClient } from "../../src/daemon/ipc.js";
import { registerOpenCommand } from "../../src/cli/commands/open.js";
import * as opencodeLauncher from "../../src/open/launchers/opencode.js";
import * as runtime from "../../src/open/runtime.js";

interface OpenHarnessOptions {
  prefix: string;
  restoreCwd?: boolean;
  runId?: string;
}

export function setupOpenHarness(options: OpenHarnessOptions): {
  runOpen(argv: string[]): Promise<void>;
} {
  const originalCwd = process.cwd();
  const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;
  const originalRunId = process.env.CODEDECK_RUN_ID;
  let configDir: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix));
    process.env.RUN_AGENT_CONFIG_DIR = configDir;
    if (options.runId !== undefined) process.env.CODEDECK_RUN_ID = options.runId;
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
    if (options.restoreCwd) process.chdir(originalCwd);
    if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
    else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
    if (options.runId !== undefined) {
      if (originalRunId === undefined) delete process.env.CODEDECK_RUN_ID;
      else process.env.CODEDECK_RUN_ID = originalRunId;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runOpen(argv: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerOpenCommand(program);
    await program.parseAsync(["node", "codedeck", "open", ...argv], { from: "node" });
  }

  return { runOpen };
}
