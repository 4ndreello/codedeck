import { afterEach, describe, expect, it, vi } from "vitest";

import { createPaneTicker } from "../../plugin/hooks/pane-ticker.js";
import type { PaneSnapshot } from "../../plugin/mods/agents/types.js";

afterEach(() => vi.useRealTimers());

function snapshot(status: string): PaneSnapshot {
  return {
    runId: "f5fd",
    orchestrator: undefined,
    rows: [{ id: "worker", status, agent: "claude", name: "worker" }],
    hidden: 0,
    total: 1,
  };
}

function harness(overrides: Partial<Parameters<typeof createPaneTicker>[0]> = {}) {
  const setInterval = vi.fn((callback: () => void, delay: number) =>
    globalThis.setInterval(callback, delay),
  );
  const clearInterval = vi.fn((handle: ReturnType<typeof globalThis.setInterval>) =>
    globalThis.clearInterval(handle),
  );
  const invalidate = vi.fn();
  const refresh = vi.fn();
  const ticker = createPaneTicker({
    now: () => Date.now(),
    setInterval,
    clearInterval,
    invalidate,
    refresh,
    ...overrides,
  });
  return { ticker, setInterval, clearInterval, invalidate, refresh };
}

describe("createPaneTicker", () => {
  it("starts one timer only for an open pane with a live row and stops it on close or completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    const h = harness();

    h.ticker.update(false, snapshot("working"));
    h.ticker.update(true, snapshot("completed"));
    expect(h.setInterval).not.toHaveBeenCalled();

    h.ticker.update(true, snapshot("needs_input"));
    h.ticker.update(true, snapshot("working"));
    expect(h.setInterval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.invalidate).toHaveBeenCalledTimes(1);

    h.ticker.update(true, snapshot("completed"));
    expect(h.clearInterval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    h.ticker.update(true, snapshot("working"));
    expect(h.setInterval).toHaveBeenCalledTimes(2);
    h.ticker.update(false, snapshot("working"));
    expect(h.clearInterval).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates every second and requests refresh no more than every five seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    const h = harness();
    h.ticker.update(true, snapshot("starting"));

    await vi.advanceTimersByTimeAsync(4999);
    expect(h.invalidate).toHaveBeenCalledTimes(4);
    expect(h.refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.invalidate).toHaveBeenCalledTimes(5);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4999);
    expect(h.invalidate).toHaveBeenCalledTimes(9);
    expect(h.refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.invalidate).toHaveBeenCalledTimes(10);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it("waits five seconds after another refresh completes before requesting data again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    const h = harness();
    h.ticker.update(true, snapshot("working"));

    await vi.advanceTimersByTimeAsync(4000);
    h.ticker.refreshed();
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("catches synchronous tick errors and rejected refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    const invalidate = vi.fn(() => {
      throw new Error("invalidate failed");
    });
    const refresh = vi.fn(() => Promise.reject(new Error("refresh failed")));
    const h = harness({ invalidate, refresh });
    h.ticker.update(true, snapshot("working"));

    await vi.advanceTimersByTimeAsync(5000);
    expect(invalidate).toHaveBeenCalledTimes(5);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
