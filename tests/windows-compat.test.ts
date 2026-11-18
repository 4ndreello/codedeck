import path from "node:path";
import { describe, expect, it } from "vitest";
import { tildify } from "../src/cli/commands/ps.js";
import { noFollowFlag, renameReplacing } from "../src/config/config.js";
import { sessionName } from "../src/open/launchers/claude.js";
import { cmdShimContents, codedeckShimEnv, withCodedeckOnPath } from "../src/open/runtime.js";
import { pidIdentity, windowsSystemBinary } from "../src/utils/process.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("config writes on Windows", () => {
  it("saves without O_NOFOLLOW where the platform has none", () => {
    expect(noFollowFlag({ O_CREAT: 64 })).toBe(0);
    expect(noFollowFlag({ O_NOFOLLOW: 131072 })).toBe(131072);
  });

  it("retries a rename that a reader briefly blocks on Windows", () => {
    const waits: number[] = [];
    let calls = 0;
    renameReplacing("a", "b", {
      platform: "win32",
      rename: () => {
        calls += 1;
        if (calls < 3) throw errno("EBUSY");
      },
      wait: (ms) => waits.push(ms),
    });
    expect(calls).toBe(3);
    expect(waits).toEqual([25, 50]);
  });

  it("gives up after the retry budget and on errors a retry cannot fix", () => {
    let calls = 0;
    const always = (code: string) => () => {
      calls += 1;
      throw errno(code);
    };
    expect(() => renameReplacing("a", "b", { platform: "win32", rename: always("EPERM"), wait: () => {} })).toThrow("EPERM");
    expect(calls).toBe(10);

    calls = 0;
    expect(() => renameReplacing("a", "b", { platform: "win32", rename: always("ENOENT"), wait: () => {} })).toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  it("does not retry on POSIX, where rename replaces atomically", () => {
    let calls = 0;
    const rename = () => {
      calls += 1;
      throw errno("EBUSY");
    };
    expect(() => renameReplacing("a", "b", { platform: "linux", rename, wait: () => {} })).toThrow("EBUSY");
    expect(calls).toBe(1);
  });
});

describe("open on Windows", () => {
  // No drive letters: path.delimiter is ":" on the POSIX host running this.
  const binDir = "\\Users\\me\\.codedeck\\bin";

  it("prepends the shim directory to Path instead of adding a second PATH", () => {
    const env = { Path: `\\Windows${path.delimiter}\\Git\\cmd`, USERPROFILE: "\\Users\\me" };

    const result = withCodedeckOnPath(env, binDir, "win32");

    expect(Object.keys(result).filter((key) => key.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(result.Path).toBe(`${binDir}${path.delimiter}\\Windows${path.delimiter}\\Git\\cmd`);
    expect(withCodedeckOnPath(result, binDir, "win32")).toEqual(result);
  });

  it("keeps only the PATH spelling Node would keep when both exist", () => {
    const result = withCodedeckOnPath({ Path: "\\stale", PATH: "\\Windows" }, binDir, "win32");

    expect(result).toEqual({ PATH: `${binDir}${path.delimiter}\\Windows` });
  });

  it("leaves other spellings alone on POSIX, where they are distinct variables", () => {
    const result = withCodedeckOnPath({ Path: "/mine", PATH: "/usr/bin" }, "/cd/bin", "linux");

    expect(result).toEqual({ Path: "/mine", PATH: `/cd/bin${path.delimiter}/usr/bin` });
  });

  it("writes a .cmd shim that names no path, so the console codepage cannot garble it", () => {
    const shim = cmdShimContents("cdk");

    expect(shim).toContain('set "CODEDECK_CLI_NAME=cdk"\r\n');
    expect(shim).toContain('"%CODEDECK_NODE%" "%CODEDECK_ENTRY%" %*\r\n');
    expect(shim).not.toMatch(/[A-Za-z]:\\/);
    expect(codedeckShimEnv("win32")).toEqual({
      CODEDECK_NODE: process.execPath,
      CODEDECK_ENTRY: expect.stringMatching(/index\.js$/),
    });
    expect(codedeckShimEnv("linux")).toEqual({});
  });

  it("names a session after the last folder of a Windows cwd", () => {
    expect(sessionName("orchestrator", "C:\\Users\\me\\dev\\codedeck")).toBe("CodeDeck · codedeck · orchestrator");
    expect(sessionName("orchestrator", "C:\\Users\\me\\dev\\codedeck\\")).toBe("CodeDeck · codedeck · orchestrator");
  });
});

describe("system programs and paths on Windows", () => {
  it("runs system programs from System32, never through PATH or the cwd", () => {
    expect(windowsSystemBinary("taskkill.exe", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\taskkill.exe");
    expect(windowsSystemBinary("rundll32.exe", {})).toBe("C:\\Windows\\System32\\rundll32.exe");
  });

  it("shortens the home directory only at a path boundary", () => {
    expect(tildify("/home/me/dev", "/home/me", "linux")).toBe("~/dev");
    expect(tildify("/home/me", "/home/me", "linux")).toBe("~");
    expect(tildify("/home/meow/dev", "/home/me", "linux")).toBe("/home/meow/dev");
    expect(tildify("c:\\users\\me\\dev", "C:\\Users\\me", "win32")).toBe("~\\dev");
    expect(tildify("C:\\x", "", "win32")).toBe("C:\\x");
  });
});

describe("PID identity", () => {
  const alive = () => true;
  const dead = () => false;

  it("is unknown for a live PID where start times cannot be read", () => {
    expect(pidIdentity(42, null, { platform: "win32", alive })).toBe("unknown");
    expect(pidIdentity(42, null, { platform: "darwin", alive })).toBe("unknown");
  });

  it("is gone for a dead or missing PID on every platform", () => {
    expect(pidIdentity(42, null, { platform: "win32", alive: dead })).toBe("gone");
    expect(pidIdentity(null, "100", { platform: "linux", alive })).toBe("gone");
  });

  it("keeps the Linux rule: only a matching start time proves identity", () => {
    expect(pidIdentity(42, "100", { platform: "linux", alive, startTime: () => "100" })).toBe("match");
    expect(pidIdentity(42, "100", { platform: "linux", alive, startTime: () => "200" })).toBe("reused");
    expect(pidIdentity(42, "100", { platform: "linux", alive, startTime: () => undefined })).toBe("reused");
    expect(pidIdentity(42, null, { platform: "linux", alive, startTime: () => "100" })).toBe("reused");
  });
});
