import { describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import { fakeSocket, makeDaemonTestContext, registerDaemonTestHooks, seam } from "./helpers/daemon-seam.js";

const context = makeDaemonTestContext("daemon-status-removed-");
let daemon: Daemon | undefined;

registerDaemonTestHooks(context, () => daemon, () => { daemon = undefined; });

describe("removed daemon.status method", () => {
  it("returns the standard unknown method response", async () => {
    daemon = new Daemon();
    const { writes, socket } = fakeSocket();

    await seam(daemon).handleRequest({
      id: context.nextRequestId("status"),
      method: "daemon.status",
      params: {},
    }, socket);

    expect(JSON.parse(writes[0])).toMatchObject({
      error: { code: "UNKNOWN_METHOD", message: "Unknown method daemon.status" },
    });
  });
});
