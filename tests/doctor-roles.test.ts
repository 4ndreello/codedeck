import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), isDaemonRunning: vi.fn() }));

vi.mock("../src/daemon/ipc.js", () => ({
  IpcClient: class {
    ensureDaemonStarted = vi.fn(async () => {});
    request = mocks.request;
  },
  isDaemonRunning: mocks.isDaemonRunning,
}));

import { registerDoctorCommand, renderRolesSection, resolveRoleReadiness } from "../src/cli/commands/doctor.js";
import { ROLES } from "../src/core/roles.js";

const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const originalConfigDir = process.env.RUN_AGENT_CONFIG_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalConfigDir === undefined) delete process.env.RUN_AGENT_CONFIG_DIR;
  else process.env.RUN_AGENT_CONFIG_DIR = originalConfigDir;
});

describe("doctor roles section", () => {
  it("reports every role, bound or not", () => {
    const rows = resolveRoleReadiness({
      defaultAgent: "claude",
      agents: { auditor: { harness: "opencode", model: "meta/muse" } },
    });

    expect(rows.map((row) => row.role)).toEqual([...ROLES]);
    expect(rows.find((row) => row.role === "auditor")).toEqual({
      role: "auditor",
      harness: "opencode",
      model: "meta/muse",
      fallback: "claude",
    });
    expect(rows.find((row) => row.role === "reviewer")).toEqual({
      role: "reviewer",
      fallback: "claude",
    });
  });

  // A half-written entry is already rejected by resolveRoleBinding, and doctor
  // has to agree with it: reporting a harness the run would not use is worse
  // than reporting none.
  it("treats a half-written binding as unbound, the way run does", () => {
    const rows = resolveRoleReadiness({
      agents: {
        general: { harness: "wat" as never, model: "m" },
        reviewer: { harness: "codex", model: "  " },
      },
    });

    expect(rows.find((row) => row.role === "general")?.harness).toBeUndefined();
    expect(rows.find((row) => row.role === "reviewer")?.harness).toBeUndefined();
  });

  it("falls back to claude when no default agent is configured", () => {
    expect(resolveRoleReadiness({}).every((row) => row.fallback === "claude")).toBe(true);
    expect(
      resolveRoleReadiness({ defaultAgent: "codex" }).every((row) => row.fallback === "codex"),
    ).toBe(true);
  });

  // The whole point of the section is that an unbound role is visibly a
  // problem: it is what let an auditor bound to opencode run on claude with
  // nothing on screen to say so.
  it("names where an unbound role actually lands", () => {
    const lines = strip(
      renderRolesSection(
        resolveRoleReadiness({
          defaultAgent: "claude",
          agents: { orchestrator: { harness: "claude", model: "claude-opus-4-8" } },
        }),
      ),
    ).split("\n");

    expect(lines[0]).toBe("Roles");
    expect(lines.find((line) => line.includes("orchestrator"))).toContain(
      "✓ claude / claude-opus-4-8",
    );
    expect(lines.find((line) => line.includes("auditor"))).toContain("✗ unbound, runs on claude");
  });

  it("uses top-level bindings and omits legacy setup keys from doctor output", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "codedeck-doctor-config-"));
    process.env.RUN_AGENT_CONFIG_DIR = configDir;
    const pointerKey = "activeProfile";
    const savedSetsKey = "profiles";
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
      agents: { reviewer: { harness: "codex", model: "top-level" } },
      [pointerKey]: "x",
      [savedSetsKey]: { x: { agents: { reviewer: { harness: "omp", model: "legacy" } } } },
    }));
    const doctorResult = {
      node: { version: "v24" },
      git: { installed: true, version: "git" },
      agents: {},
      daemon: { running: true, pid: 1, uptime: 1000 },
      database: { path: "/tmp/db", exists: true },
      power: { serviceInstalled: false, inhibitAvailable: false },
    };
    mocks.isDaemonRunning.mockResolvedValue(true);
    mocks.request.mockResolvedValue(doctorResult);

    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const jsonProgram = new Command();
    registerDoctorCommand(jsonProgram);
    await jsonProgram.parseAsync(["node", "codedeck", "doctor", "--json"]);
    const payload = JSON.parse(String(output.mock.calls[0]?.[0]));
    const errorKey = pointerKey + "Error";

    expect(payload.roles.find((row: { role: string }) => row.role === "reviewer")).toMatchObject({
      harness: "codex",
      model: "top-level",
    });
    expect(payload).not.toHaveProperty(pointerKey);
    expect(payload).not.toHaveProperty(errorKey);

    output.mockClear();
    mocks.request.mockResolvedValue(doctorResult);
    const textProgram = new Command();
    registerDoctorCommand(textProgram);
    await textProgram.parseAsync(["node", "codedeck", "doctor"]);
    const text = output.mock.calls.map((call) => String(call[0])).join("\n");

    expect(text).toContain("Roles");
    expect(text).not.toContain("Profile");
  });
});
