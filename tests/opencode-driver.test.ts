import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/drivers/helpers.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/drivers/helpers.js")>();
  return { ...mod, detectBinary: vi.fn() };
});

import { OpencodeDriver } from "../src/drivers/opencode/driver.js";
import { detectBinary } from "../src/drivers/helpers.js";

const mockedDetect = vi.mocked(detectBinary);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("OpencodeDriver", () => {
  it("detects and launches the managed OpenCode v2 binary when PATH is stale", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-opencode-"));
    const binary = path.join(home, ".opencode", "bin", "opencode");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "");
    vi.stubEnv("HOME", home);

    mockedDetect
      .mockResolvedValueOnce({ installed: false })
      .mockResolvedValueOnce({ installed: true, path: binary, version: "opencode v2.0.12" });

    try {
      const driver = new OpencodeDriver();

      expect((driver as any).getCommand()).toBe(binary);
      await expect(driver.detect()).resolves.toMatchObject({
        installed: true,
        path: binary,
        version: "opencode v2.0.12",
      });
      expect(mockedDetect).toHaveBeenNthCalledWith(1, "opencode");
      expect(mockedDetect).toHaveBeenNthCalledWith(2, binary);
      expect((driver as any).getCommand()).toBe(binary);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
