import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon/daemon.js";
import { makeDaemonTestContext, registerDaemonTestHooks, seam } from "./helpers/daemon-seam.js";

let daemon: Daemon | undefined;
const testContext = makeDaemonTestContext("power-inhibit-");
registerDaemonTestHooks(testContext, () => daemon, () => { daemon = undefined; });

function childCommandLines(pid: number): string[] {
  const taskDir = `/proc/${pid}/task`;
  const children = fs.readdirSync(taskDir).flatMap((tid) =>
    fs.readFileSync(`${taskDir}/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean),
  );
  return children.map((child) => {
    try {
      return fs.readFileSync(`/proc/${child}/cmdline`, "utf8").replaceAll("\0", " ");
    } catch {
      return "";
    }
  });
}

// A delay lock only helps a holder that reacts to logind's PrepareForShutdown.
// The daemon drains on SIGTERM, which arrives after the delay expires, so a
// lock just stalls every poweroff and suspend for InhibitDelayMaxSec.
describe.runIf(fs.existsSync("/proc/self/task"))("power delay lock", () => {
  it("start() spawns no systemd-inhibit child", async () => {
    daemon = new Daemon();
    await daemon.start();
    try {
      expect(childCommandLines(process.pid).filter((cmd) => cmd.includes("systemd-inhibit"))).toEqual([]);
    } finally {
      await seam(daemon).handleShutdown("test");
    }
  });
});
