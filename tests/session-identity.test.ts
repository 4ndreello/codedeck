import { describe, expect, it } from "vitest";

import { Daemon } from "../src/daemon/daemon.js";
import {
  fakeSocket,
  makeDaemonTestContext,
  registerDaemonTestHooks,
  seed,
  seam,
} from "./helpers/daemon-seam.js";

let daemon: Daemon | undefined;
const testContext = makeDaemonTestContext("session-identity-");
registerDaemonTestHooks(testContext, () => daemon, () => { daemon = undefined; });

async function request(method: "session.rename" | "session.get", params: unknown): Promise<Record<string, any>> {
  const { writes, socket } = fakeSocket();
  await seam(daemon!).handleRequest(
    { id: testContext.nextRequestId("session-identity"), method, params },
    socket,
  );
  return JSON.parse(writes[0]);
}

describe("session.rename IPC", () => {
  it("creates, renames, and gets the session with its new name", async () => {
    daemon = new Daemon();
    seed(daemon, "session-a", "working", { name: "raw task" });

    expect(await request("session.rename", { id: "session-a", name: "oauth-login" }))
      .toEqual({ id: "session-identity-1", result: { ok: true } });

    const response = await request("session.get", { id: "session-a" });
    expect(response.result.session.name).toBe("oauth-login");
  });

  it("rejects an empty name without changing the session", async () => {
    daemon = new Daemon();
    seed(daemon, "session-a", "working", { name: "raw task" });

    expect(await request("session.rename", { id: "session-a", name: "" }))
      .toMatchObject({ error: { code: "INVALID" } });

    const response = await request("session.get", { id: "session-a" });
    expect(response.result.session.name).toBe("raw task");
  });

  it("rejects whitespace-only and missing names without changing the session", async () => {
    daemon = new Daemon();
    seed(daemon, "session-a", "working", { name: "raw task" });

    for (const params of [{ id: "session-a", name: "   " }, { id: "session-a" }]) {
      expect(await request("session.rename", params))
        .toMatchObject({ error: { code: "INVALID" } });
    }

    const response = await request("session.get", { id: "session-a" });
    expect(response.result.session.name).toBe("raw task");
  });

  it("keeps surrounding whitespace on a nonblank name", async () => {
    daemon = new Daemon();
    seed(daemon, "session-a", "working", { name: "raw task" });

    expect(await request("session.rename", { id: "session-a", name: "  oauth-login  " }))
      .toMatchObject({ result: { ok: true } });

    const response = await request("session.get", { id: "session-a" });
    expect(response.result.session.name).toBe("  oauth-login  ");
  });

  it("rejects an unknown session", async () => {
    daemon = new Daemon();

    expect(await request("session.rename", { id: "missing", name: "new name" }))
      .toMatchObject({ error: { code: "SESSION_NOT_FOUND" } });
  });
});
