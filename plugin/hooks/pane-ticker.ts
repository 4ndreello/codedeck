import type { PaneSnapshot } from "../mods/agents/types.js";

const TICK_INTERVAL_MS = 1000;
const REFRESH_INTERVAL_MS = 5000;
const LIVE_STATUSES = new Set(["working", "starting", "needs_input"]);

export interface PaneTickerOptions {
  now: () => number;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
  invalidate: () => unknown;
  refresh: () => unknown;
}

export interface PaneTicker {
  update(paneOpen: boolean, snapshot: PaneSnapshot | undefined): void;
  refreshed(): void;
}

/** Schedules pane redraws and refresh requests while any worker card is live. */
export function createPaneTicker(options: PaneTickerOptions): PaneTicker {
  let running = false;
  let handle: unknown;
  let lastRefreshAt = 0;

  const invoke = (action: () => unknown) => {
    try {
      void Promise.resolve(action()).catch(() => {});
    } catch {
      // Hook failures drop the drawing, so timer work must stay contained.
    }
  };

  const tick = () => {
    if (!running) return;
    try {
      invoke(options.invalidate);
      const now = options.now();
      if (!Number.isFinite(now) || now - lastRefreshAt < REFRESH_INTERVAL_MS) return;
      lastRefreshAt = now;
      invoke(options.refresh);
    } catch {
      // A failed timer callback must not escape into the hooks runtime.
    }
  };

  const stop = () => {
    if (!running) return;
    running = false;
    const currentHandle = handle;
    handle = undefined;
    try {
      options.clearInterval(currentHandle);
    } catch {
      // Keep the module alive even if the timer host refuses a clear.
    }
  };

  const start = () => {
    if (running) return;
    try {
      const now = options.now();
      if (!Number.isFinite(now)) return;
      lastRefreshAt = now;
      running = true;
      handle = options.setInterval(tick, TICK_INTERVAL_MS);
    } catch {
      running = false;
      handle = undefined;
    }
  };

  const hasLiveRow = (snapshot: PaneSnapshot | undefined): boolean => {
    try {
      return (
        snapshot !== undefined &&
        Array.isArray(snapshot.rows) &&
        snapshot.rows.some((row) => row != null && LIVE_STATUSES.has(row.status))
      );
    } catch {
      return false;
    }
  };

  return {
    update(paneOpen, snapshot) {
      if (paneOpen && hasLiveRow(snapshot)) {
        start();
        return;
      }
      stop();
    },
    refreshed() {
      try {
        const now = options.now();
        if (Number.isFinite(now)) lastRefreshAt = now;
      } catch {
        // Keep the prior cadence if the injected clock fails.
      }
    },
  };
}
