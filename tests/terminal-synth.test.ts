import { describe, expect, it } from "vitest";
import { synthesizeTerminalEvent } from "../src/drivers/terminal.js";

// A reattached runtime learns of a death by polling the pid, so it never
// sees an exit code. A turn.completed as the last frame is the harness's
// own word that the turn finished; without it, unknown stays failed.
const base = { sessionId: "s1", harness: "codex", hasTerminal: false, hasMessage: true, stderr: "" };

describe("synthesizeTerminalEvent with an unobserved exit", () => {
  it("completes when the log ended on turn.completed", () => {
    const ev = synthesizeTerminalEvent({ ...base, exitCode: null, signal: null, endedOnTurnCompleted: true });
    expect(ev).toMatchObject({ type: "session.completed", reason: "turn completed; exit not observed" });
  });

  it("stays failed when the log did not end on turn.completed", () => {
    const ev = synthesizeTerminalEvent({ ...base, exitCode: null, signal: null, endedOnTurnCompleted: false });
    expect(ev).toMatchObject({ type: "session.failed", error: "codex exited without reporting a terminal event" });
  });

  it("stays failed on a fatal signal even after turn.completed", () => {
    const ev = synthesizeTerminalEvent({ ...base, exitCode: null, signal: "SIGSEGV", endedOnTurnCompleted: true });
    expect(ev?.type).toBe("session.failed");
  });

  it("stays failed on an observed non-zero exit even after turn.completed", () => {
    const ev = synthesizeTerminalEvent({ ...base, exitCode: 1, signal: null, endedOnTurnCompleted: true });
    expect(ev?.type).toBe("session.failed");
  });

  it("stays failed when stderr carries a crash signature", () => {
    const ev = synthesizeTerminalEvent({ ...base, exitCode: null, signal: null, endedOnTurnCompleted: true, stderr: "Unhandled promise rejection: EPIPE" });
    expect(ev).toMatchObject({ type: "session.failed", failure: { code: "HARNESS_CRASH" } });
  });
});
