import { describe, it, expect } from "vitest";
import { buildScopedSpawn, scopeLimits } from "../src/utils/process.js";

const BIN = "/usr/bin/systemd-run";
const LIVE = { platform: "linux", env: {}, systemdRunBin: BIN, userManagerReachable: true } as const;

describe("buildScopedSpawn — sibling-scope argv", () => {
  it("wraps the command with quiet + default caps and a -- separator", () => {
    expect(
      buildScopedSpawn({ cmd: "node", args: ["--test", "a.test.ts"] }, { ...LIVE }),
    ).toEqual({
      cmd: BIN,
      args: [
        "--user",
        "--scope",
        "--quiet",
        "-p",
        "MemoryMax=4G",
        "-p",
        "MemorySwapMax=0",
        "--",
        "node",
        "--test",
        "a.test.ts",
      ],
    });
  });

  it("honors env caps, explicit overrides, and the description", () => {
    const env = { CODEDECK_WORKER_MEMORY_MAX: "8G", CODEDECK_WORKER_SWAP_MAX: "1G" };
    expect(
      buildScopedSpawn(
        { cmd: "node", args: [], description: "codedeck worker s1" },
        { ...LIVE, env },
      )!.args,
    ).toContain("--description=codedeck worker s1");
    expect(
      buildScopedSpawn(
        { cmd: "node", args: [], memoryMax: "2G", swapMax: "512M" },
        { ...LIVE, env },
      )!.args,
    ).toEqual(
      expect.arrayContaining(["-p", "MemoryMax=2G", "-p", "MemorySwapMax=512M"]),
    );
  });

  it("falls back to defaults on malformed sizes", () => {
    expect(
      scopeLimits(undefined, { CODEDECK_WORKER_MEMORY_MAX: "lots", CODEDECK_WORKER_SWAP_MAX: "-5" }),
    ).toEqual({ memoryMax: "4G", swapMax: "0" });
  });

  it("rejects sizes systemd rejects: lowercase suffix, bare zero memory", () => {
    // systemd: "Failed to parse MemoryMax= value '4g'"; MemoryMax=0 is out
    // of range. MemorySwapMax=0 stays valid (disables swap).
    expect(scopeLimits(undefined, { CODEDECK_WORKER_MEMORY_MAX: "4g" }).memoryMax).toBe("4G");
    expect(scopeLimits(undefined, { CODEDECK_WORKER_MEMORY_MAX: "0" }).memoryMax).toBe("4G");
    expect(scopeLimits(undefined, { CODEDECK_WORKER_MEMORY_MAX: "0G" }).memoryMax).toBe("4G");
    expect(scopeLimits(undefined, { CODEDECK_WORKER_SWAP_MAX: "0" }).swapMax).toBe("0");
    expect(scopeLimits({ memoryMax: "1.5G" }, {}).memoryMax).toBe("1.5G");
  });

  it("returns null where scoping cannot work", () => {
    const req = { cmd: "node", args: [] as string[] };
    expect(buildScopedSpawn(req, { ...LIVE, platform: "darwin" })).toBeNull();
    expect(buildScopedSpawn(req, { ...LIVE, systemdRunBin: null })).toBeNull();
    expect(buildScopedSpawn(req, { ...LIVE, userManagerReachable: false })).toBeNull();
    expect(buildScopedSpawn(req, { ...LIVE, env: { CODEDECK_NO_SCOPE: "1" } })).toBeNull();
  });
});
