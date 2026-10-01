import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderServiceUnit,
  runServiceCommand,
  type ServiceCommandDependencies,
} from "../src/cli/commands/service.js";
import { powerServicePath } from "../src/cli/commands/doctor.js";

function temporaryHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-service-"));
}

describe("service commands", () => {
  it.each([
    {
      name: "renders absolute ExecStart paths, PATH, KillMode, and the default target",
      input: {
        nodePath: "/opt/node/bin/node",
        daemonScript: "/opt/codedeck/dist/daemon/daemon.js",
        path: "/home/user/.local/bin:/usr/bin",
      },
      expected: [
        'ExecStart="/opt/node/bin/node" "/opt/codedeck/dist/daemon/daemon.js" --daemon',
        'Environment="PATH=/home/user/.local/bin:/usr/bin"',
        "KillMode=process",
        "WantedBy=default.target",
      ],
    },
    {
      name: "quotes paths containing spaces and escapes systemd specifiers",
      input: {
        nodePath: "/opt/Node Runtime/bin/node",
        daemonScript: "/opt/CodeDeck %release/dist/daemon/daemon.js",
        path: "/usr/bin:/mnt/c/Program Files/Git/bin:/opt/100%tools/bin",
      },
      expected: [
        'ExecStart="/opt/Node Runtime/bin/node" "/opt/CodeDeck %%release/dist/daemon/daemon.js" --daemon',
        'Environment="PATH=/usr/bin:/mnt/c/Program Files/Git/bin:/opt/100%%tools/bin"',
      ],
    },
    {
      name: "escapes dollar signs in ExecStart paths",
      input: {
        nodePath: "/opt/$HOME/bin/node",
        daemonScript: "/opt/${X}/daemon.js",
        path: "/usr/bin",
      },
      expected: ['ExecStart="/opt/$HOME/bin/node" "/opt/$${X}/daemon.js" --daemon'],
    },
  ])("$name", ({ input, expected }) => {
    const unit = renderServiceUnit(input);
    for (const line of expected) expect(unit).toContain(line);
  });

  it("writes the unit then reloads and enables the service", async () => {
    const homeDir = temporaryHome();
    const calls: string[][] = [];
    const output: string[] = [];
    const dependencies: ServiceCommandDependencies = {
      homeDir,
      platform: "linux",
      pathEnv: "/home/test/.local/bin:/usr/bin",
      systemctlPath: "/usr/bin/systemctl",
      daemonScript: "/opt/codedeck/dist/daemon/daemon.js",
      existsSync: () => true,
      runSystemctl: async (args) => { calls.push(args); return { code: 0 }; },
      log: (message) => output.push(message),
      error: (message) => output.push(message),
    };

    try {
      expect(await runServiceCommand("install", dependencies)).toBe(0);
      expect(fs.readFileSync(powerServicePath(homeDir), "utf8")).toContain(
        'Environment="PATH=/home/test/.local/bin:/usr/bin"',
      );
      expect(calls).toEqual([
        ["--user", "daemon-reload"],
        ["--user", "enable", "codedeck.service"],
      ]);
      expect(output.join("\n")).toContain("next login");
      expect(output.join("\n")).toContain("systemctl --user daemon-reload: succeeded");
      expect(output.join("\n")).toContain("systemctl --user enable codedeck.service: succeeded");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not claim the service is enabled when systemctl fails", async () => {
    const homeDir = temporaryHome();
    const output: string[] = [];
    try {
      expect(await runServiceCommand("install", {
        homeDir,
        platform: "linux",
        pathEnv: "/usr/bin",
        systemctlPath: "/usr/bin/systemctl",
        daemonScript: "/opt/codedeck/dist/daemon/daemon.js",
        existsSync: () => true,
        runSystemctl: async () => ({ code: 1, stderr: "failed" }),
        log: (message) => output.push(message),
        error: (message) => output.push(message),
      })).toBe(1);
      expect(output.join("\n")).not.toContain("next login");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("disables the service and removes the unit on uninstall", async () => {
    const homeDir = temporaryHome();
    const unitPath = powerServicePath(homeDir);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "unit");
    const calls: string[][] = [];

    try {
      expect(await runServiceCommand("uninstall", {
        homeDir,
        platform: "linux",
        systemctlPath: "/usr/bin/systemctl",
        runSystemctl: async (args) => { calls.push(args); return { code: 0 }; },
        log: () => {},
        error: () => {},
      })).toBe(0);
      expect(calls).toEqual([
        ["--user", "disable", "codedeck.service"],
        ["--user", "daemon-reload"],
      ]);
      expect(fs.existsSync(unitPath)).toBe(false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects non-Linux and missing systemctl without writing a file", async () => {
    for (const dependencies of [
      { platform: "darwin" as NodeJS.Platform, systemctlPath: "/usr/bin/systemctl" },
      { platform: "linux" as NodeJS.Platform, systemctlPath: null },
    ]) {
      const homeDir = temporaryHome();
      const errors: string[] = [];
      try {
        expect(await runServiceCommand("install", {
          ...dependencies,
          homeDir,
          log: () => {},
          error: (message) => errors.push(message),
        })).toBe(1);
        expect(fs.existsSync(powerServicePath(homeDir))).toBe(false);
        expect(errors.length).toBe(1);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }
  });
});
