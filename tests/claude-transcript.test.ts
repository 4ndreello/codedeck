import { once } from "node:events";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findTranscript, readTranscriptUsage } from "../src/core/claude-transcript.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/claude-transcript/${name}`, import.meta.url));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-transcript-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Claude transcript usage", () => {
  it("uses the last cost-state and sums its model token totals", async () => {
    await expect(readTranscriptUsage(fixturePath("cost-state.jsonl"))).resolves.toEqual({
      state: "cost-state",
      cost: 2.5,
      inputTokens: 22,
      outputTokens: 26,
      cachedTokens: 76,
      model: "claude-opus-5",
      endedAt: "2026-09-20T12:00:00.000Z",
      cwd: "/tmp/final",
    });
  });

  it("deduplicates repeated assistant messages and prices the model totals", async () => {
    const usage = await readTranscriptUsage(fixturePath("tokens.jsonl"));

    expect(usage).toMatchObject({
      state: "tokens",
      inputTokens: 300,
      outputTokens: 140,
      cachedTokens: 35,
      endedAt: "2026-09-21T10:03:00.000Z",
      cwd: "/tmp/final",
    });
    expect(usage.cost).toBeCloseTo(0.0014661, 15);
  });

  it("omits cost when any model is unpriced", async () => {
    const usage = await readTranscriptUsage(fixturePath("unpriced.jsonl"));

    expect(usage.state).toBe("no-price");
    expect(usage).not.toHaveProperty("cost");
    expect(usage).toMatchObject({ inputTokens: 25, outputTokens: 10, cachedTokens: 5 });
  });

  it("finds a transcript in a direct project subdirectory and tolerates missing paths", () => {
    const projectsDir = makeTempDir();
    const projectDir = path.join(projectsDir, "-tmp-project");
    fs.mkdirSync(projectDir);
    const file = path.join(projectDir, "native-1.jsonl");
    fs.writeFileSync(file, "{}\n");

    expect(findTranscript("native-1", projectsDir)).toBe(file);
    expect(findTranscript("absent", projectsDir)).toBeUndefined();
    expect(findTranscript("native-1", path.join(projectsDir, "missing"))).toBeUndefined();
  });

  it("streams a generated file larger than 50 MB", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-transcript-large-"));
    const file = path.join(dir, "large.jsonl");
    try {
      const stream = createWriteStream(file);
      const segment = "x".repeat(4 * 1024 * 1024);

      for (let index = 0; index < 13; index += 1) {
        if (!stream.write(`{\"type\":\"ignored\",\"data\":\"${segment}\"}\n`)) {
          await once(stream, "drain");
        }
      }
      const finished = once(stream, "finish");
      stream.end();
      await finished;
      expect(fs.statSync(file).size).toBeGreaterThan(50 * 1024 * 1024);

      const heapBefore = process.memoryUsage().heapUsed;
      await readTranscriptUsage(file);
      const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
      expect(heapGrowth).toBeLessThan(50 * 1024 * 1024);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
