import { afterEach, describe, expect, it, vi } from "vitest";

import { INDENT, LOGO } from "../src/cli/ui.js";
import { bootFrame, playBoot, renderBanner } from "../src/open/runtime.js";

const role = "reviewer";
const model = "claude-sonnet";
const effort = "high";

function stubStdout(isTTY: boolean) {
  const writes: string[] = [];
  const stdout = {
    isTTY,
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
  };

  vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as NodeJS.WriteStream);
  return { stdout, writes };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("playBoot", () => {
  it("keeps the total TTY animation delay within 200 ms", async () => {
    vi.useFakeTimers();
    stubStdout(true);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const boot = playBoot(role, model, effort);
    await vi.runAllTimersAsync();
    await boot;

    const delays = setTimeoutSpy.mock.calls.map(([, delay]) => Number(delay));
    expect(delays).toHaveLength(19);
    expect(delays.reduce((total, delay) => total + delay, 0)).toBeLessThanOrEqual(200);
  });

  it("ends with the resolved logo, role details, and booting line", async () => {
    vi.useFakeTimers();
    const { writes } = stubStdout(true);

    const boot = playBoot(role, model, effort);
    await vi.runAllTimersAsync();
    await boot;

    const ending = writes.slice(-5);
    expect(ending.slice(0, 3)).toEqual(
      bootFrame(1, () => "").map(
        (line) => `\r\x1b[2K${INDENT}\x1b[38;2;225;29;72m${line}\x1b[0m\n`,
      ),
    );
    expect(ending[3]).toBe(
      `${INDENT}\x1b[38;2;163;139;143m${role} · ${model} · ${effort}\x1b[0m\n`,
    );
    expect(ending[4]).toBe(`${INDENT}\x1b[38;2;163;139;143mbooting…\x1b[0m\n`);
    expect(bootFrame(1, () => "")).toEqual(LOGO);
  });

  it("writes one static banner and schedules no timer when stdout is not a TTY", async () => {
    vi.useFakeTimers();
    const { stdout, writes } = stubStdout(false);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await playBoot(role, model, effort);

    expect(writes).toEqual([renderBanner(role, model, effort)]);
    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
