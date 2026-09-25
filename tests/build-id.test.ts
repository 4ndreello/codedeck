import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeBuildId, distRootFor } from "../src/daemon/build-id.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-build-id-"));
  dirs.push(dir);
  return dir;
}

function writeAt(file: string, seconds: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  fs.utimesSync(file, seconds, seconds);
}

describe("computeBuildId", () => {
  it("returns the newest .js mtime, including nested directories and ignoring other files", () => {
    const root = tempDir();
    writeAt(path.join(root, "cli", "index.js"), 1_000);
    writeAt(path.join(root, "web", "deep", "child.js"), 3_000);
    writeAt(path.join(root, "plugin", "newer.md"), 9_000);

    expect(computeBuildId(root)).toBe(String(fs.statSync(path.join(root, "web", "deep", "child.js")).mtimeMs));
    expect(computeBuildId(root)).toBe("3000000");
  });

  it("returns 0 for a tree without .js files", () => {
    expect(computeBuildId(tempDir())).toBe("0");
  });
});

describe("distRootFor", () => {
  it("returns the directory two levels above the module file", () => {
    expect(distRootFor("file:///x/dist/daemon/daemon.js")).toBe("/x/dist");
  });
});
