import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Daemon } from "../src/daemon/daemon.js";
import { saveConfig } from "../src/config/config.js";
import type { AgentDriver, DriverSession, StartOptions } from "../src/core/driver.js";
import type { Session } from "../src/core/session.js";
import { fakeSocket, seam } from "./helpers/daemon-seam.js";

type StartDriverForSession = (sessionId: string, prompt: string, model?: string) => Promise<void>;

let runAgentDir: string;
let configDir: string;
let daemon: Daemon;
let startSandboxes: Array<Session["sandbox"]>;
let requestNumber: number;
let realStartDriverForSession: StartDriverForSession;
const originalRunAgentDir = process.env.RUN_AGENT_DIR;
const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

beforeEach(() => {
  runAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-sandbox-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-sandbox-config-"));
  process.env.RUN_AGENT_DIR = runAgentDir;
  process.env.RUN_AGENT_CONFIG_DIR = configDir;
  requestNumber = 0;
  startSandboxes = [];
  daemon = new Daemon();
  const privateDaemon = daemon as unknown as { startDriverForSession: StartDriverForSession };
  realStartDriverForSession = privateDaemon.startDriverForSession.bind(daemon);
  privateDaemon.startDriverForSession = async (sessionId) => {
    startSandboxes.push(seam(daemon).sessions.get(sessionId)?.sandbox);
  };
});

afterEach(() => {
  try { seam(daemon).db.close(); } catch {}
  if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalRunAgentDir;
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
  fs.rmSync(runAgentDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function create(params: Record<string, unknown>): Promise<Session> {
  const { writes, socket } = fakeSocket();
  await seam(daemon).handleRequest(
    { id: `daemon-sandbox-${++requestNumber}`, method: "session.create", params },
    socket,
  );
  const response = JSON.parse(writes[0]) as { result: { session: Session } };
  const session = seam(daemon).sessions.get(response.result.session.id);
  if (!session) throw new Error("session was not persisted");
  return session;
}

function params(agent: string, sandbox?: unknown): Record<string, unknown> {
  return {
    prompt: "check sandbox",
    agent,
    cwd: runAgentDir,
    noWorktree: true,
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

describe("daemon session.create sandbox resolution", () => {
  it("prefers a valid request sandbox over the configured default", async () => {
    saveConfig({ defaultSandbox: "read-only" });

    const session = await create(params("codex", "danger-full-access"));

    expect(session.sandbox).toBe("danger-full-access");
    expect(startSandboxes).toEqual(["danger-full-access"]);
  });

  it("passes the resolved sandbox to the Codex start options", async () => {
    saveConfig({ defaultSandbox: "read-only" });
    const starts: StartOptions[] = [];
    const codex = (seam(daemon).registry as unknown as { get(agent: "codex"): AgentDriver }).get("codex");
    vi.spyOn(codex, "start").mockImplementation(async (options): Promise<DriverSession> => {
      starts.push(options);
      return {
        id: options.sessionId,
        nativeSessionId: "thread-created",
        cwd: options.cwd,
        model: options.model,
        sandbox: options.sandbox,
      };
    });
    (daemon as unknown as { startDriverForSession: StartDriverForSession }).startDriverForSession = realStartDriverForSession;

    const session = await create(params("codex", "danger-full-access"));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(session.sandbox).toBe("danger-full-access");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.sandbox).toBe("danger-full-access");
  });

  it("uses a valid configured sandbox when the request omits one", async () => {
    saveConfig({ defaultSandbox: "danger-full-access" });

    const session = await create(params("codex"));

    expect(session.sandbox).toBe("danger-full-access");
    expect(startSandboxes).toEqual(["danger-full-access"]);
  });

  it.each([
    ["no configured value", undefined],
    ["invalid configured value", "network"],
  ])("leaves the Codex sandbox unset with %s", async (_label, defaultSandbox) => {
    saveConfig(defaultSandbox === undefined ? {} : { defaultSandbox });

    const session = await create(params("codex"));

    expect(session.sandbox).toBeUndefined();
    expect(startSandboxes).toEqual([undefined]);
  });

  it("ignores an invalid request sandbox and falls back to a valid config value", async () => {
    saveConfig({ defaultSandbox: "workspace-write" });

    const session = await create(params("codex", "network"));

    expect(session.sandbox).toBe("workspace-write");
    expect(startSandboxes).toEqual(["workspace-write"]);
    expect(session.sandbox).not.toBe("network");
  });

  it("keeps a valid request sandbox when config is invalid", async () => {
    saveConfig({ defaultSandbox: "network" });

    const session = await create(params("codex", "danger-full-access"));

    expect(session.sandbox).toBe("danger-full-access");
    expect(startSandboxes).toEqual(["danger-full-access"]);
  });

  it("leaves an invalid request sandbox unset when config is absent", async () => {
    saveConfig({});

    const session = await create(params("codex", "network"));

    expect(session.sandbox).toBeUndefined();
    expect(startSandboxes).toEqual([undefined]);
  });

  it.each(["claude", "opencode", "omp", "antigravity"]) (
    "does not persist request or config sandbox for %s",
    async (agent) => {
      saveConfig({ defaultSandbox: "danger-full-access" });

      const session = await create(params(agent, "read-only"));

      expect(session.sandbox).toBeUndefined();
      expect(startSandboxes).toEqual([undefined]);
    },
  );

  it.each(["claude", "opencode", "omp", "antigravity"]) (
    "does not persist a config-only sandbox for %s",
    async (agent) => {
      saveConfig({ defaultSandbox: "danger-full-access" });

      const session = await create(params(agent));

      expect(session.sandbox).toBeUndefined();
      expect(startSandboxes).toEqual([undefined]);
    },
  );
});
