import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLinkWatcher } from "../src/open/link-watcher.js";

const ids = [
  "92d88cce-bdbc-46db-8573-916afd32f6f7",
  "3f1f93b8-c484-43aa-8a11-32a486109e22",
];

describe("open link watcher", () => {
  let tempDir: string;

  afterEach(() => {
    vi.useRealTimers();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("sends appended ids on the default tick and never sends an id twice", async () => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "codedeck-link-watcher-"));
    const sessionFile = path.join(tempDir, "session");
    const link = vi.fn(async () => ({}));
    const watcher = startLinkWatcher({ sessionFile, runId: "run-example", link });
    writeFileSync(sessionFile, `${ids[0]}\n${ids[0]}\n`);

    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(link).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(link).toHaveBeenCalledTimes(1);
      expect(link).toHaveBeenCalledWith("run-example", ids[0]);

      await vi.advanceTimersByTimeAsync(2000);
      expect(link).toHaveBeenCalledTimes(1);
    } finally {
      watcher.stop();
    }
  });

  it("retries an id when linking rejects", async () => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "codedeck-link-watcher-"));
    const sessionFile = path.join(tempDir, "session");
    const link = vi.fn()
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValue({});
    writeFileSync(sessionFile, `${ids[0]}\n`);
    const watcher = startLinkWatcher({ sessionFile, runId: "run-example", link });

    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(link).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(link).toHaveBeenCalledTimes(2);
      expect(link).toHaveBeenLastCalledWith("run-example", ids[0]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(link).toHaveBeenCalledTimes(2);
    } finally {
      watcher.stop();
    }
  });

  it("flushes all valid ids immediately and stop clears the timer", async () => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "codedeck-link-watcher-"));
    const sessionFile = path.join(tempDir, "session");
    const link = vi.fn(async () => ({}));
    writeFileSync(sessionFile, `invalid\n${ids[0]}\n${ids[1]}\n`);
    const watcher = startLinkWatcher({ sessionFile, runId: "run-example", link, intervalMs: 50 });

    try {
      await watcher.flush();

      expect(link.mock.calls).toEqual([
        ["run-example", ids[0]],
        ["run-example", ids[1]],
      ]);

      watcher.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(link).toHaveBeenCalledTimes(2);
    } finally {
      watcher.stop();
    }
  });

  it("reads ids appended while an earlier link is still in flight before flush resolves", async () => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "codedeck-link-watcher-"));
    const sessionFile = path.join(tempDir, "session");
    let finishFirstLink!: () => void;
    const firstLink = new Promise<void>((resolve) => {
      finishFirstLink = resolve;
    });
    const link = vi.fn(async (_runId: string, nativeId: string) => {
      if (nativeId === ids[0]) await firstLink;
      return {};
    });
    writeFileSync(sessionFile, `${ids[0]}\n`);
    const watcher = startLinkWatcher({ sessionFile, runId: "run-example", link, intervalMs: 50 });

    try {
      const initialFlush = watcher.flush();
      await Promise.resolve();
      expect(link).toHaveBeenCalledWith("run-example", ids[0]);

      writeFileSync(sessionFile, `${ids[0]}\n${ids[1]}\n`);
      const finalFlush = watcher.flush();
      finishFirstLink();
      await Promise.all([initialFlush, finalFlush]);

      expect(link.mock.calls).toEqual([
        ["run-example", ids[0]],
        ["run-example", ids[1]],
      ]);
    } finally {
      watcher.stop();
    }
  });

  it("treats a missing sidecar as an empty pass", async () => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "codedeck-link-watcher-"));
    const link = vi.fn(async () => ({}));
    const watcher = startLinkWatcher({
      sessionFile: path.join(tempDir, "missing"),
      runId: "run-example",
      link,
    });

    try {
      await expect(watcher.flush()).resolves.toBeUndefined();
      expect(link).not.toHaveBeenCalled();
    } finally {
      watcher.stop();
    }
  });
});
