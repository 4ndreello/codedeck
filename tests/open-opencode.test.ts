import fs from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("../src/drivers/helpers.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/drivers/helpers.js")>();
  return { ...mod, detectBinary: vi.fn() };
});

import {
  agentName,
  buildArgs,
  buildInlineConfig,
  preflight,
  resolveBinary,
  rolePermission,
} from "../src/open/launchers/opencode.js";
import { launcherFor } from "../src/cli/commands/open.js";
import * as models from "../src/core/models.js";
import { detectBinary } from "../src/drivers/helpers.js";
import { resolvePluginDir } from "../src/core/roles.js";

const mockedDetect = vi.mocked(detectBinary);

const pluginDir = resolvePluginDir();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rolePermission", () => {
  it("leaves general unrestricted", () => {
    expect(rolePermission("general")).toEqual({ "*": "allow" });
  });

  it("gives orchestrator bash and nothing else", () => {
    expect(rolePermission("orchestrator")).toEqual({
      read: "deny",
      edit: "deny",
      write: "deny",
      task: "deny",
      bash: "allow",
    });
  });

  it("denies reviewer edits and dispatch but keeps bash", () => {
    expect(rolePermission("reviewer")).toEqual({
      edit: "deny",
      write: "deny",
      task: "deny",
      bash: "allow",
    });
  });

  it("lets auditor dispatch but not edit", () => {
    expect(rolePermission("auditor")).toEqual({
      edit: "deny",
      write: "deny",
      task: "allow",
      bash: "allow",
    });
  });
});

describe("buildInlineConfig", () => {
  it("carries instructions, the namespaced agent, and the exact permission map", () => {
    const parsed = JSON.parse(buildInlineConfig(pluginDir, "reviewer")) as any;
    const agent = parsed.agent["codedeck-reviewer"];

    expect(agentName("reviewer")).toBe("codedeck-reviewer");
    expect(parsed.instructions).toHaveLength(1);
    expect(parsed.instructions[0]).toContain("Never round failure to success");
    expect(agent.mode).toBe("primary");
    expect(agent.prompt).toContain("CodeDeck reviewer");
    expect(agent.prompt).not.toContain("tools:");
    expect(agent.permission).toEqual(rolePermission("reviewer"));
  });

  it("embeds each role's own permission map", () => {
    for (const role of ["general", "orchestrator", "reviewer", "auditor"] as const) {
      const parsed = JSON.parse(buildInlineConfig(pluginDir, role)) as any;
      expect(parsed.agent[`codedeck-${role}`].permission).toEqual(rolePermission(role));
    }
  });

  it("writes nothing to disk", () => {
    const writes = [
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "copyFileSync"),
    ];

    buildInlineConfig(pluginDir, "general");
    buildArgs("general", { model: "prov/m" }, []);

    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
  });
});

describe("buildArgs", () => {
  it("emits agent, model, auto, session, and passthrough in order", () => {
    expect(
      buildArgs("reviewer", { model: "prov/m", resume: "sess-1" }, ["--log-level", "debug"]),
    ).toEqual([
      "--agent",
      "codedeck-reviewer",
      "--model",
      "prov/m",
      "--auto",
      "--session",
      "sess-1",
      "--log-level",
      "debug",
    ]);
  });

  it("drops --auto when bypass is off", () => {
    expect(buildArgs("general", { model: "prov/m", bypass: false }, [])).toEqual([
      "--agent",
      "codedeck-general",
      "--model",
      "prov/m",
    ]);
  });

  it("rejects models outside provider/model shape before spawn", () => {
    for (const bad of ["baremodel", "has space/x", "/leading", "trailing/"]) {
      expect(() => buildArgs("general", { model: bad }, [])).toThrow(/must be provider\/model/);
    }
  });
});

describe("resolveBinary", () => {
  it("fails with install instructions when opencode is missing", async () => {
    mockedDetect.mockResolvedValueOnce({ installed: false });

    await expect(resolveBinary()).rejects.toThrow(/not found on PATH/);
  });

  it("returns the checked path when opencode is present", async () => {
    mockedDetect.mockResolvedValueOnce({ installed: true, path: "/bin/opencode" });

    await expect(resolveBinary()).resolves.toBe("/bin/opencode");
  });
});

describe("launcherFor", () => {
  it("opens claude for a claude binding", () => {
    expect(launcherFor("general", { harness: "claude", model: "m" })).toBe("claude");
  });

  it("opens claude when nobody bound the role", () => {
    expect(launcherFor("general", undefined)).toBe("claude");
  });

  it("opens opencode for an opencode binding", () => {
    expect(launcherFor("reviewer", { harness: "opencode", model: "prov/m" })).toBe("opencode");
  });

  it("throws instead of rounding codex down to the wrong session", () => {
    expect(() => launcherFor("reviewer", { harness: "codex", model: "m" })).toThrow(/codex/);
  });

  it("throws instead of rounding omp down to the wrong session", () => {
    expect(() => launcherFor("reviewer", { harness: "omp", model: "m" })).toThrow(/omp/);
  });
});

describe("preflight", () => {
  it("warns and continues when discovery throws", async () => {
    vi.spyOn(models, "getCachedOrDiscoverModels").mockRejectedValueOnce(new Error("net down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(preflight("prov/m", false)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });

  it("rejects a model the opencode catalog does not list", async () => {
    vi.spyOn(models, "getCachedOrDiscoverModels").mockResolvedValueOnce([
      {
        agent: "opencode",
        available: true,
        providers: [
          {
            provider: "prov",
            displayName: "Prov",
            models: [{ id: "prov/a", name: "a", provider: "prov" }],
          },
        ],
      },
    ]);

    await expect(preflight("prov/zzz", false)).rejects.toThrow(/not in the opencode catalog/);
  });
});
