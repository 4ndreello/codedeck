import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  autocompactArgs,
  parseAutocompact,
  resolveAutocompactTokens,
} from "../src/core/autocompact.js";
import { buildClaudeArgs } from "../src/drivers/claude/driver.js";
import { buildOpenArgs } from "../src/open/launchers/claude.js";

const base = { sessionId: "test-session", prompt: "do it", cwd: "/work" };

// buildOpenArgs fails fast on a missing ultra.md, so the open tests below run
// against a fixture plugin dir instead of a fake path.
const PLUGIN = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-plugin-"));
  fs.writeFileSync(path.join(dir, "ultra.md"), "ULTRA BASE\n");
  return dir;
})();

describe("resolveAutocompactTokens", () => {
  it.each([
    [1_000_000, 260_000],
    [500_000, 260_000],
    [200_000, 160_000],
    [120_000, 100_000],
  ])("resolves a %s-token context window to %s tokens", (contextWindow, expected) => {
    expect(resolveAutocompactTokens({ contextWindow })).toBe(expected);
  });

  it("uses the default cap when the context window is unknown", () => {
    expect(resolveAutocompactTokens()).toBe(260_000);
  });

  it("clamps configured token values to Claude's accepted range", () => {
    expect(resolveAutocompactTokens({ config: { autocompact: { tokens: 1 } } })).toBe(
      AUTOCOMPACT_MIN_TOKENS,
    );
    expect(resolveAutocompactTokens({ config: { autocompact: { tokens: 2_000_000 } } })).toBe(
      AUTOCOMPACT_MAX_TOKENS,
    );
  });

  it("uses configured cap and percentage for a known context window", () => {
    expect(resolveAutocompactTokens({
      contextWindow: 500_000,
      config: { autocompact: { cap: 300_000, percent: 0.5 } },
    })).toBe(250_000);
  });

  it("returns auto when the configured mode requests it", () => {
    expect(resolveAutocompactTokens({ config: { autocompact: { mode: "auto" } } })).toBe("auto");
    expect(autocompactArgs({ config: { autocompact: { mode: "auto" } } })).toEqual([
      "--autocompact",
      "auto",
    ]);
  });

  it("does not generate an argument when compaction is disabled", () => {
    expect(resolveAutocompactTokens({ config: { autocompact: { enabled: false } } })).toBeUndefined();
    expect(autocompactArgs({ config: { autocompact: { enabled: false } } })).toEqual([]);
  });

  it("lets the explicit disable spelling turn the feature off", () => {
    expect(resolveAutocompactTokens({ explicit: false })).toBeUndefined();
    expect(resolveAutocompactTokens({ explicit: "--no-autocompact" })).toBeUndefined();
  });

  it("lets an explicit value override a disabled default", () => {
    expect(resolveAutocompactTokens({
      explicit: 200_000,
      config: { autocompact: { enabled: false } },
    })).toBe(200_000);
  });

  it("lets bare enable override a disabled default", () => {
    expect(resolveAutocompactTokens({
      explicit: true,
      config: { autocompact: { enabled: false } },
    })).toBe(260_000);
  });

  it("clamps explicit numeric values to Claude's accepted range", () => {
    expect(resolveAutocompactTokens({ explicit: 1 })).toBe(AUTOCOMPACT_MIN_TOKENS);
    expect(resolveAutocompactTokens({ explicit: 2_000_000 })).toBe(AUTOCOMPACT_MAX_TOKENS);
  });

  it("does not duplicate a passthrough override", () => {
    expect(resolveAutocompactTokens({ passthrough: ["--autocompact", "auto"] })).toBeUndefined();
    expect(autocompactArgs({ passthrough: ["--autocompact", "auto"] })).toEqual([]);
  });

  it("keeps both passthrough disable spellings authoritative", () => {
    expect(autocompactArgs({ passthrough: ["--autocompact=200000"] })).toEqual([]);
    expect(autocompactArgs({ passthrough: ["--no-autocompact"] })).toEqual([]);
  });
});

describe("autocompact CLI values", () => {
  it("accepts auto, a boolean option, and in-range token counts", () => {
    expect(parseAutocompact("auto")).toBe("auto");
    expect(parseAutocompact(true)).toBe(true);
    expect(parseAutocompact("100000")).toBe(100_000);
    expect(parseAutocompact("1000000")).toBe(1_000_000);
  });

  it.each(["", "99999", "1000001", "bogus", "1.5"]) ("rejects invalid value %j", (value) => {
    expect(() => parseAutocompact(value)).toThrow(/Invalid --autocompact value/);
  });
});

describe("Claude autocompact argument builders", () => {
  it("leaves default driver args silent", () => {
    expect(buildClaudeArgs(base)).not.toContain("--autocompact");
  });

  it("adds the resolved flag to the run driver before its passthrough", () => {
    const args = buildClaudeArgs(
      { ...base, autocompact: 180_000, passthrough: ["--add-dir", "/tmp/work"] },
      { autocompact: { enabled: true } },
    );
    const compactIndex = args.indexOf("--autocompact");
    const passthroughIndex = args.indexOf("--add-dir");

    expect(args.slice(compactIndex, compactIndex + 2)).toEqual(["--autocompact", "180000"]);
    expect(compactIndex).toBeLessThan(passthroughIndex);
  });

  it("adds the resolved flag to open before the user's passthrough", () => {
    const args = buildOpenArgs(
      "general",
      { autocompact: "auto" },
      PLUGIN,
      ["--add-dir", "/tmp/work"],
    );
    const compactIndex = args.indexOf("--autocompact");

    expect(args.slice(compactIndex, compactIndex + 2)).toEqual(["--autocompact", "auto"]);
    expect(compactIndex).toBeLessThan(args.indexOf("--add-dir"));
  });

  it("uses configured compaction for open and keeps an explicit disable", () => {
    const configured = buildOpenArgs(
      "general",
      {},
      PLUGIN,
      [],
      undefined,
      undefined,
      { autocompact: { tokens: 200_000 } },
    );
    const disabled = buildOpenArgs(
      "general",
      { autocompact: false },
      PLUGIN,
      [],
    );

    const compactIndex = configured.indexOf("--autocompact");
    expect(configured.slice(compactIndex, compactIndex + 2)).toEqual(["--autocompact", "200000"]);
    expect(disabled).not.toContain("--autocompact");
  });

  it("leaves a passthrough autocompact flag as the only occurrence", () => {
    const args = buildOpenArgs(
      "general",
      {},
      PLUGIN,
      ["--autocompact", "auto"],
    );

    expect(args.filter((arg) => arg === "--autocompact")).toHaveLength(1);
    expect(args.slice(-2)).toEqual(["--autocompact", "auto"]);
  });
});
