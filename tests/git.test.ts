import { describe, it, expect } from "vitest";
import { getGitInfo } from "../src/git/repository.js";
import { getDiff } from "../src/git/diff.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-git-test-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  execSync("git add .", { cwd: dir });
  execSync("git commit -qm init", { cwd: dir });
  return dir;
}

describe("git helpers", () => {
  it("getGitInfo detects repo", async () => {
    const dir = makeRepo();
    const info = await getGitInfo(dir);
    expect(info).not.toBeNull();
    expect(info?.root).toBe(dir);
    expect(info?.head).toBeDefined();
    expect(info?.isDirty).toBe(false);
  });

  it("getDiff returns empty when no changes", async () => {
    const dir = makeRepo();
    const info = await getGitInfo(dir);
    const diff = await getDiff({ cwd: dir, baseCommit: info?.head, repository: dir });
    expect(diff.diff.trim()).toBe("");
  });

  it("getDiff detects new file", async () => {
    const dir = makeRepo();
    const info = await getGitInfo(dir);
    fs.writeFileSync(path.join(dir, "b.txt"), "new");
    const diff = await getDiff({ cwd: dir, baseCommit: info?.head, repository: dir });
    // Should contain b.txt or status
    expect(diff.diff.length).toBeGreaterThan(0);
  });
});
