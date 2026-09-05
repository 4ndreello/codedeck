import { describe, it, expect } from "vitest";
import { extractCleanJson } from "../src/drivers/helpers.js";
import { findClosestModel, levenshtein } from "../src/core/models.js";

describe("extractCleanJson", () => {
  it("parses clean JSON objects", () => {
    const raw = '{"models": [{"slug": "gpt-5"}]}';
    const parsed = extractCleanJson<{ models: any[] }>(raw);
    expect(parsed.models[0].slug).toBe("gpt-5");
  });

  it("parses clean JSON arrays", () => {
    const raw = '[{"slug": "gpt-5"}]';
    const parsed = extractCleanJson<any[]>(raw);
    expect(parsed[0].slug).toBe("gpt-5");
  });

  it("ignores mise/asdf leading banner lines", () => {
    const raw = `mise ~/.config/mise/config.toml tools: codex@0.152.1
mise [WARN] upgrading plugin
{"models": [{"slug": "gpt-5.6-luna"}]}`;
    const parsed = extractCleanJson<{ models: any[] }>(raw);
    expect(parsed.models[0].slug).toBe("gpt-5.6-luna");
  });

  it("ignores trailing non-json junk", () => {
    const raw = `{"models": []}\nDone in 0.4s.`;
    const parsed = extractCleanJson<{ models: any[] }>(raw);
    expect(parsed.models).toEqual([]);
  });

  it("ignores trailing banners containing brackets and braces", () => {
    const raw = `[mise] loading
{"models": [{"slug": "gpt-5", "details": {"ctx": 128000}}]}
[mise] finished {status: ok} [120ms]`;
    const parsed = extractCleanJson<{ models: any[] }>(raw);
    expect(parsed.models[0].slug).toBe("gpt-5");
    expect(parsed.models[0].details.ctx).toBe(128000);
  });

  it("throws on input without valid JSON envelope", () => {
    expect(() => extractCleanJson("command not found")).toThrow("Failed to locate valid JSON envelope");
  });
});

describe("fuzzy model matching", () => {
  it("computes levenshtein distance correctly", () => {
    expect(levenshtein("sonnet", "sonnet")).toBe(0);
    expect(levenshtein("sonet", "sonnet")).toBe(1);
    expect(levenshtein("opus", "opus-5")).toBe(2);
  });

  it("finds closest model from candidates", () => {
    const candidates = ["sonnet", "opus", "haiku", "fable", "claude-sonnet-5"];
    expect(findClosestModel("sonet", candidates)).toBe("sonnet");
    expect(findClosestModel("opux", candidates)).toBe("opus");
    expect(findClosestModel("haik", candidates)).toBe("haiku");
    expect(findClosestModel("claude-sonnet", candidates)).toBe("claude-sonnet-5");
  });

  it("matches case-insensitively", () => {
    const candidates = ["gpt-5.6-luna", "claude-sonnet-5"];
    expect(findClosestModel("GPT-5.6-LUNA", candidates)).toBe("gpt-5.6-luna");
    expect(findClosestModel("Sonnet", candidates)).toBe("claude-sonnet-5");
  });

  it("returns undefined when query is empty", () => {
    expect(findClosestModel("", ["sonnet"])).toBeUndefined();
  });
});

describe("discoverHarnessModels error isolation", () => {
  it("isolates crash in driver.detect()", async () => {
    const { discoverHarnessModels } = await import("../src/core/models.js");
    const brokenDriver: any = {
      id: "claude",
      detect: () => Promise.reject(new Error("detect blew up")),
    };

    const res = await discoverHarnessModels(brokenDriver);
    expect(res.available).toBe(false);
    expect(res.error).toContain("detect blew up");
    expect(res.providers).toEqual([]);
  });

  it("isolates crash in driver.listModels()", async () => {
    const { discoverHarnessModels } = await import("../src/core/models.js");
    const failingDriver: any = {
      id: "codex",
      detect: () => Promise.resolve({ installed: true, path: "/usr/bin/codex" }),
      listModels: () => Promise.reject(new Error("network failure in models list")),
    };

    const res = await discoverHarnessModels(failingDriver);
    expect(res.available).toBe(true);
    expect(res.error).toContain("network failure in models list");
    expect(res.providers).toEqual([]);
  });

  it("succeeds for other drivers when one driver throws during discoverAllModels", async () => {
    const { discoverAllModels } = await import("../src/core/models.js");
    const goodDriver: any = {
      id: "claude",
      detect: () => Promise.resolve({ installed: true, path: "/usr/bin/claude" }),
      listModels: () =>
        Promise.resolve([
          {
            provider: "anthropic",
            models: [{ id: "claude-sonnet-5", name: "Sonnet 5", provider: "anthropic" }],
          },
        ]),
    };
    const badDriver: any = {
      id: "omp",
      detect: () => Promise.reject(new Error("omp binary corrupted")),
    };

    const mockRegistry: any = {
      list: () => [goodDriver, badDriver],
      get: (id: string) => (id === "claude" ? goodDriver : badDriver),
    };

    const results = await discoverAllModels(mockRegistry);
    expect(results.length).toBe(2);

    const claudeResult = results.find((r) => r.agent === "claude");
    expect(claudeResult?.available).toBe(true);
    expect(claudeResult?.providers[0].models[0].id).toBe("claude-sonnet-5");

    const ompResult = results.find((r) => r.agent === "omp");
    expect(ompResult?.available).toBe(false);
    expect(ompResult?.error).toContain("omp binary corrupted");
  });
});

