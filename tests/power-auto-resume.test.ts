import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultCapabilities } from "../src/core/capabilities.js";
import type { AgentDriver, DriverSession } from "../src/core/driver.js";
import type { Session } from "../src/core/session.js";
import {
  AUTO_RESUME_PROMPT,
  buildAutoResumePrompt,
  isAutoResumeEligible,
} from "../src/daemon/auto-resume.js";
import { Daemon } from "../src/daemon/daemon.js";
import { processStartTime } from "../src/utils/process.js";
import {
  makeDaemonTestContext,
  makeTempDir,
  registerDaemonTestHooks,
  seam,
  seed,
} from "./helpers/daemon-seam.js";

const context = makeDaemonTestContext("power-auto-resume-");
let daemon: Daemon | undefined;
let configDir: string;
const originalConfigDir = process.env.CODEDECK_CONFIG_DIR;

registerDaemonTestHooks(context, () => daemon, () => { daemon = undefined; });

beforeEach(() => {
  configDir = makeTempDir("power-auto-resume-config-");
  process.env.CODEDECK_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CODEDECK_CONFIG_DIR;
  else process.env.CODEDECK_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

interface ResumeCall {
  session: DriverSession;
  prompt: string;
}

function installResumeDriver(
  target: Daemon,
  calls: ResumeCall[],
  failFor?: string,
  resume = true,
  afterSend?: (session: DriverSession) => void,
): void {
  seam(target).registry.register({
    id: "claude",
    capabilities: () => ({ ...defaultCapabilities(), resume }),
    send: async (session: DriverSession, prompt: string) => {
      calls.push({ session, prompt });
      afterSend?.(session);
      if (session.id === failFor) throw new Error("resume spawn failed");
    },
    stop: async () => {},
    getHandle: () => undefined,
    events: async function* () {
      await new Promise<void>(() => {});
    },
  } as unknown as AgentDriver);
}

function configureAutoResume(enabled: boolean, maxAgeHours?: number): void {
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ autoResume: { enabled, ...(maxAgeHours === undefined ? {} : { maxAgeHours }) } }),
  );
}

