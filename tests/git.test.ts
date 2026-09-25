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
    expect(diff.diff.length).toBeGreaterThan(0);
    expect(diff.files).toContain("b.txt");
    expect(diff.stat).toContain("b.txt | untracked");
  });

  it("getDiff lists nonignored untracked paths from a nested cwd", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
    execSync("git add .gitignore", { cwd: dir });
    execSync('git commit -qm "add gitignore"', { cwd: dir });
    fs.writeFileSync(path.join(dir, "unstaged-root.txt"), "base version\n");
    execSync("git add unstaged-root.txt", { cwd: dir });
    execSync('git commit -qm "track root file"', { cwd: dir });
    const baseCommit = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    const nested = path.join(dir, "sub");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(dir, "committed-root.txt"), "committed after base");
    execSync("git add committed-root.txt", { cwd: dir });
    execSync('git commit -qm "commit root file"', { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "staged at repository root\n");
    fs.writeFileSync(path.join(dir, "café-staged.txt"), "staged unicode");
    execSync('git add a.txt "café-staged.txt"', { cwd: dir });
    fs.writeFileSync(path.join(dir, "unstaged-root.txt"), "unstaged after base\n");
    fs.writeFileSync(path.join(dir, "root-untracked.txt"), "root");
    fs.writeFileSync(path.join(nested, "nested-untracked.txt"), "nested");
    fs.writeFileSync(path.join(nested, "café.txt"), "unicode");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "ignored");
    const stagedStats = execSync(
      "git diff --cached --stat",
      { cwd: dir, encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => line.trim());

    const diff = await getDiff({ cwd: nested, baseCommit, repository: dir });

    expect(stagedStats).not.toHaveLength(0);
    expect(diff.files).toContain("a.txt");
    expect(diff.files).toContain("café-staged.txt");
    expect(diff.files).toContain("committed-root.txt");
    expect(diff.files).toContain("unstaged-root.txt");
    expect(diff.files).toContain("root-untracked.txt");
    expect(diff.files).toContain("sub/nested-untracked.txt");
    expect(diff.files).toContain("sub/café.txt");
    expect(diff.files).not.toContain("ignored.txt");
    expect(diff.stat).toContain("committed-root.txt");
    expect(diff.stat).toContain("unstaged-root.txt");
    for (const line of stagedStats) expect(diff.stat).toContain(line);
    expect(diff.stat).toContain("root-untracked.txt | untracked");
    expect(diff.stat).toContain("sub/nested-untracked.txt | untracked");
    expect(diff.stat).toContain("sub/café.txt | untracked");
    expect(diff.stat).not.toContain("ignored.txt");
  });

  it("getDiff includes staged stat and deduplicates a staged path", async () => {
    const dir = makeRepo();
    const baseCommit = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(dir, "a.txt"), "staged one\nstaged two\nstaged three\n");
    execSync("git add a.txt", { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "staged one\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "staged file\n");
    execSync("git add b.txt", { cwd: dir });
    const stagedStats = execSync("git diff --cached --stat", { cwd: dir, encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => line.trim());

    const diff = await getDiff({ cwd: dir, baseCommit, repository: dir });

    for (const line of stagedStats) expect(diff.stat).toContain(line);
    expect(diff.files).toEqual(["a.txt", "b.txt"]);
  });

  it("getDiff preserves committed and unstaged changes", async () => {
    const dir = makeRepo();
    const baseCommit = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(dir, "b.txt"), "committed change");
    execSync("git add b.txt", { cwd: dir });
    execSync('git commit -qm "add b.txt"', { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "unstaged change");

    const diff = await getDiff({ cwd: dir, baseCommit, repository: dir });

    expect([...diff.files].sort()).toEqual(["a.txt", "b.txt"]);
    expect(diff.stat).toContain("a.txt");
    expect(diff.stat).toContain("b.txt");
  });
});
