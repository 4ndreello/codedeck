import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectPowerReadiness,
  renderPowerSection,
  resolvePowerInfo,
} from "../src/cli/commands/doctor.js";

describe("doctor power section", () => {
  it("passes the daemon power payload through when present", () => {
    expect(
      resolvePowerInfo({ power: { serviceInstalled: true, inhibitAvailable: true } }),
    ).toEqual({ serviceInstalled: true, inhibitAvailable: true });
    expect(
      resolvePowerInfo({ power: { serviceInstalled: false, inhibitAvailable: true } }),
    ).toEqual({ serviceInstalled: false, inhibitAvailable: true });
  });

  it("falls back to local detection with boolean fields when the payload lacks power", () => {
    const power = resolvePowerInfo({});
    expect(typeof power.serviceInstalled).toBe("boolean");
    expect(typeof power.inhibitAvailable).toBe("boolean");
  });

  it("detects a missing unit file from an empty home directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-doctor-"));
    try {
      const power = detectPowerReadiness(home);
      expect(power.serviceInstalled).toBe(false);
      expect(typeof power.inhibitAvailable).toBe("boolean");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("prints a Power section without crashing when systemd is absent", () => {
    const section = renderPowerSection({ serviceInstalled: false, inhibitAvailable: false });
    expect(section).toContain("Power");
    expect(section).toContain("inhibit");
    expect(section).toContain("systemd-inhibit not found");
  });

  it("marks installed power readiness with check marks", () => {
    const section = renderPowerSection({ serviceInstalled: true, inhibitAvailable: true });
    expect(section).toContain("Power");
    expect(section).toContain("✓");
  });
});