function interrupted(id: string, overrides: Partial<Session> = {}): void {
  seed(daemon!, id, "interrupted", {
    origin: "run",
    nativeSessionId: `native-${id}`,
    failure: { code: "SHUTDOWN", blame: "infra", retryable: true },
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe("auto-resume eligibility", () => {
  const base: Session = {
    id: "eligible",
    agent: "claude",
    status: "interrupted",
    origin: "run",
    nativeSessionId: "native-eligible",
    failure: { code: "SHUTDOWN", blame: "infra", retryable: true },
    cwd: "/tmp",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("rejects sessions older than the configured window", () => {
    expect(isAutoResumeEligible(base, {
      now: new Date("2026-01-02T00:00:00Z"),
      maxAgeHours: 23,
      canResume: true,
      liveIdentity: false,
    })).toBe(false);
  });

  it("uses the interruption timestamp when later updates changed updatedAt", () => {
    expect(isAutoResumeEligible({
      ...base,
      completedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    }, {
      now: new Date("2026-01-02T01:00:00Z"),
      maxAgeHours: 24,
      canResume: true,
      liveIdentity: false,
    })).toBe(false);
  });
});

describe("buildAutoResumePrompt", () => {
  it("keeps the fixed prompt when there is no pending message", () => {
    expect(buildAutoResumePrompt()).toBe(AUTO_RESUME_PROMPT);
    expect(buildAutoResumePrompt(null)).toBe(AUTO_RESUME_PROMPT);
    expect(buildAutoResumePrompt("")).toBe(AUTO_RESUME_PROMPT);
  });

  it("appends a pending message after the fixed prompt", () => {
    const message = "Please finish the queued change";

    expect(buildAutoResumePrompt(message)).toBe(
      `${AUTO_RESUME_PROMPT}\n\nBefore the shutdown, the user queued this message for you:\n\n${message}`,
    );
  });
});

describe("auto-resume on daemon boot", () => {
  const ineligibleCases: Array<[string, Partial<Session>]> = [
    ["open origin", { origin: "open" }],
    ["missing native session id", { nativeSessionId: undefined }],
    ["non-shutdown failure", { failure: { code: "HARNESS_CRASH", blame: "harness", retryable: true } }],
    ["non-retryable shutdown failure", { failure: { code: "SHUTDOWN", blame: "infra", retryable: false } }],
  ];

  it("PRS-05 keeps auto-resume disabled by default", async () => {
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls);
    interrupted("disabled");

    await daemon.start();

    expect(calls).toHaveLength(0);
    expect(seam(daemon).sessions.get("disabled")?.status).toBe("interrupted");
  });

  it("PRS-06 resumes each eligible session once with no queued message", async () => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls);
    interrupted("eligible-1");
    interrupted("eligible-2");

    await daemon.start();
    await waitFor(() => calls.length === 2);

    expect(calls.map(({ session }) => session.id)).toEqual(["eligible-1", "eligible-2"]);
    for (const { session, prompt } of calls) {
      expect(prompt).toBe(AUTO_RESUME_PROMPT);
      expect(session.nativeSessionId).toBe(`native-${session.id}`);
    }
  });

  it("skips an eligible session whose working directory is missing", async () => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls);
    const missingDirectory = makeTempDir("power-auto-resume-missing-");
    fs.rmSync(missingDirectory, { recursive: true, force: true });
    interrupted("missing-directory", { worktree: missingDirectory });

    await daemon.start();

    expect(calls).toHaveLength(0);
    expect(seam(daemon).sessions.get("missing-directory")?.status).toBe("interrupted");
    const log = fs.readFileSync(path.join(context.codedeckDir, "daemon.log"), "utf8");
    expect(log).toContain(`auto-resume skipped missing-directory: working directory missing (${missingDirectory})`);
  });

  it("includes and clears a pending message in the single auto-resume turn", async () => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls);
    interrupted("pending", { pendingMessage: "queued user message", pendingAt: new Date().toISOString() });

    await daemon.start();
    await waitFor(() => calls.length === 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.startsWith(AUTO_RESUME_PROMPT)).toBe(true);
    expect(calls[0]?.prompt).toContain("queued user message");
    const pending = seam(daemon).db.getHandle().prepare(
      "SELECT pending_message, pending_at FROM sessions WHERE id = ?",
    ).get("pending") as { pending_message: string | null; pending_at: string | null };
    expect(pending.pending_message).toBeNull();
    expect(pending.pending_at).toBeNull();
  });

  it("PRS-07 leaves sessions older than maxAgeHours interrupted", async () => {
    configureAutoResume(true, 1);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls);
    interrupted("old", { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });

    await daemon.start();

    expect(calls).toHaveLength(0);
    expect(seam(daemon).sessions.get("old")?.status).toBe("interrupted");
  });

  it("PRS-07 defaults maxAgeHours to 24", async () => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls);
    interrupted("older-than-default", {
      completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });

    await daemon.start();

    expect(calls).toHaveLength(0);
    expect(seam(daemon).sessions.get("older-than-default")?.status).toBe("interrupted");
  });

  it.each(ineligibleCases)("PRS-08 leaves a session with %s untouched", async (_label, overrides) => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls);
    interrupted("ineligible", overrides);

    await daemon.start();

    expect(calls).toHaveLength(0);
    expect(seam(daemon).sessions.get("ineligible")?.status).toBe("interrupted");
  });

  it("PRS-08 leaves sessions untouched when the driver cannot resume", async () => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls, undefined, false);
    interrupted("unsupported");

    await daemon.start();

    expect(calls).toHaveLength(0);
    expect(seam(daemon).sessions.get("unsupported")?.status).toBe("interrupted");
  });

  it("PRS-09 skips a session whose recorded process identity is still live", async () => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls);
    interrupted("live", { pid: process.pid, pidStartTime: processStartTime(process.pid) });

    await daemon.start();

    expect(calls).toHaveLength(0);
    expect(seam(daemon).sessions.get("live")?.status).toBe("interrupted");
  });

  it("PRS-10 logs a failed start and continues to the next session without blocking boot", async () => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls, "fails");
    const pendingAt = new Date().toISOString();
    interrupted("fails", { pendingMessage: "queued failed message", pendingAt });
    interrupted("continues");

    await daemon.start();
    await waitFor(() => calls.length === 2);
    await waitFor(() => seam(daemon!).sessions.get("fails")?.pendingMessage === "queued failed message");

    expect(calls.map(({ session }) => session.id)).toEqual(["fails", "continues"]);
    expect(seam(daemon).sessions.get("fails")?.status).toBe("failed");
    expect(seam(daemon).sessions.get("fails")?.failure).toMatchObject({ code: "UNKNOWN", retryable: true });
    const failedPending = seam(daemon).db.getHandle().prepare(
      "SELECT pending_message, pending_at FROM sessions WHERE id = ?",
    ).get("fails") as { pending_message: string | null; pending_at: string | null };
    expect(failedPending).toEqual({ pending_message: "queued failed message", pending_at: pendingAt });
    expect(seam(daemon).sessions.get("continues")?.status).toBe("working");
    const log = fs.readFileSync(path.join(context.codedeckDir, "daemon.log"), "utf8");
    expect(log).toContain("auto-resume failed for fails: resume spawn failed");
    expect(log).toContain("auto-resume started session continues");
    expect(seam(daemon).events.last("fails")?.type).toBe("session.failed");
  });

  it("stops scanning when shutdown interrupts a resume", async () => {
    configureAutoResume(true);
    const calls: ResumeCall[] = [];
    daemon = new Daemon();
    installResumeDriver(daemon, calls, undefined, true, (session) => {
      if (session.id === "first") {
        (daemon as unknown as { shuttingDown: boolean }).shuttingDown = true;
      }
    });
    const pendingAt = new Date().toISOString();
    interrupted("first", { pendingMessage: "queued during shutdown", pendingAt });
    interrupted("next");

    await daemon.start();
    await waitFor(() => calls.length === 1);
    await waitFor(() => seam(daemon!).sessions.get("first")?.pendingMessage === "queued during shutdown");

    expect(seam(daemon).sessions.get("first")?.failure?.code).not.toBe("UNKNOWN");
    const interruptedPending = seam(daemon).db.getHandle().prepare(
      "SELECT pending_message, pending_at FROM sessions WHERE id = ?",
    ).get("first") as { pending_message: string | null; pending_at: string | null };
    expect(interruptedPending).toEqual({ pending_message: "queued during shutdown", pending_at: pendingAt });
    expect(seam(daemon).sessions.get("next")?.status).toBe("interrupted");
    expect(seam(daemon).sessions.get("next")?.failure).toMatchObject({ code: "SHUTDOWN" });
  });
});
