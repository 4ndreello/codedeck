import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import { makeDaemonTestContext, registerDaemonTestHooks, seam } from "./helpers/daemon-seam.js";

let daemon: Daemon | undefined;
const testContext = makeDaemonTestContext("cdk-sock-");
registerDaemonTestHooks(testContext, () => daemon, () => { daemon = undefined; });

describe("daemon socket cleanup", () => {
  it("removes the paths resolved at start when RUN_AGENT_DIR changes", async () => {
    const startedDir = testContext.runAgentDir;
    daemon = new Daemon();
    await daemon.start();

    const replacementDir = fs.mkdtempSync(path.join("/tmp", "cdk-sock-b-"));
    try {
      const replacementSocket = path.join(replacementDir, "daemon.sock");
      const replacementPid = path.join(replacementDir, "daemon.pid");
      fs.writeFileSync(replacementSocket, "socket sentinel");
      fs.writeFileSync(replacementPid, "pid sentinel");
      process.env.RUN_AGENT_DIR = replacementDir;

      await seam(daemon).handleShutdown("test");

      expect(fs.readFileSync(replacementSocket, "utf8")).toBe("socket sentinel");
      expect(fs.readFileSync(replacementPid, "utf8")).toBe("pid sentinel");
      expect(fs.existsSync(path.join(startedDir, "daemon.sock"))).toBe(false);
      expect(fs.existsSync(path.join(startedDir, "daemon.pid"))).toBe(false);
    } finally {
      fs.rmSync(replacementDir, { recursive: true, force: true });
    }
  });

  it("finishes shutdown while a client remains connected", async () => {
    daemon = new Daemon();
    await daemon.start();

    const client = net.createConnection(path.join(testContext.runAgentDir, "daemon.sock"));
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        seam(daemon).handleShutdown("test"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("shutdown waited for the connected client")), 500);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      client.destroy();
    }
  });

  it("leaves socket and pid files untouched when start never completed", async () => {
    const socketPath = path.join(testContext.runAgentDir, "daemon.sock");
    const pidPath = path.join(testContext.runAgentDir, "daemon.pid");
    fs.writeFileSync(socketPath, "socket sentinel");
    fs.writeFileSync(pidPath, "pid sentinel");
    daemon = new Daemon();

    await seam(daemon).handleShutdown("test");

    expect(fs.readFileSync(socketPath, "utf8")).toBe("socket sentinel");
    expect(fs.readFileSync(pidPath, "utf8")).toBe("pid sentinel");
  });
});
