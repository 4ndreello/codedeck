import { once } from "node:events";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeTranscriptChunk,
  findTranscript,
  readTranscriptUsage,
  TRANSCRIPT_CHUNK_LIMIT_BYTES,
  type IncrementalTranscriptState,
} from "../src/core/claude-transcript.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/claude-transcript/${name}`, import.meta.url));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-transcript-"));
  tempDirs.push(dir);
  return dir;
}

function emptyIncrementalState(): IncrementalTranscriptState {
  return {
    pendingLine: new Uint8Array(),
    discardUntilNewline: false,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    seenMessageKeys: new Set(),
  };
}

function assistantLine(options: {
  messageId?: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): string {
  return `${JSON.stringify({
    type: "assistant",
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    message: {
      ...(options.messageId === undefined ? {} : { id: options.messageId }),
      usage: {
        input_tokens: options.inputTokens ?? 0,
        output_tokens: options.outputTokens ?? 0,
        cache_read_input_tokens: options.cacheReadTokens ?? 0,
        cache_creation_input_tokens: options.cacheCreationTokens ?? 0,
      },
    },
  })}\n`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("incremental Claude transcript usage", () => {
  it("rejects an oversized chunk without mutating the input state", () => {
    const pendingLine = new TextEncoder().encode("partial");
    const seenMessageKeys = new Set(["seen"]);
    const state: IncrementalTranscriptState = {
      pendingLine,
      discardUntilNewline: true,
      inputTokens: 4,
      outputTokens: 5,
      cachedTokens: 6,
      seenMessageKeys,
    };

    expect(() => consumeTranscriptChunk(state, new Uint8Array(TRANSCRIPT_CHUNK_LIMIT_BYTES + 1))).toThrow(
      RangeError,
    );
    expect(state).toEqual({
      pendingLine: new TextEncoder().encode("partial"),
      discardUntilNewline: true,
      inputTokens: 4,
      outputTokens: 5,
      cachedTokens: 6,
      seenMessageKeys: new Set(["seen"]),
    });
    expect(state.pendingLine).toBe(pendingLine);
    expect(state.seenMessageKeys).toBe(seenMessageKeys);
  });

  it("counts only complete lines, resumes pending JSON, and skips invalid JSON", () => {
    const firstLine = assistantLine({ messageId: "message-1", requestId: "request-1", inputTokens: 2 });
    const secondLine = assistantLine({ messageId: "message-2", requestId: "request-2", inputTokens: 3 });
    const incompleteSecondLine = secondLine.slice(0, -4);
    const initial = emptyIncrementalState();

    const partial = consumeTranscriptChunk(initial, new TextEncoder().encode(firstLine + incompleteSecondLine));

    expect(partial.inputTokens).toBe(2);
    expect(new TextDecoder().decode(partial.pendingLine)).toBe(incompleteSecondLine);
    expect(initial.inputTokens).toBe(0);
    expect(initial.pendingLine).toEqual(new Uint8Array());

    const completed = consumeTranscriptChunk(
      partial,
      new TextEncoder().encode(`${secondLine.slice(incompleteSecondLine.length)}not json\n`),
    );

    expect(completed.inputTokens).toBe(5);
    expect(completed.pendingLine).toEqual(new Uint8Array());
  });

  it("counts each message id and request id pair once across chunks", () => {
    const firstRequest = assistantLine({
      messageId: "message-1",
      requestId: "request-1",
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheCreationTokens: 3,
    });
    const secondRequest = assistantLine({
      messageId: "message-1",
      requestId: "request-2",
      inputTokens: 7,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheCreationTokens: 5,
    });

    const firstChunk = consumeTranscriptChunk(emptyIncrementalState(), new TextEncoder().encode(firstRequest));
    const totals = consumeTranscriptChunk(
      firstChunk,
      new TextEncoder().encode(firstRequest + secondRequest),
    );

    expect(totals).toMatchObject({ inputTokens: 12, outputTokens: 6, cachedTokens: 13 });
    expect(totals.seenMessageKeys).toEqual(new Set(['["message-1","request-1"]', '["message-1","request-2"]']));
  });

  it("keeps counting assistant records when either dedupe id is missing", () => {
    const withoutRequestId = assistantLine({ messageId: "message-1", inputTokens: 2 });
    const withoutMessageId = assistantLine({ requestId: "request-1", inputTokens: 3 });

    const totals = consumeTranscriptChunk(
      emptyIncrementalState(),
      new TextEncoder().encode(withoutRequestId + withoutRequestId + withoutMessageId + withoutMessageId),
    );

    expect(totals.inputTokens).toBe(10);
    expect(totals.seenMessageKeys.size).toBe(0);
  });

  it("drops an oversized partial line through its newline and counts the next line", () => {
    let state = emptyIncrementalState();
    const largeFragment = new Uint8Array(TRANSCRIPT_CHUNK_LIMIT_BYTES).fill(0x78);

    for (let index = 0; index < 4; index += 1) {
      state = consumeTranscriptChunk(state, largeFragment);
    }
    expect(state.pendingLine.byteLength).toBe(4 * TRANSCRIPT_CHUNK_LIMIT_BYTES);

    state = consumeTranscriptChunk(state, new TextEncoder().encode("x"));
    expect(state).toMatchObject({
      discardUntilNewline: true,
      inputTokens: 0,
      pendingLine: new Uint8Array(),
    });

    state = consumeTranscriptChunk(
      state,
      new TextEncoder().encode(`\n${assistantLine({ messageId: "message-1", requestId: "request-1", inputTokens: 9 })}`),
    );

    expect(state).toMatchObject({
      discardUntilNewline: false,
      inputTokens: 9,
      pendingLine: new Uint8Array(),
    });
  });
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

  it("ignores zero-token synthetic assistant lines when pricing fallback usage", async () => {
    const usage = await readTranscriptUsage(fixturePath("synthetic.jsonl"));

    expect(usage).toMatchObject({
      state: "tokens",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 30,
      model: "claude-opus-5",
    });
    expect(usage.cost).toBeCloseTo(0.005295, 12);
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
      const segment = "x".repeat(64 * 1024);

      for (let index = 0; index < 1600; index += 1) {
        if (!stream.write(`{\"type\":\"ignored\",\"data\":\"${segment}\"}\n`)) {
          await once(stream, "drain");
        }
      }
      const finished = once(stream, "finish");
      stream.end();
      await finished;
      expect(fs.statSync(file).size).toBeGreaterThan(50 * 1024 * 1024);

      const memoryBefore = process.memoryUsage();
      let peakHeapUsed = memoryBefore.heapUsed;
      let peakExternal = memoryBefore.external;
      const originalParse = JSON.parse;
      JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
        const memory = process.memoryUsage();
        peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
        peakExternal = Math.max(peakExternal, memory.external);
        return originalParse(...args);
      }) as typeof JSON.parse;
      try {
        await readTranscriptUsage(file);
      } finally {
        JSON.parse = originalParse;
      }
      expect(peakHeapUsed - memoryBefore.heapUsed).toBeLessThan(50 * 1024 * 1024);
      expect(peakExternal - memoryBefore.external).toBeLessThan(50 * 1024 * 1024);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
